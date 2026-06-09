import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import type { Comment, SuggestionRecord } from '@glyphdown/protocol'
import { type DocAnnotations, docAnnotations, docAnnotationsField, setDocAnnotationsEffect } from '../src/index.ts'
import { listDecorations } from './helpers.ts'

function comment(id: string): Comment {
  return {
    id,
    anchor: null,
    authorId: 'u1',
    authorName: 'User One',
    body: 'a comment',
    createdAt: 1,
    resolved: false,
    reactions: {},
    replies: [],
  }
}

function suggestion(id: string): SuggestionRecord {
  return { id, authorId: 'u1', authorName: 'User One', createdAt: 1, status: 'open', parts: [] }
}

function stateWith(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [docAnnotations()] })
}

const payload: DocAnnotations = {
  comments: [{ comment: comment('c1'), range: { start: 0, end: 5 } }],
  suggestions: [
    {
      suggestion: suggestion('s1'),
      parts: [
        { kind: 'insert', range: { start: 6, end: 11 } },
        { kind: 'delete', range: { start: 13, end: 17 } },
      ],
    },
  ],
}

describe('docAnnotations', () => {
  it('renders comment and suggestion ranges with classes and data ids', () => {
    const state = stateWith('hello world, this is a test')
    const next = state.update({ effects: setDocAnnotationsEffect.of(payload) }).state
    const decos = listDecorations(next.field(docAnnotationsField))
    expect(decos).toHaveLength(3)

    const byClass = (cls: string) => decos.find((d) => d.deco.spec['class'] === cls)!
    const c = byClass('cm-ink-comment')
    expect(c).toMatchObject({ from: 0, to: 5 })
    expect(c.deco.spec['attributes']['data-comment-id']).toBe('c1')

    const ins = byClass('cm-ink-suggest-insert')
    expect(ins).toMatchObject({ from: 6, to: 11 })
    expect(ins.deco.spec['attributes']['data-suggestion-id']).toBe('s1')

    const del = byClass('cm-ink-suggest-delete')
    expect(del).toMatchObject({ from: 13, to: 17 })
    expect(del.deco.spec['attributes']['data-suggestion-id']).toBe('s1')
  })

  it('maps ranges through document changes between dispatches', () => {
    let state = stateWith('hello world, this is a test')
    state = state.update({ effects: setDocAnnotationsEffect.of(payload) }).state
    state = state.update({ changes: { from: 0, to: 0, insert: 'XYZ' } }).state
    const decos = listDecorations(state.field(docAnnotationsField))
    const c = decos.find((d) => d.deco.spec['class'] === 'cm-ink-comment')!
    expect(c).toMatchObject({ from: 3, to: 8 })
    const del = decos.find((d) => d.deco.spec['class'] === 'cm-ink-suggest-delete')!
    expect(del).toMatchObject({ from: 16, to: 20 })
  })

  it('payload ranges dispatched alongside changes refer to the new document', () => {
    let state = stateWith('hello world')
    state = state.update({
      changes: { from: 0, to: 0, insert: 'ab' },
      effects: setDocAnnotationsEffect.of({
        comments: [{ comment: comment('c2'), range: { start: 0, end: 5 } }],
        suggestions: [],
      }),
    }).state
    const decos = listDecorations(state.field(docAnnotationsField))
    expect(decos[0]).toMatchObject({ from: 0, to: 5 })
  })

  it('skips collapsed ranges', () => {
    const state = stateWith('hello world')
    const next = state.update({
      effects: setDocAnnotationsEffect.of({
        comments: [{ comment: comment('c3'), range: { start: 4, end: 4 } }],
        suggestions: [],
      }),
    }).state
    expect(listDecorations(next.field(docAnnotationsField))).toHaveLength(0)
  })

  it('replaces the previous set on each dispatch', () => {
    let state = stateWith('hello world, this is a test')
    state = state.update({ effects: setDocAnnotationsEffect.of(payload) }).state
    state = state.update({
      effects: setDocAnnotationsEffect.of({ comments: [], suggestions: [] }),
    }).state
    expect(listDecorations(state.field(docAnnotationsField))).toHaveLength(0)
  })
})
