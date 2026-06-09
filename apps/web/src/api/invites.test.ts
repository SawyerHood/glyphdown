import { beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { and, eq } from 'drizzle-orm'
import type { Db } from '../db/client.ts'
import type { AuthContext } from './auth.ts'
import { docMembers, docs, folderMembers, invites, notifications, userPrefs } from '../db/schema.ts'
import {
  INVITE_RATE_LIMIT,
  acceptInvite,
  getInvitePublic,
  handleInvitesCollection,
  normalizeEmail,
  revokeInvite,
  sendMentionEmails,
} from './invites.ts'

// Email is exercised in degradation mode throughout ({} env): every send is a
// console.warn, which doubles as our "was an email attempted" probe.
beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

// ---------------------------------------------------------------------------
// Fixtures (same in-memory-sqlite trick as assets.test.ts / roles.test.ts)
// ---------------------------------------------------------------------------

function setupDb(): Db {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
      email_verified INTEGER NOT NULL DEFAULT 0, image TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE agents (id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, name TEXT NOT NULL,
      key_hash TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'inherit', created_at INTEGER NOT NULL, revoked_at INTEGER);
    CREATE TABLE folders (id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, name TEXT NOT NULL,
      parent_id TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE docs (id TEXT PRIMARY KEY, title TEXT NOT NULL, filename TEXT NOT NULL DEFAULT '',
      folder_id TEXT, owner_user_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER);
    CREATE TABLE doc_members (doc_id TEXT NOT NULL, principal_id TEXT NOT NULL, principal_type TEXT NOT NULL,
      role TEXT NOT NULL, added_by TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (doc_id, principal_id));
    CREATE TABLE folder_members (folder_id TEXT NOT NULL, principal_id TEXT NOT NULL, principal_type TEXT NOT NULL,
      role TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (folder_id, principal_id));
    CREATE TABLE invites (token TEXT PRIMARY KEY, email TEXT NOT NULL, target_type TEXT NOT NULL,
      target_id TEXT NOT NULL, role TEXT NOT NULL, invited_by TEXT NOT NULL, created_at INTEGER NOT NULL,
      accepted_at INTEGER, accepted_by TEXT, revoked_at INTEGER);
    CREATE TABLE notifications (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, type TEXT NOT NULL,
      payload_json TEXT NOT NULL, created_at INTEGER NOT NULL, read_at INTEGER);
    CREATE TABLE user_prefs (user_id TEXT PRIMARY KEY, email_notifications INTEGER NOT NULL DEFAULT 1);
  `)
  // Seed: owner + an existing member-to-be + a doc + a folder.
  sqlite.exec(`
    INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES
      ('owner-1', 'Owner', 'owner@example.com', 1, 1, 1),
      ('member-1', 'Member', 'member@example.com', 1, 1, 1),
      ('newbie-1', 'Newbie', 'newbie-signed-up@example.com', 1, 1, 1);
    INSERT INTO docs (id, title, filename, folder_id, owner_user_id, created_at, updated_at, deleted_at)
      VALUES ('doc-1', 'roadmap', 'roadmap.md', NULL, 'owner-1', 1, 1, NULL);
    INSERT INTO folders (id, owner_user_id, name, parent_id, created_at)
      VALUES ('folder-1', 'owner-1', 'Plans', NULL, 1);
  `)
  return drizzle(sqlite) as unknown as Db
}

const ownerAuth: AuthContext = { principal: { id: 'owner-1', type: 'user', name: 'Owner' }, role: 'owner' }
const editorAuth: AuthContext = { principal: { id: 'member-1', type: 'user', name: 'Member' }, role: 'editor' }
const docTarget = { id: 'doc-1', ownerUserId: 'owner-1', title: 'roadmap' }
const folderTarget = { id: 'folder-1', ownerUserId: 'owner-1', title: 'Plans' }
const ORIGIN = 'https://app.test'

function inviteRequest(body: unknown, method = 'POST'): Request {
  return new Request('https://app.test/api/docs/doc-1/invites', {
    method,
    headers: { 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body),
  })
}

async function createInvite(
  db: Db,
  body: unknown,
  opts: { auth?: AuthContext; targetType?: 'doc' | 'folder'; now?: number } = {},
): Promise<Response> {
  const targetType = opts.targetType ?? 'doc'
  return handleInvitesCollection(
    db,
    inviteRequest(body),
    opts.auth ?? ownerAuth,
    targetType,
    targetType === 'doc' ? docTarget : folderTarget,
    ORIGIN,
    {}, // degradation mode: no RESEND_API_KEY
    opts.now,
  )
}

// ---------------------------------------------------------------------------

describe('normalizeEmail', () => {
  it('lowercases and trims', () => {
    expect(normalizeEmail('  Ada@Example.COM ')).toBe('ada@example.com')
  })
  it('rejects junk', () => {
    expect(normalizeEmail('not-an-email')).toBeNull()
    expect(normalizeEmail('a@b')).toBeNull()
    expect(normalizeEmail('a b@c.co')).toBeNull()
    expect(normalizeEmail(42)).toBeNull()
    expect(normalizeEmail('')).toBeNull()
  })
})

describe('POST /invites — create', () => {
  it('rejects non-owners', async () => {
    const db = setupDb()
    const res = await createInvite(db, { email: 'x@y.co', role: 'viewer' }, { auth: editorAuth })
    expect(res.status).toBe(403)
  })

  it('validates email and role', async () => {
    const db = setupDb()
    expect((await createInvite(db, { email: 'nope', role: 'viewer' })).status).toBe(400)
    expect((await createInvite(db, { email: 'x@y.co', role: 'owner' })).status).toBe(400)
    expect((await createInvite(db, { email: 'x@y.co', role: 'sudo' })).status).toBe(400)
  })

  it('unknown email → pending invite row + landing URL, action succeeds with email unconfigured', async () => {
    const db = setupDb()
    const res = await createInvite(db, { email: 'Stranger@Example.com', role: 'suggester' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.status).toBe('invited')
    expect(body.email).toBe('stranger@example.com')
    expect(body.emailSent).toBe(false) // degradation mode — but the invite EXISTS
    expect(body.url).toBe(`${ORIGIN}/invite/${body.token as string}`)

    const row = (await db.select().from(invites).where(eq(invites.token, body.token as string)))[0]!
    expect(row.email).toBe('stranger@example.com')
    expect(row.targetType).toBe('doc')
    expect(row.targetId).toBe('doc-1')
    expect(row.role).toBe('suggester')
    expect(row.invitedBy).toBe('owner-1')
    expect(row.acceptedAt).toBeNull()
    expect(row.revokedAt).toBeNull()
    // The would-be email was logged (degradation contract).
    expect(console.warn).toHaveBeenCalled()
  })

  it('existing email → membership granted immediately + doc-shared notification + pre-accepted row', async () => {
    const db = setupDb()
    const res = await createInvite(db, { email: 'member@example.com', role: 'editor' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.status).toBe('added')
    expect(body.principalId).toBe('member-1')

    const membership = (
      await db.select().from(docMembers).where(and(eq(docMembers.docId, 'doc-1'), eq(docMembers.principalId, 'member-1')))
    )[0]!
    expect(membership.role).toBe('editor')

    const notes = await db.select().from(notifications).where(eq(notifications.userId, 'member-1'))
    expect(notes).toHaveLength(1)
    expect(notes[0]!.type).toBe('doc-shared')

    // Audit row exists, already accepted, and counts toward the rate limit.
    const rows = await db.select().from(invites).where(eq(invites.email, 'member@example.com'))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.acceptedBy).toBe('member-1')
  })

  it('inviting the owner 409s', async () => {
    const db = setupDb()
    const res = await createInvite(db, { email: 'owner@example.com', role: 'viewer' })
    expect(res.status).toBe(409)
  })

  it('re-inviting the same pending email refreshes the token (old link dies)', async () => {
    const db = setupDb()
    const first = (await (await createInvite(db, { email: 's@x.co', role: 'viewer' })).json()) as { token: string }
    const second = (await (await createInvite(db, { email: 's@x.co', role: 'editor' })).json()) as { token: string }
    expect(second.token).not.toBe(first.token)

    const rows = await db.select().from(invites).where(eq(invites.email, 's@x.co'))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.role).toBe('editor')
    expect((await getInvitePublic(db, first.token)).status).toBe(404)
    expect((await getInvitePublic(db, second.token)).status).toBe(200)
  })

  it('rate-limits at 20 invites/hour per inviter (429)', async () => {
    const db = setupDb()
    for (let i = 0; i < INVITE_RATE_LIMIT; i++) {
      const res = await createInvite(db, { email: `p${i}@x.co`, role: 'viewer' })
      expect(res.status).toBe(200)
    }
    expect((await createInvite(db, { email: 'over@x.co', role: 'viewer' })).status).toBe(429)
    // …but the window slides: an hour later it works again.
    const later = Date.now() + 61 * 60 * 1000
    expect((await createInvite(db, { email: 'over@x.co', role: 'viewer' }, { now: later })).status).toBe(200)
  })

  it('GET /invites lists only pending invites (owner-only)', async () => {
    const db = setupDb()
    await createInvite(db, { email: 'pending@x.co', role: 'viewer' })
    await createInvite(db, { email: 'member@example.com', role: 'viewer' }) // pre-accepted, not listed

    const list = await handleInvitesCollection(db, inviteRequest(null, 'GET'), ownerAuth, 'doc', docTarget, ORIGIN, {})
    const body = (await list.json()) as { invites: Array<{ email: string }> }
    expect(body.invites.map((i) => i.email)).toEqual(['pending@x.co'])

    const denied = await handleInvitesCollection(db, inviteRequest(null, 'GET'), editorAuth, 'doc', docTarget, ORIGIN, {})
    expect(denied.status).toBe(403)
  })
})

describe('GET /api/invites/:token — public landing payload', () => {
  it('returns target/inviter/role for a live invite', async () => {
    const db = setupDb()
    const { token } = (await (await createInvite(db, { email: 's@x.co', role: 'commenter' })).json()) as {
      token: string
    }
    const res = await getInvitePublic(db, token)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      targetType: 'doc',
      targetName: 'roadmap',
      inviterName: 'Owner',
      role: 'commenter',
      accepted: false,
    })
  })

  it('404s for unknown and revoked tokens and deleted targets', async () => {
    const db = setupDb()
    expect((await getInvitePublic(db, 'nope')).status).toBe(404)

    const { token } = (await (await createInvite(db, { email: 's@x.co', role: 'viewer' })).json()) as { token: string }
    await revokeInvite(db, token, ownerAuth.principal)
    expect((await getInvitePublic(db, token)).status).toBe(404)

    const { token: t2 } = (await (await createInvite(db, { email: 's2@x.co', role: 'viewer' })).json()) as {
      token: string
    }
    await db.update(docs).set({ deletedAt: 5 }).where(eq(docs.id, 'doc-1'))
    expect((await getInvitePublic(db, t2)).status).toBe(404)
  })
})

describe('POST /api/invites/:token/accept', () => {
  async function pendingToken(db: Db, role = 'suggester'): Promise<string> {
    const res = await createInvite(db, { email: 'invited@elsewhere.com', role })
    return ((await res.json()) as { token: string }).token
  }

  it('grants the membership, marks accepted, and notifies the inviter with both emails', async () => {
    const db = setupDb()
    const token = await pendingToken(db)
    // Token possession is authority: newbie-1 signed up under a DIFFERENT email.
    const res = await acceptInvite(db, token, { id: 'newbie-1', type: 'user', name: 'Newbie' }, 99)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, targetType: 'doc', targetId: 'doc-1', role: 'suggester' })

    const membership = (
      await db.select().from(docMembers).where(and(eq(docMembers.docId, 'doc-1'), eq(docMembers.principalId, 'newbie-1')))
    )[0]!
    expect(membership.role).toBe('suggester')

    const row = (await db.select().from(invites).where(eq(invites.token, token)))[0]!
    expect(row.acceptedAt).toBe(99)
    expect(row.acceptedBy).toBe('newbie-1')

    const notes = await db.select().from(notifications).where(eq(notifications.userId, 'owner-1'))
    expect(notes).toHaveLength(1)
    expect(notes[0]!.type).toBe('invite-accepted')
    const payload = JSON.parse(notes[0]!.payloadJson) as Record<string, unknown>
    expect(payload.byName).toBe('Newbie')
    expect(payload.byEmail).toBe('newbie-signed-up@example.com')
    expect(payload.invitedEmail).toBe('invited@elsewhere.com')
    expect(payload.docId).toBe('doc-1')
  })

  it('is idempotent for the accepter and keeps the max role for existing members', async () => {
    const db = setupDb()
    // newbie already holds editor (stronger than the invite's suggester).
    await db.insert(docMembers).values({
      docId: 'doc-1',
      principalId: 'newbie-1',
      principalType: 'user',
      role: 'editor',
      addedBy: 'owner-1',
      createdAt: 1,
    })
    const token = await pendingToken(db, 'suggester')
    const principal = { id: 'newbie-1', type: 'user' as const, name: 'Newbie' }

    expect((await acceptInvite(db, token, principal)).status).toBe(200)
    expect((await acceptInvite(db, token, principal)).status).toBe(200) // re-click

    const membership = (
      await db.select().from(docMembers).where(and(eq(docMembers.docId, 'doc-1'), eq(docMembers.principalId, 'newbie-1')))
    )[0]!
    expect(membership.role).toBe('editor') // never downgraded
  })

  it('upgrades a weaker existing membership to the invited role', async () => {
    const db = setupDb()
    await db.insert(docMembers).values({
      docId: 'doc-1',
      principalId: 'newbie-1',
      principalType: 'user',
      role: 'viewer',
      addedBy: 'owner-1',
      createdAt: 1,
    })
    const token = await pendingToken(db, 'editor')
    await acceptInvite(db, token, { id: 'newbie-1', type: 'user', name: 'Newbie' })
    const membership = (
      await db.select().from(docMembers).where(and(eq(docMembers.docId, 'doc-1'), eq(docMembers.principalId, 'newbie-1')))
    )[0]!
    expect(membership.role).toBe('editor')
  })

  it('is spent for anyone else after acceptance (410)', async () => {
    const db = setupDb()
    const token = await pendingToken(db)
    await acceptInvite(db, token, { id: 'newbie-1', type: 'user', name: 'Newbie' })
    const res = await acceptInvite(db, token, { id: 'member-1', type: 'user', name: 'Member' })
    expect(res.status).toBe(410)
    expect(((await res.json()) as { error: string }).error).toBe('already-accepted')
  })

  it('owner accepting their own invite is a no-op grant (no self-membership)', async () => {
    const db = setupDb()
    const token = await pendingToken(db)
    const res = await acceptInvite(db, token, { id: 'owner-1', type: 'user', name: 'Owner' })
    expect(res.status).toBe(200)
    const rows = await db.select().from(docMembers).where(eq(docMembers.principalId, 'owner-1'))
    expect(rows).toHaveLength(0)
  })

  it('rejects revoked tokens (404) and agent principals (403)', async () => {
    const db = setupDb()
    const token = await pendingToken(db)
    expect(
      (await acceptInvite(db, token, { id: 'agent-1', type: 'agent', name: 'Bot', ownerUserId: 'member-1' })).status,
    ).toBe(403)
    await revokeInvite(db, token, ownerAuth.principal)
    expect((await acceptInvite(db, token, { id: 'newbie-1', type: 'user', name: 'Newbie' })).status).toBe(404)
  })

  it('folder invites create folder memberships', async () => {
    const db = setupDb()
    const res = await createInvite(db, { email: 'f@x.co', role: 'commenter' }, { targetType: 'folder' })
    const { token } = (await res.json()) as { token: string }
    const accept = await acceptInvite(db, token, { id: 'newbie-1', type: 'user', name: 'Newbie' })
    expect(await accept.json()).toEqual({ ok: true, targetType: 'folder', targetId: 'folder-1', role: 'commenter' })
    const membership = (
      await db
        .select()
        .from(folderMembers)
        .where(and(eq(folderMembers.folderId, 'folder-1'), eq(folderMembers.principalId, 'newbie-1')))
    )[0]!
    expect(membership.role).toBe('commenter')
  })
})

describe('DELETE /api/invites/:token — revoke', () => {
  it('owner revokes; non-owners are forbidden; unknown 404s', async () => {
    const db = setupDb()
    const { token } = (await (await createInvite(db, { email: 's@x.co', role: 'viewer' })).json()) as { token: string }

    expect((await revokeInvite(db, token, editorAuth.principal)).status).toBe(403)
    expect((await revokeInvite(db, token, ownerAuth.principal)).status).toBe(200)
    expect((await revokeInvite(db, token, ownerAuth.principal)).status).toBe(200) // idempotent
    expect((await revokeInvite(db, 'unknown', ownerAuth.principal)).status).toBe(404)

    const row = (await db.select().from(invites).where(eq(invites.token, token)))[0]!
    expect(row.revokedAt).not.toBeNull()
  })
})

describe('sendMentionEmails', () => {
  const opts = { byName: 'Grace', docId: 'doc-1', docTitle: 'roadmap', excerpt: 'hi', origin: ORIGIN }

  it('attempts an email per mentioned user (degradation logs one warn each)', async () => {
    const db = setupDb()
    await sendMentionEmails(db, ['member-1', 'newbie-1'], opts, {})
    expect(console.warn).toHaveBeenCalledTimes(2)
  })

  it('respects the per-user opt-out and skips unknown users', async () => {
    const db = setupDb()
    await db.insert(userPrefs).values({ userId: 'member-1', emailNotifications: 0 })
    await sendMentionEmails(db, ['member-1', 'ghost-user', 'newbie-1'], opts, {})
    expect(console.warn).toHaveBeenCalledTimes(1) // only newbie-1
  })
})
