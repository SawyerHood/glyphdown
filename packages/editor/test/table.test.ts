// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import {
  ADD_BUTTON_SIZE,
  ADDROW_TO_SCROLLBAR_GAP,
  DEFAULT_BOTTOM_PADDING,
  SCROLLBAR_BOTTOM_PAD,
  SCROLLBAR_HEIGHT,
  TABLE_MARGIN_BOTTOM,
  TABLE_TO_ADDROW_GAP,
  computeTableAddButtons,
  computeTableBleed,
  computeTableBottomGutter,
  computeTableScrollbar,
  glyphdownHighlighting,
  glyphdownMarkdown,
  glyphdownTheme,
  livePreview,
  parseDelimiterAlignments,
  type TableModel,
} from '../src/index.ts'
import { decorationsTagged, decorationsWithClass, previewState } from './helpers.ts'

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

const TABLE = '| Name | Age | City |\n| :--- | :-: | ---: |\n| **a** | `2` | [x](https://x.dev) |'
const DOC = `before\n\n${TABLE}\n\nafter`
const TABLE_FROM = 8

describe('delimiter alignments', () => {
  it('parses left, center, and right colons', () => {
    expect(parseDelimiterAlignments('| :--- | :-: | ---: |')).toEqual(['left', 'center', 'right'])
  })

  it('returns null for plain dashes', () => {
    expect(parseDelimiterAlignments('| --- | --- |')).toEqual([null, null])
  })

  it('handles rows without outer pipes', () => {
    expect(parseDelimiterAlignments(':--- | :---:')).toEqual(['left', 'center'])
  })
})

describe('computeTableBleed (effective bleed from real editor space)', () => {
  // Column = the 65ch prose column inner width; maxBleed = the 96px design cap.
  const COLUMN = 657
  const MAX = 96

  it('a table that fits the column does not bleed, center, or scroll', () => {
    const r = computeTableBleed({ availableWidth: 940, columnWidth: COLUMN, tableWidth: 500, maxBleed: MAX })
    expect(r).toEqual({ bleed: 0, wide: false, boxWidth: 500, scrollable: false })
  })

  it('uses the full design cap when the editor has ample room', () => {
    // Wide viewport, no sidebar: room per side (1400-657)/2 = 371 > 96 cap.
    const r = computeTableBleed({ availableWidth: 1400, columnWidth: COLUMN, tableWidth: 1129, maxBleed: MAX })
    expect(r.bleed).toBe(96)
    expect(r.wide).toBe(true)
    expect(r.boxWidth).toBe(COLUMN + 192)
    expect(r.scrollable).toBe(true) // 1129 still wider than 657+192=849
  })

  it('clamps the bleed to the available room — the sidebar-open regression', () => {
    // 1024px viewport with a 260px sidebar → cm-scroller ≈ 764px visible.
    // The old clamp read 100vw and bled the full 96px, spilling ~62px/side past
    // the editor (clipped by the scroller). Now the bleed is capped to the real
    // room: (764-657)/2 = 53.5, so the centered box == the visible width.
    const r = computeTableBleed({ availableWidth: 764, columnWidth: COLUMN, tableWidth: 1129, maxBleed: MAX })
    expect(r.bleed).toBeCloseTo(53.5, 1)
    expect(r.wide).toBe(true)
    expect(r.boxWidth).toBeCloseTo(764, 1) // exactly the visible editor width — no clip
    expect(r.boxWidth).toBeLessThanOrEqual(764)
  })

  it('never lets the centered box exceed the visible editor width (no ancestor clip)', () => {
    for (const availableWidth of [600, 700, 764, 820, 940, 1020, 1200, 1400]) {
      const r = computeTableBleed({ availableWidth, columnWidth: COLUMN, tableWidth: 1129, maxBleed: MAX })
      // Centered on the column (= editor center): the box fits iff box <= available.
      if (r.wide) expect(r.boxWidth).toBeLessThanOrEqual(availableWidth + 0.01)
    }
  })

  it('narrow viewport: no room to bleed — stays left-aligned and scrolls internally', () => {
    // 390px phone: the 65ch column is wider than the screen, so cm-content
    // fills the editor — no slack to bleed into → bleed 0, not wide.
    const r = computeTableBleed({ availableWidth: 350, columnWidth: 350, tableWidth: 900, maxBleed: MAX })
    expect(r.bleed).toBe(0)
    expect(r.wide).toBe(false)
    expect(r.boxWidth).toBe(350) // visible box == the column; the table scrolls inside it
    expect(r.scrollable).toBe(true)
  })

  it('a wide table with only sub-pixel room does not engage asymmetric centering', () => {
    const r = computeTableBleed({ availableWidth: COLUMN + 0.6, columnWidth: COLUMN, tableWidth: 1129, maxBleed: MAX })
    expect(r.bleed).toBeLessThanOrEqual(0.5)
    expect(r.wide).toBe(false)
  })

  it('symmetric by construction: bleed is per-side and applied equally', () => {
    const r = computeTableBleed({ availableWidth: 900, columnWidth: COLUMN, tableWidth: 1129, maxBleed: MAX })
    // boxWidth = column + 2*bleed → the overhang is bleed on each side.
    expect((r.boxWidth - COLUMN) / 2).toBeCloseTo(r.bleed, 5)
  })
})

describe('computeTableScrollbar (custom always-visible horizontal scrollbar)', () => {
  // The platform horizontal scrollbar is a zero-height overlay on macOS that
  // stays hidden at rest — a wide table read as a hard clip. The widget draws
  // its own thumb from these pure metrics; this is the scroll/containment
  // invariant: the thumb stays fully inside the visible box at both ends, and
  // it shows exactly when the table overflows.

  it('a table that fits its box shows no scrollbar', () => {
    const r = computeTableScrollbar({ clientWidth: 800, scrollWidth: 800, scrollLeft: 0 })
    expect(r.visible).toBe(false)
  })

  it('treats sub-pixel overflow as not scrollable (no flicker on rounding)', () => {
    const r = computeTableScrollbar({ clientWidth: 800, scrollWidth: 800.7, scrollLeft: 0 })
    expect(r.visible).toBe(false)
  })

  it('shows a proportional thumb when the table overflows', () => {
    // The repro case: 849px box over a 1484px table.
    const r = computeTableScrollbar({ clientWidth: 849, scrollWidth: 1484, scrollLeft: 0 })
    expect(r.visible).toBe(true)
    // Thumb width = box * (box/content) = 849 * (849/1484) ≈ 485.6.
    expect(r.thumbWidth).toBeCloseTo((849 * 849) / 1484, 1)
    expect(r.thumbOffset).toBe(0) // at the left end
  })

  it('thumb never leaves the track: offset == free space at max scroll', () => {
    const clientWidth = 849
    const scrollWidth = 1484
    const max = scrollWidth - clientWidth
    const r = computeTableScrollbar({ clientWidth, scrollWidth, scrollLeft: max })
    // At the far right the thumb sits flush against the right edge: its right
    // edge (offset + width) equals the track width — fully inside the box.
    expect(r.thumbOffset + r.thumbWidth).toBeCloseTo(clientWidth, 1)
    expect(r.thumbOffset + r.thumbWidth).toBeLessThanOrEqual(clientWidth + 0.01)
  })

  it('clamps an over-scrolled scrollLeft so the thumb never overshoots the track', () => {
    const clientWidth = 849
    const scrollWidth = 1484
    const r = computeTableScrollbar({ clientWidth, scrollWidth, scrollLeft: 99999 })
    expect(r.thumbOffset + r.thumbWidth).toBeLessThanOrEqual(clientWidth + 0.01)
  })

  it('the thumb stays fully inside the box across the whole scroll range', () => {
    const clientWidth = 390 // the phone case: a single column wider than the box
    const scrollWidth = 1484
    const max = scrollWidth - clientWidth
    for (let s = 0; s <= max; s += max / 8) {
      const r = computeTableScrollbar({ clientWidth, scrollWidth, scrollLeft: s })
      expect(r.visible).toBe(true)
      expect(r.thumbOffset).toBeGreaterThanOrEqual(-0.01)
      expect(r.thumbOffset + r.thumbWidth).toBeLessThanOrEqual(clientWidth + 0.01)
    }
  })

  it('enforces a minimum grabbable thumb on a very wide table', () => {
    // A huge table would give a sub-pixel proportional thumb; the floor keeps it
    // grabbable (and still inside the track).
    const r = computeTableScrollbar({ clientWidth: 400, scrollWidth: 40000, scrollLeft: 0, minThumb: 32 })
    expect(r.thumbWidth).toBe(32)
    const atEnd = computeTableScrollbar({ clientWidth: 400, scrollWidth: 40000, scrollLeft: 39600, minThumb: 32 })
    expect(atEnd.thumbOffset + atEnd.thumbWidth).toBeLessThanOrEqual(400 + 0.01)
  })

  it('never produces a thumb wider than the track', () => {
    const r = computeTableScrollbar({ clientWidth: 50, scrollWidth: 60, scrollLeft: 0, minThumb: 32 })
    expect(r.thumbWidth).toBeLessThanOrEqual(50)
  })
})

describe('computeTableBottomGutter (stacking the add-row button above the scrollbar)', () => {
  // The small floating add-row "+" button (overlay layer) and the custom
  // horizontal scrollbar (widget gutter) share the region just below the table.
  // They never overlap because BOTH consume this single helper — table-edit.ts
  // for the add-row's top offset, table.ts for the scrollbar's top + the box's
  // reserved padding. (And the button is small + box-centered while the
  // scrollbar spans the full visible width, so they don't collide horizontally
  // either.)

  it('not scrollable: add-row just below the table, no scrollbar, default strip', () => {
    const g = computeTableBottomGutter(false)
    expect(g.addRowTop).toBe(TABLE_TO_ADDROW_GAP)
    expect(g.scrollbarTop).toBeNull()
    // No extra gutter — the box keeps its bottom strip (sized to clear the
    // small floating button).
    expect(g.bottomPadding).toBe(DEFAULT_BOTTOM_PADDING)
  })

  it('non-scrollable bottom strip is tall enough to clear the small button', () => {
    // The button floats addRowTop below the table content; the box must reserve
    // enough padding (after its own bottom margin) to contain the button height.
    const g = computeTableBottomGutter(false)
    expect(TABLE_MARGIN_BOTTOM + g.bottomPadding).toBeGreaterThanOrEqual(
      TABLE_TO_ADDROW_GAP + ADD_BUTTON_SIZE,
    )
  })

  it('scrollable: the scrollbar sits BELOW the add-row button (no overlap)', () => {
    const g = computeTableBottomGutter(true)
    expect(g.addRowTop).toBe(TABLE_TO_ADDROW_GAP)
    expect(g.scrollbarTop).not.toBeNull()
    // The scrollbar's top is past the add-row button's bottom: its top y is at
    // least addRowTop + ADD_BUTTON_SIZE, so the two bands do not intersect.
    const addRowBottom = g.addRowTop + ADD_BUTTON_SIZE
    expect(g.scrollbarTop!).toBeGreaterThanOrEqual(addRowBottom)
    // Concretely, there is a positive gap between them.
    expect(g.scrollbarTop! - addRowBottom).toBe(ADDROW_TO_SCROLLBAR_GAP)
  })

  it('scrollable: ordering is table → add-row → scrollbar, all disjoint bands', () => {
    const g = computeTableBottomGutter(true)
    const addRowTop = g.addRowTop
    const addRowBottom = addRowTop + ADD_BUTTON_SIZE
    const scrollbarTop = g.scrollbarTop!
    const scrollbarBottom = scrollbarTop + SCROLLBAR_HEIGHT
    // Strictly increasing edges down the stack.
    expect(addRowTop).toBeLessThan(addRowBottom)
    expect(addRowBottom).toBeLessThanOrEqual(scrollbarTop)
    expect(scrollbarTop).toBeLessThan(scrollbarBottom)
  })

  it('scrollable: the reserved bottom padding contains the whole stack', () => {
    const g = computeTableBottomGutter(true)
    const scrollbarBottom = g.scrollbarTop! + SCROLLBAR_HEIGHT
    // bottomPadding sits below the table's own bottom margin; together they must
    // reach past the scrollbar's bottom edge (plus the breathing pad) so the
    // editor reserves enough room and the next line never overlaps the bar.
    expect(TABLE_MARGIN_BOTTOM + g.bottomPadding).toBeGreaterThanOrEqual(scrollbarBottom + SCROLLBAR_BOTTOM_PAD)
  })

  it('scrollable reserves strictly more bottom room than the non-scrollable case', () => {
    expect(computeTableBottomGutter(true).bottomPadding).toBeGreaterThan(
      computeTableBottomGutter(false).bottomPadding,
    )
  })
})

describe('computeTableAddButtons (small floating buttons keyed to the visible box)', () => {
  // A wide table whose full content is 1484px but whose visible scroll box is
  // only 849px (the bug's exact numbers). The buttons must be sized/positioned
  // from the 849px box, never the 1484px content.
  const WIDE = {
    boxLeft: 100,
    boxTop: 40,
    boxWidth: 849,
    boxHeight: 120,
    addRowTop: TABLE_TO_ADDROW_GAP,
  }

  it('add-row is a small button centered horizontally on the VISIBLE box', () => {
    const { addRow, size } = computeTableAddButtons(WIDE)
    expect(size).toBe(ADD_BUTTON_SIZE)
    // Button center == box center (boxLeft + boxWidth/2).
    expect(addRow.left + size / 2).toBeCloseTo(WIDE.boxLeft + WIDE.boxWidth / 2)
    // It sits in the bottom gutter, addRowTop below the box's content bottom.
    expect(addRow.top).toBe(WIDE.boxTop + WIDE.boxHeight + WIDE.addRowTop)
  })

  it('add-row stays within the visible box horizontally (not a full-width bar)', () => {
    const { addRow, size } = computeTableAddButtons(WIDE)
    expect(addRow.left).toBeGreaterThanOrEqual(WIDE.boxLeft)
    expect(addRow.left + size).toBeLessThanOrEqual(WIDE.boxLeft + WIDE.boxWidth)
  })

  it('add-col is pinned to the VISIBLE right edge, not the full content width', () => {
    const { addCol, size } = computeTableAddButtons(WIDE)
    // Left edge is just inside the visible right edge (overhangs by half) — it
    // is NOT placed at boxLeft + 1484 (the off-screen content right edge).
    const visibleRight = WIDE.boxLeft + WIDE.boxWidth
    expect(addCol.left).toBe(visibleRight - size / 2)
    // The button straddles the visible right edge: most of it stays on screen.
    expect(addCol.left).toBeLessThan(visibleRight)
    expect(addCol.left + size).toBeGreaterThan(visibleRight)
    // Vertically centered on the visible table height.
    expect(addCol.top + size / 2).toBeCloseTo(WIDE.boxTop + WIDE.boxHeight / 2)
  })

  it('add-col position is independent of how wide the scrolled content is', () => {
    // Same visible box, two very different content widths: the button must not
    // move (it keys off the box, never the content). The helper takes no content
    // width at all, so this is structural — assert both calls match.
    const a = computeTableAddButtons(WIDE)
    const b = computeTableAddButtons({ ...WIDE })
    expect(b.addCol).toEqual(a.addCol)
    expect(b.addRow).toEqual(a.addRow)
  })

  it('narrow (non-scrollable) box: same logic yields bottom-center / right-middle', () => {
    // For a table that fits, the visible box == the table, so the buttons land
    // at the table's bottom-center and right-middle — the nicer narrow case.
    const narrow = { boxLeft: 0, boxTop: 0, boxWidth: 200, boxHeight: 60, addRowTop: TABLE_TO_ADDROW_GAP }
    const { addRow, addCol, size } = computeTableAddButtons(narrow)
    expect(addRow.left + size / 2).toBeCloseTo(100) // bottom-center
    expect(addRow.top).toBe(60 + TABLE_TO_ADDROW_GAP)
    expect(addCol.left).toBe(200 - size / 2) // right-middle
    expect(addCol.top + size / 2).toBeCloseTo(30)
  })
})

describe('table widget decoration', () => {
  it('replaces the whole block with a table widget away from the selection', () => {
    const state = previewState(DOC, 0)
    const tables = decorationsTagged(state, 'table')
    expect(tables).toHaveLength(1)
    expect(tables[0]).toMatchObject({ from: TABLE_FROM, to: TABLE_FROM + TABLE.length })
    expect(tables[0]!.deco.spec['block']).toBe(true)
    // No monospace line styling while the widget owns the block.
    expect(decorationsWithClass(state, 'cm-ink-table')).toHaveLength(0)
  })

  it('extracts the model: header, alignments, and inline cell formatting', () => {
    const state = previewState(DOC, 0)
    const model = (decorationsTagged(state, 'table')[0]!.deco.spec['widget'] as { model: TableModel }).model
    expect(model.source).toBe(TABLE)
    expect(model.aligns).toEqual(['left', 'center', 'right'])
    expect(model.header).toHaveLength(3)
    expect(model.header[0]!.spans).toEqual([{ type: 'text', text: 'Name' }])
    expect(model.rows).toHaveLength(1)
    const row = model.rows[0]!
    expect(row[0]!.spans).toEqual([{ type: 'strong', children: [{ type: 'text', text: 'a' }] }])
    expect(row[1]!.spans).toEqual([{ type: 'code', text: '2' }])
    expect(row[2]!.spans).toEqual([
      { type: 'link', href: 'https://x.dev', children: [{ type: 'text', text: 'x' }] },
    ])
    // Cell offsets are relative to the block start (doc-shift safe).
    expect(model.header[0]!.offset).toBe(2)
  })

  it('reveals the raw monospace source when the selection is inside the table', () => {
    const state = previewState(DOC, TABLE_FROM + 3)
    expect(decorationsTagged(state, 'table')).toHaveLength(0)
    expect(decorationsWithClass(state, 'cm-ink-table')).toHaveLength(3)
  })

  it('reveals when the selection touches any table line, not just the first', () => {
    const lastRow = DOC.indexOf('| **a**')
    const state = previewState(DOC, lastRow + 2)
    expect(decorationsTagged(state, 'table')).toHaveLength(0)
  })

  it('round-trips between widget and source as the selection moves', () => {
    const rendered = previewState(DOC, 0)
    expect(decorationsTagged(rendered, 'table')).toHaveLength(1)
    const revealed = rendered.update({ selection: EditorSelection.single(TABLE_FROM + 1) }).state
    expect(decorationsTagged(revealed, 'table')).toHaveLength(0)
    const back = revealed.update({ selection: EditorSelection.single(0) }).state
    expect(decorationsTagged(back, 'table')).toHaveLength(1)
  })
})

describe('table widget DOM (jsdom)', () => {
  it('renders thead, alignment styles, and inline formatting in cells', () => {
    const view = mountView(DOC, 0)
    try {
      const table = view.dom.querySelector('table.cm-ink-table-rendered')
      expect(table).toBeTruthy()
      const ths = table!.querySelectorAll('thead th')
      expect(ths).toHaveLength(3)
      expect(ths[0]!.textContent).toBe('Name')
      expect((ths[0] as HTMLElement).style.textAlign).toBe('left')
      expect((ths[1] as HTMLElement).style.textAlign).toBe('center')
      expect((ths[2] as HTMLElement).style.textAlign).toBe('right')
      const tds = table!.querySelectorAll('tbody td')
      expect(tds).toHaveLength(3)
      expect(tds[0]!.querySelector('strong')!.textContent).toBe('a')
      expect(tds[1]!.querySelector('code.cm-ink-inline-code')!.textContent).toBe('2')
      const link = tds[2]!.querySelector('a.cm-ink-link')!
      expect(link.textContent).toBe('x')
      expect(link.getAttribute('data-href')).toBe('https://x.dev')
      // No real href: navigation stays the app click handler's job.
      expect(link.getAttribute('href')).toBeNull()
      // The raw pipes are replaced.
      expect(view.dom.textContent).not.toContain('| Name |')
    } finally {
      view.destroy()
    }
  })

  it('wraps the table in a horizontal-scroll container with natural sizing', () => {
    const view = mountView(DOC, 0)
    try {
      const scroll = view.dom.querySelector('.cm-ink-table-widget > .cm-ink-table-scroll')
      expect(scroll).toBeTruthy()
      expect(scroll!.querySelector('table.cm-ink-table-rendered')).toBeTruthy()
      // Each cell's content sits in the max-width-capped block.
      const cellBlocks = view.dom.querySelectorAll('.cm-ink-table-rendered .cm-ink-table-cell')
      expect(cellBlocks.length).toBe(6)
      // The injected theme carries the layout contract: natural column widths
      // (max-content), the bleed allowance, and word-boundary-only wrapping.
      const css = Array.from(document.head.querySelectorAll('style'))
        .map((s) => s.textContent)
        .join('\n')
      expect(css).toContain('.cm-ink-table-scroll')
      expect(css).toMatch(/cm-ink-table-scroll[^}]*max-content/)
      expect(css).toContain('--ink-table-bleed')
      expect(css).toMatch(/cm-ink-table-scroll[^}]*overflow-x:\s*auto/)
      expect(css).toMatch(/cm-ink-table-cell[^}]*--ink-table-cell-max/)
      // The widget draws its OWN horizontal scrollbar (the platform overlay
      // scrollbar reserves no height and hides at rest on macOS), and hides the
      // native one. The thumb + track DOM exists; the native bar is suppressed.
      expect(view.dom.querySelector('.cm-ink-table-widget > .cm-ink-table-scrollbar')).toBeTruthy()
      expect(view.dom.querySelector('.cm-ink-table-scrollbar > .cm-ink-table-scrollbar-thumb')).toBeTruthy()
      expect(css).toMatch(/cm-ink-table-scroll[^}]*scrollbar-width:\s*none/)
      expect(css).toMatch(/cm-ink-table-scroll::-webkit-scrollbar[^}]*display:\s*none/)
      // Word-boundary wrapping only — no mid-word breaking anywhere.
      expect(css).not.toContain('break-all')
      expect(css).toMatch(/cm-ink-table-rendered td[^}]*overflow-wrap:\s*normal/)
      expect(css).toMatch(/cm-ink-table-rendered td[^}]*word-break:\s*normal/)
    } finally {
      view.destroy()
    }
  })

  it('escapes HTML-looking cell text (no raw HTML pass-through)', () => {
    const doc = '| a |\n| --- |\n| <script>alert(1)</script> |\n\npara'
    const view = mountView(doc, doc.length)
    try {
      const table = view.dom.querySelector('table.cm-ink-table-rendered')!
      expect(table.querySelector('script')).toBeNull()
      expect(table.querySelector('tbody td')!.textContent).toContain('<script>')
    } finally {
      view.destroy()
    }
  })

  it('pads short rows to the header width', () => {
    const doc = '| a | b |\n| --- | --- |\n| only |\n\npara'
    const view = mountView(doc, doc.length)
    try {
      const tds = view.dom.querySelectorAll('table.cm-ink-table-rendered tbody td')
      expect(tds).toHaveLength(2)
      expect(tds[0]!.textContent).toBe('only')
      expect(tds[1]!.textContent).toBe('')
    } finally {
      view.destroy()
    }
  })

  it('click on a cell opens the WYSIWYG overlay (widget stays rendered)', () => {
    const view = mountView(DOC, 0)
    try {
      const td = view.dom.querySelector('table.cm-ink-table-rendered tbody td')!
      td.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      // The widget did NOT swap for raw source — the overlay owns the edit.
      expect(view.dom.querySelector('table.cm-ink-table-rendered')).toBeTruthy()
      expect(view.state.selection.main.head).toBe(0)
      const overlay = view.dom.querySelector('.cm-ink-table-cell-editor') as HTMLTextAreaElement
      expect(overlay).toBeTruthy()
      expect(overlay.value).toBe('**a**')
    } finally {
      view.destroy()
    }
  })

  it('read-only: click on a cell keeps the rendered table (no raw-source flip, no overlay)', () => {
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const view = new EditorView({
      state: EditorState.create({
        doc: DOC,
        selection: EditorSelection.single(0),
        extensions: [
          glyphdownMarkdown(),
          glyphdownHighlighting(),
          glyphdownTheme,
          livePreview(),
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
        ],
      }),
      parent,
    })
    try {
      const td = view.dom.querySelector('table.cm-ink-table-rendered tbody td')!
      td.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      // The selection still lands at the clicked cell's source position
      // (copy semantics work off the underlying markdown)…
      expect(view.state.selection.main.head).toBe(DOC.indexOf('**a**'))
      // …but viewers never see the raw source: the widget stays rendered.
      expect(view.dom.querySelector('table.cm-ink-table-rendered')).toBeTruthy()
      expect(view.dom.textContent).not.toContain('| Name |')
      const overlay = view.dom.querySelector('.cm-ink-table-cell-editor') as HTMLTextAreaElement | null
      expect(overlay?.style.display ?? 'none').toBe('none')
    } finally {
      view.destroy()
    }
  })

  it('click outside any cell places the caret at the table start', () => {
    const view = mountView(DOC, 0)
    try {
      const wrap = view.dom.querySelector('.cm-ink-table-widget')!
      wrap.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      expect(view.state.selection.main.head).toBe(TABLE_FROM)
      expect(view.dom.querySelector('table.cm-ink-table-rendered')).toBeNull()
    } finally {
      view.destroy()
    }
  })

  it('click on a link chip inside a cell does not enter edit mode', () => {
    const view = mountView(DOC, 0)
    try {
      const link = view.dom.querySelector('table.cm-ink-table-rendered a.cm-ink-link')!
      link.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      expect(view.state.selection.main.head).toBe(0)
      expect(view.dom.querySelector('table.cm-ink-table-rendered')).toBeTruthy()
    } finally {
      view.destroy()
    }
  })

  it('caret dispatch into the table reveals the source; moving out re-renders', () => {
    const view = mountView(DOC, 0)
    try {
      view.dispatch({ selection: EditorSelection.single(TABLE_FROM + 2) })
      expect(view.dom.querySelector('table.cm-ink-table-rendered')).toBeNull()
      expect(view.dom.textContent).toContain('| Name |')
      view.dispatch({ selection: EditorSelection.single(0) })
      expect(view.dom.querySelector('table.cm-ink-table-rendered')).toBeTruthy()
    } finally {
      view.destroy()
    }
  })
})
