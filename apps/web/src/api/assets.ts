import { and, eq, inArray, isNull } from 'drizzle-orm'
import {
  MAX_ASSET_BYTES,
  normalizeAssetFilename,
  roleAtLeast,
  type AssetMeta,
  type Role,
  type UploadAssetResponse,
} from '@glyphdown/protocol'
import { assets, docs } from '../db/schema.ts'
import type { Db } from '../db/client.ts'
import type { AuthContext } from './auth.ts'
import type { DocRow } from './roles.ts'

/**
 * Doc/folder image assets: bytes in R2 (ASSETS binding), metadata in D1
 * (`assets` table). A doc's asset namespace is its containing folder when it
 * has one — so every doc in a folder shares one image namespace and markdown
 * `![](name.png)` references stay valid across the folder — else the doc
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

  if (request.method === 'GET') return streamAsset(db, bucket, scope, filename, fallbackIds)
  if (request.method === 'DELETE') {
    if (!roleAtLeast(auth.role, 'editor')) return json({ error: 'forbidden' }, 403)
    return deleteAsset(db, bucket, scope, filename, fallbackIds)
  }
  return json({ error: 'method-not-allowed' }, 405)
}

/**
 * Folder-scoped asset surface (CLI pull/sync + the file-tree sidebar): list,
 * download, and delete. Uploads stay doc-scoped so role logic remains
 * per-doc; deletion mirrors the doc-scoped gate (editor+ — here the caller's
 * effective folder role, resolved by the router).
 */
export async function handleFolderAssets(
  db: Db,
  bucket: R2Bucket,
  request: Request,
  folderId: string,
  subPath: string,
  role: Role | null,
): Promise<Response> {
  const scope: AssetScope = { kind: 'folder', id: folderId }
  // Legacy doc-scoped rows of docs homed here resolve through this surface
  // too — the CLI folder sync must see a re-homed doc's pre-vault images.
  const fallbackIds = await fallbackDocIdsFor(db, folderId)
  if (subPath === '/assets' || subPath === '/assets/') {
    if (request.method === 'GET') return listAssets(db, scope, fallbackIds)
    return json({ error: 'method-not-allowed' }, 405)
  }
  const match = subPath.match(/^\/assets\/([^/]+)$/)
  if (!match) return json({ error: 'not-found' }, 404)
  const filename = safeDecode(match[1]!)
  if (request.method === 'GET') return streamAsset(db, bucket, scope, filename, fallbackIds)
  if (request.method === 'DELETE') {
    // Same gate as the doc-scoped delete (SPEC §4): editor+ only.
    if (role === null || !roleAtLeast(role, 'editor')) return json({ error: 'forbidden' }, 403)
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
  if (!contentType.startsWith('image/')) return json({ error: 'unsupported-content-type' }, 415)

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
): Promise<Response> {
  const row = await resolveAssetRow(db, scope, filename, fallbackDocIds)
  if (!row) return json({ error: 'not-found' }, 404)
  const object = await bucket.get(row.r2Key)
  if (!object) return json({ error: 'not-found' }, 404) // honest 404: row without bytes
  const headers = new Headers({
    'content-type': row.contentType,
    'content-length': String(object.size),
    etag: object.httpEtag,
    'cache-control': 'private, max-age=3600',
  })
  return new Response(object.body as unknown as BodyInit, { headers })
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
