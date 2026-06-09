// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import {
  findFootnoteDefinition,
  glyphdownHighlighting,
  glyphdownMarkdown,
  glyphdownTheme,
  livePreview,
} from '../src/index.ts'
import { decorationsTagged, decorationsWithClass, hiddenRanges, previewState } from './helpers.ts'

beforeAll(() => {
  // jsdom lacks layout APIs CodeMirror's measure cycle expects (the
  // render-dom.test.ts patches).
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

function mountView(doc: string, anchor = 0): EditorView {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  return new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.single(anchor),
      extensions: [glyphdownMarkdown(), glyphdownHighlighting(), glyphdownTheme, livePreview()],
    }),
    parent,
  })
}

const DOC = 'text [^1] here\n\n[^1]: the note'

describe('footnote refs', () => {
  it('replaces [^1] with a superscript chip away from the selection', () => {
    const state = previewState(DOC, 0)
    const chips = decorationsTagged(state, 'footnote-ref')
    expect(chips).toHaveLength(1)
    expect(chips[0]).toMatchObject({ from: 5, to: 9 })
    const widget = chips[0]!.deco.spec['widget'] as { label: string }
    expect(widget.label).toBe('1')
  })

  it('reveals the raw syntax when the selection touches the ref', () => {
    const state = previewState(DOC, 6)
    expect(decorationsTagged(state, 'footnote-ref')).toHaveLength(0)
  })

  it('supports word labels', () => {
    const doc = 'claim [^source] end\n\n[^source]: cited'
    const state = previewState(doc, 0)
    const chips = decorationsTagged(state, 'footnote-ref')
    expect(chips).toHaveLength(1)
    expect((chips[0]!.deco.spec['widget'] as { label: string }).label).toBe('source')
  })

  it('never renders a ref as a link chip', () => {
    const state = previewState(DOC, 0)
    expect(decorationsWithClass(state, 'cm-ink-link')).toHaveLength(0)
  })

  it('leaves a mid-line `[^1]:` (not a ref, not a definition) as plain text', () => {
    const doc = 'see [^1]: inline colon\n\npara'
    const state = previewState(doc, doc.length)
    expect(decorationsTagged(state, 'footnote-ref')).toHaveLength(0)
    expect(hiddenRanges(state)).toHaveLength(0)
  })
})

describe('footnote definitions', () => {
  it('mutes the definition line and accents the [^1]: label', () => {
    const state = previewState(DOC, 0)
    const lines = decorationsWithClass(state, 'cm-ink-footnote-def')
    expect(lines).toHaveLength(1)
    expect(lines[0]!.from).toBe(16)
    const labels = decorationsWithClass(state, 'cm-ink-footnote-def-label')
    expect(labels).toHaveLength(1)
    expect(labels[0]).toMatchObject({ from: 16, to: 21 }) // `[^1]:`
  })

  it('keeps the definition syntax visible even away from the caret', () => {
    const state = previewState(DOC, 0)
    expect(hiddenRanges(state).filter((r) => r.from >= 16)).toHaveLength(0)
  })

  it('covers indented continuation lines', () => {
    const doc = 'ref [^a]\n\n[^a]: first line\n    second line\n\npara'
    const state = previewState(doc, doc.length)
    const lines = decorationsWithClass(state, 'cm-ink-footnote-def')
    expect(lines).toHaveLength(2)
  })

  it('renders inline formatting inside the definition body', () => {
    const doc = 'x [^b]\n\n[^b]: has **bold** inside'
    const state = previewState(doc, 0)
    const boldStart = doc.indexOf('**')
    expect(hiddenRanges(state)).toContainEqual({ from: boldStart, to: boldStart + 2 })
  })
})

describe('findFootnoteDefinition', () => {
  it('finds the definition position for a label', () => {
    const state = previewState(DOC, 0)
    expect(findFootnoteDefinition(state, '1')).toBe(16)
  })

  it('returns null when no definition exists', () => {
    const state = previewState('only a ref [^ghost]\n\npara', 0)
    expect(findFootnoteDefinition(state, 'ghost')).toBeNull()
  })

  it('distinguishes labels', () => {
    const doc = '[^a] and [^b]\n\n[^a]: first\n\n[^b]: second'
    const state = previewState(doc, 0)
    expect(findFootnoteDefinition(state, 'a')).toBe(doc.indexOf('[^a]:'))
    expect(findFootnoteDefinition(state, 'b')).toBe(doc.indexOf('[^b]:'))
  })

  it('escapes regex metacharacters in labels (text-search fallback)', () => {
    const doc = 'ref [^a.b] x\n\n[^a.b]: dotted'
    const state = previewState(doc, 0)
    expect(findFootnoteDefinition(state, 'a.b')).toBe(doc.indexOf('[^a.b]:'))
    expect(findFootnoteDefinition(state, 'aXb')).toBeNull()
  })
})

describe('footnote chip click (jsdom)', () => {
  it('renders the chip as <sup> with the label text', () => {
    const view = mountView(DOC, 0)
    try {
      const chip = view.dom.querySelector('sup.cm-ink-footnote-ref')
      expect(chip).toBeTruthy()
      expect(chip!.textContent).toBe('1')
      expect(view.dom.textContent).not.toContain('text [^1] here')
    } finally {
      view.destroy()
    }
  })

  it('click scrolls to and places the caret at the definition', () => {
    const view = mountView(DOC, 0)
    try {
      const chip = view.dom.querySelector('sup.cm-ink-footnote-ref')!
      chip.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      expect(view.state.selection.main.head).toBe(16) // start of `[^1]: the note`
    } finally {
      view.destroy()
    }
  })

  it('click on a ref without a definition places the caret on the ref itself', () => {
    const view = mountView('lonely [^nope] ref\n\npara', 0)
    try {
      const chip = view.dom.querySelector('sup.cm-ink-footnote-ref')!
      chip.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      // Caret lands on the ref (7) — which also reveals the raw syntax.
      expect(view.state.selection.main.head).toBe(7)
      expect(view.dom.querySelectorAll('sup.cm-ink-footnote-ref')).toHaveLength(0)
      expect(view.dom.textContent).toContain('[^nope]')
    } finally {
      view.destroy()
    }
  })

  it('caret entry via dispatch reveals the ref and leaving re-chips it', () => {
    const view = mountView(DOC, 0)
    try {
      view.dispatch({ selection: EditorSelection.single(6) })
      expect(view.dom.querySelectorAll('sup.cm-ink-footnote-ref')).toHaveLength(0)
      expect(view.dom.textContent).toContain('[^1]')
      view.dispatch({ selection: EditorSelection.single(0) })
      expect(view.dom.querySelectorAll('sup.cm-ink-footnote-ref')).toHaveLength(1)
    } finally {
      view.destroy()
    }
  })
})
