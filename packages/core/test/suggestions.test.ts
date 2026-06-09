import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { acceptSuggestion, cleanText, materializeSuggestion, rejectSuggestion } from '../src/index.ts'
import { docWith, joinParas, paragraphsArb } from './helpers.ts'

const input = { id: 's1', authorId: 'agent-1', createdAt: 0 }

/** Build a target text by editing one paragraph: replace its tail word, add one, drop its first word. */
function editedParas(paras: string[], j: number): string[] {
  return paras.map((p, idx) => {
    if (idx !== j) return p
    const words = p.split(' ')
    words.shift() // propose deleting the first word (the "paraN:" marker)
    words[words.length - 1] = 'REPLACED'
    words.push('ADDED')
    return words.join(' ')
  })
}

describe('materializeSuggestion + accept/reject', () => {
  it('accept yields exactly the proposed text; reject restores the original (property)', () => {
    fc.assert(
      fc.property(paragraphsArb, fc.nat(), (paras, b) => {
        const j = b % paras.length
        const base = joinParas(paras)
        const target = joinParas(editedParas(paras, j))
        fc.pre(target !== base)

        // Accept path
        {
          const ytext = docWith(base)
          const s = materializeSuggestion(ytext, target, input)
          expect(s.status).toBe('open')
          // Working view contains both the suggested insertion and the not-yet-deleted text.
          expect(ytext.toString()).toContain('ADDED')
          expect(cleanText(ytext, [s])).toBe(base)
          const { suggestion: accepted, outdatedParts } = acceptSuggestion(ytext, s)
          expect(accepted.status).toBe('accepted')
          expect(outdatedParts).toHaveLength(0)
          expect(ytext.toString()).toBe(target)
        }

        // Reject path
        {
          const ytext = docWith(base)
          const s = materializeSuggestion(ytext, target, input)
          const rejected = rejectSuggestion(ytext, s)
          expect(rejected.status).toBe('rejected')
          expect(ytext.toString()).toBe(base)
        }
      }),
      { numRuns: 50 },
    )
  })

  it('survives concurrent edits elsewhere before acceptance', () => {
    const base = 'first para here\n\nsecond para there\n\nthird para everywhere'
    const ytext = docWith(base)
    const target = base.replace('second para there', 'second STUFF there')
    const s = materializeSuggestion(ytext, target, input)

    // Concurrent human edit in the third paragraph while the suggestion is open.
    ytext.insert(ytext.length, ' HUMANEDIT')

    const { suggestion: accepted } = acceptSuggestion(ytext, s)
    expect(accepted.status).toBe('accepted')
    const final = ytext.toString()
    expect(final).toContain('second STUFF there')
    expect(final).not.toContain('second para there')
    expect(final).toContain('HUMANEDIT')
  })

  it('accept and reject are idempotent and ignore non-open suggestions', () => {
    const base = 'some base text'
    const ytext = docWith(base)
    const s = materializeSuggestion(ytext, 'some better base text', input)
    const { suggestion: accepted } = acceptSuggestion(ytext, s)
    const textAfter = ytext.toString()
    expect(acceptSuggestion(ytext, accepted).suggestion).toBe(accepted)
    expect(rejectSuggestion(ytext, accepted)).toBe(accepted)
    expect(ytext.toString()).toBe(textAfter)
  })

  it('skips drifted delete parts as outdated instead of splicing changed text', () => {
    const base = 'alpha REMOVETHIS beta gamma delta'
    const ytext = docWith(base)
    const target = 'alpha beta gamma delta'
    const s = materializeSuggestion(ytext, target, input)
    // A human rewrites the marked range before the suggestion is accepted.
    const text = ytext.toString()
    const at = text.indexOf('REMOVETHIS')
    ytext.delete(at, 'REMOVETHIS'.length)
    ytext.insert(at, 'completely different words now standing here')

    const { suggestion: accepted, outdatedParts } = acceptSuggestion(ytext, s)
    expect(accepted.status).toBe('accepted')
    expect(outdatedParts.length).toBeGreaterThan(0)
    expect(ytext.toString()).toContain('completely different words now standing here')
  })

  it('handles pure deletion suggestions', () => {
    const base = 'keep this remove that keep this too'
    const ytext = docWith(base)
    const target = 'keep this keep this too'
    const s = materializeSuggestion(ytext, target, input)
    expect(ytext.toString()).toBe(base) // nothing physically removed yet
    expect(cleanText(ytext, [s])).toBe(base)
    acceptSuggestion(ytext, s)
    expect(ytext.toString()).toBe(target)
  })
})
