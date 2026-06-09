// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView, type WidgetType } from '@codemirror/view'
import { glyphdownMarkdown, glyphdownHighlighting, glyphdownTheme, livePreview } from '../src/index.ts'
import { decorationsTagged, previewState } from './helpers.ts'

beforeAll(() => {
  // jsdom lacks layout APIs CodeMirror's measure cycle expects (the
  // wikilink.test.ts patches).
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

describe('horizontal rule widget (jsdom)', () => {
  it('renders a divider span and lets clicks through to the editor', () => {
    const state = previewState('a\n\n---\n\nb', 0)
    const widget = decorationsTagged(state, 'hr')[0]!.deco.spec['widget'] as WidgetType
    const dom = widget.toDOM(null as never)
    expect(dom.tagName).toBe('SPAN')
    expect(dom.className).toBe('cm-ink-hr-widget')
    expect(dom.childNodes).toHaveLength(0) // pure border styling, no text
    // ignoreEvent false → the editor handles the click and places the caret.
    expect(widget.ignoreEvent(new MouseEvent('mousedown'))).toBe(false)
  })

  it('appears in a mounted view away from the caret, swaps to raw text on caret entry', () => {
    const view = mountView('a\n\n---\n\nb', 0)
    try {
      expect(view.dom.querySelectorAll('.cm-ink-hr-widget')).toHaveLength(1)
      expect(view.dom.textContent).not.toContain('---')
      view.dispatch({ selection: EditorSelection.single(4) }) // caret onto the rule's line
      expect(view.dom.querySelectorAll('.cm-ink-hr-widget')).toHaveLength(0)
      expect(view.dom.textContent).toContain('---')
    } finally {
      view.destroy()
    }
  })
})

describe('==highlight== rendering (jsdom)', () => {
  it('away from the caret: highlighted span visible, == delimiters hidden', () => {
    const view = mountView('a ==glow== b', 0)
    try {
      const span = view.dom.querySelector('.cm-ink-highlight')
      expect(span).toBeTruthy()
      expect(span!.textContent).toBe('glow')
      expect(view.dom.textContent).not.toContain('==')
    } finally {
      view.destroy()
    }
  })

  it('caret inside: delimiters revealed, background mark stays', () => {
    const view = mountView('a ==glow== b', 6)
    try {
      expect(view.dom.textContent).toContain('==glow==')
      expect(view.dom.querySelector('.cm-ink-highlight')).toBeTruthy()
    } finally {
      view.destroy()
    }
  })
})

describe('bare-URL autolink rendering (jsdom)', () => {
  it('renders the chip with data-href for the app click handler', () => {
    const view = mountView('see https://example.com now', 0)
    try {
      const chip = view.dom.querySelector('.cm-ink-link')
      expect(chip).toBeTruthy()
      expect(chip!.getAttribute('data-href')).toBe('https://example.com')
      expect(chip!.textContent).toBe('https://example.com')
    } finally {
      view.destroy()
    }
  })
})

describe('heading line class is reveal-stable (jsdom)', () => {
  // The reveal-reflow regression gate's structural basis: the per-level type
  // scale, line-height, and rhythm margins all live on the `.cm-ink-hN` LINE
  // class, which the live-preview layer applies whether or not the caret is on
  // the heading. Only the `#` markers hide/show — so a heading's box height is
  // identical in both states (no vertical reflow on caret reveal). This test
  // pins that invariant: lose the line class on reveal and the scale/margins
  // would drop, reflowing the heading.
  it('keeps cm-ink-h2 on the line whether or not the caret is on it', () => {
    const view = mountView('intro\n\n## Section\n\nbody', 0)
    try {
      // Resting (caret on "intro"): line styled, the `## ` marker hidden.
      expect(view.dom.querySelector('.cm-ink-h2')).toBeTruthy()
      expect(view.dom.textContent).not.toContain('## Section')
      // Caret onto the heading line: marker revealed, line class unchanged.
      view.dispatch({ selection: EditorSelection.single(9) })
      expect(view.dom.querySelector('.cm-ink-h2')).toBeTruthy()
      expect(view.dom.textContent).toContain('## Section')
    } finally {
      view.destroy()
    }
  })
})

describe('%%comment%% rendering (jsdom)', () => {
  it('fades the span with the delimiters still visible', () => {
    const view = mountView('before %%aside%% after', 0)
    try {
      const span = view.dom.querySelector('.cm-ink-md-comment')
      expect(span).toBeTruthy()
      expect(span!.textContent).toBe('%%aside%%')
    } finally {
      view.destroy()
    }
  })
})
