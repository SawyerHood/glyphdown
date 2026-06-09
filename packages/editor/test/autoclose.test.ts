import { describe, expect, it } from 'vitest'
import { EditorSelection, EditorState } from '@codemirror/state'
import * as Y from 'yjs'
import { resolveAnchor, type Suggestion } from '@glyphdown/core'
import { autoCloseBackspace, autoCloseInsert, createSuggestMode, markdownAutoClose } from '../src/index.ts'

function autoCloseState(doc = '', anchor = 0, head = anchor): EditorState {
  return EditorState.create({
    doc,
    selection: EditorSelection.single(anchor, head),
    extensions: [markdownAutoClose()],
  })
}

/** Apply the pure handler; fall back to the default single-char insertion. */
function type(state: EditorState, ch: string): EditorState {
  const spec = autoCloseInsert(state, ch)
  if (spec) return state.update(spec).state
  const { from, to } = state.selection.main
  return state.update({
    changes: { from, to, insert: ch },
    selection: EditorSelection.cursor(from + ch.length),
    userEvent: 'input.type',
  }).state
}

function cursor(state: EditorState): number {
  return state.selection.main.head
}

describe('auto close: close rule', () => {
  it('pairs * at line start and places the cursor between', () => {
    const state = type(autoCloseState(), '*')
    expect(state.doc.toString()).toBe('**')
    expect(cursor(state)).toBe(1)
  })

  it('pairs guarded chars after whitespace and delimiters', () => {
    const after = type(autoCloseState('word ', 5), '~')
    expect(after.doc.toString()).toBe('word ~~')
    expect(cursor(after)).toBe(6)
    const nested = type(autoCloseState('(', 1), '"')
    expect(nested.doc.toString()).toBe('(""')
    expect(cursor(nested)).toBe(2)
  })

  it('pairs backticks anywhere, even mid-word', () => {
    const state = type(autoCloseState('word', 4), '`')
    expect(state.doc.toString()).toBe('word``')
    expect(cursor(state)).toBe(5)
  })
})

describe('auto close: boundary guard', () => {
  it('rejects _ inside snake_case', () => {
    expect(autoCloseInsert(autoCloseState('snake', 5), '_')).toBeNull()
  })

  it('rejects * between digits (2*3)', () => {
    expect(autoCloseInsert(autoCloseState('23', 1), '*')).toBeNull()
  })

  it('rejects " mid-word', () => {
    expect(autoCloseInsert(autoCloseState('it', 2), '"')).toBeNull()
  })
})

describe('auto close: skip rule', () => {
  it('skips over a tracked closer after typing inside the pair', () => {
    let state = type(autoCloseState(), '*') // *|*
    state = state.update({
      changes: { from: 1, insert: 'bold' },
      selection: EditorSelection.cursor(5),
      userEvent: 'input.type',
    }).state
    expect(state.doc.toString()).toBe('*bold*')
    state = type(state, '*')
    expect(state.doc.toString()).toBe('*bold*') // no new char
    expect(cursor(state)).toBe(6) // cursor moved over the closer
  })

  it('does NOT skip over a user-typed * (pairs instead)', () => {
    const state = type(autoCloseState('*', 0), '*')
    expect(state.doc.toString()).toBe('***') // a fresh pair, the original stays
    expect(cursor(state)).toBe(1)
  })
})

describe('auto close: doubling chain', () => {
  it('extends * to ** to *** keeping the cursor centered', () => {
    let state = type(autoCloseState(), '*')
    state = type(state, '*')
    expect(state.doc.toString()).toBe('****')
    expect(cursor(state)).toBe(2)
    state = type(state, '*')
    expect(state.doc.toString()).toBe('******')
    expect(cursor(state)).toBe(3)
  })
})

describe('auto close: brackets', () => {
  it('supports the link flow [text](|)', () => {
    let state = autoCloseState('text', 0, 4)
    state = type(state, '[') // wrap the selection
    expect(state.doc.toString()).toBe('[text]')
    expect(state.selection.main.from).toBe(1)
    expect(state.selection.main.to).toBe(5)
    state = state.update({ selection: EditorSelection.cursor(6) }).state
    state = type(state, '(')
    expect(state.doc.toString()).toBe('[text]()')
    expect(cursor(state)).toBe(7)
    state = type(state, ')') // skip the tracked closer
    expect(state.doc.toString()).toBe('[text]()')
    expect(cursor(state)).toBe(8)
  })

  it('{ pairs with no boundary guard', () => {
    const state = type(autoCloseState('word', 4), '{')
    expect(state.doc.toString()).toBe('word{}')
    expect(cursor(state)).toBe(5)
  })

  it('falls through when typing ) before a user-typed )', () => {
    expect(autoCloseInsert(autoCloseState(')', 0), ')')).toBeNull()
  })
})

describe('auto close: selection wrap', () => {
  it('wraps a selection with * keeping it selected inside', () => {
    const state = type(autoCloseState('hello', 0, 5), '*')
    expect(state.doc.toString()).toBe('*hello*')
    expect(state.selection.main.from).toBe(1)
    expect(state.selection.main.to).toBe(6)
  })

  it('wraps a selection with [', () => {
    const state = type(autoCloseState('hi there', 3, 8), '[')
    expect(state.doc.toString()).toBe('hi [there]')
    expect(state.selection.main.from).toBe(4)
    expect(state.selection.main.to).toBe(9)
  })

  it('wraps every range of a multi-range selection', () => {
    const base = EditorState.create({
      doc: 'one two',
      selection: EditorSelection.create([EditorSelection.range(0, 3), EditorSelection.range(4, 7)]),
      extensions: [markdownAutoClose(), EditorState.allowMultipleSelections.of(true)],
    })
    const state = base.update(autoCloseInsert(base, '*')!).state
    expect(state.doc.toString()).toBe('*one* *two*')
    const [a, b] = state.selection.ranges
    expect({ from: a!.from, to: a!.to }).toEqual({ from: 1, to: 4 })
    expect({ from: b!.from, to: b!.to }).toEqual({ from: 7, to: 10 })
  })
})

describe('auto close: code fence', () => {
  it('expands `` + ` into a fence with the cursor on the middle line', () => {
    const state = type(autoCloseState('``', 2), '`')
    expect(state.doc.toString()).toBe('```\n\n```')
    expect(cursor(state)).toBe(4)
    const line = state.doc.lineAt(cursor(state))
    expect(line.number).toBe(2)
    expect(state.doc.sliceString(line.from, line.to)).toBe('')
  })

  it('keeps the indent on all three fence lines', () => {
    const state = type(autoCloseState('  ``', 4), '`')
    expect(state.doc.toString()).toBe('  ```\n  \n  ```')
    expect(cursor(state)).toBe(8)
    const line = state.doc.lineAt(cursor(state))
    expect(line.number).toBe(2)
    expect(state.doc.sliceString(line.from, line.to)).toBe('  ')
  })

  it('consumes pending auto-closed backticks instead of leaving strays', () => {
    let state = type(autoCloseState(), '`') // `|`
    state = type(state, '`') // ``|`` via doubling
    expect(state.doc.toString()).toBe('````')
    state = type(state, '`')
    expect(state.doc.toString()).toBe('```\n\n```')
    expect(cursor(state)).toBe(4)
  })
})

describe('auto close: backspace', () => {
  it('deletes an empty tracked bracket pair', () => {
    const state = type(autoCloseState(), '(')
    expect(state.doc.toString()).toBe('()')
    const next = state.update(autoCloseBackspace(state)!).state
    expect(next.doc.toString()).toBe('')
    expect(cursor(next)).toBe(0)
  })

  it('deletes an empty tracked emphasis pair', () => {
    const state = type(autoCloseState(), '*')
    const next = state.update(autoCloseBackspace(state)!).state
    expect(next.doc.toString()).toBe('')
  })

  it('falls through on a user-typed pair', () => {
    expect(autoCloseBackspace(autoCloseState('()', 1))).toBeNull()
    expect(autoCloseBackspace(autoCloseState('**', 1))).toBeNull()
  })
})

describe('auto close: suggest mode interplay', () => {
  it('routes both pair characters through the session as one suggested insert', () => {
    const ydoc = new Y.Doc()
    const ytext = ydoc.getText('content')
    ytext.insert(0, 'hello ')
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
    const state = EditorState.create({
      doc: ytext.toString(),
      selection: EditorSelection.cursor(6),
      extensions: [markdownAutoClose(), mode.extension],
    })
    const spec = autoCloseInsert(state, '*')
    expect(spec).not.toBeNull()
    const tr = state.update(spec!)
    expect(tr.docChanged).toBe(false) // cancelled and routed to the session
    while (tasks.length > 0) tasks.shift()!()
    expect(ytext.toString()).toBe('hello **')
    const records = batches.at(-1)!
    expect(records).toHaveLength(1)
    const parts = records[0]!.parts
    expect(parts).toHaveLength(1)
    expect(parts[0]!.kind).toBe('insert')
    const range = resolveAnchor(ytext, parts[0]!.anchor)!
    expect(ytext.toString().slice(range.start, range.end)).toBe('**') // both chars tracked
    expect(range).toMatchObject({ start: 6, end: 8 }) // around the cursor
  })
})
