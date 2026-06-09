// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import {
  glyphdownCollab,
  glyphdownMarkdown,
  katexIfLoaded,
  livePreview,
  loadKatex,
  renderMathInto,
} from '../src/index.ts'

beforeAll(() => {
  // jsdom lacks layout APIs CodeMirror's measure cycle expects (the
  // view.test.ts patches).
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

function mountView(doc: string, anchor = 0): EditorView {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.single(anchor),
      extensions: [glyphdownMarkdown(), livePreview()],
    }),
    parent,
  })
  // Force a recompute so the fields reflect the fully parsed tree.
  view.dispatch({ selection: EditorSelection.single(anchor) })
  return view
}

// NOTE: test order matters in this file — KaTeX loads lazily into module
// state, so the placeholder-transition test must run before anything else
// triggers the load.
describe('lazy loading', () => {
  it('renders a dimmed raw-source placeholder, then swaps to KaTeX in place', async () => {
    expect(katexIfLoaded()).toBeNull()
    const view = mountView('a $x^2$ b', 0)
    try {
      // Before the chunk arrives: raw delimited source, dimmed.
      const placeholder = view.dom.querySelector('.cm-ink-math')
      expect(placeholder).not.toBeNull()
      expect(placeholder!.classList.contains('cm-ink-math-loading')).toBe(true)
      expect(placeholder!.textContent).toBe('$x^2$')
      expect(view.dom.querySelector('.katex')).toBeNull()
      // The widget kicked off the load; once it lands the same element
      // re-renders in place.
      await loadKatex()
      await tick()
      const rendered = view.dom.querySelector('.cm-ink-math')!
      expect(rendered.classList.contains('cm-ink-math-loading')).toBe(false)
      expect(rendered.querySelector('.katex')).not.toBeNull()
      expect(katexIfLoaded()).not.toBeNull()
    } finally {
      view.destroy()
    }
  })

  it('renders synchronously once KaTeX is loaded', () => {
    const view = mountView('say $\\frac{1}{2}$ now', 0)
    try {
      const el = view.dom.querySelector('.cm-ink-math')!
      expect(el.classList.contains('cm-ink-math-loading')).toBe(false)
      expect(el.querySelector('.katex')).not.toBeNull()
    } finally {
      view.destroy()
    }
  })
})

describe('inline math rendering (jsdom)', () => {
  it('away from the caret: KaTeX span, raw $ syntax hidden', () => {
    const view = mountView('a $x^2$ b', 0)
    try {
      expect(view.dom.querySelector('.cm-ink-math .katex')).not.toBeNull()
      expect(view.contentDOM.textContent).not.toContain('$')
    } finally {
      view.destroy()
    }
  })

  it('caret reveal round-trip: raw tinted source inside, widget again outside', () => {
    const view = mountView('a $x^2$ b', 4)
    try {
      // Caret inside: raw source visible with the subtle src styling.
      expect(view.contentDOM.textContent).toContain('$x^2$')
      expect(view.dom.querySelector('.cm-ink-math-src')).not.toBeNull()
      expect(view.dom.querySelector('.cm-ink-math')).toBeNull()
      // Caret leaves: widget returns, raw syntax hidden.
      view.dispatch({ selection: EditorSelection.single(0) })
      expect(view.contentDOM.textContent).not.toContain('$x^2$')
      expect(view.dom.querySelector('.cm-ink-math .katex')).not.toBeNull()
      // And back in: raw source again.
      view.dispatch({ selection: EditorSelection.single(5) })
      expect(view.contentDOM.textContent).toContain('$x^2$')
    } finally {
      view.destroy()
    }
  })

  it('output is HTML-only (no duplicated MathML tree)', () => {
    const view = mountView('a $x^2$ b', 0)
    try {
      expect(view.dom.querySelector('.cm-ink-math .katex-html')).not.toBeNull()
      expect(view.dom.querySelector('.cm-ink-math .katex-mathml')).toBeNull()
    } finally {
      view.destroy()
    }
  })
})

describe('block math rendering (jsdom)', () => {
  it('renders a centered display block away from the caret and reveals on entry', () => {
    const doc = 'intro\n\n$$\n\\int_0^1 x\\,dx\n$$\n\nafter'
    const view = mountView(doc, 0)
    try {
      const block = view.dom.querySelector('.cm-ink-math-block')
      expect(block).not.toBeNull()
      expect(block!.tagName).toBe('DIV')
      expect(block!.querySelector('.katex-display')).not.toBeNull()
      expect(view.contentDOM.textContent).not.toContain('$$')
      // Caret onto a math line: widget gone, raw $$ source back.
      view.dispatch({ selection: EditorSelection.single(12) })
      expect(view.dom.querySelector('.cm-ink-math-block')).toBeNull()
      expect(view.contentDOM.textContent).toContain('$$')
      expect(view.contentDOM.textContent).toContain('\\int_0^1 x\\,dx')
    } finally {
      view.destroy()
    }
  })
})

describe('error handling', () => {
  it('an undefined command renders as soft-red text instead of throwing', () => {
    const view = mountView('bad $\\notarealcommand{x}$ math', 0)
    try {
      const el = view.dom.querySelector('.cm-ink-math')!
      expect(el.querySelector('[style*="#b3554d"]')).not.toBeNull()
      expect(el.textContent).toContain('\\notarealcommand')
    } finally {
      view.destroy()
    }
  })

  it('unparseable TeX renders a katex-error span with the raw source', () => {
    const view = mountView('bad $\\frac{1}{$ math', 0)
    try {
      const el = view.dom.querySelector('.cm-ink-math')!
      const err = el.querySelector('.katex-error')
      expect(err).not.toBeNull()
      expect(err!.textContent).toBe('\\frac{1}{')
    } finally {
      view.destroy()
    }
  })

  it('a KaTeX throw falls back to raw delimited source with the error tint', () => {
    const throwing = {
      renderToString: () => {
        throw new Error('katex exploded')
      },
    } as unknown as Parameters<typeof renderMathInto>[0]
    const el = document.createElement('span')
    renderMathInto(throwing, el, 'x^2', false)
    expect(el.classList.contains('cm-ink-math-error')).toBe(true)
    expect(el.textContent).toBe('$x^2$')
    expect(el.title).toContain('katex exploded')
    // Display variant keeps the $$ delimiters.
    const blockEl = document.createElement('div')
    renderMathInto(throwing, blockEl, 'y', true)
    expect(blockEl.textContent).toBe('$$y$$')
  })

  it('recovers when the TeX is corrected', () => {
    const real = katexIfLoaded()!
    const el = document.createElement('span')
    el.classList.add('cm-ink-math-error') // pretend a previous render failed
    renderMathInto(real, el, 'x^2', false)
    expect(el.classList.contains('cm-ink-math-error')).toBe(false)
    expect(el.querySelector('.katex')).not.toBeNull()
  })
})

describe('collab safety (jsdom)', () => {
  it('renders a remote caret adjacent to a math widget without breaking', async () => {
    const ydoc = new Y.Doc()
    const ytext = ydoc.getText('content')
    ytext.insert(0, 'intro\n\n$$\nE = mc^2\n$$\n\nafter')
    const undoManager = new Y.UndoManager(ytext)
    const awareness = new Awareness(ydoc)
    const view = new EditorView({
      state: EditorState.create({
        doc: ytext.toString(),
        selection: EditorSelection.single(0),
        extensions: [glyphdownMarkdown(), livePreview(), glyphdownCollab(ytext, awareness, undoManager)],
      }),
      parent: document.body,
    })
    view.dispatch({ selection: EditorSelection.single(0) })
    expect(view.dom.querySelector('.cm-ink-math-block')).not.toBeNull()
    // Fake a remote client whose caret sits right at the block widget's
    // start boundary (pos 7 = the `$$` line start).
    const remoteId = ydoc.clientID + 1
    awareness.states.set(remoteId, {
      user: { name: 'Remote', color: '#30bced' },
      cursor: {
        anchor: Y.createRelativePositionFromTypeIndex(ytext, 7),
        head: Y.createRelativePositionFromTypeIndex(ytext, 7),
      },
    })
    awareness.emit('change', [{ added: [remoteId], updated: [], removed: [] }, 'test'])
    await tick()
    // The local view keeps its widget (remote carets never force a reveal),
    // and the editor did not crash drawing the remote selection layer.
    expect(view.dom.querySelector('.cm-ink-math-block .katex')).not.toBeNull()
    // Remote edits inside the hidden math source update the widget.
    ytext.insert(14, 'm')
    await tick()
    expect(view.state.doc.toString()).toContain('E = mmc^2')
    view.destroy()
    awareness.destroy()
  })
})
