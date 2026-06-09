import { describe, expect, it } from 'vitest'
import { commentField, findComments } from '../src/index.ts'
import { listDecorations, previewState, type DecoEntry } from './helpers.ts'
import type { EditorState } from '@codemirror/state'

function commentDecorations(state: EditorState): DecoEntry[] {
  return listDecorations(state.field(commentField)).filter((d) => d.deco.spec['glyphdown'] === 'comment')
}

describe('%%comment%% parsing', () => {
  it('finds a single-line comment span, delimiters included', () => {
    expect(findComments('a %%hidden note%% b')).toEqual([{ from: 2, to: 17, text: 'hidden note' }])
  })

  it('finds multiple comments and allows lone % inside', () => {
    expect(findComments('%%a%% mid %%50% off%%')).toEqual([
      { from: 0, to: 5, text: 'a' },
      { from: 10, to: 21, text: '50% off' },
    ])
  })

  it('matches the empty comment %%%%', () => {
    expect(findComments('x %%%% y')).toEqual([{ from: 2, to: 6, text: '' }])
  })

  it('does not span lines (multi-line %% blocks are a known v1 gap)', () => {
    expect(findComments('%%open\nclose%%')).toEqual([])
  })

  it('ignores an unclosed %%', () => {
    expect(findComments('a %%dangling')).toEqual([])
  })
})

describe('%%comment%% decorations (via livePreview)', () => {
  it('fades the whole span — mark over delimiters and content, nothing hidden', () => {
    const state = previewState('before %%aside%% after', 0)
    const marks = commentDecorations(state)
    expect(marks).toHaveLength(1)
    expect(marks[0]).toMatchObject({ from: 7, to: 16 })
    expect((marks[0]!.deco.spec['class'] as string).split(' ')).toContain('cm-ink-md-comment')
    // No replace decorations: the %% delimiters stay visible, just faded.
    const hides = listDecorations(state.field(commentField)).filter((d) => d.deco.spec['glyphdown'] === 'hide')
    expect(hides).toHaveLength(0)
  })

  it('keeps the fade when the caret is inside (no reveal needed — nothing hidden)', () => {
    const state = previewState('before %%aside%% after', 10)
    expect(commentDecorations(state)).toHaveLength(1)
  })

  it('skips %% inside inline code', () => {
    const state = previewState('a `%%not a comment%%` b', 0)
    expect(commentDecorations(state)).toHaveLength(0)
  })

  it('skips %% inside fenced code blocks', () => {
    const state = previewState('```\n%%still code%%\n```\n\npara', 26)
    expect(commentDecorations(state)).toHaveLength(0)
  })

  it('skips %% inside frontmatter', () => {
    const doc = '---\ntitle: "%%x%%"\n---\n\nbody %%real%%'
    const state = previewState(doc, 0)
    const marks = commentDecorations(state)
    expect(marks).toHaveLength(1)
    expect(doc.slice(marks[0]!.from, marks[0]!.to)).toBe('%%real%%')
  })
})
