#!/usr/bin/env node
// PRIVATE owner tooling (vaults plan §1) — the eager post-deploy backfill
// that moves every user's pre-vault root content into a `Home` vault. Run it
// once after deploying the 0007 migration + vault routes; it is idempotent
// and safe to re-run (a second pass finds no root content and changes
// nothing). Asset rows are deliberately untouched — the folder→doc read
// fallback in api/assets.ts serves legacy doc-scoped rows — and trashed docs
// keep folder_id NULL (POST /api/docs/:id/restore re-homes them).
//
// Usage (from apps/web; plain node runs this — type-stripped, no build):
//   node scripts/backfill-vaults.ts --dry-run            # local D1, plan only
//   node scripts/backfill-vaults.ts                      # local D1, apply
//   node scripts/backfill-vaults.ts --remote --dry-run   # production, plan only
//   node scripts/backfill-vaults.ts --remote             # production, apply
// or: pnpm db:backfill-vaults [-- --remote --dry-run]
//
// Per user owning any root content (root folders kind='folder', or live root
// docs):
//   1. ensure a default vault (reuse a valid user_prefs.default_vault_id,
//      else an existing vault — preferring `Home` — else create `Home`,
//      suffixed -2, -3, … on a vault-name collision);
//   2. suffix-rename root docs that would collide with a live filename
//      already in the vault (deploy-window writes) — deterministic order
//      (created_at, id), same -N scheme as createDoc;
//   3. re-parent root folders (parent_id NULL, kind='folder' → vault id);
//   4. re-home live root docs (folder_id NULL, deleted_at IS NULL → vault id);
//   5. record user_prefs.default_vault_id.
//
// The decision logic lives in `backfillVaults` against a tiny SQL-runner
// interface so apps/web/test/backfill-vaults.test.ts can drive it through
// better-sqlite3; the CLI entry below backs it with `wrangler d1 execute`.

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// ---------------------------------------------------------------------------
// Core (I/O-free except through the runner)
// ---------------------------------------------------------------------------

export interface SqlRunner {
  /** Read-only statement -> rows. */
  query(sql: string): Promise<Array<Record<string, unknown>>>
  /** Apply write statements in order (one user's batch per call). */
  execute(statements: string[]): Promise<void>
}

export interface BackfillOptions {
  /** Plan and log only — no writes reach the runner. */
  dryRun?: boolean
  log?: (line: string) => void
  /** Injectable for deterministic tests. */
  newId?: () => string
  now?: () => number
}

export interface BackfillSummary {
  usersTouched: number
  vaultsCreated: number
  foldersReparented: number
  docsRehomed: number
  docsRenamed: number
}

const DEFAULT_VAULT_NAME = 'Home'

/** SQL string literal ('' escaping — every value we write is server-minted). */
function lit(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/** First free `<stem>(-N).md` against a taken set — mirrors api/filenames.ts. */
function availableFilename(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base
  const stem = base.replace(/\.md$/, '')
  for (let n = 2; ; n++) {
    const candidate = `${stem}-${n}.md`
    if (!taken.has(candidate)) return candidate
  }
}

/** First vault name not colliding case-insensitively: `Home`, `Home-2`, … */
function availableVaultName(takenLower: ReadonlySet<string>): string {
  if (!takenLower.has(DEFAULT_VAULT_NAME.toLowerCase())) return DEFAULT_VAULT_NAME
  for (let n = 2; ; n++) {
    const candidate = `${DEFAULT_VAULT_NAME}-${n}`
    if (!takenLower.has(candidate.toLowerCase())) return candidate
  }
}

export async function backfillVaults(sql: SqlRunner, options: BackfillOptions = {}): Promise<BackfillSummary> {
  const log = options.log ?? ((line: string) => console.log(line))
  const newId = options.newId ?? (() => crypto.randomUUID())
  const now = options.now ?? (() => Date.now())
  const summary: BackfillSummary = {
    usersTouched: 0,
    vaultsCreated: 0,
    foldersReparented: 0,
    docsRehomed: 0,
    docsRenamed: 0,
  }

  const users = await sql.query(
    `SELECT owner_user_id AS uid FROM folders WHERE parent_id IS NULL AND kind = 'folder'
     UNION
     SELECT owner_user_id AS uid FROM docs WHERE folder_id IS NULL AND deleted_at IS NULL
     ORDER BY uid`,
  )
  if (users.length === 0) {
    log('no root content found — nothing to backfill')
    return summary
  }

  for (const row of users) {
    const uid = String(row.uid)
    const statements: string[] = []

    // 1. Default vault: valid pref > existing `Home` > oldest vault > create.
    const vaultRows = await sql.query(
      `SELECT id, name FROM folders WHERE owner_user_id = ${lit(uid)} AND kind = 'vault' ORDER BY created_at, id`,
    )
    const vaults = vaultRows.map((v) => ({ id: String(v.id), name: String(v.name) }))
    const pref = await sql.query(`SELECT default_vault_id AS v FROM user_prefs WHERE user_id = ${lit(uid)}`)
    const prefId = pref[0]?.v != null ? String(pref[0].v) : null
    let vaultId =
      (prefId !== null ? vaults.find((v) => v.id === prefId)?.id : undefined) ??
      vaults.find((v) => v.name.toLowerCase() === DEFAULT_VAULT_NAME.toLowerCase())?.id ??
      vaults[0]?.id
    let createdName: string | null = null
    if (vaultId === undefined) {
      vaultId = newId()
      createdName = availableVaultName(new Set(vaults.map((v) => v.name.toLowerCase())))
      statements.push(
        `INSERT INTO folders (id, owner_user_id, name, kind, parent_id, created_at)` +
          ` VALUES (${lit(vaultId)}, ${lit(uid)}, ${lit(createdName)}, 'vault', NULL, ${now()})`,
      )
      summary.vaultsCreated++
    }

    // 2. Root docs that would collide with live names already in the vault
    //    (writes that landed there during the deploy window) get suffixed
    //    BEFORE the re-home so the partial unique index holds throughout.
    const rootDocs = await sql.query(
      `SELECT id, filename FROM docs WHERE owner_user_id = ${lit(uid)} AND folder_id IS NULL AND deleted_at IS NULL ORDER BY created_at, id`,
    )
    const inVault = await sql.query(
      `SELECT filename FROM docs WHERE folder_id = ${lit(vaultId)} AND deleted_at IS NULL`,
    )
    const taken = new Set(inVault.map((r) => String(r.filename)))
    for (const doc of rootDocs) {
      const filename = String(doc.filename)
      const next = availableFilename(filename, taken)
      taken.add(next)
      if (next === filename) continue
      statements.push(
        `UPDATE docs SET filename = ${lit(next)}, title = ${lit(next.replace(/\.md$/, ''))} WHERE id = ${lit(String(doc.id))}`,
      )
      summary.docsRenamed++
    }

    // 3 + 4. Re-parent root folders, re-home live root docs.
    const rootFolders = await sql.query(
      `SELECT COUNT(*) AS n FROM folders WHERE owner_user_id = ${lit(uid)} AND parent_id IS NULL AND kind = 'folder'`,
    )
    const folderCount = Number(rootFolders[0]?.n ?? 0)
    if (folderCount > 0) {
      statements.push(
        `UPDATE folders SET parent_id = ${lit(vaultId)} WHERE owner_user_id = ${lit(uid)} AND parent_id IS NULL AND kind = 'folder'`,
      )
    }
    if (rootDocs.length > 0) {
      statements.push(
        `UPDATE docs SET folder_id = ${lit(vaultId)} WHERE owner_user_id = ${lit(uid)} AND folder_id IS NULL AND deleted_at IS NULL`,
      )
    }

    // 5. Record the default vault (preserves an existing prefs row's other
    //    columns; heals a stale default_vault_id).
    statements.push(
      `INSERT INTO user_prefs (user_id, default_vault_id) VALUES (${lit(uid)}, ${lit(vaultId)})` +
        ` ON CONFLICT(user_id) DO UPDATE SET default_vault_id = ${lit(vaultId)}`,
    )

    summary.usersTouched++
    summary.foldersReparented += folderCount
    summary.docsRehomed += rootDocs.length

    const vaultLabel = createdName !== null ? `new vault ${lit(createdName)} ${vaultId}` : `existing vault ${vaultId}`
    log(
      `user ${uid}: ${vaultLabel} — ${folderCount} root folder(s), ${rootDocs.length} root doc(s)` +
        (options.dryRun ? ' [dry-run]' : ''),
    )
    for (const statement of statements) log(`  ${statement}`)
    if (!options.dryRun) await sql.execute(statements)
  }

  log(
    `${options.dryRun ? '[dry-run] would touch' : 'touched'} ${summary.usersTouched} user(s): ` +
      `${summary.vaultsCreated} vault(s) created, ${summary.foldersReparented} folder(s) re-parented, ` +
      `${summary.docsRehomed} doc(s) re-homed, ${summary.docsRenamed} renamed`,
  )
  return summary
}

// ---------------------------------------------------------------------------
// CLI entry: wrangler-backed runner (same shape as scripts/feedback.mjs)
// ---------------------------------------------------------------------------

function wranglerRunner(remote: boolean): SqlRunner {
  const webDir = join(dirname(fileURLToPath(import.meta.url)), '..')
  const run = (sql: string): Array<Record<string, unknown>> => {
    const res = spawnSync(
      'pnpm',
      ['exec', 'wrangler', 'd1', 'execute', 'inkwell', remote ? '--remote' : '--local', '--json', '--command', sql],
      { cwd: webDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    )
    if (res.status !== 0) {
      throw new Error(res.stderr || res.stdout || `wrangler exited with ${res.status}`)
    }
    const parsed = JSON.parse(res.stdout) as Array<{ results: Array<Record<string, unknown>> }>
    return parsed[0]?.results ?? []
  }
  return {
    query: async (sql) => run(sql),
    // One wrangler call per user batch; statements run in order. Safe order
    // by construction (vault insert first, prefs last) + idempotent re-runs.
    execute: async (statements) => {
      run(statements.join('; '))
    },
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const remote = args.includes('--remote')
  const dryRun = args.includes('--dry-run')
  const unknown = args.filter((a) => a !== '--remote' && a !== '--dry-run')
  if (unknown.length > 0) {
    console.error(`unknown argument(s): ${unknown.join(' ')} (expected --remote and/or --dry-run)`)
    process.exit(1)
  }
  console.log(`backfilling vaults against ${remote ? 'PRODUCTION' : 'local'} D1${dryRun ? ' (dry-run)' : ''}`)
  await backfillVaults(wranglerRunner(remote), { dryRun })
}

// Only run as a CLI (vitest imports backfillVaults without side effects).
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
