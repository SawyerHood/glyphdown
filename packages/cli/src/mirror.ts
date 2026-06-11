import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { normalizeEol } from '@glyphdown/core'
import type { DocMeta, FolderMeta } from '@glyphdown/protocol'
import { MAX_FOLDER_DEPTH, SYNCABLE_ASSET_FILE_EXTENSIONS } from '@glyphdown/protocol'
import { type Api, pushWithBase } from './api.ts'
import { type AssetOps, type AssetSyncResult, docAssetOps, folderAssetOps, pullAssets, syncAssets } from './assets.ts'
import { CliError } from './errors.ts'
import {
  type SyncDocResult,
  type SyncOptions,
  fileForDoc,
  pushRejection,
  readFolderConfig,
  syncTracked,
  writeFolderConfig,
} from './sync.ts'
import { type DocWorkspaceMeta, listMetas, recordBase, sha256Hex, slugify, workspaceRoot, writePull } from './workspace.ts'

/**
 * Full-account mirror: `glyphdown clone` materializes every accessible
 * folder/doc as a nested directory tree, and the recursive `glyphdown sync`
 * keeps it converged in both directions.
 *
 * MANIFEST DESIGN — distributed, id-keyed, backward compatible:
 *  - `.glyphdown/workspace.json` at the clone root marks a full-mirror
 *    workspace (`{version, serverUrl, clonedAt}`).
 *  - Every folder directory keeps its own `.glyphdown/folder.json`
 *    (`{folderId, folderName, serverUrl}`) — the dir ↔ folderId map. Mapping
 *    is by id, so server-side renames/moves never orphan a local dir.
 *  - Every directory keeps the existing per-doc `.glyphdown/<docId>/
 *    {meta.json, base.md}` (doc ↔ file map) and `.glyphdown/assets.json`
 *    bookkeeping.
 * Because folder dirs use the pre-existing single-folder layout verbatim, an
 * old `glyphdown pull --folder` workspace IS a valid mirror subtree: no
 * migration step — `glyphdown sync` detects the shape (workspace.json →
 * account mirror, folder.json → folder subtree, bare doc metas → single-dir)
 * and recurses from there. Workspaces created by the pre-rename `ink` CLI
 * keep their `.ink/` bookkeeping dir and are detected the same way (see
 * workspaceRoot) — no migration there either.
 *
 * SEMANTICS (v1, documented in the README):
 *  - No delete propagation in either direction. Server-gone docs warn and the
 *    local file stays; locally-deleted-but-tracked files are re-pulled.
 *  - FILENAMES ARE CANONICAL (filesystem model): a doc's server `filename`
 *    IS its local file name. Tracked files whose names drifted (a web-UI
 *    rename, or the one-time backfill migration) are RENAMED locally to the
 *    canonical name during sync (`renamed locally: old → new`). New local
 *    .md files are created server-side under their own (slugified) file
 *    name — the H1 heading is content, never a name source. Local renames of
 *    tracked files are NOT detected (the old name re-pulls, the new file
 *    becomes a new doc — warned loudly); use `glyphdown mv` instead.
 *  - Server folder renames/moves are noted (folder.json name refreshed) but
 *    local directories are never renamed or moved.
 *  - Dotfiles (including the bookkeeping dir) and non-markdown/non-asset
 *    files are ignored.
 */

// ---------------------------------------------------------------------------
// .glyphdown/workspace.json
// ---------------------------------------------------------------------------

export interface WorkspaceConfig {
  version: 1
  serverUrl: string
  clonedAt: number
}

export function workspaceConfigPath(dir: string): string {
  return join(workspaceRoot(dir), 'workspace.json')
}

export function readWorkspaceConfig(dir: string): WorkspaceConfig | null {
  const path = workspaceConfigPath(dir)
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<WorkspaceConfig>
    if (typeof parsed.serverUrl === 'string') {
      return { version: 1, serverUrl: parsed.serverUrl, clonedAt: typeof parsed.clonedAt === 'number' ? parsed.clonedAt : 0 }
    }
  } catch {
    // unreadable — treated as absent
  }
  return null
}

export function writeWorkspaceConfig(dir: string, config: WorkspaceConfig): void {
  mkdirSync(workspaceRoot(dir), { recursive: true })
  writeFileSync(workspaceConfigPath(dir), `${JSON.stringify(config, null, 2)}\n`)
}

/** True when dir already carries any Glyphdown bookkeeping (re-clone guard). */
export function isWorkspace(dir: string): boolean {
  return readWorkspaceConfig(dir) !== null || readFolderConfig(dir) !== null || listMetas(dir).length > 0
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const SYNCABLE_ASSET_EXTENSION_SET = new Set<string>(SYNCABLE_ASSET_FILE_EXTENSIONS)

function isSyncableAssetFile(name: string): boolean {
  return SYNCABLE_ASSET_EXTENSION_SET.has(name.slice(name.lastIndexOf('.') + 1).toLowerCase())
}

function isMarkdownFile(name: string): boolean {
  return name.endsWith('.md')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Allocate a directory name for a folder, suffixing -2, -3… on collisions. */
export function allocateDirName(name: string, used: Set<string>): string {
  const base = slugify(name)
  let candidate = base
  for (let n = 2; used.has(candidate); n++) candidate = `${base}-${n}`
  used.add(candidate)
  return candidate
}

/**
 * The filename a local .md file gets on the server: its own name, slugified
 * if it isn't already a clean slug. The H1 heading inside the file is just
 * CONTENT — never read for naming (filesystem model: the file name IS the
 * doc name).
 */
export function filenameForLocalFile(file: string): string {
  return `${slugify(basename(file).replace(/\.md$/i, ''))}.md`
}

/** Existing `<stem>.md` stems in a dir — the used-set seed for fileForDoc. */
function usedFileSlugs(dir: string): Set<string> {
  if (!existsSync(dir)) return new Set()
  return new Set(
    readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && isMarkdownFile(e.name))
      .map((e) => e.name.replace(/\.md$/, '')),
  )
}

/**
 * The accessible folder tree. Children are keyed by parent id; folders whose
 * parent is not in the accessible set (a granted subtree without its
 * ancestors) are promoted to the root (key null).
 */
export function folderChildren(folders: FolderMeta[]): Map<string | null, FolderMeta[]> {
  const byId = new Map(folders.map((f) => [f.id, f]))
  const children = new Map<string | null, FolderMeta[]>()
  for (const f of folders) {
    const key = f.parentId !== null && byId.has(f.parentId) ? f.parentId : null
    const list = children.get(key) ?? []
    list.push(f)
    children.set(key, list)
  }
  for (const list of children.values()) list.sort((a, b) => a.name.localeCompare(b.name))
  return children
}

// ---------------------------------------------------------------------------
// glyphdown clone
// ---------------------------------------------------------------------------

export interface CloneOptions {
  api: Api
  serverUrl: string
  /** Target directory, cwd-relative (default: ./glyphdown, or ./<vault slug> with `vault`). */
  dir?: string
  cwd: string
  /**
   * Scope the clone to one vault's subtree (`glyphdown clone --vault`). The
   * workspace root links to the vault via `.glyphdown/folder.json` — the same
   * layout `pull --folder` writes — so `glyphdown sync`'s existing
   * rootFolderConfig path confines the workspace to the subtree for free
   * (workspace.json is NOT written; it would force account-wide scope).
   */
  vault?: { id: string; name: string }
  out: (line: string) => void
  err: (line: string) => void
}

export interface CloneResult {
  /** Absolute workspace root. */
  dir: string
  folders: number
  docs: number
  failures: number
}

/**
 * Mirror everything the caller can access: the folder tree as nested
 * directories (slugified names, sibling-collision suffixes), every doc pulled
 * into its folder's directory (root-level docs into the workspace root), and
 * every folder's assets downloaded alongside its docs. With `vault`, the
 * mirror is scoped to that vault's subtree: its child folders become the
 * top-level directories, its direct docs land in the workspace root, and
 * everything outside the vault is skipped.
 */
export async function clone(opts: CloneOptions): Promise<CloneResult> {
  const root = resolve(opts.cwd, opts.dir ?? (opts.vault ? slugify(opts.vault.name) : 'glyphdown'))
  if (isWorkspace(root)) {
    throw new CliError(1, `${root} is already a Glyphdown workspace — run \`glyphdown sync\` there instead of re-cloning`)
  }
  mkdirSync(root, { recursive: true })

  /** Scope root: the vault's folder id, or null for the account mirror. */
  const rootKey: string | null = opts.vault?.id ?? null

  const folders = await opts.api.listFolders()
  const docs = await opts.api.listDocs()
  const children = folderChildren(folders)

  let failures = 0

  // Folder tree, breadth-first so parents exist before children.
  const dirByFolderId = new Map<string, { abs: string; rel: string }>()
  const usedByDir = new Map<string, Set<string>>()
  const seen = new Set<string>()
  const queue = (children.get(rootKey) ?? []).map((f) => ({ folder: f, parentAbs: root, parentRel: '', depth: 1 }))
  while (queue.length > 0) {
    const { folder, parentAbs, parentRel, depth } = queue.shift()!
    if (seen.has(folder.id)) continue // cycle guard (the server prevents cycles)
    seen.add(folder.id)
    if (depth > MAX_FOLDER_DEPTH) {
      opts.err(`warning: folder "${folder.name}" is nested deeper than ${MAX_FOLDER_DEPTH} — skipped`)
      continue
    }
    let used = usedByDir.get(parentAbs)
    if (!used) {
      used = new Set(existsSync(parentAbs) ? readdirSync(parentAbs) : [])
      usedByDir.set(parentAbs, used)
    }
    const name = allocateDirName(folder.name, used)
    const abs = join(parentAbs, name)
    const rel = parentRel === '' ? name : `${parentRel}/${name}`
    mkdirSync(abs, { recursive: true })
    writeFolderConfig(abs, { folderId: folder.id, folderName: folder.name, serverUrl: opts.serverUrl })
    dirByFolderId.set(folder.id, { abs, rel })
    opts.out(`folder ${folder.name} → ${rel}/`)
    for (const child of children.get(folder.id) ?? []) {
      queue.push({ folder: child, parentAbs: abs, parentRel: rel, depth: depth + 1 })
    }
  }

  // Docs: into their folder's dir; root-level docs (and docs whose folder is
  // not accessible) into the workspace root — except in a vault clone, where
  // the root holds the VAULT's direct docs and out-of-scope docs are skipped
  // (matching syncWorkspace's subtree scoping). Sequential — rate limits.
  let docCount = 0
  const usedFilesByDir = new Map<string, Set<string>>()
  const rootDocIds: string[] = []
  for (const doc of [...docs].sort((a, b) => a.title.localeCompare(b.title))) {
    let target: { abs: string; rel: string }
    if (opts.vault) {
      const mapped = doc.folderId === rootKey ? { abs: root, rel: '' } : dirByFolderId.get(doc.folderId ?? '')
      if (!mapped) continue // outside the vault's subtree
      target = mapped
    } else {
      target = (doc.folderId !== null ? dirByFolderId.get(doc.folderId) : undefined) ?? { abs: root, rel: '' }
      if (target.abs === root) rootDocIds.push(doc.id)
    }
    let used = usedFilesByDir.get(target.abs)
    if (!used) {
      used = usedFileSlugs(target.abs)
      usedFilesByDir.set(target.abs, used)
    }
    // The server's canonical filename verbatim — clone(sync(x)) == x for names.
    const file = fileForDoc(doc, used)
    try {
      const content = await opts.api.getContent(doc.id, 'working')
      writePull(
        {
          targetPath: join(target.abs, file),
          docId: doc.id,
          serverUrl: opts.serverUrl,
          text: content.text,
          ...(content.versionId !== null ? { versionId: content.versionId } : {}),
        },
        opts.cwd,
      )
      docCount++
      opts.out(`pulled ${doc.title} → ${target.rel === '' ? file : `${target.rel}/${file}`}`)
    } catch (error) {
      failures++
      opts.err(`failed ${doc.title}: ${errorMessage(error)}`)
    }
  }

  // Assets: per folder (folder namespace) and per root doc (own namespace).
  // A vault clone's root IS a folder namespace — the vault's.
  for (const [folderId, { abs, rel }] of dirByFolderId) {
    const results = await pullAssets({ dir: abs, ops: folderAssetOps(opts.api, folderId), err: opts.err })
    failures += reportAssetPulls(results, rel, opts)
  }
  if (opts.vault) {
    const results = await pullAssets({ dir: root, ops: folderAssetOps(opts.api, opts.vault.id), err: opts.err })
    failures += reportAssetPulls(results, '', opts)
  }
  for (const docId of rootDocIds) {
    const results = await pullAssets({ dir: root, ops: docAssetOps(opts.api, docId), err: opts.err })
    failures += reportAssetPulls(results, '', opts)
  }

  // A vault workspace is rooted by folder.json (the pull --folder layout) so
  // sync scopes to the subtree; a full mirror is marked by workspace.json.
  if (opts.vault) {
    writeFolderConfig(root, { folderId: opts.vault.id, folderName: opts.vault.name, serverUrl: opts.serverUrl })
  } else {
    writeWorkspaceConfig(root, { version: 1, serverUrl: opts.serverUrl, clonedAt: Date.now() })
  }
  return { dir: root, folders: dirByFolderId.size, docs: docCount, failures }
}

function reportAssetPulls(
  results: AssetSyncResult[],
  rel: string,
  opts: Pick<CloneOptions, 'out' | 'err'>,
): number {
  let failures = 0
  for (const r of results) {
    const path = rel === '' ? r.filename : `${rel}/${r.filename}`
    if (r.action === 'failed') {
      failures++
      opts.err(`asset ${path} failed${r.message ? ` — ${r.message}` : ''}`)
    } else if (r.action === 'pulled') {
      opts.out(`asset ${path} pulled`)
    }
  }
  return failures
}

// ---------------------------------------------------------------------------
// Recursive two-way mirror sync
// ---------------------------------------------------------------------------

export interface MirrorSyncOptions {
  /** Workspace root: a clone root, a folder workspace, or a plain doc dir. */
  dir: string
  apiFor: (serverUrl: string) => Api
  /** Pass --force through to pushes (overrides the degenerate-diff guard). */
  force?: boolean
  /** Warning sink. */
  err: (line: string) => void
}

export interface MirrorSyncOutcome {
  /** Doc + folder results; `file` paths are workspace-root-relative. */
  results: SyncDocResult[]
  /** Asset results; filenames are workspace-root-relative. */
  assetResults: AssetSyncResult[]
  /** One-shot informational notes (ignored files, etc.). */
  notes: string[]
}

interface DirNode {
  /** Workspace-root-relative path ('' for the root). */
  rel: string
  abs: string
  /** Rel of the parent dir; null for the root itself. */
  parentRel: string | null
  /** Linked server folder id; null = account root (mirror); undefined = unmapped. */
  folderId: string | null | undefined
  /** folderName recorded in folder.json, when linked. */
  folderName?: string
  /** Untracked-file/doc-discovery handling is skipped (creation failed / folder gone). */
  skipCreation?: boolean
}

/**
 * Workspace-shape detection + recursive two-way sync, over the workspace
 * root (`.glyphdown/`, or `.ink/` from the pre-rename CLI). Shapes:
 *  - workspace.json → full account mirror rooted here.
 *  - folder.json    → mirror of that folder's subtree (the pre-mirror
 *    `pull --folder` layout, recognized as-is — no migration).
 *  - bare <docId>/  → single-dir doc sync (no recursion, no creation).
 */
export async function syncWorkspace(opts: MirrorSyncOptions): Promise<MirrorSyncOutcome> {
  const wsConfig = readWorkspaceConfig(opts.dir)
  const rootFolderConfig = wsConfig ? null : readFolderConfig(opts.dir)

  if (!wsConfig && !rootFolderConfig) return syncPlainDir(opts)

  const serverUrl = wsConfig?.serverUrl ?? rootFolderConfig!.serverUrl
  const api = opts.apiFor(serverUrl)
  /** Account-root key: null for a mirror root, the linked folder id otherwise. */
  const rootKey: string | null = rootFolderConfig?.folderId ?? null

  let serverFolders: FolderMeta[]
  let serverDocs: DocMeta[]
  try {
    serverFolders = await api.listFolders()
    serverDocs = await api.listDocs()
  } catch (error) {
    return {
      results: [
        { docId: rootKey ?? '(workspace)', file: '(workspace)', action: 'failed', message: `listing the workspace failed: ${errorMessage(error)}` },
      ],
      assetResults: [],
      notes: [],
    }
  }
  const folderById = new Map(serverFolders.map((f) => [f.id, f]))
  const docById = new Map(serverDocs.map((d) => [d.id, d]))
  const syncOpts: SyncOptions = {
    dir: opts.dir,
    apiFor: opts.apiFor,
    ...(opts.force ? { force: true } : {}),
    err: opts.err,
    // Canonical filenames from this listDocs snapshot: tracked files whose
    // names drifted from the server converge (rename) inside syncTracked.
    filenameOf: (docId) => docById.get(docId)?.filename,
  }

  // In-scope server folders to materialize, parents before children:
  // everything accessible (mirror) or the linked folder's descendants
  // (subtree workspace).
  const children = folderChildren(serverFolders)
  const scopeBfs: FolderMeta[] = []
  {
    const queue = [...(children.get(wsConfig ? null : rootKey) ?? [])]
    const seen = new Set<string>()
    while (queue.length > 0) {
      const f = queue.shift()!
      if (seen.has(f.id)) continue
      seen.add(f.id)
      scopeBfs.push(f)
      queue.push(...(children.get(f.id) ?? []))
    }
  }

  const results: SyncDocResult[] = []
  const assetResults: AssetSyncResult[] = []
  const notes: string[] = []

  // ---- Phase A: walk the local tree --------------------------------------
  const rootNode: DirNode = { rel: '', abs: opts.dir, parentRel: null, folderId: rootKey }
  const dirs: DirNode[] = [rootNode]
  const nodeByRel = new Map<string, DirNode>([['', rootNode]])
  let ignored = 0
  const walk = (abs: string, rel: string): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory()) {
        const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
        const node: DirNode = { rel: childRel, abs: join(abs, entry.name), parentRel: rel, folderId: undefined }
        dirs.push(node)
        nodeByRel.set(childRel, node)
        walk(node.abs, childRel)
      } else if (entry.isFile() && !isMarkdownFile(entry.name) && !isSyncableAssetFile(entry.name)) {
        ignored++
      }
    }
  }
  walk(opts.dir, '')
  if (ignored > 0) notes.push(`ignored ${ignored} non-markdown, non-asset file(s) — only .md, images, and HTML sync`)

  // ---- Phase B: map linked dirs by folder id ------------------------------
  const dirByFolderKey = new Map<string | null, DirNode>([[rootKey, rootNode]])
  for (const node of dirs) {
    if (node.rel === '') continue
    const fc = readFolderConfig(node.abs)
    if (!fc) continue
    if (dirByFolderKey.has(fc.folderId)) {
      opts.err(`warning: ${node.rel}/ maps to folder ${fc.folderId} which is already mapped — skipping this directory`)
      node.skipCreation = true
      continue
    }
    node.folderId = fc.folderId
    node.folderName = fc.folderName
    dirByFolderKey.set(fc.folderId, node)
  }

  // ---- Phase C: new local directories → server folders --------------------
  const newLocalDirs = dirs
    .filter((n) => n.rel !== '' && n.folderId === undefined && n.skipCreation !== true)
    .sort((a, b) => a.rel.split('/').length - b.rel.split('/').length || a.rel.localeCompare(b.rel))
  for (const node of newLocalDirs) {
    if (!hasSyncableContent(node.abs)) continue // empty dirs are skipped
    const parent = nodeByRel.get(node.parentRel ?? '')
    if (!parent || parent.folderId === undefined) {
      node.skipCreation = true
      results.push({
        docId: node.rel,
        file: `${node.rel}/`,
        action: 'failed',
        message: 'parent directory has no server folder — fix the parent first',
      })
      continue
    }
    try {
      const created = await api.createFolder(basename(node.abs), parent.folderId ?? undefined)
      writeFolderConfig(node.abs, { folderId: created.id, folderName: created.name, serverUrl })
      node.folderId = created.id
      node.folderName = created.name
      dirByFolderKey.set(created.id, node)
      folderById.set(created.id, created)
      results.push({ docId: created.id, file: `${node.rel}/`, action: 'folder-created', message: folderUrl(serverUrl, created.id) })
    } catch (error) {
      node.skipCreation = true
      results.push({ docId: node.rel, file: `${node.rel}/`, action: 'failed', message: errorMessage(error) })
    }
  }

  // ---- Phase D: new server folders → local directories --------------------
  const usedNamesByDir = new Map<string, Set<string>>()
  for (const folder of scopeBfs) {
    if (dirByFolderKey.has(folder.id)) continue
    const parentKey = folder.parentId !== null && dirByFolderKey.has(folder.parentId) ? folder.parentId : rootKey
    const parent = dirByFolderKey.get(parentKey) ?? rootNode
    let used = usedNamesByDir.get(parent.abs)
    if (!used) {
      used = new Set(existsSync(parent.abs) ? readdirSync(parent.abs) : [])
      usedNamesByDir.set(parent.abs, used)
    }
    const name = allocateDirName(folder.name, used)
    const abs = join(parent.abs, name)
    const rel = parent.rel === '' ? name : `${parent.rel}/${name}`
    try {
      mkdirSync(abs, { recursive: true })
      writeFolderConfig(abs, { folderId: folder.id, folderName: folder.name, serverUrl })
    } catch (error) {
      results.push({ docId: folder.id, file: `${rel}/`, action: 'failed', message: errorMessage(error) })
      continue
    }
    const node: DirNode = { rel, abs, parentRel: parent.rel, folderId: folder.id, folderName: folder.name }
    dirs.push(node)
    nodeByRel.set(rel, node)
    dirByFolderKey.set(folder.id, node)
    results.push({ docId: folder.id, file: `${rel}/`, action: 'folder-new' })
  }

  // ---- Phase E: server renames + gone folders (no local dir changes, v1) --
  for (const node of dirs) {
    if (node.rel === '' || typeof node.folderId !== 'string') continue
    const server = folderById.get(node.folderId)
    if (!server) {
      opts.err(`warning: ${node.rel}/ — folder ${node.folderId} is gone on the server; local directory left alone`)
      node.skipCreation = true
      continue
    }
    if (node.folderName !== undefined && node.folderName !== server.name) {
      writeFolderConfig(node.abs, { folderId: server.id, folderName: server.name, serverUrl })
      node.folderName = server.name
      results.push({
        docId: server.id,
        file: `${node.rel}/`,
        action: 'folder-renamed',
        message: `now "${server.name}" on the server — local directory not renamed`,
      })
    }
  }

  // ---- Doc + asset pass, per directory ------------------------------------
  const trackedIds = new Set<string>()
  const metasByRel = new Map<string, DocWorkspaceMeta[]>()
  for (const node of dirs) {
    const metas = listMetas(node.abs).sort((a, b) => a.file.localeCompare(b.file))
    metasByRel.set(node.rel, metas)
    for (const m of metas) trackedIds.add(m.docId)
  }

  const docDirKey = (doc: DocMeta): string | null | undefined => {
    if (wsConfig) {
      // Mirror: root-level docs and docs in inaccessible folders → root.
      return doc.folderId !== null && dirByFolderKey.has(doc.folderId) ? doc.folderId : null
    }
    if (doc.folderId === rootKey) return rootKey
    return dirByFolderKey.has(doc.folderId ?? '') ? doc.folderId : undefined // undefined = out of scope
  }
  const docsByDirKey = new Map<string | null, DocMeta[]>()
  for (const doc of serverDocs) {
    const key = docDirKey(doc)
    if (key === undefined) continue
    const list = docsByDirKey.get(key) ?? []
    list.push(doc)
    docsByDirKey.set(key, list)
  }

  const orderedDirs = [...dirs].sort((a, b) => a.rel.localeCompare(b.rel))
  for (const node of orderedDirs) {
    const prefix = (file: string): string => (node.rel === '' ? file : `${node.rel}/${file}`)
    const metas = metasByRel.get(node.rel) ?? []
    const dirOpts: SyncOptions = { ...syncOpts, dir: node.abs }

    // 1. Tracked docs — the existing per-doc reconcile, sequential. Tracked
    //    names are collected POST-convergence (syncTracked may have renamed
    //    the file to the server's canonical name) so step 2 never mistakes a
    //    just-renamed file for a new doc.
    const trackedFiles = new Set(metas.map((m) => m.file))
    for (const meta of metas) {
      const result = await syncTracked(dirOpts, meta)
      trackedFiles.add(result.file)
      results.push({ ...result, file: prefix(result.file) })
    }

    // 2. Untracked local .md files → new server docs.
    const localMd = existsSync(node.abs)
      ? readdirSync(node.abs, { withFileTypes: true })
          .filter((e) => e.isFile() && !e.name.startsWith('.') && isMarkdownFile(e.name))
          .map((e) => e.name)
          .sort()
      : []
    // Skipped dirs (folder gone server-side, duplicate mapping, failed
    // creation) already warned/failed once — their files are left alone.
    const canCreate = node.folderId !== undefined && node.skipCreation !== true
    for (const file of localMd) {
      if (trackedFiles.has(file) || !canCreate) continue
      const result = await createDocFromFile(api, serverUrl, node, file, syncOpts)
      results.push({ ...result, file: prefix(result.file) })
      if (result.action === 'created') trackedIds.add(result.docId)
    }

    // 3. New server docs for this directory's folder → materialize under
    //    their canonical filenames.
    if (canCreate) {
      const used = usedFileSlugs(node.abs)
      for (const doc of docsByDirKey.get(node.folderId ?? null) ?? []) {
        if (trackedIds.has(doc.id)) continue
        const file = fileForDoc(doc, used)
        try {
          const content = await api.getContent(doc.id, 'working')
          writePull(
            {
              targetPath: join(node.abs, file),
              docId: doc.id,
              serverUrl,
              text: content.text,
              ...(content.versionId !== null ? { versionId: content.versionId } : {}),
            },
            node.abs,
          )
          trackedIds.add(doc.id)
          results.push({ docId: doc.id, file: prefix(file), action: 'new' })
        } catch (error) {
          results.push({ docId: doc.id, file: prefix(file), action: 'failed', message: errorMessage(error) })
        }
      }
    }

    // 4. Assets, two-way, scoped to this directory.
    const freshMetas = listMetas(node.abs).sort((a, b) => a.file.localeCompare(b.file))
    const firstDocId = freshMetas[0]?.docId ?? null
    let ops: AssetOps | null = null
    if (typeof node.folderId === 'string' && node.skipCreation !== true) {
      ops = folderAssetOps(api, node.folderId, serverUrl)
    } else if (node.rel === '' && node.folderId === null && firstDocId !== null) {
      // Mirror root: folderless docs carry their own namespace — ride the first.
      ops = docAssetOps(api, firstDocId)
    }
    if (ops) {
      const dirAssets = await syncAssets({ dir: node.abs, ops, mode: 'two-way', err: opts.err })
      assetResults.push(...dirAssets.map((r) => ({ ...r, filename: prefix(r.filename) })))
    }
  }

  warnLikelyLocalRename(results, opts.err)
  return { results, assetResults, notes }
}

/**
 * Local-rename detection (v1: rename is OUT of sync's scope — semantics stay
 * "missing tracked file re-pulls under the canonical name; the renamed copy
 * becomes a NEW doc"). But that pattern — a re-pull AND a create in the same
 * directory in one run — is almost always `mv` done by hand, so warn loudly
 * and point at the supported path: `glyphdown mv`.
 */
export function warnLikelyLocalRename(results: SyncDocResult[], err: (line: string) => void): void {
  const dirOf = (file: string): string => (file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '')
  const repulledDirs = new Set(results.filter((r) => r.action === 'repulled').map((r) => dirOf(r.file)))
  if (repulledDirs.size === 0) return
  const created = results.filter((r) => r.action === 'created' && repulledDirs.has(dirOf(r.file)))
  if (created.length === 0) return
  err(
    `warning: this sync re-pulled a missing tracked file AND created ${created.length === 1 ? `a new doc (${created[0]!.file})` : `${created.length} new docs`} in the same folder — if you renamed a file locally, that made a DUPLICATE doc. Undo with the web UI (delete the new doc), and rename with \`glyphdown mv <file> <new-name>\` next time (renames locally AND on the server).`,
  )
}

/** Single-dir legacy shape: tracked docs + the first doc's asset namespace. */
async function syncPlainDir(opts: MirrorSyncOptions): Promise<MirrorSyncOutcome> {
  const metas = listMetas(opts.dir).sort((a, b) => a.file.localeCompare(b.file))
  if (metas.length === 0) {
    throw new CliError(1, 'nothing to sync — run `glyphdown clone`, `glyphdown pull <doc>`, or `glyphdown pull --folder <folder>` first')
  }
  // Best-effort canonical-filename map for the convergence rename pass.
  let docById = new Map<string, DocMeta>()
  try {
    docById = new Map((await opts.apiFor(metas[0]!.serverUrl).listDocs()).map((d) => [d.id, d]))
  } catch {
    // listing failed — per-doc syncs still run and report their own failures
  }
  const syncOpts: SyncOptions = {
    dir: opts.dir,
    apiFor: opts.apiFor,
    ...(opts.force ? { force: true } : {}),
    err: opts.err,
    filenameOf: (docId) => docById.get(docId)?.filename,
  }
  const results: SyncDocResult[] = []
  for (const meta of metas) results.push(await syncTracked(syncOpts, meta))
  const first = metas[0]!
  const assetResults = await syncAssets({
    dir: opts.dir,
    ops: docAssetOps(opts.apiFor(first.serverUrl), first.docId),
    mode: 'two-way',
    err: opts.err,
  })
  return { results, assetResults, notes: [] }
}

/** True when the dir (recursively) contains anything that syncs (.md/assets). */
function hasSyncableContent(abs: string): boolean {
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    if (entry.isFile() && (isMarkdownFile(entry.name) || isSyncableAssetFile(entry.name))) return true
    if (entry.isDirectory() && hasSyncableContent(join(abs, entry.name))) return true
  }
  return false
}

/** Web URL for a doc — same shape as `glyphdown new` prints. */
function docUrl(serverUrl: string, docId: string): string {
  return `${serverUrl.replace(/\/+$/, '')}/d/${docId}`
}

/** Web URL for a folder (the /f/:folderId share-link landing page). */
function folderUrl(serverUrl: string, folderId: string): string {
  return `${serverUrl.replace(/\/+$/, '')}/f/${folderId}`
}

/**
 * Create a server doc from an untracked local .md. The FILE NAME is the
 * doc name (slugified when it isn't already a clean slug — reported, e.g.
 * `My Notes.md → my-notes.md`); the H1 heading is just content. The server
 * may suffix the name on a scope collision — the local file then renames to
 * the canonical name so both sides match. Content is pushed up and tracked.
 */
async function createDocFromFile(
  api: Api,
  serverUrl: string,
  node: DirNode,
  file: string,
  opts: Pick<SyncOptions, 'err'>,
): Promise<SyncDocResult> {
  let text: string
  try {
    text = normalizeEol(readFileSync(join(node.abs, file), 'utf8'))
  } catch (error) {
    return { docId: file, file, action: 'failed', message: errorMessage(error) }
  }
  const requested = filenameForLocalFile(file)
  if (requested !== file) {
    opts.err(`note: ${file} → ${requested} (doc names are slugs; the local file is renamed to match)`)
  }

  let meta: DocMeta
  try {
    meta = await api.createDoc({
      filename: requested,
      ...(typeof node.folderId === 'string' ? { folderId: node.folderId } : {}),
    })
  } catch (error) {
    return { docId: file, file, action: 'failed', message: `creating "${requested}" failed: ${errorMessage(error)}` }
  }

  // Converge the local file on the canonical server name (slug normalization
  // and/or a collision suffix). If the rename cannot happen the doc still
  // tracks under the old name and the next sync's convergence pass retries.
  const canonical = typeof meta.filename === 'string' && meta.filename !== '' ? meta.filename : requested
  let trackedFile = file
  if (canonical !== file) {
    try {
      if (existsSync(join(node.abs, canonical))) {
        opts.err(`warning: ${file} — created as ${canonical} on the server, but a local file with that name exists; not renamed`)
      } else {
        renameSync(join(node.abs, file), join(node.abs, canonical))
        trackedFile = canonical
      }
    } catch (error) {
      opts.err(`warning: ${file} — rename to ${canonical} failed: ${errorMessage(error)}`)
    }
  }
  const renamedNote = trackedFile !== file ? ` (${file} → ${trackedFile})` : ''
  const url = docUrl(serverUrl, meta.id)
  const id = { docId: meta.id, file: trackedFile }

  try {
    const content = await api.getContent(meta.id, 'working')
    const baseHash = content.baseHash ?? sha256Hex(content.text)
    if (sha256Hex(text) === baseHash) {
      // Local content matches the fresh doc (e.g. both empty) — just track it.
      recordBase({
        dir: node.abs,
        file: trackedFile,
        docId: meta.id,
        serverUrl,
        text,
        ...(content.versionId !== null ? { versionId: content.versionId } : {}),
      })
      return { ...id, action: 'created', message: `${canonical}${renamedNote} — ${url}` }
    }
    const { response } = await pushWithBase(api, {
      docId: meta.id,
      newText: text,
      baseHash,
      baseText: content.text,
    })
    if (!response.ok) {
      // Track against the server text so the next sync retries the push.
      recordBase({ dir: node.abs, file: trackedFile, docId: meta.id, serverUrl, text: content.text })
      return { ...id, action: 'failed', message: `created ${canonical} (${url}) but the initial push was rejected: ${pushRejection(response).message}` }
    }
    if (response.mode === 'suggest') {
      recordBase({ dir: node.abs, file: trackedFile, docId: meta.id, serverUrl, text: content.text })
      return { ...id, action: 'created', message: `${canonical} — content landed as suggestion ${response.suggestionId} — ${url}` }
    }
    if (response.failedHunks.length > 0) {
      recordBase({ dir: node.abs, file: trackedFile, docId: meta.id, serverUrl, text: content.text })
      opts.err(`warning: ${trackedFile} — ${response.failedHunks.length} hunk(s) failed on the initial push`)
      return { ...id, action: 'failed', failedHunks: response.failedHunks.length, message: `created ${canonical} (${url}) but ${response.failedHunks.length} hunk(s) failed — run glyphdown sync again` }
    }
    recordBase({ dir: node.abs, file: trackedFile, docId: meta.id, serverUrl, text, versionId: response.versionId })
    return { ...id, action: 'created', message: `${canonical}${renamedNote} — ${url}` }
  } catch (error) {
    return { ...id, action: 'failed', message: `created ${canonical} (${url}) but pushing its content failed: ${errorMessage(error)}` }
  }
}
