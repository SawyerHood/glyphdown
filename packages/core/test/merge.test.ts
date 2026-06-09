import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { mergePush } from '../src/index.ts'
import { docWith, joinParas, paragraphsArb } from './helpers.ts'

describe('mergePush', () => {
  it('applies a diff exactly when the doc has not drifted', () => {
    const base = '# Title\n\nHello world.\n\nThe end.'
    const ytext = docWith(base)
    const next = '# Title\n\nHello brave new world.\n\nThe end!'
    const result = mergePush(ytext, base, next)
    expect(result.ok).toBe(true)
    expect(ytext.toString()).toBe(next)
  })

  it('is a no-op when base equals new', () => {
    const base = 'unchanged'
    const ytext = docWith(base)
    const result = mergePush(ytext, base, base)
    expect(result).toEqual({ ok: true, applied: 0, failedHunks: [] })
    expect(ytext.toString()).toBe(base)
  })

  it('preserves disjoint concurrent edits (property)', () => {
    fc.assert(
      fc.property(paragraphsArb, fc.nat(), fc.nat(), (paras, a, b) => {
        fc.pre(paras.length >= 2)
        const i = a % paras.length
        let j = b % paras.length
        if (j === i) j = (j + 1) % paras.length

        const base = joinParas(paras)
        const ytext = docWith(base)

        // Concurrent CRDT edit: append a token to paragraph i.
        const paraIEnd = base.indexOf(paras[i]!) + paras[i]!.length
        ytext.insert(paraIEnd, ' CRDTEDIT')

        // File edit: append a token to paragraph j in the pulled copy.
        const newText = joinParas(paras.map((p, idx) => (idx === j ? `${p} FILEEDIT` : p)))

        const result = mergePush(ytext, base, newText)
        expect(result.ok).toBe(true)
        const merged = ytext.toString()
        expect(merged).toContain('CRDTEDIT')
        expect(merged).toContain('FILEEDIT')
        expect(merged.split('\n\n')).toHaveLength(paras.length)
      }),
      { numRuns: 50 },
    )
  })

  it('refuses a degenerate rewrite of a drifted doc', () => {
    const base = 'The quick brown fox jumps over the lazy dog. '.repeat(5)
    const ytext = docWith(base)
    ytext.insert(0, 'CONCURRENT ') // doc drifts from base
    const rewrite = 'Entirely different content with nothing in common.'
    const result = mergePush(ytext, base, rewrite)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('degenerate')
    expect(ytext.toString()).toContain('CONCURRENT') // untouched
    expect(ytext.toString()).toContain('quick brown fox')
  })

  it('applies a degenerate rewrite when forced', () => {
    const base = 'The quick brown fox jumps over the lazy dog. '.repeat(5)
    const ytext = docWith(base)
    ytext.insert(0, 'CONCURRENT ')
    const rewrite = 'Entirely different content with nothing in common.'
    const result = mergePush(ytext, base, rewrite, { force: true })
    expect(result.ok).toBe(true)
    expect(ytext.toString()).toContain('Entirely different content')
  })

  it('does not trip the guard on large pure additions to a drifted doc', () => {
    const base = 'Short doc.'
    const ytext = docWith(base)
    ytext.insert(ytext.length, ' Concurrent tail.')
    const next = `${base}\n\n${'Lots of appended content. '.repeat(50)}`
    const result = mergePush(ytext, base, next)
    expect(result.ok).toBe(true)
    expect(ytext.toString()).toContain('Concurrent tail.')
    expect(ytext.toString()).toContain('Lots of appended content.')
  })
})
