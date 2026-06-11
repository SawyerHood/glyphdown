import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { UploadAssetResponse } from '@glyphdown/protocol'
import type { Db } from '../db/client.ts'
import type { AuthContext } from './auth.ts'
import type { DocRow } from './roles.ts'
import {
  assetR2Key,
  assetScopeFor,
  handleDocAssets,
  handleFolderAssets,
  MAX_ASSET_BYTES,
  normalizeAssetFilename,
  uniqueAssetFilename,
} from './assets.ts'

describe('normalizeAssetFilename', () => {
  it('lowercases and converts spaces to dashes', () => {
    expect(normalizeAssetFilename('My Diagram.PNG')).toBe('my-diagram.png')
    expect(normalizeAssetFilename('a  b\tc.png')).toBe('a-b-c.png')
  })

  it('keeps the extension', () => {
    expect(normalizeAssetFilename('Photo.JPEG')).toBe('photo.jpeg')
  })

  it('strips path separators (no traversal)', () => {
    expect(normalizeAssetFilename('../../etc/passwd')).toBe('passwd')
    expect(normalizeAssetFilename('a/b/c.png')).toBe('c.png')
    expect(normalizeAssetFilename('a\\b\\evil.png')).toBe('evil.png')
    expect(normalizeAssetFilename('..\\..\\boot.ini')).toBe('boot.ini')
  })

  it('strips leading dots', () => {
    expect(normalizeAssetFilename('..hidden.png')).toBe('hidden.png')
    expect(normalizeAssetFilename('.env')).toBe('env')
  })

  it('rejects names with nothing usable', () => {
    expect(normalizeAssetFilename('')).toBeNull()
    expect(normalizeAssetFilename('   ')).toBeNull()
    expect(normalizeAssetFilename('...')).toBeNull()
    expect(normalizeAssetFilename('/')).toBeNull()
    expect(normalizeAssetFilename('../..')).toBeNull()
  })

  it('drops control characters', () => {
    expect(normalizeAssetFilename('a\u0000b\u001f.png')).toBe('ab.png')
  })

  it('truncates very long names but keeps the extension', () => {
    const name = `${'x'.repeat(300)}.png`
    const result = normalizeAssetFilename(name)!
    expect(result.length).toBeLessThanOrEqual(200)
    expect(result.endsWith('.png')).toBe(true)
  })
})

describe('uniqueAssetFilename', () => {
  it('returns the name unchanged when free', () => {
    expect(uniqueAssetFilename('pic.png', new Set())).toBe('pic.png')
  })

  it('suffixes -2 before the extension on collision', () => {
    expect(uniqueAssetFilename('pic.png', new Set(['pic.png']))).toBe('pic-2.png')
  })

  it('walks -3, -4… until a free name', () => {
    expect(uniqueAssetFilename('pic.png', new Set(['pic.png', 'pic-2.png', 'pic-3.png']))).toBe('pic-4.png')
  })

  it('handles extension-less names', () => {
    expect(uniqueAssetFilename('readme', new Set(['readme']))).toBe('readme-2')
  })
})

describe('assetScopeFor', () => {
  const base = { id: 'doc-1', folderId: null as string | null }
  it('uses the folder when the doc lives in one', () => {
    expect(assetScopeFor({ ...base, folderId: 'folder-9' })).toEqual({ kind: 'folder', id: 'folder-9' })
  })
  it('falls back to the doc itself when folderless', () => {
    expect(assetScopeFor(base)).toEqual({ kind: 'doc', id: 'doc-1' })
  })
  it('keys R2 objects by scope', () => {
    expect(assetR2Key({ kind: 'folder', id: 'f1' }, 'a.png')).toBe('folder/f1/a.png')
    expect(assetR2Key({ kind: 'doc', id: 'd1' }, 'a.png')).toBe('doc/d1/a.png')
  })
})

// ---------------------------------------------------------------------------
// Handler tests: in-memory sqlite (same driver-compat trick as roles.test.ts)
// plus a Map-backed fake R2 bucket.
// ---------------------------------------------------------------------------

interface FakeStored {
  data: Uint8Array
  etag: string
  contentType: string | undefined
}

function fakeBucket() {
  const objects = new Map<string, FakeStored>()
  let n = 0
  const bucket = {
    async put(key: string, value: ArrayBuffer, opts?: { httpMetadata?: { contentType?: string } }) {
      const stored: FakeStored = {
        data: new Uint8Array(value),
        etag: `etag-${++n}`,
        contentType: opts?.httpMetadata?.contentType,
      }
      objects.set(key, stored)
      return { etag: stored.etag }
    },
    async get(key: string) {
      const stored = objects.get(key)
      if (!stored) return null
      return {
        body: stored.data,
        size: stored.data.byteLength,
        httpEtag: `"${stored.etag}"`,
        etag: stored.etag,
      }
    },
    async delete(key: string) {
      objects.delete(key)
    },
  }
  return { bucket: bucket as unknown as R2Bucket, objects }
}

function setupDb(): Db {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE assets (id TEXT PRIMARY KEY, folder_id TEXT, doc_id TEXT, filename TEXT NOT NULL,
      r2_key TEXT NOT NULL, content_type TEXT NOT NULL, size INTEGER NOT NULL, etag TEXT NOT NULL,
      created_by TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE docs (id TEXT PRIMARY KEY, title TEXT NOT NULL, filename TEXT NOT NULL DEFAULT '',
      folder_id TEXT, owner_user_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER);
    CREATE UNIQUE INDEX assets_folder_filename_idx ON assets (folder_id, filename);
    CREATE UNIQUE INDEX assets_doc_filename_idx ON assets (doc_id, filename);
  `)
  return drizzle(sqlite) as unknown as Db
}

const folderedDoc: DocRow = {
  id: 'doc-1',
  title: 'doc',
  filename: 'doc.md',
  folderId: 'folder-1',
  ownerUserId: 'owner-1',
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
}
const looseDoc: DocRow = { ...folderedDoc, id: 'doc-2', folderId: null }

const editorAuth: AuthContext = { principal: { id: 'owner-1', type: 'user', name: 'Owner' }, role: 'owner' }
const viewerAuth: AuthContext = { principal: { id: 'vera', type: 'user', name: 'Vera' }, role: 'viewer' }
const suggesterAuth: AuthContext = { principal: { id: 'sam', type: 'user', name: 'Sam' }, role: 'suggester' }

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
const HTML = new TextEncoder().encode('<!doctype html><script>window.ok = true</script>')

function uploadRequest(filename: string, opts: { contentType?: string; body?: Uint8Array; overwrite?: boolean } = {}) {
  const url = new URL(`https://x/api/docs/doc-1/assets?filename=${encodeURIComponent(filename)}${opts.overwrite ? '&overwrite=true' : ''}`)
  const request = new Request(url, {
    method: 'POST',
    headers: { 'content-type': opts.contentType ?? 'image/png' },
    body: (opts.body ?? PNG) as unknown as BodyInit,
  })
  return { request, url }
}

async function upload(
  db: Db,
  bucket: R2Bucket,
  doc: DocRow,
  filename: string,
  opts: { contentType?: string; body?: Uint8Array; overwrite?: boolean; auth?: AuthContext } = {},
): Promise<Response> {
  const { request, url } = uploadRequest(filename, opts)
  return handleDocAssets(db, bucket, request, url, doc, opts.auth ?? editorAuth, '/assets')
}

describe('handleDocAssets', () => {
  it('uploads into the folder namespace for a foldered doc', async () => {
    const db = setupDb()
    const { bucket, objects } = fakeBucket()
    const res = await upload(db, bucket, folderedDoc, 'My Pic.PNG')
    expect(res.status).toBe(200)
    const body = (await res.json()) as UploadAssetResponse
    expect(body.path).toBe('my-pic.png')
    expect(body.asset.filename).toBe('my-pic.png')
    expect(body.asset.size).toBe(PNG.byteLength)
    expect(objects.has('folder/folder-1/my-pic.png')).toBe(true)
  })

  it('uploads text/html and preserves the html extension', async () => {
    const db = setupDb()
    const { bucket, objects } = fakeBucket()
    const res = await upload(db, bucket, folderedDoc, 'Page.HTML', { contentType: 'text/html; charset=utf-8', body: HTML })
    expect(res.status).toBe(200)
    const body = (await res.json()) as UploadAssetResponse
    expect(body.path).toBe('page.html')
    expect(body.asset).toMatchObject({ filename: 'page.html', contentType: 'text/html', size: HTML.byteLength })
    expect(objects.has('folder/folder-1/page.html')).toBe(true)
  })

  it('uploads into the doc namespace for a folderless doc', async () => {
    const db = setupDb()
    const { bucket, objects } = fakeBucket()
    const res = await upload(db, bucket, looseDoc, 'pic.png')
    expect(res.status).toBe(200)
    expect(objects.has('doc/doc-2/pic.png')).toBe(true)
  })

  it('suffixes -2 on collision, replaces with overwrite=true', async () => {
    const db = setupDb()
    const { bucket, objects } = fakeBucket()
    await upload(db, bucket, folderedDoc, 'pic.png')
    const second = (await (await upload(db, bucket, folderedDoc, 'pic.png')).json()) as UploadAssetResponse
    expect(second.path).toBe('pic-2.png')

    const big = new Uint8Array([9, 9, 9, 9])
    const replaced = (
      await (await upload(db, bucket, folderedDoc, 'pic.png', { overwrite: true, body: big })).json()
    ) as UploadAssetResponse
    expect(replaced.path).toBe('pic.png')
    expect(replaced.asset.size).toBe(4)
    expect(objects.get('folder/folder-1/pic.png')!.data).toEqual(big)
    // No third row was created.
    const list = await handleDocAssets(
      db,
      bucket,
      new Request('https://x/api/docs/doc-1/assets'),
      new URL('https://x/api/docs/doc-1/assets'),
      folderedDoc,
      editorAuth,
      '/assets',
    )
    const { assets: rows } = (await list.json()) as { assets: { filename: string }[] }
    expect(rows.map((a) => a.filename).sort()).toEqual(['pic-2.png', 'pic.png'])
  })

  it('rejects uploads below editor', async () => {
    const db = setupDb()
    const { bucket } = fakeBucket()
    expect((await upload(db, bucket, folderedDoc, 'pic.png', { auth: viewerAuth })).status).toBe(403)
    const res = await upload(db, bucket, folderedDoc, 'pic.png', { auth: suggesterAuth })
    expect(res.status).toBe(403)
  })

  it('rejects non-image content types and oversize bodies', async () => {
    const db = setupDb()
    const { bucket } = fakeBucket()
    expect((await upload(db, bucket, folderedDoc, 'a.txt', { contentType: 'text/plain' })).status).toBe(415)
    const huge = new Uint8Array(MAX_ASSET_BYTES + 1)
    expect((await upload(db, bucket, folderedDoc, 'big.png', { body: huge })).status).toBe(413)
  })

  it('rejects traversal-only filenames', async () => {
    const db = setupDb()
    const { bucket } = fakeBucket()
    expect((await upload(db, bucket, folderedDoc, '../..')).status).toBe(400)
  })

  it('streams bytes back with etag and private cache-control; honest 404', async () => {
    const db = setupDb()
    const { bucket } = fakeBucket()
    await upload(db, bucket, folderedDoc, 'pic.png')
    const get = (name: string) =>
      handleDocAssets(
        db,
        bucket,
        new Request(`https://x/api/docs/doc-1/assets/${name}`),
        new URL(`https://x/api/docs/doc-1/assets/${name}`),
        folderedDoc,
        { ...editorAuth, role: 'viewer' },
        `/assets/${name}`,
      )
    const res = await get('pic.png')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('cache-control')).toBe('private, max-age=3600')
    expect(res.headers.get('content-security-policy')).toBeNull()
    expect(res.headers.get('x-content-type-options')).toBeNull()
    expect(res.headers.get('etag')).toBeTruthy()
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG)
    expect((await get('missing.png')).status).toBe(404)
  })

  it('adds sandbox headers when streaming html assets', async () => {
    const db = setupDb()
    const { bucket } = fakeBucket()
    await upload(db, bucket, folderedDoc, 'Page.HTML', { contentType: 'text/html', body: HTML })
    const res = await handleDocAssets(
      db,
      bucket,
      new Request('https://x/api/docs/doc-1/assets/page.html'),
      new URL('https://x/api/docs/doc-1/assets/page.html'),
      folderedDoc,
      { ...editorAuth, role: 'viewer' },
      '/assets/page.html',
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html')
    expect(res.headers.get('cache-control')).toBe('private, max-age=3600')
    expect(res.headers.get('content-security-policy')).toBe('sandbox allow-scripts')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(HTML)
  })

  it('deletes row + object for editor+, forbids suggesters', async () => {
    const db = setupDb()
    const { bucket, objects } = fakeBucket()
    await upload(db, bucket, folderedDoc, 'pic.png')
    const del = (auth: AuthContext) =>
      handleDocAssets(
        db,
        bucket,
        new Request('https://x/api/docs/doc-1/assets/pic.png', { method: 'DELETE' }),
        new URL('https://x/api/docs/doc-1/assets/pic.png'),
        folderedDoc,
        auth,
        '/assets/pic.png',
      )
    expect((await del(suggesterAuth)).status).toBe(403)
    expect((await del(editorAuth)).status).toBe(200)
    expect(objects.size).toBe(0)
    expect((await del(editorAuth)).status).toBe(404)
  })
})

describe('handleFolderAssets', () => {
  const folderId = 'folder-1' // matches folderedDoc's namespace

  const authWithRole = (role: AuthContext['role'] | null): AuthContext | null =>
    role === null ? null : { ...editorAuth, role }

  const folderReq = (method: string, sub: string, role: AuthContext['role'] | null) => (db: Db, bucket: R2Bucket) => {
    const url = new URL(`https://x/api/folders/${folderId}${sub}`)
    return handleFolderAssets(db, bucket, new Request(url, { method }), url, folderId, sub, authWithRole(role))
  }

  const folderUpload = (
    db: Db,
    bucket: R2Bucket,
    filename: string,
    opts: { contentType?: string; body?: Uint8Array; auth?: AuthContext | null } = {},
  ) => {
    const url = new URL(`https://x/api/folders/${folderId}/assets?filename=${encodeURIComponent(filename)}`)
    const request = new Request(url, {
      method: 'POST',
      headers: { 'content-type': opts.contentType ?? 'image/png' },
      body: (opts.body ?? PNG) as unknown as BodyInit,
    })
    return handleFolderAssets(db, bucket, request, url, folderId, '/assets', opts.auth ?? editorAuth)
  }

  it('lists the folder namespace (docs in the folder share it)', async () => {
    const db = setupDb()
    const { bucket } = fakeBucket()
    await upload(db, bucket, folderedDoc, 'pic.png')
    const res = await folderReq('GET', '/assets', 'viewer')(db, bucket)
    expect(res.status).toBe(200)
    const { assets: rows } = (await res.json()) as { assets: { filename: string }[] }
    expect(rows.map((a) => a.filename)).toEqual(['pic.png'])
  })

  it('streams bytes for GET /assets/<filename>', async () => {
    const db = setupDb()
    const { bucket } = fakeBucket()
    await upload(db, bucket, folderedDoc, 'pic.png')
    const res = await folderReq('GET', '/assets/pic.png', 'viewer')(db, bucket)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('content-security-policy')).toBeNull()
    expect(res.headers.get('x-content-type-options')).toBeNull()
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG)
  })

  it('uploads text/html for editor+ on the folder surface and rejects viewers', async () => {
    const db = setupDb()
    const { bucket, objects } = fakeBucket()
    const uploaded = await folderUpload(db, bucket, 'Folder Page.HTM', { contentType: 'text/html', body: HTML })
    expect(uploaded.status).toBe(200)
    const body = (await uploaded.json()) as UploadAssetResponse
    expect(body.path).toBe('folder-page.htm')
    expect(body.asset).toMatchObject({ filename: 'folder-page.htm', contentType: 'text/html' })
    expect(objects.has('folder/folder-1/folder-page.htm')).toBe(true)

    const denied = await folderUpload(db, bucket, 'viewer.html', { contentType: 'text/html', body: HTML, auth: viewerAuth })
    expect(denied.status).toBe(403)

    const streamed = await folderReq('GET', '/assets/folder-page.htm', 'viewer')(db, bucket)
    expect(streamed.status).toBe(200)
    expect(streamed.headers.get('content-security-policy')).toBe('sandbox allow-scripts')
    expect(streamed.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('deletes for editor+ (row and object), mirroring the doc-scoped gate', async () => {
    const db = setupDb()
    const { bucket, objects } = fakeBucket()
    await upload(db, bucket, folderedDoc, 'pic.png')
    expect((await folderReq('DELETE', '/assets/pic.png', 'editor')(db, bucket)).status).toBe(200)
    expect(objects.size).toBe(0)
    expect((await folderReq('DELETE', '/assets/pic.png', 'editor')(db, bucket)).status).toBe(404)
  })

  it('forbids deletes below editor (viewer, suggester, no role)', async () => {
    const db = setupDb()
    const { bucket, objects } = fakeBucket()
    await upload(db, bucket, folderedDoc, 'pic.png')
    expect((await folderReq('DELETE', '/assets/pic.png', 'viewer')(db, bucket)).status).toBe(403)
    expect((await folderReq('DELETE', '/assets/pic.png', 'suggester')(db, bucket)).status).toBe(403)
    expect((await folderReq('DELETE', '/assets/pic.png', null)(db, bucket)).status).toBe(403)
    expect(objects.size).toBe(1)
  })

  it('rejects folder uploads without editor role', async () => {
    const db = setupDb()
    const { bucket } = fakeBucket()
    const res = await folderUpload(db, bucket, 'pic.png', { auth: authWithRole('suggester') })
    expect(res.status).toBe(403)
  })
})
