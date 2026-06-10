import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { Principal } from '@glyphdown/protocol'
import type { Db } from '../db/client.ts'
import { docs, user } from '../db/schema.ts'
import { handleAdminFeedback, handleAdminStats, isAdminEmail } from './admin.ts'
import { feedback } from '../db/schema.ts'

// Same in-memory-sqlite trick as roles.test.ts / invites.test.ts.
function setupDb(): Db {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
      email_verified INTEGER NOT NULL DEFAULT 0, image TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE docs (id TEXT PRIMARY KEY, title TEXT NOT NULL, filename TEXT NOT NULL DEFAULT '',
      folder_id TEXT, owner_user_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER);
    CREATE TABLE feedback (id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, user_id TEXT NOT NULL,
      type TEXT NOT NULL, body TEXT NOT NULL, page TEXT, created_at INTEGER NOT NULL);
  `)
  return drizzle(sqlite) as unknown as Db
}

const NOW = new Date(1700000000000)

async function seed(db: Db) {
  await db.insert(user).values([
    { id: 'admin-1', name: 'Kirby', email: 'kirbyhood@gmail.com', createdAt: NOW, updatedAt: NOW },
    { id: 'user-1', name: 'Alice', email: 'alice@example.com', createdAt: NOW, updatedAt: NOW },
  ])
  await db.insert(docs).values([
    { id: 'doc-1', title: 'one', filename: 'one.md', ownerUserId: 'user-1', createdAt: 1, updatedAt: 1, deletedAt: null },
    { id: 'doc-2', title: 'two', filename: 'two.md', ownerUserId: 'user-1', createdAt: 2, updatedAt: 2, deletedAt: 3 },
    { id: 'doc-3', title: 'three', filename: 'three.md', ownerUserId: 'admin-1', createdAt: 4, updatedAt: 4, deletedAt: null },
  ])
}

const admin: Principal = { id: 'admin-1', type: 'user', name: 'Kirby' }
const alice: Principal = { id: 'user-1', type: 'user', name: 'Alice' }
const adminsAgent: Principal = { id: 'agent-1', type: 'agent', name: 'Claude Code', ownerUserId: 'admin-1' }

describe('isAdminEmail', () => {
  it('matches the allowlist case-insensitively', () => {
    expect(isAdminEmail('kirbyhood@gmail.com')).toBe(true)
    expect(isAdminEmail('  KirbyHood@Gmail.com ')).toBe(true)
    expect(isAdminEmail('sawyerjhood@gmail.com')).toBe(true)
    expect(isAdminEmail('alice@example.com')).toBe(false)
  })
})

describe('handleAdminStats', () => {
  it('returns site-wide counters for an allowlisted admin', async () => {
    const db = setupDb()
    await seed(db)
    const res = await handleAdminStats(db, admin)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ users: 2, docs: { created: 3, active: 2 } })
  })

  it('401s anonymous callers', async () => {
    const db = setupDb()
    await seed(db)
    expect((await handleAdminStats(db, null)).status).toBe(401)
  })

  it('404s non-admin users (existence not leaked)', async () => {
    const db = setupDb()
    await seed(db)
    expect((await handleAdminStats(db, alice)).status).toBe(404)
  })

  it("404s agents, even the admin's own", async () => {
    const db = setupDb()
    await seed(db)
    expect((await handleAdminStats(db, adminsAgent)).status).toBe(404)
  })

  it('404s a principal with no user row', async () => {
    const db = setupDb()
    expect((await handleAdminStats(db, admin)).status).toBe(404)
  })
})

describe('handleAdminFeedback', () => {
  it('lists feedback for admins, 404s everyone else', async () => {
    const db = setupDb()
    await seed(db)
    await db.insert(feedback).values({
      id: 'f1',
      principalId: 'user-1',
      userId: 'user-1',
      type: 'bug',
      body: 'sync ate my doc',
      page: '/d/abc',
      createdAt: 5,
    })

    const res = await handleAdminFeedback(db, admin)
    expect(res.status).toBe(200)
    const { feedback: items } = (await res.json()) as { feedback: Array<{ body: string; user: { email: string } }> }
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ body: 'sync ate my doc', user: { email: 'alice@example.com' } })

    expect((await handleAdminFeedback(db, alice)).status).toBe(404)
    expect((await handleAdminFeedback(db, adminsAgent)).status).toBe(404)
    expect((await handleAdminFeedback(db, null)).status).toBe(401)
  })
})
