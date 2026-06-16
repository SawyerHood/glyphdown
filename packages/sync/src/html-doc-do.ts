import { Server } from 'partyserver'
import {
  nodeAnchorMinimumOk,
  nodeAnchorsEqual,
  parseHtmlNodeIndex,
  resolveNodeAnchor,
  type HtmlNodeIndex,
} from '@glyphdown/core'
import {
  HEADER_ASSET,
  HEADER_ASSET_VERSION,
  HEADER_PRINCIPAL,
  HEADER_ROLE,
  roleAtLeast,
  type Comment,
  type CreateAssetCommentRequest,
  type NodeAnchor,
  type Principal,
  type Role,
} from '@glyphdown/protocol'
import type { SyncEnv } from './do.ts'
import { CommentStore, type AnchorStrategy, type CommentAnchorAdapter, type Validated } from './sidecar.ts'

const HEADER_COMMENT_AUTHOR = 'x-glyphdown-comment-author'

/**
 * Per-HTML-asset Durable Object. HTML assets are R2 blobs, not Yjs docs, so
 * this object owns only sidecar state: comments now, parser/index cache later.
 */
export class HtmlDocDO extends Server<SyncEnv> {
  static override options = { hibernate: true }

  private get store() {
    return this.ctx.storage.sql
  }

  override async onStart(): Promise<void> {
    this.ensureTables()
  }

  override async onRequest(request: Request): Promise<Response> {
    this.ensureTables()
    const assetId = request.headers.get(HEADER_ASSET)
    if (!assetId) return json({ error: 'asset-required' }, 400)
    const role = (request.headers.get(HEADER_ROLE) ?? 'viewer') as Role
    const principal = JSON.parse(request.headers.get(HEADER_PRINCIPAL) ?? 'null') as Principal | null
    const currentVersionId = request.headers.get(HEADER_ASSET_VERSION)
    if (!principal) return json({ error: 'unauthenticated' }, 401)
    this.ensureContentMeta(assetId)

    try {
      return await this.route(request, assetId, principal, role, currentVersionId)
    } catch (err) {
      console.error('HtmlDocDO request failed:', err)
      return json({ error: 'internal' }, 500)
    }
  }

  private ensureTables(): void {
    this.store.exec(`
      CREATE TABLE IF NOT EXISTS comments (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS content_meta (
        asset_id TEXT PRIMARY KEY, etag TEXT, content_hash TEXT, parsed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS node_index (
        key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
    `)
  }

  private ensureContentMeta(assetId: string): void {
    this.store.exec(
      'INSERT OR IGNORE INTO content_meta (asset_id, etag, content_hash, parsed_at) VALUES (?, NULL, NULL, NULL)',
      assetId,
    )
  }

  private commentStore(assetId: string): CommentStore<NodeAnchor, HtmlNodeIndex | null> {
    return new CommentStore({
      content: () => this.loadNodeIndex(assetId),
      strategy: HtmlNodeAnchorStrategy,
      anchors: assetCommentAnchors,
      all: () => this.allComments(),
      load: (id) => this.loadComment(id),
      save: (comment) => this.saveComment(comment),
    })
  }

  private async route(
    request: Request,
    assetId: string,
    principal: Principal,
    role: Role,
    currentVersionId: string | null,
  ): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname
    const method = request.method

    if (path === '/admin/content' && method === 'POST') {
      if (!roleAtLeast(role, 'editor')) return json({ error: 'forbidden' }, 403)
      return this.handleContentChanged(assetId, await readJson<ContentChangedRequest>(request))
    }

    if (path === '/admin/pinned-versions' && method === 'GET') {
      const versionIds = [
        ...new Set(
          this.allComments()
            .filter((comment) => !comment.resolved && typeof comment.versionId === 'string')
            .map((comment) => comment.versionId!),
        ),
      ]
      return json({ versionIds })
    }

    if (path === '/comments') {
      if (method === 'GET') return json({ comments: this.allComments() })
      if (method === 'POST') {
        if (!roleAtLeast(role, 'commenter')) return json({ error: 'forbidden' }, 403)
        return this.handleCreateComment(assetId, await readJson<CreateAssetCommentRequest>(request), principal, currentVersionId)
      }
      return json({ error: 'method-not-allowed' }, 405)
    }

    const commentAction = path.match(/^\/comments\/([^/]+)\/(replies|resolve|reactions|reattach)$/)
    if (commentAction && method === 'POST') {
      if (!roleAtLeast(role, 'commenter')) return json({ error: 'forbidden' }, 403)
      const id = commentAction[1]!
      const action = commentAction[2]!
      const payload = await readJson<Record<string, unknown>>(request)
      if (action === 'replies') return this.handleReply(assetId, id, payload, principal)
      if (action === 'resolve') return this.handleResolve(assetId, id, payload)
      if (action === 'reactions') return this.handleReaction(assetId, id, payload, principal)
      return this.handleReattach(assetId, id, payload)
    }

    return json({ error: 'not-found', path }, 404)
  }

  private handleContentChanged(assetId: string, payload: ContentChangedRequest | null): Response {
    if (!payload || typeof payload.html !== 'string') return json({ error: 'html-required' }, 400)
    const etag = typeof payload.etag === 'string' ? payload.etag : null
    const contentHash = typeof payload.contentHash === 'string' ? payload.contentHash : null
    const parsedAt = Date.now()
    const index = parseHtmlNodeIndex(payload.html)
    this.store.exec(
      'UPDATE content_meta SET etag = ?, content_hash = ?, parsed_at = ? WHERE asset_id = ?',
      etag,
      contentHash,
      parsedAt,
      assetId,
    )
    this.store.exec(
      'INSERT OR REPLACE INTO node_index (key, data, updated_at) VALUES (?, ?, ?)',
      assetId,
      JSON.stringify(index),
      parsedAt,
    )
    const changed = this.commentStore(assetId).revalidate()
    return json({
      ok: true,
      nodes: index.nodes.length,
      changed: changed.length,
      anchored: changed.filter((comment) => comment.nodeAnchor?.status === 'anchored').length,
      orphaned: changed.filter((comment) => comment.nodeAnchor?.status === 'orphaned').length,
    })
  }

  private handleCreateComment(
    assetId: string,
    payload: CreateAssetCommentRequest | null,
    principal: Principal,
    currentVersionId: string | null,
  ): Response {
    const store = this.commentStore(assetId)
    const built = store.build(principal, payload?.body, payload?.nodeAnchor)
    if (!built.ok) return json({ error: built.error }, 400)
    const comment = currentVersionId ? { ...built.value, versionId: currentVersionId } : built.value
    this.saveComment(comment)
    return json(comment)
  }

  private handleReply(
    assetId: string,
    commentId: string,
    payload: Record<string, unknown> | null,
    principal: Principal,
  ): Response {
    const result = this.commentStore(assetId).reply(commentId, principal, payload?.body)
    if (!result.ok) return json({ error: result.error }, result.error === 'not-found' ? 404 : 400)
    return json(result.value.reply, 200, { [HEADER_COMMENT_AUTHOR]: result.value.rootAuthorId })
  }

  private handleResolve(assetId: string, commentId: string, payload: Record<string, unknown> | null): Response {
    const result = this.commentStore(assetId).resolve(commentId, payload?.resolved)
    if (!result.ok) return json({ error: result.error }, 404)
    return json({ resolved: result.value.resolved })
  }

  private handleReaction(
    assetId: string,
    commentId: string,
    payload: Record<string, unknown> | null,
    principal: Principal,
  ): Response {
    const result = this.commentStore(assetId).react(commentId, payload?.emoji, principal)
    if (!result.ok) return json({ error: result.error }, result.error === 'not-found' ? 404 : 400)
    return json(result.value)
  }

  private handleReattach(assetId: string, commentId: string, payload: Record<string, unknown> | null): Response {
    const result = this.commentStore(assetId).reattach(commentId, payload)
    if (!result.ok) return json({ error: result.error }, result.error === 'not-found' ? 404 : 400)
    return json(result.value)
  }

  private allComments(): Comment[] {
    return [...this.store.exec<{ data: string }>('SELECT data FROM comments ORDER BY created_at, rowid')].map(
      (row) => JSON.parse(row.data) as Comment,
    )
  }

  private loadComment(id: string): Comment | null {
    const row = [...this.store.exec<{ data: string }>('SELECT data FROM comments WHERE id = ?', id)][0]
    return row ? (JSON.parse(row.data) as Comment) : null
  }

  private saveComment(comment: Comment): void {
    this.store.exec(
      'INSERT OR REPLACE INTO comments (id, data, created_at) VALUES (?, ?, ?)',
      comment.id, JSON.stringify(comment), comment.createdAt,
    )
  }

  private loadNodeIndex(assetId: string): HtmlNodeIndex | null {
    const row = [...this.store.exec<{ data: string }>('SELECT data FROM node_index WHERE key = ?', assetId)][0]
    return row ? (JSON.parse(row.data) as HtmlNodeIndex) : null
  }
}

interface ContentChangedRequest {
  etag?: unknown
  contentHash?: unknown
  html?: unknown
}

const HtmlNodeAnchorStrategy: AnchorStrategy<NodeAnchor, HtmlNodeIndex | null> = {
  buildFromInput(content, input): Validated<NodeAnchor | null> {
    if (input === undefined || input === null) return { ok: true, value: null }
    return validateNodeAnchorInput(content, input)
  },
  validate(content, anchor) {
    if (!content) return { anchor: serverOnlyAnchor({ ...anchor, status: 'orphaned' }), resolved: false }
    if (anchor.clientResolveOnly) return { anchor: serverOnlyAnchor({ ...anchor, status: 'orphaned' }), resolved: false }
    const result = resolveNodeAnchor(content, anchor)
    return { anchor: serverOnlyAnchor(result.anchor), resolved: result.node !== null }
  },
  reattach(content, input): Validated<NodeAnchor> {
    return validateNodeAnchorInput(content, input)
  },
  equals(a, b) {
    return nodeAnchorsEqual(a, b)
  },
  minimumOk: nodeAnchorMinimumOk,
}

function validateNodeAnchorInput(content: HtmlNodeIndex | null, input: unknown): Validated<NodeAnchor> {
  const anchor = extractNodeAnchorInput(input)
  if (!isNodeAnchor(anchor)) return { ok: false, error: 'node-anchor-invalid' }
  if (anchor.clientResolveOnly) return { ok: false, error: 'client-resolve-only' }
  if (!content) return { ok: false, error: 'content-not-indexed' }
  if (!nodeAnchorMinimumOk(anchor)) return { ok: false, error: 'anchor-too-short' }
  const result = resolveNodeAnchor(content, anchor)
  if (!result.node || result.anchor.status !== 'anchored') return { ok: false, error: 'node-anchor-unresolved' }
  return { ok: true, value: serverOnlyAnchor(result.anchor) }
}

function extractNodeAnchorInput(input: unknown): unknown {
  if (typeof input === 'object' && input !== null && 'nodeAnchor' in input) {
    return (input as { nodeAnchor?: unknown }).nodeAnchor
  }
  return input
}

function isNodeAnchor(value: unknown): value is NodeAnchor {
  if (typeof value !== 'object' || value === null) return false
  const anchor = value as NodeAnchor
  return (
    anchor.schema === 1 &&
    Array.isArray(anchor.path) &&
    typeof anchor.fingerprint === 'object' &&
    anchor.fingerprint !== null &&
    typeof anchor.fingerprint.tag === 'string' &&
    typeof anchor.domHint === 'number' &&
    typeof anchor.label === 'string' &&
    (anchor.status === 'anchored' || anchor.status === 'orphaned')
  )
}

function serverOnlyAnchor(anchor: NodeAnchor): NodeAnchor {
  const next = { ...anchor }
  delete next.clientResolveOnly
  return next
}

const assetCommentAnchors: CommentAnchorAdapter<NodeAnchor> = {
  get: (comment) => comment.nodeAnchor ?? null,
  set: (comment, anchor) => {
    if (anchor) return { ...comment, anchor: null, anchorKind: 'node', nodeAnchor: serverOnlyAnchor(anchor) }
    const next: Comment = { ...comment, anchor: null, anchorKind: null, textAnchor: null }
    delete next.nodeAnchor
    return next
  },
}

function json(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T
  } catch {
    return null
  }
}
