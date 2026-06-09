// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest'
import { indentLess } from '@codemirror/commands'
import { EditorSelection, EditorState, Transaction, type Extension, type StateCommand } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import * as Y from 'yjs'
import { resolveAnchor, type Suggestion } from '@glyphdown/core'
import { createSuggestMode, glyphdownMarkdown, markdownTab, markdownTabCommand } from '../src/index.ts'

beforeAll(() => {
  // jsdom lacks layout APIs CodeMirror's measure cycle expects.
  Range.prototype.getClientRects = function () {
    return { length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] } as unknown as DOMRectList
  }
  Range.prototype.getBoundingClientRect = () =>
    ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
  if (typeof globalThis.requestAnimationFrame !== 'function') {
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
      setTimeout(() => cb(Date.now()), 0)) as typeof requestAnimationFrame
  }
})

function tabState(doc: string, anchor = 0, head = anchor, extra: Extension = []): EditorState {
  return EditorState.create({
    doc,
    selection: EditorSelection.single(anchor, head),
    extensions: [glyphdownMarkdown(), markdownTab(), extra],
  })
}

/** Run a state command the way the keymap would, returning the next state. */
function press(state: EditorState, command: StateCommand = markdownTabCommand): EditorState {
  let next = state
  const handled = command({
    state,
    dispatch: (tr: Transaction) => {
      next = tr.state
    },
  })
  expect(handled).toBe(true)
  return next
}

function cursor(state: EditorState): number {
  return state.selection.main.head
}

describe('markdown tab: list item lines indent', () => {
  it('indents a bullet line by 2 spaces, then 4, and Shift-Tab undoes it', () => {
    let state = tabState('- item', 6)
    state = press(state)
    expect(state.doc.toString()).toBe('  - item')
    expect(cursor(state)).toBe(8) // cursor mapped along
    state = press(state)
    expect(state.doc.toString()).toBe('    - item')
    state = press(state, indentLess)
    expect(state.doc.toString()).toBe('  - item')
    state = press(state, indentLess)
    expect(state.doc.toString()).toBe('- item')
  })

  it('indents ordered list and task list lines', () => {
    const ordered = press(tabState('1. item', 3))
    expect(ordered.doc.toString()).toBe('  1. item')
    const task = press(tabState('- [ ] task', 10))
    expect(task.doc.toString()).toBe('  - [ ] task')
  })

  it('indents from any cursor position on the list line', () => {
    const state = press(tabState('- item', 0))
    expect(state.doc.toString()).toBe('  - item')
  })
})

describe('markdown tab: selections indent lines', () => {
  it('indents both lines of a selection spanning two lines', () => {
    const state = press(tabState('one\ntwo', 1, 5))
    expect(state.doc.toString()).toBe('  one\n  two')
  })
})

describe('markdown tab: cursor insertion on non-list lines', () => {
  it('inserts 2 spaces at a mid-line cursor in a paragraph (not at line start)', () => {
    const state = press(tabState('hello world', 5))
    expect(state.doc.toString()).toBe('hello   world')
    expect(cursor(state)).toBe(7)
  })

  it('inserts the indent unit at the cursor inside a code fence (decision: cursor insert, not line indent)', () => {
    const state = press(tabState('```\ncode\n```', 4))
    expect(state.doc.toString()).toBe('```\n  code\n```')
    expect(cursor(state)).toBe(6)
  })

  it('tags the insertion as input.type', () => {
    const state = tabState('hello', 5)
    let userEvent: string | undefined
    markdownTabCommand({
      state,
      dispatch: (tr: Transaction) => {
        userEvent = tr.annotation(Transaction.userEvent)
      },
    })
    expect(userEvent).toBe('input.type')
  })
})

describe('markdown tab: keymap wiring (jsdom)', () => {
  function keydown(view: EditorView, shiftKey = false): void {
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true }))
  }

  it('binds Tab and Shift-Tab in the view', () => {
    const view = new EditorView({
      state: tabState('- item', 6),
      parent: document.body,
    })
    keydown(view)
    expect(view.state.doc.toString()).toBe('  - item')
    keydown(view, true)
    expect(view.state.doc.toString()).toBe('- item')
    view.destroy()
  })
})

describe('markdown tab: suggest mode interplay', () => {
  function suggestSetup(text: string) {
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
    return { ytext, tasks, batches, mode }
  }

  it('routes a prose Tab insertion through the session as a tracked suggested insert', () => {
    const { ytext, tasks, batches, mode } = suggestSetup('hello ')
    const state = tabState(ytext.toString(), 6, 6, mode.extension)
    let captured: Transaction | undefined
    markdownTabCommand({
      state,
      dispatch: (tr: Transaction) => {
        captured = tr
      },
    })
    expect(captured!.docChanged).toBe(false) // cancelled and routed to the session
    while (tasks.length > 0) tasks.shift()!()
    expect(ytext.toString()).toBe('hello   ')
    const records = batches.at(-1)!
    expect(records).toHaveLength(1)
    const parts = records[0]!.parts
    expect(parts).toHaveLength(1)
    expect(parts[0]!.kind).toBe('insert')
    expect(resolveAnchor(ytext, parts[0]!.anchor)).toMatchObject({ start: 6, end: 8 }) // the two spaces
  })

  it('routes a list line indent (indentMore) through the session as a tracked suggested insert', () => {
    const { ytext, tasks, batches, mode } = suggestSetup('- item')
    const state = tabState(ytext.toString(), 6, 6, mode.extension)
    let captured: Transaction | undefined
    markdownTabCommand({
      state,
      dispatch: (tr: Transaction) => {
        captured = tr
      },
    })
    expect(captured!.docChanged).toBe(false) // cancelled and routed to the session
    while (tasks.length > 0) tasks.shift()!()
    expect(ytext.toString()).toBe('  - item')
    const records = batches.at(-1)!
    expect(records).toHaveLength(1)
    const parts = records[0]!.parts
    expect(parts[0]!.kind).toBe('insert')
    expect(resolveAnchor(ytext, parts[0]!.anchor)).toMatchObject({ start: 0, end: 2 }) // leading indent
  })
})
