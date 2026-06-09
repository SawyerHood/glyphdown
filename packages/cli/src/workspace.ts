import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { normalizeEol } from '@glyphdown/core'
import { slugifyDocStem } from '@glyphdown/protocol'
import { CliError } from './errors.ts'

/**
 * Pull/push base bookkeeping (SPEC §8.3 steps 1–2): `glyphdown pull` writes
 * the markdown file plus `.glyphdown/<docId>/{meta.json,base.md}` next to it.
 * The base hash is always computed over EOL-normalized text — it must match
 * what the server hashes.
 */
export interface DocWorkspaceMeta {
  docId: string
  serverUrl: string
  /** sha-256 hex of the normalized base text (base.md). */
  baseHash: string
  pulledAt: number
  /** Markdown filename relative to the directory containing .glyphdown/. */
  file: string
  /** Server version id from the last pull/push, when known. */
  versionId?: string
}

export interface Workspace {
  /** Absolute path of the markdown file. */
  path: string
  /** Directory containing the file and its .glyphdown/ folder. */
  dir: string
  meta: DocWorkspaceMeta
  /** Normalized contents of .glyphdown/<docId>/base.md. */
  baseText: string
}

/** Bookkeeping dir name used for NEW clones/pulls. */
export const WORKSPACE_DIR = '.glyphdown'
/**
 * Pre-rename (`ink` CLI) bookkeeping dir name. Existing `.ink/` workspaces
 * stay valid as-is — detected and written back to, never force-migrated.
 */
export const WORKSPACE_DIR_LEGACY = '.ink'

/**
 * The bookkeeping root for `dir`: an existing `.glyphdown/` wins, otherwise
 * an existing legacy `.ink/` keeps being used; when neither exists yet, new
 * bookkeeping is created under `.glyphdown/`.
 */
export function workspaceRoot(dir: string): string {
  const next = join(dir, WORKSPACE_DIR)
  if (existsSync(next)) return next
  const legacy = join(dir, WORKSPACE_DIR_LEGACY)
  return existsSync(legacy) ? legacy : next
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Slugify a name into a doc filename stem — the protocol's canonical rule
 * (server, web, and CLI must agree character-for-character so a filename
 * round-trips unchanged through `sync` → server → `clone`).
 */
export function slugify(title: string): string {
  return slugifyDocStem(title)
}

/** Per-doc bookkeeping dir: <workspaceRoot>/<docId>. */
export function docStateDir(dir: string, docId: string): string {
  return join(workspaceRoot(dir), docId)
}

export interface RecordBaseOptions {
  dir: string
  file: string
  docId: string
  serverUrl: string
  /** Must already be EOL-normalized (normalizeEol). */
  text: string
  versionId?: string
}

/**
 * Rewrite ONLY <workspaceRoot>/<docId>/meta.json (base.md untouched) — used
 * when a doc's tracked file is renamed (`glyphdown mv`, sync's one-time
 * convergence to the server's canonical filename) without its base moving.
 */
export function rewriteMeta(dir: string, meta: DocWorkspaceMeta): void {
  const stateDir = docStateDir(dir, meta.docId)
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`)
}

/** Write/refresh <workspaceRoot>/<docId>/{base.md,meta.json}. Returns the stored meta. */
export function recordBase(opts: RecordBaseOptions): DocWorkspaceMeta {
  const stateDir = docStateDir(opts.dir, opts.docId)
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, 'base.md'), opts.text)
  const meta: DocWorkspaceMeta = {
    docId: opts.docId,
    serverUrl: opts.serverUrl,
    baseHash: sha256Hex(opts.text),
    pulledAt: Date.now(),
    file: opts.file,
    ...(opts.versionId !== undefined ? { versionId: opts.versionId } : {}),
  }
  writeFileSync(join(stateDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`)
  return meta
}

export interface WritePullOptions {
  /** Path of the markdown file to write (absolute or cwd-relative). */
  targetPath: string
  docId: string
  serverUrl: string
  /** Must already be EOL-normalized. */
  text: string
  versionId?: string
}

/** SPEC §8.3 step 1: write the document file plus its base bookkeeping. */
export function writePull(opts: WritePullOptions, cwd: string = process.cwd()): Workspace {
  const path = resolve(cwd, opts.targetPath)
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path, opts.text)
  const meta = recordBase({
    dir,
    file: basename(path),
    docId: opts.docId,
    serverUrl: opts.serverUrl,
    text: opts.text,
    ...(opts.versionId !== undefined ? { versionId: opts.versionId } : {}),
  })
  return { path, dir, meta, baseText: opts.text }
}

/**
 * Every tracked doc under the workspace root (one meta.json per pulled doc;
 * `.glyphdown/` or a legacy `.ink/`). Entries without a usable `file`
 * mapping are skipped — they cannot be pushed.
 */
export function listMetas(dir: string): DocWorkspaceMeta[] {
  const root = workspaceRoot(dir)
  if (!existsSync(root)) return []
  const metas: DocWorkspaceMeta[] = []
  for (const entry of readdirSync(root)) {
    const metaPath = join(root, entry, 'meta.json')
    if (!existsSync(metaPath)) continue
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as DocWorkspaceMeta
      if (typeof meta.file === 'string' && meta.file !== '') metas.push(meta)
    } catch {
      // unreadable meta — skip; push will report if nothing matches
    }
  }
  return metas
}

/** Load a tracked doc's workspace (file path + normalized base text). */
export function loadWorkspace(dir: string, meta: DocWorkspaceMeta): Workspace {
  const basePath = join(docStateDir(dir, meta.docId), 'base.md')
  if (!existsSync(basePath)) {
    throw new CliError(1, `missing ${basePath} — re-run \`glyphdown pull ${meta.docId}\``)
  }
  return {
    path: join(dir, meta.file),
    dir,
    meta,
    baseText: normalizeEol(readFileSync(basePath, 'utf8')),
  }
}

/**
 * Locate the pulled-doc metadata for a push. With an explicit path, the
 * matching meta lives in `.glyphdown/` (or a legacy `.ink/`) next to the
 * file; with no path, the cwd must contain exactly one pulled doc.
 */
export function findWorkspace(pathArg: string | undefined, cwd: string = process.cwd()): Workspace {
  if (pathArg !== undefined) {
    const path = resolve(cwd, pathArg)
    const dir = dirname(path)
    const file = basename(path)
    const meta = listMetas(dir).find((m) => m.file === file)
    if (!meta) {
      throw new CliError(1, `no .glyphdown metadata for ${file} in ${dir} — run \`glyphdown pull <doc> ${pathArg}\` first`)
    }
    return loadWorkspace(dir, meta)
  }
  const metas = listMetas(cwd)
  if (metas.length === 0) {
    throw new CliError(1, 'no .glyphdown metadata in this directory — run `glyphdown pull <doc>` first')
  }
  if (metas.length > 1) {
    const files = metas.map((m) => m.file).join(', ')
    throw new CliError(1, `multiple pulled docs here (${files}) — pass the file path: glyphdown push <path>`)
  }
  return loadWorkspace(cwd, metas[0]!)
}
