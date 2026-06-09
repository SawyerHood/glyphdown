// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { CompletionContext, acceptCompletion, completionStatus, currentCompletions } from '@codemirror/autocomplete'
import * as Y from 'yjs'
import { resolveAnchor, type Suggestion } from '@glyphdown/core'
import {
  applyWikiLinkCompletion,
  autoCloseInsert,
  createSuggestMode,
  findWikiLinks,
  glyphdownMarkdown,
  livePreview,
  markdownAutoClose,
  normalizeWikiTitle,
  resolveWikiTitle,
  wikiClosersToConsume,
  wikiLinkCompletionSource,
  wikiLinkContext,
  wikiLinkField,
  wikiLinks,
  type WikiLinkContext,
} from '../src/index.ts'
import { decorationsWithClass, listDecorations, type DecoEntry } from './helpers.ts'

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

const DOCS = [
  { docId: 'd1', title: 'Project Plan' },
  { docId: 'd2', title: 'Roadmap' },
]

const opened: string[] = []
const testCtx: WikiLinkContext = {
  resolve: (title) => resolveWikiTitle(DOCS, title),
  list: () => DOCS,
  open: (docId) => opened.push(docId),
}

function wikiState(doc: string, anchor = 0, head = anchor, ctx: WikiLinkContext = testCtx): EditorState {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.single(anchor, head),
    extensions: [glyphdownMarkdown(), livePreview(), wikiLinkField, wikiLinkContext.of(ctx)],
  })
  // Force one recompute so the field reflects the fully parsed tree.
  return state.update({ selection: EditorSelection.single(anchor, head) }).state
}

function wikiDecorations(state: EditorState): DecoEntry[] {
  return listDecorations(state.field(wikiLinkField))
}

function wikiHidden(state: EditorState): { from: number; to: number }[] {
  return wikiDecorations(state)
    .filter((d) => d.deco.spec['glyphdown'] === 'hide')
    .map(({ from, to }) => ({ from, to }))
}

function wikiChips(state: EditorState): DecoEntry[] {
  return wikiDecorations(state).filter((d) => d.deco.spec['glyphdown'] === 'wikilink')
}

describe('wiki links: parsing', () => {
  it('finds [[Target]] with positions', () => {
    const links = findWikiLinks('see [[Project Plan]] end')
    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({
      from: 4,
      to: 20,
      target: 'Project Plan',
      alias: null,
      labelFrom: 6,
      labelTo: 18,
    })
  })

  it('finds [[Target|alias]] with the alias as the label', () => {
    const links = findWikiLinks('[[Project Plan|the plan]]')
    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({ target: 'Project Plan', alias: 'the plan', labelFrom: 15, labelTo: 23 })
  })

  it('falls back to the target when the alias is blank', () => {
    const links = findWikiLinks('[[T|]]')
    expect(links[0]).toMatchObject({ target: 'T', alias: null, labelFrom: 2, labelTo: 3 })
  })

  it('ignores blank targets, unclosed brackets, and newline-spanning matches', () => {
    expect(findWikiLinks('[[ ]] and [[x] and [[a\nb]]')).toHaveLength(0)
  })

  it('finds multiple links in one document', () => {
    const links = findWikiLinks('[[A]] then [[B|b]]')
    expect(links.map((l) => l.target)).toEqual(['A', 'B'])
  })
})

describe('wiki links: resolver normalization', () => {
  it('matches case-insensitively with collapsed whitespace', () => {
    expect(resolveWikiTitle(DOCS, 'project plan')).toEqual({ docId: 'd1' })
    expect(resolveWikiTitle(DOCS, '  PROJECT   PLAN  ')).toEqual({ docId: 'd1' })
    expect(resolveWikiTitle(DOCS, 'roadMAP')).toEqual({ docId: 'd2' })
  })

  it('returns null for unknown or blank titles', () => {
    expect(resolveWikiTitle(DOCS, 'nope')).toBeNull()
    expect(resolveWikiTitle(DOCS, '   ')).toBeNull()
  })

  it('normalizes titles for keying', () => {
    expect(normalizeWikiTitle('  Foo \t Bar ')).toBe('foo bar')
  })
})

describe('wiki links: rendering', () => {
  it('renders a resolved chip: brackets hidden, label marked, docId attached', () => {
    const state = wikiState('see [[Project Plan]] end', 0)
    expect(wikiHidden(state)).toEqual([
      { from: 4, to: 6 },
      { from: 18, to: 20 },
    ])
    const chips = wikiChips(state)
    expect(chips).toHaveLength(1)
    expect(chips[0]).toMatchObject({ from: 6, to: 18 })
    expect(chips[0]!.deco.spec['class']).toBe('cm-ink-wikilink')
    expect(chips[0]!.deco.spec['attributes']['data-doc-id']).toBe('d1')
    expect(chips[0]!.deco.spec['attributes']['data-wikilink']).toBe('Project Plan')
  })

  it('resolves the written target case-insensitively', () => {
    const state = wikiState('[[project   plan]]', 0)
    // Selection at 0 touches the link start, so park the cursor at the end.
    const moved = state.update({ selection: EditorSelection.cursor(state.doc.length) }).state
    expect(wikiChips(moved)).toHaveLength(0) // cursor at doc end still touches `]]`
    const farState = wikiState('x [[project   plan]] y', 0)
    expect(wikiChips(farState)[0]!.deco.spec['attributes']['data-doc-id']).toBe('d1')
  })

  it('styles unresolved targets with the unresolved class', () => {
    const state = wikiState('a [[Missing Doc]] b', 0)
    const chips = wikiChips(state)
    expect(chips).toHaveLength(1)
    expect(chips[0]!.deco.spec['class']).toBe('cm-ink-wikilink cm-ink-wikilink-unresolved')
    expect(chips[0]!.deco.spec['attributes']['data-doc-id']).toBeUndefined()
  })

  it('shows the alias and hides the target when present', () => {
    const state = wikiState('a [[Project Plan|the plan]] b', 0)
    // hide `[[Project Plan|` and `]]`, mark `the plan`
    expect(wikiHidden(state)).toEqual([
      { from: 2, to: 17 },
      { from: 25, to: 27 },
    ])
    const chips = wikiChips(state)
    expect(chips[0]).toMatchObject({ from: 17, to: 25 })
    expect(chips[0]!.deco.spec['attributes']['data-wikilink']).toBe('Project Plan')
  })

  it('reveals raw syntax when the cursor enters the link', () => {
    const state = wikiState('a [[Project Plan]] b', 8)
    expect(wikiDecorations(state)).toHaveLength(0)
  })

  it('reveals raw syntax when a selection overlaps the link', () => {
    const state = wikiState('a [[Project Plan]] b', 1, 5)
    expect(wikiDecorations(state)).toHaveLength(0)
  })

  it('ignores [[...]] inside inline code', () => {
    const state = wikiState('x `[[Project Plan]]` y', 0)
    expect(wikiDecorations(state)).toHaveLength(0)
  })

  it('suppresses the live-preview link chip inside a wiki link, keeping it for real links', () => {
    const state = wikiState('a [[Project Plan]] b [x](https://x.dev) c', 0)
    const linkChips = decorationsWithClass(state, 'cm-ink-link')
    expect(linkChips).toHaveLength(1) // only the [x](…) link
    expect(linkChips[0]!.deco.spec['attributes']['data-href']).toBe('https://x.dev')
  })
})

describe('wiki links: completion source', () => {
  function complete(doc: string, pos: number, ctx: WikiLinkContext = testCtx) {
    const state = EditorState.create({
      doc,
      selection: EditorSelection.cursor(pos),
      extensions: [wikiLinkContext.of(ctx)],
    })
    return wikiLinkCompletionSource(new CompletionContext(state, pos, false))
  }

  it('activates right after [[ with all titles', () => {
    const result = complete('see [[', 6)
    expect(result).not.toBeNull()
    expect(result!.from).toBe(6)
    expect(result!.options.map((o) => o.label)).toEqual(['Project Plan', 'Roadmap'])
  })

  it('activates mid-document with a partial query, completing from after [[', () => {
    const result = complete('a [[pro b', 6)
    expect(result).not.toBeNull()
    expect(result!.from).toBe(4)
  })

  it('does not activate without [[ before the cursor', () => {
    expect(complete('see [pro', 8)).toBeNull()
    expect(complete('plain text', 5)).toBeNull()
  })

  it('does not activate once an alias pipe is typed', () => {
    expect(complete('[[Project Plan|ali', 18)).toBeNull()
  })

  it('does not activate with an empty docs list', () => {
    expect(complete('[[', 2, { resolve: () => null, list: () => [], open: () => {} })).toBeNull()
  })
})

describe('wiki links: completion apply + auto-closed brackets', () => {
  function editor(doc = '', cursor = 0): EditorView {
    return new EditorView({
      state: EditorState.create({
        doc,
        selection: EditorSelection.cursor(cursor),
        extensions: [markdownAutoClose(), glyphdownMarkdown(), wikiLinks(), wikiLinkContext.of(testCtx)],
      }),
      parent: document.body,
    })
  }

  /** Type a char through the autoclose handler (falling back to plain insert). */
  function type(view: EditorView, ch: string): void {
    const spec = autoCloseInsert(view.state, ch)
    if (spec) {
      view.dispatch(spec)
      return
    }
    const { from, to } = view.state.selection.main
    view.dispatch({
      changes: { from, to, insert: ch },
      selection: EditorSelection.cursor(from + ch.length),
      userEvent: 'input.type',
    })
  }

  it('consumes both auto-closed brackets from typing [[', () => {
    const view = editor()
    type(view, '[')
    type(view, '[')
    expect(view.state.doc.toString()).toBe('[[]]')
    expect(view.state.selection.main.head).toBe(2)
    for (const ch of 'pro') type(view, ch)
    expect(view.state.doc.toString()).toBe('[[pro]]')
    expect(wikiClosersToConsume(view.state, 5)).toBe(2)
    applyWikiLinkCompletion(view, 'Project Plan', 2, 5)
    expect(view.state.doc.toString()).toBe('[[Project Plan]]')
    expect(view.state.selection.main.head).toBe(16)
    view.destroy()
  })

  it('consumes a single tracked closer', () => {
    const view = editor('[', 1)
    type(view, '[') // pairs: "[[]" with a tracked ] at 2
    expect(view.state.doc.toString()).toBe('[[]')
    expect(wikiClosersToConsume(view.state, 2)).toBe(1)
    applyWikiLinkCompletion(view, 'Roadmap', 2, 2)
    expect(view.state.doc.toString()).toBe('[[Roadmap]]')
    view.destroy()
  })

  it('reuses the untracked ]] of an existing link when re-completing', () => {
    const view = editor('[[pr]]', 4)
    expect(wikiClosersToConsume(view.state, 4)).toBe(2)
    applyWikiLinkCompletion(view, 'Project Plan', 2, 4)
    expect(view.state.doc.toString()).toBe('[[Project Plan]]')
    view.destroy()
  })

  it('does not consume a single stray user-typed ]', () => {
    const view = editor('[[pr]x', 4)
    expect(wikiClosersToConsume(view.state, 4)).toBe(0)
    view.destroy()
  })

  it('triggers via typing and accepts through acceptCompletion (the Enter path)', async () => {
    const view = editor()
    type(view, '[')
    type(view, '[')
    for (const ch of 'road') type(view, ch)
    expect(view.state.doc.toString()).toBe('[[road]]')
    // activateOnTyping debounces; poll until the panel is active.
    const deadline = Date.now() + 2000
    while (completionStatus(view.state) !== 'active' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25))
    }
    expect(completionStatus(view.state)).toBe('active')
    expect(currentCompletions(view.state).map((c) => c.label)).toContain('Roadmap')
    // acceptCompletion (the Enter binding) refuses within interactionDelay
    // (75 ms) of the panel opening — wait it out.
    await new Promise((r) => setTimeout(r, 100))
    expect(acceptCompletion(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('[[Roadmap]]')
    expect(view.state.selection.main.head).toBe(11)
    view.destroy()
  })
})

describe('wiki links: suggest mode interplay', () => {
  it('routes the completion through the SuggestSession as a captured insert', () => {
    const ydoc = new Y.Doc()
    const ytext = ydoc.getText('content')
    ytext.insert(0, 'hello [[pr]]')
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
    let state = EditorState.create({
      doc: ytext.toString(),
      selection: EditorSelection.cursor(10),
      extensions: [markdownAutoClose(), wikiLinkField, wikiLinkContext.of(testCtx), mode.extension],
    })
    let lastDocChanged: boolean | null = null
    const fakeView = {
      get state() {
        return state
      },
      dispatch(spec: Parameters<EditorState['update']>[0]) {
        const tr = state.update(spec)
        lastDocChanged = tr.docChanged
        state = tr.state
      },
    } as unknown as EditorView

    applyWikiLinkCompletion(fakeView, 'Project Plan', 8, 10)
    expect(lastDocChanged).toBe(false) // cancelled and routed to the session
    expect(state.doc.toString()).toBe('hello [[pr]]')
    while (tasks.length > 0) tasks.shift()!()

    // The session marked the replaced text and inserted the completed link.
    expect(ytext.toString()).toContain('Project Plan]]')
    const records = batches.at(-1)!
    expect(records).toHaveLength(1)
    const parts = records[0]!.parts
    const insertPart = parts.find((p) => p.kind === 'insert')
    expect(insertPart).toBeDefined()
    const range = resolveAnchor(ytext, insertPart!.anchor)!
    expect(ytext.toString().slice(range.start, range.end)).toBe('Project Plan]]')
    const deletePart = parts.find((p) => p.kind === 'delete')
    expect(deletePart).toBeDefined()
    const delRange = resolveAnchor(ytext, deletePart!.anchor)!
    expect(ytext.toString().slice(delRange.start, delRange.end)).toBe('pr]]')
  })
})
