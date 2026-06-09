import { env } from 'cloudflare:workers'
import { and, eq, isNull } from 'drizzle-orm'
import { HEADER_PRINCIPAL, HEADER_ROLE, type Principal, type Role } from '@glyphdown/protocol'
import { createAuth } from '../auth.ts'
import { asAppEnv } from '../env.ts'
import { createDb, type Db } from '../db/client.ts'
import { agents } from '../db/schema.ts'
import { resolveDocAccess } from './roles.ts'

/** Identity + doc role resolved by the Worker before talking to a DocDO. */
export interface AuthContext {
  principal: Principal
  role: Role
}

/** Synthetic identity for anonymous visitors on view-role share links. */
const ANONYMOUS: Principal = { id: 'anonymous', type: 'user', name: 'Anonymous' }

export const SHARE_PARAM = 'share'
export const SHARE_HEADER = 'x-glyphdown-share'
/** Pre-rename (Inkroom) share header — still accepted so old links/clients keep working. */
export const SHARE_HEADER_LEGACY = 'x-inkroom-share'

/** Share token from `?share=`, the current header, or the legacy header. */
export function shareTokenFrom(url: URL, request: Request): string | null {
  return (
    url.searchParams.get(SHARE_PARAM) ??
    request.headers.get(SHARE_HEADER) ??
    request.headers.get(SHARE_HEADER_LEGACY)
  )
}

/**
 * Resolve the caller's identity and role for a document.
 *
 * Identity, in priority order:
 *  1. `Authorization: Bearer gd_sk_…` (or a pre-rename `ink_sk_…` key) —
 *     sha-256 of the key matched against the agents table → agent principal
 *     acting with its owner's access.
 *  2. better-auth session cookie (per-request auth instance).
 *  3. Anonymous — only viable with a view-role share link on a doc.
 *
 * With `docId`, the role is max(owner, doc_members, folder_members,
 * share-link `?share=` / X-Glyphdown-Share) per SPEC §4; soft-deleted docs are
 * inaccessible. Returns null to reject as unauthenticated/forbidden.
 */
export async function authenticate(request: Request, docId?: string): Promise<AuthContext | null> {
  const appEnv = asAppEnv(env)
  const db = createDb(appEnv.DB)
  const principal = await resolvePrincipal(request, db)

  if (docId === undefined) {
    if (!principal) return null
    return { principal, role: 'viewer' }
  }

  const url = new URL(request.url)
  const shareToken = shareTokenFrom(url, request)
  const access = await resolveDocAccess(db, docId, principal, shareToken)
  if (!access || access.role === null) return null
  if (access.doc.deletedAt !== null) return null
  return { principal: principal ?? ANONYMOUS, role: access.role }
}

/**
 * Identity only (no doc), by Bearer prefix:
 *  - `gd_sk_…` / legacy `ink_sk_…` → agent API key (sha-256 against the
 *    agents table). Pre-rename keys keep working — only their hash is
 *    stored, so they cannot be re-prefixed.
 *  - other Bearer → device-flow session token; the bearer() plugin in
 *    auth.ts converts the header into the session cookie better-auth
 *    validates (HMAC-checked), so getSession handles it like a cookie.
 *  - no Bearer   → better-auth session cookie.
 */
export async function resolvePrincipal(request: Request, db: Db): Promise<Principal | null> {
  const header = request.headers.get('authorization')
  if (header?.startsWith('Bearer ')) {
    const key = header.slice('Bearer '.length).trim()
    if (key.startsWith('gd_sk_') || key.startsWith('ink_sk_')) {
      const hash = await sha256Hex(key)
      const row = (
        await db
          .select()
          .from(agents)
          .where(and(eq(agents.keyHash, hash), isNull(agents.revokedAt)))
          .limit(1)
      )[0]
      if (!row) return null
      return { id: row.id, type: 'agent', name: row.name, ownerUserId: row.ownerUserId }
    }
    // Non-key Bearer values fall through to better-auth session validation.
  }

  const auth = createAuth(asAppEnv(env))
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session) return null
  return { id: session.user.id, type: 'user', name: session.user.name }
}

/**
 * Inject the trusted identity headers the DocDO believes blindly. Only the
 * Worker may set these; the DO is never directly internet-reachable.
 */
export function trustedHeaders(auth: AuthContext, init?: HeadersInit): Headers {
  const headers = new Headers(init)
  headers.set(HEADER_PRINCIPAL, JSON.stringify(auth.principal))
  headers.set(HEADER_ROLE, auth.role)
  return headers
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
