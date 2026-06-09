import { describe, expect, it } from 'vitest'
import {
  buildFtsMatch,
  extractWikiLinks,
  makeSnippet,
  normalizeWikiTarget,
  scoreEntry,
  tokenizeQuery,
} from '../src/search-core.ts'

describe('normalizeWikiTarget', () => {
  it('slug-normalizes: lowercase, non-alphanumeric runs to single dashes, edges trimmed', () => {
    expect(normalizeWikiTarget('  My   Great\tDoc ')).toBe('my-great-doc')
    expect(normalizeWikiTarget('already-clean')).toBe('already-clean')
    expect(normalizeWikiTarget('   ')).toBe('')
  })

  it('equates a legacy spaced title with its filename stem', () => {
    expect(normalizeWikiTarget('The Garden')).toBe(normalizeWikiTarget('the-garden'))
    expect(normalizeWikiTarget('Q3 — Plan!')).toBe('q3-plan')
  })
})

describe('extractWikiLinks', () => {
  it('extracts plain links (slug-normalized to filename stems)', () => {
    expect(extractWikiLinks('see [[Other Doc]] for details')).toEqual(['other-doc'])
  })

  it('strips alias and heading segments', () => {
    expect(extractWikiLinks('[[Target|the alias]] and [[Other#section]]')).toEqual(['target', 'other'])
  })

  it('normalizes and dedupes', () => {
    expect(extractWikiLinks('[[My Doc]] then [[  my   DOC ]] again')).toEqual(['my-doc'])
    expect(extractWikiLinks('[[my-doc]] and [[My Doc]]')).toEqual(['my-doc'])
  })

  it('ignores empty targets and bare brackets', () => {
    expect(extractWikiLinks('nothing [[ ]] here, nor [[')).toEqual([])
    expect(extractWikiLinks('no links at all')).toEqual([])
  })

  it('handles multiple links across lines', () => {
    expect(extractWikiLinks('a [[One]]\nb [[Two|t]]\nc [[Three#h|x]]')).toEqual(['one', 'two', 'three'])
  })
})

describe('tokenizeQuery / buildFtsMatch', () => {
  it('tokenizes to lowercase word runs', () => {
    expect(tokenizeQuery('Hello, World! 42')).toEqual(['hello', 'world', '42'])
    expect(tokenizeQuery('  ')).toEqual([])
  })

  it('quotes every token with a prefix star (no user FTS syntax leaks)', () => {
    expect(buildFtsMatch('quick fox')).toBe('"quick"* "fox"*')
    // FTS operators/quotes in user input become plain quoted tokens.
    expect(buildFtsMatch('foo OR "bar"')).toBe('"foo"* "or"* "bar"*')
    expect(buildFtsMatch('col:value*')).toBe('"col"* "value"*')
  })

  it('returns null for empty queries', () => {
    expect(buildFtsMatch('')).toBeNull()
    expect(buildFtsMatch('!!! ???')).toBeNull()
  })
})

describe('makeSnippet', () => {
  it('highlights the first hit with «» and clips ±radius', () => {
    const body = `${'a'.repeat(100)} needle ${'b'.repeat(100)}`
    const snippet = makeSnippet(body, ['needle'])
    expect(snippet).toContain('«needle»')
    expect(snippet.startsWith('…')).toBe(true)
    expect(snippet.endsWith('…')).toBe(true)
    // ±60 around the hit plus markers/ellipses, never the whole body.
    expect(snippet.length).toBeLessThan(140)
  })

  it('omits the leading ellipsis when the hit is at the start', () => {
    const snippet = makeSnippet(`needle then ${'x'.repeat(200)}`, ['needle'])
    expect(snippet.startsWith('«needle»')).toBe(true)
    expect(snippet.endsWith('…')).toBe(true)
  })

  it('uses the earliest hit across tokens', () => {
    const snippet = makeSnippet('first zebra then aardvark', ['aardvark', 'zebra'])
    expect(snippet).toContain('«zebra»')
    expect(snippet).not.toContain('«aardvark»')
  })

  it('matches case-insensitively but keeps original casing', () => {
    expect(makeSnippet('The Needle is here', ['needle'])).toBe('The «Needle» is here')
  })

  it('falls back to the head of the body when no token hits (title-only match)', () => {
    const snippet = makeSnippet(`${'word '.repeat(60)}`, ['missing'])
    expect(snippet).not.toContain('«')
    expect(snippet.endsWith('…')).toBe(true)
  })

  it('collapses newlines for single-line display', () => {
    expect(makeSnippet('line one\nneedle\nline two', ['needle'])).toBe('line one «needle» line two')
  })
})

describe('scoreEntry (LIKE-engine ranking)', () => {
  it('requires every token to match somewhere (AND semantics)', () => {
    expect(scoreEntry('Title', 'body text', ['body', 'absent'])).toBe(0)
    expect(scoreEntry('Title', 'body text', [])).toBe(0)
  })

  it('ranks title hits above body hits', () => {
    const titleHit = scoreEntry('the zebra guide', 'nothing here', ['zebra'])
    const bodyHit = scoreEntry('untitled', 'zebra zebra zebra zebra', ['zebra'])
    expect(titleHit).toBeGreaterThan(bodyHit)
  })

  it('counts occurrences to break ties', () => {
    const once = scoreEntry('t', 'zebra', ['zebra'])
    const thrice = scoreEntry('t', 'zebra zebra zebra', ['zebra'])
    expect(thrice).toBeGreaterThan(once)
  })

  it('is case-insensitive', () => {
    expect(scoreEntry('ZEBRA', 'plain', ['zebra'])).toBeGreaterThan(0)
  })
})
