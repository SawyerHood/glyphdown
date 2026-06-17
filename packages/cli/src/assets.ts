import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  MAX_ASSET_BYTES,
  SYNCABLE_ASSET_FILE_EXTENSIONS,
  assetKindForContentType,
  normalizeAssetFilename,
  type AssetMeta,
} from '@glyphdown/protocol'
import type { Api, AssetDownload } from './api.ts'
import { workspaceRoot } from './workspace.ts'

/**
 * Folder/doc asset sync for the CLI (images referenced by markdown-relative
 * paths and standalone HTML files). Bytes are binary end to end — read/written
 * with Buffers, fetched via ArrayBuffer, NEVER EOL-normalized.
 *
 * State lives in `.glyphdown/assets.json` — or a legacy `.ink/` workspace
 * root — ({filename: {etag, size, mtimeMs}}):
 *  - etag: the server-side R2 etag of the version we last synced
 *  - size/mtimeMs: the local file fingerprint at that moment (cheap local
 *    change detection without hashing every run)
 */

// ---------------------------------------------------------------------------
// State file
// ---------------------------------------------------------------------------

export interface AssetState {
  etag: string
  size: number
  mtimeMs: number
}

export type AssetStateFile = Record<string, AssetState>

export function assetStatePath(dir: string): string {
  return join(workspaceRoot(dir), 'assets.json')
}

export function readAssetState(dir: string): AssetStateFile {
  const path = assetStatePath(dir)
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as AssetStateFile
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {} // unreadable — resynced from scratch (worst case: re-downloads)
  }
}

export function writeAssetState(dir: string, state: AssetStateFile): void {
  mkdirSync(workspaceRoot(dir), { recursive: true })
  writeFileSync(assetStatePath(dir), `${JSON.stringify(state, null, 2)}\n`)
}

// ---------------------------------------------------------------------------
// Local scan
// ---------------------------------------------------------------------------

const SYNCABLE_ASSET_EXTENSION_SET = new Set<string>(SYNCABLE_ASSET_FILE_EXTENSIONS)

const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  html: 'text/html',
  htm: 'text/html',
}

export function assetContentType(filename: string): string {
  const ext = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase()
  return CONTENT_TYPE_BY_EXTENSION[ext] ?? 'image/png'
}

export const imageContentType = assetContentType

export interface LocalAsset {
  /** Actual on-disk path (the name may differ from the normalized key). */
  path: string
  size: number
  mtimeMs: number
}

/**
 * Syncable asset files (by extension, ≤ 10 MB) in the top level of the
 * workspace dir, keyed by their server-normalized filename. Dotfiles (including the
 * bookkeeping dir) are skipped.
 */
export function scanLocalAssets(dir: string, warn: (line: string) => void = () => {}): Map<string, LocalAsset> {
  const out = new Map<string, LocalAsset>()
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name.startsWith('.')) continue
    const ext = entry.name.slice(entry.name.lastIndexOf('.') + 1).toLowerCase()
    if (!SYNCABLE_ASSET_EXTENSION_SET.has(ext)) continue
    const key = normalizeAssetFilename(entry.name)
    if (key === null) continue
    const path = join(dir, entry.name)
    const stat = statSync(path)
    if (stat.size > MAX_ASSET_BYTES) {
      warn(`warning: ${entry.name} exceeds 10 MB — not synced`)
      continue
    }
    const existing = out.get(key)
    if (existing) {
      warn(`warning: ${entry.name} and ${existing.path} normalize to the same asset name "${key}" — keeping the first`)
      continue
    }
    out.set(key, { path, size: stat.size, mtimeMs: stat.mtimeMs })
  }
  return out
}

export function md5Hex(data: Uint8Array): string {
  return createHash('md5').update(data).digest('hex')
}

// ---------------------------------------------------------------------------
// Pure sync decision (unit-tested matrix)
// ---------------------------------------------------------------------------

export type AssetDecision =
  | { action: 'upload'; overwrite: boolean }
  | { action: 'download' }
  /** Both sides changed: local wins with a warning — assets don't merge. */
  | { action: 'conflict-local-kept' }
  | { action: 'up-to-date' }
  /** Stale state entry — the asset is gone on both sides. */
  | { action: 'forget' }

export function decideAssetSync(input: {
  local: { size: number; mtimeMs: number } | null
  remote: { etag: string } | null
  recorded: AssetState | null
  /** md5(local bytes) === remote etag — computed lazily for ambiguous cases. */
  bytesIdentical?: boolean
}): AssetDecision {
  const { local, remote, recorded, bytesIdentical } = input

  if (local && !remote) {
    // New local file — or the remote was deleted out from under a recorded
    // one; either way the local copy is the only copy, so it goes up.
    return { action: 'upload', overwrite: false }
  }
  if (!local && remote) {
    // New remote asset — or the local file was deleted; the contract has no
    // delete propagation, so the server copy comes (back) down.
    return { action: 'download' }
  }
  if (!local || !remote) return { action: 'forget' }

  if (recorded === null) {
    // Both exist but were never synced. Identical bytes just start tracking;
    // different bytes are a conflict (local wins, assets don't merge).
    return bytesIdentical ? { action: 'up-to-date' } : { action: 'conflict-local-kept' }
  }

  const localChanged = local.size !== recorded.size || local.mtimeMs !== recorded.mtimeMs
  const remoteChanged = remote.etag !== recorded.etag
  if (localChanged && remoteChanged) {
    return bytesIdentical ? { action: 'up-to-date' } : { action: 'conflict-local-kept' }
  }
  if (localChanged) return { action: 'upload', overwrite: true }
  if (remoteChanged) return { action: 'download' }
  return { action: 'up-to-date' }
}

// ---------------------------------------------------------------------------
// Scope ops (folder routes for folder dirs; doc routes resolve the scope
// server-side for everything else)
// ---------------------------------------------------------------------------

export interface AssetOps {
  list(): Promise<AssetMeta[]>
  download(filename: string): Promise<AssetDownload>
  upload:
    | ((filename: string, data: Uint8Array, contentType: string, overwrite: boolean) => Promise<AssetMeta>)
    | null
  viewerUrl?: (filename: string) => string
}

export function docAssetOps(api: Api, docId: string): AssetOps {
  return {
    list: () => api.listDocAssets(docId),
    download: (filename) => api.downloadDocAsset(docId, filename),
    upload: async (filename, data, contentType, overwrite) =>
      (await api.uploadDocAsset(docId, filename, data, contentType, overwrite)).asset,
  }
}

export function folderAssetOps(
  api: Api,
  folderId: string,
  serverUrl?: string,
  legacyUploadDocId?: string | null,
): AssetOps {
  return {
    list: () => api.listFolderAssets(folderId),
    download: (filename) => api.downloadFolderAsset(folderId, filename),
    upload: async (filename, data, contentType, overwrite) => {
      try {
        return (await api.uploadFolderAsset(folderId, filename, data, contentType, overwrite)).asset
      } catch (error) {
        if (!isLegacyFolderUploadMiss(error)) throw error
        if (assetKindForContentType(contentType) !== 'image') {
          throw new Error('server does not support folder HTML asset uploads — upgrade the server to sync .html/.htm files')
        }
        if (legacyUploadDocId === undefined || legacyUploadDocId === null) {
          throw new Error('no doc in this folder to upload through — pull a doc first')
        }
        return (await api.uploadDocAsset(legacyUploadDocId, filename, data, contentType, overwrite)).asset
      }
    },
    ...(serverUrl !== undefined ? { viewerUrl: (filename) => assetViewerUrl(serverUrl, folderId, filename) } : {}),
  }
}

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------

export type AssetSyncAction = 'pushed' | 'pulled' | 'conflict-local-kept' | 'up-to-date' | 'failed'

export interface AssetSyncResult {
  filename: string
  action: AssetSyncAction
  message?: string
}

export interface PullAssetsOptions {
  dir: string
  ops: Pick<AssetOps, 'list' | 'download'>
  err: (line: string) => void
}

/**
 * Pull-direction only (glyphdown pull / glyphdown pull --folder): download every remote
 * asset, skipping files whose recorded etag matches the server AND whose
 * local size still matches the record. Local-only files are left alone.
 */
export async function pullAssets(opts: PullAssetsOptions): Promise<AssetSyncResult[]> {
  let remote: AssetMeta[]
  try {
    remote = await opts.ops.list()
  } catch (error) {
    return [{ filename: '(assets)', action: 'failed', message: errorMessage(error) }]
  }
  if (remote.length === 0) return []

  const state = readAssetState(opts.dir)
  const local = scanLocalAssets(opts.dir, opts.err)
  const results: AssetSyncResult[] = []

  for (const asset of [...remote].sort((a, b) => a.filename.localeCompare(b.filename))) {
    const recorded = state[asset.filename] ?? null
    const localFile = local.get(asset.filename) ?? null
    if (recorded && recorded.etag === asset.etag && localFile && localFile.size === recorded.size) {
      results.push({ filename: asset.filename, action: 'up-to-date' })
      continue
    }
    try {
      const downloaded = await opts.ops.download(asset.filename)
      const path = localFile?.path ?? join(opts.dir, asset.filename)
      writeFileSync(path, downloaded.data)
      const stat = statSync(path)
      state[asset.filename] = { etag: asset.etag, size: stat.size, mtimeMs: stat.mtimeMs }
      results.push({ filename: asset.filename, action: 'pulled' })
    } catch (error) {
      results.push({ filename: asset.filename, action: 'failed', message: errorMessage(error) })
    }
  }

  writeAssetState(opts.dir, state)
  return results
}

export interface SyncAssetsOptions {
  dir: string
  ops: AssetOps
  /** 'push' = upload-only (glyphdown push --all); 'two-way' = glyphdown sync. */
  mode: 'push' | 'two-way'
  err: (line: string) => void
}

/**
 * Reconcile the workspace dir's syncable files with the scope's assets:
 * new-local/changed-local push (overwrite for changed), new-remote/
 * changed-remote pull (two-way mode only), both-changed keeps local with a
 * warning. Bookkeeping in the workspace root's assets.json.
 */
export async function syncAssets(opts: SyncAssetsOptions): Promise<AssetSyncResult[]> {
  let remote: AssetMeta[]
  try {
    remote = await opts.ops.list()
  } catch (error) {
    return [{ filename: '(assets)', action: 'failed', message: errorMessage(error) }]
  }
  const remoteByName = new Map(remote.map((a) => [a.filename, a]))

  const state = readAssetState(opts.dir)
  const local = scanLocalAssets(opts.dir, opts.err)
  if (local.size === 0 && remote.length === 0) return []

  const names = [...new Set([...local.keys(), ...remoteByName.keys(), ...Object.keys(state)])].sort()
  const results: AssetSyncResult[] = []

  for (const name of names) {
    const localFile = local.get(name) ?? null
    const remoteAsset = remoteByName.get(name) ?? null
    const recorded = state[name] ?? null

    // Lazily settle ambiguous cases by content: R2 single-part etags are the
    // md5 of the body, so identical bytes are recognizable without a record.
    let bytesIdentical: boolean | undefined
    if (localFile && remoteAsset && localFile.size === remoteAsset.size) {
      const ambiguous =
        recorded === null ||
        ((localFile.size !== recorded.size || localFile.mtimeMs !== recorded.mtimeMs) &&
          remoteAsset.etag !== recorded.etag)
      if (ambiguous) {
        try {
          bytesIdentical = md5Hex(new Uint8Array(readFileSync(localFile.path))) === remoteAsset.etag
        } catch {
          bytesIdentical = false
        }
      }
    }

    const decision = decideAssetSync({
      local: localFile,
      remote: remoteAsset,
      recorded,
      ...(bytesIdentical !== undefined ? { bytesIdentical } : {}),
    })

    try {
      results.push(await applyDecision(opts, state, name, decision, localFile, remoteAsset))
    } catch (error) {
      results.push({ filename: name, action: 'failed', message: errorMessage(error) })
    }
  }

  writeAssetState(opts.dir, state)
  return results.filter((r) => r.action !== 'up-to-date' || opts.mode === 'two-way')
}

async function applyDecision(
  opts: SyncAssetsOptions,
  state: AssetStateFile,
  name: string,
  decision: AssetDecision,
  localFile: LocalAsset | null,
  remoteAsset: AssetMeta | null,
): Promise<AssetSyncResult> {
  switch (decision.action) {
    case 'forget': {
      delete state[name]
      return { filename: name, action: 'up-to-date' }
    }

    case 'up-to-date': {
      // Refresh the record (covers the identical-bytes convergence case).
      if (localFile && remoteAsset) {
        state[name] = { etag: remoteAsset.etag, size: localFile.size, mtimeMs: localFile.mtimeMs }
      }
      return { filename: name, action: 'up-to-date' }
    }

    case 'upload':
    case 'conflict-local-kept': {
      const overwrite = decision.action === 'conflict-local-kept' || decision.overwrite
      if (decision.action === 'conflict-local-kept') {
        opts.err(`warning: asset ${name} changed both locally and on the server — keeping local (assets don't merge)`)
      }
      if (!localFile) return { filename: name, action: 'failed', message: 'local file vanished mid-sync' }
      if (opts.ops.upload === null) {
        return { filename: name, action: 'failed', message: 'asset uploads are unavailable for this scope' }
      }
      const data = new Uint8Array(readFileSync(localFile.path))
      const uploaded = await opts.ops.upload(basename(localFile.path), data, assetContentType(name), overwrite)
      // Record under the server's name (normally === name; collisions rename).
      state[uploaded.filename] = { etag: uploaded.etag, size: localFile.size, mtimeMs: localFile.mtimeMs }
      const messageParts = [
        uploaded.filename !== name ? `stored as ${uploaded.filename}` : '',
        assetKindForContentType(uploaded.contentType) === 'html' ? opts.ops.viewerUrl?.(uploaded.filename) ?? '' : '',
      ].filter(Boolean)
      return {
        filename: name,
        action: decision.action === 'conflict-local-kept' ? 'conflict-local-kept' : 'pushed',
        ...(messageParts.length > 0 ? { message: messageParts.join(' — ') } : {}),
      }
    }

    case 'download': {
      if (opts.mode === 'push') {
        // push --all never downloads; leave the record alone so `glyphdown sync`
        // still sees the remote change later.
        return { filename: name, action: 'up-to-date' }
      }
      if (!remoteAsset) return { filename: name, action: 'failed', message: 'remote asset vanished mid-sync' }
      const downloaded = await opts.ops.download(name)
      const path = localFile?.path ?? join(opts.dir, name)
      writeFileSync(path, downloaded.data)
      const stat = statSync(path)
      state[name] = { etag: remoteAsset.etag, size: stat.size, mtimeMs: stat.mtimeMs }
      return { filename: name, action: 'pulled' }
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The web viewer URL for a folder-scoped asset: `/f/<folderId>/file/<name>`. */
export function assetViewerUrl(serverUrl: string, folderId: string, filename: string): string {
  return `${serverUrl.replace(/\/+$/, '')}/f/${folderId}/file/${encodeURIComponent(filename)}`
}

function isLegacyFolderUploadMiss(error: unknown): boolean {
  const status = typeof error === 'object' && error !== null ? (error as { status?: unknown }).status : undefined
  return status === 404 || status === 405
}
