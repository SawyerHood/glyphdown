import type {
  AcceptResponse,
  AssetMeta,
  Comment,
  CommentReply,
  DocMeta,
  FolderMeta,
  Principal,
  Role,
  SearchResult,
  SuggestionRecord,
  UploadAssetResponse,
  VersionMeta,
} from '@glyphdown/protocol'

/**
 * Typed client for the Worker's /api surface (see @glyphdown/protocol and
 * src/api/router.ts). Doc-scoped calls accept an optional share token, sent
 * as the X-Glyphdown-Share header so share-link visitors can read/act per the
 * link's role without a session.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`${code} (${status})`)
  }
}

/** Suggestion record as stored by the DO (adds the accept-time outcome). */
export type SuggestionWithMeta = SuggestionRecord & { outdatedParts?: number }

/** Folder rows now carry parentId (nested folders) — see protocol FolderMeta. */
export type FolderInfo = FolderMeta

export interface MemberInfo {
  principalId: string
  principalType: 'user' | 'agent'
  role: Role
  name: string
  email?: string
}

export interface ShareLinkInfo {
  token: string
  role: Role
  createdAt: number
}

export interface AgentInfo {
  id: string
  name: string
  createdAt: number
  revokedAt: number | null
}

export interface MintedAgent {
  id: string
  name: string
  createdAt: number
  key: string
}

export interface NotificationItem {
  id: string
  type: string
  payload: Record<string, unknown> | null
  createdAt: number
  readAt: number | null
}

interface RequestOptions {
  method?: string
  body?: unknown
  share?: string | undefined
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {}
  if (opts.body !== undefined) headers['content-type'] = 'application/json'
  if (opts.share) headers['x-glyphdown-share'] = opts.share
  const res = await fetch(path, {
    method: opts.method ?? 'GET',
    headers,
    credentials: 'same-origin',
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  })
  if (!res.ok) {
    let code = `http-${res.status}`
    try {
      const data = (await res.json()) as { error?: unknown; reason?: unknown }
      if (typeof data.error === 'string') code = data.error
      else if (typeof data.reason === 'string') code = data.reason
    } catch {
      // non-JSON error body
    }
    throw new ApiError(res.status, code)
  }
  const contentType = res.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) return (await res.json()) as T
  return (await res.text()) as unknown as T
}

const doc = (id: string, sub = '') => `/api/docs/${encodeURIComponent(id)}${sub}`

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export interface AdminStats {
  users: number
  docs: { created: number; active: number }
}

/** 404s (ApiError) for everyone but allowlisted admins — see api/admin.ts. */
export const getAdminStats = () => request<AdminStats>('/api/admin/stats')

export async function fetchMe(): Promise<Principal | null> {
  try {
    const { principal } = await request<{ principal: Principal }>('/api/me')
    return principal
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null
    throw err
  }
}

// ---------------------------------------------------------------------------
// Docs & folders
// ---------------------------------------------------------------------------

export const listDocs = () => request<{ docs: DocMeta[] }>('/api/docs').then((r) => r.docs)

/**
 * `filename` (a slug stem or `<slug>.md`) wins over `title`; a bare title is
 * slugified server-side. Scope collisions on create are auto-suffixed — read
 * the canonical name off the returned DocMeta.
 */
export const createDoc = (input: { filename?: string; title?: string; folderId?: string }) =>
  request<DocMeta>('/api/docs', { method: 'POST', body: input })

export const getDoc = (id: string, share?: string) => request<DocMeta>(doc(id), { share })

/**
 * Rename ({ filename }: validated slug; legacy { title } is slugified) and/or
 * move ({ folderId }). Renames and moves 409 `filename-taken` on a collision
 * in the target scope — surface it, the server never silently suffixes here.
 */
export const patchDoc = (id: string, input: { filename?: string; title?: string; folderId?: string | null }) =>
  request<DocMeta>(doc(id), { method: 'PATCH', body: input })

export const deleteDoc = (id: string) => request<{ ok: true }>(doc(id), { method: 'DELETE' })

export const listFolders = () => request<{ folders: FolderInfo[] }>('/api/folders').then((r) => r.folders)

/** Accepts a bare name (root folder) or { name, parentId } to nest. */
export const createFolder = (input: string | { name: string; parentId?: string | null }) => {
  const body =
    typeof input === 'string'
      ? { name: input }
      : { name: input.name, ...(input.parentId ? { parentId: input.parentId } : {}) }
  return request<FolderInfo>('/api/folders', { method: 'POST', body })
}

/** Rename and/or move (parentId: null = move to root). Owner-only; moves are cycle/depth-guarded server-side. */
export const updateFolder = (id: string, input: { name?: string; parentId?: string | null }) =>
  request<FolderInfo>(`/api/folders/${encodeURIComponent(id)}`, { method: 'PATCH', body: input })

export const renameFolder = (id: string, name: string) => updateFolder(id, { name })

export const moveFolder = (id: string, parentId: string | null) => updateFolder(id, { parentId })

export const deleteFolder = (id: string) =>
  request<{ ok: true }>(`/api/folders/${encodeURIComponent(id)}`, { method: 'DELETE' })

// ---------------------------------------------------------------------------
// Search & backlinks
// ---------------------------------------------------------------------------

/** Full-text search over the caller's accessible docs (snippets carry «hit» markers). */
export const searchDocs = (q: string) =>
  request<{ results: SearchResult[] }>(`/api/search?q=${encodeURIComponent(q)}`).then((r) => r.results)

/** Docs (visible to the caller) whose bodies wiki-link [[this doc's title]]. */
export const listBacklinks = (docId: string, share?: string) =>
  request<{ docs: DocMeta[] }>(doc(docId, '/backlinks'), { share }).then((r) => r.docs)

// ---------------------------------------------------------------------------
// Sharing
// ---------------------------------------------------------------------------

export const listMembers = (docId: string, share?: string) =>
  request<{ members: MemberInfo[] }>(doc(docId, '/members'), { share }).then((r) => r.members)

export const addMember = (docId: string, input: { email?: string; agentId?: string; role: Role }) =>
  request<{ principalId: string; principalType: string; role: Role }>(doc(docId, '/members'), {
    method: 'POST',
    body: input,
  })

export const removeMember = (docId: string, principalId: string) =>
  request<{ ok: true }>(doc(docId, `/members/${encodeURIComponent(principalId)}`), { method: 'DELETE' })

export const listShareLinks = (docId: string) =>
  request<{ shareLinks: ShareLinkInfo[] }>(doc(docId, '/share-links')).then((r) => r.shareLinks)

export const createShareLink = (docId: string, role: Role) =>
  request<ShareLinkInfo>(doc(docId, '/share-links'), { method: 'POST', body: { role } })

export const revokeShareLink = (docId: string, token: string) =>
  request<{ ok: true }>(doc(docId, `/share-links/${encodeURIComponent(token)}`), { method: 'DELETE' })

// ---------------------------------------------------------------------------
// Email invites (work for non-users too — they get an /invite/<token> email)
// ---------------------------------------------------------------------------

/**
 * 'added'  — the email already has an account; membership granted now.
 * 'invited' — no account; a pending invite was created. `url` is the landing
 * link (always present for 'invited' so the UI can offer copy-link when
 * email delivery is unconfigured — check `emailSent`).
 */
export interface InviteResult {
  status: 'added' | 'invited'
  role: Role
  email: string
  emailSent: boolean
  token?: string
  url?: string
  principalId?: string
}

export interface PendingInvite {
  token: string
  email: string
  role: Role
  createdAt: number
}

export interface PublicInvite {
  targetType: 'doc' | 'folder'
  targetName: string
  inviterName: string
  role: Role
  accepted: boolean
}

export interface AcceptInviteResult {
  ok: true
  targetType: 'doc' | 'folder'
  targetId: string
  role: Role
}

export const createInvite = (docId: string, input: { email: string; role: Role }) =>
  request<InviteResult>(doc(docId, '/invites'), { method: 'POST', body: input })

export const createFolderInvite = (folderId: string, input: { email: string; role: Role }) =>
  request<InviteResult>(`/api/folders/${encodeURIComponent(folderId)}/invites`, { method: 'POST', body: input })

/** Pending (unaccepted, unrevoked) invites on a doc — owner-only. */
export const listInvites = (docId: string) =>
  request<{ invites: PendingInvite[] }>(doc(docId, '/invites')).then((r) => r.invites)

export const listFolderInvites = (folderId: string) =>
  request<{ invites: PendingInvite[] }>(`/api/folders/${encodeURIComponent(folderId)}/invites`).then((r) => r.invites)

/** Public: the landing page payload (404s map to ApiError). */
export const getInvite = (token: string) => request<PublicInvite>(`/api/invites/${encodeURIComponent(token)}`)

export const acceptInvite = (token: string) =>
  request<AcceptInviteResult>(`/api/invites/${encodeURIComponent(token)}/accept`, { method: 'POST', body: {} })

export const revokeInvite = (token: string) =>
  request<{ ok: true }>(`/api/invites/${encodeURIComponent(token)}`, { method: 'DELETE' })

// ---------------------------------------------------------------------------
// Per-user preferences
// ---------------------------------------------------------------------------

export const getPrefs = () => request<{ emailNotifications: boolean }>('/api/prefs')

export const setPrefs = (input: { emailNotifications: boolean }) =>
  request<{ emailNotifications: boolean }>('/api/prefs', { method: 'POST', body: input })

// ---------------------------------------------------------------------------
// Agents & notifications
// ---------------------------------------------------------------------------

export const listAgents = () => request<{ agents: AgentInfo[] }>('/api/agents').then((r) => r.agents)

export const mintAgent = (name: string) => request<MintedAgent>('/api/agents', { method: 'POST', body: { name } })

export const revokeAgent = (id: string) =>
  request<{ ok: true }>(`/api/agents/${encodeURIComponent(id)}`, { method: 'DELETE' })

export const listNotifications = () =>
  request<{ notifications: NotificationItem[] }>('/api/notifications').then((r) => r.notifications)

export const markNotificationsRead = (ids?: string[]) =>
  request<{ ok: true }>('/api/notifications/read', { method: 'POST', body: { ids } })

// ---------------------------------------------------------------------------
// Comments (proxied to the DocDO)
// ---------------------------------------------------------------------------

export const listComments = (docId: string, share?: string) =>
  request<{ comments: Comment[] }>(doc(docId, '/comments'), { share }).then((r) => r.comments)

export const createComment = (docId: string, input: { body: string; range?: { start: number; end: number } }, share?: string) =>
  request<Comment>(doc(docId, '/comments'), { method: 'POST', body: input, share })

export const replyToComment = (docId: string, commentId: string, body: string, share?: string) =>
  request<CommentReply>(doc(docId, `/comments/${encodeURIComponent(commentId)}/replies`), {
    method: 'POST',
    body: { body },
    share,
  })

export const setCommentResolved = (docId: string, commentId: string, resolved: boolean, share?: string) =>
  request<{ resolved: boolean }>(doc(docId, `/comments/${encodeURIComponent(commentId)}/resolve`), {
    method: 'POST',
    body: { resolved },
    share,
  })

export const toggleCommentReaction = (docId: string, commentId: string, emoji: string, share?: string) =>
  request<Comment>(doc(docId, `/comments/${encodeURIComponent(commentId)}/reactions`), {
    method: 'POST',
    body: { emoji },
    share,
  })

export const reattachComment = (docId: string, commentId: string, range: { start: number; end: number }, share?: string) =>
  request<Comment>(doc(docId, `/comments/${encodeURIComponent(commentId)}/reattach`), {
    method: 'POST',
    body: range,
    share,
  })

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

export const listSuggestions = (docId: string, share?: string) =>
  request<{ suggestions: SuggestionWithMeta[] }>(doc(docId, '/suggestions'), { share }).then((r) => r.suggestions)

export const acceptSuggestionApi = (docId: string, id: string) =>
  request<AcceptResponse>(doc(docId, `/suggestions/${encodeURIComponent(id)}/accept`), { method: 'POST', body: {} })

export const rejectSuggestionApi = (docId: string, id: string, share?: string) =>
  request<{ ok: true }>(doc(docId, `/suggestions/${encodeURIComponent(id)}/reject`), {
    method: 'POST',
    body: {},
    share,
  })

// ---------------------------------------------------------------------------
// Assets (images in R2, scoped to the doc's folder — or the doc itself)
// ---------------------------------------------------------------------------

/**
 * URL an <img> can fetch a doc-relative asset from. Share-link sessions ride
 * the token as a query param — image requests can't carry headers.
 */
export function assetUrl(docId: string, filename: string, share?: string): string {
  const base = doc(docId, `/assets/${encodeURIComponent(filename)}`)
  return share ? `${base}?share=${encodeURIComponent(share)}` : base
}

/** Raw-binary upload (multipart not required); editor+ only, image/* ≤ 10 MB. */
export async function uploadAsset(
  docId: string,
  filename: string,
  blob: Blob,
  opts: { share?: string | undefined; overwrite?: boolean } = {},
): Promise<UploadAssetResponse> {
  const params = new URLSearchParams({ filename })
  if (opts.overwrite) params.set('overwrite', 'true')
  const headers: Record<string, string> = { 'content-type': blob.type || 'application/octet-stream' }
  if (opts.share) headers['x-glyphdown-share'] = opts.share
  const res = await fetch(`${doc(docId, '/assets')}?${params}`, {
    method: 'POST',
    headers,
    credentials: 'same-origin',
    body: blob,
  })
  if (!res.ok) {
    let code = `http-${res.status}`
    try {
      const data = (await res.json()) as { error?: unknown }
      if (typeof data.error === 'string') code = data.error
    } catch {
      // non-JSON error body
    }
    throw new ApiError(res.status, code)
  }
  return (await res.json()) as UploadAssetResponse
}

export const listAssets = (docId: string, share?: string) =>
  request<{ assets: AssetMeta[] }>(doc(docId, '/assets'), { share }).then((r) => r.assets)

export const deleteAsset = (docId: string, filename: string, share?: string) =>
  request<{ ok: true }>(doc(docId, `/assets/${encodeURIComponent(filename)}`), { method: 'DELETE', share })

// Folder-scoped asset surface (the file-tree sidebar): signed-in only — no
// share-token plumbing, same-origin cookies authenticate <img>/<a> fetches.

const folderAsset = (folderId: string, filename: string) =>
  `/api/folders/${encodeURIComponent(folderId)}/assets/${encodeURIComponent(filename)}`

/** URL an <img> / download anchor can fetch a folder asset from. */
export const folderAssetUrl = folderAsset

export const listFolderAssets = (folderId: string) =>
  request<{ assets: AssetMeta[] }>(`/api/folders/${encodeURIComponent(folderId)}/assets`).then((r) => r.assets)

export const deleteFolderAsset = (folderId: string, filename: string) =>
  request<{ ok: true }>(folderAsset(folderId, filename), { method: 'DELETE' })

// ---------------------------------------------------------------------------
// Versions / history
// ---------------------------------------------------------------------------

export const listVersions = (docId: string, share?: string) =>
  request<{ versions: VersionMeta[] }>(doc(docId, '/versions'), { share }).then((r) => r.versions)

export const getVersionText = (docId: string, versionId: string, share?: string) =>
  request<{ text: string }>(doc(docId, `/versions/${encodeURIComponent(versionId)}`), { share }).then((r) => r.text)

export const createNamedVersion = (docId: string, name: string) =>
  request<VersionMeta>(doc(docId, '/versions'), { method: 'POST', body: { name } })

export const restoreVersion = (docId: string, versionId: string) =>
  request<{ ok: true }>(doc(docId, `/versions/${encodeURIComponent(versionId)}/restore`), { method: 'POST', body: {} })

export const getDocContent = (docId: string, share?: string) =>
  request<string>(doc(docId, '/content?view=working'), { share })
