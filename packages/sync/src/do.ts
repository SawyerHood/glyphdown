import { YServer } from 'y-partyserver'
import { getServerByName } from 'partyserver'
import type { Connection, ConnectionContext, WSMessage } from 'partyserver'
import { SEARCH_DO_NAME, type SearchDO } from './search-do.ts'
import * as Y from 'yjs'
import {
  acceptSuggestion,
  cleanText,
  computeMergedTarget,
  materializeSuggestion,
  mergePush,
  normalizeEol,
  rejectSuggestion,
  restoreText,
} from '@glyphdown/core'
import {
  HEADER_PRINCIPAL,
  HEADER_ROLE,
  type AcceptResponse,
  type ClientMessage,
  type Comment,
  type CreateCommentRequest,
  type DocEvent,
  type Principal,
  type PushRequest,
  type PushResponse,
  type Role,
  type VersionMeta,
  roleAtLeast,
} from '@glyphdown/protocol'
import {
  type StoredSuggestion,
  buildComment,
  buildReply,
  reattachComment,
  revalidateAnchors,
  toggleReaction,
} from './sidecar.ts'
import { decidePushWindow } from './ratelimit.ts'
import {
  type DeltaOp,
  type OffsetRange,
  checkSuggesterDelta,
  invertDelta,
  ownOpenInsertRanges,
} from './enforce.ts'

/** Compact the update log once it exceeds either threshold. */
const COMPACT_MAX_ROWS = 500
const COMPACT_MAX_BYTES = 1 * 1024 * 1024
/** Chunk compacted state below the 2 MB DO SQLite row cap. */
const STATE_CHUNK_BYTES = 1.5 * 1024 * 1024
/** Pulled-base cache eviction horizon. */
const BASE_TTL_MS = 14 * 24 * 60 * 60 * 1000
const MAX_DOC_BYTES = 2 * 1024 * 1024

/** Close codes for server-initiated disconnects (SPEC §11). */
export const CLOSE_DOC_DELETED = 4410
export const CLOSE_ACCESS_REVOKED = 4403

/**
 * Response header on POST /comments/:id/replies carrying the ROOT comment's
 * authorId, so the Worker proxy can write the comment-reply notification
 * (SPEC §9) without a second DO round-trip.
 */
export const HEADER_COMMENT_AUTHOR = 'x-glyphdown-comment-author'

interface ConnState {
  principal: Principal
  role: Role
}

/** Bindings the host Worker must provide (apps/web wrangler.jsonc). */
export interface SyncEnv {
  DocDO: DurableObjectNamespace<DocDO>
  /** Global full-text/wiki-link index (search-do.ts) — fed fire-and-forget. */
  SearchDO: DurableObjectNamespace<SearchDO>
  /** D1 metadata database (auth/docs/ACLs) — unused by the DO itself, but
   * part of the host Worker env so SyncEnv stays assignable to the host's
   * generated Cloudflare.Env (partyserver's `Server<Env>` constraint). */
  DB: D1Database
  /** R2 asset bucket — unused by the DOs; host-env assignability (see DB). */
  ASSETS: R2Bucket
}

type VersionRow = {
  id: string
  name: string | null
  kind: string
  author_ids: string
  created_at: number
  bytes: number
}

function rowToMeta(row: VersionRow): VersionMeta {
  return {
    id: row.id,
    createdAt: row.created_at,
    name: row.name ?? undefined,
    kind: row.kind as VersionMeta['kind'],
    authorIds: JSON.parse(row.author_ids) as string[],
    sizeBytes: row.bytes,
  }
}

const VERSION_META_COLUMNS = 'id, name, kind, author_ids, created_at, LENGTH(text) AS bytes'

/**
 * One Durable Object per document. Owns the Y.Doc (content = Y.Text 'content'),
 * an update-log persistence layer, and the sidecar tables for comments,
 * suggestions, versions, and pulled-base caching.
 *
 * The DO is never internet-reachable: the Worker authenticates every request
 * and forwards identity via trusted headers (see @glyphdown/protocol).
 */
export class DocDO extends YServer<SyncEnv> {
  static override options = { hibernate: true }

  /** Update rows persisted since last compaction (loaded lazily in onLoad). */
  private persistenceReady = false

  private get store() {
    return this.ctx.storage.sql
  }

  private get ytext(): Y.Text {
    return this.document.getText('content')
  }

  // -------------------------------------------------------------------------
  // Lifecycle & persistence: every update is its own row; compaction replays
  // into a single re-encoded state (preserving CRDT identity — never rebuild
  // from plain text, that nulls every anchor).
  // -------------------------------------------------------------------------

  override async onLoad(): Promise<void> {
    this.ensureTables()

    const stateChunks = [...this.store.exec<{ data: ArrayBuffer }>('SELECT data FROM ystate ORDER BY idx')]
    if (stateChunks.length > 0) {
      const total = stateChunks.reduce((n, r) => n + r.data.byteLength, 0)
      const merged = new Uint8Array(total)
      let off = 0
      for (const row of stateChunks) {
        merged.set(new Uint8Array(row.data), off)
        off += row.data.byteLength
      }
      Y.applyUpdate(this.document, merged, 'persistence')
    }
    for (const row of this.store.exec<{ data: ArrayBuffer }>('SELECT data FROM yupdates ORDER BY seq')) {
      Y.applyUpdate(this.document, new Uint8Array(row.data), 'persistence')
    }

    this.document.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === 'persistence') return
      this.store.exec('INSERT INTO yupdates (data) VALUES (?)', update.buffer)
      this.maybeCompact()
    })
    this.ytext.observe((event, txn) => this.enforceSuggesterPolicy(event, txn))
    this.persistenceReady = true
  }

  override async onSave(): Promise<void> {
    if (this.persistenceReady) {
      this.compact()
      this.feedSearchIndex()
    }
  }

  private ensureTables(): void {
    this.store.exec(`
      CREATE TABLE IF NOT EXISTS yupdates (seq INTEGER PRIMARY KEY AUTOINCREMENT, data BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS ystate (idx INTEGER PRIMARY KEY, data BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS bases (hash TEXT PRIMARY KEY, text TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pushes (identity TEXT NOT NULL, ts INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS pushes_identity_ts ON pushes (identity, ts);
      CREATE TABLE IF NOT EXISTS comments (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS suggestions (id TEXT PRIMARY KEY, data TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS versions (
        id TEXT PRIMARY KEY, name TEXT, kind TEXT NOT NULL, text TEXT NOT NULL,
        state_vector BLOB NOT NULL, author_ids TEXT NOT NULL, created_at INTEGER NOT NULL
      );
    `)
  }

  private maybeCompact(): void {
    const row = [...this.store.exec<{ n: number; bytes: number | null }>(
      'SELECT COUNT(*) AS n, SUM(LENGTH(data)) AS bytes FROM yupdates',
    )][0]
    if (!row) return
    if (row.n > COMPACT_MAX_ROWS || (row.bytes ?? 0) > COMPACT_MAX_BYTES) this.compact()
  }

  private compact(): void {
    const state = Y.encodeStateAsUpdate(this.document)
    this.ctx.storage.transactionSync(() => {
      this.store.exec('DELETE FROM ystate')
      for (let i = 0, idx = 0; i < state.length; i += STATE_CHUNK_BYTES, idx++) {
        const chunk = state.slice(i, i + STATE_CHUNK_BYTES)
        this.store.exec('INSERT INTO ystate (idx, data) VALUES (?, ?)', idx, chunk.buffer)
      }
      this.store.exec('DELETE FROM yupdates')
    })
  }

  // -------------------------------------------------------------------------
  // Connections & roles
  // -------------------------------------------------------------------------

  override async onConnect(connection: Connection<ConnState>, ctx: ConnectionContext): Promise<void> {
    const principal = JSON.parse(ctx.request.headers.get(HEADER_PRINCIPAL) ?? 'null') as Principal | null
    const role = (ctx.request.headers.get(HEADER_ROLE) ?? 'viewer') as Role
    if (!principal) {
      connection.close(4401, 'unauthenticated')
      return
    }
    connection.setState({ principal, role })
    return super.onConnect(connection, ctx)
  }

  override isReadOnly(connection: Connection): boolean {
    const state = (connection as Connection<ConnState>).state
    return !state || !roleAtLeast(state.role, 'suggester')
  }

  // -------------------------------------------------------------------------
  // Suggester enforcement (SPEC §6.4)
  //
  // y-partyserver applies each remote sync message in a transaction whose
  // origin is the sending Connection (verified in
  // y-partyserver/dist/server/index.js — handleMessage passes `connection` as
  // transactionOrigin into readSyncStep2/readUpdate). super.onMessage runs the
  // transaction synchronously, so we snapshot the pre-state (text for the
  // inverse delta, the author's open suggested-insert ranges for coverage)
  // around the call and the ytext observer attributes the delta to the
  // connection via txn.origin.
  // -------------------------------------------------------------------------

  private suggesterGuard: { connection: Connection; preText: string; ownRanges: OffsetRange[] } | null = null

  override onMessage(connection: Connection, message: WSMessage): void {
    const state = (connection as Connection<ConnState>).state
    if (state?.role === 'suggester' && isSyncMessage(message)) {
      this.suggesterGuard = {
        connection,
        preText: this.ytext.toString(),
        ownRanges: ownOpenInsertRanges(this.ytext, this.openSuggestions(), state.principal.id),
      }
      try {
        super.onMessage(connection, message)
      } finally {
        this.suggesterGuard = null
      }
      return
    }
    super.onMessage(connection, message)
  }

  /**
   * Revert any suggester-role content change that is not consistent with
   * suggestion semantics (deletions outside the author's own open
   * suggested-insert ranges, formatting, embeds) and drop the connection.
   * The inverse delta lands in a 'server-enforce' origin transaction — Yjs
   * queues transactions started inside observers after the current cleanup,
   * so persistence and client broadcast both see the revert as a normal
   * update.
   */
  private enforceSuggesterPolicy(event: Y.YTextEvent, txn: Y.Transaction): void {
    const guard = this.suggesterGuard
    if (!guard || txn.origin !== guard.connection) return
    const delta = event.delta as DeltaOp[]
    const verdict = checkSuggesterDelta(delta, guard.ownRanges)
    if (verdict.ok) return

    this.suggesterGuard = null // the revert below must not re-enter this check
    const inverse = invertDelta(delta, guard.preText)
    this.document.transact(() => {
      this.ytext.applyDelta(inverse)
    }, 'server-enforce')
    // The violating delete + revert re-insert tombstoned CRDT items; re-mint
    // anchors onto the restored (identical) text so nothing stays orphaned.
    this.revalidateAfterRewrite('server-enforce')
    console.warn(`suggester policy violation (${verdict.reason}); reverted and closing connection`)
    guard.connection.close(CLOSE_ACCESS_REVOKED, 'suggestion-policy-violation')
  }

  /**
   * Activity-based auto-snapshot: when the last connection leaves and the
   * content drifted from the newest stored version, capture a version (§7).
   */
  override onClose(connection: Connection, code: number, reason: string, wasClean: boolean): void {
    super.onClose(connection, code, reason, wasClean)
    const remaining = [...this.getConnections()].filter((c) => c.id !== connection.id)
    if (remaining.length > 0) return
    const state = (connection as Connection<ConnState>).state
    this.snapshotIfChanged('auto', state ? [state.principal.id] : [])
  }

  /**
   * Live suggest-mode sessions stream their suggestion records over the
   * socket; persist them and rebroadcast so other clients render them live.
   */
  override onCustomMessage(connection: Connection, message: string): void {
    const state = (connection as Connection<ConnState>).state
    if (!state) return
    let parsed: ClientMessage
    try {
      parsed = JSON.parse(message) as ClientMessage
    } catch {
      return
    }
    if (parsed.t !== 'suggestion-upsert') return
    if (!roleAtLeast(state.role, 'suggester')) return

    const suggestion = parsed.suggestion
    if (!suggestion || typeof suggestion.id !== 'string' || !Array.isArray(suggestion.parts)) return
    // Connections may only stream their own records, and may not flip them
    // into reviewed states — accept/reject runs through the REST surface so
    // the text transforms happen server-side.
    if (suggestion.authorId !== state.principal.id) return
    if (suggestion.status !== 'open' && suggestion.status !== 'withdrawn') return
    const existing = this.loadSuggestion(suggestion.id)
    if (existing && (existing.authorId !== state.principal.id || existing.status !== 'open')) return

    const record: StoredSuggestion = { ...suggestion, authorName: state.principal.name }
    this.saveSuggestion(record)
    this.broadcastEvent({ t: 'suggestion', suggestion: record }, connection)
  }

  // -------------------------------------------------------------------------
  // Internal REST surface (Worker → stub.fetch; paths per @glyphdown/protocol)
  // -------------------------------------------------------------------------

  override async onRequest(request: Request): Promise<Response> {
    const role = (request.headers.get(HEADER_ROLE) ?? 'viewer') as Role
    const principal = JSON.parse(request.headers.get(HEADER_PRINCIPAL) ?? 'null') as Principal | null
    if (!principal) return json({ error: 'unauthenticated' }, 401)
    try {
      return await this.route(request, principal, role)
    } catch (err) {
      console.error('DocDO request failed:', err)
      return json({ error: 'internal' }, 500)
    }
  }

  private async route(request: Request, principal: Principal, role: Role): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname
    const method = request.method

    if (method === 'GET' && path === '/content') return this.handleGetContent(url)

    if (method === 'POST' && path === '/push') {
      if (!roleAtLeast(role, 'suggester')) return json({ ok: false, reason: 'forbidden' } satisfies PushResponse, 403)
      const body = await readJson<PushRequest>(request)
      if (!body || typeof body.newText !== 'string' || typeof body.baseHash !== 'string') {
        return json({ error: 'bad-request' }, 400)
      }
      return this.handlePush(body, principal, role)
    }

    if (path === '/comments') {
      if (method === 'GET') return json({ comments: this.allComments() })
      if (method === 'POST') {
        if (!roleAtLeast(role, 'commenter')) return json({ error: 'forbidden' }, 403)
        return this.handleCreateComment(await readJson<CreateCommentRequest>(request), principal)
      }
    }

    const commentAction = path.match(/^\/comments\/([^/]+)\/(replies|resolve|reactions|reattach)$/)
    if (commentAction && method === 'POST') {
      if (!roleAtLeast(role, 'commenter')) return json({ error: 'forbidden' }, 403)
      const id = commentAction[1]!
      const action = commentAction[2]!
      const payload = await readJson<Record<string, unknown>>(request)
      if (action === 'replies') return this.handleReply(id, payload, principal)
      if (action === 'resolve') return this.handleResolve(id, payload)
      if (action === 'reactions') return this.handleReaction(id, payload, principal)
      return this.handleReattach(id, payload)
    }

    if (method === 'GET' && path === '/suggestions') {
      return json({ suggestions: this.allSuggestions() })
    }

    const suggestionAction = path.match(/^\/suggestions\/([^/]+)\/(accept|reject)$/)
    if (suggestionAction && method === 'POST') {
      const id = suggestionAction[1]!
      if (suggestionAction[2] === 'accept') {
        if (!roleAtLeast(role, 'editor')) return json({ error: 'forbidden' }, 403)
        return this.handleAcceptSuggestion(id, principal)
      }
      return this.handleRejectSuggestion(id, principal, role)
    }

    if (path === '/versions') {
      if (method === 'GET') {
        const versions = [...this.store.exec<VersionRow>(
          `SELECT ${VERSION_META_COLUMNS} FROM versions ORDER BY created_at DESC, rowid DESC`,
        )].map(rowToMeta)
        return json({ versions })
      }
      if (method === 'POST') {
        if (!roleAtLeast(role, 'editor')) return json({ error: 'forbidden' }, 403)
        return this.handleCreateVersion(await readJson<{ name?: unknown }>(request), principal)
      }
    }

    const versionGet = path.match(/^\/versions\/([^/]+)$/)
    if (versionGet && method === 'GET') return this.handleGetVersion(versionGet[1]!)

    const versionRestore = path.match(/^\/versions\/([^/]+)\/restore$/)
    if (versionRestore && method === 'POST') {
      if (!roleAtLeast(role, 'editor')) return json({ error: 'forbidden' }, 403)
      return this.handleRestoreVersion(versionRestore[1]!, principal)
    }

    // Lifecycle endpoints (SPEC §11), called by the Worker on owner-only D1
    // mutations (soft delete, share-link revoke, member removal). Gated like
    // everything else by the trusted headers — and additionally on the owner
    // role, since only owner actions trigger them.
    if (method === 'POST' && path === '/admin/doc-deleted') {
      if (role !== 'owner') return json({ error: 'forbidden' }, 403)
      return this.handleDocDeleted()
    }
    if (method === 'POST' && path === '/admin/recheck') {
      if (role !== 'owner') return json({ error: 'forbidden' }, 403)
      const payload = await readJson<{ principalIds?: unknown }>(request)
      const ids = Array.isArray(payload?.principalIds)
        ? payload.principalIds.filter((x): x is string => typeof x === 'string')
        : []
      return this.handleRecheck(ids)
    }

    return json({ error: 'not-found', path }, 404)
  }

  // -------------------------------------------------------------------------
  // Lifecycle (SPEC §11)
  // -------------------------------------------------------------------------

  /** Doc soft-deleted: tell every client, then drop all connections. */
  private handleDocDeleted(): Response {
    this.broadcastEvent({ t: 'doc-deleted' })
    for (const connection of this.getConnections()) {
      connection.close(CLOSE_DOC_DELETED, 'doc-deleted')
    }
    return json({ ok: true })
  }

  /**
   * Access revoked for specific principals: the DO cannot consult D1, so the
   * Worker passes the affected principal ids and we close exactly those
   * connections. Clients reconnect and the Worker re-validates the upgrade,
   * so principals that retain access via another grant simply rejoin (with
   * their recomputed role).
   */
  private handleRecheck(principalIds: string[]): Response {
    const ids = new Set(principalIds)
    let closed = 0
    for (const connection of this.getConnections<ConnState>()) {
      const state = connection.state
      if (state && ids.has(state.principal.id)) {
        connection.close(CLOSE_ACCESS_REVOKED, 'access-revoked')
        closed++
      }
    }
    return json({ ok: true, closed })
  }

  // -------------------------------------------------------------------------
  // Content & push
  // -------------------------------------------------------------------------

  private async handleGetContent(url: URL): Promise<Response> {
    const view = url.searchParams.get('view') ?? 'working'
    if (view !== 'working' && view !== 'clean') return json({ error: 'bad-view' }, 400)
    const text = view === 'clean' ? cleanText(this.ytext, this.openSuggestions()) : this.ytext.toString()
    const hash = await sha256Hex(text)
    // Only working-view text is a valid push base: clean text is not what is
    // physically in the document, so a diff from it would strip suggestions.
    if (view === 'working') this.rememberBase(hash, text)
    const headers = new Headers({
      'content-type': 'text/markdown; charset=utf-8',
      'x-glyphdown-base-hash': hash,
      // Legacy (pre-rename) echo so outdated `ink` binaries that still read
      // x-inkroom-* keep working for one release. Remove after that (the
      // older x-inkwell-* echo from the first rename has been dropped).
      'x-inkroom-base-hash': hash,
    })
    const latest = this.latestVersion()
    if (latest) {
      headers.set('x-glyphdown-version', latest.meta.id)
      headers.set('x-inkroom-version', latest.meta.id) // legacy echo, see above
    }
    return new Response(text, { headers })
  }

  private async handlePush(body: PushRequest, principal: Principal, role: Role): Promise<Response> {
    const window = this.recordPush(principal.id, Date.now())
    if (!window.allowed) {
      const res = json({ ok: false, reason: 'rate-limited' } satisfies PushResponse, 429)
      res.headers.set('retry-after', String(window.retryAfterSec))
      return res
    }

    const newText = normalizeEol(body.newText ?? '')
    if (newText.length > MAX_DOC_BYTES) return json({ ok: false, reason: 'too-large' } satisfies PushResponse, 413)

    let base = this.lookupBase(body.baseHash)
    if (base === null && body.baseText !== undefined) {
      const supplied = normalizeEol(body.baseText)
      if ((await sha256Hex(supplied)) === body.baseHash) base = supplied
    }
    if (base === null) return json({ ok: false, reason: 'base-missing' } satisfies PushResponse, 409)

    const origin = { principal }
    if (body.suggest || role === 'suggester') {
      const current = this.ytext.toString()
      const comp = computeMergedTarget(current, base, newText)
      if (comp.drifted && !body.force && comp.deletedRatio > 0.6) {
        return json({ ok: false, reason: 'degenerate', deletedRatio: comp.deletedRatio } satisfies PushResponse, 409)
      }
      const suggestion: StoredSuggestion = {
        ...materializeSuggestion(
          this.ytext,
          comp.target,
          { id: crypto.randomUUID(), authorId: principal.id, createdAt: Date.now(), note: body.note },
          origin,
        ),
        authorName: principal.name,
        note: body.note,
      }
      this.saveSuggestion(suggestion)
      this.broadcastEvent({ t: 'suggestion', suggestion })
      if (suggestion.parts.length > 0) this.revalidateAfterRewrite(origin)
      const versionId = this.ensureAutoVersion([principal.id]).id
      return json({ ok: true, mode: 'suggest', suggestionId: suggestion.id, versionId } satisfies PushResponse)
    }

    const result = mergePush(this.ytext, base, newText, { force: body.force, origin })
    if (!result.ok) return json(result satisfies PushResponse, 409)
    if (result.applied > 0) this.revalidateAfterRewrite(origin)
    const versionId = this.ensureAutoVersion([principal.id]).id
    return json({ ok: true, mode: 'edit', applied: result.applied, failedHunks: result.failedHunks, versionId } satisfies PushResponse)
  }

  /**
   * Sliding-window push rate limit (SPEC §8.3.9: 60/min per identity):
   * record the attempt, count the window, prune expired rows. Denied
   * attempts are recorded too, so staying over the limit never drains it.
   */
  private recordPush(identity: string, now: number) {
    this.store.exec('INSERT INTO pushes (identity, ts) VALUES (?, ?)', identity, now)
    const timestamps = [...this.store.exec<{ ts: number }>('SELECT ts FROM pushes WHERE identity = ?', identity)].map(
      (r) => r.ts,
    )
    const decision = decidePushWindow(timestamps, now)
    this.store.exec('DELETE FROM pushes WHERE ts <= ?', decision.pruneBefore)
    return decision
  }

  // -------------------------------------------------------------------------
  // Comments
  // -------------------------------------------------------------------------

  private handleCreateComment(payload: CreateCommentRequest | null, principal: Principal): Response {
    const built = buildComment(this.ytext, principal, payload?.body, payload?.range)
    if (!built.ok) return json({ error: built.error }, 400)
    this.saveComment(built.value)
    this.broadcastEvent({ t: 'comment', comment: built.value })
    return json(built.value)
  }

  private handleReply(commentId: string, payload: Record<string, unknown> | null, principal: Principal): Response {
    const comment = this.loadComment(commentId)
    if (!comment) return json({ error: 'not-found' }, 404)
    const built = buildReply(principal, payload?.body)
    if (!built.ok) return json({ error: built.error }, 400)
    const updated: Comment = { ...comment, replies: [...comment.replies, built.value] }
    this.saveComment(updated)
    this.broadcastEvent({ t: 'comment', comment: updated })
    // Root author rides a header so the Worker proxy can notify them (§9)
    // without changing the response body the clients consume.
    return json(built.value, 200, { [HEADER_COMMENT_AUTHOR]: comment.authorId })
  }

  private handleResolve(commentId: string, payload: Record<string, unknown> | null): Response {
    const comment = this.loadComment(commentId)
    if (!comment) return json({ error: 'not-found' }, 404)
    const resolved = typeof payload?.resolved === 'boolean' ? payload.resolved : !comment.resolved
    const updated: Comment = { ...comment, resolved }
    this.saveComment(updated)
    this.broadcastEvent({ t: 'comment', comment: updated })
    return json({ resolved })
  }

  private handleReaction(commentId: string, payload: Record<string, unknown> | null, principal: Principal): Response {
    const comment = this.loadComment(commentId)
    if (!comment) return json({ error: 'not-found' }, 404)
    const emoji = payload?.emoji
    if (typeof emoji !== 'string' || emoji.length === 0 || emoji.length > 32) return json({ error: 'bad-emoji' }, 400)
    const updated: Comment = { ...comment, reactions: toggleReaction(comment.reactions, emoji, principal.id) }
    this.saveComment(updated)
    this.broadcastEvent({ t: 'comment', comment: updated })
    return json(updated)
  }

  private handleReattach(commentId: string, payload: Record<string, unknown> | null): Response {
    const comment = this.loadComment(commentId)
    if (!comment) return json({ error: 'not-found' }, 404)
    const result = reattachComment(this.ytext, comment, payload)
    if (!result.ok) return json({ error: result.error }, 400)
    this.saveComment(result.value)
    this.broadcastEvent({ t: 'comment', comment: result.value })
    return json(result.value)
  }

  // -------------------------------------------------------------------------
  // Suggestions
  // -------------------------------------------------------------------------

  private handleAcceptSuggestion(id: string, principal: Principal): Response {
    const record = this.loadSuggestion(id)
    if (!record) return json({ error: 'not-found' }, 404)
    if (record.status !== 'open') {
      // Idempotent under concurrent acceptance (SPEC §11).
      return json({ ok: true, outdatedParts: record.outdatedParts ?? 0 } satisfies AcceptResponse)
    }
    const origin = { principal }
    const { suggestion, outdatedParts } = acceptSuggestion(this.ytext, record, origin)
    const updated: StoredSuggestion = { ...record, status: suggestion.status, outdatedParts: outdatedParts.length }
    this.saveSuggestion(updated)
    this.broadcastEvent({ t: 'suggestion-status', id, status: updated.status, outdatedParts: outdatedParts.length })
    // Applied deletions can orphan anchors that lived inside them.
    this.revalidateAfterRewrite(origin)
    return json({ ok: true, outdatedParts: outdatedParts.length } satisfies AcceptResponse)
  }

  private handleRejectSuggestion(id: string, principal: Principal, role: Role): Response {
    const record = this.loadSuggestion(id)
    if (!record) return json({ error: 'not-found' }, 404)
    const canReject = roleAtLeast(role, 'editor')
    const canWithdraw = record.authorId === principal.id && roleAtLeast(role, 'suggester')
    if (!canReject && !canWithdraw) return json({ error: 'forbidden' }, 403)
    if (record.status !== 'open') return json({ ok: true })

    const origin = { principal }
    rejectSuggestion(this.ytext, record, origin)
    const status = canReject ? 'rejected' : 'withdrawn'
    const updated: StoredSuggestion = { ...record, status }
    this.saveSuggestion(updated)
    this.broadcastEvent({ t: 'suggestion-status', id, status })
    // Removing suggested-insert text can orphan anchors that lived inside it.
    this.revalidateAfterRewrite(origin)
    return json({ ok: true })
  }

  // -------------------------------------------------------------------------
  // Versions
  // -------------------------------------------------------------------------

  private handleCreateVersion(payload: { name?: unknown } | null, principal: Principal): Response {
    const raw = typeof payload?.name === 'string' ? payload.name.trim() : ''
    const meta = this.createVersion('named', [principal.id], raw === '' ? undefined : raw)
    return json(meta)
  }

  private handleGetVersion(id: string): Response {
    const row = [...this.store.exec<{ text: string }>('SELECT text FROM versions WHERE id = ?', id)][0]
    if (!row) return json({ error: 'not-found' }, 404)
    return json({ text: row.text })
  }

  private handleRestoreVersion(id: string, principal: Principal): Response {
    const row = [...this.store.exec<{ text: string }>('SELECT text FROM versions WHERE id = ?', id)][0]
    if (!row) return json({ error: 'not-found' }, 404)
    const origin = { principal }
    const text = normalizeEol(row.text)
    if (text !== this.ytext.toString()) {
      // Capture the pre-restore state so the restore never loses history,
      // then land the restore as minimal CRDT ops (never a doc rebuild).
      this.snapshotIfChanged('restore-point', [principal.id])
      restoreText(this.ytext, text, origin)
      this.revalidateAfterRewrite(origin)
      this.snapshotIfChanged('auto', [principal.id])
    }
    return json({ ok: true })
  }

  private createVersion(kind: VersionMeta['kind'], authorIds: string[], name?: string): VersionMeta {
    const id = crypto.randomUUID()
    const text = this.ytext.toString()
    const createdAt = Date.now()
    this.store.exec(
      'INSERT INTO versions (id, name, kind, text, state_vector, author_ids, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id, name ?? null, kind, text, Y.encodeStateVector(this.document).buffer, JSON.stringify(authorIds), createdAt,
    )
    const meta: VersionMeta = { id, createdAt, name, kind, authorIds, sizeBytes: text.length }
    this.broadcastEvent({ t: 'version', version: meta })
    // Every snapshot path (auto via ensureAutoVersion/snapshotIfChanged,
    // named, restore-point) funnels through here — the natural index hook.
    this.feedSearchIndex()
    return meta
  }

  /**
   * Fire-and-forget body upsert into the global SearchDO index (search-do.ts),
   * called after version snapshots and on save. Never blocks or fails the
   * caller — a missed update self-heals on the next snapshot/save (or the
   * cold-index backfill). Title is null: titles live in D1 and are indexed by
   * the Worker (apps/web/src/api/search.ts).
   */
  private feedSearchIndex(): void {
    let docId: string
    try {
      docId = this.name
    } catch {
      return // name unavailable (uniqueId-addressed DO) — nothing to index
    }
    const payload = JSON.stringify({ docId, title: null, body: this.ytext.toString() })
    void getServerByName(this.env.SearchDO, SEARCH_DO_NAME)
      .then((stub) =>
        stub.fetch('https://do/index', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: payload,
        }),
      )
      .catch((err) => console.warn('search index update failed:', err))
  }

  private latestVersion(): { meta: VersionMeta; text: string } | null {
    const row = [...this.store.exec<VersionRow & { text: string }>(
      `SELECT ${VERSION_META_COLUMNS}, text FROM versions ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )][0]
    if (!row) return null
    return { meta: rowToMeta(row), text: row.text }
  }

  /** Snapshot only when content drifted from the newest stored version. */
  private snapshotIfChanged(kind: VersionMeta['kind'], authorIds: string[]): VersionMeta | null {
    const text = this.ytext.toString()
    const latest = this.latestVersion()
    if (latest ? latest.text === text : text === '') return null
    return this.createVersion(kind, authorIds)
  }

  /** A version id for push receipts: dedupes against the newest snapshot. */
  private ensureAutoVersion(authorIds: string[]): VersionMeta {
    return this.snapshotIfChanged('auto', authorIds) ?? this.latestVersion()?.meta ?? this.createVersion('auto', authorIds)
  }

  // -------------------------------------------------------------------------
  // Anchor revalidation (SPEC §6.1 / §8.3.7)
  // -------------------------------------------------------------------------

  /**
   * After any out-of-band rewrite, re-validate every comment/suggestion
   * anchor: persist what changed, broadcast updated records, and auto-reject
   * suggestions whose anchors orphaned.
   */
  private revalidateAfterRewrite(origin: unknown): void {
    const result = revalidateAnchors(this.ytext, this.allComments(), this.openSuggestions(), origin)
    for (const comment of result.comments) {
      this.saveComment(comment)
      this.broadcastEvent({ t: 'comment', comment })
    }
    for (const suggestion of result.suggestions) {
      this.saveSuggestion(suggestion)
      this.broadcastEvent({ t: 'suggestion', suggestion })
    }
    for (const suggestion of result.rejected) {
      this.saveSuggestion(suggestion)
      this.broadcastEvent({ t: 'suggestion-status', id: suggestion.id, status: suggestion.status })
    }
  }

  // -------------------------------------------------------------------------
  // Sidecar storage helpers
  // -------------------------------------------------------------------------

  private allComments(): Comment[] {
    return [...this.store.exec<{ data: string }>('SELECT data FROM comments ORDER BY created_at, rowid')].map(
      (r) => JSON.parse(r.data) as Comment,
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

  private allSuggestions(): StoredSuggestion[] {
    return [...this.store.exec<{ data: string }>('SELECT data FROM suggestions ORDER BY created_at, rowid')].map(
      (r) => JSON.parse(r.data) as StoredSuggestion,
    )
  }

  private openSuggestions(): StoredSuggestion[] {
    return [
      ...this.store.exec<{ data: string }>("SELECT data FROM suggestions WHERE status = 'open' ORDER BY created_at, rowid"),
    ].map((r) => JSON.parse(r.data) as StoredSuggestion)
  }

  private loadSuggestion(id: string): StoredSuggestion | null {
    const row = [...this.store.exec<{ data: string }>('SELECT data FROM suggestions WHERE id = ?', id)][0]
    return row ? (JSON.parse(row.data) as StoredSuggestion) : null
  }

  private saveSuggestion(record: StoredSuggestion): void {
    this.store.exec(
      'INSERT OR REPLACE INTO suggestions (id, data, status, created_at) VALUES (?, ?, ?, ?)',
      record.id, JSON.stringify(record), record.status, record.createdAt,
    )
  }

  private rememberBase(hash: string, text: string): void {
    this.store.exec(
      'INSERT OR REPLACE INTO bases (hash, text, created_at) VALUES (?, ?, ?)', hash, text, Date.now(),
    )
    this.store.exec('DELETE FROM bases WHERE created_at < ?', Date.now() - BASE_TTL_MS)
  }

  private lookupBase(hash: string): string | null {
    const row = [...this.store.exec<{ text: string }>('SELECT text FROM bases WHERE hash = ?', hash)][0]
    return row?.text ?? null
  }

  private broadcastEvent(event: DocEvent, exclude?: Connection): void {
    this.broadcastCustomMessage(JSON.stringify(event), exclude)
  }
}

function json(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

/** True for binary frames whose first varint is messageSync (0). */
function isSyncMessage(message: WSMessage): boolean {
  if (typeof message === 'string') return false
  const bytes =
    message instanceof ArrayBuffer
      ? new Uint8Array(message)
      : new Uint8Array(message.buffer, message.byteOffset, message.byteLength)
  return bytes.length > 0 && bytes[0] === 0
}

async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T
  } catch {
    return null
  }
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
