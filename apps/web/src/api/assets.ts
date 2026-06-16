import { and, eq, inArray, isNull, or } from 'drizzle-orm'
import {
  MAX_ASSET_BYTES,
  assetKindForContentType,
  normalizeAssetFilename,
  roleAtLeast,
  type AssetMeta,
  type UploadAssetResponse,
} from '@glyphdown/protocol'
import { assets, docs } from '../db/schema.ts'
import type { Db } from '../db/client.ts'
import type { AuthContext } from './auth.ts'
import type { DocRow } from './roles.ts'

/**
 * Doc/folder file assets: bytes in R2 (ASSETS binding), metadata in D1
 * (`assets` table). A doc's asset namespace is its containing folder when it
 * has one — so every doc in a folder shares one asset namespace and markdown
 * references stay valid across the folder — else the doc
 * itself. Pure helpers (normalizeAssetFilename, uniqueAssetFilename,
 * assetScopeFor) are unit-tested in assets.test.ts.
 *
 * LEGACY DOC-SCOPED ROWS (vaults plan §1): pre-vault root docs got doc-scoped
 * asset rows; the backfill re-homed those docs into a vault WITHOUT moving
 * their asset rows (two root docs may each own `image.png` — merging the
 * namespaces would collide and force CRDT content rewrites). Folder-scope
 * reads therefore FALL BACK to doc scope: a folder-scope hit always wins, the
 * fallback searches the doc-scoped rows of the doc(s) homed in the folder,
 * and new uploads always use the current (folder) scope. Stored r2_key values
 * are immutable, so the bytes never move.
 */

// Shared with the CLI via @glyphdown/protocol (single normalization source).
export { MAX_ASSET_BYTES, normalizeAssetFilename }

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export interface AssetScope {
  kind: 'folder' | 'doc'
  id: string
}

/** The namespace a doc's assets live in: its folder if any, else the doc. */
export function assetScopeFor(doc: Pick<DocRow, 'id' | 'folderId'>): AssetScope {
  return doc.folderId !== null ? { kind: 'folder', id: doc.folderId } : { kind: 'doc', id: doc.id }
}

/** Resolve a name collision by suffixing -2, -3, … before the extension. */
export function uniqueAssetFilename(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let i = 2; ; i++) {
    const candidate = `${stem}-${i}${ext}`
    if (!taken.has(candidate)) return candidate
  }
}

export function assetR2Key(scope: AssetScope, filename: string): string {
  return `${scope.kind}/${scope.id}/${filename}`
}

// ---------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------

type AssetRow = typeof assets.$inferSelect

function scopeFilter(scope: AssetScope) {
  return scope.kind === 'folder'
    ? and(eq(assets.folderId, scope.id), isNull(assets.docId))
    : and(eq(assets.docId, scope.id), isNull(assets.folderId))
}

export async function listAssetRows(db: Db, scope: AssetScope): Promise<AssetRow[]> {
  return db.select().from(assets).where(scopeFilter(scope))
}

async function findAssetRow(db: Db, scope: AssetScope, filename: string): Promise<AssetRow | undefined> {
  return (
    await db
      .select()
      .from(assets)
      .where(and(scopeFilter(scope), eq(assets.filename, filename)))
      .limit(1)
  )[0]
}

/** Deterministic pick among legacy rows sharing a filename: oldest first. */
function byAge(a: AssetRow, b: AssetRow): number {
  return a.createdAt - b.createdAt || a.id.localeCompare(b.id)
}

/**
 * Doc ids whose legacy doc-scoped asset rows resolve through a folder scope:
 * the live docs homed directly in the folder (a doc's namespace is its
 * DIRECT folder — subfolder docs have their own).
 */
async function fallbackDocIdsFor(db: Db, folderId: string): Promise<string[]> {
  const rows = await db
    .select({ id: docs.id })
    .from(docs)
    .where(and(eq(docs.folderId, folderId), isNull(docs.deletedAt)))
  return rows.map((r) => r.id)
}

async function fallbackRows(db: Db, docIds: string[], filename?: string): Promise<AssetRow[]> {
  if (docIds.length === 0) return []
  const base = and(inArray(assets.docId, docIds), isNull(assets.folderId))
  const where = filename !== undefined ? and(base, eq(assets.filename, filename)) : base
  return (await db.select().from(assets).where(where)).sort(byAge)
}

/**
 * Resolve an asset by filename for read/delete: the scope's own row wins; on
 * a folder-scope miss, fall back to the legacy doc-scoped rows of the given
 * docs (oldest row wins when two legacy namespaces share a filename — same
 * order the merged listing uses).
 */
async function resolveAssetRow(
  db: Db,
  scope: AssetScope,
  filename: string,
  fallbackDocIds: string[],
): Promise<AssetRow | undefined> {
  const hit = await findAssetRow(db, scope, filename)
  if (hit || scope.kind !== 'folder') return hit
  return (await fallbackRows(db, fallbackDocIds, filename))[0]
}

/** Scope listing merged with the legacy doc-scoped fallback (scope wins per filename). */
async function listAssetRowsMerged(db: Db, scope: AssetScope, fallbackDocIds: string[]): Promise<AssetRow[]> {
  const own = await listAssetRows(db, scope)
  if (scope.kind !== 'folder' || fallbackDocIds.length === 0) return own
  const byName = new Map<string, AssetRow>()
  for (const row of await fallbackRows(db, fallbackDocIds)) {
    if (!byName.has(row.filename)) byName.set(row.filename, row)
  }
  for (const row of own) byName.set(row.filename, row)
  return [...byName.values()]
}

function assetMeta(row: AssetRow): AssetMeta {
  return {
    id: row.id,
    filename: row.filename,
    contentType: row.contentType,
    size: row.size,
    etag: row.etag,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  }
}

export async function listFolderAssetMetaMap(
  db: Db,
  folderIds: readonly string[],
  docRows: ReadonlyArray<{ id: string; folderId: string | null }>,
): Promise<Map<string, AssetMeta[]>> {
  const result = new Map<string, AssetMeta[]>()
  const folderIdSet = new Set(folderIds)
  for (const folderId of folderIds) result.set(folderId, [])
  if (folderIds.length === 0) return result

  const docFolder = new Map<string, string>()
  for (const doc of docRows) {
    if (doc.folderId !== null && folderIdSet.has(doc.folderId)) docFolder.set(doc.id, doc.folderId)
  }

  const ownCondition = and(inArray(assets.folderId, [...folderIds]), isNull(assets.docId))
  const where =
    docFolder.size === 0
      ? ownCondition
      : or(ownCondition, and(inArray(assets.docId, [...docFolder.keys()]), isNull(assets.folderId)))
  const rows = await db.select().from(assets).where(where)

  const byFolder = new Map<string, Map<string, AssetRow>>()
  for (const folderId of folderIds) byFolder.set(folderId, new Map())
  for (const row of rows.filter((r) => r.docId !== null).sort(byAge)) {
    const folderId = docFolder.get(row.docId!)
    if (folderId) {
      const byName = byFolder.get(folderId)!
      if (!byName.has(row.filename)) byName.set(row.filename, row)
    }
  }
  for (const row of rows) {
    if (row.folderId !== null) byFolder.get(row.folderId)?.set(row.filename, row)
  }
  for (const [folderId, byName] of byFolder) result.set(folderId, [...byName.values()].map(assetMeta))
  return result
}

// ---------------------------------------------------------------------------
// Handlers (auth/role already resolved by the router)
// ---------------------------------------------------------------------------

/**
 * Doc-scoped asset surface under /api/docs/:docId/assets. The router has
 * already resolved the caller's doc role (viewer+ guaranteed); this enforces
 * the editor+ gate on writes per SPEC §4 (suggesters may not upload).
 */
export async function handleDocAssets(
  db: Db,
  bucket: R2Bucket,
  request: Request,
  url: URL,
  doc: DocRow,
  auth: AuthContext,
  subPath: string,
): Promise<Response> {
  const scope = assetScopeFor(doc)
  // A folder-scoped doc may predate vaults: its own legacy doc-scoped rows
  // still resolve (reads/deletes only — uploads use the current scope).
  const fallbackIds = scope.kind === 'folder' ? [doc.id] : []

  if (subPath === '/assets' || subPath === '/assets/') {
    if (request.method === 'GET') return listAssets(db, scope, fallbackIds)
    if (request.method === 'POST') {
      if (!roleAtLeast(auth.role, 'editor')) return json({ error: 'forbidden' }, 403)
      return uploadAsset(db, bucket, request, url, scope, auth)
    }
    return json({ error: 'method-not-allowed' }, 405)
  }

  const match = subPath.match(/^\/assets\/([^/]+)$/)
  if (!match) return json({ error: 'not-found' }, 404)
  const filename = safeDecode(match[1]!)

  if (request.method === 'GET') return streamAsset(db, bucket, scope, filename, fallbackIds, request)
  if (request.method === 'DELETE') {
    if (!roleAtLeast(auth.role, 'editor')) return json({ error: 'forbidden' }, 403)
    return deleteAsset(db, bucket, scope, filename, fallbackIds)
  }
  return json({ error: 'method-not-allowed' }, 405)
}

/**
 * Folder-scoped asset surface (CLI pull/sync + the file-tree sidebar): list,
 * upload, download, and delete. Upload/delete mirror the doc-scoped gate
 * (editor+ — here the caller's effective folder role, resolved by the router).
 */
export async function handleFolderAssets(
  db: Db,
  bucket: R2Bucket,
  request: Request,
  url: URL,
  folderId: string,
  subPath: string,
  auth: AuthContext | null,
): Promise<Response> {
  const scope: AssetScope = { kind: 'folder', id: folderId }
  // Legacy doc-scoped rows of docs homed here resolve through this surface
  // too — the CLI folder sync must see a re-homed doc's pre-vault images.
  const fallbackIds = await fallbackDocIdsFor(db, folderId)
  if (subPath === '/assets' || subPath === '/assets/') {
    if (request.method === 'GET') return listAssets(db, scope, fallbackIds)
    if (request.method === 'POST') {
      if (auth === null || !roleAtLeast(auth.role, 'editor')) return json({ error: 'forbidden' }, 403)
      return uploadAsset(db, bucket, request, url, scope, auth)
    }
    return json({ error: 'method-not-allowed' }, 405)
  }
  const match = subPath.match(/^\/assets\/([^/]+)$/)
  if (!match) return json({ error: 'not-found' }, 404)
  const filename = safeDecode(match[1]!)
  if (request.method === 'GET') return streamAsset(db, bucket, scope, filename, fallbackIds, request)
  if (request.method === 'DELETE') {
    // Same gate as the doc-scoped delete (SPEC §4): editor+ only.
    if (auth === null || !roleAtLeast(auth.role, 'editor')) return json({ error: 'forbidden' }, 403)
    return deleteAsset(db, bucket, scope, filename, fallbackIds)
  }
  return json({ error: 'method-not-allowed' }, 405)
}

async function listAssets(db: Db, scope: AssetScope, fallbackDocIds: string[]): Promise<Response> {
  const rows = await listAssetRowsMerged(db, scope, fallbackDocIds)
  return json({ assets: rows.map(assetMeta) })
}

async function uploadAsset(
  db: Db,
  bucket: R2Bucket,
  request: Request,
  url: URL,
  scope: AssetScope,
  auth: AuthContext,
): Promise<Response> {
  const rawName = url.searchParams.get('filename')
  if (!rawName) return json({ error: 'filename-required' }, 400)
  const normalized = normalizeAssetFilename(rawName)
  if (!normalized) return json({ error: 'bad-filename' }, 400)

  const contentType = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  if (assetKindForContentType(contentType) === null) return json({ error: 'unsupported-content-type' }, 415)

  const declared = Number(request.headers.get('content-length') ?? '0')
  if (declared > MAX_ASSET_BYTES) return json({ error: 'too-large' }, 413)
  const body = await request.arrayBuffer()
  if (body.byteLength > MAX_ASSET_BYTES) return json({ error: 'too-large' }, 413)
  if (body.byteLength === 0) return json({ error: 'empty-body' }, 400)

  const overwrite = url.searchParams.get('overwrite') === 'true'
  const existingRows = await listAssetRows(db, scope)
  const existing = existingRows.find((r) => r.filename === normalized)

  if (existing && overwrite) {
    const stored = await bucket.put(existing.r2Key, body, { httpMetadata: { contentType } })
    const update = {
      contentType,
      size: body.byteLength,
      etag: stored.etag,
      createdBy: auth.principal.id,
      createdAt: Date.now(),
    }
    await db.update(assets).set(update).where(eq(assets.id, existing.id))
    return json({ asset: assetMeta({ ...existing, ...update }), path: existing.filename } satisfies UploadAssetResponse)
  }

  const filename = uniqueAssetFilename(normalized, new Set(existingRows.map((r) => r.filename)))
  const r2Key = assetR2Key(scope, filename)
  const stored = await bucket.put(r2Key, body, { httpMetadata: { contentType } })
  const row: AssetRow = {
    id: crypto.randomUUID(),
    folderId: scope.kind === 'folder' ? scope.id : null,
    docId: scope.kind === 'doc' ? scope.id : null,
    filename,
    r2Key,
    contentType,
    size: body.byteLength,
    etag: stored.etag,
    createdBy: auth.principal.id,
    createdAt: Date.now(),
  }
  await db.insert(assets).values(row)
  return json({ asset: assetMeta(row), path: filename } satisfies UploadAssetResponse)
}

async function streamAsset(
  db: Db,
  bucket: R2Bucket,
  scope: AssetScope,
  filename: string,
  fallbackDocIds: string[],
  request: Request,
): Promise<Response> {
  const row = await resolveAssetRow(db, scope, filename, fallbackDocIds)
  if (!row) return json({ error: 'not-found' }, 404)
  const object = await bucket.get(row.r2Key)
  if (!object) return json({ error: 'not-found' }, 404) // honest 404: row without bytes
  // Assets are served from a STABLE per-filename URL, so a re-push (overwrite)
  // reuses the same URL with new bytes. `no-cache` (not `max-age`) makes the
  // browser revalidate on every load instead of serving a stale copy for the
  // freshness window — the fix for "update not visible without a hard refresh".
  // The ETag keeps that revalidation cheap: unchanged bytes come back as a 304.
  const headers = new Headers({
    'content-type': row.contentType,
    etag: object.httpEtag,
    'cache-control': 'private, no-cache',
  })
  if (assetKindForContentType(row.contentType) === 'html') {
    headers.set('content-security-policy', 'sandbox allow-scripts')
    headers.set('x-content-type-options', 'nosniff')
  }
  if (etagMatches(request.headers.get('if-none-match'), object.httpEtag)) {
    return new Response(null, { status: 304, headers })
  }
  headers.set('content-length', String(object.size))
  return new Response(object.body as unknown as BodyInit, { headers })
}

/**
 * True when an `If-None-Match` header covers `etag` (a quoted validator),
 * so the cached copy is still current and a 304 may be returned. Tolerates the
 * `*` wildcard, comma-separated lists, and weak (`W/`) prefixes.
 */
function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false
  if (ifNoneMatch.trim() === '*') return true
  const strip = (tag: string) => tag.trim().replace(/^W\//, '')
  const target = strip(etag)
  return ifNoneMatch.split(',').some((tag) => strip(tag) === target)
}

async function deleteAsset(
  db: Db,
  bucket: R2Bucket,
  scope: AssetScope,
  filename: string,
  fallbackDocIds: string[],
): Promise<Response> {
  const row = await resolveAssetRow(db, scope, filename, fallbackDocIds)
  if (!row) return json({ error: 'not-found' }, 404)
  await bucket.delete(row.r2Key)
  await db.delete(assets).where(eq(assets.id, row.id))
  return json({ ok: true })
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}
