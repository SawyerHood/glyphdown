import { Server } from 'partyserver'
import type { SyncEnv } from './do.ts'
import {
  buildFtsMatch,
  extractWikiLinks,
  makeSnippet,
  normalizeWikiTarget,
  scoreEntry,
  tokenizeQuery,
} from './search-core.ts'

/** The single global index instance (addressed via getServerByName). */
export const SEARCH_DO_NAME = 'global'

/** Default/maximum result counts for /search. */
export const SEARCH_DEFAULT_LIMIT = 20
export const SEARCH_MAX_LIMIT = 50
/** FTS candidate rows fetched before permission filtering. */
const SEARCH_CANDIDATE_ROWS = 400

// ---------------------------------------------------------------------------
// Request/response shapes (Worker <-> SearchDO; all POST, all internal)
// ---------------------------------------------------------------------------
// POST /index      IndexRequest      -> { ok: true }
// POST /remove     { docId }         -> { ok: true }
// POST /search     SearchRequest     -> SearchResponse
// POST /backlinks  BacklinksRequest  -> { docIds: string[] }

export interface IndexRequest {
  docId: string
  /** New title; null/undefined leaves the stored title unchanged. */
  title?: string | null
  /** New body (re-extracts wiki-links); undefined leaves the stored body unchanged. */
  body?: string | null
}

export interface SearchRequest {
  query: string
  /** Permission filter: only these doc ids may appear in results. */
  allowedDocIds: string[]
  limit?: number
}

export interface SearchHit {
  docId: string
  title: string
  snippet: string
  score: number
}

export interface SearchResponse {
  results: SearchHit[]
  /**
   * Set when the index has never been fed (entries empty) but the caller can
   * see docs — the Worker reacts with a one-shot backfill (api/search.ts).
   */
  coldIndex?: boolean
}

export interface BacklinksRequest {
  titleNorm: string
  allowedDocIds: string[]
}

type EntryRow = { doc_id: string; title: string | null; body: string | null }

/**
 * Global full-text + wiki-link index, one Durable Object for the whole
 * deployment (name 'global'). Owns:
 *
 *   - `entries(doc_id PK, title, body, updated_at)` — canonical indexed copy.
 *     Titles are fed by the Worker (D1 owns them); bodies are fed by each
 *     DocDO after snapshots/saves (do.ts) and by the cold-index backfill.
 *   - `entries_fts` — FTS5 shadow of entries (engine of record when the
 *     runtime supports it; the spike against workerd 1.20260603 confirmed
 *     ENABLE_FTS5). If CREATE VIRTUAL TABLE ever fails the DO degrades to a
 *     LIKE-scan over `entries` ranked by search-core's scoreEntry.
 *   - `links(src_doc_id, target_title_norm)` — wiki-links ([[Target]])
 *     extracted from each indexed body; /backlinks resolves them.
 *
 * Trust model: like DocDO, this DO is never internet-reachable. The Worker's
 * /parties/* route authenticates against doc ids so the 'global' room can
 * never resolve, and the /api FORWARDABLE allowlist only proxies DocDO paths
 * — every request here arrives via internal stub.fetch with the caller's
 * permissions already reduced to `allowedDocIds`. No principal headers
 * needed.
 */
export class SearchDO extends Server<SyncEnv> {
  static override options = { hibernate: true }

  /** 'fts5' unless the virtual-table probe fails at startup. */
  private engine: 'fts5' | 'like' = 'fts5'

  private get store() {
    return this.ctx.storage.sql
  }

  override async onStart(): Promise<void> {
    this.store.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        doc_id TEXT PRIMARY KEY, title TEXT, body TEXT, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS links (src_doc_id TEXT NOT NULL, target_title_norm TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS links_target_idx ON links (target_title_norm);
      CREATE INDEX IF NOT EXISTS links_src_idx ON links (src_doc_id);
    `)
    try {
      this.store.exec('CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(doc_id UNINDEXED, title, body)')
      this.engine = 'fts5'
    } catch (err) {
      console.warn('SearchDO: FTS5 unavailable, falling back to LIKE engine:', err)
      this.engine = 'like'
    }
  }

  override async onRequest(request: Request): Promise<Response> {
    if (request.method !== 'POST') return json({ error: 'method-not-allowed' }, 405)
    const path = new URL(request.url).pathname
    let payload: Record<string, unknown>
    try {
      payload = (await request.json()) as Record<string, unknown>
    } catch {
      return json({ error: 'bad-request' }, 400)
    }
    try {
      if (path === '/index') return this.handleIndex(payload)
      if (path === '/remove') return this.handleRemove(payload)
      if (path === '/search') return this.handleSearch(payload)
      if (path === '/backlinks') return this.handleBacklinks(payload)
    } catch (err) {
      console.error('SearchDO request failed:', err)
      return json({ error: 'internal' }, 500)
    }
    return json({ error: 'not-found', path }, 404)
  }

  // -------------------------------------------------------------------------
  // Index maintenance
  // -------------------------------------------------------------------------

  /**
   * Upsert one doc. Title and body update independently (title-only writes
   * from the Worker's D1 hooks leave the body; body-only writes from DocDO
   * leave the title), and a body write re-extracts the doc's wiki-links.
   */
  private handleIndex(payload: Record<string, unknown>): Response {
    const docId = typeof payload.docId === 'string' ? payload.docId : ''
    if (docId === '') return json({ error: 'bad-doc-id' }, 400)
    const existing = [
      ...this.store.exec<EntryRow>('SELECT doc_id, title, body FROM entries WHERE doc_id = ?', docId),
    ][0]
    const title = typeof payload.title === 'string' ? payload.title : (existing?.title ?? null)
    const bodyProvided = typeof payload.body === 'string'
    const body = bodyProvided ? (payload.body as string) : (existing?.body ?? null)

    this.ctx.storage.transactionSync(() => {
      this.store.exec(
        `INSERT INTO entries (doc_id, title, body, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(doc_id) DO UPDATE SET title = excluded.title, body = excluded.body, updated_at = excluded.updated_at`,
        docId, title, body, Date.now(),
      )
      if (this.engine === 'fts5') {
        this.store.exec('DELETE FROM entries_fts WHERE doc_id = ?', docId)
        this.store.exec('INSERT INTO entries_fts (doc_id, title, body) VALUES (?, ?, ?)', docId, title ?? '', body ?? '')
      }
      if (bodyProvided) {
        this.store.exec('DELETE FROM links WHERE src_doc_id = ?', docId)
        for (const target of extractWikiLinks(body ?? '')) {
          this.store.exec('INSERT INTO links (src_doc_id, target_title_norm) VALUES (?, ?)', docId, target)
        }
      }
    })
    return json({ ok: true })
  }

  private handleRemove(payload: Record<string, unknown>): Response {
    const docId = typeof payload.docId === 'string' ? payload.docId : ''
    if (docId === '') return json({ error: 'bad-doc-id' }, 400)
    this.ctx.storage.transactionSync(() => {
      this.store.exec('DELETE FROM entries WHERE doc_id = ?', docId)
      if (this.engine === 'fts5') this.store.exec('DELETE FROM entries_fts WHERE doc_id = ?', docId)
      this.store.exec('DELETE FROM links WHERE src_doc_id = ?', docId)
    })
    return json({ ok: true })
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  private handleSearch(payload: Record<string, unknown>): Response {
    const query = typeof payload.query === 'string' ? payload.query : ''
    const allowed = stringArray(payload.allowedDocIds)
    const limit = clampLimit(payload.limit)

    // Cold index: never fed, yet the caller can see docs — signal the Worker
    // to backfill (one-shot; see apps/web/src/api/search.ts).
    const total = [...this.store.exec<{ n: number }>('SELECT COUNT(*) AS n FROM entries')][0]?.n ?? 0
    if (total === 0 && allowed.length > 0) {
      return json({ results: [], coldIndex: true } satisfies SearchResponse)
    }

    const tokens = tokenizeQuery(query)
    if (tokens.length === 0 || allowed.length === 0) return json({ results: [] } satisfies SearchResponse)
    const allowedSet = new Set(allowed)
    const results =
      this.engine === 'fts5' ? this.searchFts(query, tokens, allowedSet, limit) : this.searchLike(tokens, allowedSet, limit)
    return json({ results } satisfies SearchResponse)
  }

  /** FTS5 engine: bm25-ranked MATCH (title weighted 5x body), then permission filter. */
  private searchFts(query: string, tokens: string[], allowedSet: Set<string>, limit: number): SearchHit[] {
    const match = buildFtsMatch(query)
    if (match === null) return []
    const rows = this.store.exec<EntryRow & { rank: number }>(
      `SELECT doc_id, title, body, bm25(entries_fts, 0.0, 5.0, 1.0) AS rank
       FROM entries_fts WHERE entries_fts MATCH ? ORDER BY rank LIMIT ?`,
      match, SEARCH_CANDIDATE_ROWS,
    )
    const results: SearchHit[] = []
    for (const row of rows) {
      if (!allowedSet.has(row.doc_id)) continue
      results.push({
        docId: row.doc_id,
        title: row.title ?? '',
        snippet: makeSnippet(row.body ?? '', tokens),
        score: -row.rank, // bm25 is more-negative-is-better; flip so higher = better
      })
      if (results.length >= limit) break
    }
    return results
  }

  /** LIKE fallback engine: full scan ranked by scoreEntry (title > body, occurrences). */
  private searchLike(tokens: string[], allowedSet: Set<string>, limit: number): SearchHit[] {
    const scored: SearchHit[] = []
    for (const row of this.store.exec<EntryRow>('SELECT doc_id, title, body FROM entries')) {
      if (!allowedSet.has(row.doc_id)) continue
      const score = scoreEntry(row.title ?? '', row.body ?? '', tokens)
      if (score <= 0) continue
      scored.push({ docId: row.doc_id, title: row.title ?? '', snippet: makeSnippet(row.body ?? '', tokens), score })
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit)
  }

  private handleBacklinks(payload: Record<string, unknown>): Response {
    const titleNorm = normalizeWikiTarget(typeof payload.titleNorm === 'string' ? payload.titleNorm : '')
    const allowedSet = new Set(stringArray(payload.allowedDocIds))
    if (titleNorm === '' || allowedSet.size === 0) return json({ docIds: [] })
    const docIds = [
      ...this.store.exec<{ src_doc_id: string }>(
        'SELECT DISTINCT src_doc_id FROM links WHERE target_title_norm = ?', titleNorm,
      ),
    ]
      .map((r) => r.src_doc_id)
      .filter((id) => allowedSet.has(id))
    return json({ docIds })
  }
}

function clampLimit(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : SEARCH_DEFAULT_LIMIT
  return Math.min(Math.max(n, 1), SEARCH_MAX_LIMIT)
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : []
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}
