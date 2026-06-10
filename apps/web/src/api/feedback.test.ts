import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { Principal } from '@glyphdown/protocol'
import type { Db } from '../db/client.ts'
import { user } from '../db/schema.ts'
import { getFeedback, handleFeedbackPost, listFeedback, MAX_FEEDBACK_LENGTH } from './feedback.ts'

// Same in-memory-sqlite trick as roles.test.ts / admin.test.ts.
function setupDb(): Db {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
      email_verified INTEGER NOT NULL DEFAULT 0, image TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE feedback (id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, user_id TEXT NOT NULL,
      type TEXT NOT NULL, body TEXT NOT NULL, page TEXT, created_at INTEGER NOT NULL);
  `)
  return drizzle(sqlite) as unknown as Db
}

const NOW = new Date(1700000000000)

async function seedUsers(db: Db) {
  await db.insert(user).values([
    { id: 'u1', name: 'Kirby', email: 'kirby@example.com', createdAt: NOW, updatedAt: NOW },
    { id: 'u2', name: 'Alice', email: 'alice@example.com', createdAt: NOW, updatedAt: NOW },
  ])
}

const kirby: Principal = { id: 'u1', type: 'user', name: 'Kirby' }
const agent: Principal = { id: 'agent-1', type: 'agent', name: 'Claude Code', ownerUserId: 'u1' }

function post(body: unknown): Request {
  return new Request('https://x/api/feedback', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('handleFeedbackPost', () => {
  it('stores a trimmed report and returns its id', async () => {
    const db = setupDb()
    await seedUsers(db)
    const res = await handleFeedbackPost(db, post({ type: 'bug', body: '  sync ate my doc  ', page: '/d/abc' }), kirby)
    expect(res.status).toBe(200)
    const { id } = (await res.json()) as { id: string }
    const row = await getFeedback(db, id)
    expect(row).toMatchObject({ type: 'bug', body: 'sync ate my doc', page: '/d/abc', userId: 'u1', principalId: 'u1' })
  })

  it('attributes agent submissions to the owning user', async () => {
    const db = setupDb()
    await seedUsers(db)
    const res = await handleFeedbackPost(db, post({ type: 'feature', body: 'wiki links' }), agent)
    const { id } = (await res.json()) as { id: string }
    expect(await getFeedback(db, id)).toMatchObject({ userId: 'u1', principalId: 'agent-1' })
  })

  it('rejects anonymous, bad types, empty and oversized bodies, non-path pages', async () => {
    const db = setupDb()
    await seedUsers(db)
    expect((await handleFeedbackPost(db, post({ type: 'bug', body: 'x' }), null)).status).toBe(401)
    expect((await handleFeedbackPost(db, post({ type: 'rant', body: 'x' }), kirby)).status).toBe(400)
    expect((await handleFeedbackPost(db, post({ type: 'bug', body: '   ' }), kirby)).status).toBe(400)
    expect(
      (await handleFeedbackPost(db, post({ type: 'bug', body: 'y'.repeat(MAX_FEEDBACK_LENGTH + 1) }), kirby)).status,
    ).toBe(400)

    const res = await handleFeedbackPost(db, post({ type: 'bug', body: 'x', page: 'https://evil.example' }), kirby)
    const { id } = (await res.json()) as { id: string }
    expect((await getFeedback(db, id))?.page).toBeNull()
  })
})

describe('listFeedback', () => {
  it('returns newest first with the filer resolved', async () => {
    const db = setupDb()
    await seedUsers(db)
    await handleFeedbackPost(db, post({ type: 'bug', body: 'first' }), kirby)
    await new Promise((r) => setTimeout(r, 2))
    await handleFeedbackPost(db, post({ type: 'feature', body: 'second' }), agent)

    const items = await listFeedback(db)
    expect(items.map((i) => i.body)).toEqual(['second', 'first'])
    expect(items[0]).toMatchObject({
      user: { id: 'u1', name: 'Kirby', email: 'kirby@example.com' },
      filedByAgent: true,
    })
    expect(items[1]?.filedByAgent).toBe(false)
  })
})
