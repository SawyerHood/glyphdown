// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import * as Y from 'yjs'
import { resolveAnchor, type Suggestion } from '@glyphdown/core'
import {
  applyTableOp,
  computeTableHandles,
  createSuggestMode,
  escapeCellText,
  glyphdownHighlighting,
  glyphdownMarkdown,
  glyphdownTheme,
  livePreview,
  parseTableGrid,
  splitTableRow,
  tableEditField,
} from '../src/index.ts'

beforeAll(() => {
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

const TABLE = '| Name | Age |\n| :--- | ---: |\n| ada | 36 |\n| bob | 41 |'
const DOC = `before\n\n${TABLE}\n\nafter`
const TABLE_FROM = 8

function mountView(doc: string, extra: unknown[] = []): EditorView {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  return new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.single(0),
      extensions: [glyphdownMarkdown(), glyphdownHighlighting(), glyphdownTheme, livePreview(), ...(extra as [])],
    }),
    parent,
  })
}

function clickCell(view: EditorView, row: number, col: number): HTMLElement {
  const table = view.dom.querySelector('table.cm-ink-table-rendered') as HTMLTableElement
  const tr = row === 0 ? table.tHead!.rows[0]! : table.tBodies[0]!.rows[row - 1]!
  const cell = tr.cells[col]!
  cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  return cell
}

function overlay(view: EditorView): HTMLTextAreaElement {
  return view.dom.querySelector('.cm-ink-table-cell-editor') as HTMLTextAreaElement
}

function typeInOverlay(ta: HTMLTextAreaElement, value: string): void {
  ta.value = value
  ta.setSelectionRange(value.length, value.length)
  ta.dispatchEvent(new Event('input', { bubbles: true }))
}

function key(ta: HTMLTextAreaElement, k: string, shift = false): void {
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey: shift, bubbles: true, cancelable: true }))
}

const sleep = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('splitTableRow', () => {
  it('splits on unescaped pipes, ignoring leading/trailing decorative pipes', () => {
    const cells = splitTableRow('| a | b\\|c | d |')
    expect(cells.map((c) => '| a | b\\|c | d |'.slice(c.from, c.to))).toEqual(['a', 'b\\|c', 'd'])
  })

  it('keeps interior empty cells', () => {
    const line = '| a |  | c |'
    const cells = splitTableRow(line)
    expect(cells).toHaveLength(3)
    expect(line.slice(cells[1]!.from, cells[1]!.to)).toBe('')
  })

  it('handles rows without a trailing pipe', () => {
    const line = '| a | b'
    const cells = splitTableRow(line)
    expect(cells.map((c) => line.slice(c.from, c.to))).toEqual(['a', 'b'])
  })
})

describe('parseTableGrid', () => {
  it('parses header, alignments, body rows, and offsets', () => {
    const grid = parseTableGrid(TABLE)!
    expect(grid.columns).toBe(2)
    expect(grid.aligns).toEqual(['left', 'right'])
    expect(grid.rows).toHaveLength(3) // header + 2 body
    const cell = grid.rows[1]![0]!
    expect(cell.text).toBe('ada')
    expect(TABLE.slice(cell.from, cell.to)).toBe('ada')
  })

  it('returns short rows as-is (the widget pads them)', () => {
    const grid = parseTableGrid('| a | b |\n| --- | --- |\n| only |')!
    expect(grid.columns).toBe(2)
    expect(grid.rows[1]).toHaveLength(1)
  })
})

describe('escapeCellText', () => {
  it('escapes bare pipes', () => {
    expect(escapeCellText('a|b')).toBe('a\\|b')
  })

  it('leaves already-escaped pipes alone', () => {
    expect(escapeCellText('a\\|b')).toBe('a\\|b')
  })

  it('escapes the pipe after an escaped backslash', () => {
    expect(escapeCellText('a\\\\|b')).toBe('a\\\\\\|b')
  })

  it('flattens newlines to spaces', () => {
    expect(escapeCellText('a\nb\r\nc')).toBe('a b c')
  })
})

describe('applyTableOp', () => {
  it('add-row appends an empty row, preserving existing lines exactly', () => {
    const next = applyTableOp(TABLE, { type: 'add-row' })!
    expect(next).toBe(`${TABLE}\n|   |   |`)
  })

  it('delete-row removes only that line', () => {
    const next = applyTableOp(TABLE, { type: 'delete-row', row: 1 })!
    expect(next).toBe('| Name | Age |\n| :--- | ---: |\n| bob | 41 |')
  })

  it('refuses deleting the header row', () => {
    expect(applyTableOp(TABLE, { type: 'delete-row', row: 0 })).toBeNull()
  })

  it('add-column extends every row and the delimiter (alignment preserved)', () => {
    const next = applyTableOp(TABLE, { type: 'add-column' })!
    expect(next).toBe('| Name | Age |  |\n| :--- | ---: | --- |\n| ada | 36 |  |\n| bob | 41 |  |')
  })

  it('delete-column drops the column everywhere, alignments included', () => {
    const next = applyTableOp(TABLE, { type: 'delete-column', col: 0 })!
    expect(next).toBe('| Age |\n| ---: |\n| 36 |\n| 41 |')
  })

  it('refuses deleting the last column', () => {
    expect(applyTableOp('| a |\n| --- |\n| x |', { type: 'delete-column', col: 0 })).toBeNull()
  })

  it('set-align rewrites only the delimiter row', () => {
    const next = applyTableOp(TABLE, { type: 'set-align', col: 0, align: 'center' })!
    expect(next).toBe('| Name | Age |\n| :---: | ---: |\n| ada | 36 |\n| bob | 41 |')
  })
})

// ---------------------------------------------------------------------------
// Overlay: open / commit / pipe escaping
// ---------------------------------------------------------------------------

describe('cell overlay (jsdom)', () => {
  it('opens over a clicked cell with the raw source, widget intact, selection parked', () => {
    const view = mountView(DOC)
    try {
      clickCell(view, 1, 0)
      const ta = overlay(view)
      expect(ta.style.display).toBe('block')
      expect(ta.value).toBe('ada')
      expect(document.activeElement).toBe(ta)
      expect(view.dom.querySelector('table.cm-ink-table-rendered')).toBeTruthy()
      // The doc selection did NOT enter the table source.
      expect(view.state.selection.main.head).toBe(0)
      expect(view.state.field(tableEditField)).toBe(TABLE_FROM)
    } finally {
      view.destroy()
    }
  })

  it('commits typing to the cell source range; widget stays rendered', () => {
    const view = mountView(DOC)
    try {
      clickCell(view, 1, 0)
      typeInOverlay(overlay(view), 'adable')
      expect(view.state.doc.toString()).toContain('| adable | 36 |')
      expect(view.dom.querySelector('table.cm-ink-table-rendered')).toBeTruthy()
      // Continue typing — ranges recompute per keystroke.
      typeInOverlay(overlay(view), 'adables')
      expect(view.state.doc.toString()).toContain('| adables | 36 |')
    } finally {
      view.destroy()
    }
  })

  it('keeps a just-typed trailing space in the overlay (it serializes as cell padding)', () => {
    const view = mountView(DOC)
    try {
      clickCell(view, 1, 0)
      typeInOverlay(overlay(view), 'ada ')
      // The doc stores the space as padding; the trimmed cell text is 'ada'…
      expect(view.state.doc.toString()).toContain('| ada  | 36 |')
      // …but the overlay must keep the user's trailing space mid-edit.
      expect(overlay(view).value).toBe('ada ')
      typeInOverlay(overlay(view), 'ada lovelace')
      expect(view.state.doc.toString()).toContain('| ada lovelace  | 36 |')
    } finally {
      view.destroy()
    }
  })

  it('commits edits to the header row too', () => {
    const view = mountView(DOC)
    try {
      clickCell(view, 0, 1)
      typeInOverlay(overlay(view), 'Years')
      expect(view.state.doc.toString()).toContain('| Name | Years |')
    } finally {
      view.destroy()
    }
  })

  it('escapes typed pipes on serialize (textarea mirrors the source)', () => {
    const view = mountView(DOC)
    try {
      clickCell(view, 1, 0)
      typeInOverlay(overlay(view), 'a|b')
      expect(overlay(view).value).toBe('a\\|b')
      expect(view.state.doc.toString()).toContain('| a\\|b | 36 |')
      // Still a 2-column table.
      const grid = parseTableGrid(view.state.doc.toString().slice(TABLE_FROM))!
      expect(grid.rows[1]).toHaveLength(2)
    } finally {
      view.destroy()
    }
  })

  it('editing an empty (padded) cell extends the short row first', async () => {
    const doc = 'para\n\n| a | b |\n| --- | --- |\n| only |'
    const view = mountView(doc)
    try {
      clickCell(view, 1, 1) // the padded cell
      await sleep()
      const ta = overlay(view)
      expect(ta.style.display).toBe('block')
      typeInOverlay(ta, 'filled')
      expect(view.state.doc.toString()).toContain('| only | filled  |')
    } finally {
      view.destroy()
    }
  })
})

// ---------------------------------------------------------------------------
// Internal horizontal scroll: the open overlay must track its cell, and the
// affordances/handles must re-anchor or hide. jsdom has no layout engine, so we
// install a controllable fake layout: the scroll box is a 200px-wide window onto
// 800px of content, and every cell's on-screen rect is its content-space rect
// shifted left by the box's scrollLeft (exactly what a real overflow box does).
// ---------------------------------------------------------------------------

const BOX = { left: 100, top: 50, width: 200, height: 120, content: 800 }
const CELL_W = 200
const CELL_H = 30

interface FakeLayout {
  setScrollLeft(value: number): void
}

/** Make scrollDOM, the table scroll box, and every cell report a deterministic
 *  geometry that depends on the box's scrollLeft. Returns a scroll setter that
 *  updates scrollLeft and fires the box's `scroll` event. */
function installFakeLayout(view: EditorView): FakeLayout {
  const scroller = view.scrollDOM
  scroller.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 400, bottom: 600, width: 400, height: 600, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
  Object.defineProperty(scroller, 'scrollLeft', { value: 0, writable: true, configurable: true })
  Object.defineProperty(scroller, 'scrollTop', { value: 0, writable: true, configurable: true })

  const box = view.dom.querySelector('.cm-ink-table-scroll') as HTMLElement
  let scrollLeft = 0
  Object.defineProperty(box, 'scrollLeft', {
    get: () => scrollLeft,
    set: (v: number) => {
      scrollLeft = v
    },
    configurable: true,
  })
  Object.defineProperty(box, 'clientWidth', { get: () => BOX.width, configurable: true })
  Object.defineProperty(box, 'clientHeight', { get: () => BOX.height, configurable: true })
  Object.defineProperty(box, 'scrollWidth', { get: () => BOX.content, configurable: true })
  box.getBoundingClientRect = () =>
    ({
      left: BOX.left,
      top: BOX.top,
      right: BOX.left + BOX.width,
      bottom: BOX.top + BOX.height,
      width: BOX.width,
      height: BOX.height,
      x: BOX.left,
      y: BOX.top,
      toJSON: () => ({}),
    }) as DOMRect

  const table = view.dom.querySelector('table.cm-ink-table-rendered') as HTMLElement
  // The table's content-space left edge is the box's left minus the scroll.
  const tableContentLeft = () => BOX.left - scrollLeft
  table.getBoundingClientRect = () =>
    ({
      left: tableContentLeft(),
      top: BOX.top,
      right: tableContentLeft() + BOX.content,
      bottom: BOX.top + CELL_H * 3,
      width: BOX.content,
      height: CELL_H * 3,
      x: tableContentLeft(),
      y: BOX.top,
      toJSON: () => ({}),
    }) as DOMRect

  // Every cell: column c spans [c*CELL_W, (c+1)*CELL_W) in content space, row r
  // spans [r*CELL_H, (r+1)*CELL_H). On-screen = content minus scrollLeft.
  for (const cell of view.dom.querySelectorAll('th, td')) {
    const el = cell as HTMLElement
    const tr = el.closest('tr')!
    const colIndex = Array.prototype.indexOf.call(tr.children, el)
    const isHeader = el.tagName === 'TH'
    const tbody = tr.parentElement!
    const rowIndex = isHeader ? 0 : 1 + Array.prototype.indexOf.call(tbody.children, tr)
    el.getBoundingClientRect = () => {
      const left = BOX.left + colIndex * CELL_W - scrollLeft
      const top = BOX.top + rowIndex * CELL_H
      return {
        left,
        top,
        right: left + CELL_W,
        bottom: top + CELL_H,
        width: CELL_W,
        height: CELL_H,
        x: left,
        y: top,
        toJSON: () => ({}),
      } as DOMRect
    }
  }

  return {
    setScrollLeft(value: number) {
      scrollLeft = value
      box.dispatchEvent(new Event('scroll', { bubbles: false }))
    },
  }
}

describe('overlay tracks the table internal horizontal scroll (jsdom)', () => {
  it('REGRESSION: the open cell editor follows its cell when the table scrolls horizontally', () => {
    const view = mountView(DOC)
    try {
      const layout = installFakeLayout(view)
      // Open the editor on row 1, col 1 ("36") — its column starts at content x
      // 200, so at scrollLeft 0 it sits at box.left + 200 = 300.
      clickCell(view, 1, 1)
      const ta = overlay(view)
      expect(ta.style.display).toBe('block')
      const leftBefore = parseFloat(ta.style.left)
      // The cell's on-screen left at scrollLeft 0, projected into scroller space.
      expect(leftBefore).toBeCloseTo(BOX.left + 1 * CELL_W, 0) // 300

      // Scroll the table internally by 150px. The cell now sits 150px to the
      // left; the textarea MUST follow it (the regression: it stayed put).
      layout.setScrollLeft(150)
      const leftAfter = parseFloat(ta.style.left)
      expect(leftBefore - leftAfter).toBeCloseTo(150, 0)
      // And it stays glued to the cell's live on-screen position.
      const cellLeftNow = (view.dom.querySelector('table.cm-ink-table-rendered') as HTMLTableElement).tBodies[0]!
        .rows[0]!.cells[1]!.getBoundingClientRect().left
      expect(parseFloat(ta.style.left)).toBeCloseTo(cellLeftNow, 0)
    } finally {
      view.destroy()
    }
  })

  it('REGRESSION: typing preserves the table internal scroll (no widget rebuild reset)', () => {
    const view = mountView(DOC)
    try {
      clickCell(view, 1, 0)
      // jsdom has no layout, so fake an internal horizontal scroll position on
      // the live box. A full widget rebuild on the next keystroke would replace
      // this element (scrollLeft → 0); updateDOM must re-render in place instead.
      const box = view.dom.querySelector('.cm-ink-table-scroll') as HTMLElement
      Object.defineProperty(box, 'scrollLeft', { value: 150, writable: true, configurable: true })

      typeInOverlay(overlay(view), 'adaX')
      expect(view.state.doc.toString()).toContain('| adaX | 36 |')

      // SAME box element, scroll position retained — so positionOverlay measures
      // the edited cell at its scrolled location, not its reset (far-right) one.
      const boxAfter = view.dom.querySelector('.cm-ink-table-scroll') as HTMLElement
      expect(boxAfter).toBe(box)
      expect(boxAfter.scrollLeft).toBe(150)
    } finally {
      view.destroy()
    }
  })

  it('re-anchors the add-row/add-col affordances on internal scroll', () => {
    const view = mountView(DOC)
    try {
      const layout = installFakeLayout(view)
      hoverCell(view, 1, 0)
      const addCol = uiButton(view, '.cm-ink-table-add-col')
      expect(addCol.style.display).toBe('block')
      // Add-col is pinned to the visible box's right edge regardless of scroll.
      const colLeftBefore = parseFloat(addCol.style.left)
      layout.setScrollLeft(150)
      expect(parseFloat(addCol.style.left)).toBeCloseTo(colLeftBefore, 0)
    } finally {
      view.destroy()
    }
  })
})

describe('handle placement on a scrolled table (jsdom)', () => {
  it('REGRESSION: the row handle stays at the visible box edge, not the scrolled-out table edge', () => {
    const view = mountView(DOC)
    try {
      const layout = installFakeLayout(view)
      // Scroll right, then hover a still-visible cell (col 0 at content x 0 is
      // now off-screen; hover col 0 in the leftmost VISIBLE position by first
      // scrolling only a little). Use scrollLeft 50 so col 0 is partly visible.
      layout.setScrollLeft(50)
      hoverCell(view, 1, 0)
      const rowHandle = uiButton(view, '.cm-ink-table-handle-row')
      expect(rowHandle.style.display).toBe('block')
      // The handle must sit just left of the VISIBLE box (≈ box.left - 22), NOT
      // at the table's full-content left edge (box.left - 50 - 22 = 28).
      const handleLeft = parseFloat(rowHandle.style.left)
      expect(handleLeft).toBeGreaterThan(BOX.left - 30)
      expect(handleLeft).toBeLessThan(BOX.left)
    } finally {
      view.destroy()
    }
  })

  it('hides the column handle when its column is scrolled out of the visible box', () => {
    const view = mountView(DOC)
    try {
      const layout = installFakeLayout(view)
      hoverCell(view, 1, 0) // col 0, content x [0,200)
      expect(uiButton(view, '.cm-ink-table-handle-col').style.display).toBe('block')
      // Scroll col 0 fully out of the 200px-wide box (its center is at x 100,
      // off-screen once scrollLeft > 100 + box.width? center on-screen = 100 +
      // box.left - scrollLeft; out of [box.left, box.right] when scrollLeft>200).
      layout.setScrollLeft(250)
      expect(uiButton(view, '.cm-ink-table-handle-col').style.display).toBe('none')
    } finally {
      view.destroy()
    }
  })
})

// ---------------------------------------------------------------------------
// Pure handle-placement helper (scrollLeft + visible box accounted for)
// ---------------------------------------------------------------------------

describe('computeTableHandles', () => {
  const base = {
    boxLeft: 100,
    boxTop: 50,
    boxWidth: 200,
    boxHeight: 120,
    cellWidth: 80,
    cellHeight: 30,
    hasRowHandle: true,
  }

  it('row handle pins just left of the visible box, never the scrolled-out table edge', () => {
    // Cell scrolled so its content left is far off-screen; the row handle must
    // still anchor to the box's left edge.
    const r = computeTableHandles({ ...base, cellLeft: -400, cellTop: 80 })
    expect(r.row.visible).toBe(true)
    expect(r.row.left).toBeCloseTo(base.boxLeft - 22, 0) // box.left - (20 + 2)
    expect(r.row.top).toBeCloseTo(80 + (base.cellHeight - 20) / 2, 0)
  })

  it('column handle centers on the hovered column above the box', () => {
    const r = computeTableHandles({ ...base, cellLeft: 140, cellTop: 80 })
    expect(r.col.visible).toBe(true)
    expect(r.col.left + 18 / 2).toBeCloseTo(140 + base.cellWidth / 2, 0)
    expect(r.col.top).toBeCloseTo(base.boxTop - 20, 0)
  })

  it('hides the column handle when the column center is outside the visible box', () => {
    // Cell scrolled left so its center (cellLeft + 40) is left of box.left.
    expect(computeTableHandles({ ...base, cellLeft: -60, cellTop: 80 }).col.visible).toBe(false)
    // Cell scrolled right so its center is right of box.right (300).
    expect(computeTableHandles({ ...base, cellLeft: 280, cellTop: 80 }).col.visible).toBe(false)
  })

  it('clamps the column handle to stay inside the box at the edges', () => {
    const r = computeTableHandles({ ...base, cellLeft: 95, cellTop: 80 })
    expect(r.col.left).toBeGreaterThanOrEqual(base.boxLeft)
    const r2 = computeTableHandles({ ...base, cellLeft: 215, cellTop: 80 })
    expect(r2.col.left + 18).toBeLessThanOrEqual(base.boxLeft + base.boxWidth)
  })

  it('no row handle for header rows', () => {
    const r = computeTableHandles({ ...base, cellLeft: 100, cellTop: 50, hasRowHandle: false })
    expect(r.row.visible).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Navigation: Tab / Enter / Esc / click-away
// ---------------------------------------------------------------------------

describe('overlay navigation (jsdom)', () => {
  it('Tab moves to the next cell, wrapping rows', () => {
    const view = mountView(DOC)
    try {
      clickCell(view, 0, 1) // header, last column
      key(overlay(view), 'Tab')
      expect(overlay(view).value).toBe('ada') // wrapped to row 1, col 0
      key(overlay(view), 'Tab')
      expect(overlay(view).value).toBe('36')
    } finally {
      view.destroy()
    }
  })

  it('Shift-Tab moves to the previous cell', () => {
    const view = mountView(DOC)
    try {
      clickCell(view, 1, 0)
      key(overlay(view), 'Tab', true)
      expect(overlay(view).value).toBe('Age')
    } finally {
      view.destroy()
    }
  })

  it('Enter moves down a row; on the last row it adds a row', () => {
    const view = mountView(DOC)
    try {
      clickCell(view, 1, 0)
      key(overlay(view), 'Enter')
      expect(overlay(view).value).toBe('bob')
      key(overlay(view), 'Enter') // last row: adds one
      expect(view.state.doc.toString()).toContain('| bob | 41 |\n|   |   |')
      expect(overlay(view).value).toBe('')
      typeInOverlay(overlay(view), 'carol')
      expect(view.state.doc.toString()).toContain('| carol  |   |')
    } finally {
      view.destroy()
    }
  })

  it('Esc closes the overlay and parks the caret just after the table', () => {
    const view = mountView(DOC)
    try {
      clickCell(view, 1, 0)
      key(overlay(view), 'Escape')
      expect(overlay(view).style.display).toBe('none')
      expect(view.state.field(tableEditField)).toBeNull()
      expect(view.state.selection.main.head).toBe(TABLE_FROM + TABLE.length + 1)
      // Selection is outside the table: the widget stays rendered.
      expect(view.dom.querySelector('table.cm-ink-table-rendered')).toBeTruthy()
    } finally {
      view.destroy()
    }
  })

  it('clicking elsewhere closes the overlay', () => {
    const view = mountView(DOC)
    try {
      clickCell(view, 1, 0)
      expect(overlay(view).style.display).toBe('block')
      view.contentDOM.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      expect(overlay(view).style.display).toBe('none')
      expect(view.state.field(tableEditField)).toBeNull()
    } finally {
      view.destroy()
    }
  })
})

// ---------------------------------------------------------------------------
// Structure affordances
// ---------------------------------------------------------------------------

function hoverCell(view: EditorView, row: number, col: number): HTMLElement {
  const table = view.dom.querySelector('table.cm-ink-table-rendered') as HTMLTableElement
  const tr = row === 0 ? table.tHead!.rows[0]! : table.tBodies[0]!.rows[row - 1]!
  const cell = tr.cells[col]!
  cell.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }))
  return cell
}

function uiButton(view: EditorView, cls: string): HTMLButtonElement {
  return view.dom.querySelector(cls) as HTMLButtonElement
}

function press(el: HTMLElement): void {
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
}

function menuItem(view: EditorView, action: string): HTMLButtonElement {
  return view.dom.querySelector(`[data-table-action="${action}"]`) as HTMLButtonElement
}

describe('structure affordances (jsdom)', () => {
  it('shows add-row/add-column and row/column handles on hover', () => {
    const view = mountView(DOC)
    try {
      hoverCell(view, 1, 0)
      expect(uiButton(view, '.cm-ink-table-add-row').style.display).toBe('block')
      expect(uiButton(view, '.cm-ink-table-add-col').style.display).toBe('block')
      expect(uiButton(view, '.cm-ink-table-handle-row').style.display).toBe('block')
      expect(uiButton(view, '.cm-ink-table-handle-col').style.display).toBe('block')
    } finally {
      view.destroy()
    }
  })

  it('header rows get no row handle', () => {
    const view = mountView(DOC)
    try {
      hoverCell(view, 1, 0)
      hoverCell(view, 0, 0)
      expect(uiButton(view, '.cm-ink-table-handle-row').style.display).toBe('none')
      expect(uiButton(view, '.cm-ink-table-handle-col').style.display).toBe('block')
    } finally {
      view.destroy()
    }
  })

  it('add-row button appends an empty row (one change)', () => {
    const view = mountView(DOC)
    try {
      hoverCell(view, 1, 0)
      press(uiButton(view, '.cm-ink-table-add-row'))
      expect(view.state.doc.toString()).toContain('| bob | 41 |\n|   |   |\n\nafter')
    } finally {
      view.destroy()
    }
  })

  it('add-column button extends rows and delimiter', () => {
    const view = mountView(DOC)
    try {
      hoverCell(view, 1, 0)
      press(uiButton(view, '.cm-ink-table-add-col'))
      expect(view.state.doc.toString()).toContain('| Name | Age |  |\n| :--- | ---: | --- |')
      // The new (all-empty) column renders — the delimiter row defines the
      // column count even though Lezer emits no cells for empty columns —
      // and its cells are editable.
      expect(view.dom.querySelectorAll('thead th')).toHaveLength(3)
      clickCell(view, 1, 2)
      typeInOverlay(overlay(view), 'new')
      expect(view.state.doc.toString()).toContain('| ada | 36 | new |')
    } finally {
      view.destroy()
    }
  })

  it('row menu deletes the hovered row', () => {
    const view = mountView(DOC)
    try {
      hoverCell(view, 1, 0)
      press(uiButton(view, '.cm-ink-table-handle-row'))
      press(menuItem(view, 'delete-row'))
      expect(view.state.doc.toString()).toContain('| :--- | ---: |\n| bob | 41 |')
      expect(view.state.doc.toString()).not.toContain('| ada |')
    } finally {
      view.destroy()
    }
  })

  it('column menu sets alignment (delimiter row rewritten, rows preserved)', () => {
    const view = mountView(DOC)
    try {
      hoverCell(view, 1, 1)
      press(uiButton(view, '.cm-ink-table-handle-col'))
      press(menuItem(view, 'align-center'))
      expect(view.state.doc.toString()).toContain('| Name | Age |\n| :--- | :---: |\n| ada | 36 |')
    } finally {
      view.destroy()
    }
  })

  it('column menu deletes the hovered column', () => {
    const view = mountView(DOC)
    try {
      hoverCell(view, 1, 1)
      press(uiButton(view, '.cm-ink-table-handle-col'))
      press(menuItem(view, 'delete-column'))
      expect(view.state.doc.toString()).toContain('| Name |\n| :--- |\n| ada |\n| bob |')
    } finally {
      view.destroy()
    }
  })

  it('read-only editors get no affordances on hover', () => {
    const view = mountView(DOC, [EditorState.readOnly.of(true), EditorView.editable.of(false)])
    try {
      hoverCell(view, 1, 0)
      expect(view.dom.querySelector('.cm-ink-table-add-row')).toBeNull()
      expect(view.dom.querySelector('.cm-ink-table-handle-row')).toBeNull()
    } finally {
      view.destroy()
    }
  })

  it('REGRESSION: affordances stay visible (re-anchored) after an add-row click', async () => {
    const view = mountView(DOC)
    try {
      hoverCell(view, 1, 0)
      press(uiButton(view, '.cm-ink-table-add-row'))
      expect(view.state.doc.toString()).toContain('|   |   |')
      // The doc change schedules a measure-phase refresh; the buttons must
      // survive it (the old code hid them on every docChanged, so repeated
      // clicks needed a mouse wiggle in between).
      await sleep(20)
      expect(uiButton(view, '.cm-ink-table-add-row').style.display).toBe('block')
      expect(uiButton(view, '.cm-ink-table-add-col').style.display).toBe('block')
      // And the second click still works.
      press(uiButton(view, '.cm-ink-table-add-row'))
      expect(view.state.doc.toString()).toContain('|   |   |\n|   |   |')
    } finally {
      view.destroy()
    }
  })

  it('REGRESSION: pointer crossing a foreign element en route to a handle does not hide the set', () => {
    const view = mountView(DOC)
    try {
      const layout = installFakeLayout(view)
      layout.setScrollLeft(0)
      hoverCell(view, 1, 0)
      expect(uiButton(view, '.cm-ink-table-handle-col').style.display).toBe('block')
      // The column handle floats ABOVE the widget, so the pointer's path to it
      // enters non-widget content. pointerover on foreign elements must not
      // hide (the old code did, killing the handle before it could be reached)…
      view.contentDOM.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }))
      // …and pointermove just outside the box but inside the margin keeps it.
      view.contentDOM.dispatchEvent(
        new MouseEvent('pointermove', { bubbles: true, clientX: BOX.left - 10, clientY: BOX.top - 15 }),
      )
      expect(uiButton(view, '.cm-ink-table-handle-col').style.display).toBe('block')
      expect(uiButton(view, '.cm-ink-table-add-row').style.display).toBe('block')
      // Moving truly away from the table hides the whole set.
      view.contentDOM.dispatchEvent(
        new MouseEvent('pointermove', { bubbles: true, clientX: BOX.left + 600, clientY: BOX.top + 400 }),
      )
      expect(uiButton(view, '.cm-ink-table-handle-col').style.display).toBe('none')
      expect(uiButton(view, '.cm-ink-table-add-row').style.display).toBe('none')
    } finally {
      view.destroy()
    }
  })
})

// ---------------------------------------------------------------------------
// Native selection inside the cell editor
// ---------------------------------------------------------------------------

describe('cell editor mouse interactions (jsdom)', () => {
  it('REGRESSION: mousedown inside the open overlay is not prevented (caret/drag-selection work)', () => {
    const view = mountView(DOC)
    try {
      clickCell(view, 1, 0)
      const ta = overlay(view)
      expect(ta.style.display).toBe('block')
      const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
      ta.dispatchEvent(down)
      // preventDefault on a textarea mousedown disables native caret placement
      // and drag selection — the overlay must leave it alone and stay open.
      expect(down.defaultPrevented).toBe(false)
      expect(ta.style.display).toBe('block')
      expect(view.state.field(tableEditField)).not.toBeNull()
    } finally {
      view.destroy()
    }
  })
})

// ---------------------------------------------------------------------------
// Remote edits mid-edit
// ---------------------------------------------------------------------------

describe('remote edits while the overlay is open (jsdom)', () => {
  it('re-anchors to the same logical cell when text is inserted above', () => {
    const view = mountView(DOC)
    try {
      clickCell(view, 1, 0)
      // A collaborator inserts a paragraph above the table.
      view.dispatch({ changes: { from: 0, to: 0, insert: 'remote paragraph\n\n' } })
      expect(view.state.field(tableEditField)).toBe(TABLE_FROM + 18)
      // The overlay still edits the same logical cell at its shifted range.
      typeInOverlay(overlay(view), 'ada2')
      expect(view.state.doc.toString()).toContain('| ada2 | 36 |')
      expect(view.state.doc.toString().startsWith('remote paragraph')).toBe(true)
    } finally {
      view.destroy()
    }
  })

  it('re-syncs the overlay value when a collaborator edits the same cell', () => {
    const view = mountView(DOC)
    try {
      clickCell(view, 1, 0)
      const adaAt = view.state.doc.toString().indexOf('ada')
      view.dispatch({ changes: { from: adaAt, to: adaAt + 3, insert: 'eve' } })
      expect(overlay(view).value).toBe('eve')
    } finally {
      view.destroy()
    }
  })

  it('closes gracefully when the edited cell disappears', async () => {
    const view = mountView(DOC)
    try {
      clickCell(view, 2, 0) // 'bob'
      // A collaborator deletes the last row.
      const doc = view.state.doc.toString()
      const rowAt = doc.indexOf('\n| bob')
      view.dispatch({ changes: { from: rowAt, to: rowAt + '\n| bob | 41 |'.length } })
      expect(overlay(view).style.display).toBe('none')
      await sleep()
      expect(view.state.field(tableEditField)).toBeNull()
    } finally {
      view.destroy()
    }
  })

  it('closes gracefully when the whole table is deleted', async () => {
    const view = mountView(DOC)
    try {
      clickCell(view, 1, 0)
      view.dispatch({ changes: { from: TABLE_FROM, to: TABLE_FROM + TABLE.length, insert: 'gone' } })
      expect(overlay(view).style.display).toBe('none')
      await sleep()
      expect(view.state.field(tableEditField)).toBeNull()
    } finally {
      view.destroy()
    }
  })
})

// ---------------------------------------------------------------------------
// Suggest mode: overlay edits route through the SuggestSession
// ---------------------------------------------------------------------------

describe('suggest mode capture (jsdom)', () => {
  function setupSuggest(doc: string) {
    const ydoc = new Y.Doc()
    const ytext = ydoc.getText('content')
    ytext.insert(0, doc)
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
    const view = mountView(doc, [mode.extension])
    const run = () => {
      while (tasks.length > 0) tasks.shift()!()
    }
    // Stand-in for the yCollab binding: echo ytext into the view as a
    // minimal diff (the real binding dispatches granular deltas).
    const echo = () => {
      const text = ytext.toString()
      const current = view.state.doc.toString()
      if (current === text) return
      let prefix = 0
      const max = Math.min(current.length, text.length)
      while (prefix < max && current[prefix] === text[prefix]) prefix++
      let suffix = 0
      while (suffix < max - prefix && current[current.length - 1 - suffix] === text[text.length - 1 - suffix]) suffix++
      view.dispatch({
        changes: { from: prefix, to: current.length - suffix, insert: text.slice(prefix, text.length - suffix) },
      })
    }
    return { ytext, view, run, echo, batches }
  }

  it('a cell edit lands in ytext as a suggested insertion (doc untouched until replay)', async () => {
    const { ytext, view, run, echo, batches } = setupSuggest(DOC)
    try {
      clickCell(view, 1, 0)
      typeInOverlay(overlay(view), 'adaX')
      // The transaction was canceled — nothing applied yet.
      expect(view.state.doc.toString()).toBe(DOC)
      run() // the session replays the edit into ytext
      expect(ytext.toString()).toContain('| adaX | 36 |')
      const records = batches.at(-1)!
      expect(records).toHaveLength(1)
      const part = records[0]!.parts[0]!
      expect(part.kind).toBe('insert')
      const range = resolveAnchor(ytext, part.anchor)!
      expect(ytext.toString().slice(range.start, range.end)).toBe('X')
      // The binding echo arrives; the widget must stay rendered and the
      // overlay re-anchored even though the session parked the cursor inside
      // the table source.
      echo()
      run()
      expect(view.dom.querySelector('table.cm-ink-table-rendered')).toBeTruthy()
      expect(overlay(view).style.display).toBe('block')
      expect(overlay(view).value).toBe('adaX')
    } finally {
      view.destroy()
    }
  })

  it('a structure op routes through the session as one suggestion', () => {
    const { ytext, view, run, batches } = setupSuggest(DOC)
    try {
      hoverCell(view, 1, 0)
      press(uiButton(view, '.cm-ink-table-add-row'))
      expect(view.state.doc.toString()).toBe(DOC) // canceled, queued
      run()
      expect(ytext.toString()).toContain('| bob | 41 |\n|   |   |')
      expect(batches.at(-1)).toHaveLength(1)
    } finally {
      view.destroy()
    }
  })
})
