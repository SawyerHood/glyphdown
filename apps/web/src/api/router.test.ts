import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { DocMeta, FolderListingResponse, FolderMeta, VaultMeta } from '@glyphdown/protocol'
import type { Db } from '../db/client.ts'

/**
 * Integration tests for the Phase-1 vault invariants on the REAL router
 * (handleApi end to end): the Workers runtime pieces are stubbed — `env` +
 * `waitUntil`, partyserver's getServerByName (recording every DO fetch so
 * recheck fan-outs are assertable), and createDb (better-sqlite3 in place of
 * D1) — while auth runs the genuine agent-key path against the test DB.
 */

const h = vi.hoisted(() => {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>()
  const bucket = {
    async put(key: string, body: ArrayBuffer, opts?: { httpMetadata?: { contentType?: string } }) {
      objects.set(key, { bytes: new Uint8Array(body), contentType: opts?.httpMetadata?.contentType ?? '' })
      return { etag: `etag-${key}` }
    },
    async get(key: string) {
      const o = objects.get(key)
      if (!o) return null
      return { body: o.bytes, size: o.bytes.byteLength, httpEtag: `W/"${key}"` }
    },
    async delete(key: string) {
      objects.delete(key)
    },
  }
  /** Every Worker->DO fetch: which namespace, DO name, path, JSON body, trusted headers. */
  const doCalls: Array<{ ns: string; name: string; path: string; body: unknown; headers: Record<string, string | null> }> = []
  const state = { db: null as unknown as Db }
  return { objects, bucket, doCalls, state }
})

vi.mock('partyserver', async (importOriginal) => ({
  // Partial mock: @glyphdown/sync (imported transitively) needs the real
  // Server class; only the Worker->DO handle is stubbed to record calls.
  ...(await importOriginal<Record<string, unknown>>()),
  getServerByName: async (ns: { __ns: string }, name: string) => ({
    fetch: async (input: Request | string, init?: RequestInit) => {
      const req = typeof input === 'string' ? new Request(input, init) : input
      let body: unknown = null
      try {
        body = await req.clone().json()
      } catch {
        body = null
      }
      const path = new URL(req.url).pathname
      h.doCalls.push({
        ns: ns.__ns,
        name,
        path,
        body,
        headers: {
          principal: req.headers.get('x-glyphdown-principal'),
          role: req.headers.get('x-glyphdown-role'),
          asset: req.headers.get('x-glyphdown-asset'),
          version: req.headers.get('x-glyphdown-asset-version'),
          contentType: req.headers.get('content-type'),
        },
      })
      // One shape serves every stubbed DO: results for SearchDO /search,
      // docIds for SearchDO /backlinks, ok for DocDO admin calls.
      const headers = new Headers({ 'content-type': 'application/json' })
      if (path.endsWith('/replies')) headers.set('x-glyphdown-comment-author', 'alice')
      const replyBody =
        typeof body === 'object' && body !== null && 'body' in body ? (body as { body?: unknown }).body : ''
      const responseBody = path.endsWith('/replies')
        ? { id: 'reply-1', body: replyBody }
        : path === '/comments' && req.method === 'POST'
          ? { id: 'comment-1' }
          : { ok: true, results: [], docIds: [] }
      return new Response(JSON.stringify(responseBody), { headers })
    },
  }),
}))

vi.mock('../db/client.ts', () => ({ createDb: () => h.state.db }))

// The cloudflare:workers import resolves to test/stubs/cloudflare-workers.ts
// (vitest.config.ts alias) — inject the fake bindings into its env object.
import { env as stubEnv } from 'cloudflare:workers'
Object.assign(stubEnv as unknown as Record<string, unknown>, {
  ASSETS: h.bucket,
  DocDO: { __ns: 'DocDO' },
  HtmlDocDO: { __ns: 'HtmlDocDO' },
  SearchDO: { __ns: 'SearchDO' },
})

import { handleApi } from './router.ts'

function setupDb(): Db {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
      email_verified INTEGER NOT NULL DEFAULT 0, image TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE agents (id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, name TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE, scope TEXT NOT NULL DEFAULT 'inherit', created_at INTEGER NOT NULL, revoked_at INTEGER);
    CREATE TABLE folders (id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'folder', parent_id TEXT, created_at INTEGER NOT NULL);
    CREATE UNIQUE INDEX folders_vault_name_unique ON folders (owner_user_id, lower(name)) WHERE kind = 'vault';
    CREATE TABLE docs (id TEXT PRIMARY KEY, title TEXT NOT NULL, filename TEXT NOT NULL DEFAULT '',
      folder_id TEXT, owner_user_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER);
    CREATE UNIQUE INDEX docs_folder_filename_unique ON docs (folder_id, filename) WHERE folder_id IS NOT NULL AND deleted_at IS NULL;
    CREATE UNIQUE INDEX docs_root_filename_unique ON docs (owner_user_id, filename) WHERE folder_id IS NULL AND deleted_at IS NULL;
    CREATE TABLE doc_members (doc_id TEXT NOT NULL, principal_id TEXT NOT NULL, principal_type TEXT NOT NULL,
      role TEXT NOT NULL, added_by TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (doc_id, principal_id));
    CREATE TABLE folder_members (folder_id TEXT NOT NULL, principal_id TEXT NOT NULL, principal_type TEXT NOT NULL,
      role TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (folder_id, principal_id));
    CREATE TABLE share_links (token TEXT PRIMARY KEY, target_type TEXT NOT NULL, target_id TEXT NOT NULL,
      role TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER);
    CREATE TABLE assets (id TEXT PRIMARY KEY, folder_id TEXT, doc_id TEXT, filename TEXT NOT NULL,
      r2_key TEXT NOT NULL, content_type TEXT NOT NULL, size INTEGER NOT NULL, etag TEXT NOT NULL,
      current_version_id TEXT, created_by TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE UNIQUE INDEX assets_folder_filename_idx ON assets (folder_id, filename);
    CREATE UNIQUE INDEX assets_doc_filename_idx ON assets (doc_id, filename);
    CREATE TABLE content_objects (hash TEXT PRIMARY KEY, size INTEGER NOT NULL, refcount INTEGER NOT NULL);
    CREATE TABLE asset_versions (id TEXT PRIMARY KEY, asset_id TEXT NOT NULL, content_hash TEXT NOT NULL,
      size INTEGER NOT NULL, etag TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, message TEXT);
    CREATE INDEX asset_versions_asset_idx ON asset_versions (asset_id);
    CREATE INDEX asset_versions_content_hash_idx ON asset_versions (content_hash);
    CREATE TABLE notifications (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, type TEXT NOT NULL,
      payload_json TEXT NOT NULL, created_at INTEGER NOT NULL, read_at INTEGER);
    CREATE TABLE user_prefs (user_id TEXT PRIMARY KEY, email_notifications INTEGER NOT NULL DEFAULT 1,
      default_vault_id TEXT);
  `)
  const db = drizzle(sqlite) as unknown as Db
  // The better-sqlite3 driver lacks D1's batch — run the queries in order
  // (each drizzle query builder is a thenable).
  ;(db as unknown as { batch: (queries: Array<PromiseLike<unknown>>) => Promise<void> }).batch = async (queries) => {
    for (const q of queries) await q
  }
  ;(db as unknown as { transaction: (fn: (tx: Db) => Promise<unknown>) => Promise<unknown> }).transaction = async (fn) => {
    sqlite.exec('BEGIN')
    try {
      const result = await fn(db)
      sqlite.exec('COMMIT')
      return result
    } catch (err) {
      sqlite.exec('ROLLBACK')
      throw err
    }
  }
  return db
}

let raw: ReturnType<typeof rawDb>
function rawDb(db: Db) {
  // drizzle(better-sqlite3) keeps the client on .$client (typed loosely here).
  return (db as unknown as { $client: InstanceType<typeof Database> }).$client
}

/** Seed a user + a live agent key acting for them; returns auth headers. */
function principalFor(userId: string): Record<string, string> {
  const key = `gd_sk_test-${userId}`
  const keyHash = createHash('sha256').update(key).digest('hex')
  raw.prepare(
    `INSERT OR IGNORE INTO user (id, name, email, email_verified, created_at, updated_at)
     VALUES (?, ?, ?, 1, 1, 1)`,
  ).run(userId, userId, `${userId}@example.com`)
  raw.prepare(
    `INSERT OR IGNORE INTO agents (id, owner_user_id, name, key_hash, created_at)
     VALUES (?, ?, ?, ?, 1)`,
  ).run(`agent-${userId}`, userId, `${userId}'s agent`, keyHash)
  return { authorization: `Bearer ${key}` }
}

function api(path: string, init?: RequestInit & { headers?: Record<string, string> }): Promise<Response | null> {
  return handleApi(new Request(`https://glyphdown.test${path}`, init))
}

function contentKey(text: string): string {
  return `asset-blobs/sha256/${createHash('sha256').update(text).digest('hex')}`
}

async function jsonOf<T>(res: Response | null): Promise<T> {
  expect(res).not.toBeNull()
  return (await res!.json()) as T
}

function seedVault(id: string, owner: string, name = 'Home'): void {
  raw.prepare(`INSERT INTO folders (id, owner_user_id, name, kind, parent_id, created_at) VALUES (?, ?, ?, 'vault', NULL, 1)`).run(id, owner, name)
  raw.prepare(`INSERT INTO user_prefs (user_id, default_vault_id) VALUES (?, ?)
               ON CONFLICT(user_id) DO UPDATE SET default_vault_id = excluded.default_vault_id`).run(owner, id)
}

function seedFolder(id: string, owner: string, parentId: string, name = id): void {
  raw.prepare(`INSERT INTO folders (id, owner_user_id, name, kind, parent_id, created_at) VALUES (?, ?, ?, 'folder', ?, 1)`).run(id, owner, name, parentId)
}

function seedDoc(id: string, owner: string, filename: string, folderId: string | null, deletedAt: number | null = null): void {
  raw.prepare(
    `INSERT INTO docs (id, title, filename, folder_id, owner_user_id, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, 1, 1, ?)`,
  ).run(id, filename.replace(/\.md$/, ''), filename, folderId, owner, deletedAt)
}

beforeEach(() => {
  h.state.db = setupDb()
  raw = rawDb(h.state.db)
  h.doCalls.length = 0
  h.objects.clear()
})

// ---------------------------------------------------------------------------
// createDoc → default vault
// ---------------------------------------------------------------------------

describe('POST /api/docs without folderId', () => {
  it('lands in the owner\'s default vault, minting Home on first use', async () => {
    const headers = principalFor('alice')
    const res = await api('/api/docs', { method: 'POST', headers, body: JSON.stringify({ filename: 'notes.md' }) })
    const meta = await jsonOf<DocMeta>(res)

    const vault = raw.prepare(`SELECT * FROM folders WHERE owner_user_id = 'alice'`).get() as Record<string, unknown>
    expect(vault).toMatchObject({ name: 'Home', kind: 'vault', parent_id: null })
    expect(meta.folderId).toBe(vault.id)
    expect(raw.prepare(`SELECT default_vault_id FROM user_prefs WHERE user_id = 'alice'`).get()).toEqual({
      default_vault_id: vault.id,
    })
  })

  it('reuses the existing default vault (agent caller → the OWNER\'s vault)', async () => {
    const headers = principalFor('alice')
    seedVault('v-home', 'alice')
    const meta = await jsonOf<DocMeta>(
      await api('/api/docs', { method: 'POST', headers, body: JSON.stringify({ filename: 'two.md' }) }),
    )
    expect(meta.folderId).toBe('v-home')
    expect(raw.prepare(`SELECT COUNT(*) AS n FROM folders`).get()).toEqual({ n: 1 })
  })
})

// ---------------------------------------------------------------------------
// patchDoc invariants + move recheck fan-out
// ---------------------------------------------------------------------------

describe('PATCH /api/docs/:id', () => {
  it('rejects folderId: null and \'\' with 400 (no root scope anymore)', async () => {
    const headers = principalFor('alice')
    seedVault('v1', 'alice')
    seedDoc('d1', 'alice', 'a.md', 'v1')
    for (const folderId of [null, '']) {
      const res = await api('/api/docs/d1', { method: 'PATCH', headers, body: JSON.stringify({ folderId }) })
      expect(res!.status).toBe(400)
      expect(await jsonOf<{ error: string }>(res)).toEqual({ error: 'bad-folder' })
    }
    expect(raw.prepare(`SELECT folder_id FROM docs WHERE id = 'd1'`).get()).toEqual({ folder_id: 'v1' })
  })

  it('fans out a recheck to the doc DO for principals granted on the OLD chain', async () => {
    const headers = principalFor('alice')
    seedVault('v1', 'alice')
    seedFolder('f-src', 'alice', 'v1')
    seedFolder('f-dst', 'alice', 'v1')
    seedDoc('d1', 'alice', 'a.md', 'f-src')
    principalFor('bob')
    raw.prepare(`INSERT INTO folder_members (folder_id, principal_id, principal_type, role, created_at) VALUES ('f-src', 'bob', 'user', 'editor', 1)`).run()

    const res = await api('/api/docs/d1', { method: 'PATCH', headers, body: JSON.stringify({ folderId: 'f-dst' }) })
    expect(res!.status).toBe(200)
    expect(raw.prepare(`SELECT folder_id FROM docs WHERE id = 'd1'`).get()).toEqual({ folder_id: 'f-dst' })

    const rechecks = h.doCalls.filter((c) => c.ns === 'DocDO' && c.path === '/admin/recheck')
    expect(rechecks).toHaveLength(1)
    expect(rechecks[0]).toMatchObject({ name: 'd1' })
    const principals = (rechecks[0]!.body as { principalIds: string[] }).principalIds
    expect(principals).toContain('bob')
    expect(principals).toContain('anonymous')
  })

  it('does not recheck when only renaming (no move)', async () => {
    const headers = principalFor('alice')
    seedVault('v1', 'alice')
    seedDoc('d1', 'alice', 'a.md', 'v1')
    const res = await api('/api/docs/d1', { method: 'PATCH', headers, body: JSON.stringify({ filename: 'b.md' }) })
    expect(res!.status).toBe(200)
    expect(h.doCalls.filter((c) => c.path === '/admin/recheck')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Folder route invariants
// ---------------------------------------------------------------------------

describe('folder vault invariants', () => {
  it('POST /api/folders rejects a missing/null parentId', async () => {
    const headers = principalFor('alice')
    for (const body of [{ name: 'X' }, { name: 'X', parentId: null }, { name: 'X', parentId: '' }]) {
      const res = await api('/api/folders', { method: 'POST', headers, body: JSON.stringify(body) })
      expect(res!.status).toBe(400)
      expect(await jsonOf<{ error: string }>(res)).toEqual({ error: 'parent-required' })
    }
  })

  it('POST /api/folders requires the parent chain to end in a vault', async () => {
    const headers = principalFor('alice')
    // A stray pre-backfill root folder (kind='folder', parent NULL).
    raw.prepare(`INSERT INTO folders (id, owner_user_id, name, kind, parent_id, created_at) VALUES ('stray', 'alice', 'Stray', 'folder', NULL, 1)`).run()
    const bad = await api('/api/folders', { method: 'POST', headers, body: JSON.stringify({ name: 'X', parentId: 'stray' }) })
    expect(bad!.status).toBe(400)
    expect(await jsonOf<{ error: string }>(bad)).toEqual({ error: 'vault-required' })

    seedVault('v1', 'alice')
    const ok = await api('/api/folders', { method: 'POST', headers, body: JSON.stringify({ name: 'X', parentId: 'v1' }) })
    const meta = await jsonOf<FolderMeta>(ok)
    expect(ok!.status).toBe(200)
    expect(meta).toMatchObject({ name: 'X', kind: 'folder', parentId: 'v1' })
  })

  it('PATCH /api/folders/:id refuses to move a vault at all', async () => {
    const headers = principalFor('alice')
    seedVault('v1', 'alice')
    seedVault('v2', 'alice', 'Work')
    seedFolder('f1', 'alice', 'v2')
    for (const parentId of ['f1', null]) {
      const res = await api('/api/folders/v1', { method: 'PATCH', headers, body: JSON.stringify({ parentId }) })
      expect(res!.status).toBe(400)
      expect(await jsonOf<{ error: string }>(res)).toEqual({ error: 'vault-immovable' })
    }
  })

  it('PATCH /api/folders/:id refuses parentId null on a plain folder (no new roots)', async () => {
    const headers = principalFor('alice')
    seedVault('v1', 'alice')
    seedFolder('f1', 'alice', 'v1')
    const res = await api('/api/folders/f1', { method: 'PATCH', headers, body: JSON.stringify({ parentId: null }) })
    expect(res!.status).toBe(400)
    expect(await jsonOf<{ error: string }>(res)).toEqual({ error: 'vault-required' })
  })

  it('DELETE /api/folders/:id refuses vaults (promote-to-root would break the invariant)', async () => {
    const headers = principalFor('alice')
    seedVault('v1', 'alice')
    seedFolder('f1', 'alice', 'v1')
    seedDoc('d1', 'alice', 'a.md', 'f1')
    const res = await api('/api/folders/v1', { method: 'DELETE', headers })
    expect(res!.status).toBe(400)
    expect(await jsonOf<{ error: string }>(res)).toEqual({ error: 'vault-undeletable' })
    // Plain folder deletes still promote into the vault.
    const ok = await api('/api/folders/f1', { method: 'DELETE', headers })
    expect(ok!.status).toBe(200)
    expect(raw.prepare(`SELECT folder_id FROM docs WHERE id = 'd1'`).get()).toEqual({ folder_id: 'v1' })
  })

  it('still allows legal folder moves (vault → vault is just a re-parent)', async () => {
    const headers = principalFor('alice')
    seedVault('v1', 'alice')
    seedVault('v2', 'alice', 'Work')
    seedFolder('f1', 'alice', 'v1')
    const res = await api('/api/folders/f1', { method: 'PATCH', headers, body: JSON.stringify({ parentId: 'v2' }) })
    expect(res!.status).toBe(200)
    expect(raw.prepare(`SELECT parent_id FROM folders WHERE id = 'f1'`).get()).toEqual({ parent_id: 'v2' })
  })

  it('rejects a vault rename colliding case-insensitively with another vault (409)', async () => {
    const headers = principalFor('alice')
    seedVault('v1', 'alice')
    seedVault('v2', 'alice', 'Work')
    const res = await api('/api/folders/v2', { method: 'PATCH', headers, body: JSON.stringify({ name: 'home' }) })
    expect(res!.status).toBe(409)
    expect(await jsonOf<{ error: string }>(res)).toEqual({ error: 'name-taken' })
    // Same-vault case-only rename stays allowed.
    const ok = await api('/api/folders/v2', { method: 'PATCH', headers, body: JSON.stringify({ name: 'work' }) })
    expect(ok!.status).toBe(200)
  })

  it('GET /api/folders returns kind on every row', async () => {
    const headers = principalFor('alice')
    seedVault('v1', 'alice')
    seedFolder('f1', 'alice', 'v1')
    const { folders: list } = await jsonOf<{ folders: FolderMeta[] }>(await api('/api/folders', { headers }))
    expect(new Map(list.map((f) => [f.id, f.kind]))).toEqual(new Map([['v1', 'vault'], ['f1', 'folder']]))
  })
})

// ---------------------------------------------------------------------------
// Folder assets: inherited grants
// ---------------------------------------------------------------------------

describe('GET /api/folders/:id/assets with an inherited grant', () => {
  it('lets a vault-root member list and stream subfolder assets', async () => {
    principalFor('alice')
    const bob = principalFor('bob')
    seedVault('v1', 'alice')
    seedFolder('sub', 'alice', 'v1')
    raw.prepare(`INSERT INTO folder_members (folder_id, principal_id, principal_type, role, created_at) VALUES ('v1', 'bob', 'user', 'viewer', 1)`).run()
    raw.prepare(`INSERT INTO assets (id, folder_id, doc_id, filename, r2_key, content_type, size, etag, created_by, created_at)
                 VALUES ('a1', 'sub', NULL, 'pic.png', 'folder/sub/pic.png', 'image/png', 3, 'e1', 'alice', 1)`).run()
    h.objects.set('folder/sub/pic.png', { bytes: new Uint8Array([1, 2, 3]), contentType: 'image/png' })

    const list = await api('/api/folders/sub/assets', { headers: bob })
    expect(list!.status).toBe(200)
    expect(await jsonOf<{ assets: Array<{ filename: string }> }>(list)).toMatchObject({
      assets: [{ filename: 'pic.png' }],
    })
    const stream = await api('/api/folders/sub/assets/pic.png', { headers: bob })
    expect(stream!.status).toBe(200)

    // Strangers still see nothing.
    const mallory = principalFor('mallory')
    expect((await api('/api/folders/sub/assets', { headers: mallory }))!.status).toBe(404)
  })

  it('lets anonymous folder-share viewers list and stream html assets', async () => {
    principalFor('alice')
    seedVault('v1', 'alice')
    seedFolder('sub', 'alice', 'v1')
    seedShareLink('tok-v1', 'folder', 'v1')
    raw.prepare(`INSERT INTO assets (id, folder_id, doc_id, filename, r2_key, content_type, size, etag, created_by, created_at)
                 VALUES ('a-html', 'sub', NULL, 'page.html', 'folder/sub/page.html', 'text/html', 15, 'e-html', 'alice', 1)`).run()
    h.objects.set('folder/sub/page.html', { bytes: new TextEncoder().encode('<!doctype html>'), contentType: 'text/html' })

    const list = await api('/api/folders/sub/assets', { headers: { 'x-glyphdown-share': 'tok-v1' } })
    expect(list!.status).toBe(200)
    expect(await jsonOf<{ assets: Array<{ filename: string; contentType: string }> }>(list)).toMatchObject({
      assets: [{ filename: 'page.html', contentType: 'text/html' }],
    })

    const stream = await api('/api/folders/sub/assets/page.html?share=tok-v1')
    expect(stream!.status).toBe(200)
    expect(stream!.headers.get('content-type')).toBe('text/html')
    expect(stream!.headers.get('content-security-policy')).toBe('sandbox allow-scripts')
    expect(stream!.headers.get('x-content-type-options')).toBe('nosniff')
    expect(new TextDecoder().decode(await stream!.arrayBuffer())).toBe('<!doctype html>')
  })

  it('serves the injected commenting view to share callers via header-only token delivery', async () => {
    principalFor('alice')
    seedVault('v1', 'alice')
    seedFolder('sub', 'alice', 'v1')
    seedShareLink('tok-v1', 'folder', 'v1')
    raw.prepare(`INSERT INTO assets (id, folder_id, doc_id, filename, r2_key, content_type, size, etag, created_by, created_at)
                 VALUES ('a-html', 'sub', NULL, 'page.html', 'folder/sub/page.html', 'text/html', 15, 'e-html', 'alice', 1)`).run()
    h.objects.set('folder/sub/page.html', { bytes: new TextEncoder().encode('<!doctype html><h1>Report</h1>'), contentType: 'text/html' })

    const res = await api('/api/folders/sub/assets/page.html/commenting-view', {
      headers: { 'x-glyphdown-share': 'tok-v1' },
    })
    expect(res!.status).toBe(200)
    expect(res!.headers.get('content-security-policy')).toBe('sandbox allow-scripts')
    expect(res!.headers.get('cache-control')).toBe('private, no-store')
    expect(res!.headers.get('x-glyphdown-view-nonce')).toMatch(/^[a-f0-9]{32}$/)
    const html = await res!.text()
    expect(html).toContain('data-glyphdown-runtime')
    expect(html).toContain('<base href="/api/folders/sub/assets/page.html">')
    expect(html).toContain('<h1>Report</h1>')
    expect(html).not.toContain('tok-v1')
    expect(html).not.toContain('share=')
  })

  it('rejects missing, invalid, and revoked anonymous share tokens for folder assets', async () => {
    principalFor('alice')
    seedVault('v1', 'alice')
    seedFolder('sub', 'alice', 'v1')
    seedShareLink('tok-dead', 'folder', 'v1', 'viewer', 999)
    raw.prepare(`INSERT INTO assets (id, folder_id, doc_id, filename, r2_key, content_type, size, etag, created_by, created_at)
                 VALUES ('a-html', 'sub', NULL, 'page.html', 'folder/sub/page.html', 'text/html', 15, 'e-html', 'alice', 1)`).run()
    h.objects.set('folder/sub/page.html', { bytes: new TextEncoder().encode('<!doctype html>'), contentType: 'text/html' })

    expect((await api('/api/folders/sub/assets/page.html'))!.status).toBe(401)
    expect((await api('/api/folders/sub/assets/page.html?share=missing'))!.status).toBe(404)
    expect((await api('/api/folders/sub/assets/page.html?share=tok-dead'))!.status).toBe(404)
  })

  it('does not let anonymous share-token callers mutate folder assets', async () => {
    principalFor('alice')
    seedVault('v1', 'alice')
    seedFolder('sub', 'alice', 'v1')
    seedShareLink('tok-v1', 'folder', 'v1')
    raw.prepare(`INSERT INTO assets (id, folder_id, doc_id, filename, r2_key, content_type, size, etag, created_by, created_at)
                 VALUES ('a-html', 'sub', NULL, 'page.html', 'folder/sub/page.html', 'text/html', 15, 'e-html', 'alice', 1)`).run()
    h.objects.set('folder/sub/page.html', { bytes: new TextEncoder().encode('<!doctype html>'), contentType: 'text/html' })

    const post = await api('/api/folders/sub/assets?filename=new.html&share=tok-v1', {
      method: 'POST',
      headers: { 'content-type': 'text/html' },
      body: '<!doctype html>',
    })
    expect(post!.status).toBe(401)
    expect((await api('/api/folders/sub/assets/page.html?share=tok-v1', { method: 'DELETE' }))!.status).toBe(401)
  })
})

describe('POST /api/folders/:id/assets', () => {
  it('uploads html for inherited editor+ roles and forbids viewers', async () => {
    principalFor('alice')
    const bob = principalFor('bob')
    const eve = principalFor('eve')
    seedVault('v1', 'alice')
    seedFolder('sub', 'alice', 'v1')
    raw.prepare(`INSERT INTO folder_members (folder_id, principal_id, principal_type, role, created_at) VALUES ('v1', 'bob', 'user', 'viewer', 1)`).run()
    raw.prepare(`INSERT INTO folder_members (folder_id, principal_id, principal_type, role, created_at) VALUES ('v1', 'eve', 'user', 'editor', 1)`).run()

    const denied = await api('/api/folders/sub/assets?filename=viewer.html', {
      method: 'POST',
      headers: { ...bob, 'content-type': 'text/html' },
      body: '<!doctype html>',
    })
    expect(denied!.status).toBe(403)

    const uploaded = await api('/api/folders/sub/assets?filename=Page.HTML', {
      method: 'POST',
      headers: { ...eve, 'content-type': 'text/html; charset=utf-8' },
      body: '<!doctype html>',
    })
    expect(uploaded!.status).toBe(200)
    const body = await jsonOf<{ asset: { id: string; filename: string; contentType: string }; path: string }>(uploaded)
    expect(body).toMatchObject({
      asset: { filename: 'page.html', contentType: 'text/html' },
      path: 'page.html',
    })
    expect(h.objects.has(contentKey('<!doctype html>'))).toBe(true)
    const contentRefresh = h.doCalls.find((c) => c.ns === 'HtmlDocDO' && c.path === '/admin/content')
    expect(contentRefresh).toMatchObject({
      ns: 'HtmlDocDO',
      name: body.asset.id,
      path: '/admin/content',
      body: {
        etag: `etag-${contentKey('<!doctype html>')}`,
        contentHash: createHash('sha256').update('<!doctype html>').digest('hex'),
        html: '<!doctype html>',
      },
      headers: { role: 'editor', asset: body.asset.id, contentType: 'application/json' },
    })
  })
})

// ---------------------------------------------------------------------------
// Asset read fallback (legacy doc-scoped rows after re-homing)
// ---------------------------------------------------------------------------

describe('asset folder→doc read fallback', () => {
  function seedLegacyAsset(docId: string, filename: string, bytes: number[]): void {
    raw.prepare(`INSERT INTO assets (id, folder_id, doc_id, filename, r2_key, content_type, size, etag, created_by, created_at)
                 VALUES (?, NULL, ?, ?, ?, 'image/png', ?, 'e', 'alice', 1)`).run(`asset-${docId}-${filename}`, docId, filename, `doc/${docId}/${filename}`, bytes.length)
    h.objects.set(`doc/${docId}/${filename}`, { bytes: new Uint8Array(bytes), contentType: 'image/png' })
  }

  it('serves a re-homed doc\'s legacy doc-scoped asset on the doc surface', async () => {
    const headers = principalFor('alice')
    seedVault('v1', 'alice')
    seedDoc('d1', 'alice', 'a.md', 'v1') // re-homed: folder-scoped lookups miss
    seedLegacyAsset('d1', 'pic.png', [7])

    const res = await api('/api/docs/d1/assets/pic.png', { headers })
    expect(res!.status).toBe(200)
    expect(new Uint8Array(await res!.arrayBuffer())).toEqual(new Uint8Array([7]))
    const list = await jsonOf<{ assets: Array<{ filename: string }> }>(await api('/api/docs/d1/assets', { headers }))
    expect(list.assets.map((a) => a.filename)).toEqual(['pic.png'])
  })

  it('folder-scope hit wins over the legacy row', async () => {
    const headers = principalFor('alice')
    seedVault('v1', 'alice')
    seedDoc('d1', 'alice', 'a.md', 'v1')
    seedLegacyAsset('d1', 'pic.png', [7])
    raw.prepare(`INSERT INTO assets (id, folder_id, doc_id, filename, r2_key, content_type, size, etag, created_by, created_at)
                 VALUES ('a-folder', 'v1', NULL, 'pic.png', 'folder/v1/pic.png', 'image/png', 1, 'e2', 'alice', 2)`).run()
    h.objects.set('folder/v1/pic.png', { bytes: new Uint8Array([9]), contentType: 'image/png' })

    const res = await api('/api/docs/d1/assets/pic.png', { headers })
    expect(new Uint8Array(await res!.arrayBuffer())).toEqual(new Uint8Array([9]))
    // Merged listing dedupes by filename with the folder row winning.
    const list = await jsonOf<{ assets: Array<{ filename: string; etag: string }> }>(
      await api('/api/docs/d1/assets', { headers }),
    )
    expect(list.assets).toEqual([expect.objectContaining({ filename: 'pic.png', etag: 'e2' })])
  })

  it('resolves legacy rows on the folder surface too (CLI sync listing)', async () => {
    const headers = principalFor('alice')
    seedVault('v1', 'alice')
    seedDoc('d1', 'alice', 'a.md', 'v1')
    seedDoc('d-trash', 'alice', 'gone.md', 'v1', 999) // trashed docs contribute nothing
    seedLegacyAsset('d1', 'pic.png', [7])
    seedLegacyAsset('d-trash', 'ghost.png', [8])

    const list = await jsonOf<{ assets: Array<{ filename: string }> }>(await api('/api/folders/v1/assets', { headers }))
    expect(list.assets.map((a) => a.filename)).toEqual(['pic.png'])
    const res = await api('/api/folders/v1/assets/pic.png', { headers })
    expect(res!.status).toBe(200)
    expect(new Uint8Array(await res!.arrayBuffer())).toEqual(new Uint8Array([7]))
  })

  it('does not leak another folder\'s doc-scoped rows', async () => {
    const headers = principalFor('alice')
    seedVault('v1', 'alice')
    seedFolder('other', 'alice', 'v1')
    seedDoc('d-other', 'alice', 'b.md', 'other')
    seedLegacyAsset('d-other', 'pic.png', [7])
    expect((await api('/api/folders/v1/assets/pic.png', { headers }))!.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// HTML asset comments (filename-addressed route → HtmlDocDO by asset id)
// ---------------------------------------------------------------------------

function seedHtmlAsset(
  id: string,
  folderId: string | null,
  docId: string | null,
  filename = 'page.html',
  currentVersionId: string | null = null,
): void {
  raw.prepare(
    `INSERT INTO assets (id, folder_id, doc_id, filename, r2_key, content_type, size, etag, current_version_id, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, 'text/html', 15, 'e-html', ?, 'alice', 1)`,
  ).run(id, folderId, docId, filename, folderId ? `folder/${folderId}/${filename}` : `doc/${docId}/${filename}`, currentVersionId)
}

describe('HTML asset comment routes', () => {
  it('forwards folder asset comments to HtmlDocDO by immutable asset id with trusted headers', async () => {
    principalFor('alice')
    const bob = principalFor('bob')
    seedVault('v1', 'alice')
    seedFolder('sub', 'alice', 'v1')
    grantFolder('v1', 'bob', 'commenter')
    seedHtmlAsset('a-html', 'sub', null)

    const res = await api('/api/folders/sub/assets/page.html/comments', {
      method: 'POST',
      headers: { ...bob, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'Looks good' }),
    })
    expect(res!.status).toBe(200)

    const call = h.doCalls.find((c) => c.ns === 'HtmlDocDO')
    expect(call).toMatchObject({
      ns: 'HtmlDocDO',
      name: 'a-html',
      path: '/comments',
      body: { body: 'Looks good' },
      headers: { role: 'commenter', asset: 'a-html', contentType: 'application/json' },
    })
    expect(JSON.parse(call!.headers.principal!)).toMatchObject({ id: 'agent-bob', ownerUserId: 'bob' })
  })

  it('forwards the current asset version id when creating asset comments', async () => {
    principalFor('alice')
    const bob = principalFor('bob')
    seedVault('v1', 'alice')
    seedFolder('sub', 'alice', 'v1')
    grantFolder('v1', 'bob', 'commenter')
    seedHtmlAsset('a-html', 'sub', null, 'page.html', 'version-current')

    const res = await api('/api/folders/sub/assets/page.html/comments', {
      method: 'POST',
      headers: { ...bob, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'Versioned comment' }),
    })
    expect(res!.status).toBe(200)
    expect(h.doCalls.at(-1)).toMatchObject({
      ns: 'HtmlDocDO',
      name: 'a-html',
      path: '/comments',
      headers: { asset: 'a-html', version: 'version-current' },
    })
  })

  it('lets signed-in folder-share commenters write but rejects anonymous writes', async () => {
    principalFor('alice')
    const bob = principalFor('bob')
    seedVault('v1', 'alice')
    seedFolder('sub', 'alice', 'v1')
    seedShareLink('tok-comment', 'folder', 'v1', 'commenter')
    seedHtmlAsset('a-html', 'sub', null)

    const signedIn = await api('/api/folders/sub/assets/page.html/comments?share=tok-comment', {
      method: 'POST',
      headers: { ...bob, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'link-authorized' }),
    })
    expect(signedIn!.status).toBe(200)
    expect(h.doCalls.at(-1)).toMatchObject({ ns: 'HtmlDocDO', name: 'a-html', path: '/comments' })
    expect(h.doCalls.at(-1)!.headers.role).toBe('commenter')

    const anonymous = await api('/api/folders/sub/assets/page.html/comments?share=tok-comment', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'anonymous' }),
    })
    expect(anonymous!.status).toBe(401)
  })

  it('allows anonymous viewer share links to read folder asset comments', async () => {
    principalFor('alice')
    seedVault('v1', 'alice')
    seedFolder('sub', 'alice', 'v1')
    seedShareLink('tok-view', 'folder', 'v1', 'viewer')
    seedHtmlAsset('a-html', 'sub', null)

    const res = await api('/api/folders/sub/assets/page.html/comments?share=tok-view')
    expect(res!.status).toBe(200)
    expect(h.doCalls.at(-1)).toMatchObject({ ns: 'HtmlDocDO', name: 'a-html', path: '/comments' })
    expect(h.doCalls.at(-1)!.headers.role).toBe('viewer')
    expect(JSON.parse(h.doCalls.at(-1)!.headers.principal!)).toMatchObject({ id: 'anonymous' })
  })

  it('resolves legacy doc-scoped asset rows through the doc comments surface', async () => {
    const alice = principalFor('alice')
    seedVault('v1', 'alice')
    seedDoc('d1', 'alice', 'a.md', 'v1')
    seedHtmlAsset('a-legacy', null, 'd1')

    const res = await api('/api/docs/d1/assets/page.html/comments', { headers: alice })
    expect(res!.status).toBe(200)
    expect(h.doCalls.at(-1)).toMatchObject({ ns: 'HtmlDocDO', name: 'a-legacy', path: '/comments' })
    expect(h.doCalls.at(-1)!.headers.asset).toBe('a-legacy')
  })

  it('writes asset-targeted mention and reply notifications', async () => {
    principalFor('alice')
    const bob = principalFor('bob')
    seedVault('v1', 'alice')
    raw.prepare(`UPDATE user_prefs SET email_notifications = 0 WHERE user_id = 'alice'`).run()
    seedFolder('sub', 'alice', 'v1')
    grantFolder('v1', 'bob', 'commenter')
    seedHtmlAsset('a-html', 'sub', null)

    const mentioned = await api('/api/folders/sub/assets/page.html/comments', {
      method: 'POST',
      headers: { ...bob, 'content-type': 'application/json' },
      body: JSON.stringify({ body: '@[alice] please check' }),
    })
    expect(mentioned!.status).toBe(200)

    const replied = await api('/api/folders/sub/assets/page.html/comments/c1/replies', {
      method: 'POST',
      headers: { ...bob, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'replying' }),
    })
    expect(replied!.status).toBe(200)

    const rows = raw.prepare(`SELECT type, payload_json FROM notifications WHERE user_id = 'alice' ORDER BY rowid`).all() as Array<{
      type: string
      payload_json: string
    }>
    expect(rows.map((row) => row.type)).toEqual(['mention', 'comment-reply'])
    expect(JSON.parse(rows[0]!.payload_json)).toMatchObject({
      assetId: 'a-html',
      assetTitle: 'page.html',
      folderId: 'sub',
      filename: 'page.html',
      deepLink: '/f/sub/file/page.html',
      commentId: 'comment-1',
      by: 'agent-bob',
    })
    expect(JSON.parse(rows[1]!.payload_json)).toMatchObject({
      assetId: 'a-html',
      commentId: 'reply-1',
      excerpt: 'replying',
    })
  })
})

// ---------------------------------------------------------------------------
// POST /api/docs/:id/restore
// ---------------------------------------------------------------------------

describe('POST /api/docs/:id/restore', () => {
  it('restores in place when the folder still exists', async () => {
    const headers = principalFor('alice')
    seedVault('v1', 'alice')
    seedDoc('d1', 'alice', 'a.md', 'v1', 999)
    const meta = await jsonOf<DocMeta>(await api('/api/docs/d1/restore', { method: 'POST', headers }))
    expect(meta).toMatchObject({ id: 'd1', folderId: 'v1', filename: 'a.md' })
    expect(raw.prepare(`SELECT deleted_at FROM docs WHERE id = 'd1'`).get()).toEqual({ deleted_at: null })
  })

  it('re-homes a folderless (pre-vault trash) doc into the default vault', async () => {
    const headers = principalFor('alice')
    seedVault('v1', 'alice')
    seedDoc('d1', 'alice', 'a.md', null, 999)
    const meta = await jsonOf<DocMeta>(await api('/api/docs/d1/restore', { method: 'POST', headers }))
    expect(meta.folderId).toBe('v1')
  })

  it('re-homes when the folder row no longer exists, minting the vault if needed', async () => {
    const headers = principalFor('alice')
    seedDoc('d1', 'alice', 'a.md', 'gone-folder', 999)
    const meta = await jsonOf<DocMeta>(await api('/api/docs/d1/restore', { method: 'POST', headers }))
    const vault = raw.prepare(`SELECT id, name, kind FROM folders`).get() as Record<string, unknown>
    expect(vault).toMatchObject({ name: 'Home', kind: 'vault' })
    expect(meta.folderId).toBe(vault.id)
  })

  it('suffixes the filename when the target scope already has it', async () => {
    const headers = principalFor('alice')
    seedVault('v1', 'alice')
    seedDoc('d-live', 'alice', 'notes.md', 'v1')
    seedDoc('d-trash', 'alice', 'notes.md', null, 999)
    const meta = await jsonOf<DocMeta>(await api('/api/docs/d-trash/restore', { method: 'POST', headers }))
    expect(meta).toMatchObject({ folderId: 'v1', filename: 'notes-2.md', title: 'notes-2' })
  })

  it('is owner-only and 409s on a live doc', async () => {
    const headers = principalFor('alice')
    const bob = principalFor('bob')
    seedVault('v1', 'alice')
    seedDoc('d1', 'alice', 'a.md', 'v1', 999)
    raw.prepare(`INSERT INTO doc_members (doc_id, principal_id, principal_type, role, added_by, created_at) VALUES ('d1', 'bob', 'user', 'editor', 'alice', 1)`).run()
    expect((await api('/api/docs/d1/restore', { method: 'POST', headers: bob }))!.status).toBe(404)

    seedDoc('d-live', 'alice', 'b.md', 'v1')
    expect((await api('/api/docs/d-live/restore', { method: 'POST', headers }))!.status).toBe(409)
  })
})

// ---------------------------------------------------------------------------
// /api/vaults (Phase 2)
// ---------------------------------------------------------------------------

function grantFolder(folderId: string, principalId: string, role: string): void {
  raw.prepare(
    `INSERT INTO folder_members (folder_id, principal_id, principal_type, role, created_at) VALUES (?, ?, 'user', ?, 1)`,
  ).run(folderId, principalId, role)
}

function setDefaultVault(userId: string, vaultId: string): void {
  raw.prepare(`INSERT INTO user_prefs (user_id, default_vault_id) VALUES (?, ?)
               ON CONFLICT(user_id) DO UPDATE SET default_vault_id = excluded.default_vault_id`).run(userId, vaultId)
}

describe('GET /api/vaults', () => {
  it('lists owned vaults oldest-first plus directly granted vaults with the effective role', async () => {
    const headers = principalFor('alice')
    principalFor('carol')
    raw.prepare(`INSERT INTO folders (id, owner_user_id, name, kind, parent_id, created_at) VALUES
      ('v-work', 'alice', 'Work', 'vault', NULL, 2),
      ('v-home', 'alice', 'Home', 'vault', NULL, 1),
      ('v-carol', 'carol', 'Shared', 'vault', NULL, 5),
      ('f-sub', 'alice', 'Sub', 'folder', 'v-home', 3)`).run()
    grantFolder('v-carol', 'alice', 'editor')

    const { vaults } = await jsonOf<{ vaults: VaultMeta[] }>(await api('/api/vaults', { headers }))
    expect(vaults.map((v) => [v.id, v.role])).toEqual([
      ['v-home', 'owner'],
      ['v-work', 'owner'],
      ['v-carol', 'editor'],
    ])
    // Plain folders never leak into the vault list.
    expect(vaults.some((v) => v.id === 'f-sub')).toBe(false)
  })

  it('a grant on a SUBFOLDER does not surface its vault (direct grants only)', async () => {
    principalFor('alice')
    const bob = principalFor('bob')
    seedVault('v1', 'alice')
    seedFolder('f1', 'alice', 'v1')
    grantFolder('f1', 'bob', 'viewer')
    const { vaults } = await jsonOf<{ vaults: VaultMeta[] }>(await api('/api/vaults', { headers: bob }))
    expect(vaults).toEqual([])
  })
})

describe('POST /api/vaults', () => {
  it('creates a root folder row with kind=vault', async () => {
    const headers = principalFor('alice')
    const meta = await jsonOf<VaultMeta>(
      await api('/api/vaults', { method: 'POST', headers, body: JSON.stringify({ name: 'Research' }) }),
    )
    expect(meta).toMatchObject({ name: 'Research', ownerUserId: 'alice', role: 'owner' })
    expect(raw.prepare(`SELECT kind, parent_id FROM folders WHERE id = ?`).get(meta.id)).toEqual({
      kind: 'vault',
      parent_id: null,
    })
  })

  it('409s name-taken on a case-insensitive collision per owner; other owners are unaffected', async () => {
    const headers = principalFor('alice')
    seedVault('v1', 'alice', 'Research')
    const res = await api('/api/vaults', { method: 'POST', headers, body: JSON.stringify({ name: 'research' }) })
    expect(res!.status).toBe(409)
    expect(await jsonOf<{ error: string }>(res)).toEqual({ error: 'name-taken' })

    const bob = principalFor('bob')
    expect((await api('/api/vaults', { method: 'POST', headers: bob, body: JSON.stringify({ name: 'Research' }) }))!.status).toBe(200)
  })

  it('400s on a missing/blank name', async () => {
    const headers = principalFor('alice')
    for (const body of [{}, { name: '' }, { name: '   ' }]) {
      const res = await api('/api/vaults', { method: 'POST', headers, body: JSON.stringify(body) })
      expect(res!.status).toBe(400)
      expect(await jsonOf<{ error: string }>(res)).toEqual({ error: 'bad-name' })
    }
  })
})

describe('PATCH /api/vaults/:id', () => {
  it('renames (owner-only) with the same case-insensitive 409 guard', async () => {
    const headers = principalFor('alice')
    seedVault('v1', 'alice')
    seedVault('v2', 'alice', 'Work')
    const ok = await api('/api/vaults/v2', { method: 'PATCH', headers, body: JSON.stringify({ name: 'Projects' }) })
    expect(await jsonOf<VaultMeta>(ok)).toMatchObject({ id: 'v2', name: 'Projects' })

    const clash = await api('/api/vaults/v2', { method: 'PATCH', headers, body: JSON.stringify({ name: 'home' }) })
    expect(clash!.status).toBe(409)
    expect(await jsonOf<{ error: string }>(clash)).toEqual({ error: 'name-taken' })

    // Case-only self-rename stays allowed.
    expect((await api('/api/vaults/v2', { method: 'PATCH', headers, body: JSON.stringify({ name: 'projects' }) }))!.status).toBe(200)
  })

  it('rejects moves, non-owners, and non-vault ids', async () => {
    const headers = principalFor('alice')
    const bob = principalFor('bob')
    seedVault('v1', 'alice')
    seedFolder('f1', 'alice', 'v1')
    grantFolder('v1', 'bob', 'editor')

    const move = await api('/api/vaults/v1', { method: 'PATCH', headers, body: JSON.stringify({ name: 'X', parentId: 'f1' }) })
    expect(move!.status).toBe(400)
    expect(await jsonOf<{ error: string }>(move)).toEqual({ error: 'vault-immovable' })

    // Members (even editors) cannot rename — owner-only like folder PATCH.
    expect((await api('/api/vaults/v1', { method: 'PATCH', headers: bob, body: JSON.stringify({ name: 'Mine' }) }))!.status).toBe(403)
    // A plain folder is not addressable through the vault routes.
    expect((await api('/api/vaults/f1', { method: 'PATCH', headers, body: JSON.stringify({ name: 'X' }) }))!.status).toBe(404)
  })
})

describe('DELETE /api/vaults/:id', () => {
  it('blocks the last vault and the default vault with distinct codes', async () => {
    const headers = principalFor('alice')
    seedVault('v1', 'alice')
    const last = await api('/api/vaults/v1', { method: 'DELETE', headers })
    expect(last!.status).toBe(400)
    expect(await jsonOf<{ error: string }>(last)).toEqual({ error: 'last-vault' })

    seedVault('v2', 'alice', 'Work')
    setDefaultVault('alice', 'v1')
    const dflt = await api('/api/vaults/v1', { method: 'DELETE', headers })
    expect(dflt!.status).toBe(400)
    expect(await jsonOf<{ error: string }>(dflt)).toEqual({ error: 'default-vault' })
  })

  it('is owner-only (members cannot delete)', async () => {
    principalFor('alice')
    const bob = principalFor('bob')
    seedVault('v1', 'alice')
    seedVault('v2', 'alice', 'Work')
    setDefaultVault('alice', 'v1')
    grantFolder('v2', 'bob', 'editor')
    expect((await api('/api/vaults/v2', { method: 'DELETE', headers: bob }))!.status).toBe(403)
  })

  it('soft-deletes the entire doc subtree, hard-deletes the folder rows, and tears down each doc DO', async () => {
    const headers = principalFor('alice')
    seedVault('v1', 'alice')
    seedVault('v2', 'alice', 'Work')
    setDefaultVault('alice', 'v1')
    seedFolder('f1', 'alice', 'v2')
    seedFolder('f2', 'alice', 'f1')
    seedDoc('d-top', 'alice', 'top.md', 'v2')
    seedDoc('d-deep', 'alice', 'deep.md', 'f2')
    seedDoc('d-trashed', 'alice', 'old.md', 'f1', 777) // already in the trash
    seedDoc('d-other', 'alice', 'other.md', 'v1') // a different vault — untouched
    grantFolder('v2', 'bob', 'editor')

    const res = await api('/api/vaults/v2', { method: 'DELETE', headers })
    expect(res!.status).toBe(200)

    // Docs: every live doc in the closure is trashed; pre-trashed keeps its
    // original deleted_at; other vaults are untouched.
    const deletedAt = (id: string) => (raw.prepare(`SELECT deleted_at FROM docs WHERE id = ?`).get(id) as { deleted_at: number | null }).deleted_at
    expect(deletedAt('d-top')).not.toBeNull()
    expect(deletedAt('d-deep')).not.toBeNull()
    expect(deletedAt('d-trashed')).toBe(777)
    expect(deletedAt('d-other')).toBeNull()

    // Folders: the whole subtree is gone, grants included.
    expect(raw.prepare(`SELECT COUNT(*) AS n FROM folders WHERE id IN ('v2','f1','f2')`).get()).toEqual({ n: 0 })
    expect(raw.prepare(`SELECT COUNT(*) AS n FROM folder_members WHERE folder_id = 'v2'`).get()).toEqual({ n: 0 })
    expect(raw.prepare(`SELECT COUNT(*) AS n FROM folders WHERE id = 'v1'`).get()).toEqual({ n: 1 })

    // Each live doc's DO was told doc-deleted (closes every connection,
    // members included) — exactly like a single-doc delete.
    const teardowns = h.doCalls.filter((c) => c.ns === 'DocDO' && c.path === '/admin/doc-deleted')
    expect(teardowns.map((c) => c.name).sort()).toEqual(['d-deep', 'd-top'])
  })

  it('restore after a vault delete re-homes the doc into the default vault', async () => {
    const headers = principalFor('alice')
    seedVault('v1', 'alice')
    seedVault('v2', 'alice', 'Work')
    setDefaultVault('alice', 'v1')
    seedDoc('d1', 'alice', 'notes.md', 'v2')
    seedDoc('d-clash', 'alice', 'notes.md', 'v1') // forces suffixing on restore

    expect((await api('/api/vaults/v2', { method: 'DELETE', headers }))!.status).toBe(200)
    const meta = await jsonOf<DocMeta>(await api('/api/docs/d1/restore', { method: 'POST', headers }))
    expect(meta).toMatchObject({ folderId: 'v1', filename: 'notes-2.md' })
    expect(raw.prepare(`SELECT deleted_at FROM docs WHERE id = 'd1'`).get()).toEqual({ deleted_at: null })
  })
})

// ---------------------------------------------------------------------------
// Folder share-link landing surface (GET /api/folders/:id/listing) + folder
// tokens on the doc routes
// ---------------------------------------------------------------------------

function seedShareLink(
  token: string,
  targetType: 'doc' | 'folder' | 'asset',
  targetId: string,
  role = 'viewer',
  revokedAt: number | null = null,
): void {
  raw.prepare(
    `INSERT INTO share_links (token, target_type, target_id, role, created_by, created_at, revoked_at)
     VALUES (?, ?, ?, ?, 'alice', 1, ?)`,
  ).run(token, targetType, targetId, role, revokedAt)
}

type Listing = FolderListingResponse

/** alice's two vaults: v1 (sub + two docs) and a sibling v2 (one doc). */
function seedSharedTree(): void {
  principalFor('alice')
  seedVault('v1', 'alice')
  seedVault('v2', 'alice', 'Work')
  seedFolder('sub', 'alice', 'v1', 'Research')
  seedDoc('d-a', 'alice', 'alpha.md', 'v1')
  seedDoc('d-b', 'alice', 'beta.md', 'sub')
  seedDoc('d-c', 'alice', 'gamma.md', 'v2')
}

describe('GET /api/folders/:id/listing', () => {
  it('lets an anonymous visitor with a vault view link read the whole subtree, viewer-capped', async () => {
    seedSharedTree()
    seedShareLink('tok-v1', 'folder', 'v1')

    const listing = await jsonOf<Listing>(await api('/api/folders/v1/listing?share=tok-v1'))
    expect(listing.folder).toMatchObject({ id: 'v1', name: 'Home', kind: 'vault', role: 'viewer' })
    expect(listing.folders.map((f) => f.id)).toEqual(['sub'])
    expect(listing.docs.map((d) => d.id).sort()).toEqual(['d-a', 'd-b'])
    expect(listing.docs.every((d) => d.role === 'viewer')).toBe(true)
  })

  it('includes assets on each folder node', async () => {
    seedSharedTree()
    seedShareLink('tok-v1', 'folder', 'v1')
    raw.prepare(`INSERT INTO assets (id, folder_id, doc_id, filename, r2_key, content_type, size, etag, created_by, created_at)
                 VALUES ('a-v1', 'v1', NULL, 'page.html', 'folder/v1/page.html', 'text/html', 15, 'e-html', 'alice', 1)`).run()
    raw.prepare(`INSERT INTO assets (id, folder_id, doc_id, filename, r2_key, content_type, size, etag, created_by, created_at)
                 VALUES ('a-sub', 'sub', NULL, 'pic.png', 'folder/sub/pic.png', 'image/png', 3, 'e-png', 'alice', 2)`).run()

    const listing = await jsonOf<Listing>(await api('/api/folders/v1/listing?share=tok-v1'))
    expect(listing.folder.assets).toEqual([
      expect.objectContaining({ filename: 'page.html', contentType: 'text/html', etag: 'e-html' }),
    ])
    expect(listing.folders.find((f) => f.id === 'sub')?.assets).toEqual([
      expect.objectContaining({ filename: 'pic.png', contentType: 'image/png', etag: 'e-png' }),
    ])
  })

  it('admits the token on any folder INSIDE the link target (navigating into a subfolder)', async () => {
    seedSharedTree()
    seedShareLink('tok-v1', 'folder', 'v1')
    const listing = await jsonOf<Listing>(await api('/api/folders/sub/listing?share=tok-v1'))
    expect(listing.folder.id).toBe('sub')
    expect(listing.docs.map((d) => d.id)).toEqual(['d-b'])
  })

  it('never lets the token escape its subtree (sibling vault folder and doc both 404)', async () => {
    seedSharedTree()
    seedShareLink('tok-v1', 'folder', 'v1')
    expect((await api('/api/folders/v2/listing?share=tok-v1'))!.status).toBe(404)
    expect((await api('/api/docs/d-c?share=tok-v1'))!.status).toBe(404)
  })

  it('grants anonymous DOC access through the folder token (the landing page opens docs)', async () => {
    seedSharedTree()
    seedShareLink('tok-v1', 'folder', 'v1')
    const meta = await jsonOf<DocMeta>(await api('/api/docs/d-b?share=tok-v1'))
    expect(meta).toMatchObject({ id: 'd-b', role: 'viewer' })
  })

  it('treats a revoked token exactly like no access (404), and bare anonymous as 401', async () => {
    seedSharedTree()
    seedShareLink('tok-dead', 'folder', 'v1', 'viewer', 999)
    expect((await api('/api/folders/v1/listing?share=tok-dead'))!.status).toBe(404)
    expect((await api('/api/docs/d-a?share=tok-dead'))!.status).toBe(404)
    expect((await api('/api/folders/v1/listing'))!.status).toBe(401)
    expect((await api('/api/folders/nope/listing?share=tok-dead'))!.status).toBe(404)
  })

  it('caps anonymous visitors at viewer: a comment+ link grants them nothing (404, like docs)', async () => {
    seedSharedTree()
    seedShareLink('tok-edit', 'folder', 'v1', 'editor')
    expect((await api('/api/folders/v1/listing?share=tok-edit'))!.status).toBe(404)
  })

  it('gives a signed-in visitor the link role (and an existing member the max of both)', async () => {
    seedSharedTree()
    const bob = principalFor('bob')
    seedShareLink('tok-edit', 'folder', 'v1', 'editor')

    const viaLink = await jsonOf<Listing>(await api('/api/folders/v1/listing?share=tok-edit', { headers: bob }))
    expect(viaLink.folder.role).toBe('editor')

    // Their own grant outranks a weaker link.
    seedShareLink('tok-view', 'folder', 'v1', 'viewer')
    grantFolder('v1', 'bob', 'suggester')
    const viaBoth = await jsonOf<Listing>(await api('/api/folders/v1/listing?share=tok-view', { headers: bob }))
    expect(viaBoth.folder.role).toBe('suggester')
  })

  it('works tokenless for the owner (role owner) and 404s for a stranger', async () => {
    seedSharedTree()
    const alice = principalFor('alice')
    const eve = principalFor('eve')
    const listing = await jsonOf<Listing>(await api('/api/folders/v1/listing', { headers: alice }))
    expect(listing.folder.role).toBe('owner')
    expect((await api('/api/folders/v1/listing', { headers: eve }))!.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Per-file (asset) share links: TRUE per-asset sharing of HTML files
// ---------------------------------------------------------------------------

/** alice owns v1 → sub, with two HTML files in sub: a.html (a-A) and b.html (a-B). */
function seedTwoFileTree(): void {
  principalFor('alice')
  seedVault('v1', 'alice')
  seedFolder('sub', 'alice', 'v1', 'Research')
  seedHtmlAsset('a-A', 'sub', null, 'a.html')
  seedHtmlAsset('a-B', 'sub', null, 'b.html')
  h.objects.set('folder/sub/a.html', { bytes: new TextEncoder().encode('<!doctype html><h1>A</h1>'), contentType: 'text/html' })
  h.objects.set('folder/sub/b.html', { bytes: new TextEncoder().encode('<!doctype html><h1>B</h1>'), contentType: 'text/html' })
}

describe('asset share-link CRUD (POST/GET/DELETE /api/folders/:id/assets/:file/share-links)', () => {
  it('lets the owner create, list, and revoke a per-file link (target_type=asset)', async () => {
    const headers = principalFor('alice')
    seedTwoFileTree()

    const created = await api('/api/folders/sub/assets/a.html/share-links', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'commenter' }),
    })
    expect(created!.status).toBe(200)
    const link = await jsonOf<{ token: string; role: string }>(created)
    expect(link.role).toBe('commenter')
    // It is stored as an ASSET link pointed at the asset id, not the folder.
    expect(raw.prepare(`SELECT target_type, target_id FROM share_links WHERE token = ?`).get(link.token)).toEqual({
      target_type: 'asset',
      target_id: 'a-A',
    })

    const list = await jsonOf<{ shareLinks: Array<{ token: string; role: string }> }>(
      await api('/api/folders/sub/assets/a.html/share-links', { headers }),
    )
    expect(list.shareLinks).toEqual([expect.objectContaining({ token: link.token, role: 'commenter' })])

    const del = await api(`/api/folders/sub/assets/a.html/share-links/${link.token}`, { method: 'DELETE', headers })
    expect(del!.status).toBe(200)
    expect(raw.prepare(`SELECT revoked_at FROM share_links WHERE token = ?`).get(link.token)).not.toEqual({ revoked_at: null })
    // Listing only returns live links.
    const after = await jsonOf<{ shareLinks: unknown[] }>(await api('/api/folders/sub/assets/a.html/share-links', { headers }))
    expect(after.shareLinks).toEqual([])
  })

  it('is owner-only: strangers 404 (no leak), non-owner members 403', async () => {
    seedTwoFileTree()
    const bob = principalFor('bob')
    const eve = principalFor('eve')
    grantFolder('v1', 'eve', 'editor') // inherited editor — still not owner

    const stranger = await api('/api/folders/sub/assets/a.html/share-links', {
      method: 'POST',
      headers: { ...bob, 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'viewer' }),
    })
    expect(stranger!.status).toBe(404)

    const member = await api('/api/folders/sub/assets/a.html/share-links', {
      method: 'POST',
      headers: { ...eve, 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'viewer' }),
    })
    expect(member!.status).toBe(403)

    // Anonymous management is rejected outright.
    expect((await api('/api/folders/sub/assets/a.html/share-links'))!.status).toBe(401)
  })

  it('404s for a filename with no asset row', async () => {
    const headers = principalFor('alice')
    seedTwoFileTree()
    const res = await api('/api/folders/sub/assets/ghost.html/share-links', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'viewer' }),
    })
    expect(res!.status).toBe(404)
  })
})

describe('asset share-link access (restricted listing + raw + comments)', () => {
  it('restricted listing exposes ONLY the shared file — no other assets, docs, or subfolders', async () => {
    seedTwoFileTree()
    seedDoc('d-secret', 'alice', 'secret.md', 'sub') // must not leak
    seedShareLink('tok-A', 'asset', 'a-A', 'viewer')

    const listing = await jsonOf<Listing>(await api('/api/folders/sub/listing?share=tok-A'))
    expect(listing.folder).toMatchObject({ id: 'sub', role: 'viewer' })
    expect(listing.folder.assets.map((a) => a.filename)).toEqual(['a.html'])
    expect(listing.folders).toEqual([])
    expect(listing.docs).toEqual([])
  })

  it('a token for asset A grants nothing on asset B, and cannot list the folder\'s assets', async () => {
    seedTwoFileTree()
    seedShareLink('tok-A', 'asset', 'a-A', 'viewer')

    // The shared file reads; the sibling file 404s under the same token.
    expect((await api('/api/folders/sub/assets/a.html?share=tok-A'))!.status).toBe(200)
    expect((await api('/api/folders/sub/assets/b.html?share=tok-A'))!.status).toBe(404)
    // The bare asset-list path (no filename) never rides an asset token — it
    // would leak sibling files — so it stays denied.
    expect((await api('/api/folders/sub/assets?share=tok-A'))!.status).toBe(404)
    // commenting-view of the shared file works (the iframe source).
    const view = await api('/api/folders/sub/assets/a.html/commenting-view?share=tok-A')
    expect(view!.status).toBe(200)
    expect(view!.headers.get('content-security-policy')).toBe('sandbox allow-scripts')
  })

  it('an asset token cannot list a DIFFERENT folder (no subtree escape)', async () => {
    seedTwoFileTree()
    seedShareLink('tok-A', 'asset', 'a-A', 'viewer')
    // a-A lives in sub, not v1 — its token must not produce a v1 listing.
    expect((await api('/api/folders/v1/listing?share=tok-A'))!.status).toBe(404)
  })

  it('a revoked asset token grants nothing (listing, raw, and comments all deny)', async () => {
    seedTwoFileTree()
    seedShareLink('tok-dead', 'asset', 'a-A', 'viewer', 999)
    expect((await api('/api/folders/sub/listing?share=tok-dead'))!.status).toBe(404)
    expect((await api('/api/folders/sub/assets/a.html?share=tok-dead'))!.status).toBe(404)
    expect((await api('/api/folders/sub/assets/a.html/comments?share=tok-dead'))!.status).toBe(404)
  })

  it('comment POST via an asset token requires sign-in; anonymous is viewer/read-only', async () => {
    seedTwoFileTree()
    const bob = principalFor('bob')
    seedShareLink('tok-comment', 'asset', 'a-A', 'commenter')
    seedShareLink('tok-view', 'asset', 'a-A', 'viewer')

    // Anonymous read through a VIEW link works.
    const anonRead = await api('/api/folders/sub/assets/a.html/comments?share=tok-view')
    expect(anonRead!.status).toBe(200)
    expect(h.doCalls.at(-1)).toMatchObject({ ns: 'HtmlDocDO', name: 'a-A', path: '/comments' })
    expect(h.doCalls.at(-1)!.headers.role).toBe('viewer')

    // Anonymous WRITE is rejected even with a comment link (attribution).
    const anonWrite = await api('/api/folders/sub/assets/a.html/comments?share=tok-comment', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'anon' }),
    })
    expect(anonWrite!.status).toBe(401)

    // Signed-in caller on a comment link may write — and only for THIS asset.
    const signedIn = await api('/api/folders/sub/assets/a.html/comments?share=tok-comment', {
      method: 'POST',
      headers: { ...bob, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'authorized' }),
    })
    expect(signedIn!.status).toBe(200)
    expect(h.doCalls.at(-1)).toMatchObject({ ns: 'HtmlDocDO', name: 'a-A', headers: { role: 'commenter' } })

    // The same comment token does NOT reach asset B's comments.
    const otherAsset = await api('/api/folders/sub/assets/b.html/comments?share=tok-comment', {
      method: 'POST',
      headers: { ...bob, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'nope' }),
    })
    expect(otherAsset!.status).toBe(404)
  })

  it('gives a signed-in visitor the link role in the restricted listing; anon comment links grant nothing', async () => {
    seedTwoFileTree()
    const bob = principalFor('bob')
    seedShareLink('tok-comment', 'asset', 'a-A', 'commenter')

    const viaLink = await jsonOf<Listing>(await api('/api/folders/sub/listing?share=tok-comment', { headers: bob }))
    expect(viaLink.folder.role).toBe('commenter')
    expect(viaLink.folder.assets.map((a) => a.filename)).toEqual(['a.html'])

    // Anonymous + comment link → nothing (the listing 404s, like docs/folders).
    expect((await api('/api/folders/sub/listing?share=tok-comment'))!.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Vault-scoped search + backlinks (vaults plan §4)
// ---------------------------------------------------------------------------

describe('GET /api/search?vault=', () => {
  const searchCalls = () => h.doCalls.filter((c) => c.ns === 'SearchDO' && c.path === '/search')

  it('narrows allowedDocIds to the vault subtree BEFORE the search (pre-truncation)', async () => {
    seedSharedTree()
    const alice = principalFor('alice')
    expect((await api('/api/search?q=hello&vault=v1', { headers: alice }))!.status).toBe(200)
    const call = searchCalls().at(-1)!.body as { allowedDocIds: string[] }
    expect([...call.allowedDocIds].sort()).toEqual(['d-a', 'd-b'])
  })

  it('keeps the unscoped closure when the param is absent', async () => {
    seedSharedTree()
    const alice = principalFor('alice')
    expect((await api('/api/search?q=hello', { headers: alice }))!.status).toBe(200)
    const call = searchCalls().at(-1)!.body as { allowedDocIds: string[] }
    expect([...call.allowedDocIds].sort()).toEqual(['d-a', 'd-b', 'd-c'])
  })

  it('404s when the caller cannot see the vault (or it is not a vault) — and never queries the index', async () => {
    seedSharedTree()
    const eve = principalFor('eve')
    const alice = principalFor('alice')
    expect((await api('/api/search?q=hello&vault=v1', { headers: eve }))!.status).toBe(404)
    expect((await api('/api/search?q=hello&vault=sub', { headers: alice }))!.status).toBe(404)
    expect((await api('/api/search?q=hello&vault=ghost', { headers: alice }))!.status).toBe(404)
    expect(searchCalls()).toHaveLength(0)
  })

  it('lets a vault member search their shared vault', async () => {
    seedSharedTree()
    const bob = principalFor('bob')
    grantFolder('v1', 'bob', 'viewer')
    expect((await api('/api/search?q=hello&vault=v1', { headers: bob }))!.status).toBe(200)
    const call = searchCalls().at(-1)!.body as { allowedDocIds: string[] }
    expect([...call.allowedDocIds].sort()).toEqual(['d-a', 'd-b'])
  })
})

describe('GET /api/docs/:id/backlinks vault scoping', () => {
  const backlinkCalls = () => h.doCalls.filter((c) => c.ns === 'SearchDO' && c.path === '/backlinks')

  it('filters candidate docs to the linked doc\'s vault', async () => {
    seedSharedTree()
    const alice = principalFor('alice')
    expect((await api('/api/docs/d-a/backlinks', { headers: alice }))!.status).toBe(200)
    const call = backlinkCalls().at(-1)!.body as { allowedDocIds: string[] }
    expect([...call.allowedDocIds].sort()).toEqual(['d-a', 'd-b'])
  })

  it('keeps the full closure for a doc with no derivable vault (pre-backfill plain-folder root)', async () => {
    seedSharedTree()
    const alice = principalFor('alice')
    raw.prepare(
      `INSERT INTO folders (id, owner_user_id, name, kind, parent_id, created_at) VALUES ('legacy', 'alice', 'Legacy', 'folder', NULL, 1)`,
    ).run()
    seedDoc('d-l', 'alice', 'legacy.md', 'legacy')
    expect((await api('/api/docs/d-l/backlinks', { headers: alice }))!.status).toBe(200)
    const call = backlinkCalls().at(-1)!.body as { allowedDocIds: string[] }
    expect([...call.allowedDocIds].sort()).toEqual(['d-a', 'd-b', 'd-c', 'd-l'])
  })
})
