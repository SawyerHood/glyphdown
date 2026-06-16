import { env } from 'cloudflare:workers'
import { getServerByName, type Server } from 'partyserver'
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import {
  type AssetVersionMeta,
  HEADER_ASSET,
  MAX_ASSET_BYTES,
  assetKindForContentType,
  normalizeAssetFilename,
  roleAtLeast,
  type AssetMeta,
  type UploadAssetResponse,
} from '@glyphdown/protocol'
import { assetVersions, assets, contentObjects, docs } from '../db/schema.ts'
import type { Db } from '../db/client.ts'
import { trustedHeaders, type AuthContext } from './auth.ts'
import type { DocRow } from './roles.ts'
import { asAppEnv } from '../env.ts'
import { installHtmlCommentsRuntime } from '../runtime/html-comments.ts'

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

export type AssetRow = typeof assets.$inferSelect
type AssetVersionRow = typeof assetVersions.$inferSelect

function contentObjectKey(hash: string): string {
  return `asset-blobs/sha256/${hash}`
}

function assetVersionMeta(row: AssetVersionRow, currentVersionId: string | null): AssetVersionMeta {
  return {
    id: row.id,
    assetId: row.assetId,
    contentHash: row.contentHash,
    size: row.size,
    etag: row.etag,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    ...(row.message !== null ? { message: row.message } : {}),
    current: row.id === currentVersionId,
  }
}

async function inAssetTransaction<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction((tx) => fn(tx as unknown as Db))
}

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
export async function fallbackDocIdsFor(db: Db, folderId: string): Promise<string[]> {
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
export async function resolveAssetRow(
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

  const versionRoute = assetVersionRoute(subPath)
  if (versionRoute) {
    return handleAssetVersions(db, bucket, request, scope, versionRoute.filename, fallbackIds, auth, versionRoute)
  }

  const commentingViewMatch = subPath.match(/^\/assets\/([^/]+)\/commenting-view$/)
  if (commentingViewMatch) {
    if (request.method !== 'GET') return json({ error: 'method-not-allowed' }, 405)
    const filename = safeDecode(commentingViewMatch[1]!)
    return streamAssetCommentingView(db, bucket, scope, filename, fallbackIds, assetPublicPath(url))
  }

  const match = subPath.match(/^\/assets\/([^/]+)$/)
  if (!match) return json({ error: 'not-found' }, 404)
  const filename = safeDecode(match[1]!)

  if (request.method === 'GET') return streamAsset(db, bucket, scope, filename, fallbackIds, url.searchParams.get('version'))
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

  const versionRoute = assetVersionRoute(subPath)
  if (versionRoute) {
    if (auth === null) return json({ error: 'forbidden' }, 403)
    return handleAssetVersions(db, bucket, request, scope, versionRoute.filename, fallbackIds, auth, versionRoute)
  }

  const commentingViewMatch = subPath.match(/^\/assets\/([^/]+)\/commenting-view$/)
  if (commentingViewMatch) {
    if (request.method !== 'GET') return json({ error: 'method-not-allowed' }, 405)
    const filename = safeDecode(commentingViewMatch[1]!)
    return streamAssetCommentingView(db, bucket, scope, filename, fallbackIds, assetPublicPath(url))
  }

  const match = subPath.match(/^\/assets\/([^/]+)$/)
  if (!match) return json({ error: 'not-found' }, 404)
  const filename = safeDecode(match[1]!)
  if (request.method === 'GET') return streamAsset(db, bucket, scope, filename, fallbackIds, url.searchParams.get('version'))
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
    let result: { row: AssetRow; version: AssetVersionRow }
    try {
      result = await appendVersionToExistingAsset(db, bucket, existing, body, contentType, auth)
    } catch (err) {
      if (err instanceof Error && (err.message === 'legacy-asset-bytes-missing' || err.message === 'asset-not-found')) {
        return json({ error: 'not-found' }, 404)
      }
      throw err
    }
    const row = result.row
    return json({ asset: assetMeta(row), path: existing.filename } satisfies UploadAssetResponse)
  }

  const filename = uniqueAssetFilename(normalized, new Set(existingRows.map((r) => r.filename)))
  const r2Key = assetR2Key(scope, filename)
  const blob = await ensureContentBlob(db, bucket, body)
  const now = Date.now()
  const versionId = crypto.randomUUID()
  const insertRow: AssetRow = {
    id: crypto.randomUUID(),
    folderId: scope.kind === 'folder' ? scope.id : null,
    docId: scope.kind === 'doc' ? scope.id : null,
    filename,
    r2Key,
    contentType,
    size: body.byteLength,
    etag: blob.etag,
    currentVersionId: null,
    createdBy: auth.principal.id,
    createdAt: now,
  }
  await inAssetTransaction(db, async (tx) => {
    await tx.insert(contentObjects).values({ hash: blob.hash, size: body.byteLength, refcount: 1 }).onConflictDoUpdate({
      target: contentObjects.hash,
      set: { refcount: sql`${contentObjects.refcount} + 1` },
    })
    await tx.insert(assets).values(insertRow)
    await tx.insert(assetVersions).values({
      id: versionId,
      assetId: insertRow.id,
      contentHash: blob.hash,
      size: body.byteLength,
      etag: blob.etag,
      createdBy: auth.principal.id,
      createdAt: now,
      message: null,
    })
    await tx.update(assets).set({ currentVersionId: versionId }).where(eq(assets.id, insertRow.id))
  })
  const row: AssetRow = { ...insertRow, currentVersionId: versionId }
  await notifyHtmlAssetContentChanged(row, body, auth)
  return json({ asset: assetMeta(row), path: filename } satisfies UploadAssetResponse)
}

interface PreparedBlob {
  hash: string
  etag: string
}

interface PreparedVersion {
  id: string
  contentHash: string
  size: number
  etag: string
  createdBy: string
  createdAt: number
  message: string | null
}

async function ensureContentBlob(db: Db, bucket: R2Bucket, body: ArrayBuffer): Promise<PreparedBlob> {
  const hash = await sha256ArrayBuffer(body)
  const key = contentObjectKey(hash)
  const known = (await db.select({ hash: contentObjects.hash }).from(contentObjects).where(eq(contentObjects.hash, hash)).limit(1))[0]
  if (!known) {
    const stored = await bucket.put(key, body)
    return { hash, etag: stored?.etag ?? hash }
  }

  const object = await bucket.get(key)
  if (object) return { hash, etag: object.etag ?? stripHttpEtag(object.httpEtag) }

  // D1 says the object exists but R2 is missing. Repair from the bytes we
  // already have; the refcount transaction remains the source of truth.
  const stored = await bucket.put(key, body)
  return { hash, etag: stored?.etag ?? hash }
}

async function appendVersionToExistingAsset(
  db: Db,
  bucket: R2Bucket,
  existing: AssetRow,
  body: ArrayBuffer,
  contentType: string,
  auth: AuthContext,
): Promise<{ row: AssetRow; version: AssetVersionRow }> {
  const nextBlob = await ensureContentBlob(db, bucket, body)
  const backfill = existing.currentVersionId === null ? await prepareLegacyBackfill(db, bucket, existing) : null
  const now = Date.now()
  const nextVersion: PreparedVersion = {
    id: crypto.randomUUID(),
    contentHash: nextBlob.hash,
    size: body.byteLength,
    etag: nextBlob.etag,
    createdBy: auth.principal.id,
    createdAt: now,
    message: null,
  }

  const { row, version } = await inAssetTransaction(db, async (tx) => {
    const current = (await tx.select().from(assets).where(eq(assets.id, existing.id)).limit(1))[0]
    if (!current) throw new Error('asset-not-found')

    if (current.currentVersionId === null && backfill) {
      await insertPreparedVersion(tx, current.id, backfill)
    }

    await insertPreparedVersion(tx, current.id, nextVersion)
    const update = {
      contentType,
      size: nextVersion.size,
      etag: nextVersion.etag,
      currentVersionId: nextVersion.id,
      createdBy: auth.principal.id,
      createdAt: now,
    }
    await tx.update(assets).set(update).where(eq(assets.id, current.id))
    const updated = { ...current, ...update }
    return {
      row: updated,
      version: {
        id: nextVersion.id,
        assetId: current.id,
        contentHash: nextVersion.contentHash,
        size: nextVersion.size,
        etag: nextVersion.etag,
        createdBy: nextVersion.createdBy,
        createdAt: nextVersion.createdAt,
        message: nextVersion.message,
      },
    }
  })

  await notifyHtmlAssetContentChanged(row, body, auth)
  return { row, version }
}

async function prepareLegacyBackfill(db: Db, bucket: R2Bucket, existing: AssetRow): Promise<PreparedVersion> {
  const object = await bucket.get(existing.r2Key)
  if (!object) throw new Error('legacy-asset-bytes-missing')
  const body = await objectArrayBuffer(object)
  const blob = await ensureContentBlob(db, bucket, body)
  return {
    id: crypto.randomUUID(),
    contentHash: blob.hash,
    size: existing.size,
    // Preserve the legacy row's HTTP/sync etag for the imported v1 audit row.
    etag: existing.etag,
    createdBy: existing.createdBy,
    createdAt: existing.createdAt,
    message: null,
  }
}

async function insertPreparedVersion(tx: Db, assetId: string, version: PreparedVersion): Promise<void> {
  await tx
    .insert(contentObjects)
    .values({ hash: version.contentHash, size: version.size, refcount: 1 })
    .onConflictDoUpdate({
      target: contentObjects.hash,
      set: { refcount: sql`${contentObjects.refcount} + 1` },
    })
  await tx.insert(assetVersions).values({
    id: version.id,
    assetId,
    contentHash: version.contentHash,
    size: version.size,
    etag: version.etag,
    createdBy: version.createdBy,
    createdAt: version.createdAt,
    message: version.message,
  })
}

async function notifyHtmlAssetContentChanged(row: AssetRow, body: ArrayBuffer, auth: AuthContext): Promise<void> {
  if (assetKindForContentType(row.contentType) !== 'html') return
  const namespace = asAppEnv(env).HtmlDocDO as unknown as DurableObjectNamespace<Server<Env>> | undefined
  if (!namespace) return
  try {
    const headers = trustedHeaders(auth)
    headers.set(HEADER_ASSET, row.id)
    headers.set('content-type', 'application/json')
    const stub = await getServerByName(namespace, row.id)
    const response = await stub.fetch(
      new Request('https://do/admin/content', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          etag: row.etag,
          contentHash: await sha256ArrayBuffer(body),
          html: new TextDecoder().decode(body),
        }),
      }),
    )
    if (!response.ok) console.error(`HtmlDocDO content refresh failed for ${row.id}: ${response.status}`)
  } catch (err) {
    console.error(`HtmlDocDO content refresh failed for ${row.id}:`, err)
  }
}

async function sha256ArrayBuffer(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

interface AssetVersionRoute {
  filename: string
  versionId?: string
  action?: 'raw' | 'restore' | 'name'
}

function assetVersionRoute(subPath: string): AssetVersionRoute | null {
  const match = subPath.match(/^\/assets\/([^/]+)\/versions(?:\/([^/]+)(?:\/(raw|restore|name))?)?$/)
  if (!match) return null
  return {
    filename: safeDecode(match[1]!),
    ...(match[2] ? { versionId: safeDecode(match[2]) } : {}),
    ...(match[3] ? { action: match[3] as AssetVersionRoute['action'] } : {}),
  }
}

async function handleAssetVersions(
  db: Db,
  bucket: R2Bucket,
  request: Request,
  scope: AssetScope,
  filename: string,
  fallbackDocIds: string[],
  auth: AuthContext,
  route: AssetVersionRoute,
): Promise<Response> {
  const row = await resolveAssetRow(db, scope, filename, fallbackDocIds)
  if (!row) return json({ error: 'not-found' }, 404)

  if (!route.versionId && !route.action) {
    if (request.method !== 'GET') return json({ error: 'method-not-allowed' }, 405)
    return listAssetVersions(db, row)
  }

  if (!route.versionId) return json({ error: 'not-found' }, 404)
  if (route.action === 'raw') {
    if (request.method !== 'GET') return json({ error: 'method-not-allowed' }, 405)
    return streamAssetVersionById(db, bucket, row, route.versionId)
  }

  if (route.action === 'restore') {
    if (request.method !== 'POST') return json({ error: 'method-not-allowed' }, 405)
    if (!roleAtLeast(auth.role, 'editor')) return json({ error: 'forbidden' }, 403)
    return restoreAssetVersion(db, bucket, row, route.versionId, auth)
  }

  if (route.action === 'name' || !route.action) {
    if (request.method !== 'POST' && request.method !== 'PATCH') return json({ error: 'method-not-allowed' }, 405)
    if (!roleAtLeast(auth.role, 'editor')) return json({ error: 'forbidden' }, 403)
    return nameAssetVersion(db, request, row, route.versionId)
  }

  return json({ error: 'not-found' }, 404)
}

async function listAssetVersions(db: Db, row: AssetRow): Promise<Response> {
  const versions = await db
    .select()
    .from(assetVersions)
    .where(eq(assetVersions.assetId, row.id))
    .orderBy(desc(assetVersions.createdAt))
  return json({ versions: versions.map((version) => assetVersionMeta(version, row.currentVersionId)) })
}

async function streamAssetVersionById(db: Db, bucket: R2Bucket, row: AssetRow, versionId: string): Promise<Response> {
  const version = await findAssetVersion(db, row.id, versionId)
  if (!version) return json({ error: 'version-not-found' }, 404)
  const object = await bucket.get(contentObjectKey(version.contentHash))
  if (!object) return json({ error: 'version-bytes-not-found' }, 404)
  return assetObjectResponse(row.contentType, version.size, version.etag, object)
}

async function restoreAssetVersion(
  db: Db,
  bucket: R2Bucket,
  row: AssetRow,
  versionId: string,
  auth: AuthContext,
): Promise<Response> {
  const source = await findAssetVersion(db, row.id, versionId)
  if (!source) return json({ error: 'version-not-found' }, 404)
  const object = await bucket.get(contentObjectKey(source.contentHash))
  if (!object) return json({ error: 'version-bytes-not-found' }, 404)
  const body = await objectArrayBuffer(object)
  const now = Date.now()
  const restored: PreparedVersion = {
    id: crypto.randomUUID(),
    contentHash: source.contentHash,
    size: source.size,
    etag: source.etag,
    createdBy: auth.principal.id,
    createdAt: now,
    message: null,
  }

  const updatedRow = await inAssetTransaction(db, async (tx) => {
    const current = (await tx.select().from(assets).where(eq(assets.id, row.id)).limit(1))[0]
    if (!current) throw new Error('asset-not-found')
    await insertPreparedVersion(tx, row.id, restored)
    const update = {
      size: restored.size,
      etag: restored.etag,
      currentVersionId: restored.id,
      createdBy: auth.principal.id,
      createdAt: now,
    }
    await tx.update(assets).set(update).where(eq(assets.id, row.id))
    return { ...current, ...update }
  })

  await notifyHtmlAssetContentChanged(updatedRow, body, auth)
  const version: AssetVersionRow = { assetId: row.id, ...restored }
  return json({ asset: assetMeta(updatedRow), version: assetVersionMeta(version, updatedRow.currentVersionId) })
}

async function nameAssetVersion(db: Db, request: Request, row: AssetRow, versionId: string): Promise<Response> {
  const version = await findAssetVersion(db, row.id, versionId)
  if (!version) return json({ error: 'version-not-found' }, 404)
  const payload = await readJson<{ name?: unknown; message?: unknown }>(request)
  const raw = payload?.name ?? payload?.message
  if (raw !== null && raw !== undefined && typeof raw !== 'string') return json({ error: 'bad-name' }, 400)
  const message = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null
  await db.update(assetVersions).set({ message }).where(and(eq(assetVersions.id, version.id), eq(assetVersions.assetId, row.id)))
  return json(assetVersionMeta({ ...version, message }, row.currentVersionId))
}

async function findAssetVersion(db: Db, assetId: string, versionId: string): Promise<AssetVersionRow | undefined> {
  return (
    await db
      .select()
      .from(assetVersions)
      .where(and(eq(assetVersions.id, versionId), eq(assetVersions.assetId, assetId)))
      .limit(1)
  )[0]
}

async function versionObject(
  db: Db,
  bucket: R2Bucket,
  row: AssetRow,
  versionId: string,
): Promise<R2ObjectBody | null> {
  const version = await findAssetVersion(db, row.id, versionId)
  if (!version) return null
  return bucket.get(contentObjectKey(version.contentHash))
}

function assetObjectResponse(contentType: string, size: number, etag: string, object: R2ObjectBody): Response {
  const headers = new Headers({
    'content-type': contentType,
    'content-length': String(size),
    etag: httpEtag(etag),
    'cache-control': 'private, max-age=3600',
  })
  if (assetKindForContentType(contentType) === 'html') {
    headers.set('content-security-policy', 'sandbox allow-scripts')
    headers.set('x-content-type-options', 'nosniff')
  }
  return new Response(object.body as unknown as BodyInit, { headers })
}

function httpEtag(etag: string): string {
  if (etag.startsWith('"') || etag.startsWith('W/"')) return etag
  return `"${etag}"`
}

function stripHttpEtag(etag: string): string {
  return etag.replace(/^W\//, '').replace(/^"|"$/g, '')
}

async function streamAsset(
  db: Db,
  bucket: R2Bucket,
  scope: AssetScope,
  filename: string,
  fallbackDocIds: string[],
  versionId?: string | null,
): Promise<Response> {
  const row = await resolveAssetRow(db, scope, filename, fallbackDocIds)
  if (!row) return json({ error: 'not-found' }, 404)

  if (versionId) return streamAssetVersionById(db, bucket, row, versionId)
  if (row.currentVersionId) return streamAssetVersionById(db, bucket, row, row.currentVersionId)

  const object = await bucket.get(row.r2Key)
  if (!object) return json({ error: 'not-found' }, 404) // honest 404: row without bytes
  const headers = new Headers({
    'content-type': row.contentType,
    'content-length': String(object.size),
    etag: object.httpEtag,
    'cache-control': 'private, max-age=3600',
  })
  if (assetKindForContentType(row.contentType) === 'html') {
    headers.set('content-security-policy', 'sandbox allow-scripts')
    headers.set('x-content-type-options', 'nosniff')
  }
  return new Response(object.body as unknown as BodyInit, { headers })
}

async function streamAssetCommentingView(
  db: Db,
  bucket: R2Bucket,
  scope: AssetScope,
  filename: string,
  fallbackDocIds: string[],
  publicAssetPath: string,
): Promise<Response> {
  const row = await resolveAssetRow(db, scope, filename, fallbackDocIds)
  if (!row) return json({ error: 'not-found' }, 404)
  if (assetKindForContentType(row.contentType) !== 'html') return json({ error: 'unsupported-asset-type' }, 415)
  const object = row.currentVersionId
    ? await versionObject(db, bucket, row, row.currentVersionId)
    : await bucket.get(row.r2Key)
  if (!object) return json({ error: 'not-found' }, 404)
  const source = new TextDecoder().decode(await objectArrayBuffer(object))
  const nonce = randomNonce()
  const body = injectHtmlCommentsRuntime(source, nonce, publicAssetPath)
  const bytes = new TextEncoder().encode(body)
  const headers = new Headers({
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(bytes.byteLength),
    etag: `W/"commenting-${row.etag}-${nonce}"`,
    'cache-control': 'private, no-store',
    'content-security-policy': 'sandbox allow-scripts',
    'x-content-type-options': 'nosniff',
    'x-glyphdown-view-nonce': nonce,
    vary: 'cookie, authorization, x-glyphdown-share',
  })
  return new Response(bytes, { headers })
}

function injectHtmlCommentsRuntime(html: string, nonce: string, publicAssetPath: string): string {
  const base = /<base\b/i.test(html) ? '' : `<base href="${escapeAttr(publicAssetPath)}">`
  const script = `<script data-glyphdown-runtime>${runtimeSource(nonce)}</script>`
  const injection = `${base}${script}`
  const headOpen = html.match(/<head\b[^>]*>/i)
  if (headOpen?.index !== undefined) {
    const at = headOpen.index + headOpen[0].length
    return `${html.slice(0, at)}${injection}${html.slice(at)}`
  }

  const htmlOpen = html.match(/<html\b[^>]*>/i)
  if (htmlOpen?.index !== undefined) {
    const at = htmlOpen.index + htmlOpen[0].length
    return `${html.slice(0, at)}<head>${injection}</head>${html.slice(at)}`
  }

  const doctype = html.match(/^\s*<!doctype[^>]*>\s*/i)
  const prefix = doctype?.[0] ?? ''
  return `${prefix}<head>${injection}</head>${html.slice(prefix.length)}`
}

function runtimeSource(nonce: string): string {
  return `;(${installHtmlCommentsRuntime.toString()})(${JSON.stringify(nonce)});`.replace(/<\/script/giu, '<\\/script')
}

function assetPublicPath(url: URL): string {
  return url.pathname.replace(/\/commenting-view$/, '')
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function randomNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function objectArrayBuffer(object: R2ObjectBody): Promise<ArrayBuffer> {
  const body = object.body as unknown
  if (body instanceof ArrayBuffer) return body
  if (body instanceof Uint8Array) {
    const copy = new Uint8Array(body.byteLength)
    copy.set(body)
    return copy.buffer
  }
  if (body && typeof (body as { arrayBuffer?: unknown }).arrayBuffer === 'function') {
    return (await (body as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer()) as ArrayBuffer
  }
  return new Response(body as BodyInit).arrayBuffer()
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
  const versions = await db.select().from(assetVersions).where(eq(assetVersions.assetId, row.id))
  const gcHashes = await inAssetTransaction(db, async (tx) => {
    const toDelete = await decrementContentRefs(tx, versions)
    await tx.delete(assets).where(eq(assets.id, row.id))
    for (const hash of toDelete) await tx.delete(contentObjects).where(eq(contentObjects.hash, hash))
    return toDelete
  })
  await bucket.delete(row.r2Key)
  for (const hash of gcHashes) await bucket.delete(contentObjectKey(hash))
  return json({ ok: true })
}

async function decrementContentRefs(tx: Db, versions: AssetVersionRow[]): Promise<string[]> {
  const byHash = new Map<string, number>()
  for (const version of versions) byHash.set(version.contentHash, (byHash.get(version.contentHash) ?? 0) + 1)
  const gcHashes: string[] = []
  for (const [hash, count] of byHash) {
    await tx
      .update(contentObjects)
      .set({ refcount: sql`${contentObjects.refcount} - ${count}` })
      .where(eq(contentObjects.hash, hash))
    const row = (await tx.select().from(contentObjects).where(eq(contentObjects.hash, hash)).limit(1))[0]
    if (row && row.refcount <= 0) gcHashes.push(hash)
  }
  return gcHashes
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

async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T
  } catch {
    return null
  }
}
