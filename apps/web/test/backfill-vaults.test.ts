import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { backfillVaults, type SqlRunner } from '../scripts/backfill-vaults.ts'

/**
 * Drives the backfill core through better-sqlite3 with the REAL partial
 * unique indexes from the migrations — proving every emitted statement
 * sequence keeps the filename/vault-name invariants at each step (the
 * wrangler runner applies the same statements to D1).
 */
function setup(): { sqlite: Database.Database; runner: SqlRunner } {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE folders (id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'folder', parent_id TEXT, created_at INTEGER NOT NULL);
    CREATE UNIQUE INDEX folders_vault_name_unique ON folders (owner_user_id, lower(name)) WHERE kind = 'vault';
    CREATE TABLE docs (id TEXT PRIMARY KEY, title TEXT NOT NULL, filename TEXT NOT NULL DEFAULT '',
      folder_id TEXT, owner_user_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER);
    CREATE UNIQUE INDEX docs_folder_filename_unique ON docs (folder_id, filename) WHERE folder_id IS NOT NULL AND deleted_at IS NULL;
    CREATE UNIQUE INDEX docs_root_filename_unique ON docs (owner_user_id, filename) WHERE folder_id IS NULL AND deleted_at IS NULL;
    CREATE TABLE assets (id TEXT PRIMARY KEY, folder_id TEXT, doc_id TEXT, filename TEXT NOT NULL,
      r2_key TEXT NOT NULL, content_type TEXT NOT NULL, size INTEGER NOT NULL, etag TEXT NOT NULL,
      created_by TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE user_prefs (user_id TEXT PRIMARY KEY, email_notifications INTEGER NOT NULL DEFAULT 1,
      default_vault_id TEXT);
  `)
  const runner: SqlRunner = {
    query: async (sql) => sqlite.prepare(sql).all() as Array<Record<string, unknown>>,
    execute: async (statements) => {
      // Statement-by-statement (no wrapping transaction), like the wrangler
      // runner — the unique indexes must hold at every intermediate step.
      for (const statement of statements) sqlite.prepare(statement).run()
    },
  }
  return { sqlite, runner }
}

let n = 0
const opts = () => ({ log: () => {}, newId: () => `vault-${++n}`, now: () => 1000 })

function rootDoc(id: string, owner: string, filename: string, createdAt = 1, deletedAt: number | null = null) {
  return {
    id,
    owner,
    filename,
    sql: `INSERT INTO docs (id, title, filename, folder_id, owner_user_id, created_at, updated_at, deleted_at)
          VALUES ('${id}', '${filename.replace(/\.md$/, '')}', '${filename}', NULL, '${owner}', ${createdAt}, ${createdAt}, ${deletedAt ?? 'NULL'})`,
  }
}

function snapshot(sqlite: Database.Database) {
  return {
    folders: sqlite.prepare('SELECT * FROM folders ORDER BY id').all(),
    docs: sqlite.prepare('SELECT * FROM docs ORDER BY id').all(),
    prefs: sqlite.prepare('SELECT * FROM user_prefs ORDER BY user_id').all(),
    assets: sqlite.prepare('SELECT * FROM assets ORDER BY id').all(),
  }
}

describe('backfillVaults', () => {
  it('re-homes root docs and re-parents root folders into a per-user Home vault', async () => {
    const { sqlite, runner } = setup()
    sqlite.exec(rootDoc('d1', 'u1', 'alpha.md').sql)
    sqlite.exec(rootDoc('d2', 'u2', 'alpha.md').sql) // same filename, other user — never collides
    sqlite.exec(`INSERT INTO folders (id, owner_user_id, name, parent_id, created_at) VALUES ('f1', 'u1', 'Projects', NULL, 1)`)
    sqlite.exec(`INSERT INTO folders (id, owner_user_id, name, parent_id, created_at) VALUES ('f2', 'u1', 'Sub', 'f1', 1)`)

    const summary = await backfillVaults(runner, opts())
    expect(summary).toMatchObject({ usersTouched: 2, vaultsCreated: 2, foldersReparented: 1, docsRehomed: 2, docsRenamed: 0 })

    const u1Vault = sqlite.prepare(`SELECT * FROM folders WHERE owner_user_id = 'u1' AND kind = 'vault'`).get() as Record<string, unknown>
    expect(u1Vault.name).toBe('Home')
    expect(u1Vault.parent_id).toBeNull()
    // Root folder re-parented under the vault; nested folder untouched.
    expect(sqlite.prepare(`SELECT parent_id FROM folders WHERE id = 'f1'`).get()).toEqual({ parent_id: u1Vault.id })
    expect(sqlite.prepare(`SELECT parent_id FROM folders WHERE id = 'f2'`).get()).toEqual({ parent_id: 'f1' })
    expect(sqlite.prepare(`SELECT folder_id FROM docs WHERE id = 'd1'`).get()).toEqual({ folder_id: u1Vault.id })
    expect(sqlite.prepare(`SELECT default_vault_id FROM user_prefs WHERE user_id = 'u1'`).get()).toEqual({
      default_vault_id: u1Vault.id,
    })
  })

  it('is idempotent — a second run touches nothing', async () => {
    const { sqlite, runner } = setup()
    sqlite.exec(rootDoc('d1', 'u1', 'alpha.md').sql)
    sqlite.exec(`INSERT INTO folders (id, owner_user_id, name, parent_id, created_at) VALUES ('f1', 'u1', 'Projects', NULL, 1)`)

    await backfillVaults(runner, opts())
    const before = snapshot(sqlite)
    const second = await backfillVaults(runner, opts())
    expect(second).toMatchObject({ usersTouched: 0, vaultsCreated: 0, foldersReparented: 0, docsRehomed: 0 })
    expect(snapshot(sqlite)).toEqual(before)
  })

  it('root filenames cannot collide (one root namespace folds into one vault)', async () => {
    const { sqlite, runner } = setup()
    // Per-owner root uniqueness means these are all distinct by construction.
    for (const f of ['a.md', 'b.md', 'c.md']) sqlite.exec(rootDoc(`d-${f}`, 'u1', f).sql)
    const summary = await backfillVaults(runner, opts())
    expect(summary.docsRenamed).toBe(0)
    const names = sqlite.prepare(`SELECT filename FROM docs ORDER BY filename`).all()
    expect(names).toEqual([{ filename: 'a.md' }, { filename: 'b.md' }, { filename: 'c.md' }])
  })

  it('suffixes a root doc colliding with a deploy-window doc already in the vault', async () => {
    const { sqlite, runner } = setup()
    // Deploy window: ensureDefaultVault already minted the vault and a new
    // doc landed in it under the same name as an old root doc.
    sqlite.exec(`INSERT INTO folders (id, owner_user_id, name, kind, parent_id, created_at) VALUES ('v1', 'u1', 'Home', 'vault', NULL, 1)`)
    sqlite.exec(`INSERT INTO user_prefs (user_id, default_vault_id) VALUES ('u1', 'v1')`)
    sqlite.exec(`INSERT INTO docs (id, title, filename, folder_id, owner_user_id, created_at, updated_at, deleted_at)
                 VALUES ('d-new', 'notes', 'notes.md', 'v1', 'u1', 5, 5, NULL)`)
    sqlite.exec(rootDoc('d-old', 'u1', 'notes.md').sql)

    const summary = await backfillVaults(runner, opts())
    expect(summary).toMatchObject({ usersTouched: 1, vaultsCreated: 0, docsRehomed: 1, docsRenamed: 1 })
    expect(sqlite.prepare(`SELECT filename, title, folder_id FROM docs WHERE id = 'd-old'`).get()).toEqual({
      filename: 'notes-2.md',
      title: 'notes-2',
      folder_id: 'v1',
    })
  })

  it('leaves trashed docs and asset rows alone', async () => {
    const { sqlite, runner } = setup()
    sqlite.exec(rootDoc('d-live', 'u1', 'live.md').sql)
    sqlite.exec(rootDoc('d-trash', 'u1', 'trash.md', 1, 999).sql)
    sqlite.exec(`INSERT INTO assets (id, folder_id, doc_id, filename, r2_key, content_type, size, etag, created_by, created_at)
                 VALUES ('a1', NULL, 'd-live', 'pic.png', 'doc/d-live/pic.png', 'image/png', 1, 'e', 'u1', 1)`)

    await backfillVaults(runner, opts())
    expect(sqlite.prepare(`SELECT folder_id, deleted_at FROM docs WHERE id = 'd-trash'`).get()).toEqual({
      folder_id: null,
      deleted_at: 999,
    })
    // Asset row untouched: still doc-scoped, same r2_key (read fallback serves it).
    expect(sqlite.prepare(`SELECT folder_id, doc_id, r2_key FROM assets WHERE id = 'a1'`).get()).toEqual({
      folder_id: null,
      doc_id: 'd-live',
      r2_key: 'doc/d-live/pic.png',
    })
  })

  it('dry-run plans without writing', async () => {
    const { sqlite, runner } = setup()
    sqlite.exec(rootDoc('d1', 'u1', 'alpha.md').sql)
    const before = snapshot(sqlite)
    const summary = await backfillVaults(runner, { ...opts(), dryRun: true })
    expect(summary.usersTouched).toBe(1)
    expect(summary.vaultsCreated).toBe(1) // planned, not applied
    expect(snapshot(sqlite)).toEqual(before)
  })

  it('reuses an existing valid default vault instead of minting Home', async () => {
    const { sqlite, runner } = setup()
    sqlite.exec(`INSERT INTO folders (id, owner_user_id, name, kind, parent_id, created_at) VALUES ('v1', 'u1', 'Stuff', 'vault', NULL, 1)`)
    sqlite.exec(`INSERT INTO user_prefs (user_id, default_vault_id) VALUES ('u1', 'v1')`)
    sqlite.exec(rootDoc('d1', 'u1', 'alpha.md').sql)
    const summary = await backfillVaults(runner, opts())
    expect(summary.vaultsCreated).toBe(0)
    expect(sqlite.prepare(`SELECT folder_id FROM docs WHERE id = 'd1'`).get()).toEqual({ folder_id: 'v1' })
  })
})
