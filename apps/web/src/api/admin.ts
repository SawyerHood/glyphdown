import { count, eq, isNull } from 'drizzle-orm'
import type { Principal } from '@glyphdown/protocol'
import type { Db } from '../db/client.ts'
import { docs, user } from '../db/schema.ts'
import { listFeedback } from './feedback.ts'

/**
 * Site admins, by account email. A code-level allowlist on purpose (v1): the
 * dashboard is read-only stats, the list is tiny, and this avoids both a
 * migration on the better-auth-managed `user` table and an admin-management
 * surface. Adding an admin = edit this set + deploy.
 */
const ADMIN_EMAILS: ReadonlySet<string> = new Set(['kirbyhood@gmail.com', 'sawyerjhood@gmail.com'])

export function isAdminEmail(email: string): boolean {
  return ADMIN_EMAILS.has(email.trim().toLowerCase())
}

export interface AdminStats {
  users: number
  docs: {
    /** Every doc ever created, including soft-deleted ones. */
    created: number
    /** Docs not in the trash (deleted_at IS NULL). */
    active: number
  }
}

/**
 * The admin gate, shared by every /api/admin/* route. Admin = signed-in user
 * whose email is allowlisted. Agent keys never get admin, even when owned by
 * an admin (the admin surface is for humans). Returns the rejection Response,
 * or null when the principal may proceed — non-admins get 404, not 403, so
 * the endpoints' existence isn't leaked.
 */
export async function rejectNonAdmin(db: Db, principal: Principal | null): Promise<Response | null> {
  if (!principal) return json({ error: 'unauthenticated' }, 401)
  if (principal.type !== 'user') return json({ error: 'not-found' }, 404)
  const row = (await db.select({ email: user.email }).from(user).where(eq(user.id, principal.id)).limit(1))[0]
  if (!row || !isAdminEmail(row.email)) return json({ error: 'not-found' }, 404)
  return null
}

/** GET /api/admin/stats — site-wide counters for the /admin dashboard. */
export async function handleAdminStats(db: Db, principal: Principal | null): Promise<Response> {
  const rejected = await rejectNonAdmin(db, principal)
  if (rejected) return rejected

  const users = (await db.select({ n: count() }).from(user))[0]?.n ?? 0
  const created = (await db.select({ n: count() }).from(docs))[0]?.n ?? 0
  const active = (await db.select({ n: count() }).from(docs).where(isNull(docs.deletedAt)))[0]?.n ?? 0

  const stats: AdminStats = { users, docs: { created, active } }
  return json(stats)
}

/**
 * GET /api/admin/feedback — newest-first feature requests / bug reports,
 * consumed by /admin and the hidden `glyphdown feedback` CLI command.
 */
export async function handleAdminFeedback(db: Db, principal: Principal | null): Promise<Response> {
  const rejected = await rejectNonAdmin(db, principal)
  if (rejected) return rejected
  return json({ feedback: await listFeedback(db) })
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}
