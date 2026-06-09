import { type EditorState, type Extension, StateEffect, StateField } from '@codemirror/state'
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import {
  type TableAlign,
  computeTableAddButtons,
  computeTableBottomGutter,
  computeTableHandles,
  parseDelimiterAlignments,
} from './table.ts'

// ---------------------------------------------------------------------------
// WYSIWYG table editing on top of the rendered-table widget.
//
// Editing model (v1): clicking a cell positions a floating <textarea> overlay
// exactly over that cell. The overlay lives OUTSIDE the widget DOM (appended
// to the editor's scroller), so widget rebuilds underneath never steal focus.
// It shows the cell's RAW source span (`**bold** text`) — raw-in-cell editing
// is the v1 contract. Every input commits a minimal diff of the cell's source
// range, recomputed per keystroke from the current document — which makes
// collab merge naturally and lets suggest mode capture the edits through its
// transactionFilter unchanged.
//
// While the overlay is open the underlying widget must stay rendered even if
// the document selection drifts into the table source (suggest mode parks the
// cursor at its last replayed edit): tableEditField pins the edited table and
// live-preview's Table case keeps the widget for it regardless of selection.
//
// Structure ops (add/delete row/column, alignment) regenerate the table's
// source from the parsed grid and dispatch ONE minimal replace of the block —
// a single undo step that suggest mode captures like any other edit.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Text-level table grid (offsets, not just content — the Lezer cell model
// skips empty cells, which editing must address uniformly)
// ---------------------------------------------------------------------------

export interface TableCellSlice {
  /** Trimmed cell content range, relative to the table source start. */
  from: number
  to: number
  text: string
}

export interface TableLineSlice {
  from: number
  to: number
  text: string
}

export interface TableGrid {
  /** Column count: the widest row wins (the widget pads short rows). */
  columns: number
  aligns: TableAlign[]
  /** rows[0] is the header; rows[1..] are body rows (delimiter excluded). */
  rows: TableCellSlice[][]
  /** Every physical line of the table, delimiter included (line surgery). */
  lines: TableLineSlice[]
}

/**
 * Splits one table row into trimmed cell ranges on unescaped `|` characters
 * (GFM: `\|` never splits, even inside code spans). Leading/trailing pipes
 * are decorative; interior empty segments are real empty cells.
 */
export function splitTableRow(line: string): { from: number; to: number }[] {
  const pipes: number[] = []
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '\\') {
      i++
      continue
    }
    if (ch === '|') pipes.push(i)
  }
  const bounds = [-1, ...pipes, line.length]
  const segments: { from: number; to: number }[] = []
  for (let k = 0; k + 1 < bounds.length; k++) {
    segments.push({ from: bounds[k]! + 1, to: bounds[k + 1]! })
  }
  const blank = (s: { from: number; to: number }) => line.slice(s.from, s.to).trim() === ''
  if (pipes.length > 0 && segments.length > 0 && blank(segments[0]!)) segments.shift()
  if (pipes.length > 0 && segments.length > 0 && blank(segments[segments.length - 1]!)) {
    // Only an actual trailing pipe ends the row; `| a` keeps its last cell.
    if (bounds[bounds.length - 2]! === pipes[pipes.length - 1]!) segments.pop()
  }
  return segments.map((seg) => {
    const raw = line.slice(seg.from, seg.to)
    const lead = raw.length - raw.trimStart().length
    const trail = raw.length - raw.trimEnd().length
    if (lead + trail >= raw.length) {
      // Empty cell: a collapsed insertion point just inside the padding.
      const at = Math.min(seg.from + Math.min(lead, 1), seg.to)
      return { from: at, to: at }
    }
    return { from: seg.from + lead, to: seg.to - trail }
  })
}

/** Parses a GFM table's source text into a grid of cell slices. */
export function parseTableGrid(source: string): TableGrid | null {
  const texts = source.split('\n')
  if (texts.length < 2) return null
  let off = 0
  const lines: TableLineSlice[] = texts.map((text) => {
    const slice = { from: off, to: off + text.length, text }
    off += text.length + 1
    return slice
  })
  const cellsOf = (line: TableLineSlice): TableCellSlice[] =>
    splitTableRow(line.text).map((r) => ({
      from: line.from + r.from,
      to: line.from + r.to,
      text: line.text.slice(r.from, r.to),
    }))
  const header = cellsOf(lines[0]!)
  if (header.length === 0) return null
  const aligns = parseDelimiterAlignments(texts[1]!)
  const body = lines.slice(2).map(cellsOf)
  const columns = Math.max(header.length, aligns.length, ...body.map((r) => r.length), 1)
  return { columns, aligns, rows: [header, ...body], lines }
}

/**
 * Serializes display text into a cell's source: newlines flatten to spaces
 * (a cell is one line) and bare `|` characters get escaped — already-escaped
 * sequences (`\|`, `\\`) pass through untouched.
 */
export function escapeCellText(text: string): string {
  return text.replace(/\r\n?|\n/g, ' ').replace(/\\[\s\S]|\|/g, (m) => (m === '|' ? '\\|' : m))
}

// ---------------------------------------------------------------------------
// Structure ops: parsed grid -> regenerated table source
// ---------------------------------------------------------------------------

export type TableOp =
  | { type: 'add-row' }
  | { type: 'add-column' }
  | { type: 'delete-row'; row: number } // grid row index (>= 1: body rows only)
  | { type: 'delete-column'; col: number }
  | { type: 'set-align'; col: number; align: TableAlign }

function alignMarker(align: TableAlign): string {
  switch (align) {
    case 'left':
      return ':---'
    case 'center':
      return ':---:'
    case 'right':
      return '---:'
    default:
      return '---'
  }
}

function delimiterLine(aligns: TableAlign[]): string {
  return `| ${aligns.map(alignMarker).join(' | ')} |`
}

function rebuildLine(cells: string[]): string {
  return `| ${cells.join(' | ')} |`
}

function emptyRowLine(columns: number): string {
  return `|${Array<string>(columns).fill('   ').join('|')}|`
}

/**
 * Applies one structure op to a table's source text, returning the
 * regenerated source (or null when the op is invalid, e.g. deleting the last
 * column). Row ops splice whole lines so untouched rows keep their exact
 * written form; column ops rebuild every line from the parsed cells (the
 * delimiter from the parsed alignments, so alignment survives).
 */
export function applyTableOp(source: string, op: TableOp): string | null {
  const grid = parseTableGrid(source)
  if (!grid) return null
  const lines = grid.lines.map((l) => l.text)
  const paddedAligns = (): TableAlign[] => {
    const out: TableAlign[] = []
    for (let i = 0; i < grid.columns; i++) out.push(grid.aligns[i] ?? null)
    return out
  }
  const rowTexts = (lineIndex: number): string[] => {
    const row = grid.rows[lineIndex === 0 ? 0 : lineIndex - 1] ?? []
    const out: string[] = []
    for (let i = 0; i < grid.columns; i++) out.push(row[i]?.text ?? '')
    return out
  }
  switch (op.type) {
    case 'add-row':
      return `${source}\n${emptyRowLine(grid.columns)}`
    case 'delete-row': {
      if (op.row < 1 || op.row >= grid.rows.length) return null
      lines.splice(op.row + 1, 1)
      return lines.join('\n')
    }
    case 'add-column': {
      const aligns = [...paddedAligns(), null]
      return lines.map((_, i) => (i === 1 ? delimiterLine(aligns) : rebuildLine([...rowTexts(i), '']))).join('\n')
    }
    case 'delete-column': {
      if (grid.columns <= 1 || op.col < 0 || op.col >= grid.columns) return null
      const aligns = paddedAligns()
      aligns.splice(op.col, 1)
      return lines
        .map((_, i) => {
          if (i === 1) return delimiterLine(aligns)
          const texts = rowTexts(i)
          texts.splice(op.col, 1)
          return rebuildLine(texts)
        })
        .join('\n')
    }
    case 'set-align': {
      if (op.col < 0 || op.col >= grid.columns) return null
      const aligns = paddedAligns()
      aligns[op.col] = op.align
      lines[1] = delimiterLine(aligns)
      return lines.join('\n')
    }
  }
}

/** Minimal single-range change turning `oldText` into `newText` at `base`. */
export function diffReplace(
  base: number,
  oldText: string,
  newText: string,
): { from: number; to: number; insert: string } {
  const max = Math.min(oldText.length, newText.length)
  let prefix = 0
  while (prefix < max && oldText[prefix] === newText[prefix]) prefix++
  let suffix = 0
  while (suffix < max - prefix && oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]) {
    suffix++
  }
  return {
    from: base + prefix,
    to: base + oldText.length - suffix,
    insert: newText.slice(prefix, newText.length - suffix),
  }
}

// ---------------------------------------------------------------------------
// The pinned-table field: while a cell overlay is open, the edited table's
// widget must stay rendered even when the doc selection drifts into its
// source (live-preview's Table case consults this field).
// ---------------------------------------------------------------------------

export const setTableEditEffect = StateEffect.define<number | null>({
  map: (value, mapping) => (value === null ? null : mapping.mapPos(value, 1)),
})

/** Doc position of the table being WYSIWYG-edited (null when no overlay). */
export const tableEditField = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    if (value !== null && tr.docChanged) value = tr.changes.mapPos(value, 1)
    for (const effect of tr.effects) {
      if (effect.is(setTableEditEffect)) value = effect.value
    }
    return value
  },
})

// ---------------------------------------------------------------------------
// Doc/DOM resolution helpers
// ---------------------------------------------------------------------------

interface ResolvedTable {
  from: number
  to: number
  grid: TableGrid
}

/** The Table node on (or spanning) the line at `pos`. */
export function findTableAt(state: EditorState, pos: number): { from: number; to: number } | null {
  if (pos < 0 || pos > state.doc.length) return null
  const line = state.doc.lineAt(pos)
  let found: { from: number; to: number } | null = null
  syntaxTree(state).iterate({
    from: line.from,
    to: line.to,
    enter: (node) => {
      if (found) return false
      if (node.name === 'Table') {
        found = { from: node.from, to: node.to }
        return false
      }
      return true
    },
  })
  return found
}

function resolveTable(state: EditorState, pos: number): ResolvedTable | null {
  const table = findTableAt(state, pos)
  if (!table) return null
  const grid = parseTableGrid(state.doc.sliceString(table.from, table.to))
  return grid ? { from: table.from, to: table.to, grid } : null
}

/** Logical (row, col) of a rendered cell element; row 0 is the header. */
function cellCoords(cellEl: HTMLElement): { row: number; col: number } | null {
  const tr = cellEl.closest('tr')
  if (!tr) return null
  const col = Array.prototype.indexOf.call(tr.children, cellEl)
  if (col < 0) return null
  if (cellEl.tagName === 'TH') return { row: 0, col }
  const tbody = tr.parentElement
  if (!tbody) return null
  const bodyIndex = Array.prototype.indexOf.call(tbody.children, tr)
  return bodyIndex < 0 ? null : { row: 1 + bodyIndex, col }
}

/** The rendered cell element at logical (row, col) inside a table widget —
 *  the inverse of cellCoords. Cell edits re-render the rows in place
 *  (populateTable replaces thead/tbody), so holding a cell ELEMENT across a
 *  doc change is never safe; re-resolve through this instead. */
function cellIn(wrap: HTMLElement, row: number, col: number): HTMLElement | null {
  const table = wrap.querySelector('table.cm-ink-table-rendered')
  if (!(table instanceof HTMLTableElement)) return null
  const tr = row === 0 ? table.tHead?.rows[0] : table.tBodies[0]?.rows[row - 1]
  return tr?.cells[col] ?? null
}

/**
 * Best-effort caret index for opening the cell editor at the clicked spot.
 * The textarea shows the cell's RAW source; when the rendered cell text equals
 * that source (the common unstyled cell) the clicked character offset maps
 * 1:1, so resolve it with the browser's caret-from-point API. Styled cells
 * (markup differs from rendered text) and engines without the API fall back
 * to null (caret-at-end).
 */
function caretIndexIn(cellEl: HTMLElement, x: number, y: number, rawText: string | undefined): number | null {
  if (rawText === undefined) return null
  const content = cellEl.querySelector('.cm-ink-table-cell')
  if (!(content instanceof HTMLElement) || content.textContent !== rawText) return null
  const doc = cellEl.ownerDocument
  let node: Node | null = null
  let offset = 0
  const withCaretApis = doc as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
    caretRangeFromPoint?: (x: number, y: number) => Range | null
  }
  if (typeof withCaretApis.caretPositionFromPoint === 'function') {
    const at = withCaretApis.caretPositionFromPoint(x, y)
    if (at) {
      node = at.offsetNode
      offset = at.offset
    }
  } else if (typeof withCaretApis.caretRangeFromPoint === 'function') {
    const range = withCaretApis.caretRangeFromPoint(x, y)
    if (range) {
      node = range.startContainer
      offset = range.startOffset
    }
  }
  if (!node || !content.contains(node)) return null
  // Character count from the cell content's start to (node, offset).
  const walker = doc.createTreeWalker(content, NodeFilter.SHOW_TEXT)
  let count = 0
  while (walker.nextNode()) {
    const text = walker.currentNode
    if (text === node) return count + offset
    count += text.textContent?.length ?? 0
  }
  return null
}

// ---------------------------------------------------------------------------
// The view plugin: overlay + structure affordances
//
// Affordance lifecycle (the part that must not be event-fragile): the handles
// and add buttons sit ON or OUTSIDE the widget's edges (the ⋯ column handle
// floats above the box, the row handle left of it, the add-col button
// overhangs its right edge), so the pointer's path onto them inevitably
// crosses elements that are neither the widget nor a control. Hiding can
// therefore never key off "entered a foreign element" — it is GEOMETRIC: the
// set stays up while the pointer is inside the visible box expanded by a
// margin that covers every floating control, and hides only when the pointer
// truly leaves that neighborhood (or the editor). Likewise doc/geometry
// changes REPOSITION the visible set (the table re-renders in place on every
// keystroke); they never hide it — a hidden set could only come back on the
// next element crossing, which made the buttons "vanish" under a parked
// pointer.
// ---------------------------------------------------------------------------

/**
 * How far past the visible scroll box the pointer may roam before the hover
 * affordances hide. Must cover the floating controls' overhang — the row
 * handle (HANDLE_WIDTH + 2 left of the box), the column handle above, the
 * add-col button's half-width past the right edge — plus diagonal-travel slop.
 */
const AFFORDANCE_MARGIN = 40

interface ActiveCell {
  /** Doc position of the table's source start (kept mapped via the field). */
  tablePos: number
  row: number
  col: number
}

class TableEditPluginValue {
  private active: ActiveCell | null = null
  private textarea: HTMLTextAreaElement | null = null
  private ignoreBlur = false

  // Hover affordances (one floating set, re-anchored to the hovered table).
  private addRowEl: HTMLButtonElement | null = null
  private addColEl: HTMLButtonElement | null = null
  private rowHandleEl: HTMLButtonElement | null = null
  private colHandleEl: HTMLButtonElement | null = null
  private menuEl: HTMLDivElement | null = null
  private hoverWidget: HTMLElement | null = null
  private hoverRow = -1
  private hoverCol = -1

  constructor(readonly view: EditorView) {
    view.dom.addEventListener('mousedown', this.onMouseDown, true)
    view.scrollDOM.addEventListener('pointerover', this.onPointerOver)
    view.scrollDOM.addEventListener('pointermove', this.onPointerMove)
    view.dom.addEventListener('pointerleave', this.onPointerLeave)
    // A table's INTERNAL horizontal scroll happens inside the widget DOM and
    // never reaches CodeMirror's update()/geometryChanged, so the overlay layer
    // (positioned in scrollDOM space) would otherwise stay frozen while the
    // cells move. scroll events don't bubble, but they DO reach an ancestor in
    // the CAPTURE phase — one capturing listener catches every table box's
    // scroll and re-derives the overlay + affordance geometry from the live
    // cell/box rects (which already bake in the new scrollLeft).
    view.scrollDOM.addEventListener('scroll', this.onTableScroll, true)
  }

  destroy(): void {
    this.view.dom.removeEventListener('mousedown', this.onMouseDown, true)
    this.view.scrollDOM.removeEventListener('pointerover', this.onPointerOver)
    this.view.scrollDOM.removeEventListener('pointermove', this.onPointerMove)
    this.view.dom.removeEventListener('pointerleave', this.onPointerLeave)
    this.view.scrollDOM.removeEventListener('scroll', this.onTableScroll, true)
    for (const el of [this.textarea, this.addRowEl, this.addColEl, this.rowHandleEl, this.colHandleEl, this.menuEl]) {
      el?.remove()
    }
    this.active = null
  }

  update(update: ViewUpdate): void {
    // Reposition (never hide) the visible affordances: every keystroke in a
    // cell is a doc change that re-renders the table in place, and merely
    // showing the buttons can trigger a measure/geometry pass — instant-hide
    // here is what made the controls vanish under a parked pointer.
    if (update.docChanged || update.geometryChanged) this.scheduleAffordanceRefresh()
    if (!this.active) return
    const pinned = update.state.field(tableEditField, false) ?? null
    if (pinned === null) {
      this.teardownOverlay()
      return
    }
    this.active.tablePos = pinned
    if (update.docChanged) {
      // Re-anchor to the same logical cell: value sync is layout-free and runs
      // now; geometry settles in the measure phase below.
      this.syncOverlay()
    }
    if (update.docChanged || update.geometryChanged) this.schedulePosition()
  }

  // --- events ----------------------------------------------------------------

  private onMouseDown = (event: MouseEvent): void => {
    const target = event.target instanceof HTMLElement ? event.target : null
    if (!target) return
    // The open cell editor owns its mouse interactions: preventing this
    // mousedown would kill native caret placement and drag-selection inside
    // the textarea (the "can't select text in a cell" bug).
    if (target.closest('.cm-ink-table-cell-editor')) return
    if (target.closest('.cm-ink-table-ui')) {
      // Our own floating controls: keep focus where it is and run the action.
      event.preventDefault()
      event.stopPropagation()
      this.onUiMouseDown(target)
      return
    }
    this.hideMenu()
    const wrap = target.closest('.cm-ink-table-widget')
    if (
      wrap instanceof HTMLElement &&
      this.view.contentDOM.contains(wrap) &&
      !this.view.state.readOnly &&
      !target.closest('a[data-href]')
    ) {
      const cell = target.closest('th, td')
      if (cell instanceof HTMLElement && cell.closest('.cm-ink-table-rendered')) {
        // WYSIWYG entry point: the overlay opens instead of revealing source.
        // (Raw-source editing stays reachable via arrow keys / readOnly-mode
        // clicks — the widget's own mousedown handler is untouched.)
        event.preventDefault()
        event.stopPropagation()
        this.openFromCell(wrap, cell, event)
        return
      }
    }
    // Clicking anywhere else closes an open overlay; the event then proceeds
    // normally (e.g. the widget's click-to-source for non-cell areas).
    if (this.active) this.close(null)
  }

  /** Anchors/shows the affordances. Showing only — hiding is the geometric
   *  pointermove/pointerleave path, so a pointer crossing foreign elements on
   *  its way to a floating control can never drop the set. */
  private onPointerOver = (event: Event): void => {
    if (this.view.state.readOnly) return
    const target = event.target instanceof HTMLElement ? event.target : null
    if (!target || target.closest('.cm-ink-table-ui')) return
    const wrap = target.closest('.cm-ink-table-widget')
    if (!(wrap instanceof HTMLElement) || !this.view.contentDOM.contains(wrap)) return
    if (wrap !== this.hoverWidget) {
      // Switching tables: the handles still point at the previous table's
      // cells — drop them until a cell of the new table is hovered.
      this.hoverWidget = wrap
      this.hoverRow = -1
      this.hoverCol = -1
      this.hideHandles()
    }
    this.showTableAffordances(wrap)
    const cell = target.closest('th, td')
    if (cell instanceof HTMLElement && cell.closest('.cm-ink-table-rendered')) {
      const coords = cellCoords(cell)
      if (coords) {
        this.hoverRow = coords.row
        this.hoverCol = coords.col
        this.showHandles(wrap, cell, coords)
      }
    }
  }

  /** Geometric hide: the affordances stay up while the pointer is anywhere in
   *  the table's neighborhood (visible box + margin — which contains all the
   *  floating controls), and hide only when it truly leaves. An open menu
   *  pins the set regardless (it closes on click/click-away). */
  private onPointerMove = (event: PointerEvent): void => {
    if (!this.hoverWidget || this.menuVisible()) return
    const target = event.target instanceof HTMLElement ? event.target : null
    if (target && (target.closest('.cm-ink-table-ui') || target.closest('.cm-ink-table-widget'))) return
    if (!this.inAffordanceRegion(event.clientX, event.clientY)) this.hideAffordances()
  }

  private onPointerLeave = (event: PointerEvent): void => {
    // Leaving the editor usually drops the set — but not when the pointer is
    // still in the table's neighborhood (it may be ON a floating control that
    // pokes past the editor's box, which is "outside" in DOM-tree terms).
    if (this.menuVisible()) return
    if (!this.inAffordanceRegion(event.clientX, event.clientY)) this.hideAffordances()
  }

  private inAffordanceRegion(x: number, y: number): boolean {
    const wrap = this.hoverWidget
    if (!wrap || !wrap.isConnected) return false
    // The visible scroll box, not wrap: a bleeding table's box is wider than
    // the widget, and the box's bottom padding already contains the add-row
    // button and the scrollbar.
    const box = wrap.querySelector('.cm-ink-table-scroll') ?? wrap
    const rect = box.getBoundingClientRect()
    return (
      x >= rect.left - AFFORDANCE_MARGIN &&
      x <= rect.right + AFFORDANCE_MARGIN &&
      y >= rect.top - AFFORDANCE_MARGIN &&
      y <= rect.bottom + AFFORDANCE_MARGIN
    )
  }

  /**
   * The table's internal horizontal scroll fires here in the capture phase (it
   * never reaches CodeMirror's update()). Re-derive the open overlay's position
   * from its cell's live rect, and re-anchor the visible affordances/handles to
   * the moved cells — unless a menu is open (re-anchoring would yank its
   * anchor out from under the pointer).
   */
  private onTableScroll = (event: Event): void => {
    const target = event.target instanceof HTMLElement ? event.target : null
    if (!target || !target.classList.contains('cm-ink-table-scroll')) return
    if (this.active) this.positionOverlay()
    if (this.menuVisible()) return
    if (this.hoverWidget?.contains(target)) this.refreshAffordances()
  }

  // --- overlay lifecycle -------------------------------------------------------

  private openFromCell(wrap: HTMLElement, cellEl: HTMLElement, event?: MouseEvent): void {
    const coords = cellCoords(cellEl)
    if (!coords) return
    const base = this.view.posAtDOM(wrap)
    const table = resolveTable(this.view.state, base)
    if (!table) return
    const row = table.grid.rows[coords.row]
    if (!row) return
    const cell = row[coords.col]
    if (!cell) {
      // A padded cell (source row shorter than the widget's column count):
      // first extend the row with empty cells, then edit the now-real cell.
      this.padRow(table, coords.row, coords.col, () => this.openAt(table.from, coords.row, coords.col))
      return
    }
    // Land the caret on the clicked character when the rendered text maps 1:1
    // onto the raw source (otherwise openAt defaults to caret-at-end).
    const caret = event ? caretIndexIn(cellEl, event.clientX, event.clientY, cell.text) : null
    this.openAt(table.from, coords.row, coords.col, caret)
  }

  private openAt(tablePos: number, row: number, col: number, caret: number | null = null): void {
    const resolved = resolveTable(this.view.state, tablePos)
    const cell = resolved?.grid.rows[row]?.[col]
    if (!resolved || cell === undefined) return
    this.active = { tablePos: resolved.from, row, col }
    const ta = this.ensureTextarea()
    this.ignoreBlur = true
    try {
      ta.value = cell.text
      ta.style.display = 'block'
      this.positionOverlay()
      ta.focus()
      const at = caret === null ? ta.value.length : Math.max(0, Math.min(caret, ta.value.length))
      ta.setSelectionRange(at, at)
    } finally {
      this.ignoreBlur = false
    }
    if ((this.view.state.field(tableEditField, false) ?? null) !== resolved.from) {
      this.view.dispatch({ effects: setTableEditEffect.of(resolved.from) })
    }
  }

  /**
   * Close the overlay. `selectionAfter` (Esc) parks the caret just after the
   * table and refocuses the editor; null leaves selection/focus to whatever
   * the user clicked. Deferred dispatch when called from update().
   */
  private close(selectionAfter: number | null, fromUpdate = false): void {
    if (!this.active) return
    this.teardownOverlay()
    const clear = () => {
      if ((this.view.state.field(tableEditField, false) ?? null) === null) return
      this.view.dispatch({
        effects: setTableEditEffect.of(null),
        ...(selectionAfter !== null ? { selection: { anchor: selectionAfter } } : {}),
      })
      if (selectionAfter !== null) this.view.focus()
    }
    if (fromUpdate) queueMicrotask(clear)
    else clear()
  }

  private teardownOverlay(): void {
    this.active = null
    if (this.textarea) {
      this.ignoreBlur = true
      try {
        this.textarea.style.display = 'none'
        this.textarea.blur()
      } finally {
        this.ignoreBlur = false
      }
    }
  }

  private ensureTextarea(): HTMLTextAreaElement {
    if (this.textarea) return this.textarea
    const ta = document.createElement('textarea')
    ta.className = 'cm-ink-table-ui cm-ink-table-cell-editor'
    ta.rows = 1
    ta.setAttribute('aria-label', 'Edit table cell')
    ta.addEventListener('input', () => this.onInput())
    ta.addEventListener('keydown', (event) => this.onKeyDown(event))
    ta.addEventListener('blur', () => {
      if (!this.ignoreBlur) this.close(null)
    })
    this.view.scrollDOM.appendChild(ta)
    this.textarea = ta
    return ta
  }

  // --- commit flow ---------------------------------------------------------

  private resolveActive(): ResolvedTable | null {
    if (!this.active) return null
    const resolved = resolveTable(this.view.state, this.active.tablePos)
    if (resolved) this.active.tablePos = resolved.from // re-snap drifted maps
    return resolved
  }

  private onInput(): void {
    const ta = this.textarea
    if (!ta || !this.active) return
    // Keep the textarea a faithful view of the cell's source: escape bare
    // pipes (and flatten pasted newlines) in place, preserving the caret.
    const escaped = escapeCellText(ta.value)
    if (escaped !== ta.value) {
      const caret = ta.selectionStart ?? ta.value.length
      const grown = escapeCellText(ta.value.slice(0, caret)).length
      ta.value = escaped
      ta.setSelectionRange(grown, grown)
    }
    this.commit()
  }

  private commit(): void {
    const ta = this.textarea
    const active = this.active
    if (!ta || !active) return
    const resolved = this.resolveActive()
    const cell = resolved?.grid.rows[active.row]?.[active.col]
    if (!resolved || cell === undefined) {
      this.close(null)
      return
    }
    if (cell.text === ta.value) return
    const change = diffReplace(resolved.from + cell.from, cell.text, ta.value)
    const before = this.view.state.doc
    this.view.dispatch({ changes: change, userEvent: 'input.type' })
    if (this.view.state.doc === before) {
      // Suggest mode canceled the transaction and will replay it through the
      // session on a microtask; re-sync once that (macro-task) has settled —
      // marked deletions keep the original text in the doc, and the textarea
      // mirrors the doc (the same behavior raw suggest-mode typing has).
      setTimeout(() => {
        if (this.active) {
          this.syncOverlay()
          this.positionOverlay()
        }
      }, 0)
    }
  }

  /** Re-anchor the overlay's value to the doc's current cell text. */
  private syncOverlay(): void {
    const ta = this.textarea
    const active = this.active
    if (!ta || !active) return
    const resolved = this.resolveActive()
    const cell = resolved?.grid.rows[active.row]?.[active.col]
    if (!resolved || cell === undefined) {
      // Table or cell no longer exists (remote structure change): close.
      this.close(null, true)
      return
    }
    if (cell.text === ta.value) return
    // Edge whitespace the user just typed serializes into the cell's source
    // PADDING (the grid trims cell content), so the doc legitimately reads
    // back without it. Keep the textarea's version — rewriting would eat the
    // space mid-word ("Codex " -> "Codex" -> "CodexCLI").
    if (cell.text === ta.value.trim()) return
    const caret = ta.selectionStart ?? ta.value.length
    const old = ta.value
    const next = cell.text
    let prefix = 0
    while (prefix < Math.min(old.length, next.length) && old[prefix] === next[prefix]) prefix++
    ta.value = next
    const mapped = caret <= prefix ? caret : Math.max(prefix, next.length - (old.length - caret))
    const clamped = Math.max(0, Math.min(mapped, next.length))
    ta.setSelectionRange(clamped, clamped)
  }

  // --- navigation ------------------------------------------------------------

  private onKeyDown(event: KeyboardEvent): void {
    const active = this.active
    if (!active) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      const resolved = this.resolveActive()
      const after = resolved ? Math.min(resolved.to + 1, this.view.state.doc.length) : null
      this.close(after)
      return
    }
    if (event.key === 'Tab') {
      event.preventDefault()
      event.stopPropagation()
      const resolved = this.resolveActive()
      if (!resolved) return
      const { columns, rows } = resolved.grid
      const total = rows.length * columns
      const index = active.row * columns + active.col
      const next = (index + (event.shiftKey ? -1 : 1) + total) % total
      this.moveTo(Math.floor(next / columns), next % columns)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      const resolved = this.resolveActive()
      if (!resolved) return
      if (active.row + 1 < resolved.grid.rows.length) {
        this.moveTo(active.row + 1, active.col)
      } else {
        // Last row: Enter grows the table by one row, then moves into it.
        const target = { row: active.row + 1, col: active.col }
        this.dispatchOp(resolved, { type: 'add-row' }, () => this.moveTo(target.row, target.col))
      }
    }
  }

  private moveTo(row: number, col: number): void {
    if (!this.active) return
    const resolved = this.resolveActive()
    const cell = resolved?.grid.rows[row]?.[col]
    if (!resolved) {
      this.close(null)
      return
    }
    if (cell === undefined) {
      // Target is a padded cell of a short source row: extend the row first.
      this.padRow(resolved, row, col, () => this.openAt(resolved.from, row, col))
      return
    }
    this.openAt(resolved.from, row, col)
  }

  // --- structure ops -----------------------------------------------------------

  /**
   * Dispatches one minimal replace turning the table's source into the op's
   * regenerated source. `then` runs once the doc reflects the change — for
   * suggest mode (transaction canceled, replayed async) it is deferred a
   * macro-task so the session's echo has landed.
   */
  private dispatchOp(table: ResolvedTable, op: TableOp, then?: () => void): void {
    if (this.view.state.readOnly) return
    const source = this.view.state.doc.sliceString(table.from, table.to)
    const next = applyTableOp(source, op)
    if (next === null || next === source) return
    const change = diffReplace(table.from, source, next)
    const before = this.view.state.doc
    this.view.dispatch({ changes: change, userEvent: 'input' })
    if (!then) return
    if (this.view.state.doc !== before) then()
    else setTimeout(then, 0)
  }

  /** Extends a short source row with empty cells through column `col`. */
  private padRow(table: ResolvedTable, row: number, col: number, then: () => void): void {
    const lineIndex = row === 0 ? 0 : row + 1
    const line = table.grid.lines[lineIndex]
    if (!line) return
    const have = table.grid.rows[row]?.length ?? 0
    const missing = col + 1 - have
    if (missing <= 0) {
      then()
      return
    }
    const trimmed = line.text.trimEnd()
    const hasTrailingPipe = trimmed.endsWith('|') && !trimmed.endsWith('\\|')
    const insert = (hasTrailingPipe ? '' : ' |') + '   |'.repeat(missing)
    const at = table.from + line.from + trimmed.length
    const before = this.view.state.doc
    this.view.dispatch({ changes: { from: at, to: at, insert }, userEvent: 'input' })
    if (this.view.state.doc !== before) then()
    else setTimeout(then, 0)
  }

  // --- affordances (hover-only floating controls) ------------------------------

  private menuVisible(): boolean {
    return this.menuEl !== null && this.menuEl.style.display !== 'none'
  }

  private hideAffordances(): void {
    for (const el of [this.addRowEl, this.addColEl]) {
      if (el) el.style.display = 'none'
    }
    this.hideHandles()
    this.hideMenu()
    this.hoverWidget = null
    this.hoverRow = -1
    this.hoverCol = -1
  }

  private hideHandles(): void {
    for (const el of [this.rowHandleEl, this.colHandleEl]) {
      if (el) el.style.display = 'none'
    }
  }

  private affordanceRefreshScheduled = false

  /** Reposition the visible affordances after the DOM has settled (the doc
   *  changed or the editor geometry moved). A measure-phase write, like
   *  schedulePosition. */
  private scheduleAffordanceRefresh(): void {
    if (this.affordanceRefreshScheduled || !this.hoverWidget) return
    this.affordanceRefreshScheduled = true
    this.view.requestMeasure({
      read: () => undefined,
      write: () => {
        this.affordanceRefreshScheduled = false
        this.refreshAffordances()
      },
    })
  }

  /** Re-anchor the visible affordance set to the live DOM. Cell edits
   *  re-render the table's rows in place (populateTable replaces thead/tbody),
   *  so the hovered cell ELEMENT is routinely stale — re-resolve the same
   *  logical (row, col) instead of trusting it. Hides only when the hovered
   *  widget itself is gone. */
  private refreshAffordances(): void {
    const wrap = this.hoverWidget
    if (!wrap || !wrap.isConnected) {
      this.hideAffordances()
      return
    }
    this.showTableAffordances(wrap)
    const cell = this.hoverRow >= 0 && this.hoverCol >= 0 ? cellIn(wrap, this.hoverRow, this.hoverCol) : null
    if (cell) this.showHandles(wrap, cell, { row: this.hoverRow, col: this.hoverCol })
    else this.hideHandles()
  }

  private hideMenu(): void {
    if (this.menuEl) this.menuEl.style.display = 'none'
  }

  private button(className: string, label: string, title: string): HTMLButtonElement {
    const el = document.createElement('button')
    el.type = 'button'
    el.className = `cm-ink-table-ui ${className}`
    el.textContent = label
    el.title = title
    el.tabIndex = -1
    el.style.display = 'none'
    this.view.scrollDOM.appendChild(el)
    return el
  }

  /** Top-left of `rect` in the scroller's absolute coordinate space. */
  private toScroller(rect: DOMRect): { left: number; top: number } {
    const scroller = this.view.scrollDOM
    const sRect = scroller.getBoundingClientRect()
    return {
      left: rect.left - sRect.left + scroller.scrollLeft,
      top: rect.top - sRect.top + scroller.scrollTop,
    }
  }

  private showTableAffordances(wrap: HTMLElement): void {
    const table = wrap.querySelector('table.cm-ink-table-rendered')
    const scrollEl = wrap.querySelector('.cm-ink-table-scroll')
    if (!(table instanceof HTMLElement) || !(scrollEl instanceof HTMLElement)) return
    if (!this.addRowEl) {
      this.addRowEl = this.button('cm-ink-table-add cm-ink-table-add-row', '+', 'Add row')
      this.addRowEl.setAttribute('aria-label', 'Add row')
    }
    if (!this.addColEl) {
      this.addColEl = this.button('cm-ink-table-add cm-ink-table-add-col', '+', 'Add column')
      this.addColEl.setAttribute('aria-label', 'Add column')
    }
    // Key the buttons off the VISIBLE scroll box, never the table's full
    // (max-content) rect: when the table overflows, that rect is the whole
    // scrolled CONTENT (e.g. 1484px wide), which made the old full-width add-row
    // bar huge and pushed the add-col bar off-screen past the visible edge. The
    // scroll box's on-screen rect + clientWidth are exactly the visible region.
    const boxRect = scrollEl.getBoundingClientRect()
    const box = this.toScroller(boxRect)
    const boxWidth = scrollEl.clientWidth
    // The visible table height: the table content height, capped to the box's
    // visible (client) height so a tall scrolled box never overstates it. The
    // box reserves bottom padding for the gutter, so its client height exceeds
    // the table; clamp to the table's own height when the table is shorter.
    const tableRect = table.getBoundingClientRect()
    const boxHeight = Math.min(tableRect.height, scrollEl.clientHeight)
    // The add-row button and the widget's custom horizontal scrollbar share the
    // bottom-of-table region but live in different DOM layers. The shared stack
    // math keeps them apart: the small centered button sits directly under the
    // content (`addRowTop`), and when the table overflows the scrollbar spans
    // the full visible width BELOW it inside a taller reserved gutter
    // (positioned by table.ts). `scrollable` is read from the class updateBar()
    // toggles.
    const scrollable = scrollEl.classList.contains('cm-ink-table-scrollable')
    const { addRowTop } = computeTableBottomGutter(scrollable)
    const { addRow: addRowAt, addCol: addColAt, size } = computeTableAddButtons({
      boxLeft: box.left,
      boxTop: box.top,
      boxWidth,
      boxHeight,
      addRowTop,
    })
    const addRow = this.addRowEl
    addRow.style.display = 'block'
    addRow.style.left = `${addRowAt.left}px`
    addRow.style.top = `${addRowAt.top}px`
    addRow.style.width = `${size}px`
    addRow.style.height = `${size}px`
    const addCol = this.addColEl
    addCol.style.display = 'block'
    addCol.style.left = `${addColAt.left}px`
    addCol.style.top = `${addColAt.top}px`
    addCol.style.width = `${size}px`
    addCol.style.height = `${size}px`
  }

  private showHandles(wrap: HTMLElement, cellEl: HTMLElement, coords: { row: number; col: number }): void {
    const scrollEl = wrap.querySelector('.cm-ink-table-scroll')
    if (!(scrollEl instanceof HTMLElement)) return
    if (!this.rowHandleEl) {
      this.rowHandleEl = this.button('cm-ink-table-handle cm-ink-table-handle-row', '⋯', 'Row actions')
    }
    if (!this.colHandleEl) {
      this.colHandleEl = this.button('cm-ink-table-handle cm-ink-table-handle-col', '⋯', 'Column actions')
    }
    // Anchor both handles to the VISIBLE scroll box (never the table's full
    // max-content rect, whose left edge scrolls off-screen): the row handle pins
    // just left of the box at the hovered row, the column handle just above the
    // box centered on the hovered column. The cell's live rect already bakes in
    // the internal scrollLeft, so projecting both into scroller space and
    // clamping/hiding against the box keeps them reachable on a scrolled table.
    const cell = this.toScroller(cellEl.getBoundingClientRect())
    const cellRect = cellEl.getBoundingClientRect()
    const box = this.toScroller(scrollEl.getBoundingClientRect())
    const { row, col } = computeTableHandles({
      cellLeft: cell.left,
      cellTop: cell.top,
      cellWidth: cellRect.width,
      cellHeight: cellRect.height,
      boxLeft: box.left,
      boxTop: box.top,
      boxWidth: scrollEl.clientWidth,
      // Visible table height: the box's client height capped to the table's own
      // height (matches showTableAffordances), so the column handle hugs the
      // table top even when the box reserves bottom gutter padding.
      boxHeight: Math.min(this.tableHeight(wrap), scrollEl.clientHeight),
      // Header rows have no row actions (the header is structural in GFM).
      hasRowHandle: coords.row >= 1,
    })
    // Keep the handles inside the scroller's paintable area: a table whose box
    // reaches the editor content's left (or top) edge would otherwise push a
    // handle to negative scroller coordinates, where the scroller CLIPS it —
    // invisible, yet a hit-test hole right where the pointer travels. Clamped,
    // it overlaps the table's edge instead and stays visible and clickable
    // (the handles render above the cells).
    row.left = Math.max(row.left, 2)
    col.top = Math.max(col.top, 2)
    this.place(this.rowHandleEl, row)
    this.place(this.colHandleEl, col)
  }

  private tableHeight(wrap: HTMLElement): number {
    const table = wrap.querySelector('table.cm-ink-table-rendered')
    return table instanceof HTMLElement ? table.getBoundingClientRect().height : 0
  }

  private place(el: HTMLButtonElement, at: { left: number; top: number; visible: boolean }): void {
    if (!at.visible) {
      el.style.display = 'none'
      return
    }
    el.style.display = 'block'
    el.style.left = `${at.left}px`
    el.style.top = `${at.top}px`
  }

  private onUiMouseDown(target: HTMLElement): void {
    if (this.view.state.readOnly) return
    const widget = this.hoverWidget
    const action = target.closest('[data-table-action]')
    if (action instanceof HTMLElement) {
      this.runMenuAction(action.dataset['tableAction'] ?? '')
      return
    }
    if (!widget || !widget.isConnected) return
    // The add buttons stay up after the op (the doc change schedules a refresh
    // that re-anchors them to the grown table) so repeat clicks just work.
    if (target.closest('.cm-ink-table-add-row')) {
      const table = resolveTable(this.view.state, this.view.posAtDOM(widget))
      if (table) this.dispatchOp(table, { type: 'add-row' })
      return
    }
    if (target.closest('.cm-ink-table-add-col')) {
      const table = resolveTable(this.view.state, this.view.posAtDOM(widget))
      if (table) this.dispatchOp(table, { type: 'add-column' })
      return
    }
    if (target.closest('.cm-ink-table-handle-row')) {
      this.showMenu(this.rowHandleEl!, [{ action: 'delete-row', label: 'Delete row' }])
      return
    }
    if (target.closest('.cm-ink-table-handle-col')) {
      this.showMenu(this.colHandleEl!, [
        { action: 'align-left', label: 'Align left' },
        { action: 'align-center', label: 'Align center' },
        { action: 'align-right', label: 'Align right' },
        { action: 'delete-column', label: 'Delete column' },
      ])
    }
  }

  private showMenu(anchor: HTMLElement, items: { action: string; label: string }[]): void {
    if (!this.menuEl) {
      this.menuEl = document.createElement('div')
      this.menuEl.className = 'cm-ink-table-ui cm-ink-table-menu'
      this.view.scrollDOM.appendChild(this.menuEl)
    }
    const menu = this.menuEl
    menu.textContent = ''
    for (const item of items) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'cm-ink-table-ui cm-ink-table-menu-item'
      btn.dataset['tableAction'] = item.action
      btn.textContent = item.label
      btn.tabIndex = -1
      menu.appendChild(btn)
    }
    menu.style.display = 'block'
    menu.style.left = anchor.style.left
    menu.style.top = `${parseFloat(anchor.style.top || '0') + 20}px`
  }

  private runMenuAction(action: string): void {
    const widget = this.hoverWidget
    this.hideMenu()
    if (!widget || !widget.isConnected) return
    const table = resolveTable(this.view.state, this.view.posAtDOM(widget))
    if (!table) return
    const row = this.hoverRow
    const col = this.hoverCol
    const op: TableOp | null =
      action === 'delete-row'
        ? { type: 'delete-row', row }
        : action === 'delete-column'
          ? { type: 'delete-column', col }
          : action === 'align-left'
            ? { type: 'set-align', col, align: 'left' }
            : action === 'align-center'
              ? { type: 'set-align', col, align: 'center' }
              : action === 'align-right'
                ? { type: 'set-align', col, align: 'right' }
                : null
    if (op) this.dispatchOp(table, op)
    // Handles re-anchor on the doc-change refresh (a deleted row/column may
    // leave the hovered coordinates dangling, which hides just the handles).
  }

  // --- overlay geometry --------------------------------------------------------

  private widgetDom(): HTMLElement | null {
    if (!this.active) return null
    const lineFrom = this.view.state.doc.lineAt(this.active.tablePos).from
    for (const el of this.view.contentDOM.querySelectorAll('.cm-ink-table-widget')) {
      if (!(el instanceof HTMLElement)) continue
      try {
        if (this.view.posAtDOM(el) === lineFrom) return el
      } catch {
        // detached or remeasuring — skip
      }
    }
    return null
  }

  private cellDom(): HTMLElement | null {
    const active = this.active
    const widget = this.widgetDom()
    if (!active || !widget) return null
    return cellIn(widget, active.row, active.col)
  }

  private positionOverlay(): void {
    const ta = this.textarea
    if (!ta || !this.active) return
    const cellEl = this.cellDom()
    if (!cellEl) {
      // The widget scrolled out of CodeMirror's render viewport: the overlay
      // has no anchor left. Commits are per-keystroke, so nothing is lost.
      this.close(null, true)
      return
    }
    const rect = cellEl.getBoundingClientRect()
    const at = this.toScroller(rect)
    const cs = window.getComputedStyle(cellEl)
    ta.style.left = `${at.left}px`
    ta.style.top = `${at.top}px`
    ta.style.width = `${Math.max(rect.width, 48)}px`
    ta.style.minHeight = `${rect.height}px`
    ta.style.font = cs.font
    ta.style.fontWeight = cs.fontWeight
    ta.style.lineHeight = cs.lineHeight
    ta.style.textAlign = cs.textAlign
    ta.style.padding = cs.padding
    // Theme-correct chrome without app CSS: inherit the editor's painted
    // colors at open time (the app's light/dark vars resolve here).
    const editor = window.getComputedStyle(this.view.dom)
    ta.style.backgroundColor = editor.backgroundColor === 'rgba(0, 0, 0, 0)' ? '#fff' : editor.backgroundColor
    ta.style.color = cs.color
    // Auto-grow to the wrapped content.
    ta.style.height = 'auto'
    if (ta.scrollHeight > 0) ta.style.height = `${ta.scrollHeight}px`
  }

  private positionScheduled = false

  private schedulePosition(): void {
    if (this.positionScheduled) return
    this.positionScheduled = true
    this.view.requestMeasure({
      read: () => undefined,
      write: () => {
        this.positionScheduled = false
        if (this.active) this.positionOverlay()
      },
    })
  }
}

const tableEditPlugin = ViewPlugin.fromClass(TableEditPluginValue)

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

const tableEditTheme = EditorView.baseTheme({
  '.cm-ink-table-cell-editor': {
    position: 'absolute',
    display: 'none',
    zIndex: '20',
    boxSizing: 'border-box',
    margin: '0',
    border: '1px solid transparent',
    outline: '2px solid var(--ink-table-accent, #2563eb)',
    outlineOffset: '-1px',
    borderRadius: '2px',
    resize: 'none',
    overflow: 'hidden',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'normal',
  },
  '.cm-ink-table-handle, .cm-ink-table-menu': {
    position: 'absolute',
    zIndex: '15',
    boxSizing: 'border-box',
    font: '12px/1 ui-sans-serif, system-ui, sans-serif',
    color: '#9ca3af',
    backgroundColor: 'var(--ink-table-header-bg, rgba(135, 131, 120, 0.08))',
    border: '1px solid var(--ink-table-border, #d7dde5)',
    borderRadius: '4px',
    cursor: 'pointer',
    padding: '0',
  },
  // Small floating "+" buttons (~26px round) keyed to the VISIBLE scroll box —
  // add-row centered under the box, add-col pinned to its right edge. Paper
  // surface + subtle border + centered glyph: the app's small icon-button
  // language (share/menu/⋯ handles). Never full-width bars.
  '.cm-ink-table-add': {
    position: 'absolute',
    zIndex: '16',
    boxSizing: 'border-box',
    width: '26px',
    height: '26px',
    // Centered glyph via line-height (26px box minus the 1px borders) — the
    // show code drives `display` inline, so flex centering would not survive.
    font: '16px/24px ui-sans-serif, system-ui, sans-serif',
    textAlign: 'center',
    color: 'var(--ink-table-add-fg, #6b7280)',
    backgroundColor: 'var(--ink-table-add-bg, #ffffff)',
    border: '1px solid var(--ink-table-border, #d7dde5)',
    borderRadius: '50%',
    boxShadow: '0 1px 3px rgba(15, 23, 42, 0.12)',
    cursor: 'pointer',
    padding: '0',
  },
  '.cm-ink-table-handle': {
    width: '20px',
    height: '18px',
    lineHeight: '16px',
    textAlign: 'center',
  },
  '.cm-ink-table-add:hover': {
    color: 'var(--ink-table-accent, #2563eb)',
    borderColor: 'var(--ink-table-accent, #2563eb)',
    backgroundColor: 'var(--ink-table-add-bg, #ffffff)',
  },
  '.cm-ink-table-handle:hover': {
    color: '#1f2430',
    backgroundColor: 'var(--ink-table-border, #d7dde5)',
  },
  '.cm-ink-table-menu': {
    display: 'none',
    minWidth: '136px',
    padding: '4px',
    backgroundColor: 'var(--ink-table-menu-bg, #ffffff)',
    boxShadow: '0 4px 16px rgba(15, 23, 42, 0.12)',
    zIndex: '25',
  },
  '.cm-ink-table-menu-item': {
    display: 'block',
    width: '100%',
    textAlign: 'left',
    font: '13px/1.6 ui-sans-serif, system-ui, sans-serif',
    color: 'inherit',
    backgroundColor: 'transparent',
    border: 'none',
    borderRadius: '3px',
    padding: '3px 8px',
    cursor: 'pointer',
  },
  '.cm-ink-table-menu-item:hover': {
    backgroundColor: 'var(--ink-table-header-bg, rgba(135, 131, 120, 0.08))',
  },
})

/**
 * WYSIWYG table editing: a floating cell overlay (raw source per cell,
 * Tab/Enter navigation, pipe escaping) plus hover affordances for structure
 * ops. Inert in read-only editors and in source mode (no widgets, nothing to
 * attach to). Included in livePreview(); exported for standalone setups.
 */
export function tableEditor(): Extension {
  return [tableEditField, tableEditPlugin, tableEditTheme]
}
