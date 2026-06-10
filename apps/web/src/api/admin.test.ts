import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { Principal } from '@glyphdown/protocol'
import type { Db } from '../db/client.ts'
import { docs, user } from '../db/schema.ts'
import { handleAdminStats, isAdminEmail } from './admin.ts'

// Same in-memory-sqlite trick as roles.test.ts / invites.test.ts.
function setupDb(): Db {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
      email_verified INTEGER NOT NULL DEFAULT 0, image TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE docs (id TEXT PRIMARY KEY, title TEXT NOT NULL, filename TEXT NOT NULL DEFAULT '',
      folder_id TEXT, owner_user_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER);
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
