import { env, waitUntil } from 'cloudflare:workers'
import { getServerByName, type Server } from 'partyserver'
import { docFilenameStem, type DocMeta, type Principal, type Role, type SearchResult } from '@glyphdown/protocol'
import { SEARCH_DO_NAME, normalizeWikiTarget, type SearchResponse } from '@glyphdown/sync'
import { asAppEnv } from '../env.ts'
import type { Db } from '../db/client.ts'
import { trustedHeaders } from './auth.ts'
import { accessibleDocs, type DocRow } from './roles.ts'

/**
 * Worker side of the search surface (SPEC addendum; index lives in the single
 * global SearchDO — packages/sync/src/search-do.ts):
 *
 *   GET /api/search?q=…           — full-text over the caller's accessible
 *                                   docs (the exact GET /api/docs closure).
 *   GET /api/docs/:id/backlinks   — docs wiki-linking [[this doc's title]],
 *                                   filtered to the caller's accessible set.
 *
 * Index feeds: DocDO posts bodies after snapshots/saves; this module posts
 * titles on doc create/rename and removals on delete (D1 owns titles).
 *
 * Cold-index backfill: a brand-new deployment has an empty index but existing
 * docs. When SearchDO reports `coldIndex`, we fetch each accessible doc's
 * content from its DocDO and index it — fire-and-forget via waitUntil,
 * bounded to BACKFILL_MAX_DOCS. One shot per cold /search; once any entry
 * lands the flag never trips again.
 */

const BACKFILL_MAX_DOCS = 200
const SEARCH_LIMIT = 20

/** Synthetic principal for backfill /content reads (the DO only logs it). */
const INDEXER: Principal = { id: 'system:search-indexer', type: 'user', name: 'Search indexer' }

type AccessMap = Map<string, { doc: DocRow; role: Role }>

async function callSearchDO<T>(path: '/index' | '/remove' | '/search' | '/backlinks', payload: unknown): Promise<T> {
  const namespace = asAppEnv(env).SearchDO as unknown as DurableObjectNamespace<Server<Env>>
  const stub = await getServerByName(namespace, SEARCH_DO_NAME)
  const res = await stub.fetch(`https://do${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(`SearchDO ${path} failed: ${res.status}`)
  return (await res.json()) as T
}

// ---------------------------------------------------------------------------
// Public handlers (wired in router.ts)
// ---------------------------------------------------------------------------

/** GET /api/search?q=… -> { results: SearchResult[] } */
export async function handleSearch(db: Db, url: URL, principal: Principal): Promise<Response> {
  const access = await accessibleDocs(db, principal)
  if (access === null) return json({ error: 'forbidden' }, 403)
  const q = (url.searchParams.get('q') ?? '').trim()
  if (q === '' || access.size === 0) return json({ results: [] })

  const data = await callSearchDO<SearchResponse>('/search', {
    query: q,
    allowedDocIds: [...access.keys()],
    limit: SEARCH_LIMIT,
  })
  if (data.coldIndex) waitUntil(backfillIndex(access))

  // D1 is the name source of truth — the index copy may trail a rename. The
  // displayed "title" is always the filename stem (filesystem model).
  const results: SearchResult[] = data.results.map((r) => {
    const hit = access.get(r.docId)
    return { ...r, title: hit ? stemOf(hit.doc) : r.title }
  })
  return json({ results })
}

/**
 * GET /api/docs/:id/backlinks -> { docs: DocMeta[] } — docs whose bodies
 * contain [[<this doc's title>]], visible to the caller. Anonymous share-link
 * visitors have no doc closure beyond the shared doc, so they get [].
 */
export async function handleBacklinks(db: Db, doc: DocRow, principal: Principal | null): Promise<Response> {
  if (!principal || principal.id === 'anonymous') return json({ docs: [] })
  const access = await accessibleDocs(db, principal)
  if (access === null) return json({ docs: [] })

  const { docIds } = await callSearchDO<{ docIds: string[] }>('/backlinks', {
    // Wiki-link targets resolve against filename stems; normalizeWikiTarget
    // slugifies both sides, so old [[Title With Spaces]] links still hit.
    titleNorm: normalizeWikiTarget(stemOf(doc)),
    allowedDocIds: [...access.keys()],
  })
  const docs: DocMeta[] = []
  for (const id of docIds) {
    const hit = access.get(id)
    if (hit) docs.push(toDocMeta(hit.doc, hit.role))
  }
  return json({ docs })
}

// ---------------------------------------------------------------------------
// Index feeds from the Worker (titles live in D1; bodies come from DocDO)
// ---------------------------------------------------------------------------

/** Title-only upsert on doc create/rename — never blocks the caller. */
export function feedTitleToIndex(docId: string, title: string): void {
  waitUntil(
    callSearchDO('/index', { docId, title }).catch((err) => console.warn('search title index failed:', err)),
  )
}

/** Drop a doc from the index on (soft) delete — never blocks the caller. */
export function removeFromIndex(docId: string): void {
  waitUntil(callSearchDO('/remove', { docId }).catch((err) => console.warn('search index remove failed:', err)))
}

// ---------------------------------------------------------------------------
// Cold-index backfill
// ---------------------------------------------------------------------------

async function backfillIndex(access: AccessMap): Promise<void> {
  const namespace = asAppEnv(env).DocDO as unknown as DurableObjectNamespace<Server<Env>>
  const docs = [...access.values()].slice(0, BACKFILL_MAX_DOCS)
  for (const { doc } of docs) {
    try {
      const stub = await getServerByName(namespace, doc.id)
      const res = await stub.fetch('https://do/content?view=working', {
        headers: trustedHeaders({ principal: INDEXER, role: 'viewer' }),
      })
      if (!res.ok) continue
      const body = await res.text()
      await callSearchDO('/index', { docId: doc.id, title: stemOf(doc), body })
    } catch (err) {
      console.warn(`search backfill failed for doc ${doc.id}:`, err)
    }
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** Display stem of a doc row (legacy-title fallback for unbackfilled rows). */
function stemOf(doc: Pick<DocRow, 'title' | 'filename'>): string {
  return doc.filename !== '' ? docFilenameStem(doc.filename) : doc.title
}

function toDocMeta(doc: DocRow, role: Role): DocMeta {
  return {
    id: doc.id,
    filename: doc.filename,
    title: stemOf(doc),
    folderId: doc.folderId,
    ownerUserId: doc.ownerUserId,
    role,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  }
}
