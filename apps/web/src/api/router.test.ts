import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { DocMeta, FolderMeta } from '@glyphdown/protocol'
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
  /** Every Worker->DO fetch: which namespace, DO name, path, JSON body. */
  const doCalls: Array<{ ns: string; name: string; path: string; body: unknown }> = []
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
      h.doCalls.push({ ns: ns.__ns, name, path: new URL(req.url).pathname, body })
      return new Response(JSON.stringify({ ok: true, results: [] }), {
        headers: { 'content-type': 'application/json' },
      })
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
      created_by TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE UNIQUE INDEX assets_folder_filename_idx ON assets (folder_id, filename);
    CREATE UNIQUE INDEX assets_doc_filename_idx ON assets (doc_id, filename);
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
