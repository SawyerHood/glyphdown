import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  SuggestSession,
  acceptSuggestion,
  cleanText,
  rejectSuggestion,
  resolveAnchor,
  type Suggestion,
} from '../src/index.ts'
import { docWith, joinParas, paragraphsArb, wordArb } from './helpers.ts'

function makeSession(ytext: ReturnType<typeof docWith>, opts: { now?: () => number } = {}) {
  let n = 0
  return new SuggestSession(ytext, 'author-1', { newId: () => `s${++n}`, now: opts.now ?? (() => 1000) })
}

describe('SuggestSession', () => {
  it('coalesces continuous typing into one insert part', () => {
    const ytext = docWith('hello world')
    const session = makeSession(ytext)
    const s1 = session.insert(5, ' brave')
    const s2 = session.insert(11, ' new')
    expect(s2.id).toBe(s1.id)
    expect(ytext.toString()).toBe('hello brave new world')
    expect(s2.parts).toHaveLength(1)
    const range = resolveAnchor(ytext, s2.parts[0]!.anchor)
    expect(ytext.toString().slice(range!.start, range!.end)).toBe(' brave new')
  })

  it('marks deletions of original text without removing it', () => {
    const ytext = docWith('keep remove keep')
    const session = makeSession(ytext)
    const s = session.delete(4, 11) // " remove"
    expect(ytext.toString()).toBe('keep remove keep') // physically untouched
    expect(s.parts).toHaveLength(1)
    expect(s.parts[0]!.kind).toBe('delete')
    const { suggestion: accepted } = acceptSuggestion(ytext, s)
    expect(accepted.status).toBe('accepted')
    expect(ytext.toString()).toBe('keep keep')
  })

  it('really deletes the author\'s own pending insertion (backspace over typed text)', () => {
    const ytext = docWith('hello world')
    const session = makeSession(ytext)
    let s = session.insert(5, ' brave')
    expect(ytext.toString()).toBe('hello brave world')
    s = session.delete(9, 11) // backspace the "ve"
    expect(ytext.toString()).toBe('hello bra world')
    // No delete part created — it was the author's own suggested text.
    expect(s.parts.filter((p) => p.kind === 'delete')).toHaveLength(0)
    rejectSuggestion(ytext, s)
    expect(ytext.toString()).toBe('hello world')
  })

  it('splits a mixed deletion: own insertion removed, original text only marked', () => {
    const ytext = docWith('alpha beta gamma')
    const session = makeSession(ytext)
    let s = session.insert(10, ' INSERTED') // "alpha beta INSERTED gamma"
    // Delete " INSERTED gam" — spans own insert plus original " gam".
    s = session.delete(10, 23)
    const text = ytext.toString()
    expect(text).toBe('alpha beta gamma') // insertion physically gone, original retained
    const deleteParts = s.parts.filter((p) => p.kind === 'delete')
    expect(deleteParts).toHaveLength(1)
    const { suggestion: accepted } = acceptSuggestion(ytext, s)
    expect(accepted.status).toBe('accepted')
    expect(ytext.toString()).toBe('alpha betama')
  })

  it('starts a new suggestion after the coalescing window', () => {
    const ytext = docWith('one two three')
    let clock = 0
    const session = makeSession(ytext, { now: () => clock })
    const s1 = session.insert(3, ' X')
    clock = 60_000
    const s2 = session.insert(9, ' Y')
    expect(s2.id).not.toBe(s1.id)
  })

  it('starts a new suggestion for edits far apart in the document', () => {
    const paras = ['first paragraph text here', 'second paragraph text here', 'third paragraph text here', 'fourth paragraph text here']
    const ytext = docWith(joinParas(paras))
    const session = makeSession(ytext)
    const s1 = session.insert(5, ' NEAR')
    const farPos = ytext.toString().indexOf('fourth')
    const s2 = session.insert(farPos, 'FAR ')
    expect(s2.id).not.toBe(s1.id)
  })

  it('keeps the clean view identical to the original at every step (property)', () => {
    fc.assert(
      fc.property(
        paragraphsArb,
        fc.array(
          fc.record({
            insert: fc.boolean(),
            pos: fc.nat(),
            len: fc.integer({ min: 1, max: 8 }),
            word: wordArb,
          }),
          { minLength: 1, maxLength: 12 },
        ),
        (paras, ops) => {
          const original = joinParas(paras)
          const ytext = docWith(original)
          const session = makeSession(ytext)
          const seen = new Map<string, Suggestion>()

          for (const op of ops) {
            const len = ytext.length
            let s: Suggestion
            if (op.insert) {
              s = session.insert(op.pos % (len + 1), ` ${op.word} `)
            } else {
              const start = op.pos % len
              const end = Math.min(len, start + op.len)
              if (end <= start) continue
              s = session.delete(start, end)
            }
            seen.set(s.id, s)
            // Invariant: rejecting everything must always recover the original.
            expect(cleanText(ytext, [...seen.values()])).toBe(original)
          }

          // Reject-all really does restore the original.
          for (const s of seen.values()) rejectSuggestion(ytext, s)
          expect(ytext.toString()).toBe(original)
        },
      ),
      { numRuns: 40 },
    )
  })

  it('accept-all equals working text minus marked deletions (property)', () => {
    fc.assert(
      fc.property(
        paragraphsArb,
        fc.array(
          fc.record({ insert: fc.boolean(), pos: fc.nat(), len: fc.integer({ min: 1, max: 6 }), word: wordArb }),
          { minLength: 1, maxLength: 10 },
        ),
        (paras, ops) => {
          const original = joinParas(paras)
          const ytext = docWith(original)
          const session = makeSession(ytext)
          const seen = new Map<string, Suggestion>()

          for (const op of ops) {
            const len = ytext.length
            if (op.insert) {
              const s = session.insert(op.pos % (len + 1), ` ${op.word} `)
              seen.set(s.id, s)
            } else {
              const start = op.pos % len
              const end = Math.min(len, start + op.len)
              if (end <= start) continue
              const s = session.delete(start, end)
              seen.set(s.id, s)
            }
          }

          // Expected accept-all result: working text minus all marked delete ranges.
          const working = ytext.toString()
          const deleteRanges = [...seen.values()]
            .flatMap((s) => s.parts.filter((p) => p.kind === 'delete'))
            .map((p) => resolveAnchor(ytext, p.anchor))
            .filter((r): r is NonNullable<typeof r> => r !== null && r.end > r.start)
            .sort((a, b) => a.start - b.start)
          let expected = ''
          let pos = 0
          for (const r of deleteRanges) {
            if (r.start < pos) continue
            expected += working.slice(pos, r.start)
            pos = r.end
          }
          expected += working.slice(pos)

          for (const s of seen.values()) acceptSuggestion(ytext, s)
          expect(ytext.toString()).toBe(expected)
        },
      ),
      { numRuns: 40 },
    )
  })
})
