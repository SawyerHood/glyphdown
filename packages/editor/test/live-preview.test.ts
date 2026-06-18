import { describe, expect, it } from 'vitest'
import { toggleCheckboxChange } from '../src/index.ts'
import { decorationsTagged, decorationsWithClass, hiddenRanges, previewState } from './helpers.ts'

describe('live preview: inline formatting', () => {
  it('hides bold delimiters when the selection is elsewhere', () => {
    const state = previewState('intro\n\n**bold** here', 0)
    const hidden = hiddenRanges(state)
    expect(hidden).toContainEqual({ from: 7, to: 9 })
    expect(hidden).toContainEqual({ from: 13, to: 15 })
  })

  it('reveals bold delimiters when the cursor is inside the node', () => {
    const state = previewState('intro\n\n**bold** here', 10)
    const hidden = hiddenRanges(state).filter((r) => r.from >= 7 && r.to <= 15)
    expect(hidden).toHaveLength(0)
  })

  it('reveals delimiters when a selection range overlaps the node', () => {
    const state = previewState('intro\n\n**bold** here', 8, 18)
    const hidden = hiddenRanges(state).filter((r) => r.from >= 7 && r.to <= 15)
    expect(hidden).toHaveLength(0)
  })

  it('hides italic and strikethrough marks', () => {
    const state = previewState('a *it* and ~~gone~~ b', 0)
    const hidden = hiddenRanges(state)
    expect(hidden).toContainEqual({ from: 2, to: 3 })
    expect(hidden).toContainEqual({ from: 5, to: 6 })
    expect(hidden).toContainEqual({ from: 11, to: 13 })
    expect(hidden).toContainEqual({ from: 17, to: 19 })
  })

  it('hides inline-code backticks and styles the code', () => {
    const state = previewState('a `code` b', 0)
    const hidden = hiddenRanges(state)
    expect(hidden).toContainEqual({ from: 2, to: 3 })
    expect(hidden).toContainEqual({ from: 7, to: 8 })
    const marks = decorationsWithClass(state, 'cm-ink-inline-code')
    expect(marks).toHaveLength(1)
    expect(marks[0]).toMatchObject({ from: 2, to: 8 })
  })
})

describe('live preview: headings', () => {
  it('hides the # marker and its space when the cursor is on another line', () => {
    const state = previewState('# Title\n\nbody', 9)
    expect(hiddenRanges(state)).toContainEqual({ from: 0, to: 2 })
    const lines = decorationsWithClass(state, 'cm-ink-h1')
    expect(lines).toHaveLength(1)
    expect(lines[0]!.from).toBe(0)
  })

  it('reveals the marker when the cursor is anywhere on the heading line', () => {
    const state = previewState('# Title\n\nbody', 3)
    expect(hiddenRanges(state)).toHaveLength(0)
  })

  it('handles all six heading levels', () => {
    const doc = '## two\n\n###### six\n\nbody'
    const state = previewState(doc, doc.length)
    expect(decorationsWithClass(state, 'cm-ink-h2')).toHaveLength(1)
    expect(decorationsWithClass(state, 'cm-ink-h6')).toHaveLength(1)
    expect(hiddenRanges(state)).toContainEqual({ from: 0, to: 3 })
    expect(hiddenRanges(state)).toContainEqual({ from: 8, to: 15 })
  })

  it('does not style a Setext heading while the caret is editing the block', () => {
    // Typing `-` under "hello" to start a bullet list momentarily parses as a
    // Setext h2 ("hello" + `-` underline). With the caret on the underline the
    // paragraph must stay un-styled rather than flashing to heading type.
    const doc = 'hello\n-'
    const state = previewState(doc, doc.length)
    expect(decorationsWithClass(state, 'cm-ink-h2')).toHaveLength(0)
  })

  it('styles a Setext heading once the caret leaves the block', () => {
    const state = previewState('hello\n-\n\nbody', 11)
    // The Setext node spans the text line and its underline; both get the
    // heading line class. The text line ("hello", from 0) is what shows big.
    const lines = decorationsWithClass(state, 'cm-ink-h2')
    expect(lines.some((l) => l.from === 0)).toBe(true)
  })
})

describe('live preview: links', () => {
  it('renders a chip: label marked, syntax hidden, href attached', () => {
    const state = previewState('see [text](https://x.dev) end', 0)
    const hidden = hiddenRanges(state)
    expect(hidden).toContainEqual({ from: 4, to: 5 })
    expect(hidden).toContainEqual({ from: 9, to: 25 })
    const chips = decorationsWithClass(state, 'cm-ink-link')
    expect(chips).toHaveLength(1)
    expect(chips[0]).toMatchObject({ from: 5, to: 9 })
    expect(chips[0]!.deco.spec['attributes']['data-href']).toBe('https://x.dev')
  })

  it('reveals full syntax when the cursor enters the link', () => {
    const state = previewState('see [text](https://x.dev) end', 6)
    expect(hiddenRanges(state)).toHaveLength(0)
    expect(decorationsWithClass(state, 'cm-ink-link')).toHaveLength(0)
  })
})

describe('live preview: images', () => {
  it('replaces the image with a placeholder widget', () => {
    const state = previewState('before\n\n![alt](img.png)\n\nafter', 0)
    const widgets = decorationsTagged(state, 'image')
    expect(widgets).toHaveLength(1)
    expect(widgets[0]).toMatchObject({ from: 8, to: 23 })
  })

  it('reveals the syntax when the cursor is on the image line', () => {
    const state = previewState('before\n\n![alt](img.png)\n\nafter', 10)
    expect(decorationsTagged(state, 'image')).toHaveLength(0)
    // ...and keeps the rendered image visible as a block widget below the line.
    const blocks = decorationsTagged(state, 'image-block')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ from: 23, to: 23 })
    expect(blocks[0]!.deco.spec['block']).toBe(true)
  })
})

describe('live preview: task lists', () => {
  it('replaces the marker with a checkbox widget when the cursor is elsewhere', () => {
    const state = previewState('- [ ] buy milk\n\npara', 17)
    const boxes = decorationsTagged(state, 'checkbox')
    expect(boxes).toHaveLength(1)
    expect(boxes[0]).toMatchObject({ from: 2, to: 5 })
  })

  it('hides the list marker and its space — the checkbox alone marks the item', () => {
    const state = previewState('- [ ] buy milk\n\npara', 17)
    expect(hiddenRanges(state)).toContainEqual({ from: 0, to: 2 })
    // The dash is hidden outright, never swapped for a bullet glyph.
    expect(decorationsTagged(state, 'bullet')).toHaveLength(0)
  })

  it('hides * and + task markers as well', () => {
    const doc = '* [ ] star\n\n+ [x] plus\n\npara'
    const state = previewState(doc, doc.length)
    expect(hiddenRanges(state)).toContainEqual({ from: 0, to: 2 })
    expect(hiddenRanges(state)).toContainEqual({ from: 12, to: 14 })
    expect(decorationsTagged(state, 'checkbox')).toHaveLength(2)
  })

  it('shows raw syntax when the cursor is on the task line', () => {
    const state = previewState('- [ ] buy milk\n\npara', 8)
    expect(decorationsTagged(state, 'checkbox')).toHaveLength(0)
    // The `- ` marker is revealed too — nothing on the line stays hidden.
    expect(hiddenRanges(state)).toHaveLength(0)
    expect(decorationsTagged(state, 'bullet')).toHaveLength(0)
  })

  it('strikes through completed tasks', () => {
    const state = previewState('- [x] done\n\npara', 13)
    expect(decorationsWithClass(state, 'cm-ink-task-done')).toHaveLength(1)
    // The strike covers only the task text — not the indent or the hidden
    // marker, which would otherwise render a floating dash.
    const strikes = decorationsWithClass(state, 'cm-ink-task-done-text')
    expect(strikes).toHaveLength(1)
    expect(strikes[0]).toMatchObject({ from: 5, to: 10 })
  })
})

describe('live preview: bullet lists', () => {
  it('replaces the dash with a bullet widget when the cursor is elsewhere', () => {
    const state = previewState('- item\n\npara', 10)
    const bullets = decorationsTagged(state, 'bullet')
    expect(bullets).toHaveLength(1)
    expect(bullets[0]).toMatchObject({ from: 0, to: 1 })
    // Only the marker char is swapped — its following space stays as text.
    expect(hiddenRanges(state)).toHaveLength(0)
  })

  it('renders * and + markers as bullets too', () => {
    const doc = '* star\n\n+ plus\n\npara'
    const state = previewState(doc, doc.length)
    const bullets = decorationsTagged(state, 'bullet')
    expect(bullets.map(({ from, to }) => ({ from, to }))).toEqual([
      { from: 0, to: 1 },
      { from: 8, to: 9 },
    ])
  })

  it('uses the same bullet glyph at every nesting depth', () => {
    const doc = '- a\n  - b\n    - c\n\npara'
    const state = previewState(doc, doc.length)
    const bullets = decorationsTagged(state, 'bullet')
    expect(bullets.map(({ from, to }) => ({ from, to }))).toEqual([
      { from: 0, to: 1 },
      { from: 6, to: 7 },
      { from: 14, to: 15 },
    ])
    // One shared widget instance: identical glyph at every depth.
    expect(bullets.every((b) => b.deco.spec['widget'] === bullets[0]!.deco.spec['widget'])).toBe(true)
  })

  it('reveals the raw marker when the cursor is on the bullet line', () => {
    const state = previewState('- item\n\npara', 3)
    expect(decorationsTagged(state, 'bullet')).toHaveLength(0)
    expect(decorationsWithClass(state, 'cm-ink-list-mark')).toHaveLength(1)
  })

  it('only reveals the marker on the cursor line in a multi-item list', () => {
    const doc = '- one\n- two\n- three'
    const state = previewState(doc, 8) // cursor inside "two"
    const bullets = decorationsTagged(state, 'bullet')
    expect(bullets.map(({ from, to }) => ({ from, to }))).toEqual([
      { from: 0, to: 1 },
      { from: 12, to: 13 },
    ])
  })

  it('leaves ordered-list markers untouched', () => {
    const doc = '1. one\n2. two\n\npara'
    const state = previewState(doc, 16)
    expect(decorationsTagged(state, 'bullet')).toHaveLength(0)
    expect(hiddenRanges(state)).toHaveLength(0)
    expect(decorationsWithClass(state, 'cm-ink-list-mark')).toHaveLength(2)
  })

  it('keeps a nested task and a nested bullet at the same depth aligned', () => {
    const doc = '- top\n  - [ ] sub task\n  - sub bullet\n\npara'
    const state = previewState(doc, doc.length)
    // Nested task: `- ` hidden (8–10), checkbox over `[ ]` (10–13).
    expect(hiddenRanges(state)).toContainEqual({ from: 8, to: 10 })
    const boxes = decorationsTagged(state, 'checkbox')
    expect(boxes).toContainEqual(expect.objectContaining({ from: 10, to: 13 }))
    // Nested bullet: the glyph replaces the marker at position 25.
    const bullets = decorationsTagged(state, 'bullet')
    expect(bullets).toContainEqual(expect.objectContaining({ from: 25, to: 26 }))
    // Both rendered lines start their visible content at the same column, so
    // the checkbox and the bullet glyph line up without drift.
    const taskMarkerCol = 8 - state.doc.lineAt(8).from
    const bulletMarkerCol = 25 - state.doc.lineAt(25).from
    expect(taskMarkerCol).toBe(bulletMarkerCol)
  })
})

describe('checkbox toggling', () => {
  it('computes the flip for an unchecked box', () => {
    const state = previewState('- [ ] buy milk', 0)
    expect(toggleCheckboxChange(state.doc, 2)).toEqual({ from: 3, to: 4, insert: 'x' })
  })

  it('computes the flip for a checked box', () => {
    const state = previewState('- [x] done', 0)
    expect(toggleCheckboxChange(state.doc, 2)).toEqual({ from: 3, to: 4, insert: ' ' })
  })

  it('returns null off-marker', () => {
    const state = previewState('plain text', 0)
    expect(toggleCheckboxChange(state.doc, 0)).toBeNull()
  })

  it('the toggle transaction produces the flipped document', () => {
    const state = previewState('- [ ] buy milk', 0)
    const change = toggleCheckboxChange(state.doc, 2)!
    const next = state.update({ changes: change }).state
    expect(next.doc.toString()).toBe('- [x] buy milk')
  })
})

describe('live preview: blocks', () => {
  it('styles fenced code lines and keeps fences visible', () => {
    const doc = '```js\nconst x = 1\n```'
    const state = previewState(doc, doc.length)
    const lines = decorationsWithClass(state, 'cm-ink-code-block')
    expect(lines.map((l) => l.from)).toEqual([0, 6, 18])
    expect(hiddenRanges(state)).toHaveLength(0)
  })

  it('styles tables as a monospace block without hiding anything', () => {
    const doc = '| a | b |\n| --- | --- |\n| 1 | 2 |'
    const state = previewState(doc, 0)
    const lines = decorationsWithClass(state, 'cm-ink-table')
    expect(lines).toHaveLength(3)
    expect(hiddenRanges(state)).toHaveLength(0)
  })

  it('styles blockquote lines and hides the marker away from the caret', () => {
    const state = previewState('> quoted\n\npara', 12)
    expect(decorationsWithClass(state, 'cm-ink-blockquote')).toHaveLength(1)
    // The `> ` marker hides; the line's border/muted styling marks the quote.
    expect(hiddenRanges(state)).toContainEqual({ from: 0, to: 2 })
    expect(decorationsWithClass(state, 'cm-ink-quote-mark')).toHaveLength(0)
  })

  it('styles horizontal rules', () => {
    const doc = 'a\n\n---\n\nb'
    const state = previewState(doc, 0)
    expect(decorationsWithClass(state, 'cm-ink-hr')).toHaveLength(1)
  })

  it('styles YAML frontmatter lines', () => {
    const doc = '---\ntitle: x\n---\n\nbody'
    const state = previewState(doc, doc.length)
    const lines = decorationsWithClass(state, 'cm-ink-frontmatter')
    expect(lines.length).toBeGreaterThanOrEqual(3)
  })
})

describe('live preview: horizontal rules', () => {
  it('replaces the rule with a divider widget when the caret is elsewhere', () => {
    const state = previewState('a\n\n---\n\nb', 0)
    const rules = decorationsTagged(state, 'hr')
    expect(rules).toHaveLength(1)
    expect(rules[0]).toMatchObject({ from: 3, to: 6 }) // the whole `---`
    expect(decorationsWithClass(state, 'cm-ink-hr-mark')).toHaveLength(0)
    // The line keeps its hr styling either way.
    expect(decorationsWithClass(state, 'cm-ink-hr')).toHaveLength(1)
  })

  it('handles the spaced `- - -` form', () => {
    const state = previewState('a\n\n- - -\n\nb', 0)
    const rules = decorationsTagged(state, 'hr')
    expect(rules).toHaveLength(1)
    expect(rules[0]).toMatchObject({ from: 3, to: 8 })
    // Never mistaken for a bullet list item.
    expect(decorationsTagged(state, 'bullet')).toHaveLength(0)
  })

  it('reveals the raw gray rule when the caret is on its line', () => {
    const state = previewState('a\n\n---\n\nb', 4)
    expect(decorationsTagged(state, 'hr')).toHaveLength(0)
    const marks = decorationsWithClass(state, 'cm-ink-hr-mark')
    expect(marks).toHaveLength(1)
    expect(marks[0]).toMatchObject({ from: 3, to: 6 })
  })

  it('all rule widgets share one instance (interchangeable dividers)', () => {
    const state = previewState('a\n\n---\n\n***\n\nb', 0)
    const rules = decorationsTagged(state, 'hr')
    expect(rules).toHaveLength(2)
    expect(rules[0]!.deco.spec['widget']).toBe(rules[1]!.deco.spec['widget'])
  })
})

describe('live preview: URL-less links stay plain text (dead-link guard)', () => {
  it('[^1] footnote refs are not chipped as links (they render as footnote chips)', () => {
    const state = previewState('text [^1] ref\n\n[^1]: the note', 0)
    expect(decorationsWithClass(state, 'cm-ink-link')).toHaveLength(0)
    // The ref parses as FootnoteRef now and renders as its own chip widget
    // (covered in footnote.test.ts) — never as a dead link.
    expect(decorationsTagged(state, 'footnote-ref')).toHaveLength(1)
  })

  it('> [!note] callout headers are not chipped as links (they render as callouts)', () => {
    const doc = '> [!note]\n> callout body\n\npara'
    const state = previewState(doc, doc.length)
    expect(decorationsWithClass(state, 'cm-ink-link')).toHaveLength(0)
    // The header is owned by the callout rendering (covered in
    // callout.test.ts) — never a dead-link chip.
    expect(decorationsTagged(state, 'callout-header')).toHaveLength(1)
  })

  it('- [?] non-task bracket markers are not chipped', () => {
    const state = previewState('- [?] odd task\n\npara', 17)
    expect(decorationsWithClass(state, 'cm-ink-link')).toHaveLength(0)
    expect(hiddenRanges(state)).toHaveLength(0)
  })

  it('[foo] shortcut references are not chipped', () => {
    const state = previewState('[foo] shortcut\n\npara', 17)
    expect(decorationsWithClass(state, 'cm-ink-link')).toHaveLength(0)
    expect(hiddenRanges(state)).toHaveLength(0)
  })

  it('links WITH a URL still chip (the guard is URL-less only)', () => {
    const doc = '[text](https://x.dev) and [^1]\n\npara'
    const state = previewState(doc, doc.length)
    const chips = decorationsWithClass(state, 'cm-ink-link')
    expect(chips).toHaveLength(1)
    expect(chips[0]).toMatchObject({ from: 1, to: 5 })
  })
})

describe('live preview: ==highlight==', () => {
  it('marks the span and hides the == delimiters away from the selection', () => {
    const state = previewState('a ==glow== b', 0)
    const marks = decorationsWithClass(state, 'cm-ink-highlight')
    expect(marks).toHaveLength(1)
    expect(marks[0]).toMatchObject({ from: 2, to: 10 }) // whole node, marks included
    const hidden = hiddenRanges(state)
    expect(hidden).toContainEqual({ from: 2, to: 4 })
    expect(hidden).toContainEqual({ from: 8, to: 10 })
  })

  it('reveals the delimiters when the cursor is inside, keeping the background', () => {
    const state = previewState('a ==glow== b', 5)
    expect(hiddenRanges(state)).toHaveLength(0)
    expect(decorationsWithClass(state, 'cm-ink-highlight')).toHaveLength(1)
  })

  it('does not treat a single = pair as a highlight', () => {
    const state = previewState('a =not= b', 0)
    expect(decorationsWithClass(state, 'cm-ink-highlight')).toHaveLength(0)
    expect(hiddenRanges(state)).toHaveLength(0)
  })

  it('nests with other inline formatting', () => {
    const state = previewState('x ==has **bold** inside== y', 0)
    const marks = decorationsWithClass(state, 'cm-ink-highlight')
    expect(marks).toHaveLength(1)
    expect(marks[0]).toMatchObject({ from: 2, to: 25 })
    // Both the == and ** delimiters hide.
    const hidden = hiddenRanges(state)
    expect(hidden).toContainEqual({ from: 2, to: 4 })
    expect(hidden).toContainEqual({ from: 8, to: 10 })
    expect(hidden).toContainEqual({ from: 14, to: 16 })
    expect(hidden).toContainEqual({ from: 23, to: 25 })
  })
})

describe('live preview: blockquote marks', () => {
  it('hides the > and its space on lines the caret is not on', () => {
    const state = previewState('> quoted\n\npara', 12)
    expect(hiddenRanges(state)).toContainEqual({ from: 0, to: 2 })
    expect(decorationsWithClass(state, 'cm-ink-quote-mark')).toHaveLength(0)
    // The quote line styling (border + muted text) stays.
    expect(decorationsWithClass(state, 'cm-ink-blockquote')).toHaveLength(1)
  })

  it('reveals per line: only the caret line shows its marker', () => {
    const doc = '> one\n> two\n> three'
    const state = previewState(doc, 8) // caret inside "two"
    const hidden = hiddenRanges(state)
    expect(hidden).toContainEqual({ from: 0, to: 2 }) // line 1 hidden
    expect(hidden).toContainEqual({ from: 12, to: 14 }) // line 3 hidden
    const marks = decorationsWithClass(state, 'cm-ink-quote-mark')
    expect(marks).toHaveLength(1)
    expect(marks[0]).toMatchObject({ from: 6, to: 7 }) // line 2 revealed
  })

  it('hides nested >> markers as a unit', () => {
    const doc = '> outer\n>> nested\n\npara'
    const state = previewState(doc, doc.length)
    const hidden = hiddenRanges(state)
    expect(hidden).toContainEqual({ from: 0, to: 2 }) // `> `
    expect(hidden).toContainEqual({ from: 8, to: 9 }) // first `>` (no space follows)
    expect(hidden).toContainEqual({ from: 9, to: 11 }) // second `> `
  })

  it('keeps the gray mark styling when the caret is on the quote line', () => {
    const state = previewState('> quoted\n\npara', 3)
    expect(hiddenRanges(state)).toHaveLength(0)
    expect(decorationsWithClass(state, 'cm-ink-quote-mark')).toContainEqual(
      expect.objectContaining({ from: 0, to: 1 }),
    )
  })
})

describe('live preview: bare-URL autolinks', () => {
  it('chips a bare https URL with cm-ink-link and data-href', () => {
    const state = previewState('see https://example.com now', 0)
    const chips = decorationsTagged(state, 'autolink')
    expect(chips).toHaveLength(1)
    expect(chips[0]).toMatchObject({ from: 4, to: 23 })
    const spec = chips[0]!.deco.spec
    expect((spec['class'] as string).split(' ')).toContain('cm-ink-link')
    expect(spec['attributes']['data-href']).toBe('https://example.com')
  })

  it('keeps the chip active when the selection touches it (nothing is hidden)', () => {
    const state = previewState('see https://example.com now', 10)
    expect(decorationsTagged(state, 'autolink')).toHaveLength(1)
    expect(hiddenRanges(state)).toHaveLength(0)
  })

  it('does not double-chip the URL inside a markdown link or image', () => {
    const state = previewState('[t](https://x.dev) and ![a](https://x.dev/i.png)', 0)
    expect(decorationsTagged(state, 'autolink')).toHaveLength(0)
  })

  it('does not chip the URL of a reference definition', () => {
    // (`[^1]: …` is a footnote definition since the footnote extension —
    // a true LinkReference needs a non-caret label.)
    const state = previewState('[ref]: https://x.dev/note\n\npara', 29)
    expect(decorationsTagged(state, 'autolink')).toHaveLength(0)
  })
})
