import { count, eq, isNull } from 'drizzle-orm'
import type { Principal } from '@glyphdown/protocol'
import type { Db } from '../db/client.ts'
import { docs, user } from '../db/schema.ts'

/**
 * Site admins, by account email. A code-level allowlist on purpose (v1): the
 * dashboard is read-only stats, the list is tiny, and this avoids both a
 * migration on the better-auth-managed `user` table and an admin-management
 * surface. Adding an admin = edit this set + deploy.
 */
const ADMIN_EMAILS: ReadonlySet<string> = new Set(['kirbyhood@gmail.com'])

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
 * GET /api/admin/stats — site-wide counters for the /admin dashboard.
 * Admin = signed-in user whose email is allowlisted. Agent keys never get
 * admin, even when owned by an admin (the dashboard is a human surface).
 * Non-admins get 404, not 403, so the endpoint's existence isn't leaked.
 */
export async function handleAdminStats(db: Db, principal: Principal | null): Promise<Response> {
  if (!principal) return json({ error: 'unauthenticated' }, 401)
  if (principal.type !== 'user') return json({ error: 'not-found' }, 404)
  const row = (await db.select({ email: user.email }).from(user).where(eq(user.id, principal.id)).limit(1))[0]
  if (!row || !isAdminEmail(row.email)) return json({ error: 'not-found' }, 404)

  const users = (await db.select({ n: count() }).from(user))[0]?.n ?? 0
  const created = (await db.select({ n: count() }).from(docs))[0]?.n ?? 0
  const active = (await db.select({ n: count() }).from(docs).where(isNull(docs.deletedAt)))[0]?.n ?? 0

  const stats: AdminStats = { users, docs: { created, active } }
  return json(stats)
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}
