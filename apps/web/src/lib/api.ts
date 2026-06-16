import type {
  AcceptResponse,
  AssetMeta,
  Comment,
  CommentReply,
  CreateAssetCommentRequest,
  DocMeta,
  FolderListingResponse,
  FolderMeta,
  NodeAnchor,
  Principal,
  PushResponse,
  Role,
  SearchResult,
  SuggestionRecord,
  UploadAssetResponse,
  VaultMeta,
  VersionMeta,
} from '@glyphdown/protocol'
import { normalizeEol } from '@glyphdown/core'

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

export type FeedbackType = 'feature' | 'bug'

export interface FeedbackItem {
  id: string
  type: FeedbackType
  body: string
  page: string | null
  createdAt: number
  user: { id: string; name: string; email: string | null }
  filedByAgent: boolean
}

export const submitFeedback = (input: { type: FeedbackType; body: string; page?: string }) =>
  request<{ id: string; ok: true }>('/api/feedback', { method: 'POST', body: input })

/** Admin-only (404s otherwise), newest first. */
export const getAdminFeedback = () =>
  request<{ feedback: FeedbackItem[] }>('/api/admin/feedback').then((r) => r.feedback)

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

/** { name, parentId } — a parent is REQUIRED now (the root level holds only vaults; the server 400s without one). */
export const createFolder = (input: string | { name: string; parentId?: string | null }) => {
  const body =
    typeof input === 'string'
      ? { name: input }
      : { name: input.name, ...(input.parentId ? { parentId: input.parentId } : {}) }
  return request<FolderInfo>('/api/folders', { method: 'POST', body })
}

/** Rename and/or move. Owner-only; moves are cycle/depth-guarded server-side, parentId null is rejected (no new roots). */
export const updateFolder = (id: string, input: { name?: string; parentId?: string | null }) =>
  request<FolderInfo>(`/api/folders/${encodeURIComponent(id)}`, { method: 'PATCH', body: input })

export const renameFolder = (id: string, name: string) => updateFolder(id, { name })

export const moveFolder = (id: string, parentId: string | null) => updateFolder(id, { parentId })

export const deleteFolder = (id: string) =>
  request<{ ok: true }>(`/api/folders/${encodeURIComponent(id)}`, { method: 'DELETE' })

/**
 * The folder share-link landing page's read (/f/:folderId): the folder plus
 * its whole live subtree. The ONE folder read that takes a share token —
 * anonymous visitors on a folder/vault link read through it (viewer-capped),
 * signed-in visitors get max(own grants, link role).
 */
export const getFolderListing = (folderId: string, share?: string) =>
  request<FolderListingResponse>(`/api/folders/${encodeURIComponent(folderId)}/listing`, { share })

// ---------------------------------------------------------------------------
// Vaults (root namespaces — see protocol VaultMeta; the switcher derives its
// list from ['folders'], these are the mutation routes)
// ---------------------------------------------------------------------------

/** 409 `name-taken` on a case-insensitive collision with another of your vaults. */
export const createVault = (name: string) => request<VaultMeta>('/api/vaults', { method: 'POST', body: { name } })

/**
 * Owner-only. The whole subtree goes to the 30-day trash; 400 `last-vault` /
 * `default-vault` protect the only and the default vault — surface both.
 */
export const deleteVault = (id: string) =>
  request<{ ok: true }>(`/api/vaults/${encodeURIComponent(id)}`, { method: 'DELETE' })

// ---------------------------------------------------------------------------
// Search & backlinks
// ---------------------------------------------------------------------------

/**
 * Full-text search over the caller's accessible docs (snippets carry «hit»
 * markers). `vault` narrows to that vault's subtree server-side — BEFORE the
 * result limit, so scoped results aren't lossy.
 */
export const searchDocs = (q: string, vault?: string) =>
  request<{ results: SearchResult[] }>(
    `/api/search?q=${encodeURIComponent(q)}${vault ? `&vault=${encodeURIComponent(vault)}` : ''}`,
  ).then((r) => r.results)

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

// Folder-scoped sharing (the vault share dialog): same member model as docs,
// one level up — a grant on a vault root covers its entire subtree.

const folderPath = (id: string, sub = '') => `/api/folders/${encodeURIComponent(id)}${sub}`

export const listFolderMembers = (folderId: string, share?: string) =>
  request<{ members: MemberInfo[] }>(folderPath(folderId, '/members'), { share }).then((r) => r.members)

export const addFolderMember = (folderId: string, input: { email?: string; agentId?: string; role: Role }) =>
  request<{ principalId: string; principalType: string; role: Role }>(folderPath(folderId, '/members'), {
    method: 'POST',
    body: input,
  })

export const removeFolderMember = (folderId: string, principalId: string) =>
  request<{ ok: true }>(folderPath(folderId, `/members/${encodeURIComponent(principalId)}`), { method: 'DELETE' })

// Folder share links (the vault share dialog's Links section): same routes as
// doc links one level up — a link on a vault root covers its whole subtree.
// The copyable URL is the landing page: /f/<folderId>?share=<token>.

export const listFolderShareLinks = (folderId: string) =>
  request<{ shareLinks: ShareLinkInfo[] }>(folderPath(folderId, '/share-links')).then((r) => r.shareLinks)

export const createFolderShareLink = (folderId: string, role: Role) =>
  request<ShareLinkInfo>(folderPath(folderId, '/share-links'), { method: 'POST', body: { role } })

export const revokeFolderShareLink = (folderId: string, token: string) =>
  request<{ ok: true }>(folderPath(folderId, `/share-links/${encodeURIComponent(token)}`), { method: 'DELETE' })

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
  /** Copy noun — 'vault' for folder invites whose folder is a vault root. */
  targetKind: 'doc' | 'folder' | 'vault'
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
// Asset comments (REST + polling; HtmlDocDO behind the Worker)
// ---------------------------------------------------------------------------

const docAssetComments = (docId: string, filename: string, sub = '') =>
  doc(docId, `/assets/${encodeURIComponent(filename)}/comments${sub}`)

const folderAssetComments = (folderId: string, filename: string, sub = '') =>
  `${folderAsset(folderId, filename)}/comments${sub}`

export const listAssetComments = (docId: string, filename: string, share?: string) =>
  request<{ comments: Comment[] }>(docAssetComments(docId, filename), { share }).then((r) => r.comments)

export const createAssetComment = (
  docId: string,
  filename: string,
  input: CreateAssetCommentRequest,
  share?: string,
) => request<Comment>(docAssetComments(docId, filename), { method: 'POST', body: input, share })

export const replyToAssetComment = (docId: string, filename: string, commentId: string, body: string, share?: string) =>
  request<CommentReply>(docAssetComments(docId, filename, `/${encodeURIComponent(commentId)}/replies`), {
    method: 'POST',
    body: { body },
    share,
  })

export const setAssetCommentResolved = (
  docId: string,
  filename: string,
  commentId: string,
  resolved: boolean,
  share?: string,
) =>
  request<{ resolved: boolean }>(docAssetComments(docId, filename, `/${encodeURIComponent(commentId)}/resolve`), {
    method: 'POST',
    body: { resolved },
    share,
  })

export const toggleAssetCommentReaction = (
  docId: string,
  filename: string,
  commentId: string,
  emoji: string,
  share?: string,
) =>
  request<Comment>(docAssetComments(docId, filename, `/${encodeURIComponent(commentId)}/reactions`), {
    method: 'POST',
    body: { emoji },
    share,
  })

export const reattachAssetComment = (
  docId: string,
  filename: string,
  commentId: string,
  input: { nodeAnchor: NodeAnchor },
  share?: string,
) =>
  request<Comment>(docAssetComments(docId, filename, `/${encodeURIComponent(commentId)}/reattach`), {
    method: 'POST',
    body: input,
    share,
  })

export const listFolderAssetComments = (folderId: string, filename: string, share?: string) =>
  request<{ comments: Comment[] }>(folderAssetComments(folderId, filename), { share }).then((r) => r.comments)

export const createFolderAssetComment = (
  folderId: string,
  filename: string,
  input: CreateAssetCommentRequest,
  share?: string,
) => request<Comment>(folderAssetComments(folderId, filename), { method: 'POST', body: input, share })

export const replyToFolderAssetComment = (
  folderId: string,
  filename: string,
  commentId: string,
  body: string,
  share?: string,
) =>
  request<CommentReply>(folderAssetComments(folderId, filename, `/${encodeURIComponent(commentId)}/replies`), {
    method: 'POST',
    body: { body },
    share,
  })

export const setFolderAssetCommentResolved = (
  folderId: string,
  filename: string,
  commentId: string,
  resolved: boolean,
  share?: string,
) =>
  request<{ resolved: boolean }>(folderAssetComments(folderId, filename, `/${encodeURIComponent(commentId)}/resolve`), {
    method: 'POST',
    body: { resolved },
    share,
  })

export const toggleFolderAssetCommentReaction = (
  folderId: string,
  filename: string,
  commentId: string,
  emoji: string,
  share?: string,
) =>
  request<Comment>(folderAssetComments(folderId, filename, `/${encodeURIComponent(commentId)}/reactions`), {
    method: 'POST',
    body: { emoji },
    share,
  })

export const reattachFolderAssetComment = (
  folderId: string,
  filename: string,
  commentId: string,
  input: { nodeAnchor: NodeAnchor },
  share?: string,
) =>
  request<Comment>(folderAssetComments(folderId, filename, `/${encodeURIComponent(commentId)}/reattach`), {
    method: 'POST',
    body: input,
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

// Folder-scoped asset surface. Signed-in same-origin requests ride cookies;
// folder share-link viewers pass the token as ?share= because iframes/img/a
// requests cannot carry custom headers.

const folderAsset = (folderId: string, filename: string) =>
  `/api/folders/${encodeURIComponent(folderId)}/assets/${encodeURIComponent(filename)}`

/** URL an <img> / download anchor can fetch a folder asset from. */
export function folderAssetUrl(folderId: string, filename: string, share?: string): string {
  const base = folderAsset(folderId, filename)
  return share ? `${base}?share=${encodeURIComponent(share)}` : base
}

export const listFolderAssets = (folderId: string, share?: string) =>
  request<{ assets: AssetMeta[] }>(`/api/folders/${encodeURIComponent(folderId)}/assets`, { share }).then((r) => r.assets)

/** Raw-binary folder asset upload; editor+ only, image/* or text/html ≤ 10 MB. */
export async function uploadFolderAsset(
  folderId: string,
  filename: string,
  blob: Blob,
  opts: { overwrite?: boolean } = {},
): Promise<UploadAssetResponse> {
  const params = new URLSearchParams({ filename })
  if (opts.overwrite) params.set('overwrite', 'true')
  const res = await fetch(`/api/folders/${encodeURIComponent(folderId)}/assets?${params}`, {
    method: 'POST',
    headers: { 'content-type': blob.type || 'application/octet-stream' },
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

export const deleteFolderAsset = (folderId: string, filename: string) =>
  request<{ ok: true }>(folderAsset(folderId, filename), { method: 'DELETE' })

export interface HtmlCommentingView {
  html: string
  nonce: string
}

export async function fetchFolderAssetCommentingView(
  folderId: string,
  filename: string,
  share?: string,
): Promise<HtmlCommentingView> {
  const headers: Record<string, string> = {}
  if (share) headers['x-glyphdown-share'] = share
  const res = await fetch(`${folderAsset(folderId, filename)}/commenting-view`, {
    method: 'GET',
    headers,
    credentials: 'same-origin',
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
  return { html: await res.text(), nonce: res.headers.get('x-glyphdown-view-nonce') ?? '' }
}

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

/** Replace a doc's working text through the same merge-aware push endpoint the CLI uses. */
export async function pushDocContent(docId: string, newText: string): Promise<Extract<PushResponse, { ok: true }>> {
  const baseText = normalizeEol(await getDocContent(docId))
  const body = {
    newText: normalizeEol(newText),
    baseHash: await sha256Hex(baseText),
    baseText,
  }
  const res = await fetch(doc(docId, '/push'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let data: PushResponse | null = null
  try {
    data = JSON.parse(text) as PushResponse
  } catch {
    // non-JSON error body
  }
  if (data?.ok === true) return data
  if (data?.ok === false) throw new ApiError(res.status, data.reason)
  throw new ApiError(res.status, `http-${res.status}`)
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
