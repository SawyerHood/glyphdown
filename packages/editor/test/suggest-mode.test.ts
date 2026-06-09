import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import * as Y from 'yjs'
import { resolveAnchor, type Suggestion } from '@glyphdown/core'
import { createSuggestMode } from '../src/index.ts'

function setup(text: string) {
  const ydoc = new Y.Doc()
  const ytext = ydoc.getText('content')
  ytext.insert(0, text)
  const tasks: (() => void)[] = []
  const batches: Suggestion[][] = []
  let n = 0
  const mode = createSuggestMode({
    ytext,
    authorId: 'author-1',
    newId: () => `s${++n}`,
    onSuggestion: (records) => batches.push(records),
    schedule: (fn) => tasks.push(fn),
  })
  const freshState = () => EditorState.create({ doc: ytext.toString(), extensions: [mode.extension] })
  const run = () => {
    while (tasks.length > 0) tasks.shift()!()
  }
  return { ytext, mode, freshState, run, batches }
}

function partRanges(ytext: Y.Text, s: Suggestion) {
  return s.parts.map((p) => {
    const range = resolveAnchor(ytext, p.anchor)!
    return { kind: p.kind, text: ytext.toString().slice(range.start, range.end) }
  })
}

describe('suggest mode', () => {
  it('cancels typing and lands it in ytext as a suggested insertion', () => {
    const { ytext, freshState, run, batches } = setup('hello world')
    const tr = freshState().update({ changes: { from: 5, to: 5, insert: ' brave' }, userEvent: 'input.type' })
    expect(tr.docChanged).toBe(false) // the direct edit never applies
    expect(ytext.toString()).toBe('hello world') // nothing happens until the queue drains
    run()
    expect(ytext.toString()).toBe('hello brave world')
    const records = batches.at(-1)!
    expect(records).toHaveLength(1)
    expect(partRanges(ytext, records[0]!)).toEqual([{ kind: 'insert', text: ' brave' }])
  })

  it('marks deletions of original text without removing it', () => {
    const { ytext, freshState, run, batches } = setup('hello world')
    const tr = freshState().update({ changes: { from: 4, to: 5 }, userEvent: 'delete.backward' })
    expect(tr.docChanged).toBe(false)
    run()
    expect(ytext.toString()).toBe('hello world') // physically untouched
    const records = batches.at(-1)!
    expect(partRanges(ytext, records[0]!)).toEqual([{ kind: 'delete', text: 'o' }])
  })

  it('turns a selection replace into delete-mark + insert', () => {
    const { ytext, freshState, run, batches } = setup('hello world')
    freshState().update({ changes: { from: 0, to: 5, insert: 'howdy' }, userEvent: 'input.type' })
    run()
    expect(ytext.toString()).toBe('howdyhello world')
    const records = batches.at(-1)!
    expect(records).toHaveLength(1)
    const ranges = partRanges(ytext, records[0]!)
    expect(ranges).toContainEqual({ kind: 'delete', text: 'hello' })
    expect(ranges).toContainEqual({ kind: 'insert', text: 'howdy' })
  })

  it('deletes the author\'s own pending insertion for real', () => {
    const { ytext, freshState, run, batches } = setup('hello world')
    freshState().update({ changes: { from: 5, to: 5, insert: ' brave' }, userEvent: 'input.type' })
    run()
    expect(ytext.toString()).toBe('hello brave world')
    freshState().update({ changes: { from: 5, to: 11 }, userEvent: 'delete.backward' })
    run()
    expect(ytext.toString()).toBe('hello world')
    const records = batches.at(-1)!
    expect(records[0]!.parts).toHaveLength(0) // collapsed insert part pruned
  })

  it('coalesces consecutive typing into one suggestion', () => {
    const { ytext, freshState, run, batches } = setup('hello world')
    freshState().update({ changes: { from: 5, to: 5, insert: ' brave' }, userEvent: 'input.type' })
    run()
    freshState().update({ changes: { from: 11, to: 11, insert: ' new' }, userEvent: 'input.type' })
    run()
    expect(ytext.toString()).toBe('hello brave new world')
    const ids = new Set(batches.flat().map((s) => s.id))
    expect(ids.size).toBe(1)
    const records = batches.at(-1)!
    expect(partRanges(ytext, records[0]!)).toEqual([{ kind: 'insert', text: ' brave new' }])
  })

  it('lets sync echoes / remote edits pass through untouched', () => {
    const { ytext, freshState, run } = setup('hello world')
    const state = freshState()
    ytext.insert(0, 'R') // a remote edit landed; the binding echoes it
    const tr = state.update({ changes: { from: 0, to: 0, insert: 'R' } })
    expect(tr.docChanged).toBe(true) // passed through, not routed to the session
    run()
    expect(ytext.toString()).toBe('Rhello world') // session never double-applied
  })

  it('ignores selection-only transactions', () => {
    const { freshState, run, batches } = setup('hello world')
    const tr = freshState().update({ selection: { anchor: 3 } })
    expect(tr.selection).toBeDefined()
    run()
    expect(batches).toHaveLength(0)
  })

  it('normalizes CRLF in routed insertions', () => {
    const { ytext, freshState, run } = setup('ab')
    freshState().update({ changes: { from: 1, to: 1, insert: 'x\r\ny' } })
    run()
    expect(ytext.toString()).toBe('ax\nyb')
  })

  it('flush() ends the coalescing window', () => {
    const { ytext, mode, freshState, run, batches } = setup('hello world')
    freshState().update({ changes: { from: 5, to: 5, insert: ' a' }, userEvent: 'input.type' })
    run()
    mode.flush()
    freshState().update({ changes: { from: 7, to: 7, insert: 'b' }, userEvent: 'input.type' })
    run()
    expect(ytext.toString()).toBe('hello ab world')
    const ids = new Set(batches.flat().map((s) => s.id))
    expect(ids.size).toBe(2)
  })
})
