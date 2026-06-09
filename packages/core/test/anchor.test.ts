import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { createAnchor, resolveAnchor, validateOrReanchor } from '../src/index.ts'
import { docWith, joinParas, paragraphsArb, wordArb } from './helpers.ts'

describe('anchors under live CRDT edits', () => {
  it('tracks a range through edits before and after it', () => {
    const ytext = docWith('hello world foo bar')
    const anchor = createAnchor(ytext, 6, 11) // "world"
    ytext.insert(0, 'XYZ ')
    ytext.insert(ytext.length, ' tail')
    ytext.delete(ytext.length - 5, 5)
    const range = resolveAnchor(ytext, anchor)
    expect(range).not.toBeNull()
    expect(ytext.toString().slice(range!.start, range!.end)).toBe('world')
  })

  it('keeps anchored content intact under random outside edits (property)', () => {
    fc.assert(
      fc.property(
        paragraphsArb,
        fc.array(fc.tuple(fc.boolean(), fc.nat(), wordArb), { minLength: 1, maxLength: 10 }),
        (paras, edits) => {
          const text = joinParas(paras)
          // Anchor the second paragraph.
          const target = paras[1]!
          const start = text.indexOf(target)
          const ytext = docWith(text)
          const anchor = createAnchor(ytext, start, start + target.length)

          for (const [before, pos, word] of edits) {
            const range = resolveAnchor(ytext, anchor)
            expect(range).not.toBeNull()
            if (before) {
              ytext.insert(pos % (range!.start + 1), `${word} `)
            } else {
              const after = range!.end + (pos % (ytext.length - range!.end + 1))
              ytext.insert(after, ` ${word}`)
            }
          }

          const final = resolveAnchor(ytext, anchor)
          expect(final).not.toBeNull()
          expect(ytext.toString().slice(final!.start, final!.end)).toBe(target)
        },
      ),
      { numRuns: 50 },
    )
  })
})

describe('re-anchoring after out-of-band rewrites', () => {
  it('re-anchors by quote when the text was deleted and re-typed elsewhere', () => {
    const ytext = docWith('intro section\n\nthe unique quoted passage here\n\nclosing words')
    const text = ytext.toString()
    const start = text.indexOf('unique quoted passage')
    const anchor = createAnchor(ytext, start, start + 'unique quoted passage'.length)

    // Destroy CRDT identity: wipe the doc and retype different layout containing the quote.
    ytext.delete(0, ytext.length)
    ytext.insert(0, 'completely new intro\n\nmore content\n\nnow the unique quoted passage moved here')

    const { anchor: updated, range } = validateOrReanchor(ytext, anchor)
    expect(updated.status).toBe('anchored')
    expect(range).not.toBeNull()
    expect(ytext.toString().slice(range!.start, range!.end)).toBe('unique quoted passage')
  })

  it('re-anchors fuzzily when the quoted text changed slightly', () => {
    const ytext = docWith('alpha beta\n\nthe quick brown fox jumps over the lazy dog\n\nomega')
    const text = ytext.toString()
    const quote = 'quick brown fox jumps over the lazy'
    const start = text.indexOf(quote)
    const anchor = createAnchor(ytext, start, start + quote.length)

    ytext.delete(0, ytext.length)
    ytext.insert(0, 'different start\n\nthe quick brown foxx jumps over the lazy dog\n\ndifferent end')

    const { anchor: updated, range } = validateOrReanchor(ytext, anchor)
    expect(updated.status).toBe('anchored')
    expect(range).not.toBeNull()
    const found = ytext.toString().slice(range!.start, range!.end)
    expect(found).toContain('brown fox')
  })

  it('orphans when the quoted text is gone', () => {
    const ytext = docWith('first paragraph\n\nsecond paragraph entirely\n\nthird paragraph')
    const text = ytext.toString()
    const start = text.indexOf('second paragraph entirely')
    const anchor = createAnchor(ytext, start, start + 'second paragraph entirely'.length)

    ytext.delete(0, ytext.length)
    ytext.insert(0, 'replaced with absolutely unrelated material about cooking recipes')

    const { anchor: updated, range } = validateOrReanchor(ytext, anchor)
    expect(updated.status).toBe('orphaned')
    expect(range).toBeNull()
  })
})
