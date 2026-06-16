import { env, waitUntil } from 'cloudflare:workers'
import { getServerByName, type Server } from 'partyserver'
import { and, desc, eq, inArray, isNull, ne } from 'drizzle-orm'
import {
  HEADER_ASSET,
  HEADER_ASSET_VERSION,
  assetKindForContentType,
  docFilenameStem,
  roleAtLeast,
  type CommentTarget,
  type DocMeta,
  type FolderListingFolderMeta,
  type FolderListingResponse,
  type FolderMeta,
  type Principal,
  type PushResponse,
  type Role,
  type VaultMeta,
} from '@glyphdown/protocol'
import { HEADER_COMMENT_AUTHOR } from '@glyphdown/sync'
import { asAppEnv } from '../env.ts'
import { createDb, type Db } from '../db/client.ts'
import { agents, assets, docMembers, docs, folderMembers, folders, notifications, shareLinks, user, userPrefs } from '../db/schema.ts'
import { type AuthContext, resolvePrincipal, sha256Hex, shareTokenFrom, trustedHeaders } from './auth.ts'
import { handleAdminFeedback, handleAdminStats } from './admin.ts'
import { handleFeedbackPost } from './feedback.ts'
import { acceptInvite, getInvitePublic, handleInvitesCollection, revokeInvite, sendMentionEmails } from './invites.ts'
import type { EmailEnv } from '../email.ts'
import { captureServerEvent, type AnalyticsServerEnv } from '../analytics-server.ts'
import {
  accessibleDocs,
  assetShareLinkRole,
  effectiveUserId,
  fetchAncestorChain,
  fetchFolderSubtrees,
  folderGrantMap,
  folderShareLinkRole,
  maxRole,
  resolveDocAccess,
  resolveFolderRole,
  type DocRow,
} from './roles.ts'
import { MAX_FOLDER_DEPTH, planFolderDelete, propagateFolderRoles, validateMove } from './folder-tree.ts'
import {
  assetMeta,
  assetScopeFor,
  fallbackDocIdsFor,
  handleDocAssets,
  handleFolderAssets,
  listFolderAssetMetaMap,
  resolveAssetRow,
  type AssetRow,
} from './assets.ts'
import { feedTitleToIndex, handleBacklinks, handleSearch, removeFromIndex } from './search.ts'
import { availableFilename, filenameForCreate, filenameFromPatch } from './filenames.ts'
import { ensureDefaultVault } from './vaults.ts'

/**
 * Public HTTP API (protocol §Public HTTP API): the Worker authenticates each
 * request against D1 (better-auth session or agent API key), resolves the doc
 * role per SPEC §4, then serves metadata CRUD from D1 or proxies the
 * doc-scoped surface to the document's DocDO. Returns null for paths this
 * router does not own so the TanStack Start handler can serve them.
 *
 * /api/auth/* is mounted earlier in server.ts and never reaches this router.
 */

/** Doc-scoped DO sub-paths we forward (must mirror the DocDO REST surface). */
const FORWARDABLE: ReadonlyArray<{ method: string; pattern: RegExp }> = [
  { method: 'GET', pattern: /^\/content$/ },
  { method: 'POST', pattern: /^\/push$/ },
  { method: 'GET', pattern: /^\/comments$/ },
  { method: 'POST', pattern: /^\/comments$/ },
  { method: 'POST', pattern: /^\/comments\/[^/]+\/(replies|resolve|reactions|reattach)$/ },
  { method: 'GET', pattern: /^\/suggestions$/ },
  { method: 'POST', pattern: /^\/suggestions\/[^/]+\/(accept|reject)$/ },
  { method: 'GET', pattern: /^\/versions$/ },
  { method: 'POST', pattern: /^\/versions$/ },
  { method: 'GET', pattern: /^\/versions\/[^/]+$/ },
  { method: 'POST', pattern: /^\/versions\/[^/]+\/restore$/ },
]

const ASSET_COMMENT_PATH = /^\/assets\/([^/]+)\/comments(\/.*)?$/

/** Accept both protocol role names and SPEC §4 share-link verbs. */
const ROLE_ALIASES: Record<string, Role> = {
  view: 'viewer',
  viewer: 'viewer',
  comment: 'commenter',
  commenter: 'commenter',
  suggest: 'suggester',
  suggester: 'suggester',
  edit: 'editor',
  editor: 'editor',
}

type GrantableRole = 'viewer' | 'commenter' | 'suggester' | 'editor'

function grantableRole(value: unknown): GrantableRole | null {
  if (typeof value !== 'string') return null
  const role = ROLE_ALIASES[value]
  return role && role !== 'owner' ? (role as GrantableRole) : null
}

export async function handleApi(request: Request): Promise<Response | null> {
  const url = new URL(request.url)
  if (!url.pathname.startsWith('/api/')) return null
  const db = createDb(asAppEnv(env).DB)

  if (url.pathname === '/api/me' && request.method === 'GET') {
    const principal = await resolvePrincipal(request, db)
    if (!principal) return json({ error: 'unauthenticated' }, 401)
    return json({ principal })
  }

  if (url.pathname === '/api/docs') {
    const principal = await resolvePrincipal(request, db)
    if (!principal) return json({ error: 'unauthenticated' }, 401)
    if (request.method === 'GET') return listDocs(db, principal)
    if (request.method === 'POST') return createDoc(db, request, principal)
    return json({ error: 'method-not-allowed' }, 405)
  }

  if (url.pathname === '/api/search') {
    if (request.method !== 'GET') return json({ error: 'method-not-allowed' }, 405)
    const principal = await resolvePrincipal(request, db)
    if (!principal) return json({ error: 'unauthenticated' }, 401)
    return handleSearch(db, url, principal)
  }

  const docMatch = url.pathname.match(/^\/api\/docs\/([^/]+)(\/.*)?$/)
  if (docMatch) return handleDocScoped(db, request, url, docMatch[1]!, docMatch[2] ?? '')

  if (url.pathname === '/api/folders' || url.pathname.startsWith('/api/folders/')) {
    return handleFolders(db, request, url)
  }

  if (url.pathname === '/api/vaults' || url.pathname.startsWith('/api/vaults/')) {
    return handleVaults(db, request, url)
  }

  if (url.pathname === '/api/agents' || url.pathname.startsWith('/api/agents/')) {
    return handleAgents(db, request, url)
  }

  if (url.pathname === '/api/admin/stats') {
    if (request.method !== 'GET') return json({ error: 'method-not-allowed' }, 405)
    return handleAdminStats(db, await resolvePrincipal(request, db))
  }

  if (url.pathname === '/api/admin/feedback') {
    if (request.method !== 'GET') return json({ error: 'method-not-allowed' }, 405)
    return handleAdminFeedback(db, await resolvePrincipal(request, db))
  }

  if (url.pathname === '/api/feedback') {
    if (request.method !== 'POST') return json({ error: 'method-not-allowed' }, 405)
    return handleFeedbackPost(db, request, await resolvePrincipal(request, db))
  }

  if (url.pathname === '/api/notifications' || url.pathname === '/api/notifications/read') {
    return handleNotifications(db, request, url)
  }

  // Invite tokens: GET is public-ish (the landing page renders pre-sign-in);
  // accept/revoke authenticate inside.
  const inviteMatch = url.pathname.match(/^\/api\/invites\/([^/]+)(\/accept)?$/)
  if (inviteMatch) return handleInviteToken(db, request, inviteMatch[1]!, inviteMatch[2] === '/accept')

  if (url.pathname === '/api/prefs') return handlePrefs(db, request)

  // Not ours — let the Start handler (server functions, future routes) serve it.
  return null
}

// ---------------------------------------------------------------------------
// Docs CRUD (D1 metadata)
// ---------------------------------------------------------------------------

async function listDocs(db: Db, principal: Principal): Promise<Response> {
  // Closure shared with /api/search and /backlinks (roles.ts) so search
  // visibility always matches this list exactly.
  const byId = await accessibleDocs(db, principal)
  if (byId === null) return json({ error: 'forbidden' }, 403)

  const metas = [...byId.values()]
    .sort((a, b) => b.doc.updatedAt - a.doc.updatedAt)
    .map(({ doc, role }) => docMeta(doc, role))
  return json({ docs: metas })
}

async function createDoc(db: Db, request: Request, principal: Principal): Promise<Response> {
  const userId = effectiveUserId(principal)
  if (userId === null) return json({ error: 'forbidden' }, 403)
  const payload = await readJson<{ filename?: unknown; title?: unknown; folderId?: unknown }>(request)

  // Every doc lives in a vault's subtree: an explicit folderId wins, else the
  // caller's default vault (for agents: the OWNER's — userId is already the
  // effective user). ensureDefaultVault creates `Home` on first need.
  let folderId: string
  if (typeof payload?.folderId === 'string' && payload.folderId !== '') {
    const folder = (await db.select().from(folders).where(eq(folders.id, payload.folderId)).limit(1))[0]
    if (!folder) return json({ error: 'folder-not-found' }, 404)
    if (folder.ownerUserId !== userId) return json({ error: 'forbidden' }, 403)
    folderId = folder.id
  } else {
    folderId = await ensureDefaultVault(db, userId)
  }

  // Canonical name: explicit `filename` wins, a bare `title` is slugified.
  // Creation never fails on a collision — the name is suffixed (-2, -3, …)
  // within the target scope; callers read the canonical name off the response.
  const requested = filenameForCreate(payload)
  const filename = availableFilename(requested, await takenFilenames(db, userId, folderId))

  const now = Date.now()
  const doc: DocRow = {
    id: crypto.randomUUID(),
    // Legacy column, kept coherent: always the filename stem from now on.
    title: docFilenameStem(filename),
    filename,
    folderId,
    ownerUserId: userId,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  }
  // The DocDO is created lazily on first open (first WS upgrade or proxy
  // fetch) — nothing to provision here.
  await db.insert(docs).values(doc)
  // Names live in D1, so the Worker feeds the stem to the search index
  // (fire-and-forget; the body arrives later from the DocDO).
  feedTitleToIndex(doc.id, docFilenameStem(filename))
  return json(docMeta(doc, 'owner'))
}

/** Filenames already used by LIVE docs in a scope (folder, or owner root). */
async function takenFilenames(
  db: Db,
  ownerUserId: string,
  folderId: string | null,
  excludeDocId?: string,
): Promise<Set<string>> {
  const scope =
    folderId !== null
      ? eq(docs.folderId, folderId)
      : and(eq(docs.ownerUserId, ownerUserId), isNull(docs.folderId))
  const where = excludeDocId !== undefined ? and(scope, isNull(docs.deletedAt), ne(docs.id, excludeDocId)) : and(scope, isNull(docs.deletedAt))
  const rows = await db.select({ filename: docs.filename }).from(docs).where(where)
  return new Set(rows.map((r) => r.filename))
}

async function handleDocScoped(
  db: Db,
  request: Request,
  url: URL,
  docId: string,
  subPath: string,
): Promise<Response> {
  const principal = await resolvePrincipal(request, db)
  // shareTokenFrom also accepts the legacy x-inkroom-share header (pre-rename links).
  const shareToken = shareTokenFrom(url, request)
  const access = await resolveDocAccess(db, docId, principal, shareToken)

  // Restore must reach trashed docs, which every other doc route 404s —
  // handle it before the deleted gate. Owner-only; everyone else gets the
  // same 404 a trashed doc gives them anyway (no existence leak).
  if (subPath === '/restore') {
    if (request.method !== 'POST') return json({ error: 'method-not-allowed' }, 405)
    if (!access || access.role !== 'owner' || !principal) {
      if (!principal && !shareToken) return json({ error: 'unauthenticated' }, 401)
      return json({ error: 'not-found' }, 404)
    }
    return restoreDoc(db, access.doc, { principal, role: access.role })
  }

  if (!access || access.doc.deletedAt !== null || access.role === null) {
    // Unauthenticated callers get a 401 (so the CLI can prompt for login);
    // everyone else gets 404 to avoid leaking doc existence.
    if (!principal && !shareToken) return json({ error: 'unauthenticated' }, 401)
    return json({ error: 'not-found' }, 404)
  }
  const auth: AuthContext = {
    principal: principal ?? { id: 'anonymous', type: 'user', name: 'Anonymous' },
    role: access.role,
  }

  if (subPath === '' || subPath === '/') {
    if (request.method === 'GET') return json(docMeta(access.doc, access.role))
    if (request.method === 'PATCH') return patchDoc(db, request, access.doc, auth)
    if (request.method === 'DELETE') return deleteDoc(db, access.doc, auth)
    return json({ error: 'method-not-allowed' }, 405)
  }

  if (subPath === '/share-links' || subPath.startsWith('/share-links/')) {
    return handleShareLinks(db, request, subPath, auth, 'doc', access.doc.id)
  }
  if (subPath === '/members' || subPath.startsWith('/members/')) {
    // The display name in share notifications is the filename stem.
    return handleMembers(db, request, subPath, auth, 'doc', { ...access.doc, title: docStem(access.doc) })
  }
  if (subPath === '/invites') {
    return handleInvitesCollection(
      db,
      request,
      auth,
      'doc',
      { id: access.doc.id, ownerUserId: access.doc.ownerUserId, title: docStem(access.doc) },
      url.origin,
      emailEnv(),
    )
  }
  if (isAssetCommentPath(subPath)) {
    return handleDocAssetComments(db, request, url, access.doc, auth, subPath)
  }
  if (subPath === '/assets' || subPath.startsWith('/assets/')) {
    return handleDocAssets(db, asAppEnv(env).ASSETS, request, url, access.doc, auth, subPath)
  }

  // Backlinks resolve against the global SearchDO, not this doc's DO — handle
  // before the FORWARDABLE gate (and never forward search paths to a DocDO).
  if (subPath === '/backlinks') {
    if (request.method !== 'GET') return json({ error: 'method-not-allowed' }, 405)
    return handleBacklinks(db, access.doc, principal)
  }

  if (!FORWARDABLE.some((r) => r.method === request.method && r.pattern.test(subPath))) {
    return json({ error: 'not-found' }, 404)
  }

  // Comment writes are inspected for @mentions so we can write notification
  // rows (the DO has no D1 access; the proxy is the hook point). Replies
  // additionally notify the root comment's author (SPEC §9).
  const isReply = request.method === 'POST' && /^\/comments\/[^/]+\/replies$/.test(subPath)
  const isCommentWrite = (request.method === 'POST' && /^\/comments$/.test(subPath)) || isReply
  if (isCommentWrite) {
    const bodyText = await request.text()
    const response = await forwardToDoc(request, docId, subPath, url.search, auth, bodyText)
    if (response.ok) {
      const target = docCommentTarget(access.doc)
      const mentioned = await notifyMentions(db, bodyText, response, target, auth.principal, url.origin)
      if (isReply) await notifyCommentReply(db, response, target, auth.principal, mentioned)
    }
    return response
  }

  // Pushes that land as a suggestion set notify the doc owner (SPEC §9).
  // Known gap: live suggest-mode sessions stream `suggestion-upsert` over the
  // WebSocket straight to the DO, bypassing this proxy — those create no
  // notification row in v1 (the DO has no D1 access).
  if (request.method === 'POST' && subPath === '/push') {
    const response = await forwardToDoc(request, docId, subPath, url.search, auth)
    if (response.ok) {
      await notifySuggestionPush(db, response, access.doc, auth.principal)
      // Analytics: cli_push on a successful push (the web editor never uses
      // this proxy — it syncs over the WebSocket). Background, best-effort.
      trackCliPush(response, access.doc.id, auth.principal)
    }
    return response
  }

  return forwardToDoc(request, docId, subPath, url.search, auth)
}

/**
 * PATCH /api/docs/:id — rename ({ filename }, or legacy { title } slugified)
 * and/or move ({ folderId }). Renames validate the slug strictly (400
 * `bad-filename`); both renames and moves re-check filename uniqueness among
 * live docs in the TARGET scope and return 409 `filename-taken` on collision
 * — never silent suffixing (the web UI surfaces the conflict instead).
 */
async function patchDoc(db: Db, request: Request, doc: DocRow, auth: AuthContext): Promise<Response> {
  if (auth.role !== 'owner') return json({ error: 'forbidden' }, 403)
  const payload = await readJson<{ filename?: unknown; title?: unknown; folderId?: unknown }>(request)
  if (!payload) return json({ error: 'bad-request' }, 400)

  const update: Partial<DocRow> = { updatedAt: Date.now() }

  const rename = filenameFromPatch(payload)
  if (rename === 'invalid') return json({ error: 'bad-filename' }, 400)
  if (rename !== null && rename !== doc.filename) {
    update.filename = rename
    update.title = docFilenameStem(rename) // legacy column stays coherent
  }

  if (payload.folderId !== undefined) {
    if (typeof payload.folderId === 'string' && payload.folderId !== '') {
      const folder = (await db.select().from(folders).where(eq(folders.id, payload.folderId)).limit(1))[0]
      if (!folder) return json({ error: 'folder-not-found' }, 404)
      if (folder.ownerUserId !== doc.ownerUserId) return json({ error: 'forbidden' }, 403)
      update.folderId = folder.id
    } else {
      // null/'' included: there is no root scope — every doc stays in some
      // vault's subtree (vaults plan §1 invariants).
      return json({ error: 'bad-folder' }, 400)
    }
  }

  // Uniqueness in the scope the doc will END UP in (move, rename, or both).
  const targetFolderId = update.folderId !== undefined ? update.folderId : doc.folderId
  const targetName = update.filename ?? doc.filename
  if (targetName !== doc.filename || targetFolderId !== doc.folderId) {
    const taken = await takenFilenames(db, doc.ownerUserId, targetFolderId, doc.id)
    if (taken.has(targetName)) return json({ error: 'filename-taken' }, 409)
  }

  // A move changes which folder grants reach this doc — capture the OLD
  // ancestor chain (the doc's folder included) before the update so the
  // principals granted there get their live connections rechecked, mirroring
  // patchFolder. Conservative: survivors simply reconnect.
  const moved = update.folderId !== undefined && update.folderId !== doc.folderId
  const oldChain = moved ? await fetchAncestorChain(db, doc.folderId) : []

  await db.update(docs).set(update).where(eq(docs.id, doc.id))
  if (update.filename !== undefined) feedTitleToIndex(doc.id, docFilenameStem(update.filename))

  if (moved && oldChain.length > 0) {
    const lost = await db
      .select({ principalId: folderMembers.principalId })
      .from(folderMembers)
      .where(inArray(folderMembers.folderId, oldChain))
    // 'anonymous' covers visitors riding a folder share link on an old
    // ancestor; everyone closed here re-authenticates on reconnect.
    const principals = [...new Set(lost.map((l) => l.principalId)), 'anonymous']
    await docAdminCall(doc.id, '/admin/recheck', auth, { principalIds: principals })
  }

  return json(docMeta({ ...doc, ...update }, auth.role))
}

async function deleteDoc(db: Db, doc: DocRow, auth: AuthContext): Promise<Response> {
  if (auth.role !== 'owner') return json({ error: 'forbidden' }, 403)
  await db.update(docs).set({ deletedAt: Date.now(), updatedAt: Date.now() }).where(eq(docs.id, doc.id))
  // SPEC §11: tell the DO so it broadcasts {t:'doc-deleted'} and closes every
  // live connection (4410). Best-effort — D1 is the source of truth and the
  // Worker rejects re-connects to a soft-deleted doc anyway.
  await docAdminCall(doc.id, '/admin/doc-deleted', auth)
  removeFromIndex(doc.id)
  return json({ ok: true })
}

/**
 * POST /api/docs/:id/restore (SPEC §11 trash, vaults plan §1): bring a
 * trashed doc back. The doc restores in place when its folder still exists;
 * docs trashed from the pre-vault root (folder_id NULL) or whose folder is
 * gone re-home into the owner's default vault. Either way the filename is
 * re-checked against the target scope and suffixed like create — two trashed
 * docs may share a name, so restore must never fail on a collision.
 */
async function restoreDoc(db: Db, doc: DocRow, auth: AuthContext): Promise<Response> {
  if (doc.deletedAt === null) return json({ error: 'not-deleted' }, 409)

  let folderId = doc.folderId
  if (folderId !== null) {
    const folder = (await db.select().from(folders).where(eq(folders.id, folderId)).limit(1))[0]
    if (!folder) folderId = null
  }
  if (folderId === null) folderId = await ensureDefaultVault(db, doc.ownerUserId)

  const taken = await takenFilenames(db, doc.ownerUserId, folderId, doc.id)
  const filename = availableFilename(doc.filename !== '' ? doc.filename : 'untitled.md', taken)
  const update = {
    folderId,
    filename,
    title: docFilenameStem(filename), // legacy column stays coherent
    deletedAt: null,
    updatedAt: Date.now(),
  }
  await db.update(docs).set(update).where(eq(docs.id, doc.id))
  // Deletion removed the doc from the search index; re-feed the title (the
  // body re-indexes on the DO's next snapshot/save).
  feedTitleToIndex(doc.id, docFilenameStem(filename))
  return json(docMeta({ ...doc, ...update }, auth.role))
}

function docMeta(doc: DocRow, role: Role): DocMeta {
  return {
    id: doc.id,
    filename: doc.filename,
    // `title` is DERIVED — always the filename stem (protocol contract). The
    // legacy column is never surfaced.
    title: docStem(doc),
    folderId: doc.folderId,
    ownerUserId: doc.ownerUserId,
    role,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  }
}

/** Display stem of a doc row (legacy-title fallback for unbackfilled tests). */
function docStem(doc: Pick<DocRow, 'title' | 'filename'>): string {
  return doc.filename !== '' ? docFilenameStem(doc.filename) : doc.title
}

// ---------------------------------------------------------------------------
// Share links (docs + folders)
// ---------------------------------------------------------------------------

async function handleShareLinks(
  db: Db,
  request: Request,
  subPath: string,
  auth: AuthContext,
  targetType: 'doc' | 'folder' | 'asset',
  targetId: string,
): Promise<Response> {
  if (auth.role !== 'owner') return json({ error: 'forbidden' }, 403)

  if (subPath === '/share-links') {
    if (request.method === 'GET') {
      const links = await db
        .select()
        .from(shareLinks)
        .where(
          and(eq(shareLinks.targetType, targetType), eq(shareLinks.targetId, targetId), isNull(shareLinks.revokedAt)),
        )
      return json({
        shareLinks: links.map((l) => ({ token: l.token, role: l.role, createdAt: l.createdAt })),
      })
    }
    if (request.method === 'POST') {
      const payload = await readJson<{ role?: unknown }>(request)
      const role = grantableRole(payload?.role)
      if (!role) return json({ error: 'bad-role' }, 400)
      const token = randomToken()
      const createdAt = Date.now()
      await db.insert(shareLinks).values({
        token,
        targetType,
        targetId,
        role,
        createdBy: auth.principal.id,
        createdAt,
        revokedAt: null,
      })
      return json({ token, role, createdAt })
    }
    return json({ error: 'method-not-allowed' }, 405)
  }

  const tokenMatch = subPath.match(/^\/share-links\/([^/]+)$/)
  if (tokenMatch && request.method === 'DELETE') {
    await db
      .update(shareLinks)
      .set({ revokedAt: Date.now() })
      .where(
        and(
          eq(shareLinks.token, tokenMatch[1]!),
          eq(shareLinks.targetType, targetType),
          eq(shareLinks.targetId, targetId),
        ),
      )
    // SPEC §11: drop live connections that rode the link. Only anonymous
    // visitors are identifiable as link-borne (the DO can't check D1, and the
    // Worker can't enumerate which signed-in sockets used the token) — those
    // signed-in sessions are dropped at their next upgrade/REST call instead.
    // Asset links carry no live WebSocket (asset comments are REST-polled, and
    // every poll re-validates the token), so there is nothing to recheck.
    if (targetType !== 'asset') {
      await recheckDocConnections(db, targetType, targetId, auth, ['anonymous'])
    }
    return json({ ok: true })
  }
  return json({ error: 'not-found' }, 404)
}

// ---------------------------------------------------------------------------
// Members (docs + folders): invite by email (existing users only, v1) or by
// agent id (sharing with an agent identity).
// ---------------------------------------------------------------------------

async function handleMembers(
  db: Db,
  request: Request,
  subPath: string,
  auth: AuthContext,
  targetType: 'doc' | 'folder',
  target: { id: string; ownerUserId: string; title?: string; name?: string; kind?: 'folder' | 'vault' },
): Promise<Response> {
  const table = targetType === 'doc' ? docMembers : folderMembers
  const targetColumn = targetType === 'doc' ? docMembers.docId : folderMembers.folderId

  if (subPath === '/members' && request.method === 'GET') {
    // Any reader may list members (mention autocomplete needs it).
    const rows = await db.select().from(table).where(eq(targetColumn, target.id))
    const userIds = rows.filter((r) => r.principalType === 'user').map((r) => r.principalId)
    const agentIds = rows.filter((r) => r.principalType === 'agent').map((r) => r.principalId)
    const users = userIds.length > 0 ? await db.select().from(user).where(inArray(user.id, userIds)) : []
    const agentRows = agentIds.length > 0 ? await db.select().from(agents).where(inArray(agents.id, agentIds)) : []
    const owner = (await db.select().from(user).where(eq(user.id, target.ownerUserId)).limit(1))[0]
    const members = [
      ...(owner
        ? [{ principalId: owner.id, principalType: 'user', role: 'owner', name: owner.name, email: owner.email }]
        : []),
      ...rows.map((r) => {
        const u = users.find((x) => x.id === r.principalId)
        const a = agentRows.find((x) => x.id === r.principalId)
        return {
          principalId: r.principalId,
          principalType: r.principalType,
          role: r.role,
          name: u?.name ?? a?.name ?? 'Unknown',
          email: u?.email,
        }
      }),
    ]
    return json({ members })
  }

  if (auth.role !== 'owner') return json({ error: 'forbidden' }, 403)

  if (subPath === '/members' && request.method === 'POST') {
    const payload = await readJson<{ email?: unknown; agentId?: unknown; role?: unknown }>(request)
    const role = grantableRole(payload?.role)
    if (!role) return json({ error: 'bad-role' }, 400)

    let principalId: string
    let principalType: 'user' | 'agent'
    let invitedUserId: string | null = null
    if (typeof payload?.email === 'string') {
      const invited = (
        await db.select().from(user).where(eq(user.email, payload.email.trim().toLowerCase())).limit(1)
      )[0]
      // v1: existing users only — no email invitations.
      if (!invited) return json({ error: 'user-not-found' }, 404)
      principalId = invited.id
      principalType = 'user'
      invitedUserId = invited.id
    } else if (typeof payload?.agentId === 'string') {
      const agent = (
        await db.select().from(agents).where(and(eq(agents.id, payload.agentId), isNull(agents.revokedAt))).limit(1)
      )[0]
      if (!agent) return json({ error: 'agent-not-found' }, 404)
      principalId = agent.id
      principalType = 'agent'
    } else {
      return json({ error: 'bad-request' }, 400)
    }
    if (principalId === target.ownerUserId) return json({ error: 'already-owner' }, 409)

    const row = {
      principalId,
      principalType,
      role,
      createdAt: Date.now(),
      ...(targetType === 'doc'
        ? { docId: target.id, addedBy: auth.principal.id }
        : { folderId: target.id }),
    }
    if (targetType === 'doc') {
      await db
        .insert(docMembers)
        .values(row as typeof docMembers.$inferInsert)
        .onConflictDoUpdate({ target: [docMembers.docId, docMembers.principalId], set: { role } })
    } else {
      await db
        .insert(folderMembers)
        .values(row as typeof folderMembers.$inferInsert)
        .onConflictDoUpdate({ target: [folderMembers.folderId, folderMembers.principalId], set: { role } })
    }

    if (invitedUserId) {
      await notify(db, [invitedUserId], targetType === 'doc' ? 'doc-shared' : 'folder-shared', {
        [targetType === 'doc' ? 'docId' : 'folderId']: target.id,
        title: target.title ?? target.name ?? null,
        role,
        by: auth.principal.id,
        byName: auth.principal.name,
        // Folder shares carry the folder kind so the UI can say "vault".
        ...(targetType === 'folder' ? { kind: target.kind ?? 'folder' } : {}),
      })
    }
    return json({ principalId, principalType, role })
  }

  const memberMatch = subPath.match(/^\/members\/([^/]+)$/)
  if (memberMatch && request.method === 'DELETE') {
    const principalId = memberMatch[1]!
    await db.delete(table).where(and(eq(targetColumn, target.id), eq(table.principalId, principalId)))
    // SPEC §11: drop the removed principal's live connections (4403). If they
    // retain access via another grant they reconnect and the Worker
    // recomputes their role on upgrade.
    await recheckDocConnections(db, targetType, target.id, auth, [principalId])
    return json({ ok: true })
  }
  return json({ error: 'not-found' }, 404)
}

// ---------------------------------------------------------------------------
// Folders CRUD
// ---------------------------------------------------------------------------

async function handleFolders(db: Db, request: Request, url: URL): Promise<Response> {
  const principal = await resolvePrincipal(request, db)

  // The folder share-link landing surface (GET /api/folders/:id/listing) is
  // the one folder read that admits anonymous callers — they ride a folder
  // share token the way doc GETs do — so it sits before the auth gate.
  const listingMatch = url.pathname.match(/^\/api\/folders\/([^/]+)\/listing$/)
  if (listingMatch) {
    if (request.method !== 'GET') return json({ error: 'method-not-allowed' }, 405)
    return folderListing(db, listingMatch[1]!, principal, shareTokenFrom(url, request))
  }

  // Per-file asset share-link CRUD (owner-only). This sits ABOVE the shared
  // GET asset surface below — otherwise a GET /share-links would be swallowed
  // by `sharedAssetMatch` and routed to the read path. Auth/owner gating lives
  // inside handleAssetShareLinks.
  const assetShareLinkMatch = url.pathname.match(
    /^\/api\/folders\/([^/]+)\/assets\/([^/]+)\/share-links(\/[^/]+)?$/,
  )
  if (assetShareLinkMatch) {
    return handleAssetShareLinks(
      db,
      request,
      assetShareLinkMatch[1]!,
      safeDecode(assetShareLinkMatch[2]!),
      assetShareLinkMatch[3] ?? '',
    )
  }

  // Folder share-link landing pages need their assets before the visitor has
  // an authenticated session. Only the read surface rides share tokens here;
  // mutations continue through the authenticated route below.
  const sharedAssetMatch = url.pathname.match(/^\/api\/folders\/([^/]+)(\/assets(?:\/.*)?)$/)
  if (sharedAssetMatch && request.method === 'GET') {
    if (isAssetCommentPath(sharedAssetMatch[2]!)) {
      return handleFolderAssetComments(
        db,
        request,
        url,
        sharedAssetMatch[1]!,
        sharedAssetMatch[2]!,
        principal,
        shareTokenFrom(url, request),
      )
    }
    return folderAssetRead(
      db,
      request,
      url,
      sharedAssetMatch[1]!,
      sharedAssetMatch[2]!,
      principal,
      shareTokenFrom(url, request),
    )
  }

  if (!principal) return json({ error: 'unauthenticated' }, 401)
  const userId = effectiveUserId(principal)
  if (userId === null) return json({ error: 'forbidden' }, 403)
  const ids = userId === principal.id ? [principal.id] : [principal.id, userId]

  if (url.pathname === '/api/folders') {
    if (request.method === 'GET') return listFolders(db, userId, ids)
    if (request.method === 'POST') return createFolder(db, request, userId)
    return json({ error: 'method-not-allowed' }, 405)
  }

  const match = url.pathname.match(/^\/api\/folders\/([^/]+)(\/.*)?$/)
  if (!match) return json({ error: 'not-found' }, 404)
  const folderId = match[1]!
  const subPath = match[2] ?? ''
  const folder = (await db.select().from(folders).where(eq(folders.id, folderId)).limit(1))[0]
  if (!folder) return json({ error: 'not-found' }, 404)
  // Inherited like docs: role = max(owner, folder_members on this folder or
  // any ancestor). Callers with no role at all see 404, not folder metadata.
  const folderRole = await resolveFolderRole(db, folder, principal)
  const isOwner = folderRole === 'owner'
  const auth: AuthContext = { principal, role: folderRole ?? 'viewer' }

  if (isAssetCommentPath(subPath)) {
    return handleFolderAssetComments(db, request, url, folder.id, subPath, principal, shareTokenFrom(url, request), folder)
  }
  if (subPath === '/assets' || subPath.startsWith('/assets/')) {
    // Folder-role check (used by CLI pull/sync and the sidebar): owner or
    // any folder member may list/download — INHERITED grants included (a
    // member granted on a vault root reads assets in every subfolder), so
    // guard on the already-resolved folderRole, not a direct-membership
    // lookup. Uploads and deletes additionally require editor+ on the folder
    // (enforced inside, mirroring the doc-scoped gate).
    if (folderRole === null) return json({ error: 'not-found' }, 404)
    return handleFolderAssets(db, asAppEnv(env).ASSETS, request, url, folder.id, subPath, auth)
  }
  if (subPath === '/share-links' || subPath.startsWith('/share-links/')) {
    return handleShareLinks(db, request, subPath, auth, 'folder', folder.id)
  }
  if (subPath === '/members' || subPath.startsWith('/members/')) {
    // Non-owners may list members only if they hold a role themselves
    // (directly or inherited from an ancestor grant).
    if (folderRole === null) return json({ error: 'not-found' }, 404)
    return handleMembers(db, request, subPath, auth, 'folder', folder)
  }
  if (subPath === '/invites') {
    if (folderRole === null) return json({ error: 'not-found' }, 404)
    return handleInvitesCollection(
      db,
      request,
      auth,
      'folder',
      { id: folder.id, ownerUserId: folder.ownerUserId, title: folder.name, kind: folder.kind },
      url.origin,
      emailEnv(),
    )
  }

  if (subPath === '' || subPath === '/') {
    if (request.method === 'PATCH') {
      if (!isOwner) return json({ error: 'forbidden' }, 403)
      return patchFolder(db, request, folder, userId, auth)
    }
    if (request.method === 'DELETE') {
      if (!isOwner) return json({ error: 'forbidden' }, 403)
      return deleteFolder(db, folder, userId, auth)
    }
    if (request.method === 'GET') {
      if (folderRole === null) return json({ error: 'not-found' }, 404)
      return json(folderMeta(folder, folderRole))
    }
  }
  return json({ error: 'not-found' }, 404)
}

/**
 * GET /api/folders: every folder the caller can see — owned folders, granted
 * folders, and all descendants of granted folders (grants inherit down), with
 * the effective (propagated) role on each.
 */
async function listFolders(db: Db, userId: string, ids: string[]): Promise<Response> {
  const byId = new Map<string, FolderMeta>()
  const owned = await db.select().from(folders).where(eq(folders.ownerUserId, userId))
  for (const f of owned) byId.set(f.id, folderMeta(f, 'owner'))

  const grantMap = await folderGrantMap(db, ids)
  if (grantMap.size > 0) {
    const treeRows = await fetchFolderSubtrees(db, [...grantMap.keys()])
    const effective = propagateFolderRoles(treeRows, grantMap)
    for (const row of treeRows) {
      const role = effective.get(row.id)
      if (!role) continue
      const existing = byId.get(row.id)
      byId.set(row.id, folderMeta(row, existing ? (maxRole(existing.role, role) ?? role) : role))
    }
  }
  return json({ folders: [...byId.values()] })
}

async function folderAssetRead(
  db: Db,
  request: Request,
  url: URL,
  folderId: string,
  subPath: string,
  principal: Principal | null,
  shareToken: string | null,
): Promise<Response> {
  const unauthorized = () =>
    !principal && !shareToken ? json({ error: 'unauthenticated' }, 401) : json({ error: 'not-found' }, 404)

  const folder = (await db.select().from(folders).where(eq(folders.id, folderId)).limit(1))[0]
  if (!folder) return unauthorized()
  let role = maxRole(
    await resolveFolderRole(db, folder, principal),
    await folderShareLinkRole(db, folder.id, principal, shareToken),
  )
  // No folder-level access? An ASSET-scoped token still grants access to ITS
  // single asset (raw read, commenting-view, versions, comments) addressed by
  // filename in the path — never the folder listing (a tokenless /assets list
  // path carries no filename, so it stays denied and cannot leak siblings).
  if (role === null && shareToken) {
    const filename = assetFilenameFromSubPath(subPath)
    if (filename !== null) {
      const fallbackIds = await fallbackDocIdsFor(db, folder.id)
      const row = await resolveAssetRow(db, { kind: 'folder', id: folder.id }, filename, fallbackIds)
      if (row) role = maxRole(role, await assetShareLinkRole(db, row.id, principal, shareToken))
    }
  }
  if (role === null) return unauthorized()

  return handleFolderAssets(db, asAppEnv(env).ASSETS, request, url, folder.id, subPath, {
    principal: principal ?? { id: 'anonymous', type: 'user', name: 'Anonymous' },
    role,
  })
}

/** Filename addressed by a `/assets/<filename>[/...]` sub-path, else null (a bare `/assets` list has none). */
function assetFilenameFromSubPath(subPath: string): string | null {
  const match = subPath.match(/^\/assets\/([^/]+)(?:\/.*)?$/)
  return match ? safeDecode(match[1]!) : null
}

async function handleDocAssetComments(
  db: Db,
  request: Request,
  url: URL,
  doc: DocRow,
  auth: AuthContext,
  subPath: string,
): Promise<Response> {
  const parts = assetCommentParts(subPath)
  if (!parts) return json({ error: 'not-found' }, 404)
  const scope = assetScopeFor(doc)
  const fallbackIds = scope.kind === 'folder' ? [doc.id] : []
  const row = await resolveAssetRow(db, scope, parts.filename, fallbackIds)
  if (!row) return json({ error: 'not-found' }, 404)
  const folderId = scope.kind === 'folder' ? scope.id : row.folderId ?? doc.folderId ?? undefined
  return handleAssetCommentProxy(
    db,
    request,
    url,
    row,
    auth,
    parts.commentPath,
    assetCommentTarget(row, row.filename, folderId, doc.id),
  )
}

async function handleFolderAssetComments(
  db: Db,
  request: Request,
  url: URL,
  folderId: string,
  subPath: string,
  principal: Principal | null,
  shareToken: string | null,
  preloadedFolder?: typeof folders.$inferSelect,
): Promise<Response> {
  const unauthorized = () =>
    !principal && !shareToken ? json({ error: 'unauthenticated' }, 401) : json({ error: 'not-found' }, 404)
  const parts = assetCommentParts(subPath)
  if (!parts) return json({ error: 'not-found' }, 404)

  const folder =
    preloadedFolder ??
    (await db.select().from(folders).where(eq(folders.id, folderId)).limit(1))[0]
  if (!folder) return unauthorized()

  const fallbackIds = await fallbackDocIdsFor(db, folder.id)
  const row = await resolveAssetRow(db, { kind: 'folder', id: folder.id }, parts.filename, fallbackIds)

  let role = maxRole(
    await resolveFolderRole(db, folder, principal),
    await folderShareLinkRole(db, folder.id, principal, shareToken),
  )
  // An asset-scoped token grants comment access to its asset only (read for
  // anonymous via a view link; commenting needs sign-in, enforced below).
  if (row && shareToken) role = maxRole(role, await assetShareLinkRole(db, row.id, principal, shareToken))
  if (role === null) return unauthorized()
  if (request.method !== 'GET' && !principal) return json({ error: 'unauthenticated' }, 401)

  const auth: AuthContext = {
    principal: principal ?? { id: 'anonymous', type: 'user', name: 'Anonymous' },
    role,
  }
  if (!row) return json({ error: 'not-found' }, 404)
  return handleAssetCommentProxy(
    db,
    request,
    url,
    row,
    auth,
    parts.commentPath,
    assetCommentTarget(row, row.filename, folder.id),
  )
}

async function handleAssetCommentProxy(
  db: Db,
  request: Request,
  url: URL,
  row: AssetRow,
  auth: AuthContext,
  commentPath: string,
  target: CommentTarget,
): Promise<Response> {
  if (assetKindForContentType(row.contentType) !== 'html') return json({ error: 'unsupported-asset-type' }, 415)
  const isWrite = request.method !== 'GET' && request.method !== 'HEAD'
  if (isWrite && !roleAtLeast(auth.role, 'commenter')) return json({ error: 'forbidden' }, 403)

  const isReply = request.method === 'POST' && /^\/comments\/[^/]+\/replies$/.test(commentPath)
  const isCommentWrite = (request.method === 'POST' && commentPath === '/comments') || isReply
  if (isCommentWrite) {
    const bodyText = await request.text()
    const response = await forwardToAssetDoc(request, row.id, row.currentVersionId, commentPath, url.search, auth, bodyText)
    if (response.ok) {
      const mentioned = await notifyMentions(db, bodyText, response, target, auth.principal, url.origin)
      if (isReply) await notifyCommentReply(db, response, target, auth.principal, mentioned)
    }
    return response
  }

  return forwardToAssetDoc(request, row.id, row.currentVersionId, commentPath, url.search, auth)
}

function isAssetCommentPath(subPath: string): boolean {
  return ASSET_COMMENT_PATH.test(subPath)
}

function assetCommentParts(subPath: string): { filename: string; commentPath: string } | null {
  const match = subPath.match(ASSET_COMMENT_PATH)
  if (!match) return null
  return { filename: safeDecode(match[1]!), commentPath: `/comments${match[2] ?? ''}` }
}

function assetCommentTarget(row: AssetRow, filename: string, folderId?: string, docId?: string): CommentTarget {
  return {
    kind: 'asset',
    id: row.id,
    label: filename,
    deepLink: folderId
      ? `/f/${encodeURIComponent(folderId)}/file/${encodeURIComponent(filename)}`
      : `/d/${encodeURIComponent(docId ?? '')}`,
    folderId,
    filename,
  }
}

/**
 * GET /api/folders/:id/listing — the share-link landing page's read (protocol
 * §Folder share-link landing surface): the folder plus its ENTIRE live
 * subtree (descendant folders + docs), in one response so the landing page
 * navigates the subtree without further calls. Role = max(owner/member grants
 * over the ancestor chain, share-link role) with the anonymous viewer cap —
 * exactly the doc-route rules one level up. By construction nothing outside
 * the requested folder's subtree is returned, and the token only validates
 * when its target folder is on the requested folder's ancestor chain — a
 * sibling folder 404s like any other invisible folder.
 */
async function folderListing(
  db: Db,
  folderId: string,
  principal: Principal | null,
  shareToken: string | null,
): Promise<Response> {
  const unauthorized = () =>
    // Mirror the doc routes: bare anonymous gets 401 (sign-in prompt), anyone
    // else gets 404 — never confirming the folder exists.
    !principal && !shareToken ? json({ error: 'unauthenticated' }, 401) : json({ error: 'not-found' }, 404)

  const folder = (await db.select().from(folders).where(eq(folders.id, folderId)).limit(1))[0]
  if (!folder) return unauthorized()

  const role = maxRole(
    await resolveFolderRole(db, folder, principal),
    await folderShareLinkRole(db, folder.id, principal, shareToken),
  )
  if (role === null) {
    // No folder-level access. An ASSET-scoped token still admits a RESTRICTED
    // listing exposing ONLY its single asset — never other assets, docs, or
    // subfolders. This is the landing read for a per-file share link.
    const restricted = await assetScopedListing(db, folder, principal, shareToken)
    if (restricted) return json(restricted)
    return unauthorized()
  }

  const subtree = await fetchFolderSubtrees(db, [folder.id])
  const docRows = await db
    .select()
    .from(docs)
    .where(
      and(
        inArray(
          docs.folderId,
          subtree.map((f) => f.id),
        ),
        isNull(docs.deletedAt),
      ),
    )
  const assetsByFolder = await listFolderAssetMetaMap(
    db,
    subtree.map((f) => f.id),
    docRows,
  )
  const listingFolder = (
    f: Parameters<typeof folderMeta>[0],
  ): FolderListingFolderMeta => ({
    ...folderMeta(f, role),
    assets: assetsByFolder.get(f.id) ?? [],
  })
  const body: FolderListingResponse = {
    folder: listingFolder(folder),
    folders: subtree.filter((f) => f.id !== folder.id).map((f) => listingFolder(f)),
    docs: docRows.map((d) => docMeta(d, role)),
  }
  return json(body)
}

/**
 * The landing read for a per-file (asset) share token: a FolderListingResponse
 * exposing ONLY the link's asset and never anything else in the folder. Returns
 * null (caller 404s/401s) unless the token is an unrevoked asset link, confers
 * a role (anonymous capped at viewer), and its asset actually lives in this
 * folder (folder-scoped row, or a legacy doc-scoped row homed here). The shape
 * matches a full listing with empty `folders`/`docs` so the viewer renders.
 */
async function assetScopedListing(
  db: Db,
  folder: typeof folders.$inferSelect,
  principal: Principal | null,
  shareToken: string | null,
): Promise<FolderListingResponse | null> {
  if (!shareToken) return null
  const link = (await db.select().from(shareLinks).where(eq(shareLinks.token, shareToken)).limit(1))[0]
  if (!link || link.revokedAt !== null || link.targetType !== 'asset') return null
  // Anonymous visitors get viewer only, and only via a view link (SPEC §4).
  const role: Role | null = principal ? link.role : link.role === 'viewer' ? 'viewer' : null
  if (role === null) return null

  const row = (await db.select().from(assets).where(eq(assets.id, link.targetId)).limit(1))[0]
  if (!row) return null
  const belongsToFolder =
    row.folderId === folder.id ||
    (row.folderId === null &&
      row.docId !== null &&
      (await fallbackDocIdsFor(db, folder.id)).includes(row.docId))
  if (!belongsToFolder) return null

  const listingFolder: FolderListingFolderMeta = { ...folderMeta(folder, role), assets: [assetMeta(row)] }
  return { folder: listingFolder, folders: [], docs: [] }
}

/**
 * Per-file asset share-link CRUD: GET/POST /api/folders/:id/assets/:filename/
 * share-links and DELETE …/<token>. Owner-only (the asset's owner is the folder
 * owner), mirroring the doc/folder share-link gating — handleShareLinks does
 * the actual list/create/revoke against targetType='asset', targetId=asset id.
 * Non-members get 404 (no existence leak); non-owner members get 403.
 */
async function handleAssetShareLinks(
  db: Db,
  request: Request,
  folderId: string,
  filename: string,
  tokenPart: string,
): Promise<Response> {
  const principal = await resolvePrincipal(request, db)
  if (!principal) return json({ error: 'unauthenticated' }, 401)
  const folder = (await db.select().from(folders).where(eq(folders.id, folderId)).limit(1))[0]
  if (!folder) return json({ error: 'not-found' }, 404)
  const folderRole = await resolveFolderRole(db, folder, principal)
  if (folderRole === null) return json({ error: 'not-found' }, 404)
  if (folderRole !== 'owner') return json({ error: 'forbidden' }, 403)

  const fallbackIds = await fallbackDocIdsFor(db, folder.id)
  const row = await resolveAssetRow(db, { kind: 'folder', id: folder.id }, filename, fallbackIds)
  if (!row) return json({ error: 'not-found' }, 404)

  const auth: AuthContext = { principal, role: 'owner' }
  return handleShareLinks(db, request, `/share-links${tokenPart}`, auth, 'asset', row.id)
}

/**
 * POST /api/folders: { name, parentId } — parent is REQUIRED (the root level
 * holds only vaults; plain folders cannot root) and must be caller-owned with
 * an ancestor chain terminating in a vault; depth-capped.
 */
async function createFolder(db: Db, request: Request, userId: string): Promise<Response> {
  const payload = await readJson<{ name?: unknown; parentId?: unknown }>(request)
  const name = typeof payload?.name === 'string' ? payload.name.trim() : ''
  if (name === '') return json({ error: 'bad-name' }, 400)

  if (payload?.parentId === undefined || payload.parentId === null || payload.parentId === '') {
    return json({ error: 'parent-required' }, 400)
  }
  if (typeof payload.parentId !== 'string') return json({ error: 'bad-parent' }, 400)
  const parent = (await db.select().from(folders).where(eq(folders.id, payload.parentId)).limit(1))[0]
  if (!parent) return json({ error: 'parent-not-found' }, 404)
  if (parent.ownerUserId !== userId) return json({ error: 'forbidden' }, 403)
  const chain = await fetchAncestorChain(db, parent.id)
  if (chain.length + 1 > MAX_FOLDER_DEPTH) return json({ error: 'too-deep' }, 400)
  // The chain must end at a vault (invariant: parent_id NULL ⟺ kind='vault')
  // — a stray pre-backfill root folder is not a legal home for new children.
  const rootId = chain[chain.length - 1]!
  const root = parent.id === rootId ? parent : (await db.select().from(folders).where(eq(folders.id, rootId)).limit(1))[0]
  if (!root || root.kind !== 'vault') return json({ error: 'vault-required' }, 400)

  const folder = {
    id: crypto.randomUUID(),
    ownerUserId: userId,
    name,
    kind: 'folder' as const,
    parentId: parent.id,
    createdAt: Date.now(),
  }
  await db.insert(folders).values(folder)
  return json(folderMeta(folder, 'owner'))
}

/**
 * PATCH /api/folders/:id: { name?, parentId? } — rename and/or MOVE (owner
 * only). Moves are cycle-guarded (the target must not be the folder itself or
 * any descendant) and depth-capped (moved subtree height + target depth ≤
 * MAX_FOLDER_DEPTH). Because a move changes which ancestors' grants reach the
 * subtree's docs, we fan out a connection recheck over the subtree for every
 * principal granted on the OLD ancestor chain (conservative: anyone who might
 * have lost access; survivors simply reconnect).
 */
async function patchFolder(
  db: Db,
  request: Request,
  folder: typeof folders.$inferSelect,
  userId: string,
  auth: AuthContext,
): Promise<Response> {
  const payload = await readJson<{ name?: unknown; parentId?: unknown }>(request)
  if (!payload || (payload.name === undefined && payload.parentId === undefined)) {
    return json({ error: 'bad-request' }, 400)
  }

  const update: { name?: string; parentId?: string | null } = {}
  if (payload.name !== undefined) {
    const name = typeof payload.name === 'string' ? payload.name.trim() : ''
    if (name === '') return json({ error: 'bad-name' }, 400)
    // Vault names address vaults (CLI `--vault <name>`): keep them unique per
    // owner, case-insensitively — mirrors the partial unique index so the
    // rename fails 409 instead of a constraint error.
    if (folder.kind === 'vault' && name.toLowerCase() !== folder.name.toLowerCase()) {
      if (await vaultNameTaken(db, userId, name, folder.id)) return json({ error: 'name-taken' }, 409)
    }
    update.name = name
  }

  if (payload.parentId !== undefined) {
    // Vaults ARE the roots: they never move or nest (vaults plan §1).
    if (folder.kind === 'vault') return json({ error: 'vault-immovable' }, 400)

    let newParentId: string | null
    if (payload.parentId === null || payload.parentId === '') newParentId = null
    else if (typeof payload.parentId === 'string') newParentId = payload.parentId
    else return json({ error: 'bad-parent' }, 400)

    // No new roots: the root level holds only vaults.
    if (newParentId === null) return json({ error: 'vault-required' }, 400)

    const parent = (await db.select().from(folders).where(eq(folders.id, newParentId)).limit(1))[0]
    if (!parent) return json({ error: 'parent-not-found' }, 404)
    // Trees stay single-owner: you may only nest under your own folders.
    if (parent.ownerUserId !== userId) return json({ error: 'forbidden' }, 403)
    // Cycle + depth validation over the owner's full folder set (folder trees
    // are single-owner by construction, so this set contains the whole tree).
    const ownerFolders = await db
      .select({ id: folders.id, parentId: folders.parentId })
      .from(folders)
      .where(eq(folders.ownerUserId, userId))
    const verdict = validateMove(ownerFolders, folder.id, newParentId)
    if (!verdict.ok) {
      return json({ error: verdict.reason }, verdict.reason === 'parent-not-found' ? 404 : 400)
    }
    update.parentId = newParentId
  }

  const moved = update.parentId !== undefined && update.parentId !== folder.parentId
  // Capture the OLD ancestor chain above the folder before the move — grants
  // there are the ones that can stop reaching this subtree.
  const oldChainAbove = moved ? await fetchAncestorChain(db, folder.parentId) : []

  await db.update(folders).set(update).where(eq(folders.id, folder.id))

  if (moved && oldChainAbove.length > 0) {
    const lost = await db
      .select({ principalId: folderMembers.principalId })
      .from(folderMembers)
      .where(inArray(folderMembers.folderId, oldChainAbove))
    // 'anonymous' covers visitors riding a folder share link on an old
    // ancestor; everyone closed here re-authenticates on reconnect.
    const principals = [...new Set(lost.map((l) => l.principalId)), 'anonymous']
    await recheckFolderSubtree(db, folder.id, auth, principals)
  }

  return json(folderMeta({ ...folder, ...update }, 'owner'))
}

/**
 * DELETE /api/folders/:id: promote the folder's direct child folders AND docs
 * to the deleted folder's parent (null → root) in one batch, then delete the
 * row. Grants on ancestors keep reaching the promoted children (the chain
 * just loses one link), but grants on the DELETED folder itself stop covering
 * the subtree — so the recheck fans out over every doc in the subtree for the
 * deleted folder's member principals (+ 'anonymous' for its share links).
 */
async function deleteFolder(
  db: Db,
  folder: typeof folders.$inferSelect,
  userId: string,
  auth: AuthContext,
): Promise<Response> {
  // Folder-delete semantics (promote children to the parent) would dump a
  // vault's children at the now-illegal root. Vault deletion is a dedicated
  // flow (subtree soft-delete, Phase 2's DELETE /api/vaults/:id) — until
  // then a vault cannot be deleted at all.
  if (folder.kind === 'vault') return json({ error: 'vault-undeletable' }, 400)

  const ownerFolders = await db
    .select({ id: folders.id, parentId: folders.parentId })
    .from(folders)
    .where(eq(folders.ownerUserId, userId))
  const plan = planFolderDelete(ownerFolders, folder.id)
  if (!plan) return json({ error: 'not-found' }, 404)

  // Snapshot the recheck fanout BEFORE mutating: every live doc in the
  // subtree, and the principals granted on the folder being deleted.
  const subtreeDocs = await db
    .select({ id: docs.id })
    .from(docs)
    .where(and(inArray(docs.folderId, plan.subtreeFolderIds), isNull(docs.deletedAt)))
  const lost = await db
    .select({ principalId: folderMembers.principalId })
    .from(folderMembers)
    .where(eq(folderMembers.folderId, folder.id))

  // Promotion can land a doc next to a same-named sibling in the destination
  // scope. Unlike an explicit move (409 filename-taken), deleting a folder is
  // not a naming action — colliding promoted docs are quietly suffixed
  // (-2, -3, …) deterministically (created_at, id) before the move so the
  // scope's uniqueness invariant holds.
  const promoted = await db
    .select()
    .from(docs)
    .where(and(eq(docs.folderId, folder.id), isNull(docs.deletedAt)))
  const destTaken = await takenFilenames(db, userId, plan.promoteToParentId)
  // Suffix targets must dodge BOTH destination names and every sibling being
  // promoted alongside (renames apply while the docs still sit in the old
  // folder, where those siblings live).
  const taken = new Set([...destTaken, ...promoted.map((d) => d.filename)])
  const renames: Array<{ id: string; filename: string }> = []
  for (const doc of [...promoted].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))) {
    if (!destTaken.has(doc.filename)) {
      destTaken.add(doc.filename)
      continue
    }
    const next = availableFilename(doc.filename, taken)
    renames.push({ id: doc.id, filename: next })
    taken.add(next)
    destTaken.add(next)
  }

  // Renames apply before the folder-id move so the partial unique indexes
  // hold at every intermediate statement.
  await db.batch([
    db.update(folders).set({ parentId: plan.promoteToParentId }).where(eq(folders.parentId, folder.id)),
    ...renames.map((r) =>
      db.update(docs).set({ filename: r.filename, title: docFilenameStem(r.filename) }).where(eq(docs.id, r.id)),
    ),
    db.update(docs).set({ folderId: plan.promoteToParentId }).where(eq(docs.folderId, folder.id)),
    db.delete(folders).where(eq(folders.id, folder.id)),
  ])
  for (const r of renames) feedTitleToIndex(r.id, docFilenameStem(r.filename))

  const principals = [...new Set(lost.map((l) => l.principalId)), 'anonymous']
  for (const doc of subtreeDocs) {
    await docAdminCall(doc.id, '/admin/recheck', auth, { principalIds: principals })
  }
  return json({ ok: true })
}

function folderMeta(
  folder: {
    id: string
    name: string
    kind: 'folder' | 'vault'
    parentId: string | null
    ownerUserId: string
    createdAt: number
  },
  role: Role,
): FolderMeta {
  return {
    id: folder.id,
    name: folder.name,
    kind: folder.kind,
    parentId: folder.parentId,
    ownerUserId: folder.ownerUserId,
    role,
    createdAt: folder.createdAt,
  }
}

// folderGrantMap / fetchFolderSubtrees moved to roles.ts (shared with the
// accessible-docs closure that /api/search reuses).

// ---------------------------------------------------------------------------
// Vaults (vaults plan §3): thin routes over the folders table that enforce
// the vault invariants — a vault is a root folder (kind='vault'), named
// uniquely per owner (case-insensitive), rename-only, and deletable only as
// a whole subtree into the 30-day trash.
// ---------------------------------------------------------------------------

async function handleVaults(db: Db, request: Request, url: URL): Promise<Response> {
  const principal = await resolvePrincipal(request, db)
  if (!principal) return json({ error: 'unauthenticated' }, 401)
  const userId = effectiveUserId(principal)
  if (userId === null) return json({ error: 'forbidden' }, 403)
  const ids = userId === principal.id ? [principal.id] : [principal.id, userId]

  if (url.pathname === '/api/vaults') {
    if (request.method === 'GET') return listVaults(db, userId, ids)
    if (request.method === 'POST') return createVault(db, request, userId)
    return json({ error: 'method-not-allowed' }, 405)
  }

  const match = url.pathname.match(/^\/api\/vaults\/([^/]+)$/)
  if (!match) return json({ error: 'not-found' }, 404)
  const vault = (
    await db.select().from(folders).where(and(eq(folders.id, match[1]!), eq(folders.kind, 'vault'))).limit(1)
  )[0]
  if (!vault) return json({ error: 'not-found' }, 404)

  if (request.method !== 'PATCH' && request.method !== 'DELETE') return json({ error: 'method-not-allowed' }, 405)
  // Vault mutations are owner-only, like every folder mutation (members get
  // the same 403 a folder PATCH gives them).
  if (vault.ownerUserId !== userId) return json({ error: 'forbidden' }, 403)
  if (request.method === 'PATCH') return renameVault(db, request, vault, userId)
  return deleteVault(db, vault, userId, { principal, role: 'owner' })
}

/**
 * GET /api/vaults: the caller's vault switcher list — owned vaults plus every
 * vault the principal holds a DIRECT folder_members grant on (a grant on a
 * subfolder shares that subtree, not the vault), with the effective role.
 */
async function listVaults(db: Db, userId: string, ids: string[]): Promise<Response> {
  const byId = new Map<string, VaultMeta>()
  const owned = await db
    .select()
    .from(folders)
    .where(and(eq(folders.ownerUserId, userId), eq(folders.kind, 'vault')))
  for (const v of owned) byId.set(v.id, vaultMeta(v, 'owner'))

  const grantMap = await folderGrantMap(db, ids)
  if (grantMap.size > 0) {
    const granted = await db
      .select()
      .from(folders)
      .where(and(inArray(folders.id, [...grantMap.keys()]), eq(folders.kind, 'vault')))
    for (const v of granted) {
      const role = grantMap.get(v.id)
      if (!role) continue
      const existing = byId.get(v.id)
      byId.set(v.id, vaultMeta(v, existing ? (maxRole(existing.role, role) ?? role) : role))
    }
  }
  // Oldest first: stable ordering for switchers, with the (usually oldest)
  // default `Home` vault leading.
  const vaults = [...byId.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  return json({ vaults })
}

/** POST /api/vaults: { name } — 409 `name-taken` mirrors the partial unique index. */
async function createVault(db: Db, request: Request, userId: string): Promise<Response> {
  const payload = await readJson<{ name?: unknown }>(request)
  const name = typeof payload?.name === 'string' ? payload.name.trim() : ''
  if (name === '') return json({ error: 'bad-name' }, 400)
  if (await vaultNameTaken(db, userId, name)) return json({ error: 'name-taken' }, 409)

  const vault = {
    id: crypto.randomUUID(),
    ownerUserId: userId,
    name,
    kind: 'vault' as const,
    parentId: null,
    createdAt: Date.now(),
  }
  await db.insert(folders).values(vault)
  return json(vaultMeta(vault, 'owner'))
}

/**
 * PATCH /api/vaults/:id: rename ONLY — vaults are the roots and never move
 * (plan §1 invariants), so a parentId in the payload is rejected outright.
 * Same case-insensitive 409 `name-taken` guard as the folder PATCH path.
 */
async function renameVault(
  db: Db,
  request: Request,
  vault: typeof folders.$inferSelect,
  userId: string,
): Promise<Response> {
  const payload = await readJson<{ name?: unknown; parentId?: unknown }>(request)
  if (!payload || payload.name === undefined) return json({ error: 'bad-request' }, 400)
  if (payload.parentId !== undefined) return json({ error: 'vault-immovable' }, 400)
  const name = typeof payload.name === 'string' ? payload.name.trim() : ''
  if (name === '') return json({ error: 'bad-name' }, 400)
  if (name.toLowerCase() !== vault.name.toLowerCase() && (await vaultNameTaken(db, userId, name, vault.id))) {
    return json({ error: 'name-taken' }, 409)
  }
  await db.update(folders).set({ name }).where(eq(folders.id, vault.id))
  return json(vaultMeta({ ...vault, name }, 'owner'))
}

/**
 * DELETE /api/vaults/:id — deliberately NOT folder-delete semantics (which
 * promote children to the parent; for a vault that would dump content at the
 * now-illegal root). Instead the ENTIRE subtree goes away: every live doc is
 * soft-deleted into the 30-day trash (SPEC §11) and the subtree's folder rows
 * are hard-deleted — restore (POST /api/docs/:id/restore) then re-homes a doc
 * into the owner's default vault, which is exactly the Phase-1 missing-folder
 * contract. Grants and share links on the deleted folders die with the rows.
 *
 * Guards (the UI surfaces both distinctly): the caller's LAST vault cannot be
 * deleted (every doc needs a vault to land in), and neither can their default
 * vault (createDoc-without-folderId and restore both target it).
 */
async function deleteVault(
  db: Db,
  vault: typeof folders.$inferSelect,
  userId: string,
  auth: AuthContext,
): Promise<Response> {
  const owned = await db
    .select({ id: folders.id })
    .from(folders)
    .where(and(eq(folders.ownerUserId, userId), eq(folders.kind, 'vault')))
  if (owned.length <= 1) return json({ error: 'last-vault' }, 400)
  const pref = (await db.select().from(userPrefs).where(eq(userPrefs.userId, userId)).limit(1))[0]
  if (pref?.defaultVaultId === vault.id) return json({ error: 'default-vault' }, 400)

  // Snapshot the subtree BEFORE mutating: the folder closure and every live
  // doc in it (those are the docs to trash and the DOs to tear down).
  const subtree = await fetchFolderSubtrees(db, [vault.id])
  const subtreeIds = subtree.map((f) => f.id)
  const liveDocs = await db
    .select({ id: docs.id })
    .from(docs)
    .where(and(inArray(docs.folderId, subtreeIds), isNull(docs.deletedAt)))

  // One batch: trash the docs, drop the subtree's grants, then the folder
  // rows children-before-parents (the parent_id self-FK has no ON DELETE
  // action, so a parent must not outlive-in-reverse its children mid-batch).
  const now = Date.now()
  await db.batch([
    db
      .update(docs)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(inArray(docs.folderId, subtreeIds), isNull(docs.deletedAt))),
    db.delete(folderMembers).where(inArray(folderMembers.folderId, subtreeIds)),
    ...subtreeDeleteLevels(subtree).map((levelIds) => db.delete(folders).where(inArray(folders.id, levelIds))),
  ])

  // Tear each doc down exactly like deleteDoc: the DO broadcasts
  // {t:'doc-deleted'} and closes EVERY live connection (members and link
  // visitors included — this subsumes a per-principal recheck fan-out), and
  // the search index forgets the doc. Best-effort, like deleteDoc.
  for (const doc of liveDocs) {
    await docAdminCall(doc.id, '/admin/doc-deleted', auth)
    removeFromIndex(doc.id)
  }
  return json({ ok: true })
}

/** Case-insensitive vault-name collision among the owner's vaults (mirrors the partial unique index). */
async function vaultNameTaken(db: Db, userId: string, name: string, excludeId?: string): Promise<boolean> {
  const vaults = await db
    .select({ id: folders.id, name: folders.name })
    .from(folders)
    .where(and(eq(folders.ownerUserId, userId), eq(folders.kind, 'vault')))
  return vaults.some((v) => v.id !== excludeId && v.name.toLowerCase() === name.toLowerCase())
}

/**
 * Subtree folder ids grouped by depth, DEEPEST level first — the deletion
 * order the folders.parent_id self-FK demands. Rows come from
 * fetchFolderSubtrees, so the set is acyclic with the vault as its only root.
 */
function subtreeDeleteLevels(subtree: ReadonlyArray<{ id: string; parentId: string | null }>): string[][] {
  const inSet = new Map(subtree.map((f) => [f.id, f]))
  const depths = new Map<string, number>()
  const depthOf = (id: string): number => {
    const known = depths.get(id)
    if (known !== undefined) return known
    const row = inSet.get(id)
    const depth = !row || row.parentId === null || !inSet.has(row.parentId) ? 0 : depthOf(row.parentId) + 1
    depths.set(id, depth)
    return depth
  }
  const levels: string[][] = []
  for (const folder of subtree) {
    const depth = depthOf(folder.id)
    ;(levels[depth] ??= []).push(folder.id)
  }
  return levels.filter((l) => l.length > 0).reverse()
}

function vaultMeta(
  vault: { id: string; name: string; ownerUserId: string; createdAt: number },
  role: Role,
): VaultMeta {
  return {
    id: vault.id,
    name: vault.name,
    ownerUserId: vault.ownerUserId,
    role,
    createdAt: vault.createdAt,
  }
}

// ---------------------------------------------------------------------------
// Agents (Settings → Agents): mint returns the raw key exactly once.
// ---------------------------------------------------------------------------

async function handleAgents(db: Db, request: Request, url: URL): Promise<Response> {
  const principal = await resolvePrincipal(request, db)
  if (!principal) return json({ error: 'unauthenticated' }, 401)
  // Only humans manage agents — an agent key cannot mint or revoke keys.
  if (principal.type !== 'user') return json({ error: 'forbidden' }, 403)

  if (url.pathname === '/api/agents') {
    if (request.method === 'GET') {
      const rows = await db.select().from(agents).where(eq(agents.ownerUserId, principal.id))
      return json({
        agents: rows.map((a) => ({ id: a.id, name: a.name, createdAt: a.createdAt, revokedAt: a.revokedAt })),
      })
    }
    if (request.method === 'POST') {
      const payload = await readJson<{ name?: unknown }>(request)
      const name = typeof payload?.name === 'string' ? payload.name.trim() : ''
      if (name === '') return json({ error: 'bad-name' }, 400)
      const key = `gd_sk_${randomToken(32)}`
      const agent = {
        id: crypto.randomUUID(),
        ownerUserId: principal.id,
        name,
        keyHash: await sha256Hex(key),
        scope: 'inherit',
        createdAt: Date.now(),
        revokedAt: null,
      }
      await db.insert(agents).values(agent)
      // The raw key is returned exactly once; only its hash is stored.
      return json({ id: agent.id, name: agent.name, createdAt: agent.createdAt, key })
    }
    return json({ error: 'method-not-allowed' }, 405)
  }

  const match = url.pathname.match(/^\/api\/agents\/([^/]+)$/)
  if (match && request.method === 'DELETE') {
    await db
      .update(agents)
      .set({ revokedAt: Date.now() })
      .where(and(eq(agents.id, match[1]!), eq(agents.ownerUserId, principal.id)))
    return json({ ok: true })
  }
  return json({ error: 'not-found' }, 404)
}

// ---------------------------------------------------------------------------
// Notifications (bell/inbox; D1-polled per SPEC §9)
// ---------------------------------------------------------------------------

async function handleNotifications(db: Db, request: Request, url: URL): Promise<Response> {
  const principal = await resolvePrincipal(request, db)
  if (!principal) return json({ error: 'unauthenticated' }, 401)
  const userId = effectiveUserId(principal)
  if (userId === null) return json({ error: 'forbidden' }, 403)

  if (url.pathname === '/api/notifications' && request.method === 'GET') {
    const rows = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, userId))
      .orderBy(desc(notifications.createdAt))
      .limit(100)
    return json({
      notifications: rows.map((n) => ({
        id: n.id,
        type: n.type,
        payload: safeParse(n.payloadJson),
        createdAt: n.createdAt,
        readAt: n.readAt,
      })),
    })
  }

  if (url.pathname === '/api/notifications/read' && request.method === 'POST') {
    const payload = await readJson<{ ids?: unknown }>(request)
    const ids = Array.isArray(payload?.ids) ? payload.ids.filter((x): x is string => typeof x === 'string') : null
    const base = and(eq(notifications.userId, userId), isNull(notifications.readAt))
    await db
      .update(notifications)
      .set({ readAt: Date.now() })
      .where(ids && ids.length > 0 ? and(base, inArray(notifications.id, ids)) : base)
    return json({ ok: true })
  }
  return json({ error: 'not-found' }, 404)
}

// ---------------------------------------------------------------------------
// Invites (token routes) + per-user prefs
// ---------------------------------------------------------------------------

/** Secrets the email module needs, lifted off the Worker env once per call. */
function emailEnv(): EmailEnv {
  const appEnv = asAppEnv(env)
  return { RESEND_API_KEY: appEnv.RESEND_API_KEY, EMAIL_FROM: appEnv.EMAIL_FROM }
}

/** Secrets the server analytics module needs (no-key = silent no-op inside). */
function analyticsEnv(): AnalyticsServerEnv {
  const appEnv = asAppEnv(env)
  return { POSTHOG_KEY: appEnv.POSTHOG_KEY, POSTHOG_HOST: appEnv.POSTHOG_HOST }
}

/**
 * cli_push analytics: parse the PushResponse off a clone (mode: edit|suggest)
 * and capture in the background via waitUntil — push latency is unaffected.
 * Best-effort by construction: failures log, never surface.
 */
function trackCliPush(response: Response, docId: string, principal: Principal): void {
  const task = (async () => {
    try {
      const push = (await response.clone().json()) as PushResponse
      if (!push.ok) return
      await captureServerEvent(
        'cli_push',
        principal.id,
        { docId, mode: push.mode, principalType: principal.type },
        { env: analyticsEnv() },
      )
    } catch (err) {
      console.error('cli_push analytics failed:', err)
    }
  })()
  try {
    waitUntil(task)
  } catch {
    void task // outside a request context (tests) — the task never rejects
  }
}

/**
 * /api/invites/:token — GET (public landing payload), POST /accept (session
 * required; token possession = authority), DELETE (owner revoke).
 */
async function handleInviteToken(db: Db, request: Request, token: string, isAccept: boolean): Promise<Response> {
  if (isAccept) {
    if (request.method !== 'POST') return json({ error: 'method-not-allowed' }, 405)
    const principal = await resolvePrincipal(request, db)
    if (!principal) return json({ error: 'unauthenticated' }, 401)
    return acceptInvite(db, token, principal)
  }
  if (request.method === 'GET') return getInvitePublic(db, token)
  if (request.method === 'DELETE') {
    const principal = await resolvePrincipal(request, db)
    if (!principal) return json({ error: 'unauthenticated' }, 401)
    return revokeInvite(db, token, principal)
  }
  return json({ error: 'method-not-allowed' }, 405)
}

/**
 * /api/prefs — GET/POST the caller's user_prefs row. Missing row = defaults
 * (email notifications ON). Only gates non-transactional email (mentions).
 */
async function handlePrefs(db: Db, request: Request): Promise<Response> {
  const principal = await resolvePrincipal(request, db)
  if (!principal) return json({ error: 'unauthenticated' }, 401)
  const userId = effectiveUserId(principal)
  if (userId === null) return json({ error: 'forbidden' }, 403)

  if (request.method === 'GET') {
    const row = (await db.select().from(userPrefs).where(eq(userPrefs.userId, userId)).limit(1))[0]
    return json({ emailNotifications: row ? row.emailNotifications !== 0 : true })
  }
  if (request.method === 'POST') {
    const payload = await readJson<{ emailNotifications?: unknown }>(request)
    if (typeof payload?.emailNotifications !== 'boolean') return json({ error: 'bad-request' }, 400)
    const value = payload.emailNotifications ? 1 : 0
    await db
      .insert(userPrefs)
      .values({ userId, emailNotifications: value })
      .onConflictDoUpdate({ target: userPrefs.userId, set: { emailNotifications: value } })
    return json({ emailNotifications: payload.emailNotifications })
  }
  return json({ error: 'method-not-allowed' }, 405)
}

/**
 * Insert notification rows for @[userId] mentions in a comment/reply body.
 * Returns the user ids actually notified so follow-up hooks (comment-reply)
 * can avoid double-notifying the same person for the same write.
 */
async function notifyMentions(
  db: Db,
  requestBody: string,
  response: Response,
  target: CommentTarget,
  author: Principal,
  origin: string,
): Promise<string[]> {
  try {
    const payload = safeParse(requestBody) as { body?: unknown } | null
    if (!payload || typeof payload.body !== 'string') return []
    const mentioned = [...payload.body.matchAll(/@\[([^\]]+)\]/g)].map((m) => m[1]!)
    if (mentioned.length === 0) return []

    const authorUserId = effectiveUserId(author)
    const unique = [...new Set(mentioned)].filter((id) => id !== authorUserId && id !== author.id)
    if (unique.length === 0) return []
    const existing = await db.select({ id: user.id }).from(user).where(inArray(user.id, unique))
    if (existing.length === 0) return []

    let commentId: string | null = null
    try {
      const created = (await response.clone().json()) as { id?: unknown }
      if (typeof created.id === 'string') commentId = created.id
    } catch {
      // non-JSON response — keep commentId null
    }

    const userIds = existing.map((u) => u.id)
    await notify(db, userIds, 'mention', {
      ...commentTargetPayload(target),
      commentId,
      by: author.id,
      byName: author.name,
      excerpt: payload.body.slice(0, 200),
    })
    // Same pipeline as invites: a short mention email with a deep link, per
    // user, unless they opted out (user_prefs). Best-effort by construction.
    await sendMentionEmails(
      db,
      userIds,
      {
        byName: author.name,
        docTitle: target.label,
        excerpt: payload.body.slice(0, 200),
        origin,
        deepLink: target.deepLink,
      },
      emailEnv(),
    )
    return userIds
  } catch (err) {
    // Notifications are best-effort; never fail the comment write.
    console.error('mention notification failed:', err)
    return []
  }
}

/**
 * Resolve a comment/suggestion authorId (user or agent) to the user who
 * should receive notifications about it: users map to themselves, agents to
 * the human they act for. Null when the id matches no live principal.
 */
async function notifiableUserId(db: Db, principalId: string): Promise<string | null> {
  const u = (await db.select({ id: user.id }).from(user).where(eq(user.id, principalId)).limit(1))[0]
  if (u) return u.id
  const agent = (await db.select().from(agents).where(eq(agents.id, principalId)).limit(1))[0]
  return agent?.ownerUserId ?? null
}

/**
 * comment-reply notification (SPEC §9): notify the root comment's author.
 * The DO surfaces the root authorId on the reply response via the
 * HEADER_COMMENT_AUTHOR trusted header (it has no D1 access of its own).
 * Skips self-replies and authors already notified by an @mention.
 */
async function notifyCommentReply(
  db: Db,
  response: Response,
  commentTarget: CommentTarget,
  author: Principal,
  alreadyNotified: string[],
): Promise<void> {
  try {
    const rootAuthorId = response.headers.get(HEADER_COMMENT_AUTHOR)
    if (!rootAuthorId) return
    const targetUserId = await notifiableUserId(db, rootAuthorId)
    // Skip self: the reply author (their agent's owner counts as them too).
    if (!targetUserId || targetUserId === author.id || targetUserId === effectiveUserId(author)) return
    if (alreadyNotified.includes(targetUserId)) return

    let commentId: string | null = null
    let excerpt = ''
    try {
      const reply = (await response.clone().json()) as { id?: unknown; body?: unknown }
      if (typeof reply.id === 'string') commentId = reply.id
      if (typeof reply.body === 'string') excerpt = reply.body.slice(0, 200)
    } catch {
      // non-JSON response — keep defaults
    }
    await notify(db, [targetUserId], 'comment-reply', {
      ...commentTargetPayload(commentTarget),
      commentId,
      by: author.id,
      byName: author.name,
      excerpt,
    })
  } catch (err) {
    console.error('comment-reply notification failed:', err)
  }
}

function docCommentTarget(doc: DocRow): CommentTarget {
  return { kind: 'doc', id: doc.id, label: docStem(doc), deepLink: `/d/${encodeURIComponent(doc.id)}` }
}

function commentTargetPayload(target: CommentTarget): Record<string, unknown> {
  if (target.kind === 'doc') return { docId: target.id, docTitle: target.label }
  return {
    assetId: target.id,
    assetTitle: target.label,
    folderId: target.folderId ?? null,
    filename: target.filename ?? target.label,
    deepLink: target.deepLink,
  }
}

/**
 * suggestion-on-your-doc notification (SPEC §9), for pushes that landed as a
 * suggestion set (`ink push --suggest`, or any suggester-role push). Skips
 * the owner pushing to their own doc — but an owner's agent suggesting on it
 * still notifies (the attribution is the agent, which is the point).
 */
async function notifySuggestionPush(db: Db, response: Response, doc: DocRow, author: Principal): Promise<void> {
  try {
    if (doc.ownerUserId === author.id) return
    let push: PushResponse
    try {
      push = (await response.clone().json()) as PushResponse
    } catch {
      return
    }
    if (!push.ok || push.mode !== 'suggest') return
    await notify(db, [doc.ownerUserId], 'suggestion', {
      docId: doc.id,
      docTitle: docStem(doc),
      suggestionId: push.suggestionId,
      by: author.id,
      byName: author.name,
    })
  } catch (err) {
    console.error('suggestion notification failed:', err)
  }
}

async function notify(db: Db, userIds: string[], type: string, payload: unknown): Promise<void> {
  if (userIds.length === 0) return
  await db.insert(notifications).values(
    userIds.map((userId) => ({
      id: crypto.randomUUID(),
      userId,
      type,
      payloadJson: JSON.stringify(payload),
      createdAt: Date.now(),
      readAt: null,
    })),
  )
}

// ---------------------------------------------------------------------------
// DO proxy
// ---------------------------------------------------------------------------

/** Proxy a doc-scoped request to its DocDO with trusted identity headers. */
async function forwardToDoc(
  request: Request,
  docId: string,
  subPath: string,
  search: string,
  auth: AuthContext,
  bodyText?: string,
): Promise<Response> {
  const namespace = asAppEnv(env).DocDO as unknown as DurableObjectNamespace<Server<Env>>
  const stub = await getServerByName(namespace, docId)
  const headers = trustedHeaders(auth)
  const contentType = request.headers.get('content-type')
  if (contentType) headers.set('content-type', contentType)
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
  const internal = new Request(`https://do${subPath}${search}`, {
    method: request.method,
    headers,
    body: hasBody ? (bodyText ?? request.body) : undefined,
  })
  return stub.fetch(internal)
}

/** Proxy an asset-comment request to the HtmlDocDO keyed by immutable asset id. */
async function forwardToAssetDoc(
  request: Request,
  assetId: string,
  currentVersionId: string | null,
  subPath: string,
  search: string,
  auth: AuthContext,
  bodyText?: string,
): Promise<Response> {
  const namespace = asAppEnv(env).HtmlDocDO as unknown as DurableObjectNamespace<Server<Env>>
  const stub = await getServerByName(namespace, assetId)
  const headers = trustedHeaders(auth)
  headers.set(HEADER_ASSET, assetId)
  if (currentVersionId) headers.set(HEADER_ASSET_VERSION, currentVersionId)
  const contentType = request.headers.get('content-type')
  if (contentType) headers.set('content-type', contentType)
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
  const internal = new Request(`https://do${subPath}${search}`, {
    method: request.method,
    headers,
    body: hasBody ? (bodyText ?? request.body) : undefined,
  })
  return stub.fetch(internal)
}

/**
 * Best-effort lifecycle call to a doc's DO (SPEC §11): doc-deleted broadcast
 * + teardown, and targeted connection drops on access revocation. Reuses the
 * forwardToDoc stub plumbing with a synthetic POST. Failures are logged,
 * never surfaced — D1 stays the source of truth and the Worker re-validates
 * every upgrade and REST call regardless.
 */
async function docAdminCall(
  docId: string,
  path: '/admin/doc-deleted' | '/admin/recheck',
  auth: AuthContext,
  payload?: { principalIds: string[] },
): Promise<void> {
  try {
    const synthetic = new Request(`https://do${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    })
    await forwardToDoc(synthetic, docId, path, '', auth, JSON.stringify(payload ?? {}))
  } catch (err) {
    console.error(`doc admin call ${path} failed:`, err)
  }
}

/**
 * Ask the DO(s) behind a doc or folder to close the given principals' live
 * connections (4403). Folder-level revocations fan out to every doc in the
 * folder's ENTIRE SUBTREE — grants inherit down the tree, so revoking on a
 * folder can revoke access to docs in any descendant (folder trees are
 * single-owner, so the owner-gated admin endpoint accepts the same auth
 * context for every doc).
 */
async function recheckDocConnections(
  db: Db,
  targetType: 'doc' | 'folder',
  targetId: string,
  auth: AuthContext,
  principalIds: string[],
): Promise<void> {
  if (targetType === 'doc') {
    await docAdminCall(targetId, '/admin/recheck', auth, { principalIds })
    return
  }
  await recheckFolderSubtree(db, targetId, auth, principalIds)
}

/** Recheck live connections on every (live) doc in a folder's subtree. */
async function recheckFolderSubtree(
  db: Db,
  folderId: string,
  auth: AuthContext,
  principalIds: string[],
): Promise<void> {
  const subtree = await fetchFolderSubtrees(db, [folderId])
  if (subtree.length === 0) return
  const docRows = await db
    .select({ id: docs.id })
    .from(docs)
    .where(
      and(
        inArray(
          docs.folderId,
          subtree.map((f) => f.id),
        ),
        isNull(docs.deletedAt),
      ),
    )
  for (const row of docRows) {
    await docAdminCall(row.id, '/admin/recheck', auth, { principalIds })
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function randomToken(bytes = 24): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
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
