// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import type { Suggestion } from '@glyphdown/core'
import { createSuggestMode, imageResolver, glyphdownCollab, glyphdownMarkdown, livePreview } from '../src/index.ts'

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

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/** A realistic pointer click: mousedown then click (where the browser toggles a checkbox). */
function clickEl(el: HTMLElement): void {
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}

function collabView(text: string) {
  const ydoc = new Y.Doc()
  const ytext = ydoc.getText('content')
  ytext.insert(0, text)
  const undoManager = new Y.UndoManager(ytext)
  const batches: Suggestion[][] = []
  let n = 0
  const mode = createSuggestMode({
    ytext,
    authorId: 'author-1',
    newId: () => `s${++n}`,
    onSuggestion: (records) => batches.push(records),
  })
  const view = new EditorView({
    state: EditorState.create({
      doc: ytext.toString(),
      extensions: [glyphdownMarkdown(), livePreview(), glyphdownCollab(ytext, null, undoManager), mode.extension],
    }),
    parent: document.body,
  })
  return { ydoc, ytext, view, mode, batches }
}

describe('EditorView integration (jsdom)', () => {
  it('routes typed input through the session and echoes it back into the view', async () => {
    const { ytext, view, batches } = collabView('hello world')
    view.dispatch({
      changes: { from: 5, to: 5, insert: ' X' },
      selection: EditorSelection.cursor(7),
      userEvent: 'input.type',
    })
    expect(view.state.doc.toString()).toBe('hello world') // cancelled
    await tick()
    expect(ytext.toString()).toBe('hello X world')
    expect(view.state.doc.toString()).toBe('hello X world') // echoed via yCollab
    expect(view.state.selection.main.head).toBe(7) // cursor after typed text
    expect(batches.at(-1)![0]!.parts[0]!.kind).toBe('insert')
    view.destroy()
  })

  it('keeps marked deletions visible and moves the cursor over them', async () => {
    const { ytext, view } = collabView('hello world')
    view.dispatch({
      changes: { from: 4, to: 5 },
      selection: EditorSelection.cursor(4),
      userEvent: 'delete.backward',
    })
    await tick()
    expect(ytext.toString()).toBe('hello world') // delete only marked
    expect(view.state.doc.toString()).toBe('hello world')
    expect(view.state.selection.main.head).toBe(4)
    view.destroy()
  })

  it('applies remote ytext edits to the view without routing them to the session', async () => {
    const { ytext, view, batches } = collabView('hello world')
    ytext.insert(0, 'R! ')
    await tick()
    expect(view.state.doc.toString()).toBe('R! hello world')
    expect(batches).toHaveLength(0)
    view.destroy()
  })

  it('renders a clickable checkbox widget that toggles the task', async () => {
    const ydoc = new Y.Doc()
    const ytext = ydoc.getText('content')
    ytext.insert(0, '- [ ] task\n\npara')
    const view = new EditorView({
      state: EditorState.create({
        doc: ytext.toString(),
        selection: EditorSelection.cursor(14),
        extensions: [glyphdownMarkdown(), livePreview()],
      }),
      parent: document.body,
    })
    const box = view.dom.querySelector<HTMLInputElement>('input.cm-ink-checkbox')
    expect(box).not.toBeNull()
    expect(box!.checked).toBe(false)
    // The input is wrapped in a sized hit-area element (>=24px tap target);
    // the wrapper is the widget root that carries the click handlers.
    const wrap = view.dom.querySelector('.cm-ink-checkbox-wrap')
    expect(wrap).not.toBeNull()
    expect(wrap!.contains(box!)).toBe(true)
    // Clicking anywhere in the wrapper toggles, even off the 13px native box.
    clickEl(wrap as HTMLElement)
    expect(view.state.doc.toString()).toBe('- [x] task\n\npara')
    view.destroy()
  })

  it('renders bullet glyphs for list markers and hides the task-line dash', () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: '- bullet\n- [ ] task\n\npara',
        selection: EditorSelection.cursor(23),
        extensions: [glyphdownMarkdown(), livePreview()],
      }),
      parent: document.body,
    })
    // Force a recompute so the field reflects the fully parsed tree.
    view.dispatch({ selection: EditorSelection.cursor(23) })
    const lines = view.dom.querySelectorAll('.cm-line')
    // Bullet line: glyph widget instead of the raw dash.
    const glyph = lines[0]!.querySelector('.cm-ink-list-bullet')
    expect(glyph).not.toBeNull()
    expect(glyph!.textContent).toBe('•')
    expect(lines[0]!.textContent).not.toContain('-')
    // Task line: no dash, no brackets — just the checkbox and the text.
    expect(lines[1]!.textContent).not.toContain('-')
    expect(lines[1]!.textContent).not.toContain('[')
    expect(lines[1]!.querySelector('input.cm-ink-checkbox')).not.toBeNull()
    // The checkbox still toggles with the marker hidden in front of it.
    clickEl(lines[1]!.querySelector('.cm-ink-checkbox-wrap') as HTMLElement)
    expect(view.state.doc.toString()).toBe('- bullet\n- [x] task\n\npara')
    // Caret on the bullet line reveals the raw marker again.
    view.dispatch({ selection: EditorSelection.cursor(2) })
    expect(view.dom.querySelector('.cm-ink-list-bullet')).toBeNull()
    expect(view.contentDOM.textContent).toContain('- bullet')
    view.destroy()
  })

  it('treats a checkbox click as inert in a read-only editor', () => {
    const ydoc = new Y.Doc()
    const ytext = ydoc.getText('content')
    ytext.insert(0, '- [ ] task\n\npara')
    const undoManager = new Y.UndoManager(ytext)
    const view = new EditorView({
      state: EditorState.create({
        doc: ytext.toString(),
        selection: EditorSelection.cursor(14),
        extensions: [
          glyphdownMarkdown(),
          livePreview(),
          glyphdownCollab(ytext, null, undoManager),
          // Viewer/commenter roles mount the editor read-only (see DocEditorPage).
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
        ],
      }),
      parent: document.body,
    })
    const box = view.dom.querySelector<HTMLInputElement>('input.cm-ink-checkbox')
    expect(box).not.toBeNull()
    clickEl(box!)
    // No local edit, no Y.Text mutation — the click does nothing.
    expect(view.state.doc.toString()).toBe('- [ ] task\n\npara')
    expect(ytext.toString()).toBe('- [ ] task\n\npara')
    expect(box!.checked).toBe(false) // native toggle suppressed: control stays inert
    view.destroy()
  })

  it('routes a checkbox click through suggest mode as a tracked suggestion', async () => {
    const { ytext, view, batches } = collabView('- [ ] task\n\npara')
    // Cursor off the task line so the checkbox widget renders.
    view.dispatch({ selection: EditorSelection.cursor(14) })
    const box = view.dom.querySelector<HTMLInputElement>('input.cm-ink-checkbox')
    expect(box).not.toBeNull()
    clickEl(box!)
    // The dispatch is cancelled by the suggest-mode transactionFilter; the
    // edit only lands once the deferred queue drains.
    expect(view.state.doc.toString()).toBe('- [ ] task\n\npara')
    await tick()
    // The toggle became a tracked suggestion (delete-mark of the space + an
    // inserted 'x') rather than a direct edit.
    expect(batches.length).toBeGreaterThan(0)
    const parts = batches.at(-1)![0]!.parts
    expect(parts.some((p) => p.kind === 'insert')).toBe(true)
    expect(ytext.toString()).toContain('x')
    view.destroy()
  })

  it('reveals image syntax with a block widget below, then restores inline on leave', () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: 'intro\n\n![alt](pic.png)\n\nafter',
        selection: EditorSelection.cursor(10),
        extensions: [glyphdownMarkdown(), livePreview(), imageResolver.of((src) => `/assets/${src}`)],
      }),
      parent: document.body,
    })
    // Force a recompute so the field reflects the fully parsed tree.
    view.dispatch({ selection: EditorSelection.cursor(10) })
    // Cursor on the line: raw syntax in the content DOM + block widget below.
    expect(view.contentDOM.textContent).toContain('![alt](pic.png)')
    const block = view.dom.querySelector('.cm-ink-image-block img')
    expect(block).not.toBeNull()
    expect(block!.getAttribute('src')).toBe('/assets/pic.png')
    expect(view.state.selection.main.head).toBe(10) // caret untouched by the widget
    // Cursor off the line: widget below disappears, inline render returns.
    view.dispatch({ selection: EditorSelection.cursor(0) })
    expect(view.dom.querySelector('.cm-ink-image-block')).toBeNull()
    expect(view.dom.querySelector('.cm-ink-image img')).not.toBeNull()
    expect(view.contentDOM.textContent).not.toContain('![alt](pic.png)')
    view.destroy()
  })

  it('renders a remote caret next to the block image widget without breaking', async () => {
    const ydoc = new Y.Doc()
    const ytext = ydoc.getText('content')
    ytext.insert(0, 'intro\n\n![alt](pic.png)\n\nafter')
    const undoManager = new Y.UndoManager(ytext)
    const awareness = new Awareness(ydoc)
    const view = new EditorView({
      state: EditorState.create({
        doc: ytext.toString(),
        selection: EditorSelection.cursor(10),
        extensions: [glyphdownMarkdown(), livePreview(), glyphdownCollab(ytext, awareness, undoManager)],
      }),
      parent: document.body,
    })
    view.dispatch({ selection: EditorSelection.cursor(10) })
    expect(view.dom.querySelector('.cm-ink-image-block')).not.toBeNull()
    // Fake a remote client whose caret sits at the image line's end (pos 22) —
    // exactly where the block widget is anchored.
    const remoteId = ydoc.clientID + 1
    awareness.states.set(remoteId, {
      user: { name: 'Remote', color: '#30bced' },
      cursor: {
        anchor: Y.createRelativePositionFromTypeIndex(ytext, 22),
        head: Y.createRelativePositionFromTypeIndex(ytext, 22),
      },
    })
    awareness.emit('change', [{ added: [remoteId], updated: [], removed: [] }, 'test'])
    await tick()
    expect(view.dom.querySelector('.cm-ySelectionCaret')).not.toBeNull()
    expect(view.dom.querySelector('.cm-ink-image-block img')).not.toBeNull()
    expect(view.contentDOM.textContent).toContain('![alt](pic.png)')
    view.destroy()
    awareness.destroy()
  })
})
