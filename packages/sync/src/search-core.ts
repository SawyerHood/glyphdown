/**
 * Pure helpers for the global search index (SearchDO) — no I/O, unit-tested
 * in test/search-core.test.ts. Engine-agnostic by design so the storage layer
 * stays swappable: the FTS5 path uses `buildFtsMatch` + SQLite bm25 ranking,
 * the LIKE fallback uses `scoreEntry`, and both feed `makeSnippet` for
 * presentation.
 */

/** Wiki-link opener: `[[Target]]`, `[[Target|alias]]`, `[[Target#heading]]`. */
export const WIKI_LINK_RE = /\[\[([^\]|#]+)/g

/** Snippet window: characters of context kept on each side of the first hit. */
export const SNIPPET_RADIUS = 60

/**
 * Normalize a wiki-link target (or a doc's filename stem) for backlink
 * matching — SLUG semantics, mirroring slugifyDocStem in @glyphdown/protocol:
 * lowercase, every non-[a-z0-9] run collapsed to a single '-', edge dashes
 * trimmed. Doc names are slug filename stems now, so `[[the-garden]]` and a
 * legacy `[[The Garden]]` both normalize to the stem `the-garden`. Returns
 * '' when nothing usable remains (callers treat that as no link). Index rows
 * written under the old space-collapsing normalization heal as docs are
 * re-indexed on their next save.
 */
export function normalizeWikiTarget(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Unique normalized wiki-link targets extracted from a markdown body. */
export function extractWikiLinks(body: string): string[] {
  const out = new Set<string>()
  for (const match of body.matchAll(WIKI_LINK_RE)) {
    const norm = normalizeWikiTarget(match[1]!)
    if (norm !== '') out.add(norm)
  }
  return [...out]
}

/** Lowercased word tokens (unicode letters/digits/underscore runs) of a query. */
export function tokenizeQuery(query: string): string[] {
  return query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []
}

/**
 * Build a safe FTS5 MATCH expression from a free-form user query: each token
 * is double-quoted (so no user input is parsed as FTS syntax) with a `*`
 * prefix-match suffix, joined by implicit AND. Null when no tokens survive.
 */
export function buildFtsMatch(query: string): string | null {
  const tokens = tokenizeQuery(query)
  if (tokens.length === 0) return null
  return tokens.map((t) => `"${t}"*`).join(' ')
}

/**
 * Presentation snippet: ±SNIPPET_RADIUS chars around the FIRST occurrence of
 * any token in the body, the hit wrapped in «», clipped edges marked with an
 * ellipsis, whitespace collapsed for single-line display. Falls back to the
 * head of the body (no highlight) when no token appears — e.g. a title-only
 * hit.
 */
export function makeSnippet(body: string, tokens: string[], radius = SNIPPET_RADIUS): string {
  const lower = body.toLowerCase()
  let hitStart = -1
  let hitEnd = -1
  for (const token of tokens) {
    if (token === '') continue
    const i = lower.indexOf(token)
    if (i !== -1 && (hitStart === -1 || i < hitStart)) {
      hitStart = i
      hitEnd = i + token.length
    }
  }

  const collapse = (s: string) => s.replace(/\s+/g, ' ')
  if (hitStart === -1) {
    const head = collapse(body.slice(0, radius * 2)).trim()
    return body.length > radius * 2 ? `${head}…` : head
  }

  const from = Math.max(0, hitStart - radius)
  const to = Math.min(body.length, hitEnd + radius)
  const prefix = (from > 0 ? '…' : '') + collapse(body.slice(from, hitStart))
  const hit = collapse(body.slice(hitStart, hitEnd))
  const suffix = collapse(body.slice(hitEnd, to)) + (to < body.length ? '…' : '')
  return `${prefix}«${hit}»${suffix}`
}

/**
 * LIKE-engine ranking (FTS5-unavailable fallback): AND semantics across
 * tokens (a token missing from both title and body scores 0), title hits
 * dominate body hits, occurrence counts break ties. Substring matching to
 * mirror the FTS prefix-match behavior as closely as a scan can.
 */
export function scoreEntry(title: string, body: string, tokens: string[]): number {
  if (tokens.length === 0) return 0
  const t = title.toLowerCase()
  const b = body.toLowerCase()
  let score = 0
  for (const token of tokens) {
    const titleHits = countOccurrences(t, token)
    const bodyHits = countOccurrences(b, token)
    if (titleHits === 0 && bodyHits === 0) return 0
    score += titleHits * 100 + bodyHits
  }
  return score
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0
  let count = 0
  let i = haystack.indexOf(needle)
  while (i !== -1) {
    count++
    i = haystack.indexOf(needle, i + needle.length)
  }
  return count
}
