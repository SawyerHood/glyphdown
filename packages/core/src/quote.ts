import { DIFF_EQUAL, cleanupSemantic, makeDiff, match } from '@sanity/diff-match-patch'

/** W3C TextQuoteSelector-style snapshot of an anchored range. */
export interface TextQuote {
  exact: string
  prefix: string
  suffix: string
}

/** Context captured around a quote, in UTF-16 code units. */
export const QUOTE_CONTEXT = 32

/** Bitap (dmp match) hard limit on pattern length. */
const MATCH_MAX_BITS = 32

/** Minimum similarity for an in-place anchored range to still count as "the same text". */
export const REANCHOR_THRESHOLD = 0.5

/**
 * Minimum similarity for a *fuzzy* re-anchor match to be accepted. Stricter
 * than in-place validation: markdown is self-similar, and a wrong re-anchor
 * silently attaches a comment to unrelated text (Hypothesis uses ~0.8).
 */
export const FUZZY_ACCEPT_THRESHOLD = 0.8

export function captureQuote(text: string, start: number, end: number): TextQuote {
  return {
    exact: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - QUOTE_CONTEXT), start),
    suffix: text.slice(end, end + QUOTE_CONTEXT),
  }
}

/** Ratio of common content between two strings, 0..1. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1
  if (a.length === 0 || b.length === 0) return 0
  const diffs = cleanupSemantic(makeDiff(a, b))
  let equal = 0
  for (const [op, chunk] of diffs) {
    if (op === DIFF_EQUAL) equal += chunk.length
  }
  return (2 * equal) / (a.length + b.length)
}

export interface QuoteMatch {
  start: number
  end: number
  score: number
}

/**
 * Find where a quote now lives in `text`, preferring matches near `hint`.
 * Tries exact occurrences first, then a fuzzy bitap search. Returns null if
 * nothing matches above REANCHOR_THRESHOLD.
 */
export function findQuote(text: string, quote: TextQuote, hint: number): QuoteMatch | null {
  const { exact } = quote
  if (exact.length === 0) return null

  const candidates: QuoteMatch[] = []
  let from = 0
  while (true) {
    const idx = text.indexOf(exact, from)
    if (idx === -1) break
    candidates.push({ start: idx, end: idx + exact.length, score: contextScore(text, quote, idx) })
    from = idx + 1
  }

  if (candidates.length > 0) {
    candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return Math.abs(a.start - hint) - Math.abs(b.start - hint)
    })
    return candidates[0] ?? null
  }

  // Fuzzy fallback: bitap-match a window of the quote, then verify the rest.
  const pattern = exact.slice(0, MATCH_MAX_BITS)
  const loc = match(text, pattern, Math.max(0, Math.min(hint, text.length)))
  if (loc === -1) return null
  const end = Math.min(text.length, loc + exact.length)
  const found = text.slice(loc, end)
  const score = similarity(found, exact)
  if (score < FUZZY_ACCEPT_THRESHOLD) return null
  return { start: loc, end, score }
}

function contextScore(text: string, quote: TextQuote, at: number): number {
  let score = 1 // exact body match
  if (quote.prefix) {
    const before = text.slice(Math.max(0, at - quote.prefix.length), at)
    score += similarity(before, quote.prefix)
  }
  if (quote.suffix) {
    const after = text.slice(at + quote.exact.length, at + quote.exact.length + quote.suffix.length)
    score += similarity(after, quote.suffix)
  }
  return score
}
