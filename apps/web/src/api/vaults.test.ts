import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { folders, userPrefs } from '../db/schema.ts'
import type { Db } from '../db/client.ts'
import { availableVaultName, ensureDefaultVault } from './vaults.ts'

// Same in-memory-sqlite trick as roles.test.ts / invites.test.ts.
function setupDb(): Db {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE folders (id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'folder', parent_id TEXT, created_at INTEGER NOT NULL);
    CREATE UNIQUE INDEX folders_vault_name_unique ON folders (owner_user_id, lower(name)) WHERE kind = 'vault';
    CREATE TABLE user_prefs (user_id TEXT PRIMARY KEY, email_notifications INTEGER NOT NULL DEFAULT 1,
      default_vault_id TEXT);
  `)
  return drizzle(sqlite) as unknown as Db
}

async function vaultRows(db: Db) {
  return db.select().from(folders)
}

describe('availableVaultName', () => {
  it('returns the base when free and suffixes -2, -3 case-insensitively', () => {
    expect(availableVaultName('Home', new Set())).toBe('Home')
    expect(availableVaultName('Home', new Set(['home']))).toBe('Home-2')
    expect(availableVaultName('Home', new Set(['home', 'home-2']))).toBe('Home-3')
  })
})

describe('ensureDefaultVault', () => {
  it('creates a Home vault and records it as the default', async () => {
    const db = setupDb()
    const id = await ensureDefaultVault(db, 'u1')

    const rows = await vaultRows(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id, ownerUserId: 'u1', name: 'Home', kind: 'vault', parentId: null })
    const prefs = await db.select().from(userPrefs)
    expect(prefs).toEqual([{ userId: 'u1', emailNotifications: 1, defaultVaultId: id }])
  })

  it('is idempotent — a second call returns the same vault, creating nothing', async () => {
    const db = setupDb()
    const first = await ensureDefaultVault(db, 'u1')
    const second = await ensureDefaultVault(db, 'u1')
    expect(second).toBe(first)
    expect(await vaultRows(db)).toHaveLength(1)
  })

  it('adopts an existing vault (preferring Home) when the pref is missing', async () => {
    const db = setupDb()
    await db.insert(folders).values([
      { id: 'v-old', ownerUserId: 'u1', name: 'Notes', kind: 'vault', parentId: null, createdAt: 1 },
      { id: 'v-home', ownerUserId: 'u1', name: 'home', kind: 'vault', parentId: null, createdAt: 2 },
    ])
    expect(await ensureDefaultVault(db, 'u1')).toBe('v-home')
    expect(await vaultRows(db)).toHaveLength(2) // nothing new minted
  })

  it('falls back to the oldest vault when none is named Home', async () => {
    const db = setupDb()
    await db.insert(folders).values([
      { id: 'v-b', ownerUserId: 'u1', name: 'B', kind: 'vault', parentId: null, createdAt: 5 },
      { id: 'v-a', ownerUserId: 'u1', name: 'A', kind: 'vault', parentId: null, createdAt: 1 },
    ])
    expect(await ensureDefaultVault(db, 'u1')).toBe('v-a')
  })

  it('heals a stale default_vault_id (vault gone)', async () => {
    const db = setupDb()
    await db.insert(userPrefs).values({ userId: 'u1', defaultVaultId: 'gone' })
    const id = await ensureDefaultVault(db, 'u1')
    expect(id).not.toBe('gone')
    const prefs = await db.select().from(userPrefs)
    expect(prefs[0]!.defaultVaultId).toBe(id)
  })

  it("never adopts another user's vault or a plain folder named Home", async () => {
    const db = setupDb()
    // u2's Home vault must not satisfy u1, and u1's plain FOLDER named Home
    // is no vault — a fresh Home vault is minted for u1 (names are only
    // unique among vaults per owner, so no suffix needed).
    await db.insert(folders).values([
      { id: 'v-u2', ownerUserId: 'u2', name: 'Home', kind: 'vault', parentId: null, createdAt: 1 },
      { id: 'f-u1', ownerUserId: 'u1', name: 'Home', kind: 'folder', parentId: 'v-u2', createdAt: 1 },
    ])
    const id = await ensureDefaultVault(db, 'u1')
    const mine = (await vaultRows(db)).find((f) => f.id === id)!
    expect(mine).toMatchObject({ ownerUserId: 'u1', name: 'Home', kind: 'vault' })
  })

  it('respects a valid pre-set default over the oldest vault', async () => {
    const db = setupDb()
    await db.insert(folders).values([
      { id: 'v-1', ownerUserId: 'u1', name: 'Home', kind: 'vault', parentId: null, createdAt: 1 },
      { id: 'v-2', ownerUserId: 'u1', name: 'Work', kind: 'vault', parentId: null, createdAt: 2 },
    ])
    await db.insert(userPrefs).values({ userId: 'u1', defaultVaultId: 'v-2' })
    expect(await ensureDefaultVault(db, 'u1')).toBe('v-2')
  })
})
