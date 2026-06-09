import { normalizeEol } from '@glyphdown/core'
import type {
  AssetMeta,
  Comment,
  CommentReply,
  DocMeta,
  FolderMeta,
  Principal,
  PushRequest,
  PushResponse,
  SuggestionRecord,
  UploadAssetResponse,
  VersionMeta,
} from '@glyphdown/protocol'
import { CliError } from './errors.ts'

/** Folder row from GET /api/folders — re-exported so CLI callers get parentId. */
export type { FolderMeta }

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

/** Raw asset bytes — binary, NEVER EOL-normalized (images are not text). */
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
  listFolders(): Promise<FolderMeta[]>
  getFolder(folderId: string): Promise<FolderMeta>
  /** POST /api/folders — parent must be caller-owned; depth ≤ MAX_FOLDER_DEPTH. */
  createFolder(name: string, parentId?: string): Promise<FolderMeta>
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
  createVersion(docId: string, name: string): Promise<VersionMeta>
  /** Asset surface: doc routes resolve the namespace (folder or doc) server-side. */
  listDocAssets(docId: string): Promise<AssetMeta[]>
  listFolderAssets(folderId: string): Promise<AssetMeta[]>
  downloadDocAsset(docId: string, filename: string): Promise<AssetDownload>
  downloadFolderAsset(folderId: string, filename: string): Promise<AssetDownload>
  uploadDocAsset(
    docId: string,
    filename: string,
    data: Uint8Array,
    contentType: string,
    overwrite?: boolean,
  ): Promise<UploadAssetResponse>
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

    createVersion(docId, name) {
      return requestJson<VersionMeta>('POST', `/api/docs/${encodeURIComponent(docId)}/versions`, { name })
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

    downloadDocAsset(docId, filename) {
      return downloadBinary(`/api/docs/${encodeURIComponent(docId)}/assets/${encodeURIComponent(filename)}`)
    },

    downloadFolderAsset(folderId, filename) {
      return downloadBinary(`/api/folders/${encodeURIComponent(folderId)}/assets/${encodeURIComponent(filename)}`)
    },

    async uploadDocAsset(docId, filename, data, contentType, overwrite = false) {
      const params = new URLSearchParams({ filename })
      if (overwrite) params.set('overwrite', 'true')
      const headers: Record<string, string> = { 'content-type': contentType }
      if (credential) headers.authorization = `Bearer ${credential}`
      const res = await fetchFn(
        `${base}/api/docs/${encodeURIComponent(docId)}/assets?${params.toString()}`,
        // Binary body straight through — no JSON wrapping, no EOL touching.
        { method: 'POST', headers, body: data as unknown as RequestInit['body'] },
      )
      const text = await res.text()
      if (!res.ok) throw mapError(res.status, text, res.headers.get('retry-after'))
      return JSON.parse(text) as UploadAssetResponse
    },
  }

  /** GET binary content via ArrayBuffer — images must never be EOL-normalized. */
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
