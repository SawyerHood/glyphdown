import { normalizeEol } from '@glyphdown/core'
import type {
  AssetMeta,
  AssetVersionMeta,
  Comment,
  CommentReply,
  CreateAssetCommentRequest,
  DocMeta,
  FolderMeta,
  Principal,
  PushRequest,
  PushResponse,
  ShareLink,
  ShareLinkRole,
  SuggestionRecord,
  UploadAssetResponse,
  VaultMeta,
  VersionMeta,
} from '@glyphdown/protocol'
import { CliError } from './errors.ts'

/** Folder row from GET /api/folders — re-exported so CLI callers get parentId. */
export type { FolderMeta }
/** Vault row from GET /api/vaults — re-exported for CLI callers. */
export type { VaultMeta }

export type ContentView = 'working' | 'clean'

export interface ContentResult {
  /** EOL-normalized document text. */
  text: string
  /** From the X-Glyphdown-Version header, when the server sends it. */
  versionId: string | null
  /**
   * From the X-Glyphdown-Base-Hash header: the server's sha-256 of the working
   * text (the same hash it caches push bases under). Null when not sent.
   */
  baseHash: string | null
}

/** Raw asset bytes — binary, NEVER EOL-normalized. */
export interface AssetDownload {
  data: Uint8Array
  /** Unquoted etag from the response header, when sent. */
  etag: string | null
  contentType: string | null
}

export interface ApiOptions {
  serverUrl: string
  /** Agent API key (gd_sk_…, legacy ink_sk_…) — wins over sessionToken when both exist. */
  apiKey?: string
  /** Device-flow session token from `glyphdown login` (attributes to the human). */
  sessionToken?: string
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
}

/** Typed client for the /api HTTP surface in @glyphdown/protocol. */
export interface Api {
  me(): Promise<Principal>
  listDocs(): Promise<DocMeta[]>
  getDoc(docId: string): Promise<DocMeta>
  /**
   * POST /api/docs — `filename` (the canonical slug name) wins over `title`
   * (legacy: slugified server-side). Scope collisions are auto-suffixed; read
   * the canonical name off the returned DocMeta.
   */
  createDoc(input: { filename?: string; title?: string; folderId?: string }): Promise<DocMeta>
  /**
   * PATCH /api/docs/:id { filename } — rename the doc's canonical filename.
   * The server 409s `filename-taken` on a scope collision (mapped to a
   * CliError with status 409).
   */
  renameDoc(docId: string, filename: string): Promise<DocMeta>
  /** DELETE /api/docs/:id — owner-only soft delete. */
  deleteDoc(docId: string): Promise<void>
  listFolders(): Promise<FolderMeta[]>
  getFolder(folderId: string): Promise<FolderMeta>
  /** POST /api/folders — parent must be caller-owned; depth ≤ MAX_FOLDER_DEPTH. */
  createFolder(name: string, parentId?: string): Promise<FolderMeta>
  /** GET /api/vaults — owned vaults + vaults shared with you, with your role. */
  listVaults(): Promise<VaultMeta[]>
  getContent(docId: string, view?: ContentView): Promise<ContentResult>
  /**
   * Raw push. Non-2xx responses that carry a PushResponse body (409
   * base-missing/degenerate, 403 forbidden, 413 too-large, 429 rate-limited)
   * are RETURNED, not thrown — callers handle each rejection honestly.
   */
  push(docId: string, body: PushRequest): Promise<PushResponse>
  listComments(docId: string): Promise<Comment[]>
  createComment(docId: string, body: string, range?: { start: number; end: number }): Promise<Comment>
  replyToComment(docId: string, commentId: string, body: string): Promise<CommentReply>
  resolveComment(docId: string, commentId: string, resolved?: boolean): Promise<void>
  listSuggestions(docId: string): Promise<SuggestionRecord[]>
  listVersions(docId: string): Promise<VersionMeta[]>
  getVersionText(docId: string, versionId: string): Promise<string>
  createVersion(docId: string, name: string): Promise<VersionMeta>
  /**
   * Share links (anyone-with-link grants) — owner-only on the target; the
   * server 403s otherwise. A folder link covers the folder's entire subtree.
   */
  listDocShareLinks(docId: string): Promise<ShareLink[]>
  createDocShareLink(docId: string, role: ShareLinkRole): Promise<ShareLink>
  revokeDocShareLink(docId: string, token: string): Promise<void>
  listFolderShareLinks(folderId: string): Promise<ShareLink[]>
  createFolderShareLink(folderId: string, role: ShareLinkRole): Promise<ShareLink>
  revokeFolderShareLink(folderId: string, token: string): Promise<void>
  /** Asset surface: doc routes resolve the namespace (folder or doc) server-side. */
  listDocAssets(docId: string): Promise<AssetMeta[]>
  listFolderAssets(folderId: string): Promise<AssetMeta[]>
  downloadDocAsset(docId: string, filename: string, versionId?: string): Promise<AssetDownload>
  downloadFolderAsset(folderId: string, filename: string, versionId?: string): Promise<AssetDownload>
  uploadDocAsset(
    docId: string,
    filename: string,
    data: Uint8Array,
    contentType: string,
    overwrite?: boolean,
  ): Promise<UploadAssetResponse>
  uploadFolderAsset(
    folderId: string,
    filename: string,
    data: Uint8Array,
    contentType: string,
    overwrite?: boolean,
  ): Promise<UploadAssetResponse>
  listDocAssetComments(docId: string, filename: string): Promise<Comment[]>
  listFolderAssetComments(folderId: string, filename: string): Promise<Comment[]>
  createDocAssetComment(docId: string, filename: string, input: CreateAssetCommentRequest): Promise<Comment>
  createFolderAssetComment(folderId: string, filename: string, input: CreateAssetCommentRequest): Promise<Comment>
  replyToDocAssetComment(docId: string, filename: string, commentId: string, body: string): Promise<CommentReply>
  replyToFolderAssetComment(folderId: string, filename: string, commentId: string, body: string): Promise<CommentReply>
  resolveDocAssetComment(docId: string, filename: string, commentId: string, resolved?: boolean): Promise<void>
  resolveFolderAssetComment(folderId: string, filename: string, commentId: string, resolved?: boolean): Promise<void>
  listDocAssetVersions(docId: string, filename: string): Promise<AssetVersionMeta[]>
  listFolderAssetVersions(folderId: string, filename: string): Promise<AssetVersionMeta[]>
  nameDocAssetVersion(docId: string, filename: string, versionId: string, name: string): Promise<AssetVersionMeta>
  nameFolderAssetVersion(folderId: string, filename: string, versionId: string, name: string): Promise<AssetVersionMeta>
}

function mapError(status: number, bodyText: string, retryAfter?: string | null): CliError {
  let detail = bodyText
  try {
    const parsed = JSON.parse(bodyText) as { error?: string }
    if (typeof parsed.error === 'string') detail = parsed.error
  } catch {
    // plain-text body
  }
  detail = detail.trim().slice(0, 200)
  if (status === 401) {
    return new CliError(
      1,
      'not authenticated — run `glyphdown login` (or `glyphdown login --key <gd_sk_...>` / set GLYPHDOWN_API_KEY)',
      { status },
    )
  }
  if (status === 403)
    return new CliError(1, `forbidden — your role on this doc does not allow that${detail ? ` (${detail})` : ''}`, {
      status,
    })
  if (status === 404) return new CliError(1, 'doc not found — check the id/URL and your access', { status })
  if (status === 409 && detail === 'filename-taken') {
    return new CliError(1, 'filename taken — a doc with that name already exists there; pick another', { status })
  }
  if (status === 429) {
    return new CliError(1, `rate-limited — retry ${retryAfter ? `in ${retryAfter}s` : 'shortly'}`, { status })
  }
  return new CliError(1, `server error ${status}${detail ? `: ${detail}` : ''}`, { status })
}

export function createApi(opts: ApiOptions): Api {
  const base = opts.serverUrl.replace(/\/+$/, '')
  const fetchFn = opts.fetchImpl ?? fetch
  // Both ride the same Bearer header; the server tells them apart by the
  // gd_sk_ / legacy ink_sk_ prefix (agent key) vs anything else (better-auth
  // session token).
  const credential = opts.apiKey ?? opts.sessionToken

  function send(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {}
    if (credential) headers.authorization = `Bearer ${credential}`
    if (body !== undefined) headers['content-type'] = 'application/json'
    return fetchFn(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  async function requestJson<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await send(method, path, body)
    const text = await res.text()
    if (!res.ok) throw mapError(res.status, text, res.headers.get('retry-after'))
    return JSON.parse(text) as T
  }

  return {
    async me() {
      const { principal } = await requestJson<{ principal: Principal }>('GET', '/api/me')
      return principal
    },

    async listDocs() {
      const { docs } = await requestJson<{ docs: DocMeta[] }>('GET', '/api/docs')
      return docs
    },

    getDoc(docId) {
      return requestJson<DocMeta>('GET', `/api/docs/${encodeURIComponent(docId)}`)
    },

    createDoc(input) {
      return requestJson<DocMeta>('POST', '/api/docs', {
        ...(input.filename !== undefined ? { filename: input.filename } : {}),
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.folderId !== undefined ? { folderId: input.folderId } : {}),
      })
    },

    renameDoc(docId, filename) {
      return requestJson<DocMeta>('PATCH', `/api/docs/${encodeURIComponent(docId)}`, { filename })
    },

    async deleteDoc(docId) {
      await requestJson<unknown>('DELETE', `/api/docs/${encodeURIComponent(docId)}`)
    },

    async listFolders() {
      const { folders } = await requestJson<{ folders: FolderMeta[] }>('GET', '/api/folders')
      return folders
    },

    getFolder(folderId) {
      return requestJson<FolderMeta>('GET', `/api/folders/${encodeURIComponent(folderId)}`)
    },

    createFolder(name, parentId) {
      return requestJson<FolderMeta>('POST', '/api/folders', { name, ...(parentId ? { parentId } : {}) })
    },

    async listVaults() {
      const { vaults } = await requestJson<{ vaults: VaultMeta[] }>('GET', '/api/vaults')
      return vaults
    },

    async getContent(docId, view = 'working') {
      const res = await send('GET', `/api/docs/${encodeURIComponent(docId)}/content?view=${view}`)
      const text = await res.text()
      if (!res.ok) throw mapError(res.status, text, res.headers.get('retry-after'))
      return {
        text: normalizeEol(text),
        // Legacy x-inkroom-* fallbacks let a renamed CLI keep working
        // against a pre-rename server during rollout.
        versionId: res.headers.get('x-glyphdown-version') ?? res.headers.get('x-inkroom-version'),
        baseHash: res.headers.get('x-glyphdown-base-hash') ?? res.headers.get('x-inkroom-base-hash'),
      }
    },

    async push(docId, body) {
      const res = await send('POST', `/api/docs/${encodeURIComponent(docId)}/push`, body)
      const text = await res.text()
      try {
        const data = JSON.parse(text) as PushResponse & { ok?: unknown; reason?: string }
        if (typeof data.ok === 'boolean') {
          const retryAfter = res.headers.get('retry-after')
          if (data.reason === 'rate-limited' && retryAfter) {
            return { ...data, retryAfterSec: Number(retryAfter) } as PushResponse
          }
          return data as PushResponse
        }
      } catch {
        // not a PushResponse body — fall through to error mapping
      }
      throw mapError(res.status, text, res.headers.get('retry-after'))
    },

    async listComments(docId) {
      const { comments } = await requestJson<{ comments: Comment[] }>(
        'GET',
        `/api/docs/${encodeURIComponent(docId)}/comments`,
      )
      return comments
    },

    createComment(docId, body, range) {
      return requestJson<Comment>('POST', `/api/docs/${encodeURIComponent(docId)}/comments`, {
        body,
        ...(range ? { range } : {}),
      })
    },

    replyToComment(docId, commentId, body) {
      return requestJson<CommentReply>(
        'POST',
        `/api/docs/${encodeURIComponent(docId)}/comments/${encodeURIComponent(commentId)}/replies`,
        { body },
      )
    },

    async resolveComment(docId, commentId, resolved = true) {
      await requestJson<unknown>(
        'POST',
        `/api/docs/${encodeURIComponent(docId)}/comments/${encodeURIComponent(commentId)}/resolve`,
        { resolved },
      )
    },

    async listSuggestions(docId) {
      const { suggestions } = await requestJson<{ suggestions: SuggestionRecord[] }>(
        'GET',
        `/api/docs/${encodeURIComponent(docId)}/suggestions`,
      )
      return suggestions
    },

    async listVersions(docId) {
      const { versions } = await requestJson<{ versions: VersionMeta[] }>(
        'GET',
        `/api/docs/${encodeURIComponent(docId)}/versions`,
      )
      return versions
    },

    async getVersionText(docId, versionId) {
      const { text } = await requestJson<{ text: string }>(
        'GET',
        `/api/docs/${encodeURIComponent(docId)}/versions/${encodeURIComponent(versionId)}`,
      )
      return normalizeEol(text)
    },

    createVersion(docId, name) {
      return requestJson<VersionMeta>('POST', `/api/docs/${encodeURIComponent(docId)}/versions`, { name })
    },

    async listDocShareLinks(docId) {
      const { shareLinks } = await requestJson<{ shareLinks: ShareLink[] }>(
        'GET',
        `/api/docs/${encodeURIComponent(docId)}/share-links`,
      )
      return shareLinks
    },

    createDocShareLink(docId, role) {
      return requestJson<ShareLink>('POST', `/api/docs/${encodeURIComponent(docId)}/share-links`, { role })
    },

    async revokeDocShareLink(docId, token) {
      await requestJson<unknown>(
        'DELETE',
        `/api/docs/${encodeURIComponent(docId)}/share-links/${encodeURIComponent(token)}`,
      )
    },

    async listFolderShareLinks(folderId) {
      const { shareLinks } = await requestJson<{ shareLinks: ShareLink[] }>(
        'GET',
        `/api/folders/${encodeURIComponent(folderId)}/share-links`,
      )
      return shareLinks
    },

    createFolderShareLink(folderId, role) {
      return requestJson<ShareLink>('POST', `/api/folders/${encodeURIComponent(folderId)}/share-links`, { role })
    },

    async revokeFolderShareLink(folderId, token) {
      await requestJson<unknown>(
        'DELETE',
        `/api/folders/${encodeURIComponent(folderId)}/share-links/${encodeURIComponent(token)}`,
      )
    },

    async listDocAssets(docId) {
      const { assets } = await requestJson<{ assets: AssetMeta[] }>(
        'GET',
        `/api/docs/${encodeURIComponent(docId)}/assets`,
      )
      return assets
    },

    async listFolderAssets(folderId) {
      const { assets } = await requestJson<{ assets: AssetMeta[] }>(
        'GET',
        `/api/folders/${encodeURIComponent(folderId)}/assets`,
      )
      return assets
    },

    downloadDocAsset(docId, filename, versionId) {
      return downloadBinary(assetFilePath('docs', docId, filename, versionId))
    },

    downloadFolderAsset(folderId, filename, versionId) {
      return downloadBinary(assetFilePath('folders', folderId, filename, versionId))
    },

    uploadDocAsset(docId, filename, data, contentType, overwrite = false) {
      return uploadAsset(`/api/docs/${encodeURIComponent(docId)}/assets`, filename, data, contentType, overwrite)
    },

    uploadFolderAsset(folderId, filename, data, contentType, overwrite = false) {
      return uploadAsset(`/api/folders/${encodeURIComponent(folderId)}/assets`, filename, data, contentType, overwrite)
    },

    async listDocAssetComments(docId, filename) {
      const { comments } = await requestJson<{ comments: Comment[] }>(
        'GET',
        assetCommentsPath('docs', docId, filename),
      )
      return comments
    },

    async listFolderAssetComments(folderId, filename) {
      const { comments } = await requestJson<{ comments: Comment[] }>(
        'GET',
        assetCommentsPath('folders', folderId, filename),
      )
      return comments
    },

    createDocAssetComment(docId, filename, input) {
      return requestJson<Comment>('POST', assetCommentsPath('docs', docId, filename), input)
    },

    createFolderAssetComment(folderId, filename, input) {
      return requestJson<Comment>('POST', assetCommentsPath('folders', folderId, filename), input)
    },

    replyToDocAssetComment(docId, filename, commentId, body) {
      return requestJson<CommentReply>(
        'POST',
        assetCommentsPath('docs', docId, filename, `/${encodeURIComponent(commentId)}/replies`),
        { body },
      )
    },

    replyToFolderAssetComment(folderId, filename, commentId, body) {
      return requestJson<CommentReply>(
        'POST',
        assetCommentsPath('folders', folderId, filename, `/${encodeURIComponent(commentId)}/replies`),
        { body },
      )
    },

    async resolveDocAssetComment(docId, filename, commentId, resolved = true) {
      await requestJson<unknown>(
        'POST',
        assetCommentsPath('docs', docId, filename, `/${encodeURIComponent(commentId)}/resolve`),
        { resolved },
      )
    },

    async resolveFolderAssetComment(folderId, filename, commentId, resolved = true) {
      await requestJson<unknown>(
        'POST',
        assetCommentsPath('folders', folderId, filename, `/${encodeURIComponent(commentId)}/resolve`),
        { resolved },
      )
    },

    async listDocAssetVersions(docId, filename) {
      const { versions } = await requestJson<{ versions: AssetVersionMeta[] }>(
        'GET',
        assetVersionsPath('docs', docId, filename),
      )
      return versions
    },

    async listFolderAssetVersions(folderId, filename) {
      const { versions } = await requestJson<{ versions: AssetVersionMeta[] }>(
        'GET',
        assetVersionsPath('folders', folderId, filename),
      )
      return versions
    },

    nameDocAssetVersion(docId, filename, versionId, name) {
      return requestJson<AssetVersionMeta>(
        'POST',
        assetVersionsPath('docs', docId, filename, `/${encodeURIComponent(versionId)}/name`),
        { name },
      )
    },

    nameFolderAssetVersion(folderId, filename, versionId, name) {
      return requestJson<AssetVersionMeta>(
        'POST',
        assetVersionsPath('folders', folderId, filename, `/${encodeURIComponent(versionId)}/name`),
        { name },
      )
    },
  }

  function assetFilePath(scope: 'docs' | 'folders', id: string, filename: string, versionId?: string): string {
    const path = `/api/${scope}/${encodeURIComponent(id)}/assets/${encodeURIComponent(filename)}`
    return versionId === undefined ? path : `${path}?version=${encodeURIComponent(versionId)}`
  }

  function assetCommentsPath(scope: 'docs' | 'folders', id: string, filename: string, sub = ''): string {
    return `/api/${scope}/${encodeURIComponent(id)}/assets/${encodeURIComponent(filename)}/comments${sub}`
  }

  function assetVersionsPath(scope: 'docs' | 'folders', id: string, filename: string, sub = ''): string {
    return `/api/${scope}/${encodeURIComponent(id)}/assets/${encodeURIComponent(filename)}/versions${sub}`
  }

  async function uploadAsset(
    path: string,
    filename: string,
    data: Uint8Array,
    contentType: string,
    overwrite: boolean,
  ): Promise<UploadAssetResponse> {
    const params = new URLSearchParams({ filename })
    if (overwrite) params.set('overwrite', 'true')
    const headers: Record<string, string> = { 'content-type': contentType }
    if (credential) headers.authorization = `Bearer ${credential}`
    const res = await fetchFn(
      `${base}${path}?${params.toString()}`,
      // Binary body straight through — no JSON wrapping, no EOL touching.
      { method: 'POST', headers, body: data as unknown as RequestInit['body'] },
    )
    const text = await res.text()
    if (!res.ok) throw mapError(res.status, text, res.headers.get('retry-after'))
    return JSON.parse(text) as UploadAssetResponse
  }

  /** GET binary content via ArrayBuffer — assets must never be EOL-normalized. */
  async function downloadBinary(path: string): Promise<AssetDownload> {
    const res = await send('GET', path)
    if (!res.ok) throw mapError(res.status, await res.text(), res.headers.get('retry-after'))
    const buffer = await res.arrayBuffer()
    const rawEtag = res.headers.get('etag')
    return {
      data: new Uint8Array(buffer),
      etag: rawEtag ? rawEtag.replace(/^W\//, '').replace(/^"|"$/g, '') : null,
      contentType: res.headers.get('content-type'),
    }
  }
}

export interface PushWithBaseOptions {
  docId: string
  newText: string
  baseHash: string
  /** Local <workspaceRoot>/<docId>/base.md contents, re-sent on a 409 base-missing. */
  baseText: string
  suggest?: boolean
  force?: boolean
  note?: string
}

export interface PushOutcome {
  response: PushResponse
  /** True when the server's base cache missed and base.md was re-sent. */
  resentBase: boolean
}

/**
 * SPEC §8.3 step 2: push {newText, baseHash}; if the server's base cache
 * misses (`base-missing`), re-send with the baseText kept on disk at pull time.
 */
export async function pushWithBase(api: Api, opts: PushWithBaseOptions): Promise<PushOutcome> {
  const req: PushRequest = {
    newText: opts.newText,
    baseHash: opts.baseHash,
    ...(opts.suggest ? { suggest: true } : {}),
    ...(opts.force ? { force: true } : {}),
    ...(opts.note !== undefined ? { note: opts.note } : {}),
  }
  let response = await api.push(opts.docId, req)
  let resentBase = false
  if (!response.ok && response.reason === 'base-missing') {
    resentBase = true
    response = await api.push(opts.docId, { ...req, baseText: opts.baseText })
  }
  return { response, resentBase }
}
