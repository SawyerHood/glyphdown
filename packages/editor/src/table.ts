import type { EditorState } from '@codemirror/state'
import { EditorView, WidgetType } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'

// ---------------------------------------------------------------------------
// Read-only rendered tables (the SilverBullet table-widget approach): away
// from the selection, the whole GFM table block is replaced by a real
// <table>; the selection entering the block (or a click on the widget)
// reveals the raw monospace source.
// ---------------------------------------------------------------------------

export type TableAlign = 'left' | 'center' | 'right' | null

/**
 * A safe, minimal inline-content model for one table cell. Built from the
 * Lezer tree (never from raw HTML) and rendered with createElement +
 * textContent only — no HTML pass-through is possible.
 */
export type CellSpan =
  | { type: 'text'; text: string }
  | { type: 'strong' | 'em' | 'del' | 'mark'; children: CellSpan[] }
  | { type: 'code'; text: string }
  | { type: 'link'; href: string; children: CellSpan[] }

export interface TableCellModel {
  /** Cell start, relative to the widget's replace range (stays valid as the doc shifts). */
  offset: number
  spans: CellSpan[]
}

export interface TableModel {
  /** The table's source text — the widget identity for eq(). */
  source: string
  aligns: TableAlign[]
  header: TableCellModel[]
  rows: TableCellModel[][]
}

/**
 * Alignment per column from the delimiter row (`| :--- | :-: | ---: |`):
 * `:` on both sides → center, right only → right, left only → left,
 * neither → null (the browser default).
 */
export function parseDelimiterAlignments(row: string): TableAlign[] {
  let text = row.trim()
  if (text.startsWith('|')) text = text.slice(1)
  if (text.endsWith('|')) text = text.slice(0, -1)
  return text.split('|').map((segment) => {
    const s = segment.trim()
    const left = s.startsWith(':')
    const right = s.endsWith(':') && s.length > 1
    if (left && right) return 'center'
    if (right) return 'right'
    if (left) return 'left'
    return null
  })
}

const SPAN_TYPES: Record<string, 'strong' | 'em' | 'del' | 'mark'> = {
  StrongEmphasis: 'strong',
  Emphasis: 'em',
  Strikethrough: 'del',
  Highlight: 'mark',
}

const SPAN_MARKS: Record<string, string> = {
  StrongEmphasis: 'EmphasisMark',
  Emphasis: 'EmphasisMark',
  Strikethrough: 'StrikethroughMark',
  Highlight: 'HighlightMark',
}

/** Content range between a node's first and last delimiter marks. */
function innerRange(node: SyntaxNode, markName: string): { from: number; to: number } {
  const marks = node.getChildren(markName)
  const first = marks[0]
  const last = marks.length > 1 ? marks[marks.length - 1] : undefined
  return { from: first ? first.to : node.from, to: last ? last.from : node.to }
}

function spansForNode(state: EditorState, node: SyntaxNode, base: number): CellSpan[] {
  const doc = state.doc
  const wrap = SPAN_TYPES[node.name]
  if (wrap !== undefined) {
    const { from, to } = innerRange(node, SPAN_MARKS[node.name]!)
    return [{ type: wrap, children: spansBetween(state, node, from, to, base) }]
  }
  switch (node.name) {
    case 'InlineCode': {
      const { from, to } = innerRange(node, 'CodeMark')
      return [{ type: 'code', text: doc.sliceString(from, to) }]
    }
    case 'Link': {
      const urlNode = node.getChild('URL')
      const marks = node.getChildren('LinkMark')
      const open = marks[0]
      const close = marks.find((m) => doc.sliceString(m.from, m.to) === ']') ?? marks[1]
      if (urlNode && open && close && close.from > open.to) {
        return [
          {
            type: 'link',
            href: doc.sliceString(urlNode.from, urlNode.to),
            children: spansBetween(state, node, open.to, close.from, base),
          },
        ]
      }
      break
    }
    case 'Escape':
      // `\|` etc. render the escaped character alone.
      return [{ type: 'text', text: doc.sliceString(node.from + 1, node.to) }]
    case 'URL':
      // GFM autolink: a plain link whose label is the URL itself.
      return [
        {
          type: 'link',
          href: doc.sliceString(node.from, node.to),
          children: [{ type: 'text', text: doc.sliceString(node.from, node.to) }],
        },
      ]
  }
  // Anything else (footnote refs, images, raw marks…) stays raw text — the
  // cell renderer is deliberately minimal.
  return [{ type: 'text', text: doc.sliceString(node.from, node.to) }]
}

/** Inline spans for [from, to] within `parent`, gap text included. */
function spansBetween(state: EditorState, parent: SyntaxNode, from: number, to: number, base: number): CellSpan[] {
  const out: CellSpan[] = []
  let pos = from
  for (let child = parent.firstChild; child; child = child.nextSibling) {
    if (child.to <= from || child.from >= to) continue
    if (child.from > pos) out.push({ type: 'text', text: state.doc.sliceString(pos, child.from) })
    out.push(...spansForNode(state, child, base))
    pos = Math.max(pos, child.to)
  }
  if (pos < to) out.push({ type: 'text', text: state.doc.sliceString(pos, to) })
  return out
}

function cellModel(state: EditorState, cell: SyntaxNode, base: number): TableCellModel {
  return { offset: cell.from - base, spans: spansBetween(state, cell, cell.from, cell.to, base) }
}

/**
 * Extracts the render model from a Lezer Table node: thead cells from
 * TableHeader, per-column alignment from the delimiter row, body rows from
 * TableRow. `base` is the widget's replace-range start — cell offsets are
 * stored relative to it so the model survives doc shifts above the table.
 */
export function buildTableModel(state: EditorState, table: SyntaxNode, base: number): TableModel | null {
  const headerNode = table.getChild('TableHeader')
  if (!headerNode) return null
  const header = headerNode.getChildren('TableCell').map((c) => cellModel(state, c, base))
  if (header.length === 0) return null
  const delimiter = table.getChild('TableDelimiter')
  const aligns = delimiter ? parseDelimiterAlignments(state.doc.sliceString(delimiter.from, delimiter.to)) : []
  const rows = table.getChildren('TableRow').map((row) => row.getChildren('TableCell').map((c) => cellModel(state, c, base)))
  return { source: state.doc.sliceString(table.from, table.to), aligns, header, rows }
}

// ---------------------------------------------------------------------------
// The widget
// ---------------------------------------------------------------------------

function appendSpans(parent: HTMLElement, spans: CellSpan[]): void {
  for (const span of spans) {
    switch (span.type) {
      case 'text':
        parent.appendChild(document.createTextNode(span.text))
        break
      case 'code': {
        const el = document.createElement('code')
        el.className = 'cm-ink-inline-code'
        el.textContent = span.text
        parent.appendChild(el)
        break
      }
      case 'link': {
        // No real href: navigation is the app's job (its click handler opens
        // `.cm-ink-link` chips via data-href, the same contract as inline
        // links). The widget's mousedown handler leaves anchors alone.
        const el = document.createElement('a')
        el.className = 'cm-ink-link'
        el.setAttribute('data-href', span.href)
        el.title = span.href
        appendSpans(el, span.children)
        parent.appendChild(el)
        break
      }
      case 'mark': {
        const el = document.createElement('mark')
        el.className = 'cm-ink-highlight'
        appendSpans(el, span.children)
        parent.appendChild(el)
        break
      }
      default: {
        const el = document.createElement(span.type)
        appendSpans(el, span.children)
        parent.appendChild(el)
        break
      }
    }
  }
}

function renderCell(tag: 'th' | 'td', cell: TableCellModel | null, align: TableAlign): HTMLElement {
  const el = document.createElement(tag)
  if (align) el.style.textAlign = align
  // The inner block carries the per-cell max width (~38ch): max-width on the
  // th/td itself is not reliably honored by table auto-layout, but a block
  // child's preferred width is — so prose cells wrap at the cap while short
  // cells keep their natural (max-content) width.
  const content = document.createElement('div')
  content.className = 'cm-ink-table-cell'
  if (cell) {
    el.dataset['pos'] = String(cell.offset)
    appendSpans(content, cell.spans)
  }
  el.appendChild(content)
  return el
}

// ---------------------------------------------------------------------------
// Bleed math (pure — unit-tested)
// ---------------------------------------------------------------------------

export interface TableBleedInput {
  /**
   * Width of the editor area the table is actually centered within — the
   * cm-scroller's client width (already excludes the file sidebar and the
   * editor's own scrollbar). NOT 100vw: the original clamp read the viewport
   * and overstated the bleed whenever a sidebar was open, pushing the table
   * past the visible editor where an ancestor clipped it.
   */
  availableWidth: number
  /** The prose column's inner content width (the widget's content box). */
  columnWidth: number
  /** The table's natural (max-content) width. */
  tableWidth: number
  /** App-configured maximum bleed per side (the design cap). */
  maxBleed: number
}

export interface TableBleed {
  /** Effective per-side bleed (px), clamped to the room actually available. */
  bleed: number
  /** Center + bleed: the table exceeds the column AND there is room to bleed. */
  wide: boolean
  /** The resulting visible scroll-box width. */
  boxWidth: number
  /** Table content still exceeds the visible box — a scrollbar/fade is needed. */
  scrollable: boolean
}

/**
 * Per-widget table bleed/centering, computed from the EDITOR'S real available
 * width rather than the raw viewport. A wide table centers over the prose
 * column and bleeds symmetrically up to `maxBleed`, but never further than the
 * room between the column and the visible editor edges — so the centered box
 * always fits inside the editor and is never clipped by an ancestor. Anything
 * still wider than that box scrolls horizontally inside the wrapper.
 */
export function computeTableBleed({ availableWidth, columnWidth, tableWidth, maxBleed }: TableBleedInput): TableBleed {
  const exceedsColumn = columnWidth > 0 && tableWidth > columnWidth + 1
  // Half the slack between the prose column and the visible editor edges; the
  // table is centered on the column (= the editor center), so this is exactly
  // how far each side may bleed before spilling past the editor.
  const room = Math.max(0, (availableWidth - columnWidth) / 2)
  const bleed = exceedsColumn ? Math.max(0, Math.min(maxBleed, room)) : 0
  // Only center when the bleed is meaningful: sub-pixel bleed at very narrow
  // viewports stays left-aligned and simply scrolls internally (unchanged).
  const wide = exceedsColumn && bleed > 0.5
  const boxWidth = exceedsColumn ? Math.min(tableWidth, columnWidth + 2 * bleed) : tableWidth
  const scrollable = tableWidth > boxWidth + 1
  return { bleed, wide, boxWidth, scrollable }
}

export interface TableScrollbarInput {
  /** The visible scroll box width (scroll.clientWidth). */
  clientWidth: number
  /** The table's full content width (scroll.scrollWidth). */
  scrollWidth: number
  /** Current horizontal scroll position (scroll.scrollLeft). */
  scrollLeft: number
  /** Smallest grabbable thumb, in px (default 32). */
  minThumb?: number
}

export interface TableScrollbar {
  /** The table overflows its box — the custom scrollbar should be shown. */
  visible: boolean
  /** Thumb width in px (clamped to at least `minThumb`, at most the track). */
  thumbWidth: number
  /** Thumb left offset in px within the track. */
  thumbOffset: number
}

/**
 * Geometry for the widget's custom (always-visible) horizontal scrollbar — the
 * platform overlay scrollbar reserves no height and stays hidden at rest on
 * macOS, so the widget draws its own thumb. Pure so the proportional mapping
 * (clientWidth/scrollWidth for the thumb width, scrollLeft/maxScroll across the
 * free track for its offset) is unit-tested without a layout engine. The thumb
 * never exceeds the track and never shrinks below `minThumb`, and the offset is
 * clamped to the free space so the thumb stays fully inside the box at both
 * ends — the scroll/containment invariant the bug violated.
 */
export function computeTableScrollbar({
  clientWidth,
  scrollWidth,
  scrollLeft,
  minThumb = 32,
}: TableScrollbarInput): TableScrollbar {
  const overflow = scrollWidth - clientWidth
  if (overflow <= 1 || clientWidth <= 0) {
    return { visible: false, thumbWidth: clientWidth, thumbOffset: 0 }
  }
  const ratio = clientWidth / scrollWidth
  const thumbWidth = Math.min(clientWidth, Math.max(Math.min(clientWidth, minThumb), clientWidth * ratio))
  const free = clientWidth - thumbWidth
  const clampedLeft = Math.max(0, Math.min(scrollLeft, overflow))
  const thumbOffset = free > 0 ? (clampedLeft / overflow) * free : 0
  return { visible: true, thumbWidth, thumbOffset }
}

// ---------------------------------------------------------------------------
// Bottom-gutter stacking geometry (pure — unit-tested)
//
// Below the table content sit two affordances that must NOT overlap: the
// WYSIWYG "add row" (+) floating button (rendered in the editor's overlay layer
// by table-edit.ts) and this widget's custom horizontal scrollbar (rendered in
// the widget's own gutter). They live in different DOM layers, so they can
// only be kept apart by agreeing on the SAME stack math — this helper is that
// single source of truth, consumed by both sides (table.ts positions the
// scrollbar; table-edit.ts offsets the add-row button) and unit-tested here.
//
// The add-row button is a small (~26px) round button CENTERED on the VISIBLE
// scroll box, not a full-width bar — so the scrollbar (which spans the whole
// visible width below it) is free to share the gutter: the button sits above
// it, the scrollbar below it, neither overlapping.
//
// Stack, top→bottom, all offsets measured DOWN from the table's bottom edge:
//   table content
//   [TABLE_TO_ADDROW_GAP]
//   add-row "+" button   (ADD_BUTTON_SIZE)   ← small, box-centered
//   [ADDROW_TO_SCROLLBAR_GAP]   ← only when the scrollbar is present
//   horizontal scrollbar (SCROLLBAR_HEIGHT)   ← only when scrollable
//   [SCROLLBAR_BOTTOM_PAD]
// ---------------------------------------------------------------------------

/**
 * Small floating add-row/add-col button size — mirrors `.cm-ink-table-add`
 * width/height in CSS. The add-row button reserves this much vertical room in
 * the bottom gutter (its full height, not the old 14px bar).
 */
export const ADD_BUTTON_SIZE = 26
/** Custom horizontal scrollbar height — mirrors `.cm-ink-table-scrollbar`. */
export const SCROLLBAR_HEIGHT = 8
/** Gap between the table's bottom edge and the add-row button. */
export const TABLE_TO_ADDROW_GAP = 2
/** Gap between the add-row button and the scrollbar (scrollable case only). */
export const ADDROW_TO_SCROLLBAR_GAP = 2
/** Breathing room below the scrollbar, kept inside the reserved gutter. */
export const SCROLLBAR_BOTTOM_PAD = 2
/**
 * The table element's own vertical margin (`.cm-ink-table-rendered`
 * `margin: 4px 0`): the scroll box's content bottom sits this far below the
 * table's bottom edge, so the reserved bottom padding is the gutter minus it.
 */
export const TABLE_MARGIN_BOTTOM = 4
/**
 * Bottom padding reserved by the scroll box when the table does NOT overflow
 * (no scrollbar) — must clear the small add-row button that floats just below
 * the table content even in the non-scrollable case.
 */
export const DEFAULT_BOTTOM_PADDING = Math.max(12, TABLE_TO_ADDROW_GAP + ADD_BUTTON_SIZE + SCROLLBAR_BOTTOM_PAD - TABLE_MARGIN_BOTTOM)

export interface TableBottomGutter {
  /** Distance (px) from the table's bottom edge to the add-row button's top. */
  addRowTop: number
  /**
   * Distance (px) from the table's bottom edge to the scrollbar's top, or null
   * when the table doesn't overflow (no scrollbar is shown).
   */
  scrollbarTop: number | null
  /**
   * The scroll box's reserved bottom padding (px) so the editor allots vertical
   * room for the whole stack below the table content — i.e. the gutter minus
   * the table's own bottom margin (which already sits inside the scroll box).
   */
  bottomPadding: number
}

/**
 * Vertical layout of the affordances stacked below the table, derived from the
 * shared height/gap constants so the two DOM layers never overlap.
 *
 * - Not scrollable: the add-row button floats just below the table (centered on
 *   the box), no scrollbar, and the box reserves enough bottom strip to clear
 *   the small button.
 * - Scrollable: the add-row button stays directly under the table content, the
 *   scrollbar goes BELOW it spanning the visible width, and the box reserves
 *   enough bottom padding for both (so the scrollbar never overlaps the button
 *   or the next line). Because the button is small and box-centered while the
 *   scrollbar spans the full visible width, they never collide horizontally
 *   either.
 */
export function computeTableBottomGutter(scrollable: boolean): TableBottomGutter {
  const addRowTop = TABLE_TO_ADDROW_GAP
  if (!scrollable) {
    return { addRowTop, scrollbarTop: null, bottomPadding: DEFAULT_BOTTOM_PADDING }
  }
  const scrollbarTop = addRowTop + ADD_BUTTON_SIZE + ADDROW_TO_SCROLLBAR_GAP
  // Gutter measured from the table's bottom edge down past the scrollbar; the
  // scroll box's padding starts below the table margin, so subtract it out.
  const gutter = scrollbarTop + SCROLLBAR_HEIGHT + SCROLLBAR_BOTTOM_PAD
  const bottomPadding = Math.max(DEFAULT_BOTTOM_PADDING, gutter - TABLE_MARGIN_BOTTOM)
  return { addRowTop, scrollbarTop, bottomPadding }
}

// ---------------------------------------------------------------------------
// Floating add-button placement (pure — unit-tested)
//
// The add-row/add-col "+" buttons are small floating buttons keyed to the
// VISIBLE scroll box, never to the table's full (max-content) rect — that rect
// is the whole scrolled content and would size/position the buttons off-screen
// when the table overflows. This helper maps the visible box geometry to the
// two buttons' top-left coordinates in the SCROLLER's absolute space, given the
// box's already-projected top-left (`boxLeft`/`boxTop`) and its on-screen size
// (`boxWidth` = clientWidth, `boxHeight` = the visible table height).
// ---------------------------------------------------------------------------

export interface TableAddButtonsInput {
  /** Visible scroll box's left, in the scroller's absolute coordinate space. */
  boxLeft: number
  /** Visible scroll box's top, in the scroller's absolute coordinate space. */
  boxTop: number
  /** Visible box width on screen (`scroll.clientWidth`). */
  boxWidth: number
  /** Visible table height on screen (clamped to the box's client height). */
  boxHeight: number
  /** Vertical offset from the table's bottom edge to the add-row button's top. */
  addRowTop: number
  /** Square button size (px). */
  size?: number
}

export interface TableAddButtons {
  /** Add-row button top-left (scroller space). Centered under the box. */
  addRow: { left: number; top: number }
  /** Add-col button top-left (scroller space). Pinned to the box's right edge. */
  addCol: { left: number; top: number }
  /** Button size used (px). */
  size: number
}

/**
 * Places the two small floating add buttons against the VISIBLE scroll box:
 *
 * - Add row: horizontally CENTERED on the visible box, in the bottom gutter
 *   `addRowTop` below the box's bottom content edge (which is `boxHeight` below
 *   the box top). Because it's small and centered while the scrollbar spans the
 *   full visible width below it, the two never overlap.
 * - Add col: pinned to the visible box's RIGHT edge (its left side just inside
 *   the right edge by the button width), vertically centered on the visible
 *   table height — always on-screen, never pushed off by the scrolled-away
 *   content. The button overhangs the right edge by ~half its width so it reads
 *   as a right-edge affordance the way the bottom one reads as a bottom one.
 */
export function computeTableAddButtons({
  boxLeft,
  boxTop,
  boxWidth,
  boxHeight,
  addRowTop,
  size = ADD_BUTTON_SIZE,
}: TableAddButtonsInput): TableAddButtons {
  const addRow = {
    left: boxLeft + boxWidth / 2 - size / 2,
    top: boxTop + boxHeight + addRowTop,
  }
  const addCol = {
    // Sit on the right edge: half the button overhangs outside the box so it
    // floats clear of the content, the other half overlaps the edge.
    left: boxLeft + boxWidth - size / 2,
    top: boxTop + boxHeight / 2 - size / 2,
  }
  return { addRow, addCol, size }
}

// ---------------------------------------------------------------------------
// Row / column ⋯ handle placement (pure — unit-tested)
//
// The ⋯ handles must anchor to the hovered cell WITHIN the visible scroll box,
// not to the table's full (max-content) rect. The previous code keyed the row
// handle off `table.left` — when the table scrolls horizontally that edge moves
// off-screen, dragging the handle hundreds of px to the left (a "stray
// top-left" handle), and keyed the column handle off `table.top` (fine
// vertically, but it could overhang the scrolled-out left edge). This helper
// takes the cell's and box's rects ALREADY projected into the scroller's
// absolute space (so the internal scroll is baked into `cellLeft`/`cellTop`) and
// places:
//
// - the row handle just LEFT of the visible box's left edge, vertically
//   centered on the hovered row, HIDDEN when the row scrolls out vertically;
// - the column handle just ABOVE the visible box's top edge, horizontally
//   centered on the hovered COLUMN (the cell), and HIDDEN when that column is
//   scrolled out of the box horizontally.
//
// Coordinates are in the scroller's absolute space, matching the add buttons.
// ---------------------------------------------------------------------------

export interface TableHandlesInput {
  /** Hovered cell rect, projected into scroller space. */
  cellLeft: number
  cellTop: number
  cellWidth: number
  cellHeight: number
  /** Visible scroll box rect, projected into scroller space. */
  boxLeft: number
  boxTop: number
  boxWidth: number
  boxHeight: number
  /** Whether the hovered cell is a body row (header rows get no row handle). */
  hasRowHandle: boolean
  /** Row handle width (px). */
  rowSize?: number
  /** Column handle height (px). */
  colSize?: number
}

export interface TableHandlePlacement {
  left: number
  top: number
  /** Hidden when the row/column is scrolled out of the visible box. */
  visible: boolean
}

export interface TableHandles {
  row: TableHandlePlacement
  col: TableHandlePlacement
}

/** Handle glyph box: mirrors `.cm-ink-table-handle` width/height in CSS. */
export const HANDLE_WIDTH = 20
export const HANDLE_HEIGHT = 18

/**
 * Places the row/column ⋯ handles against the VISIBLE scroll box, anchored to
 * the hovered cell and clamped/hidden when its row/column is scrolled out. All
 * inputs are in the scroller's absolute coordinate space.
 */
export function computeTableHandles({
  cellLeft,
  cellTop,
  cellWidth,
  cellHeight,
  boxLeft,
  boxTop,
  boxWidth,
  boxHeight,
  hasRowHandle,
  rowSize = HANDLE_WIDTH,
  colSize = HANDLE_HEIGHT,
}: TableHandlesInput): TableHandles {
  const boxRight = boxLeft + boxWidth
  const boxBottom = boxTop + boxHeight
  const cellBottom = cellTop + cellHeight
  const cellCenterX = cellLeft + cellWidth / 2
  // A measurable box is needed to decide "scrolled out"; with a degenerate
  // (zero-size) box — e.g. a layout-less test environment — there's no clipping
  // info, so never hide on horizontal/vertical containment grounds.
  const measurable = boxWidth > 0 && boxHeight > 0

  // Row handle: pinned just LEFT of the visible box, vertically centered on the
  // hovered row. Visible while the row is within the box's vertical extent.
  const rowTop = cellTop + Math.max(0, cellHeight / 2 - rowSize / 2)
  const rowVisible = hasRowHandle && (!measurable || (cellBottom > boxTop + 1 && cellTop < boxBottom - 1))
  const row: TableHandlePlacement = {
    left: boxLeft - rowSize - 2,
    top: rowTop,
    visible: rowVisible,
  }

  // Column handle: pinned just ABOVE the visible box, horizontally centered on
  // the hovered column. Hidden when that column's center is scrolled out of the
  // visible box horizontally so it never strays past the edge or floats over a
  // clipped column.
  const colVisible = !measurable || (cellCenterX >= boxLeft && cellCenterX <= boxRight)
  const col: TableHandlePlacement = {
    left: Math.max(boxLeft, Math.min(cellCenterX - colSize / 2, boxRight - colSize)),
    top: boxTop - colSize - 2,
    visible: colVisible,
  }

  return { row, col }
}

/** Per-widget observers/listeners, torn down in destroy(). */
interface WidgetTeardown {
  dispose(): void
  /**
   * Re-render the table's content IN PLACE for a new model, keeping the same
   * wrapper/scroll/table elements — so the box's internal `scrollLeft` (and the
   * observers/listeners) survive. updateDOM() drives this on every edit instead
   * of letting CodeMirror recreate the widget DOM (which would reset the scroll
   * to 0 mid-edit and fling the cell overlay off to the side).
   */
  update(model: TableModel): void
}
const widgetObservers = new WeakMap<HTMLElement, WidgetTeardown>()

/**
 * The GFM authoritative column count: the delimiter row defines it, so a
 * trailing all-empty column (Lezer emits no TableCell for empty cells, e.g.
 * right after an add-column op) is still rendered.
 */
function tableColumns(model: TableModel): number {
  return Math.max(model.header.length, model.aligns.length, ...model.rows.map((r) => r.length))
}

/**
 * (Re)builds a `<table>`'s thead/tbody from a model, replacing any existing
 * children. Reuses the SAME `<table>` element so an enclosing scroll box keeps
 * its `scrollLeft` and the widget's observers stay attached to it.
 */
function populateTable(table: HTMLElement, model: TableModel): void {
  const columns = tableColumns(model)
  const thead = document.createElement('thead')
  const headRow = document.createElement('tr')
  for (let i = 0; i < columns; i++) {
    headRow.appendChild(renderCell('th', model.header[i] ?? null, model.aligns[i] ?? null))
  }
  thead.appendChild(headRow)
  const tbody = document.createElement('tbody')
  for (const row of model.rows) {
    const tr = document.createElement('tr')
    for (let i = 0; i < columns; i++) {
      tr.appendChild(renderCell('td', row[i] ?? null, model.aligns[i] ?? null))
    }
    tbody.appendChild(tr)
  }
  table.replaceChildren(thead, tbody)
}

export class TableWidget extends WidgetType {
  constructor(readonly model: TableModel) {
    super()
  }

  override eq(other: TableWidget): boolean {
    // Cell offsets are widget-relative, so identical source ⇒ identical DOM
    // even after edits elsewhere in the doc.
    return other.model.source === this.model.source
  }

  override get estimatedHeight(): number {
    // ~one prose line (17px × 1.5 + cell padding + border) per row.
    return (this.model.rows.length + 1) * 35
  }

  override toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'cm-ink-table-widget'
    // The scroll wrapper sizes to the table's natural width, may bleed
    // symmetrically past the prose column up to --ink-table-bleed per side,
    // and scrolls horizontally beyond that (see tableBaseTheme).
    const scroll = document.createElement('div')
    scroll.className = 'cm-ink-table-scroll'
    const table = document.createElement('table')
    table.className = 'cm-ink-table-rendered'
    populateTable(table, this.model)
    scroll.appendChild(table)
    wrap.appendChild(scroll)

    // Always-visible, draggable horizontal scrollbar drawn by the widget — NOT
    // the platform scrollbar. macOS (and headless Chromium) render OVERLAY
    // scrollbars that reserve zero layout height and stay hidden at rest, so
    // `scrollbar-width: thin` + a styled `::-webkit-scrollbar` are silently
    // ignored: a too-wide table looked hard-clipped with no way to reach the
    // off-screen columns. This custom track/thumb is persistent, themeable, and
    // reachable on every OS; it lives in the scroll wrapper (so it bleeds and
    // centers with the table) but is absolutely positioned over the box's bottom
    // edge, outside the table's own scroll flow. Wheel/trackpad scroll the
    // native box and the scroll listener keeps the thumb in sync.
    const bar = document.createElement('div')
    bar.className = 'cm-ink-table-scrollbar'
    const thumb = document.createElement('div')
    thumb.className = 'cm-ink-table-scrollbar-thumb'
    bar.appendChild(thumb)
    // The bar lives in `wrap` (which neither scrolls nor carries the edge-fade
    // mask) and is positioned absolutely over the bottom of the visible scroll
    // box by updateBar(). Keeping it OUT of `scroll` means the mask fade never
    // dims the thumb, and the bar never scrolls away with the content.
    // (`contain: inline-size` on wrap constrains size, not paint, so the bar may
    // extend past wrap's own box when the table bleeds.)
    wrap.appendChild(bar)

    // Wide tables (natural width past the prose column) center themselves and
    // bleed symmetrically; tables that fit stay left-aligned in the text
    // column like any other content. CSS alone can't compare an element's
    // natural width to its container, nor clamp the bleed to the editor's real
    // available width, so a ResizeObserver drives both. The effective bleed is
    // recomputed PER WIDGET from the editor's visible width (not the viewport),
    // and written inline so the scroll wrapper's max-width / centering use it.
    // Drag state for the custom thumb (declared out here so the pointer
    // listeners and the teardown both see it). dragging is also read by the
    // wrap mousedown handler so a scrollbar drag never flips to raw source.
    let dragStartX = 0
    let dragStartLeft = 0
    let dragging = false

    // Reflect the native scroll metrics onto the custom track/thumb. Shown only
    // when the table actually overflows its visible box. The bar is absolutely
    // positioned over the bottom of the VISIBLE scroll box (re-aligned each call
    // since the box bleeds/centers), and the thumb's width and offset are the
    // standard proportional mapping (clientWidth/scrollWidth and
    // scrollLeft/maxScroll across the free track space).
    const updateBar = () => {
      const { visible, thumbWidth, thumbOffset } = computeTableScrollbar({
        clientWidth: scroll.clientWidth,
        scrollWidth: scroll.scrollWidth,
        scrollLeft: scroll.scrollLeft,
      })
      const gutter = computeTableBottomGutter(visible)
      // Reserve the box's bottom padding from the shared stack math: enough for
      // the add-row bar AND the scrollbar when scrollable, the default strip
      // otherwise. The add-row bar (overlay layer) reads the same constants.
      scroll.style.paddingBottom = `${gutter.bottomPadding}px`
      if (!visible) {
        scroll.classList.remove('cm-ink-table-scrollable')
        bar.classList.remove('cm-ink-table-scrollbar-visible')
        return
      }
      scroll.classList.add('cm-ink-table-scrollable')
      bar.classList.add('cm-ink-table-scrollbar-visible')
      // Align the bar to the visible scroll box, in wrap's coordinate space (the
      // box bleeds/centers, so re-read its rect each call). The bar's TOP is
      // anchored off the TABLE's bottom edge (not the box bottom) so it stacks
      // BELOW the add-row bar by the shared `scrollbarTop` offset — the two
      // affordances never overlap.
      const wrapRect = wrap.getBoundingClientRect()
      const boxRect = scroll.getBoundingClientRect()
      const tableRect = table.getBoundingClientRect()
      bar.style.left = `${boxRect.left - wrapRect.left}px`
      bar.style.top = `${tableRect.bottom - wrapRect.top + (gutter.scrollbarTop ?? 0)}px`
      bar.style.width = `${scroll.clientWidth}px`
      thumb.style.width = `${thumbWidth}px`
      thumb.style.transform = `translateX(${thumbOffset}px)`
    }

    // Re-derive bleed/scrollbar geometry after an in-place content swap, and
    // tear down the observers/listeners. Both are no-ops without a
    // ResizeObserver (jsdom/SSR); the block below installs the real ones. They
    // live out here so the per-widget record (registered unconditionally) can
    // reach them — updateDOM() needs `remeasure` even on the RO-less path.
    let remeasure = (): void => {}
    let disposeObservers = (): void => {}

    if (typeof ResizeObserver === 'function') {
      const updateFade = () => {
        // Fade the side(s) that still hide content, so an internal-scroll cut
        // never reads as a broken clip. left/right tracked independently as the
        // user scrolls the wrapper.
        const max = scroll.scrollWidth - scroll.clientWidth
        scroll.classList.toggle('cm-ink-table-clip-right', max > 1 && scroll.scrollLeft < max - 1)
        scroll.classList.toggle('cm-ink-table-clip-left', max > 1 && scroll.scrollLeft > 1)
        updateBar()
      }
      const measure = () => {
        const styles = window.getComputedStyle(wrap)
        const inset = (parseFloat(styles.paddingLeft) || 0) + (parseFloat(styles.paddingRight) || 0)
        const columnWidth = wrap.clientWidth - inset
        const maxBleed = parseFloat(styles.getPropertyValue('--ink-table-bleed-max')) || 96
        // The editor column is centered in the scroller; its visible width is
        // what the bleed must fit inside (sidebar + scrollbar already excluded).
        const availableWidth = view.scrollDOM.clientWidth || columnWidth
        const { bleed, wide } = computeTableBleed({
          availableWidth,
          columnWidth,
          tableWidth: table.offsetWidth,
          maxBleed,
        })
        scroll.style.setProperty('--ink-table-bleed', `${bleed}px`)
        scroll.classList.toggle('cm-ink-table-wide', wide)
        updateFade()
      }
      const observer = new ResizeObserver(measure)
      observer.observe(wrap)
      observer.observe(table)
      // The scroller resizes on sidebar toggle / window resize WITHOUT the
      // widget's own box changing — observe it so the bleed re-clamps then too.
      observer.observe(view.scrollDOM)
      scroll.addEventListener('scroll', updateFade, { passive: true })

      // Drag the custom thumb to scroll. Pointer capture keeps the gesture alive
      // even when the cursor leaves the thin track; the map is the inverse of
      // updateBar's (track delta → scroll delta over the free space).
      const onThumbDown = (event: PointerEvent) => {
        event.preventDefault()
        event.stopPropagation()
        dragging = true
        dragStartX = event.clientX
        dragStartLeft = scroll.scrollLeft
        thumb.setPointerCapture(event.pointerId)
        bar.classList.add('cm-ink-table-dragging')
      }
      const onThumbMove = (event: PointerEvent) => {
        if (!dragging) return
        const overflow = scroll.scrollWidth - scroll.clientWidth
        const free = scroll.clientWidth - thumb.offsetWidth
        if (free <= 0 || overflow <= 0) return
        const delta = event.clientX - dragStartX
        scroll.scrollLeft = dragStartLeft + (delta / free) * overflow
      }
      const onThumbUp = (event: PointerEvent) => {
        if (!dragging) return
        dragging = false
        try {
          thumb.releasePointerCapture(event.pointerId)
        } catch {
          /* pointer already released */
        }
        bar.classList.remove('cm-ink-table-dragging')
      }
      // Click on the empty track jumps the thumb so its center lands under the
      // pointer (a direct seek, the common modern-scrollbar behavior).
      const onTrackDown = (event: PointerEvent) => {
        if (event.target === thumb) return
        event.preventDefault()
        event.stopPropagation()
        const rect = bar.getBoundingClientRect()
        const overflow = scroll.scrollWidth - scroll.clientWidth
        const free = scroll.clientWidth - thumb.offsetWidth
        if (free <= 0 || overflow <= 0) return
        const x = event.clientX - rect.left - thumb.offsetWidth / 2
        scroll.scrollLeft = Math.max(0, Math.min(overflow, (x / free) * overflow))
      }
      thumb.addEventListener('pointerdown', onThumbDown)
      thumb.addEventListener('pointermove', onThumbMove)
      thumb.addEventListener('pointerup', onThumbUp)
      thumb.addEventListener('pointercancel', onThumbUp)
      bar.addEventListener('pointerdown', onTrackDown)

      // First ResizeObserver fire can land before layout/fonts settle; re-run
      // after a frame and once webfonts arrive (metrics shift the table width).
      const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(measure) : 0
      const fonts = typeof document !== 'undefined' ? document.fonts : undefined
      const onFonts = () => measure()
      fonts?.ready?.then(onFonts).catch(() => {})
      fonts?.addEventListener?.('loadingdone', onFonts)
      // A content swap changes the table's width and may clamp the box's
      // scrollLeft (e.g. a deleted column), so re-measure the bleed/scrollbar.
      remeasure = measure
      disposeObservers = () => {
        observer.disconnect()
        scroll.removeEventListener('scroll', updateFade)
        thumb.removeEventListener('pointerdown', onThumbDown)
        thumb.removeEventListener('pointermove', onThumbMove)
        thumb.removeEventListener('pointerup', onThumbUp)
        thumb.removeEventListener('pointercancel', onThumbUp)
        bar.removeEventListener('pointerdown', onTrackDown)
        if (raf) cancelAnimationFrame(raf)
        fonts?.removeEventListener?.('loadingdone', onFonts)
      }
    }

    // Registered unconditionally so updateDOM() can re-render in place even
    // without a ResizeObserver: reusing this DOM (vs. a CodeMirror rebuild)
    // keeps the box's internal scrollLeft across edits.
    widgetObservers.set(wrap, {
      dispose: () => disposeObservers(),
      update: (model) => {
        populateTable(table, model)
        remeasure()
      },
    })

    wrap.addEventListener('mousedown', (event) => {
      const target = event.target instanceof HTMLElement ? event.target : null
      // Link chips inside cells belong to the app's click handler — don't
      // also enter edit mode under the opened link.
      if (target?.closest('a[data-href]')) return
      // A mousedown on the custom horizontal scrollbar (track or thumb) is a
      // scroll gesture — its own pointer handlers own it; never flip the widget
      // to raw source under a scrollbar drag.
      if (target?.closest('.cm-ink-table-scrollbar')) return
      // A mousedown on the scroll wrapper's NATIVE scrollbar (below/right of its
      // client box, where a platform classic scrollbar would sit) is likewise a
      // scroll gesture, not a cell click.
      if (target === scroll && (event.offsetX > scroll.clientWidth || event.offsetY > scroll.clientHeight)) return
      event.preventDefault()
      // The checkbox pattern: resolve the widget's position at click time and
      // place the caret inside the table source — the clicked cell when the
      // click landed on one, the table start otherwise. The selection change
      // swaps the widget for the raw source (click-to-edit).
      const base = view.posAtDOM(wrap)
      const cell = target?.closest('[data-pos]')
      const offset = cell instanceof HTMLElement ? Number(cell.dataset['pos']) : 0
      const pos = Math.min(base + (Number.isFinite(offset) ? offset : 0), view.state.doc.length)
      view.dispatch({ selection: { anchor: pos } })
      view.focus()
    })
    return wrap
  }

  override updateDOM(dom: HTMLElement): boolean {
    // CodeMirror would otherwise destroy and recreate the widget DOM whenever
    // the source changes (every keystroke in a cell — eq() keys on source),
    // which resets the scroll box's internal scrollLeft to 0 mid-edit and
    // throws the cell overlay off to the side. Re-render the existing DOM in
    // place instead, preserving the scroll position (and the observers).
    const record = widgetObservers.get(dom)
    if (!record) return false
    record.update(this.model)
    return true
  }

  override ignoreEvent(): boolean {
    // The widget owns its clicks (cell-accurate click-to-edit), like the
    // checkbox; the app's delegated click handler still sees bubbled events.
    return true
  }

  override destroy(dom: HTMLElement): void {
    widgetObservers.get(dom)?.dispose()
    widgetObservers.delete(dom)
  }
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

/**
 * Rendered-table styling. `--ink-table-border` and `--ink-table-header-bg`
 * are the app's tuning hooks (light defaults declared in glyphdownTheme; dark
 * mode overrides them on the app side, the --ink-highlight-bg pattern).
 */
export const tableBaseTheme = EditorView.baseTheme({
  '.cm-ink-table-widget': {
    // Mirror .cm-line's horizontal padding so the table sits exactly in the
    // editor's text column — no jump when the source is revealed. Apps that
    // override the line padding tune --ink-table-inset to match.
    padding: 'var(--ink-table-inset, 0 16px)',
    // Design cap for the symmetric bleed (per side); the widget's observer
    // clamps the EFFECTIVE bleed to the editor's real available width and
    // writes it to --ink-table-bleed inline. A plain length (resolvable by
    // getComputedStyle) so apps can retune it without a clamp() the JS can't
    // read.
    '--ink-table-bleed-max': '96px',
    // The widget must never inflate the editor's content column: cm-content
    // is a flex item (flex-shrink: 0), so a max-content table inside it would
    // push the whole column past narrow viewports. Inline-size containment
    // zeroes the widget's intrinsic contribution; its used width still comes
    // from the column, and the scroll wrapper handles the overflow.
    contain: 'inline-size',
    // Anchor for the custom horizontal scrollbar, which is absolutely positioned
    // over the bottom of the (possibly bleeding) scroll box by updateBar().
    position: 'relative',
  },
  '.cm-ink-table-scroll': {
    // Columns size naturally (width: max-content) up to the prose column plus
    // a symmetric bleed allowance per side. --ink-table-bleed is set INLINE by
    // the widget's observer (clamped to the editor's real available width); the
    // 0px fallback keeps things sane before the first measure / without a RO.
    // Anything wider scrolls horizontally inside this wrapper, never the editor.
    width: 'max-content',
    maxWidth: 'calc(100% + 2 * var(--ink-table-bleed, 0px))',
    overflowX: 'auto',
    WebkitOverflowScrolling: 'touch',
    // Hide the PLATFORM horizontal scrollbar entirely: on macOS/Chromium it is a
    // zero-height overlay that stays invisible at rest (so the table read as
    // hard-clipped). The widget draws its own always-visible thumb instead
    // (.cm-ink-table-scrollbar). Firefox honors `none`; the webkit rule below
    // covers Chromium/Safari. Wheel/trackpad scrolling still works.
    scrollbarWidth: 'none',
    // Pre-measure fallback for the bottom gutter (= DEFAULT_BOTTOM_PADDING).
    // Once the widget measures, updateBar() rewrites this inline: the default
    // strip when the table fits, or a taller gutter when it overflows so the
    // add-row bar and the scrollbar stack below the table without overlapping
    // (see computeTableBottomGutter).
    paddingBottom: '12px',
  },
  // Only tables wider than the prose column (with room to bleed) center
  // themselves over it (the 50% + translate pair keeps the overhang symmetric);
  // narrower tables — and wide tables at viewports too tight to bleed — stay
  // left-aligned in the text column and scroll internally. The widget's
  // observer toggles the class.
  '.cm-ink-table-scroll.cm-ink-table-wide': {
    marginLeft: '50%',
    transform: 'translateX(-50%)',
  },
  // Subtle edge fade while internal-scrollable content remains hidden, so a cut
  // never looks like a clipped bug. Masked per side as the user scrolls; the
  // two gradients compose (right-only, left-only, or both). Reserve a hair past
  // the scrollbar so the thumb stays fully visible.
  '.cm-ink-table-scroll.cm-ink-table-clip-right': {
    maskImage: 'linear-gradient(to right, #000 calc(100% - 24px), transparent 100%)',
    WebkitMaskImage: 'linear-gradient(to right, #000 calc(100% - 24px), transparent 100%)',
  },
  '.cm-ink-table-scroll.cm-ink-table-clip-left': {
    maskImage: 'linear-gradient(to right, transparent 0, #000 24px)',
    WebkitMaskImage: 'linear-gradient(to right, transparent 0, #000 24px)',
  },
  '.cm-ink-table-scroll.cm-ink-table-clip-left.cm-ink-table-clip-right': {
    maskImage: 'linear-gradient(to right, transparent 0, #000 24px, #000 calc(100% - 24px), transparent 100%)',
    WebkitMaskImage: 'linear-gradient(to right, transparent 0, #000 24px, #000 calc(100% - 24px), transparent 100%)',
  },
  // Hide the platform horizontal scrollbar (the custom one replaces it). `none`
  // on the pseudo-element is the Chromium/Safari counterpart of
  // `scrollbar-width: none`.
  '.cm-ink-table-scroll::-webkit-scrollbar': { height: '0', width: '0', display: 'none' },
  // --- Custom always-visible horizontal scrollbar ---------------------------
  // A persistent, themeable, draggable thumb the widget positions over the
  // bottom of the visible scroll box. Hidden until the table overflows (the
  // `cm-ink-table-scrollable` class, toggled by updateBar). OS-independent: it
  // does not rely on overlay-scrollbar visibility, which macOS suppresses.
  '.cm-ink-table-scrollbar': {
    position: 'absolute',
    height: '8px',
    pointerEvents: 'none',
    opacity: '0',
    transition: 'opacity 120ms ease',
    zIndex: '1',
  },
  '.cm-ink-table-scrollbar.cm-ink-table-scrollbar-visible': {
    opacity: '1',
    pointerEvents: 'auto',
  },
  '.cm-ink-table-scrollbar-thumb': {
    position: 'absolute',
    top: '0',
    left: '0',
    height: '100%',
    minWidth: '32px',
    borderRadius: '4px',
    backgroundColor: 'var(--ink-table-scrollbar, #b3bcc6)',
    cursor: 'grab',
    touchAction: 'none',
  },
  '.cm-ink-table-scrollbar-thumb:hover': {
    backgroundColor: 'var(--ink-table-scrollbar-hover, #9aa6b2)',
  },
  '.cm-ink-table-scrollbar.cm-ink-table-dragging .cm-ink-table-scrollbar-thumb': {
    cursor: 'grabbing',
    backgroundColor: 'var(--ink-table-scrollbar-hover, #9aa6b2)',
  },
  '.cm-ink-table-rendered': {
    borderCollapse: 'collapse',
    margin: '4px 0',
    lineHeight: '1.5',
    width: 'max-content',
  },
  '.cm-ink-table-rendered th': {
    border: '1px solid var(--ink-table-border, #d7dde5)',
    padding: '4px 10px',
    textAlign: 'left',
    fontWeight: '600',
    backgroundColor: 'var(--ink-table-header-bg, rgba(135, 131, 120, 0.08))',
    // Word-boundary wrapping only: never break words mid-word ("Pro/duct").
    overflowWrap: 'normal',
    wordBreak: 'normal',
    whiteSpace: 'normal',
    verticalAlign: 'top',
  },
  '.cm-ink-table-rendered td': {
    border: '1px solid var(--ink-table-border, #d7dde5)',
    padding: '4px 10px',
    textAlign: 'left',
    overflowWrap: 'normal',
    wordBreak: 'normal',
    whiteSpace: 'normal',
    verticalAlign: 'top',
  },
  '.cm-ink-table-cell': {
    // Caps a prose cell's preferred width so long sentences wrap instead of
    // stretching the column indefinitely; columns of short words stay at
    // their natural width. Unbreakable tokens longer than the cap simply
    // widen their column (min-content wins) and the wrapper scrolls.
    maxWidth: 'var(--ink-table-cell-max, 38ch)',
  },
})
