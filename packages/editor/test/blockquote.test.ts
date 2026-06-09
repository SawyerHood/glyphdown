import { describe, expect, it } from 'vitest'
import { EditorSelection, EditorState } from '@codemirror/state'
import { MAX_QUOTE_DEPTH, glyphdownMarkdown, livePreview } from '../src/index.ts'
import { decorationsWithClass, hiddenRanges, previewState } from './helpers.ts'

// ---------------------------------------------------------------------------
// Depth-aware nested blockquotes (Obsidian semantics): each `>` nesting level
// stacks one more left bar and one more padding step. The blockquote line
// decoration carries a depth class (cm-ink-bq-d1..d4, deeper clamped to d4);
// the innermost depth wins per line. Caret position never changes the depth
// class (no horizontal jump between rendered and revealed states), and ALL
// QuoteMark tokens on a resting line hide together / reveal together. The
// `>>` and `> >` written forms are equivalent. Read-only never reveals, but
// the depth classes still apply.
// ---------------------------------------------------------------------------

function readOnlyState(doc: string, anchor = 0, head = anchor): EditorState {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.single(anchor, head),
    extensions: [glyphdownMarkdown(), livePreview(), EditorState.readOnly.of(true)],
  })
  // Force one recompute so the field reflects the fully parsed tree (the
  // previewState pattern in helpers.ts).
  return state.update({ selection: EditorSelection.single(anchor, head) }).state
}

/** The cm-ink-bq-d<n> class on the line at `lineNo` (1-based), or null. */
function depthClass(state: EditorState, lineNo: number): string | null {
  const from = state.doc.line(lineNo).from
  for (let d = 1; d <= MAX_QUOTE_DEPTH; d++) {
    const cls = `cm-ink-bq-d${d}`
    if (decorationsWithClass(state, cls).some((deco) => deco.from === from)) return cls
  }
  return null
}

describe('blockquote depth: line classes', () => {
  it('a single-level quote is depth 1 (today\'s single border)', () => {
    const state = previewState('> shallow\n\npara', 13)
    expect(decorationsWithClass(state, 'cm-ink-blockquote')).toHaveLength(1)
    expect(depthClass(state, 1)).toBe('cm-ink-bq-d1')
    // No deeper class leaks onto the line.
    expect(decorationsWithClass(state, 'cm-ink-bq-d2')).toHaveLength(0)
  })

  it('each nesting level gets its own depth class; the innermost wins per line', () => {
    const state = previewState('> a\n> > b\n> > > c\n\npara', 22)
    expect(depthClass(state, 1)).toBe('cm-ink-bq-d1')
    expect(depthClass(state, 2)).toBe('cm-ink-bq-d2')
    expect(depthClass(state, 3)).toBe('cm-ink-bq-d3')
    // Exactly one blockquote line decoration per quoted line — no duplicates.
    expect(decorationsWithClass(state, 'cm-ink-blockquote')).toHaveLength(3)
  })

  it('every quoted line carries the generic cm-ink-blockquote class too', () => {
    const state = previewState('> a\n> > b\n\npara', 13)
    // The depth class rides alongside cm-ink-blockquote (border + muted ink).
    expect(decorationsWithClass(state, 'cm-ink-blockquote')).toHaveLength(2)
    expect(depthClass(state, 1)).toBe('cm-ink-bq-d1')
    expect(depthClass(state, 2)).toBe('cm-ink-bq-d2')
  })

  it('clamps visual depth at MAX_QUOTE_DEPTH (deeper quotes share the d4 styling)', () => {
    // Six `>` deep — well past the cap.
    const state = previewState('> a\n> > b\n> > > c\n> > > > d\n> > > > > e\n> > > > > > f\n\npara', 0)
    expect(depthClass(state, 4)).toBe('cm-ink-bq-d4')
    expect(depthClass(state, 5)).toBe('cm-ink-bq-d4') // clamped
    expect(depthClass(state, 6)).toBe('cm-ink-bq-d4') // clamped
    // No class beyond the cap is ever emitted.
    expect(decorationsWithClass(state, `cm-ink-bq-d${MAX_QUOTE_DEPTH + 1}`)).toHaveLength(0)
  })
})

describe('blockquote depth: `>>` and `> >` are equivalent', () => {
  it('the two written forms produce the same depth-2 class', () => {
    const tight = previewState('>> deep\n\npara', 0)
    const spaced = previewState('> > deep\n\npara', 0)
    expect(depthClass(tight, 1)).toBe('cm-ink-bq-d2')
    expect(depthClass(spaced, 1)).toBe('cm-ink-bq-d2')
  })

  it('both forms hide ALL their quote marks as a unit when resting', () => {
    // `>>`: two QuoteMark nodes, `>` (no space) then `> ` (with space).
    const tight = previewState('>> deep\n\npara', 9)
    expect(hiddenRanges(tight)).toContainEqual({ from: 0, to: 1 }) // first `>`
    expect(hiddenRanges(tight)).toContainEqual({ from: 1, to: 3 }) // second `> `
    expect(decorationsWithClass(tight, 'cm-ink-quote-mark')).toHaveLength(0)
    // `> >`: `> ` then `> `.
    const spaced = previewState('> > deep\n\npara', 10)
    expect(spaced.doc.line(1).text).toBe('> > deep')
    expect(hiddenRanges(spaced)).toContainEqual({ from: 0, to: 2 }) // first `> `
    expect(hiddenRanges(spaced)).toContainEqual({ from: 2, to: 4 }) // second `> `
    expect(decorationsWithClass(spaced, 'cm-ink-quote-mark')).toHaveLength(0)
  })
})

describe('blockquote depth: complete mark hiding / reveal per line', () => {
  it('a deep line hides EVERY mark together when the caret is away', () => {
    const doc = '> a\n> > > deep\n\npara'
    const state = previewState(doc, doc.length) // caret on the para
    const hidden = hiddenRanges(state)
    // Line 2 `> > > deep`: three marks, each `> ` hidden as a unit.
    expect(hidden).toContainEqual({ from: 4, to: 6 })
    expect(hidden).toContainEqual({ from: 6, to: 8 })
    expect(hidden).toContainEqual({ from: 8, to: 10 })
    expect(decorationsWithClass(state, 'cm-ink-quote-mark')).toHaveLength(0)
  })

  it('the caret on a deep line reveals ALL of that line\'s marks together (none hidden)', () => {
    const doc = '> a\n> > > deep\n\npara'
    const caret = doc.indexOf('deep') + 1
    const state = previewState(doc, caret)
    // All three marks on the caret line are revealed as gray mark spans…
    const marks = decorationsWithClass(state, 'cm-ink-quote-mark').map((m) => ({ from: m.from, to: m.to }))
    expect(marks).toContainEqual({ from: 4, to: 5 })
    expect(marks).toContainEqual({ from: 6, to: 7 })
    expect(marks).toContainEqual({ from: 8, to: 9 })
    // …and NONE of the caret line's marks are hidden.
    const hidden = hiddenRanges(state).filter((r) => r.from >= 4 && r.to <= 14)
    expect(hidden).toHaveLength(0)
  })

  it('reveal is strictly per line: a caret on line 2 leaves line 1 and line 3 fully hidden', () => {
    const doc = '> > a\n> > b\n> > c'
    const state = previewState(doc, 9) // caret inside line 2 "b"
    const hidden = hiddenRanges(state)
    // Line 1 both marks hidden.
    expect(hidden).toContainEqual({ from: 0, to: 2 })
    expect(hidden).toContainEqual({ from: 2, to: 4 })
    // Line 3 both marks hidden.
    expect(hidden).toContainEqual({ from: 12, to: 14 })
    expect(hidden).toContainEqual({ from: 14, to: 16 })
    // Only line 2's two marks are revealed.
    expect(decorationsWithClass(state, 'cm-ink-quote-mark')).toHaveLength(2)
  })

  it('the depth class is identical whether the line is resting or revealed (no horizontal jump)', () => {
    const doc = '> a\n> > b\n\npara'
    const resting = previewState(doc, doc.length) // caret on para
    const revealed = previewState(doc, doc.indexOf(' b') + 1) // caret on line 2
    expect(depthClass(resting, 2)).toBe('cm-ink-bq-d2')
    expect(depthClass(revealed, 2)).toBe('cm-ink-bq-d2')
  })
})

describe('blockquote depth: blank `>` line + continuation', () => {
  it('a blank quote line between two content lines is still depth-classed and mark-hidden', () => {
    const doc = '> first\n>\n> second\n\npara'
    const state = previewState(doc, doc.length)
    expect(depthClass(state, 1)).toBe('cm-ink-bq-d1')
    expect(depthClass(state, 2)).toBe('cm-ink-bq-d1') // the lone `>` line
    expect(depthClass(state, 3)).toBe('cm-ink-bq-d1')
    // The lone `>` (no following space) hides on the resting blank line.
    expect(hiddenRanges(state)).toContainEqual({ from: 8, to: 9 })
  })
})

describe('blockquote depth: callout + quote interplay', () => {
  it('a top-level callout owns level 1 itself — no quote-depth classes', () => {
    const doc = '> [!note] Title\n> body\n\npara'
    const state = previewState(doc, doc.length)
    // Callout lines are tinted with the per-type class…
    expect(decorationsWithClass(state, 'cm-ink-callout')).toHaveLength(2)
    // …and carry NO blockquote depth class or callout-nested tag.
    expect(decorationsWithClass(state, 'cm-ink-bq-d1')).toHaveLength(0)
    expect(decorationsWithClass(state, 'cm-ink-callout-nested')).toHaveLength(0)
  })

  it('a callout nested INSIDE a quote keeps the outer quote\'s gray bar (callout-nested) at its depth', () => {
    const doc = '> outer\n> > [!note] Title\n> > body\n\npara'
    const state = previewState(doc, doc.length)
    // Outer quote line: depth 1.
    expect(depthClass(state, 1)).toBe('cm-ink-bq-d1')
    // The callout's two lines occupy quote depth 2 and are tagged so the theme
    // keeps the OUTER quote's gray bar at the border position (no double border).
    expect(depthClass(state, 2)).toBe('cm-ink-bq-d2')
    expect(depthClass(state, 3)).toBe('cm-ink-bq-d2')
    const nested = decorationsWithClass(state, 'cm-ink-callout-nested').map((d) => d.from)
    expect(nested).toEqual([state.doc.line(2).from, state.doc.line(3).from])
    // The callout tint/accent still applies on those lines.
    expect(decorationsWithClass(state, 'cm-ink-callout')).toHaveLength(2)
  })

  it('a quote nested INSIDE a callout: the inner quote line is plain depth-2 (no callout-nested tag)', () => {
    const doc = '> [!note] Title\n> > quoted inside\n\npara'
    const state = previewState(doc, doc.length)
    // The inner `> >` line is a plain depth-2 quote line (gray gradient bars);
    // it is NOT a nested callout, so it carries no callout-nested tag.
    expect(depthClass(state, 2)).toBe('cm-ink-bq-d2')
    expect(decorationsWithClass(state, 'cm-ink-callout-nested')).toHaveLength(0)
  })
})

describe('blockquote depth: read-only never reveals, but depth classes still apply', () => {
  const doc = '> a\n> > b\n> > > c'

  it('keeps every mark hidden with the caret on a deep line, depth classes intact', () => {
    const ro = readOnlyState(doc, doc.indexOf('c') + 1) // caret on the deepest line
    // No mark is revealed anywhere (read-only).
    expect(decorationsWithClass(ro, 'cm-ink-quote-mark')).toHaveLength(0)
    // The deepest line's three marks stay hidden despite the caret.
    const hidden = hiddenRanges(ro)
    expect(hidden).toContainEqual({ from: 10, to: 12 })
    expect(hidden).toContainEqual({ from: 12, to: 14 })
    expect(hidden).toContainEqual({ from: 14, to: 16 })
    // Depth classes apply exactly as in editable mode.
    expect(depthClass(ro, 1)).toBe('cm-ink-bq-d1')
    expect(depthClass(ro, 2)).toBe('cm-ink-bq-d2')
    expect(depthClass(ro, 3)).toBe('cm-ink-bq-d3')
  })

  it('editable control: the same caret reveals that line\'s marks', () => {
    const editable = previewState(doc, doc.indexOf('c') + 1)
    expect(decorationsWithClass(editable, 'cm-ink-quote-mark')).toHaveLength(3)
  })
})
