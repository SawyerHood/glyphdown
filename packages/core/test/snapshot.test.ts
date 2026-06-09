import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { createAnchor, resolveAnchor, restoreText } from '../src/index.ts'
import { docWith, joinParas, paragraphsArb, wordArb } from './helpers.ts'

describe('restoreText', () => {
  it('returns the document to the snapshot text after arbitrary edits (property)', () => {
    fc.assert(
      fc.property(
        paragraphsArb,
        fc.array(fc.tuple(fc.nat(), wordArb), { minLength: 1, maxLength: 10 }),
        (paras, edits) => {
          const snapshot = joinParas(paras)
          const ytext = docWith(snapshot)
          for (const [pos, word] of edits) {
            ytext.insert(pos % (ytext.length + 1), ` ${word} `)
          }
          restoreText(ytext, snapshot)
          expect(ytext.toString()).toBe(snapshot)
        },
      ),
      { numRuns: 50 },
    )
  })

  it('preserves anchors on regions untouched between versions', () => {
    const ytext = docWith('stable opening\n\nvolatile middle\n\nstable closing')
    const snapshot = ytext.toString()
    const start = snapshot.indexOf('stable closing')
    const anchor = createAnchor(ytext, start, start + 'stable closing'.length)

    ytext.insert(snapshot.indexOf('volatile'), 'inserted noise ')
    restoreText(ytext, snapshot)

    const range = resolveAnchor(ytext, anchor)
    expect(range).not.toBeNull()
    expect(ytext.toString().slice(range!.start, range!.end)).toBe('stable closing')
  })
})
