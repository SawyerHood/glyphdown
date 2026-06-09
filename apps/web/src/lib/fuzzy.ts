/**
 * Subsequence fuzzy matching for the Cmd+K quick switcher (pure — tested in
 * fuzzy.test.ts). Greedy leftmost subsequence with bonuses for consecutive
 * and word-boundary matches; `rankDocs` layers a recency boost from the
 * visited-docs list on top.
 */

export interface FuzzyHit {
  score: number
  /** Matched character indices in the target (for highlight rendering). */
  positions: number[]
}

const BOUNDARY = /[\s\-_/([{.,:#]/

/**
 * Case-insensitive subsequence match of `query` inside `target`. Null when
 * the query is not a subsequence; otherwise a score (higher = better):
 * +1 per matched char, +3 when consecutive with the previous match, +2 on a
 * word boundary, minus mild penalties for late first hits / long targets so
 * tight matches in short titles win.
 */
export function fuzzyMatch(query: string, target: string): FuzzyHit | null {
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  if (q.length === 0) return { score: 0, positions: [] }

  const positions: number[] = []
  let score = 0
  let search = 0
  let prev = -2
  for (const ch of q) {
    const at = t.indexOf(ch, search)
    if (at === -1) return null
    score += 1
    if (at === prev + 1) score += 3
    if (at === 0 || BOUNDARY.test(t[at - 1]!)) score += 2
    positions.push(at)
    prev = at
    search = at + 1
  }
  score -= Math.min(positions[0]! * 0.1, 2)
  score -= Math.min((t.length - q.length) * 0.05, 2)
  return { score, positions }
}

/** Max score bump for the most recently visited doc (decays down the list). */
export const RECENCY_BOOST = 4

export interface RankedDoc<T> {
  doc: T
  score: number
  positions: number[]
}

/**
 * Rank docs by fuzzy title match + recency. `recentIds` is most-recent-first
 * (lib/recents.ts). An empty query matches everything with score 0, so the
 * boost surfaces recents first and ties keep the caller's order (pass docs
 * sorted by updatedAt desc) — Array.prototype.sort is stable.
 */
export function rankDocs<T extends { id: string; title: string }>(
  query: string,
  docs: T[],
  recentIds: string[],
  limit = 8,
): RankedDoc<T>[] {
  const recencyRank = new Map(recentIds.map((id, i) => [id, i]))
  const boost = (id: string): number => {
    const rank = recencyRank.get(id)
    if (rank === undefined) return 0
    return RECENCY_BOOST * (1 - rank / Math.max(recentIds.length, 1))
  }

  const ranked: RankedDoc<T>[] = []
  for (const doc of docs) {
    const hit = fuzzyMatch(query, doc.title)
    if (hit === null) continue
    ranked.push({ doc, score: hit.score + boost(doc.id), positions: hit.positions })
  }
  return ranked.sort((a, b) => b.score - a.score).slice(0, limit)
}
