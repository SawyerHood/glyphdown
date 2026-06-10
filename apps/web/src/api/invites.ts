import { and, count, eq, gt, isNull } from 'drizzle-orm'
import { docFilenameStem, type Principal } from '@glyphdown/protocol'
import { agents, docMembers, docs, folderMembers, folders, invites, notifications, user, userPrefs } from '../db/schema.ts'
import type { Db } from '../db/client.ts'
import { addedEmail, inviteEmail, mentionEmail, sendEmail, type EmailEnv } from '../email.ts'
import { effectiveUserId, maxRole } from './roles.ts'
import type { AuthContext } from './auth.ts'

/**
 * Email invites (SPEC §4 sharing, extended past "existing users only"):
 *
 *  - POST /api/docs/:id/invites  (and /api/folders/:id/invites)
 *      {email, role} — owner-only. Existing account → membership granted
 *      immediately ('added') + a direct-link email. No account → pending
 *      invite row ('invited') + an /invite/<token> email. Either way the
 *      caller's action SUCCEEDS even when email is unconfigured (the
 *      response carries emailSent + the URL so the UI can offer copy-link).
 *  - GET  /api/invites/:token         — public landing-page payload.
 *  - POST /api/invites/:token/accept  — session required; token possession
 *      is authority (the accepting email may differ from the invited one —
 *      both are surfaced to the inviter for transparency).
 *  - DELETE /api/invites/:token       — owner revoke.
 *
 * This module never imports `cloudflare:workers` (the router passes env/db
 * in), so the whole flow is unit-testable on better-sqlite3.
 */

export const INVITE_RATE_LIMIT = 20
export const INVITE_RATE_WINDOW_MS = 60 * 60 * 1000

type GrantableRole = 'viewer' | 'commenter' | 'suggester' | 'editor'

const GRANTABLE: ReadonlyArray<GrantableRole> = ['viewer', 'commenter', 'suggester', 'editor']

function asGrantableRole(value: unknown): GrantableRole | null {
  return typeof value === 'string' && (GRANTABLE as string[]).includes(value) ? (value as GrantableRole) : null
}

/** Light shape check only — the real validation is the delivery attempt. */
export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const email = value.trim().toLowerCase()
  if (email.length < 3 || email.length > 254) return null
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null
  return email
}

export interface InviteTarget {
  id: string
  ownerUserId: string
  /** Display name: doc filename stem or folder name. */
  title: string
  /**
   * For folder targets: whether the folder is a vault root — vault shares say
   * "vault", not "folder", in emails, notifications, and the landing page.
   */
  kind?: 'folder' | 'vault'
}

/** Copy noun for a share target ('vault' when a folder target is a vault root). */
function shareNoun(targetType: 'doc' | 'folder', kind?: 'folder' | 'vault'): 'doc' | 'folder' | 'vault' {
  return targetType === 'folder' && kind === 'vault' ? 'vault' : targetType
}

// ---------------------------------------------------------------------------
// Collection routes: GET (list pending) + POST (create) on /invites
// ---------------------------------------------------------------------------

export async function handleInvitesCollection(
  db: Db,
  request: Request,
  auth: AuthContext,
  targetType: 'doc' | 'folder',
  target: InviteTarget,
  origin: string,
  emailEnv: EmailEnv,
  now = Date.now(),
): Promise<Response> {
  // Sharing is owner-only, exactly like /members POST and /share-links.
  if (auth.role !== 'owner') return json({ error: 'forbidden' }, 403)

  if (request.method === 'GET') {
    const rows = await db
      .select()
      .from(invites)
      .where(
        and(
          eq(invites.targetType, targetType),
          eq(invites.targetId, target.id),
          isNull(invites.acceptedAt),
          isNull(invites.revokedAt),
        ),
      )
    return json({
      invites: rows.map((r) => ({ token: r.token, email: r.email, role: r.role, createdAt: r.createdAt })),
    })
  }

  if (request.method !== 'POST') return json({ error: 'method-not-allowed' }, 405)

  const payload = await readJson<{ email?: unknown; role?: unknown }>(request)
  const email = normalizeEmail(payload?.email)
  if (!email) return json({ error: 'bad-email' }, 400)
  const role = asGrantableRole(payload?.role)
  if (!role) return json({ error: 'bad-role' }, 400)

  // Rate limit: 20 invites/hour per inviter, counted over ALL invite rows
  // (the 'added' path writes a pre-accepted row, so it counts too).
  const inviterId = auth.principal.id
  const windowStart = now - INVITE_RATE_WINDOW_MS
  const [{ value: recent } = { value: 0 }] = await db
    .select({ value: count() })
    .from(invites)
    .where(and(eq(invites.invitedBy, inviterId), gt(invites.createdAt, windowStart)))
  if (recent >= INVITE_RATE_LIMIT) return json({ error: 'rate-limited' }, 429)

  const invited = (await db.select().from(user).where(eq(user.email, email)).limit(1))[0]

  if (invited) {
    // Existing account: grant immediately (the pre-invites behavior), email a
    // direct link, and record a pre-accepted invite row for the audit trail.
    if (invited.id === target.ownerUserId) return json({ error: 'already-owner' }, 409)

    await upsertMembershipKeepMax(db, targetType, target.id, invited.id, role, auth.principal.id, now, {
      // Direct (re-)invites SET the role like /members does — the share
      // dialog uses the same endpoint to change roles downward too.
      keepMax: false,
    })
    await db.insert(invites).values({
      token: randomToken(),
      email,
      targetType,
      targetId: target.id,
      role,
      invitedBy: inviterId,
      createdAt: now,
      acceptedAt: now,
      acceptedBy: invited.id,
      revokedAt: null,
    })
    await insertNotification(db, invited.id, targetType === 'doc' ? 'doc-shared' : 'folder-shared', {
      [targetType === 'doc' ? 'docId' : 'folderId']: target.id,
      title: target.title,
      role,
      by: auth.principal.id,
      byName: auth.principal.name,
      ...(targetType === 'folder' ? { kind: target.kind ?? 'folder' } : {}),
    })

    const url = targetType === 'doc' ? `${origin}/d/${target.id}` : `${origin}/?folder=${target.id}`
    const result = await sendEmail(
      {
        to: email,
        ...addedEmail({
          inviterName: auth.principal.name,
          targetName: target.title,
          targetType: shareNoun(targetType, target.kind),
          role,
          url,
        }),
      },
      { env: emailEnv },
    )
    return json({
      status: 'added',
      principalId: invited.id,
      principalType: 'user',
      role,
      email,
      emailSent: result.sent,
      ...(result.sent ? {} : { emailError: result.reason }),
    })
  }

  // No account yet: refresh any pending invite for this (email, target) —
  // new token, old links die — and send the landing-page link.
  await db
    .delete(invites)
    .where(
      and(
        eq(invites.email, email),
        eq(invites.targetType, targetType),
        eq(invites.targetId, target.id),
        isNull(invites.acceptedAt),
        isNull(invites.revokedAt),
      ),
    )
  const token = randomToken()
  await db.insert(invites).values({
    token,
    email,
    targetType,
    targetId: target.id,
    role,
    invitedBy: inviterId,
    createdAt: now,
    acceptedAt: null,
    acceptedBy: null,
    revokedAt: null,
  })

  const url = `${origin}/invite/${token}`
  const result = await sendEmail(
    {
      to: email,
      ...inviteEmail({
        inviterName: auth.principal.name,
        targetName: target.title,
        targetType: shareNoun(targetType, target.kind),
        role,
        url,
      }),
    },
    { env: emailEnv },
  )
  return json({
    status: 'invited',
    token,
    url,
    role,
    email,
    emailSent: result.sent,
    ...(result.sent ? {} : { emailError: result.reason }),
  })
}

// ---------------------------------------------------------------------------
// Token routes: GET (public landing payload), POST accept, DELETE revoke
// ---------------------------------------------------------------------------

/** Public-ish: no auth — the landing page renders this before sign-in. */
export async function getInvitePublic(db: Db, token: string): Promise<Response> {
  const loaded = await loadLiveInvite(db, token)
  if (!loaded) return json({ error: 'not-found' }, 404)
  const { invite, targetName, targetKind } = loaded
  const inviterName = await principalName(db, invite.invitedBy)
  return json({
    targetType: invite.targetType,
    // 'doc' | 'folder' | 'vault' — lets the landing page say "vault" for
    // folder invites whose folder is a vault root.
    targetKind,
    targetName,
    inviterName,
    role: invite.role,
    accepted: invite.acceptedAt !== null,
  })
}

export async function acceptInvite(
  db: Db,
  token: string,
  principal: Principal,
  now = Date.now(),
): Promise<Response> {
  // Memberships attach to the human account; agents don't accept invites.
  if (principal.type !== 'user') return json({ error: 'forbidden' }, 403)
  const loaded = await loadLiveInvite(db, token)
  if (!loaded) return json({ error: 'not-found' }, 404)
  const { invite, targetName, ownerUserId } = loaded

  if (invite.acceptedAt !== null) {
    // Idempotent for the accepter (re-clicking the email link); spent for
    // anyone else.
    if (invite.acceptedBy === principal.id) {
      return json({ ok: true, targetType: invite.targetType, targetId: invite.targetId, role: invite.role })
    }
    return json({ error: 'already-accepted' }, 410)
  }

  if (principal.id !== ownerUserId) {
    // Idempotent when already a member: keep the max of existing and granted.
    await upsertMembershipKeepMax(db, invite.targetType, invite.targetId, principal.id, invite.role, invite.invitedBy, now, {
      keepMax: true,
    })
  }
  await db.update(invites).set({ acceptedAt: now, acceptedBy: principal.id }).where(eq(invites.token, token))

  // Tell the inviter — with BOTH emails when they differ (token possession is
  // authority, so the inviter deserves to see who actually landed).
  const inviterUserId = await notifiableUserId(db, invite.invitedBy)
  if (inviterUserId && inviterUserId !== principal.id) {
    const accepter = (await db.select().from(user).where(eq(user.id, principal.id)).limit(1))[0]
    await insertNotification(db, inviterUserId, 'invite-accepted', {
      [invite.targetType === 'doc' ? 'docId' : 'folderId']: invite.targetId,
      title: targetName,
      role: invite.role,
      by: principal.id,
      byName: accepter?.name ?? principal.name,
      byEmail: accepter?.email ?? null,
      invitedEmail: invite.email,
    })
  }

  return json({ ok: true, targetType: invite.targetType, targetId: invite.targetId, role: invite.role })
}

export async function revokeInvite(db: Db, token: string, principal: Principal): Promise<Response> {
  const invite = (await db.select().from(invites).where(eq(invites.token, token)).limit(1))[0]
  if (!invite) return json({ error: 'not-found' }, 404)

  // Owner-only, matching every other sharing mutation. Folder trees are
  // single-owner, so the target's owner_user_id is the whole answer.
  const ownerUserId =
    invite.targetType === 'doc'
      ? (await db.select({ id: docs.ownerUserId }).from(docs).where(eq(docs.id, invite.targetId)).limit(1))[0]?.id
      : (await db.select({ id: folders.ownerUserId }).from(folders).where(eq(folders.id, invite.targetId)).limit(1))[0]
          ?.id
  if (!ownerUserId || effectiveUserId(principal) !== ownerUserId) return json({ error: 'forbidden' }, 403)

  if (invite.revokedAt === null) {
    await db.update(invites).set({ revokedAt: Date.now() }).where(eq(invites.token, token))
  }
  return json({ ok: true })
}

// ---------------------------------------------------------------------------
// Mention emails (same pipeline; respects the per-user opt-out)
// ---------------------------------------------------------------------------

/**
 * Email each mentioned user (already filtered to real users by the caller)
 * unless they opted out via user_prefs.email_notifications. Best-effort:
 * failures log and never propagate (the comment write already succeeded).
 */
export async function sendMentionEmails(
  db: Db,
  userIds: string[],
  opts: { byName: string; docId: string; docTitle: string; excerpt: string; origin: string },
  emailEnv: EmailEnv,
): Promise<void> {
  for (const userId of userIds) {
    try {
      const recipient = (await db.select().from(user).where(eq(user.id, userId)).limit(1))[0]
      if (!recipient?.email) continue
      const prefs = (await db.select().from(userPrefs).where(eq(userPrefs.userId, userId)).limit(1))[0]
      if (prefs && prefs.emailNotifications === 0) continue
      await sendEmail(
        {
          to: recipient.email,
          ...mentionEmail({
            byName: opts.byName,
            docTitle: opts.docTitle,
            excerpt: opts.excerpt,
            url: `${opts.origin}/d/${opts.docId}`,
          }),
        },
        { env: emailEnv },
      )
    } catch (err) {
      console.error('mention email failed:', err)
    }
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface LoadedInvite {
  invite: typeof invites.$inferSelect
  targetName: string
  ownerUserId: string
  /** Copy noun: 'vault' for folder targets that are vault roots. */
  targetKind: 'doc' | 'folder' | 'vault'
}

/** Invite row + live target; null for unknown/revoked tokens or dead targets. */
async function loadLiveInvite(db: Db, token: string): Promise<LoadedInvite | null> {
  const invite = (await db.select().from(invites).where(eq(invites.token, token)).limit(1))[0]
  if (!invite || invite.revokedAt !== null) return null

  if (invite.targetType === 'doc') {
    const doc = (await db.select().from(docs).where(eq(docs.id, invite.targetId)).limit(1))[0]
    if (!doc || doc.deletedAt !== null) return null
    return {
      invite,
      targetName: doc.filename !== '' ? docFilenameStem(doc.filename) : doc.title,
      ownerUserId: doc.ownerUserId,
      targetKind: 'doc',
    }
  }
  const folder = (await db.select().from(folders).where(eq(folders.id, invite.targetId)).limit(1))[0]
  if (!folder) return null
  return {
    invite,
    targetName: folder.name,
    ownerUserId: folder.ownerUserId,
    targetKind: shareNoun('folder', folder.kind),
  }
}

/**
 * Insert-or-update a doc/folder membership for a USER principal. keepMax
 * (accept path) never downgrades an existing grant; without it (direct
 * invite/role-change path) the new role wins, matching POST /members.
 */
async function upsertMembershipKeepMax(
  db: Db,
  targetType: 'doc' | 'folder',
  targetId: string,
  principalId: string,
  role: GrantableRole,
  addedBy: string,
  now: number,
  opts: { keepMax: boolean },
): Promise<void> {
  let effective: GrantableRole = role
  if (opts.keepMax) {
    const table = targetType === 'doc' ? docMembers : folderMembers
    const targetColumn = targetType === 'doc' ? docMembers.docId : folderMembers.folderId
    const existing = (
      await db.select().from(table).where(and(eq(targetColumn, targetId), eq(table.principalId, principalId))).limit(1)
    )[0]
    if (existing) effective = (maxRole(existing.role, role) ?? role) as GrantableRole
  }

  if (targetType === 'doc') {
    await db
      .insert(docMembers)
      .values({ docId: targetId, principalId, principalType: 'user', role: effective, addedBy, createdAt: now })
      .onConflictDoUpdate({ target: [docMembers.docId, docMembers.principalId], set: { role: effective } })
  } else {
    await db
      .insert(folderMembers)
      .values({ folderId: targetId, principalId, principalType: 'user', role: effective, createdAt: now })
      .onConflictDoUpdate({ target: [folderMembers.folderId, folderMembers.principalId], set: { role: effective } })
  }
}

/** Display name for a user-or-agent principal id (invited_by). */
async function principalName(db: Db, principalId: string): Promise<string> {
  const u = (await db.select({ name: user.name }).from(user).where(eq(user.id, principalId)).limit(1))[0]
  if (u) return u.name
  const a = (await db.select({ name: agents.name }).from(agents).where(eq(agents.id, principalId)).limit(1))[0]
  return a?.name ?? 'Someone'
}

/** The user behind invited_by: users map to themselves, agents to their owner. */
async function notifiableUserId(db: Db, principalId: string): Promise<string | null> {
  const u = (await db.select({ id: user.id }).from(user).where(eq(user.id, principalId)).limit(1))[0]
  if (u) return u.id
  const a = (await db.select().from(agents).where(eq(agents.id, principalId)).limit(1))[0]
  return a?.ownerUserId ?? null
}

async function insertNotification(db: Db, userId: string, type: string, payload: unknown): Promise<void> {
  await db.insert(notifications).values({
    id: crypto.randomUUID(),
    userId,
    type,
    payloadJson: JSON.stringify(payload),
    createdAt: Date.now(),
    readAt: null,
  })
}

function randomToken(bytes = 16): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('')
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
