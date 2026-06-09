import { describe, expect, it } from 'vitest'
import { fuzzyMatch, rankDocs } from './fuzzy.ts'

describe('fuzzyMatch', () => {
  it('matches subsequences case-insensitively', () => {
    const hit = fuzzyMatch('mtg', 'Meeting Notes')
    expect(hit).not.toBeNull()
    expect(hit!.positions).toEqual([0, 3, 6])
  })

  it('returns null when the query is not a subsequence', () => {
    expect(fuzzyMatch('xyz', 'Meeting Notes')).toBeNull()
    expect(fuzzyMatch('notesx', 'Notes')).toBeNull()
  })

  it('matches everything on an empty query', () => {
    expect(fuzzyMatch('', 'Anything')).toEqual({ score: 0, positions: [] })
  })

  it('scores consecutive runs above scattered matches', () => {
    const consecutive = fuzzyMatch('note', 'Notebook')!
    const scattered = fuzzyMatch('note', 'Nine of the elephants')!
    expect(consecutive.score).toBeGreaterThan(scattered.score)
  })

  it('rewards word-boundary hits', () => {
    const boundary = fuzzyMatch('dn', 'Design Notes')!
    const interior = fuzzyMatch('dn', 'sdxnx')!
    expect(boundary.score).toBeGreaterThan(interior.score)
  })

  it('prefers tighter matches in shorter titles', () => {
    const short = fuzzyMatch('plan', 'Plan')!
    const long = fuzzyMatch('plan', 'Permanent long-range annotations')!
    expect(short.score).toBeGreaterThan(long.score)
  })
})

describe('rankDocs', () => {
  const docs = [
    { id: 'a', title: 'Architecture' },
    { id: 'b', title: 'Budget 2026' },
    { id: 'c', title: 'Archive cleanup' },
    { id: 'd', title: 'Daily journal' },
  ]

  it('filters to fuzzy matches and sorts best-first', () => {
    const ranked = rankDocs('arch', docs, [])
    expect(ranked.map((r) => r.doc.id)).toEqual(['a', 'c'])
  })

  it('surfaces recents first on an empty query, keeping input order for the rest', () => {
    const ranked = rankDocs('', docs, ['d', 'b'])
    expect(ranked.map((r) => r.doc.id)).toEqual(['d', 'b', 'a', 'c'])
  })

  it('boosts recently visited docs within matches', () => {
    // Both titles match 'ar'; recency flips the order.
    const ranked = rankDocs('ar', docs, ['c'])
    expect(ranked[0]!.doc.id).toBe('c')
  })

  it('caps the result count', () => {
    expect(rankDocs('', docs, [], 2)).toHaveLength(2)
  })

  it('exposes match positions for highlighting', () => {
    const ranked = rankDocs('bud', docs, [])
    expect(ranked[0]!.doc.id).toBe('b')
    expect(ranked[0]!.positions).toEqual([0, 1, 2])
  })
})
