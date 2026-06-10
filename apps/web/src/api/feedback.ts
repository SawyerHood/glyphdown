import { desc, eq, inArray } from 'drizzle-orm'
import type { Principal } from '@glyphdown/protocol'
import type { Db } from '../db/client.ts'
import { feedback, user } from '../db/schema.ts'
import { effectiveUserId } from './roles.ts'

const FEEDBACK_TYPES = ['feature', 'bug'] as const
type FeedbackType = (typeof FEEDBACK_TYPES)[number]

/** Hard cap — feedback is a note, not a doc. */
export const MAX_FEEDBACK_LENGTH = 4000

/**
 * POST /api/feedback — { type: 'feature'|'bug', body, page? } from any
 * signed-in principal. Agents file under their own id with the owner as the
 * responsible user (same attribution model as comments/suggestions).
 */
export async function handleFeedbackPost(db: Db, request: Request, principal: Principal | null): Promise<Response> {
  if (!principal) return json({ error: 'unauthenticated' }, 401)
  const userId = effectiveUserId(principal)
  if (userId === null) return json({ error: 'forbidden' }, 403)

  interface FeedbackPayload {
    type?: unknown
    body?: unknown
    page?: unknown
  }
  let payload: FeedbackPayload | null
  try {
    payload = (await request.json()) as FeedbackPayload | null
  } catch {
    return json({ error: 'bad-request' }, 400)
  }
  const type = FEEDBACK_TYPES.find((t) => t === payload?.type) as FeedbackType | undefined
  if (!type) return json({ error: 'bad-type' }, 400)
  const body = typeof payload?.body === 'string' ? payload.body.trim() : ''
  if (body === '') return json({ error: 'empty-body' }, 400)
  if (body.length > MAX_FEEDBACK_LENGTH) return json({ error: 'too-long' }, 400)
  const page = typeof payload?.page === 'string' && payload.page.startsWith('/') ? payload.page.slice(0, 200) : null

  const row = {
    id: crypto.randomUUID(),
    principalId: principal.id,
    userId,
    type,
    body,
    page,
    createdAt: Date.now(),
  }
  await db.insert(feedback).values(row)
  return json({ id: row.id, ok: true })
}

/**
 * Admin-only list (newest first, capped) with the filer resolved to a name +
 * email. The admin gate itself lives in the caller (api/admin.ts owns the
 * allowlist); this just shapes the data.
 */
export async function listFeedback(db: Db, limit = 200) {
  const rows = await db.select().from(feedback).orderBy(desc(feedback.createdAt)).limit(limit)
  const userIds = [...new Set(rows.map((r) => r.userId))]
  const users = userIds.length > 0 ? await db.select().from(user).where(inArray(user.id, userIds)) : []
  const byId = new Map(users.map((u) => [u.id, u]))
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    body: r.body,
    page: r.page,
    createdAt: r.createdAt,
    user: { id: r.userId, name: byId.get(r.userId)?.name ?? 'Unknown', email: byId.get(r.userId)?.email ?? null },
    /** Differs from user.id when an agent filed it. */
    filedByAgent: r.principalId !== r.userId,
  }))
}

/** Convenience for tests/admin: a single row by id. */
export async function getFeedback(db: Db, id: string) {
  return (await db.select().from(feedback).where(eq(feedback.id, id)).limit(1))[0] ?? null
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}
