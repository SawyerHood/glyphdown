// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest'
import { Compartment, EditorSelection, EditorState, type Extension } from '@codemirror/state'
import { Decoration, EditorView } from '@codemirror/view'
import {
  glyphdownMarkdown,
  glyphdownHighlighting,
  glyphdownTheme,
  listHangPrefixes,
  listHangingIndent,
  livePreview,
  renderedHangWidth,
} from '../src/index.ts'
import { previewState } from './helpers.ts'

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

/** All prefixes for the whole doc, keyed by line NUMBER for readable asserts. */
function prefixesByLine(doc: string): Map<number, string> {
  const state = previewState(doc, 0)
  const out = new Map<number, string>()
  for (const [pos, prefix] of listHangPrefixes(state, 0, state.doc.length)) {
    out.set(state.doc.lineAt(pos).number, prefix)
  }
  return out
}

describe('hanging indent: prefix extraction (source text)', () => {
  it('bullet items: marker + trailing space', () => {
    expect(prefixesByLine('- alpha beta')).toEqual(new Map([[1, '- ']]))
    expect(prefixesByLine('* starred')).toEqual(new Map([[1, '* ']]))
    expect(prefixesByLine('+ plussed')).toEqual(new Map([[1, '+ ']]))
  })

  it('ordered items: variable-width markers, both delimiters', () => {
    const p = prefixesByLine('1. one\n12. twelve\n123. wide')
    expect(p.get(1)).toBe('1. ')
    expect(p.get(2)).toBe('12. ')
    expect(p.get(3)).toBe('123. ')
    expect(prefixesByLine('1) paren').get(1)).toBe('1) ')
  })

  it('task items: marker + checkbox + trailing space', () => {
    expect(prefixesByLine('- [ ] buy milk').get(1)).toBe('- [ ] ')
    expect(prefixesByLine('- [x] done already').get(1)).toBe('- [x] ')
  })

  it('nested items include their leading indent', () => {
    const p = prefixesByLine('- top\n  - nested\n    - deeper')
    expect(p.get(1)).toBe('- ')
    expect(p.get(2)).toBe('  - ')
    expect(p.get(3)).toBe('    - ')
  })

  it('nested task includes indent, marker and checkbox', () => {
    expect(prefixesByLine('- top\n  - [ ] sub task').get(2)).toBe('  - [ ] ')
  })

  it('blockquoted items include the quote marker', () => {
    expect(prefixesByLine('> - quoted item').get(1)).toBe('> - ')
  })

  it('multi-space marker gaps measure as written', () => {
    expect(prefixesByLine('-   spaced out').get(1)).toBe('-   ')
  })

  it('hard continuation lines hang by their own leading whitespace', () => {
    const p = prefixesByLine('- item text\ncontinues lazy\n  continues indented')
    expect(p.get(1)).toBe('- ')
    expect(p.get(2)).toBe('') // lazy at column 0: zero hang
    expect(p.get(3)).toBe('  ')
  })

  it('later paragraphs of an item hang by their indent', () => {
    const p = prefixesByLine('- para one\n\n  para two in item')
    expect(p.get(1)).toBe('- ')
    expect(p.get(3)).toBe('  ')
  })

  it('the innermost item wins for nested lines', () => {
    // Line 2 belongs to both the outer item and the nested one — the nested
    // marker prefix must win over the outer item's continuation whitespace.
    const p = prefixesByLine('- outer\n  - inner long text')
    expect(p.get(2)).toBe('  - ')
  })

  it('non-list lines have no prefix', () => {
    const p = prefixesByLine('# Title\n\nplain paragraph\n\n> quote only\n\n- item')
    expect([...p.keys()]).toEqual([7])
  })
})

// ---------------------------------------------------------------------------
// Rendered-state hang math (pure: fake metrics + fake per-char measure). The
// live preview replaces resting markers — bullets with a 1ch glyph widget,
// task markers with the 16px checkbox (the `- ` hidden) — so the hang of a
// RESTING marker line must come from that rendered geometry, not the source
// text width.
// ---------------------------------------------------------------------------

// Deliberately fake advance table: '-' (5) differs from the bullet widget (7)
// so the bullet source/rendered difference is observable, unlike the 1ch
// fallback where both coincide at 1ch per char.
const FAKE_ADVANCE = new Map<string, number>([
  [' ', 4],
  ['-', 5],
  ['>', 6],
  ['[', 3],
  [']', 3],
  ['x', 7],
])
const fakeMeasure = (text: string): number => [...text].reduce((sum, ch) => sum + (FAKE_ADVANCE.get(ch) ?? 10), 0)
const fakeMetrics = { bulletPx: 7, checkboxPx: 16 }

describe('hanging indent: renderedHangWidth (replaced-marker math)', () => {
  it('bullet: indent + glyph widget + trailing space run — not the source text', () => {
    expect(renderedHangWidth('- ', fakeMeasure, fakeMetrics)).toEqual({ kind: 'bullet', width: 11 }) // 0 + 7 + 4
    expect(fakeMeasure('- ')).toBe(9) // the source width it replaces — differs
    expect(renderedHangWidth('  - ', fakeMeasure, fakeMetrics)).toEqual({ kind: 'bullet', width: 19 }) // 8 + 7 + 4
    expect(renderedHangWidth('-   ', fakeMeasure, fakeMetrics)).toEqual({ kind: 'bullet', width: 19 }) // 0 + 7 + 12
  })

  it('quote marks in the prefix are hidden at rest: `> ` runs contribute nothing', () => {
    // The field hides each `>` plus one following space on resting lines, so
    // the rendered hang of a quoted bullet equals the unquoted one.
    expect(renderedHangWidth('> - ', fakeMeasure, fakeMetrics)).toEqual({ kind: 'bullet', width: 11 }) // 0 + 7 + 4
    expect(fakeMeasure('> - ')).toBe(19) // source width — differs
    // Depth ≥ 2, both written forms: identical (every mark hides).
    expect(renderedHangWidth('>> - ', fakeMeasure, fakeMetrics)).toEqual({ kind: 'bullet', width: 11 })
    expect(renderedHangWidth('> > - ', fakeMeasure, fakeMetrics)).toEqual({ kind: 'bullet', width: 11 })
    // Only ONE space hides per mark; further indent still renders.
    expect(renderedHangWidth('>  - ', fakeMeasure, fakeMetrics)).toEqual({ kind: 'bullet', width: 15 }) // 4 + 7 + 4
    // Quoted task: hidden `> ` + hidden `- ` + checkbox(16) + ' '(4).
    expect(renderedHangWidth('> > - [ ] ', fakeMeasure, fakeMetrics)).toEqual({ kind: 'task', width: 20 })
  })

  it('task: the hidden `- ` contributes nothing; checkbox advance + rendered spaces', () => {
    // `- [ ] ` renders as: (hidden `- `) + checkbox(16) + ' '(4).
    expect(renderedHangWidth('- [ ] ', fakeMeasure, fakeMetrics)).toEqual({ kind: 'task', width: 20 })
    expect(fakeMeasure('- [ ] ')).toBe(23) // source width — differs
    expect(renderedHangWidth('- [x] ', fakeMeasure, fakeMetrics)).toEqual({ kind: 'task', width: 20 })
    // Nested: the leading indent still renders as text.
    expect(renderedHangWidth('  - [ ] ', fakeMeasure, fakeMetrics)).toEqual({ kind: 'task', width: 28 })
    // Extra space between marker and brackets: only ONE space is hidden with
    // the marker; the second renders.
    expect(renderedHangWidth('-  [ ] ', fakeMeasure, fakeMetrics)).toEqual({ kind: 'task', width: 24 })
  })

  it('ordered markers and continuation indents have no replaceable marker: null (source width stands)', () => {
    expect(renderedHangWidth('1. ', fakeMeasure, fakeMetrics)).toBeNull()
    expect(renderedHangWidth('12) ', fakeMeasure, fakeMetrics)).toBeNull()
    expect(renderedHangWidth('  ', fakeMeasure, fakeMetrics)).toBeNull()
    expect(renderedHangWidth('> ', fakeMeasure, fakeMetrics)).toBeNull()
    expect(renderedHangWidth('', fakeMeasure, fakeMetrics)).toBeNull()
    // Tab between marker and brackets: the field only hides a space, so this
    // rare shape degrades gracefully to the source measurement.
    expect(renderedHangWidth('-\t[ ] ', fakeMeasure, fakeMetrics)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Decoration level (mounted jsdom view: no canvas 2D, so still-rendered text
// falls back to 1ch per character — deterministic values for asserts; real
// browsers measure px, covered by the live verification). Resting task lines
// compose the checkbox's px advance with calc(); resting bullets coincide
// with the source width here because the glyph widget is exactly 1ch wide.
// ---------------------------------------------------------------------------

function mountView(doc: string, anchor = 0, extra: Extension = []): EditorView {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  return new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.single(anchor),
      extensions: [glyphdownMarkdown(), glyphdownHighlighting(), glyphdownTheme, livePreview(), extra],
    }),
    parent,
  })
}

function hangEntries(view: EditorView): { line: number; style: string }[] {
  const out: { line: number; style: string }[] = []
  const set = view.plugin(listHangingIndent)!.decorations
  const it = set.iter()
  while (it.value) {
    const spec = (it.value as Decoration).spec as { class?: string; attributes?: Record<string, string> }
    expect(spec.class).toBe('cm-ink-list-line')
    out.push({ line: view.state.doc.lineAt(it.from).number, style: spec.attributes!['style']! })
    it.next()
  }
  return out
}

describe('hanging indent: line decorations (jsdom, ch fallback)', () => {
  it('decorates each marker shape with its state-aware prefix width', () => {
    const view = mountView('- bullet here\n\n12. ordered here\n\n- [ ] task here\n\n  - nested here')
    try {
      expect(hangEntries(view)).toEqual([
        { line: 1, style: '--ink-hang: 2ch' }, // caret on the line: revealed, source width
        { line: 3, style: '--ink-hang: 4ch' }, // ordered: never replaced, source width
        { line: 5, style: '--ink-hang: calc(1ch + 16px)' }, // resting task: checkbox + trailing space
        { line: 7, style: '--ink-hang: 4ch' }, // resting bullet: indent + 1ch glyph + space
      ])
    } finally {
      view.destroy()
    }
  })

  it('applies the class and inline var to the rendered line DOM', () => {
    const view = mountView('- wrapped item text\n\nplain paragraph')
    try {
      const lines = Array.from(view.dom.querySelectorAll('.cm-line'))
      const listLines = lines.filter((l) => l.classList.contains('cm-ink-list-line'))
      expect(listLines).toHaveLength(1)
      expect(listLines[0]!.getAttribute('style')).toContain('--ink-hang: 2ch')
      // Non-list lines untouched: no class, no hang var.
      for (const line of lines) {
        if (line === listLines[0]) continue
        expect(line.getAttribute('style') ?? '').not.toContain('--ink-hang')
      }
    } finally {
      view.destroy()
    }
  })

  it('swaps a marker line between rendered and source hang as the caret moves (round-trip stable)', () => {
    const view = mountView('- bullet here\n\n- [ ] task here', 0) // caret on the bullet line
    try {
      const caretOnBullet = [
        { line: 1, style: '--ink-hang: 2ch' }, // revealed bullet: source width
        { line: 3, style: '--ink-hang: calc(1ch + 16px)' }, // resting task: rendered width
      ]
      expect(hangEntries(view)).toEqual(caretOnBullet)
      view.dispatch({ selection: EditorSelection.single(18) }) // caret onto the task line
      expect(hangEntries(view)).toEqual([
        { line: 1, style: '--ink-hang: 2ch' }, // resting bullet: 1ch glyph + space (= source in ch fallback)
        { line: 3, style: '--ink-hang: 6ch' }, // revealed task: source width
      ])
      view.dispatch({ selection: EditorSelection.single(0) }) // back to the bullet line
      expect(hangEntries(view)).toEqual(caretOnBullet) // round trip: no drift
    } finally {
      view.destroy()
    }
  })

  it('ordered-list hang is identical in resting and revealed states', () => {
    const view = mountView('12. ordered here\n\nplain paragraph', 0) // caret on the ordered line
    try {
      const revealed = hangEntries(view)
      expect(revealed).toEqual([{ line: 1, style: '--ink-hang: 4ch' }])
      view.dispatch({ selection: EditorSelection.single(20) }) // caret onto the paragraph
      expect(hangEntries(view)).toEqual(revealed) // marker never replaced → same hang
    } finally {
      view.destroy()
    }
  })

  it('without livePreviewField (standalone plugin) markers are never replaced: source widths', () => {
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const view = new EditorView({
      state: EditorState.create({
        doc: 'plain\n\n- [ ] task here',
        selection: EditorSelection.single(0),
        extensions: [glyphdownMarkdown(), listHangingIndent],
      }),
      parent,
    })
    try {
      // The task line rests (caret elsewhere), but with no field there is no
      // checkbox widget either — the source measurement is the correct hang.
      expect(hangEntries(view)).toEqual([{ line: 3, style: '--ink-hang: 6ch' }])
    } finally {
      view.destroy()
    }
  })

  it('decorates every line of a hard-wrapped item, by each line\'s own indent', () => {
    const view = mountView('- first line\n  hard continuation')
    try {
      expect(hangEntries(view)).toEqual([
        { line: 1, style: '--ink-hang: 2ch' },
        { line: 2, style: '--ink-hang: 2ch' }, // two leading spaces
      ])
    } finally {
      view.destroy()
    }
  })

  it('leaves non-list documents undecorated', () => {
    const view = mountView('# Title\n\nparagraph text\n\n> quote\n\n```\ncode\n```')
    try {
      expect(hangEntries(view)).toEqual([])
    } finally {
      view.destroy()
    }
  })

  it('updates decorations as list structure changes', () => {
    const view = mountView('plain text')
    try {
      expect(hangEntries(view)).toEqual([])
      view.dispatch({ changes: { from: 0, to: 0, insert: '- ' } })
      expect(hangEntries(view)).toEqual([{ line: 1, style: '--ink-hang: 2ch' }])
    } finally {
      view.destroy()
    }
  })
})

describe('hanging indent: read-only (jsdom)', () => {
  // Read-only mode never reveals source markers, so every marker line keeps
  // its RENDERED hang permanently — the caret moving across lines must not
  // oscillate widths (the task line would flip calc(1ch + 16px) ↔ 6ch).
  const DOC = '- bullet here\n\n- [ ] task here'
  const TASK_POS = DOC.indexOf('task')
  const restingHang = [
    { line: 1, style: '--ink-hang: 2ch' }, // bullet: 1ch glyph + space (ch fallback)
    { line: 3, style: '--ink-hang: calc(1ch + 16px)' }, // task: checkbox + trailing space
  ]

  it('keeps rendered widths with the caret on a marker line, across caret moves', () => {
    const view = mountView(DOC, TASK_POS, [EditorState.readOnly.of(true), EditorView.editable.of(false)])
    try {
      // Caret ON the task line: still the rendered width, not the 6ch source.
      expect(hangEntries(view)).toEqual(restingHang)
      view.dispatch({ selection: EditorSelection.single(0) }) // onto the bullet line
      expect(hangEntries(view)).toEqual(restingHang)
      view.dispatch({ selection: EditorSelection.single(TASK_POS) }) // back again
      expect(hangEntries(view)).toEqual(restingHang) // no oscillation
    } finally {
      view.destroy()
    }
  })

  it('a readOnly compartment flip swaps the caret line between rendered and source hang', () => {
    const comp = new Compartment()
    const view = mountView(DOC, TASK_POS, comp.of([EditorState.readOnly.of(true), EditorView.editable.of(false)]))
    try {
      expect(hangEntries(view)).toEqual(restingHang)
      // Role re-resolution flips the compartment at runtime: the caret line
      // must now reveal (source hang) with no doc/selection change at all.
      view.dispatch({ effects: comp.reconfigure([]) })
      expect(hangEntries(view)).toEqual([
        { line: 1, style: '--ink-hang: 2ch' },
        { line: 3, style: '--ink-hang: 6ch' }, // revealed task: source width
      ])
      view.dispatch({ effects: comp.reconfigure([EditorState.readOnly.of(true), EditorView.editable.of(false)]) })
      expect(hangEntries(view)).toEqual(restingHang)
    } finally {
      view.destroy()
    }
  })
})
