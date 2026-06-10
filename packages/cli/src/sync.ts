import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { normalizeEol } from '@glyphdown/core'
import type { DocMeta, PushResponse } from '@glyphdown/protocol'
import { type Api, type ContentResult, type FolderMeta, type VaultMeta, pushWithBase } from './api.ts'
import { CliError, DEGENERATE_MESSAGE } from './errors.ts'
import {
  type DocWorkspaceMeta,
  type Workspace,
  listMetas,
  loadWorkspace,
  recordBase,
  rewriteMeta,
  sha256Hex,
  slugify,
  workspaceRoot,
  writePull,
} from './workspace.ts'

// ---------------------------------------------------------------------------
// .glyphdown/folder.json — links a directory to a server folder so
// `glyphdown sync` can discover docs added to the folder after the original
// `glyphdown pull --folder`. (Legacy `.ink/` workspaces are honored too —
// see workspaceRoot.)
// ---------------------------------------------------------------------------

export interface FolderConfig {
  folderId: string
  folderName: string
  serverUrl: string
}

export function folderConfigPath(dir: string): string {
  return join(workspaceRoot(dir), 'folder.json')
}

export function readFolderConfig(dir: string): FolderConfig | null {
  const path = folderConfigPath(dir)
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<FolderConfig>
    if (
      typeof parsed.folderId === 'string' &&
      typeof parsed.folderName === 'string' &&
      typeof parsed.serverUrl === 'string'
    ) {
      return { folderId: parsed.folderId, folderName: parsed.folderName, serverUrl: parsed.serverUrl }
    }
  } catch {
    // unreadable — treated as absent; the next `glyphdown pull --folder` rewrites it
  }
  return null
}

export function writeFolderConfig(dir: string, config: FolderConfig): void {
  mkdirSync(workspaceRoot(dir), { recursive: true })
  writeFileSync(folderConfigPath(dir), `${JSON.stringify(config, null, 2)}\n`)
}

// ---------------------------------------------------------------------------
// Folder resolution + slug allocation
// ---------------------------------------------------------------------------

/**
 * Resolve a folder reference — folder id or exact name — via GET /api/folders.
 * A vault IS a folder, so vault refs work here too: when no exact folder name
 * matches, vault rows (kind='vault') are retried case-insensitively, matching
 * how `--vault` resolves names (vault names are unique per owner that way).
 */
export async function resolveFolder(api: Api, ref: string): Promise<FolderMeta> {
  const folders = await api.listFolders()
  const byId = folders.find((f) => f.id === ref)
  if (byId) return byId
  let byName = folders.filter((f) => f.name === ref)
  if (byName.length === 0) {
    const lower = ref.toLowerCase()
    byName = folders.filter((f) => f.kind === 'vault' && f.name.toLowerCase() === lower)
  }
  if (byName.length === 1) return byName[0]!
  if (byName.length > 1) {
    const candidates = byName.map((f) => `  ${f.id}  ${f.name}`).join('\n')
    throw new CliError(1, `folder name "${ref}" is ambiguous — pass an id instead:\n${candidates}`)
  }
  throw new CliError(
    1,
    `no folder matches "${ref}" (checked ids and exact names of ${folders.length} accessible folder(s))`,
  )
}

/**
 * Resolve a vault reference — vault id or name — via GET /api/vaults (NOT the
 * generic folder lookup: vault names are unique per owner case-insensitively,
 * so name matching is case-insensitive here). A name carried by both an owned
 * and a shared vault is ambiguous — the error lists ids.
 */
export async function resolveVault(api: Api, ref: string): Promise<VaultMeta> {
  const vaults = await api.listVaults()
  const byId = vaults.find((v) => v.id === ref)
  if (byId) return byId
  const lower = ref.toLowerCase()
  const byName = vaults.filter((v) => v.name.toLowerCase() === lower)
  if (byName.length === 1) return byName[0]!
  if (byName.length > 1) {
    const candidates = byName.map((v) => `  ${v.id}  ${v.name} (${v.role})`).join('\n')
    throw new CliError(1, `vault name "${ref}" is ambiguous — pass an id instead:\n${candidates}`)
  }
  if (vaults.length === 0) {
    throw new CliError(1, `no vault matches "${ref}" — you have no accessible vaults (run \`glyphdown vaults\`)`)
  }
  const known = vaults.map((v) => `  ${v.id}  ${v.name}`).join('\n')
  throw new CliError(1, `no vault matches "${ref}" — accessible vaults:\n${known}`)
}

/**
 * Local file for a server doc: its canonical `filename` VERBATIM — the
 * server name IS the file name (filesystem model), which is what makes
 * clone(sync(x)) == x for names. '-2'/'-3' suffixes are applied only when a
 * DIFFERENT local file already claims the name (`used` holds stems); the next
 * sync's convergence pass re-checks. Falls back to slugifying the title for
 * pre-filename servers.
 */
export function fileForDoc(doc: Pick<DocMeta, 'filename' | 'title'>, used: Set<string>): string {
  const base = typeof doc.filename === 'string' && doc.filename !== '' ? fileSlug(doc.filename) : slugify(doc.title)
  let slug = base
  for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`
  used.add(slug)
  return `${slug}.md`
}

function fileSlug(file: string): string {
  return file.replace(/\.md$/, '')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ---------------------------------------------------------------------------
// glyphdown pull --folder
// ---------------------------------------------------------------------------

export interface PullFolderOptions {
  api: Api
  serverUrl: string
  /** Folder id or exact name. */
  folderRef: string
  /** Target directory, cwd-relative (default: ./<slugified folder name>). */
  dir?: string
  cwd: string
  out: (line: string) => void
}

export interface PullFolderResult {
  /** Absolute target directory. */
  dir: string
  folder: FolderMeta
  pulled: Array<{ docId: string; file: string }>
}

/**
 * Pull every non-deleted doc in a folder into one directory: <slug>.md per
 * doc plus the usual .glyphdown/<docId>/ base bookkeeping, then record the
 * folder in .glyphdown/folder.json so `glyphdown sync` can discover docs
 * added later.
 */
export async function pullFolder(opts: PullFolderOptions): Promise<PullFolderResult> {
  const folder = await resolveFolder(opts.api, opts.folderRef)
  const dir = resolve(opts.cwd, opts.dir ?? slugify(folder.name))
  const docs = (await opts.api.listDocs()).filter((d) => d.folderId === folder.id)

  // Re-pulls keep each already-tracked doc in its existing file.
  const tracked = new Map(listMetas(dir).map((m) => [m.docId, m]))
  const used = new Set([...tracked.values()].map((m) => fileSlug(m.file)))

  const pulled: Array<{ docId: string; file: string }> = []
  for (const doc of docs) {
    // Sequential on purpose: one GET per doc, readable output.
    const file = tracked.get(doc.id)?.file ?? fileForDoc(doc, used)
    const content = await opts.api.getContent(doc.id, 'working')
    const ws = writePull(
      {
        targetPath: join(dir, file),
        docId: doc.id,
        serverUrl: opts.serverUrl,
        text: content.text,
        ...(content.versionId !== null ? { versionId: content.versionId } : {}),
      },
      opts.cwd,
    )
    pulled.push({ docId: doc.id, file })
    opts.out(`pulled ${doc.title} → ${ws.path}`)
  }

  writeFolderConfig(dir, { folderId: folder.id, folderName: folder.name, serverUrl: opts.serverUrl })
  return { dir, folder, pulled }
}

// ---------------------------------------------------------------------------
// glyphdown push --all
// ---------------------------------------------------------------------------

export interface PushAllOptions {
  /** Absolute directory containing the tracked docs. */
  dir: string
  apiFor: (serverUrl: string) => Api
  suggest?: boolean
  force?: boolean
  note?: string
  out: (line: string) => void
  err: (line: string) => void
}

interface DocFailure {
  file: string
  exitCode: number
  message: string
}

export function pushRejection(response: Extract<PushResponse, { ok: false }>): { exitCode: number; message: string } {
  if (response.reason === 'degenerate') {
    return {
      exitCode: 3,
      message: `${DEGENERATE_MESSAGE} (deletes ${Math.round(response.deletedRatio * 100)}% of the base)`,
    }
  }
  if (response.reason === 'base-missing') {
    return { exitCode: 1, message: 'server rejected the base even after re-sending it — re-pull and retry' }
  }
  if (response.reason === 'rate-limited') {
    return {
      exitCode: 1,
      message: `rate-limited — retry ${response.retryAfterSec ? `in ${response.retryAfterSec}s` : 'shortly'}`,
    }
  }
  return { exitCode: 1, message: `push rejected: ${response.reason}` }
}

/**
 * Push every tracked doc whose file hash drifted from its recorded base.
 * Sequential on purpose — pushes are rate-limited per identity (60/min,
 * SPEC §8.3 step 9) and interleaved output is unreadable. Continues past
 * per-doc failures; throws at the end when any doc failed (the failing doc's
 * exit code when all failures share one, otherwise 1).
 */
export async function pushAll(opts: PushAllOptions): Promise<void> {
  const metas = listMetas(opts.dir).sort((a, b) => a.file.localeCompare(b.file))
  if (metas.length === 0) {
    throw new CliError(1, 'no tracked docs here — run `glyphdown pull <doc>` or `glyphdown pull --folder <folder>` first')
  }

  const failures: DocFailure[] = []
  let pushed = 0
  let unchanged = 0

  for (const meta of metas) {
    try {
      const ws = loadWorkspace(opts.dir, meta)
      const newText = normalizeEol(readFileSync(ws.path, 'utf8'))
      if (sha256Hex(newText) === ws.meta.baseHash) {
        unchanged++
        opts.out(`unchanged ${meta.file}`)
        continue
      }

      const api = opts.apiFor(ws.meta.serverUrl)
      const { response } = await pushWithBase(api, {
        docId: ws.meta.docId,
        newText,
        baseHash: ws.meta.baseHash,
        baseText: ws.baseText,
        ...(opts.suggest ? { suggest: true } : {}),
        ...(opts.force ? { force: true } : {}),
        ...(opts.note !== undefined ? { note: opts.note } : {}),
      })

      if (!response.ok) {
        const rejection = pushRejection(response)
        failures.push({ file: meta.file, ...rejection })
        opts.err(`failed ${meta.file}: ${rejection.message}`)
        continue
      }
      if (response.mode === 'suggest') {
        pushed++
        opts.out(`suggested ${meta.file}: suggestion ${response.suggestionId} (base unchanged)`)
        continue
      }
      if (response.failedHunks.length > 0) {
        failures.push({ file: meta.file, exitCode: 2, message: `${response.failedHunks.length} failed hunk(s)` })
        for (const hunk of response.failedHunks) opts.err(hunk)
        opts.err(`failed ${meta.file}: ${response.failedHunks.length} hunk(s) not applied — base unchanged, re-pull`)
        continue
      }
      recordBase({
        dir: opts.dir,
        file: ws.meta.file,
        docId: ws.meta.docId,
        serverUrl: ws.meta.serverUrl,
        text: newText,
        versionId: response.versionId,
      })
      pushed++
      opts.out(`pushed ${meta.file}: ${response.applied} change(s) applied (version ${response.versionId})`)
    } catch (error) {
      const exitCode = error instanceof CliError ? error.exitCode : 1
      failures.push({ file: meta.file, exitCode, message: errorMessage(error) })
      opts.err(`failed ${meta.file}: ${errorMessage(error)}`)
    }
  }

  opts.out(`${pushed} pushed, ${unchanged} unchanged, ${failures.length} failed`)
  if (failures.length > 0) {
    const codes = new Set(failures.map((f) => f.exitCode))
    const exitCode = codes.size === 1 ? [...codes][0]! : 1
    throw new CliError(exitCode, `push --all: ${failures.length} of ${metas.length} doc(s) failed`)
  }
}

// ---------------------------------------------------------------------------
// glyphdown sync
// ---------------------------------------------------------------------------

export type SyncAction =
  | 'up-to-date'
  | 'pushed'
  | 'pulled'
  | 'merged'
  | 'new'
  | 'remote-gone'
  | 'skipped-degenerate'
  | 'failed'
  /** Untracked local .md pushed up as a brand-new server doc. */
  | 'created'
  /** Tracked doc whose local file vanished — re-pulled (no delete propagation). */
  | 'repulled'
  /** New local directory created as a server folder. */
  | 'folder-created'
  /** New server folder materialized as a local directory. */
  | 'folder-new'
  /** Server-side folder rename noted; the local directory is NOT moved (v1). */
  | 'folder-renamed'

export interface SyncDocResult {
  /** Doc id — or the folder id for folder-* actions. */
  docId: string
  /** Workspace-relative file path — or `dir/` for folder-* actions. */
  file: string
  action: SyncAction
  /** Hunks the server could not apply during a merge (exit 2 when > 0). */
  failedHunks?: number
  message?: string
}

export interface SyncOptions {
  /** Absolute directory containing the tracked docs. */
  dir: string
  apiFor: (serverUrl: string) => Api
  /** Pass --force through to pushes (overrides the degenerate-diff guard). */
  force?: boolean
  /** Warning sink (remote-gone docs are warned here, not failed). */
  err: (line: string) => void
  /**
   * Server-side canonical filename per doc id (from a listDocs snapshot).
   * When a tracked doc's local file name differs, syncTracked RENAMES the
   * local file to the canonical name before reconciling — the one-time
   * convergence that makes pre-filename workspaces match the server.
   */
  filenameOf?: (docId: string) => string | undefined
}

/**
 * Two-way reconcile of every tracked doc, plus new-doc discovery when the
 * directory is linked to a folder (folder.json in the workspace root). One
 * GET per doc serves three purposes: liveness (404 → remote gone), the
 * server's base hash (x-glyphdown-base-hash), and the body — never fetched
 * twice for a plain pull. One listDocs up front feeds both filename
 * convergence (local files rename to the server's canonical names) and
 * folder-linked new-doc discovery.
 */
export async function syncAll(opts: SyncOptions): Promise<SyncDocResult[]> {
  const metas = listMetas(opts.dir).sort((a, b) => a.file.localeCompare(b.file))
  const folderConfig = readFolderConfig(opts.dir)
  if (metas.length === 0 && folderConfig === null) {
    throw new CliError(1, 'nothing to sync — run `glyphdown pull <doc>` or `glyphdown pull --folder <folder>` first')
  }

  // One listDocs snapshot: canonical filenames for convergence + discovery.
  let serverDocs: DocMeta[] | null = null
  let listFailure: SyncDocResult | null = null
  const serverUrl = folderConfig?.serverUrl ?? metas[0]?.serverUrl
  if (serverUrl !== undefined) {
    try {
      serverDocs = await opts.apiFor(serverUrl).listDocs()
    } catch (error) {
      // Convergence is best-effort (per-doc reconciles still run and report
      // their own failures honestly); folder discovery, however, depends on
      // the listing — record the failure like discoverNewDocs used to.
      if (folderConfig) {
        listFailure = {
          docId: folderConfig.folderId,
          file: '(folder)',
          action: 'failed',
          message: `listing folder "${folderConfig.folderName}" failed: ${errorMessage(error)}`,
        }
      }
    }
  }
  const byId = serverDocs !== null ? new Map(serverDocs.map((d) => [d.id, d])) : null
  const effOpts: SyncOptions =
    opts.filenameOf === undefined && byId !== null
      ? { ...opts, filenameOf: (docId) => byId.get(docId)?.filename }
      : opts

  const results: SyncDocResult[] = []
  for (const meta of metas) {
    // Sequential on purpose (rate limit + readable output), like push --all.
    results.push(await syncTracked(effOpts, meta))
  }
  if (folderConfig) {
    if (serverDocs !== null) {
      results.push(...(await discoverNewDocs(effOpts, folderConfig, metas, serverDocs)))
    } else if (listFailure !== null) {
      results.push(listFailure)
    }
  }
  return results
}

/**
 * Reconcile one tracked doc (shared by syncAll and the recursive mirror
 * sync). When the server's canonical filename differs from the tracked local
 * name, the local file is renamed FIRST (manifest updated, reported as
 * `renamed locally: old → new`) — the one-time convergence after the
 * filename-canonical migration; from then on names round-trip verbatim.
 */
export async function syncTracked(opts: SyncOptions, meta: DocWorkspaceMeta): Promise<SyncDocResult> {
  const { meta: effective, note } = convergeFilename(opts, meta)
  const result = await reconcileTracked(opts, effective)
  if (note === undefined) return result
  return { ...result, message: result.message !== undefined ? `${note} — ${result.message}` : note }
}

/** Rename the tracked file to the server's canonical name when they differ. */
function convergeFilename(
  opts: SyncOptions,
  meta: DocWorkspaceMeta,
): { meta: DocWorkspaceMeta; note?: string } {
  const canonical = opts.filenameOf?.(meta.docId)
  if (canonical === undefined || canonical === '' || canonical === meta.file) return { meta }
  const oldPath = join(opts.dir, meta.file)
  const newPath = join(opts.dir, canonical)
  if (existsSync(newPath)) {
    opts.err(
      `warning: ${meta.file} — server name is ${canonical}, but a local file with that name already exists; not renamed`,
    )
    return { meta }
  }
  try {
    // A missing old file still converges the manifest: the reconcile's
    // re-pull then materializes under the canonical name.
    if (existsSync(oldPath)) renameSync(oldPath, newPath)
    const next = { ...meta, file: canonical }
    rewriteMeta(opts.dir, next)
    return { meta: next, note: `renamed locally: ${meta.file} → ${canonical}` }
  } catch (error) {
    opts.err(`warning: ${meta.file} — rename to ${canonical} failed: ${errorMessage(error)}`)
    return { meta }
  }
}

/** The per-doc two-way reconcile body (post filename convergence). */
async function reconcileTracked(opts: SyncOptions, meta: DocWorkspaceMeta): Promise<SyncDocResult> {
  const id = { docId: meta.docId, file: meta.file }

  let ws: Workspace
  try {
    ws = loadWorkspace(opts.dir, meta)
  } catch (error) {
    return { ...id, action: 'failed', message: errorMessage(error) }
  }
  const api = opts.apiFor(ws.meta.serverUrl)

  let content: ContentResult
  try {
    content = await api.getContent(meta.docId, 'working')
  } catch (error) {
    if (error instanceof CliError && error.status === 404) {
      opts.err(`warning: ${meta.file} — doc ${meta.docId} is gone on the server; local file left alone`)
      return { ...id, action: 'remote-gone' }
    }
    return { ...id, action: 'failed', message: errorMessage(error) }
  }
  const remoteText = content.text
  const remoteHash = content.baseHash ?? sha256Hex(remoteText)

  let localText: string
  try {
    localText = normalizeEol(readFileSync(ws.path, 'utf8'))
  } catch {
    // Tracked but the local file is gone. Deletions never propagate: the
    // server doc stays intact and the local copy is re-pulled.
    try {
      writeFileSync(ws.path, remoteText)
      recordBase({
        dir: opts.dir,
        file: meta.file,
        docId: meta.docId,
        serverUrl: ws.meta.serverUrl,
        text: remoteText,
        ...(content.versionId !== null ? { versionId: content.versionId } : {}),
      })
      return { ...id, action: 'repulled', message: 'local file missing — re-pulled from the server' }
    } catch (error) {
      return { ...id, action: 'failed', message: errorMessage(error) }
    }
  }
  const localHash = sha256Hex(localText)
  const localChanged = localHash !== ws.meta.baseHash
  const remoteChanged = remoteHash !== ws.meta.baseHash

  if (!localChanged && !remoteChanged) return { ...id, action: 'up-to-date' }

  if (!localChanged) {
    // Remote only: overwrite the local file with the already-fetched text.
    writeFileSync(ws.path, remoteText)
    recordBase({
      dir: opts.dir,
      file: meta.file,
      docId: meta.docId,
      serverUrl: ws.meta.serverUrl,
      text: remoteText,
      ...(content.versionId !== null ? { versionId: content.versionId } : {}),
    })
    return { ...id, action: 'pulled' }
  }

  if (localHash === remoteHash) {
    // Both sides converged on identical text — just move the base forward.
    recordBase({
      dir: opts.dir,
      file: meta.file,
      docId: meta.docId,
      serverUrl: ws.meta.serverUrl,
      text: localText,
      ...(content.versionId !== null ? { versionId: content.versionId } : {}),
    })
    return { ...id, action: 'up-to-date' }
  }

  // Local changed (and possibly remote too): push — the server CRDT-merges.
  let response: PushResponse
  try {
    const outcome = await pushWithBase(api, {
      docId: meta.docId,
      newText: localText,
      baseHash: ws.meta.baseHash,
      baseText: ws.baseText,
      ...(opts.force ? { force: true } : {}),
    })
    response = outcome.response
  } catch (error) {
    return { ...id, action: 'failed', message: errorMessage(error) }
  }

  if (!response.ok) {
    if (response.reason === 'degenerate') {
      return {
        ...id,
        action: 'skipped-degenerate',
        message: `${DEGENERATE_MESSAGE} (deletes ${Math.round(response.deletedRatio * 100)}% of the base)`,
      }
    }
    return { ...id, action: 'failed', message: pushRejection(response).message }
  }

  if (response.mode === 'suggest') {
    // Suggester-role pushes land as suggestions; the base cannot move.
    return { ...id, action: 'pushed', message: `landed as suggestion ${response.suggestionId} — base unchanged` }
  }

  if (!remoteChanged && response.failedHunks.length === 0) {
    // No drift: the server text now equals the local file exactly.
    recordBase({
      dir: opts.dir,
      file: meta.file,
      docId: meta.docId,
      serverUrl: ws.meta.serverUrl,
      text: localText,
      versionId: response.versionId,
    })
    return { ...id, action: 'pushed' }
  }

  // Both changed: re-GET the merged result and converge the file + base on it.
  try {
    const merged = await api.getContent(meta.docId, 'working')
    writeFileSync(ws.path, merged.text)
    recordBase({
      dir: opts.dir,
      file: meta.file,
      docId: meta.docId,
      serverUrl: ws.meta.serverUrl,
      text: merged.text,
      ...(merged.versionId !== null ? { versionId: merged.versionId } : {}),
    })
  } catch (error) {
    return {
      ...id,
      action: 'failed',
      ...(response.failedHunks.length > 0 ? { failedHunks: response.failedHunks.length } : {}),
      message: `push applied but re-fetching the merged text failed: ${errorMessage(error)}`,
    }
  }
  return {
    ...id,
    action: 'merged',
    ...(response.failedHunks.length > 0 ? { failedHunks: response.failedHunks.length } : {}),
  }
}

/** Pull folder docs that appeared server-side after the original folder pull. */
async function discoverNewDocs(
  opts: SyncOptions,
  config: FolderConfig,
  metas: DocWorkspaceMeta[],
  docs: DocMeta[],
): Promise<SyncDocResult[]> {
  const api = opts.apiFor(config.serverUrl)
  const trackedIds = new Set(metas.map((m) => m.docId))
  const used = new Set(metas.map((m) => fileSlug(m.file)))
  const results: SyncDocResult[] = []
  for (const doc of docs) {
    if (doc.folderId !== config.folderId || trackedIds.has(doc.id)) continue
    const file = fileForDoc(doc, used)
    try {
      const content = await api.getContent(doc.id, 'working')
      writePull(
        {
          targetPath: join(opts.dir, file),
          docId: doc.id,
          serverUrl: config.serverUrl,
          text: content.text,
          ...(content.versionId !== null ? { versionId: content.versionId } : {}),
        },
        opts.dir,
      )
      results.push({ docId: doc.id, file, action: 'new' })
    } catch (error) {
      results.push({ docId: doc.id, file, action: 'failed', message: errorMessage(error) })
    }
  }
  return results
}

/** Exit code for a sync run: 0 clean, 2 failed hunks, 3 degenerate skip, 1 other failures. */
export function syncExitCode(results: SyncDocResult[]): number {
  if (results.some((r) => (r.failedHunks ?? 0) > 0)) return 2
  if (results.some((r) => r.action === 'skipped-degenerate')) return 3
  if (results.some((r) => r.action === 'failed')) return 1
  return 0
}
