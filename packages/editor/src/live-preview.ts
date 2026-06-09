import {
  type EditorState,
  type Extension,
  Facet,
  type Range as RangeValue,
  RangeSetBuilder,
  StateField,
  type Text,
} from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import type { SyntaxNode } from '@lezer/common'
import { commentBaseTheme, commentField } from './comment.ts'
import { CalloutHeaderWidget, calloutBaseTheme, fallbackCalloutTitle, parseCalloutHeader } from './callout.ts'
import { FootnoteRefWidget, footnoteBaseTheme } from './footnote.ts'
import { TableWidget, buildTableModel, tableBaseTheme } from './table.ts'
import { tableEditField, tableEditor } from './table-edit.ts'

// ---------------------------------------------------------------------------
// Selection helpers (SilverBullet's isCursorInRange pattern)
// ---------------------------------------------------------------------------

/**
 * Does any selection range touch [from, to] (boundaries included)?
 *
 * THE reveal gate for every live-preview surface: this module's reveal sites
 * and the modules with their own decoration fields (wikilink.ts, math.ts) all
 * route through this predicate (touchesLine delegates here too). In read-only
 * editors (viewer role, anonymous share-link visitors) it returns false
 * regardless of the selection: placing the cursor inside an element must
 * never reveal raw markdown — the document stays fully rendered, while
 * click/drag selection and copy keep working on the underlying text.
 * state.readOnly is read per call (never captured), so a runtime compartment
 * flip changes the answer on the very next recompute — the consuming fields
 * recompute on tr.reconfigured for exactly that reason.
 */
export function touchesSelection(state: EditorState, from: number, to: number): boolean {
  if (state.readOnly) return false
  return state.selection.ranges.some((r) => r.from <= to && r.to >= from)
}

/** Does any selection range touch the line(s) spanned by [from, to]? */
export function touchesLine(state: EditorState, from: number, to: number): boolean {
  const start = state.doc.lineAt(from).from
  const end = state.doc.lineAt(Math.min(to, state.doc.length)).to
  return touchesSelection(state, start, end)
}

// ---------------------------------------------------------------------------
// Widgets
// ---------------------------------------------------------------------------

/**
 * Pure change computation for toggling a `[ ]`/`[x]` task marker whose `[`
 * sits at `pos`. Returns null when the position does not hold a task marker.
 */
export function toggleCheckboxChange(doc: Text, pos: number): { from: number; to: number; insert: string } | null {
  const marker = doc.sliceString(pos, pos + 3)
  if (!/^\[[ xX]\]$/.test(marker)) return null
  const checked = marker[1] !== ' '
  return { from: pos + 1, to: pos + 2, insert: checked ? ' ' : 'x' }
}

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super()
  }

  override eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked
  }

  override toDOM(view: EditorView): HTMLElement {
    // A sized wrapper carries the hit area: a native-appearance checkbox is
    // ~13px and ignores `padding` (Chromium drops it on the UA widget), which
    // is below the 24px coarse-pointer tap-target floor. The wrapper is the
    // widget's DOM root, so click coordinates and posAtDOM resolve against it;
    // the inner <input> is purely visual (pointer-events disabled), so every
    // click in the 24px box lands on the wrapper's handler.
    const wrap = document.createElement('span')
    wrap.className = 'cm-ink-checkbox-wrap'
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.checked = this.checked
    box.tabIndex = -1
    box.className = 'cm-ink-checkbox'
    box.setAttribute('aria-label', 'Toggle task')
    wrap.appendChild(box)
    wrap.addEventListener('mousedown', (event) => {
      event.preventDefault()
      // Read-only editors (viewer/commenter roles) must treat the click as
      // inert: EditorState.readOnly does NOT block a programmatic dispatch, so
      // without this guard the toggle would mutate the local doc (and, via the
      // yCollab binding, the local Y.Text) even though the change can never be
      // synced — a misleading no-op edit. Bail before dispatching.
      if (view.state.readOnly) return
      // Look the position up at click time: the decoration set may have been
      // rebuilt/mapped since this DOM node was created.
      const pos = view.posAtDOM(wrap)
      const change = toggleCheckboxChange(view.state.doc, pos)
      if (change) view.dispatch({ changes: change, userEvent: 'input' })
    })
    // The browser toggles a checkbox's `checked` as the default action of the
    // *click* event (which fires after mousedown), independently of the doc.
    // Cancel it so the control is driven solely by the widget's `checked`
    // (rebuilt from the document on a real edit). Without this, a read-only
    // click would leave the box visually ticked despite no change, and an
    // editable click could briefly desync from the document.
    wrap.addEventListener('click', (event) => event.preventDefault())
    return wrap
  }

  override ignoreEvent(): boolean {
    return true
  }
}

class BulletWidget extends WidgetType {
  override eq(): boolean {
    // Every bullet renders the same glyph regardless of depth (Obsidian-style),
    // so all instances are interchangeable.
    return true
  }

  override toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-ink-list-bullet'
    span.textContent = '•'
    return span
  }

  override ignoreEvent(): boolean {
    // Let the editor handle pointer events: a click on the glyph places the
    // caret at the marker's position (revealing the raw `-`) instead of the
    // widget swallowing it.
    return false
  }
}

/** Shared instance — all bullets are identical (see eq above). */
const bulletWidget = new BulletWidget()

class HrWidget extends WidgetType {
  override eq(): boolean {
    // Every rule renders the same divider regardless of the written form
    // (`---`, `***`, `- - -`, …), so all instances are interchangeable.
    return true
  }

  override toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-ink-hr-widget'
    return span
  }

  override ignoreEvent(): boolean {
    // Let the editor handle pointer events: a click on the divider places the
    // caret on the rule's line, revealing the raw `---` (the BulletWidget
    // convention).
    return false
  }
}

/** Shared instance — all rules are identical (see eq above). */
const hrWidget = new HrWidget()

/**
 * Maps a doc-relative image src (`diagram.png`) to a fetchable URL — the app
 * provides one (e.g. `name.png` → `/api/docs/<id>/assets/name.png`). Default
 * is identity, so plain markdown previews still work without an app resolver.
 */
export const imageResolver = Facet.define<(src: string) => string, (src: string) => string>({
  combine: (values) => values[0] ?? ((src: string) => src),
})

/**
 * Run a markdown image src through the resolver — but only relative srcs:
 * anything with a scheme (http:, https:, data:, blob:, …) or starting with
 * '/' passes through untouched.
 */
export function resolveImageSrc(src: string, resolve: (src: string) => string): string {
  if (src === '' || src.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(src)) return src
  return resolve(src)
}

function imageFallback(label: string): HTMLElement {
  const span = document.createElement('span')
  span.className = 'cm-ink-image-placeholder'
  span.textContent = `\u{1F5BC} ${label || 'image'}`
  return span
}

export interface ImageSize {
  /** The alt text with any trailing `|<size>` suffix stripped. */
  alt: string
  width: number | null
  height: number | null
}

/**
 * Obsidian's image-sizing pipe syntax inside the alt text: `![alt|300](url)`
 * sets the width, `![alt|300x200](url)` width and height. The size suffix is
 * the segment after the LAST pipe, so alt text may itself contain pipes.
 * Returns the display alt (suffix stripped) plus the parsed dimensions.
 */
export function parseImageSize(alt: string): ImageSize {
  const m = /^(.*)\|([1-9]\d*)(?:x([1-9]\d*))?$/.exec(alt)
  if (!m) return { alt, width: null, height: null }
  return { alt: m[1]!, width: Number(m[2]), height: m[3] !== undefined ? Number(m[3]) : null }
}

class ImageWidget extends WidgetType {
  constructor(
    readonly alt: string,
    /** Resolved, fetchable URL ('' = no URL written yet). */
    readonly src: string,
    /** The src exactly as written in the markdown (broken-image label). */
    readonly original: string,
    /**
     * Block mode: rendered as its own line below the image's source line while
     * the raw syntax is revealed (Obsidian-style). Inline mode replaces the
     * syntax in place.
     */
    readonly block = false,
    /** Rendered width/height from the `|300`/`|300x200` alt suffix. */
    readonly width: number | null = null,
    readonly height: number | null = null,
  ) {
    super()
  }

  override eq(other: ImageWidget): boolean {
    return (
      other.alt === this.alt &&
      other.src === this.src &&
      other.original === this.original &&
      other.block === this.block &&
      other.width === this.width &&
      other.height === this.height
    )
  }

  override toDOM(): HTMLElement {
    const wrap = document.createElement(this.block ? 'div' : 'span')
    wrap.className = this.block ? 'cm-ink-image cm-ink-image-block' : 'cm-ink-image'
    wrap.title = this.original
    if (this.src === '') {
      wrap.appendChild(imageFallback(this.alt))
      return wrap
    }
    const img = document.createElement('img')
    img.src = this.src
    img.alt = this.alt
    img.setAttribute('loading', 'lazy')
    img.className = 'cm-ink-image-img'
    // Attribute (not style) sizing: the browser keeps the aspect ratio when
    // only the width is given, and the theme's maxWidth still caps overflow.
    if (this.width !== null) img.width = this.width
    if (this.height !== null) img.height = this.height
    img.addEventListener(
      'error',
      () => {
        // Broken image: a subtle placeholder showing the written filename.
        img.remove()
        wrap.appendChild(imageFallback(this.original || this.alt))
      },
      { once: true },
    )
    wrap.appendChild(img)
    return wrap
  }

  override ignoreEvent(): boolean {
    // Inline: let clicks place the cursor inside the image syntax (revealing
    // it). Block: clicks map to the widget's position at the line end, so the
    // selection stays in the editor and the reveal stays active.
    return false
  }
}

// ---------------------------------------------------------------------------
// Decoration computation
// ---------------------------------------------------------------------------

const HEADINGS: Record<string, number> = {
  ATXHeading1: 1,
  ATXHeading2: 2,
  ATXHeading3: 3,
  ATXHeading4: 4,
  ATXHeading5: 5,
  ATXHeading6: 6,
  SetextHeading1: 1,
  SetextHeading2: 2,
}

function hide(from: number, to: number): RangeValue<Decoration> {
  return Decoration.replace({ glyphdown: 'hide' }).range(from, to)
}

function lineClasses(state: EditorState, from: number, to: number, cls: string, out: RangeValue<Decoration>[]): void {
  const first = state.doc.lineAt(from).number
  const last = state.doc.lineAt(Math.min(to, state.doc.length)).number
  for (let n = first; n <= last; n++) {
    out.push(Decoration.line({ class: cls }).range(state.doc.line(n).from))
  }
}

/**
 * Deepest visual nesting level for blockquotes: each level stacks one more
 * left bar and one more padding step; quotes nested deeper than this clamp to
 * the d4 styling (Obsidian-style depth cue without unbounded indentation).
 */
export const MAX_QUOTE_DEPTH = 4

/** This Blockquote's nesting depth: 1 + the number of Blockquote ancestors. */
function blockquoteDepth(node: SyntaxNode): number {
  let depth = 1
  for (let p = node.parent; p; p = p.parent) if (p.name === 'Blockquote') depth++
  return depth
}

/** Record every line of [from, to] at `depth`; the innermost (max) depth wins. */
function recordQuoteLines(state: EditorState, from: number, to: number, depth: number, out: Map<number, number>): void {
  const first = state.doc.lineAt(from).number
  const last = state.doc.lineAt(Math.min(to, state.doc.length)).number
  for (let n = first; n <= last; n++) {
    const prev = out.get(n)
    if (prev === undefined || prev < depth) out.set(n, depth)
  }
}

function computeDecorations(state: EditorState): DecorationSet {
  const decos: RangeValue<Decoration>[] = []
  const doc = state.doc

  // Blockquote lines, collected across the whole tree and emitted once per
  // line AFTER the iteration: nested quotes cover the same lines with several
  // Blockquote nodes, and per-node emission would stack duplicate classes
  // with no depth information (a '>> deep' line styled identically to
  // '> shallow'). The innermost depth wins per line.
  const quoteDepths = new Map<number, number>()
  // Lines of a rendered callout that is itself nested inside a quote: the
  // border-left position belongs to the OUTER quote, so these lines keep the
  // quote's gray bar (cm-ink-callout-nested) while the callout accent lives
  // in its tint, icon, and title.
  const nestedCalloutLines = new Set<number>()

  syntaxTree(state).iterate({
    enter: (node): boolean | void => {
      const name = node.name

      // --- Headings -------------------------------------------------------
      const level = HEADINGS[name]
      if (level !== undefined) {
        lineClasses(state, node.from, node.to, `cm-ink-heading cm-ink-h${level}`, decos)
        if (name.startsWith('ATXHeading') && !touchesLine(state, node.from, node.to)) {
          for (const mark of node.node.getChildren('HeaderMark')) {
            const extra = doc.sliceString(mark.to, mark.to + 1) === ' ' ? 1 : 0
            if (mark.to + extra > mark.from) decos.push(hide(mark.from, mark.to + extra))
          }
        }
        return
      }

      switch (name) {
        // --- Inline formatting: hide delimiters unless touched -------------
        case 'Emphasis':
        case 'StrongEmphasis':
        case 'Strikethrough':
        case 'Highlight':
        case 'InlineCode': {
          if (name === 'InlineCode') {
            decos.push(Decoration.mark({ class: 'cm-ink-inline-code' }).range(node.from, node.to))
          }
          if (name === 'Highlight') {
            // The whole node carries the background (marks included), the
            // same shape as InlineCode's cm-ink-inline-code mark.
            decos.push(Decoration.mark({ class: 'cm-ink-highlight' }).range(node.from, node.to))
          }
          if (touchesSelection(state, node.from, node.to)) return
          const markName =
            name === 'InlineCode'
              ? 'CodeMark'
              : name === 'Strikethrough'
                ? 'StrikethroughMark'
                : name === 'Highlight'
                  ? 'HighlightMark'
                  : 'EmphasisMark'
          for (const mark of node.node.getChildren(markName)) {
            if (mark.to > mark.from) decos.push(hide(mark.from, mark.to))
          }
          return
        }

        // --- Links: render as a chip, reveal syntax on cursor entry --------
        case 'Link': {
          const n = node.node
          const marks = n.getChildren('LinkMark')
          const urlNode = n.getChild('URL')
          // URL-less Links stay plain text — no chip, no hidden brackets.
          // The parser emits these for callout headers (`> [!note]`, owned
          // by the Blockquote case), non-task bracket markers (`- [?]`),
          // shortcut/full reference links (`[foo]`, `[foo][bar]`), and a
          // wiki link's inner `[Title]` (owned by the wikiLinks() field).
          // Chipping them would misrender working syntax as dead links.
          // (Footnote refs `[^1]` now parse as FootnoteRef, not Link.)
          if (!urlNode) return
          const url = doc.sliceString(urlNode.from, urlNode.to)
          if (touchesSelection(state, node.from, node.to) || marks.length < 2) {
            return // revealed: full syntax, highlighted by the language
          }
          const open = marks[0]
          const close = marks.find((m) => doc.sliceString(m.from, m.to) === ']') ?? marks[1]
          if (!open || !close || close.from <= open.to) return
          const labelFrom = open.to
          const labelTo = close.from
          if (node.from < labelFrom) decos.push(hide(node.from, labelFrom))
          if (labelTo < node.to) decos.push(hide(labelTo, node.to))
          decos.push(
            Decoration.mark({
              class: 'cm-ink-link',
              attributes: { 'data-href': url, title: url },
            }).range(labelFrom, labelTo),
          )
          return
        }

        // --- Bare URLs (GFM autolinks): the same chip the app's click
        // handler already opens (it matches on `.cm-ink-link` + `data-href`,
        // not on Link nodes). Nothing is hidden, so the chip stays active
        // even when the selection touches it — exactly the text Obsidian
        // shows, just clickable. URL nodes inside Link/Image/LinkReference
        // are part of written syntax and stay untouched. --------------------
        case 'URL': {
          const parent = node.node.parent?.name
          if (parent === 'Link' || parent === 'Image' || parent === 'LinkReference') return
          const url = doc.sliceString(node.from, node.to)
          decos.push(
            Decoration.mark({
              glyphdown: 'autolink',
              class: 'cm-ink-link cm-ink-autolink',
              attributes: { 'data-href': url, title: url },
            }).range(node.from, node.to),
          )
          return
        }

        // --- Images: inline <img> widget (relative srcs via imageResolver).
        // Cursor on the line: Obsidian-style reveal — the raw syntax stays
        // visible and the same image renders as a block widget directly below
        // the line (one widget per image, in document order). ----------------
        case 'Image': {
          if (node.to <= node.from) return false
          const n = node.node
          const marks = n.getChildren('LinkMark')
          const urlNode = n.getChild('URL')
          const url = urlNode ? doc.sliceString(urlNode.from, urlNode.to) : ''
          const open = marks[0]
          const close = marks.find((m) => doc.sliceString(m.from, m.to) === ']')
          const rawAlt = open && close && close.from > open.to ? doc.sliceString(open.to, close.from) : ''
          // Obsidian sizing syntax: `![alt|300]` / `![alt|300x200]` — the
          // suffix sizes the <img> and is stripped from the displayed alt.
          const { alt, width, height } = parseImageSize(rawAlt)
          const src = resolveImageSrc(url, state.facet(imageResolver))
          if (touchesLine(state, node.from, node.to)) {
            // Revealed: keep the text untouched (decoration only — no doc
            // changes) and hang the rendered image below the line. side: 1 at
            // the line end keeps the widget after the caret's line, so the
            // caret position stays stable when the widget appears/disappears.
            decos.push(
              Decoration.widget({
                glyphdown: 'image-block',
                widget: new ImageWidget(alt, src, url, true, width, height),
                block: true,
                side: 1,
              }).range(doc.lineAt(node.to).to),
            )
          } else {
            decos.push(
              Decoration.replace({
                glyphdown: 'image',
                widget: new ImageWidget(alt, src, url, false, width, height),
              }).range(node.from, node.to),
            )
          }
          return false
        }

        // --- Task list checkboxes -------------------------------------------
        case 'Task': {
          const marker = node.node.getChild('TaskMarker')
          if (!marker) return
          const checked = /x/i.test(doc.sliceString(marker.from, marker.to))
          lineClasses(state, marker.from, marker.from, checked ? 'cm-ink-task cm-ink-task-done' : 'cm-ink-task', decos)
          if (checked && node.to > marker.to) {
            // Strike through the task's text only. A line-level
            // text-decoration would also strike the leading indent
            // whitespace, which reads as a stray dash floating before the
            // checkbox once the `- ` marker is hidden.
            decos.push(Decoration.mark({ class: 'cm-ink-task-done-text' }).range(marker.to, node.to))
          }
          if (!touchesLine(state, marker.from, marker.to)) {
            decos.push(
              Decoration.replace({ glyphdown: 'checkbox', widget: new CheckboxWidget(checked) }).range(
                marker.from,
                marker.to,
              ),
            )
          }
          return
        }

        // --- Block styling ---------------------------------------------------
        case 'Blockquote': {
          // Obsidian callout: `> [!type] Optional Title`. Away from the
          // selection the marker renders as an icon'd, type-colored title row
          // over tinted lines; the caret anywhere inside the blockquote
          // reveals the raw syntax (the standard blockquote rendering, with
          // its per-line QuoteMark reveal). Fold markers (`[!type]-`) render
          // the same as plain callouts — flat, no folding in v1.
          const depth = blockquoteDepth(node.node)
          const callout = parseCalloutHeader(state, node.node)
          if (callout && !touchesSelection(state, node.from, node.to)) {
            lineClasses(state, node.from, node.to, `cm-ink-callout cm-ink-callout-${callout.canonical}`, decos)
            const hasTitle = callout.titleFrom < callout.titleTo
            decos.push(
              Decoration.replace({
                glyphdown: 'callout-header',
                widget: new CalloutHeaderWidget(
                  callout.canonical,
                  hasTitle ? null : fallbackCalloutTitle(callout.written),
                ),
                // Replace up to the title start (marker + padding spaces) so
                // the icon sits flush against the title text; without a
                // written title this swallows the whole header-line rest.
              }).range(callout.markerFrom, callout.titleFrom),
            )
            if (hasTitle) {
              decos.push(Decoration.mark({ class: 'cm-ink-callout-title' }).range(callout.titleFrom, callout.titleTo))
            }
            // A top-level callout owns level 1 itself (accent border + tint —
            // no quote-depth classes; the existing callout contract). Nested
            // in a quote it still occupies a quote nesting level: record its
            // lines for the depth padding/bars and tag them so the theme
            // keeps the outer quote's gray bar at the border position.
            if (depth > 1) {
              recordQuoteLines(state, node.from, node.to, depth, quoteDepths)
              const first = doc.lineAt(node.from).number
              const last = doc.lineAt(Math.min(node.to, doc.length)).number
              for (let n = first; n <= last; n++) nestedCalloutLines.add(n)
            }
            return // descend: body formatting and QuoteMark hiding still apply
          }
          recordQuoteLines(state, node.from, node.to, depth, quoteDepths)
          return
        }
        case 'QuoteMark': {
          // Per-line reveal (Obsidian): the `>` (plus its following space)
          // hides on lines the caret is not on — the blockquote line's
          // border/muted styling alone marks the quote. Nested `>>` works
          // since each `>` is its own QuoteMark node.
          if (touchesLine(state, node.from, node.to)) {
            decos.push(Decoration.mark({ class: 'cm-ink-quote-mark' }).range(node.from, node.to))
            return
          }
          const extra = doc.sliceString(node.to, node.to + 1) === ' ' ? 1 : 0
          decos.push(hide(node.from, node.to + extra))
          return
        }
        case 'ListMark': {
          const markText = doc.sliceString(node.from, node.to)
          const isBullet = markText === '-' || markText === '*' || markText === '+'
          // Ordered-list markers (`1.` / `2)`) always stay as written; bullet
          // markers reveal their raw form when the caret is on the line (the
          // same line convention the task checkbox uses).
          if (!isBullet || touchesLine(state, node.from, node.to)) {
            decos.push(Decoration.mark({ class: 'cm-ink-list-mark' }).range(node.from, node.to))
            return
          }
          if (node.node.parent?.getChild('Task')) {
            // Task line: the checkbox alone represents the item, so the marker
            // and its following space disappear entirely. The checkbox then
            // starts at the exact column where a sibling bullet's glyph sits,
            // keeping nested tasks and bullets at the same depth aligned.
            const extra = doc.sliceString(node.to, node.to + 1) === ' ' ? 1 : 0
            decos.push(hide(node.from, node.to + extra))
            return
          }
          // Plain bullet item: swap the marker char for a real bullet glyph.
          // Widget semantics keep the glyph out of text selection/copy.
          decos.push(Decoration.replace({ glyphdown: 'bullet', widget: bulletWidget }).range(node.from, node.to))
          return
        }
        case 'FencedCode':
          lineClasses(state, node.from, node.to, 'cm-ink-code-block', decos)
          return
        case 'HorizontalRule':
          lineClasses(state, node.from, node.to, 'cm-ink-hr', decos)
          if (touchesLine(state, node.from, node.to)) {
            // Caret on the line: the raw `---` stays, gray-styled.
            decos.push(Decoration.mark({ class: 'cm-ink-hr-mark' }).range(node.from, node.to))
            return
          }
          // Elsewhere: the whole rule (incl. spaced forms like `- - -`)
          // renders as a full-width divider; a click places the caret.
          decos.push(Decoration.replace({ glyphdown: 'hr', widget: hrWidget }).range(node.from, node.to))
          return
        case 'Table': {
          // Block replace decorations must span whole lines.
          const from = doc.lineAt(node.from).from
          const to = doc.lineAt(node.to).to
          // A table with an open WYSIWYG cell overlay stays rendered even if
          // the selection drifts into its source (suggest mode parks the
          // cursor at its replayed edits) — otherwise the widget under the
          // overlay would flip to raw source mid-edit.
          const editPos = state.field(tableEditField, false) ?? null
          const pinned = editPos !== null && editPos >= from && editPos <= to
          // Selection on any of the table's lines (and not pinned): raw
          // monospace source (the editing view). Elsewhere: the whole block
          // renders as a real <table> widget; clicking a cell opens the cell
          // overlay (editable docs) or places the caret inside the source.
          if (!pinned && touchesLine(state, node.from, node.to)) {
            lineClasses(state, node.from, node.to, 'cm-ink-table', decos)
            return false
          }
          const model = buildTableModel(state, node.node, from)
          if (!model) {
            lineClasses(state, node.from, node.to, 'cm-ink-table', decos)
            return false
          }
          decos.push(
            Decoration.replace({ glyphdown: 'table', widget: new TableWidget(model), block: true }).range(from, to),
          )
          return false
        }

        // --- Footnotes: superscript ref chips, muted definition lines ------
        case 'FootnoteRef': {
          if (touchesSelection(state, node.from, node.to)) return // revealed: raw syntax
          const labelNode = node.node.getChild('FootnoteRefLabel')
          const label = labelNode ? doc.sliceString(labelNode.from, labelNode.to) : ''
          decos.push(
            Decoration.replace({ glyphdown: 'footnote-ref', widget: new FootnoteRefWidget(label) }).range(
              node.from,
              node.to,
            ),
          )
          return false
        }
        case 'FootnoteDefinition': {
          // The definition keeps its written syntax (Obsidian parity); the
          // lines are muted and the `[^label]:` mark carries the accent.
          lineClasses(state, node.from, node.to, 'cm-ink-footnote-def', decos)
          const defMarks = node.node.getChildren('FootnoteDefMark')
          const lastMark = defMarks[defMarks.length - 1]
          if (defMarks[0] && lastMark && lastMark.to > defMarks[0].from) {
            decos.push(Decoration.mark({ class: 'cm-ink-footnote-def-label' }).range(defMarks[0].from, lastMark.to))
          }
          return // descend: the body's inline formatting still renders
        }
        case 'Frontmatter':
          lineClasses(state, node.from, node.to, 'cm-ink-frontmatter', decos)
          return
      }
    },
  })

  // One blockquote line decoration per quoted line, carrying the innermost
  // depth (clamped): cm-ink-bq-d1 lines render today's single border, deeper
  // lines stack one bar + one padding step per level (the base theme's
  // cm-ink-bq-d2..d4 rules). Caret position never changes line classes, so
  // padding/indent are identical between rendered and revealed states.
  for (const [n, depth] of quoteDepths) {
    const d = Math.min(depth, MAX_QUOTE_DEPTH)
    const nested = nestedCalloutLines.has(n) ? ' cm-ink-callout-nested' : ''
    decos.push(Decoration.line({ class: `cm-ink-blockquote cm-ink-bq-d${d}${nested}` }).range(doc.line(n).from))
  }

  return Decoration.set(decos, true)
}

// ---------------------------------------------------------------------------
// The state field
// ---------------------------------------------------------------------------

/**
 * Live-preview decorations computed from the Lezer syntax tree. Recomputed on
 * doc changes, selection changes, async parse progress, and reconfiguration
 * (a readOnly compartment flip changes the reveal gate's answer — see
 * touchesSelection); reused untouched for all other transactions.
 */
export const livePreviewField = StateField.define<DecorationSet>({
  create: computeDecorations,
  update(value, tr) {
    if (
      tr.docChanged ||
      tr.selection ||
      tr.reconfigured ||
      syntaxTree(tr.state) !== syntaxTree(tr.startState)
    ) {
      return computeDecorations(tr.state)
    }
    return value
  },
  provide: (f) => EditorView.decorations.from(f),
})

// ---------------------------------------------------------------------------
// List hanging indents
// ---------------------------------------------------------------------------

/**
 * Source prefix of every line that belongs to a list item, keyed by the
 * line-start position. The prefix is the text a soft-wrapped continuation
 * should hang under:
 *
 * - On an item's marker line: leading indent + marker + trailing space(s) up
 *   to the content start (`'- '`, `'12. '`, `'- [ ] '`, `'  - '`, `'> - '`).
 *   The content start comes from the syntax tree (the node after ListMark /
 *   TaskMarker), so multi-space gaps after a marker measure exactly.
 * - On the item's hard continuation lines (lazy or indented lines of a
 *   multi-line Paragraph, later paragraphs, nested code…): the line's own
 *   leading whitespace (plus any blockquote `>` prefix) — the wrap then
 *   aligns under that line's first visible character.
 *
 * Nested items overwrite their parent's entries (the tree iterates parents
 * first), so the innermost list context wins for every line.
 */
export function listHangPrefixes(state: EditorState, from: number, to: number): Map<number, string> {
  const doc = state.doc
  const prefixes = new Map<number, string>()
  const firstLine = doc.lineAt(from).number
  const lastLine = doc.lineAt(Math.min(to, doc.length)).number
  syntaxTree(state).iterate({
    from,
    to,
    enter: (node): void => {
      if (node.name !== 'ListItem') return
      const item = node.node
      const mark = item.getChild('ListMark')
      if (!mark) return
      const markerLine = doc.lineAt(mark.from)
      // Content start on the marker line: after `[ ] ` for tasks, otherwise
      // the first sibling after the marker (skips the marker's space run).
      let content: number
      const taskMarker = item.getChild('Task')?.getChild('TaskMarker') ?? null
      if (taskMarker) {
        content = taskMarker.to + (doc.sliceString(taskMarker.to, taskMarker.to + 1) === ' ' ? 1 : 0)
      } else {
        const sibling = mark.nextSibling
        content =
          sibling && sibling.from > mark.to && sibling.from <= markerLine.to
            ? sibling.from
            : Math.min(mark.to + 1, markerLine.to)
      }
      if (markerLine.number >= firstLine && markerLine.number <= lastLine) {
        prefixes.set(markerLine.from, doc.sliceString(markerLine.from, content))
      }
      const itemLast = doc.lineAt(Math.min(item.to, doc.length)).number
      for (let n = Math.max(markerLine.number + 1, firstLine); n <= Math.min(itemLast, lastLine); n++) {
        const line = doc.line(n)
        // `>` rides along so blockquoted continuations hang past the quote
        // marker column too.
        prefixes.set(line.from, /^[ \t>]*/.exec(line.text)![0])
      }
    },
  })
  return prefixes
}

/**
 * Measures list prefixes in pixels with a canvas 2D context using the
 * editor's computed content font. The prose font is proportional, so a
 * ch-based estimate is visibly wrong (in Inter at 17px, `'- '` measures
 * ~12.6px while `2ch` is ~21.4px and `'- [ ] '` ~34.6px vs ~64.3px for
 * `6ch`) — canvas measureText matches DOM layout within a fraction of a
 * pixel. Where canvas 2D is unavailable (jsdom, SSR) it falls back to 1ch
 * per character, which keeps tests deterministic.
 */
let measureCtx: CanvasRenderingContext2D | null = null
let measureCtxProbed = false

/** One shared 2D context for all editors (the font is set per measurement). */
function measureContext(): CanvasRenderingContext2D | null {
  if (!measureCtxProbed) {
    measureCtxProbed = true
    try {
      measureCtx = document.createElement('canvas').getContext('2d')
    } catch {
      measureCtx = null
    }
  }
  return measureCtx
}

/**
 * Tabs render to the next tab stop; a tabSize-space run approximates that
 * closely enough for the rare tab-indented list.
 */
function expandTabs(text: string, tabSize: number): string {
  return text.includes('\t') ? text.replace(/\t/g, ' '.repeat(tabSize)) : text
}

class PrefixMeasurer {
  private font = ''
  private widths = new Map<string, string>()

  /** Re-read the content font; true when it changed (cache dropped). */
  refresh(view: EditorView): boolean {
    if (!measureContext()) return false
    const cs = window.getComputedStyle(view.contentDOM)
    // Detached DOM (pre-mount) yields empty values — keep the old font.
    if (!cs.fontSize || !cs.fontFamily) return false
    const font = `${cs.fontStyle || 'normal'} ${cs.fontWeight || 'normal'} ${cs.fontSize} ${cs.fontFamily}`
    if (font === this.font) return false
    this.font = font
    this.widths.clear()
    return true
  }

  /** Drop cached widths (webfont arrival changes metrics, not the font string). */
  invalidate(): void {
    this.widths.clear()
  }

  /** Advance of source text in the content font (px), or null without canvas 2D. */
  px(text: string, tabSize: number): number | null {
    const ctx = measureContext()
    if (!ctx || this.font === '') return null
    ctx.font = this.font
    return ctx.measureText(expandTabs(text, tabSize)).width
  }

  /** CSS length for a prefix: measured px, or `<n>ch` without canvas 2D. */
  css(prefix: string, tabSize: number): string {
    const cached = this.widths.get(prefix)
    if (cached !== undefined) return cached
    const px = this.px(prefix, tabSize)
    const value = px !== null ? `${Math.round(px * 100) / 100}px` : `${expandTabs(prefix, tabSize).length}ch`
    this.widths.set(prefix, value)
    return value
  }

  /**
   * CSS length for a marker-line prefix whose marker is currently REPLACED by
   * a live-preview widget (bullet glyph / task checkbox), computed from the
   * RENDERED geometry via renderedHangWidth. Null when the prefix has no
   * replaceable marker (ordered markers and continuation indents render as
   * written — the source measurement is already exact).
   *
   * Without canvas 2D the still-rendered text falls back to 1ch per character
   * (matching css()); the bullet widget is 1ch by the base theme, and the
   * checkbox's px advance is composed in with calc().
   */
  renderedCss(prefix: string, tabSize: number, metrics: () => RenderedMarkerMetrics): string | null {
    if (measureContext() && this.font !== '') {
      const hang = renderedHangWidth(prefix, (text) => this.px(text, tabSize) ?? 0, metrics())
      return hang === null ? null : `${Math.round(hang.width * 100) / 100}px`
    }
    const hang = renderedHangWidth(prefix, (text) => expandTabs(text, tabSize).length, { bulletPx: 1, checkboxPx: 0 })
    if (hang === null) return null
    if (hang.kind === 'bullet') return `${hang.width}ch`
    return hang.width > 0 ? `calc(${hang.width}ch + ${CHECKBOX_ADVANCE_PX}px)` : `${CHECKBOX_ADVANCE_PX}px`
  }
}

/**
 * Effective advance of the resting checkbox widget per the base theme:
 * cm-ink-checkbox-wrap is a 24px border-box with -6px/-2px horizontal margins
 * → it advances the line by 16px. Fallback for when no live widget node is
 * available to measure (first build, or a doc whose tasks are off-screen).
 */
const CHECKBOX_ADVANCE_PX = 16

/** Effective advance widths (px) of the live-preview marker widgets. */
export interface RenderedMarkerMetrics {
  /** The bullet glyph: cm-ink-list-bullet, a 1ch inline-block. */
  bulletPx: number
  /** The checkbox: cm-ink-checkbox-wrap's visual box plus its (negative) horizontal margins. */
  checkboxPx: number
}

export interface RenderedHang {
  kind: 'bullet' | 'task'
  /** Total rendered prefix advance: still-rendered source text + widget. */
  width: number
}

/**
 * A prefix with its blockquote marks removed — each `>` plus the single
 * following space, exactly the range the livePreviewField hides per
 * QuoteMark. Resting quote lines render without their marks, so their hang
 * must measure only what still shows ('>' only ever appears in hang prefixes
 * as a quote mark).
 */
function stripQuoteMarks(prefix: string): string {
  return prefix.replace(/> ?/g, '')
}

/**
 * Hang width of a marker-line prefix in the RESTING live-preview state, where
 * the marker is replaced by a widget. The decomposition mirrors exactly what
 * the livePreviewField does to the prefix text:
 *
 * - Task `- [ ] `: the list marker plus ONE following space is hidden and the
 *   `[ ]` is replaced by the checkbox widget. Everything else — leading
 *   indent, extra spaces before the brackets, the space after them — still
 *   renders as text and is measured via `measure`.
 * - Bullet `- `: only the single marker character is replaced by the glyph
 *   widget; the indent and the space run after it render as text.
 * - Quote marks in the leading indent (`> - `, `>> - `): hidden along with
 *   one following space each on resting lines (the QuoteMark hiding), so
 *   they contribute nothing — only the residual indent measures.
 *
 * Returns null for prefixes with no replaceable marker (ordered markers and
 * continuation indents always render as written). Pure: text measurement and
 * widget metrics are injected, so the math is unit-testable with fakes.
 */
export function renderedHangWidth(
  prefix: string,
  measure: (text: string) => number,
  metrics: RenderedMarkerMetrics,
): RenderedHang | null {
  const task = /^([ \t>]*)[-*+] ([ \t]*)\[[xX ]\]( ?)$/.exec(prefix)
  if (task) {
    return {
      kind: 'task',
      width: measure(stripQuoteMarks(task[1]!) + task[2]!) + metrics.checkboxPx + measure(task[3]!),
    }
  }
  const bullet = /^([ \t>]*)[-*+]([ \t]+)$/.exec(prefix)
  if (bullet) {
    return { kind: 'bullet', width: measure(stripQuoteMarks(bullet[1]!)) + metrics.bulletPx + measure(bullet[2]!) }
  }
  return null
}

/**
 * Is a marker inside [from, to] currently replaced by a live-preview widget
 * (bullet glyph or task checkbox)? Reads the livePreviewField's actual output
 * rather than replicating its reveal logic, so the answer tracks the field
 * exactly (caret on the line reveals the source marker; readOnly and suggest
 * variants need no special-casing). Without the field — listHangingIndent
 * used standalone — markers are never replaced and this stays false.
 */
function markerReplaced(state: EditorState, from: number, to: number): boolean {
  const decorations = state.field(livePreviewField, false)
  if (!decorations) return false
  let replaced = false
  decorations.between(from, to, (_from, _to, deco) => {
    const tag = (deco.spec as { glyphdown?: unknown }).glyphdown
    if (tag === 'bullet' || tag === 'checkbox') {
      replaced = true
      return false
    }
  })
  return replaced
}

/**
 * Horizontal advance an inline widget adds to its line: border-box width plus
 * horizontal margins (the checkbox wrap relies on negative margins). Null when
 * the node has no real layout (jsdom, display:none) so callers fall back to
 * the theme constants.
 */
function widgetAdvance(el: Element | null): number | null {
  if (!el) return null
  const rect = el.getBoundingClientRect()
  if (!(rect.width > 0)) return null
  const cs = window.getComputedStyle(el)
  return rect.width + (Number.parseFloat(cs.marginLeft) || 0) + (Number.parseFloat(cs.marginRight) || 0)
}

/** One shared Decoration per distinct hang width (values repeat heavily). */
const hangDecoCache = new Map<string, Decoration>()

function hangDeco(width: string): Decoration {
  let deco = hangDecoCache.get(width)
  if (!deco) {
    deco = Decoration.line({
      class: 'cm-ink-list-line',
      attributes: { style: `--ink-hang: ${width}` },
    })
    hangDecoCache.set(width, deco)
  }
  return deco
}

/**
 * Hanging indents for list items (Obsidian behavior): every line of a list
 * item gets `--ink-hang: <width of its source prefix>` plus the
 * cm-ink-list-line class; the base theme turns that into a negative
 * text-indent compensated by padding-left, so the FIRST rendered line of each
 * source line stays exactly where it is today and only soft-wrapped
 * continuations move (to the item's content column).
 *
 * The hang is STATE-AWARE. A revealed line (caret on it) shows the raw source
 * marker, so the hang is the measured source prefix. A resting line has its
 * marker REPLACED by the live preview — bullets render as the 1ch glyph
 * widget, task markers as the 16px checkbox with the `- ` hidden — which is
 * narrower than the source text it stands in for, so the hang is instead
 * computed from the rendered geometry (renderedHangWidth: still-rendered
 * source text canvas-measured + the widget's effective advance, preferring a
 * live widget DOM measurement over the theme constants). Ordered-list markers
 * are never replaced, so their hang is identical in both states.
 *
 * Caret moves across marker lines therefore reflow that line's soft wraps by
 * the small source↔rendered difference — the same shift the reveal itself
 * already causes — while the FIRST rendered line never moves: the negative
 * text-indent and the padding-left cancel exactly for any hang value.
 *
 * A view plugin (not a state field) because the width measurement needs the
 * view's computed font; line decorations are safe to provide from a plugin.
 */
export const listHangingIndent = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    private readonly measurer = new PrefixMeasurer()
    private stale = false
    // Widget advances measured from live decoration DOM, cached until the
    // font/geometry changes. Null = not measured yet (no widget on screen);
    // the theme-exact fallbacks (1ch bullet via canvas '0', 16px checkbox)
    // are used and the DOM is re-probed on the next build.
    private domBulletPx: number | null = null
    private domCheckboxPx: number | null = null
    private readonly onFontsLoaded = (): void => {
      // A webfont finished loading: glyph metrics changed under the same
      // font string. Drop the caches and schedule a rebuild.
      this.measurer.invalidate()
      this.domBulletPx = null
      this.domCheckboxPx = null
      this.stale = true
      this.view.dispatch()
    }

    constructor(private readonly view: EditorView) {
      this.measurer.refresh(view)
      this.decorations = this.build(view)
      // document.fonts is missing in jsdom — guard the whole chain.
      if (typeof document !== 'undefined' && document.fonts?.addEventListener) {
        document.fonts.addEventListener('loadingdone', this.onFontsLoaded)
      }
    }

    update(update: ViewUpdate): void {
      // geometryChanged covers mount and font-size/zoom changes — the moments
      // the computed font can change. Selection changes rebuild too: the hang
      // is reveal-state aware (a caret entering a marker line swaps that
      // line's hang from rendered-widget width back to source width — except
      // in read-only editors, where markers stay replaced and the rendered
      // width applies permanently). Reconfigures rebuild for the same reason:
      // a readOnly compartment flip changes which state each line is in.
      const fontChanged = update.geometryChanged && this.measurer.refresh(update.view)
      if (fontChanged) {
        this.domBulletPx = null
        this.domCheckboxPx = null
      }
      if (
        this.stale ||
        fontChanged ||
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        update.transactions.some((tr) => tr.reconfigured) ||
        syntaxTree(update.state) !== syntaxTree(update.startState)
      ) {
        this.stale = false
        this.decorations = this.build(update.view)
      }
    }

    destroy(): void {
      if (typeof document !== 'undefined' && document.fonts?.removeEventListener) {
        document.fonts.removeEventListener('loadingdone', this.onFontsLoaded)
      }
    }

    /**
     * Widget advances for the rendered-state math: a live widget node when
     * one is on screen (apps may restyle the widgets), else the theme-exact
     * fallbacks — the bullet is pinned to 1ch, which is BY DEFINITION the
     * advance of '0' in the content font, and the checkbox wrap nets 16px.
     * DOM reads happen at most once per font epoch (results are cached).
     */
    private metrics(view: EditorView): RenderedMarkerMetrics {
      this.domBulletPx ??= widgetAdvance(view.contentDOM.querySelector('.cm-ink-list-bullet'))
      this.domCheckboxPx ??= widgetAdvance(view.contentDOM.querySelector('.cm-ink-checkbox-wrap'))
      return {
        bulletPx: this.domBulletPx ?? this.measurer.px('0', view.state.tabSize) ?? 0,
        checkboxPx: this.domCheckboxPx ?? CHECKBOX_ADVANCE_PX,
      }
    }

    private build(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>()
      const state = view.state
      const tabSize = state.tabSize
      // Without the field (standalone plugin) nothing is ever hidden or
      // replaced — every prefix renders as written.
      const hasField = state.field(livePreviewField, false) !== undefined
      // Lazy and at most once per build — only resting bullet/task lines pay
      // for the widget-metrics lookup.
      let metrics: RenderedMarkerMetrics | undefined
      const metricsOnce = (): RenderedMarkerMetrics => (metrics ??= this.metrics(view))
      for (const range of view.visibleRanges) {
        const prefixes = listHangPrefixes(state, range.from, range.to)
        for (const pos of Array.from(prefixes.keys()).sort((a, b) => a - b)) {
          const prefix = prefixes.get(pos)!
          if (prefix === '') continue // zero hang — leave the line untouched
          // Resting line (caret away — always, in read-only editors): the
          // live preview hides any quote marks in the prefix, so the hang
          // measures only what still renders. Revealed lines keep the full
          // source measurement — exact for the raw text the caret is showing.
          const resting = hasField && !touchesLine(state, pos, pos + prefix.length)
          // Resting marker line (bullet/checkbox widget active): hang wrapped
          // lines off the RENDERED prefix so they align with the visible text
          // start (renderedCss strips hidden quote marks itself).
          const rendered =
            resting && markerReplaced(state, pos, pos + prefix.length)
              ? this.measurer.renderedCss(prefix, tabSize, metricsOnce)
              : null
          const source = resting ? stripQuoteMarks(prefix) : prefix
          if (rendered === null && source === '') continue // marks fully hidden — zero hang
          builder.add(pos, pos, hangDeco(rendered ?? this.measurer.css(source, tabSize)))
        }
      }
      return builder.finish()
    }
  },
  { decorations: (plugin) => plugin.decorations },
)

// style-mod's StyleSpec, without depending on the transitive package directly.
type ThemeSpec = Parameters<typeof EditorView.baseTheme>[0]

/**
 * The quote bar geometry: every nesting level advances by the line's base
 * padding (--ink-line-pad, the gap between a bar and what follows it) plus
 * the 3px bar itself, mirroring the level-1 metrics (3px border-left + base
 * padding). Routed through the same tokens as level 1 so the app's dark mode
 * tunes one var (--ink-block-border) for every depth.
 */
const QUOTE_BAR_COLOR = 'var(--ink-block-border, #cbd5e1)'
const QUOTE_PAD = 'var(--ink-line-pad, 14px)'

/** [left, right] edges of the level-k bar (k ≥ 2) inside the padding box. */
function quoteBarEdges(k: number): [string, string] {
  // Level 1 is the border-left, sitting just OUTSIDE the padding box; bar k
  // starts after k-1 gaps and k-2 inner 3px bars.
  const left = `${QUOTE_PAD} * ${k - 1} + ${(k - 2) * 3}px`
  return [`calc(${left})`, `calc(${left} + 3px)`]
}

/**
 * background-image drawing the level 2..depth bars as a single multi-stop
 * gradient (transparent between bars). Level 1 stays the real border-left, so
 * a depth-1 quote renders exactly as before; gradient coordinates live in the
 * padding box, so the bars hold position whatever the padding value is.
 */
function quoteBars(depth: number): string {
  const stops: string[] = []
  let prev = '0'
  for (let k = 2; k <= depth; k++) {
    const [left, right] = quoteBarEdges(k)
    stops.push(`transparent ${prev} ${left}`, `${QUOTE_BAR_COLOR} ${left} ${right}`)
    prev = right
  }
  stops.push(`transparent ${prev}`)
  return `linear-gradient(to right, ${stops.join(', ')})`
}

const livePreviewRules: ThemeSpec = {
  '.cm-ink-blockquote': {
    // Left rule + muted ink route through vars so the app's dark mode can tune
    // them for contrast (the --ink-highlight-bg pattern); the fallbacks keep
    // the package's light defaults when used standalone.
    borderLeft: '3px solid var(--ink-block-border, #cbd5e1)',
    paddingLeft: '14px',
    color: 'var(--ink-block-muted, #5f6b7a)',
    // Quotes read as set-apart, slightly literary text. fontStyle lives on the
    // always-present line class (both resting + revealed states) → reflow-safe.
    fontStyle: 'italic',
    // Keep the hang rule's base padding in lockstep with this paddingLeft:
    // whichever rule wins the padding cascade also supplies the var the
    // cm-ink-list-line calc() reads.
    '--ink-line-pad': '14px',
  },
}

// Nested-quote depth classes (cm-ink-bq-d2..d4; d1 is the plain blockquote
// rule above, and deeper quotes clamp to d4). Each level stacks one more bar
// (gradient, level 1 stays the border-left) and one more padding step
// (--ink-bq-extra, composed into the padding calc below AND the list hang
// rule). The padding rule doubles the class to outrank the app's three-class
// `.ink-editor .cm-editor .cm-line` shorthand — but it is declared BEFORE the
// cm-ink-list-line rule, so on a list line inside a deep quote the hang rule
// wins the tie and supplies the (depth-aware) padding itself.
for (let d = 2; d <= MAX_QUOTE_DEPTH; d++) {
  livePreviewRules[`.cm-ink-bq-d${d}`] = {
    '--ink-bq-extra': `calc((${QUOTE_PAD} + 3px) * ${d - 1})`,
    backgroundImage: quoteBars(d),
  }
  livePreviewRules[`.cm-line.cm-ink-bq-d${d}.cm-ink-bq-d${d}`] = {
    paddingLeft: `calc(${QUOTE_PAD} + var(--ink-bq-extra, 0px))`,
  }
}

Object.assign(livePreviewRules, {
  // Hanging indent for list lines: the line plugin sets `--ink-hang` (the
  // measured width of the line's source prefix) inline; the negative
  // text-indent pulls the FIRST rendered line back to its usual spot while
  // the padding pushes soft-wrapped continuations to the item's content
  // column. --ink-line-pad must always equal the padding-left the line would
  // have WITHOUT this rule (set next to every padding-left declaration, incl.
  // the app's), so first lines never move — plus the quote-depth extra when
  // the item sits inside a nested quote. The class is doubled to outrank
  // the app's three-class `.ink-editor .cm-editor .cm-line { padding: … }`
  // shorthand, which would otherwise reset padding-left on specificity tie.
  '.cm-line.cm-ink-list-line.cm-ink-list-line': {
    textIndent: 'calc(-1 * var(--ink-hang, 0px))',
    paddingLeft: 'calc(var(--ink-line-pad, 16px) + var(--ink-bq-extra, 0px) + var(--ink-hang, 0px))',
  },
  // text-indent INHERITS: an inline-block widget on the line (bullet glyph,
  // math, …) is its own block container, so without this reset its first
  // line — the widget's content — would shift left by the hang too.
  '.cm-ink-list-line *': { textIndent: '0' },
  '.cm-ink-quote-mark': { color: 'var(--ink-faint, #9ca3af)' },
  '.cm-ink-list-mark': { color: 'var(--ink-faint, #9ca3af)' },
  '.cm-ink-list-bullet': {
    // Stands in for the one-char `-`/`*`/`+` marker: pinning the glyph to 1ch
    // and centering it keeps the following text from shifting when the caret
    // enters the line and the raw marker is revealed.
    display: 'inline-block',
    width: '1ch',
    textAlign: 'center',
    color: 'var(--ink-faint, #9ca3af)',
  },
  '.cm-ink-code-block': {
    backgroundColor: 'var(--ink-code-bg, rgba(135, 131, 120, 0.08))',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: '0.9em',
    // A denser per-element line-height for monospace (the ~1.65 body rhythm is
    // too airy for code); applied to the line, so it never reflows on reveal.
    lineHeight: '1.5',
  },
  '.cm-ink-inline-code': {
    backgroundColor: 'var(--ink-code-bg-inline, rgba(135, 131, 120, 0.15))',
    // The app's chip radius (matches the inline `code` element in styles.css).
    borderRadius: '4px',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: '0.85em',
    // Horizontal breathing only — vertical padding on an inline chip would
    // inflate the line box and break body rhythm (the inline-code gate).
    padding: '0 0.35em',
  },
  '.cm-ink-link': {
    color: 'var(--accent, #2563eb)',
    textDecoration: 'underline',
    textUnderlineOffset: '2px',
    cursor: 'pointer',
  },
  '.cm-ink-table': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: '0.85em',
    backgroundColor: 'rgba(135, 131, 120, 0.04)',
  },
  // Generous breathing room so a rule reads as a true section break, not a
  // cramped line. Applied to the line (present in both states) so the divider
  // widget and the revealed raw `---` occupy the same vertical footprint.
  // Vertical rhythm is PADDING, not margin: CM6's line-height model measures
  // line blocks by offset geometry, which excludes margin but includes padding.
  // A vertical margin here would desync coordsAtPos/posAtCoords from the paint
  // and drift the caret on click (the same regression the heading line classes
  // had). The divider lives on the inner cm-ink-hr-widget span (a full-width
  // border), not on the line box, so margin↔padding is visually identical — the
  // widget and the revealed `---` still center in the padded line. Vertical
  // longhand only, so the `.cm-line` horizontal padding is preserved.
  '.cm-ink-hr': { color: 'var(--ink-faint, #9ca3af)', paddingTop: '1.1em', paddingBottom: '1.1em' },
  '.cm-ink-hr-mark': { letterSpacing: '2px' },
  '.cm-ink-hr-widget': {
    // Replaces the rule's text, so the divider must occupy the line itself:
    // an inline-block stretched to the full line width, drawn as a border.
    display: 'inline-block',
    width: '100%',
    borderTop: '1px solid var(--ink-block-border, #cbd5e1)',
    verticalAlign: 'middle',
  },
  '.cm-ink-highlight': {
    // --ink-highlight-bg is the app's tuning hook (declared with a default in
    // glyphdownTheme; dark mode overrides it on the app side).
    backgroundColor: 'var(--ink-highlight-bg, rgba(255, 213, 0, 0.35))',
    borderRadius: '2px',
  },
  // Syntax-highlight spans nested inside an autolink chip (tags.url renders
  // URLs gray) must not override the chip color.
  '.cm-ink-autolink span': { color: 'inherit' },
  // The line carries the muted color; the strike is a mark over the task's
  // text only (see the Task case) so hidden markers/indent never show a
  // floating strike-through segment.
  '.cm-ink-task-done': { color: '#9ca3af' },
  '.cm-ink-task-done-text': { textDecoration: 'line-through' },
  '.cm-ink-checkbox-wrap': {
    // 24px square hit area (coarse-pointer tap-target floor) around a visually
    // native checkbox. Negative margins absorb the extra box back into the
    // line so text rhythm and the checkbox's apparent position are unchanged;
    // the overhang stays clickable.
    boxSizing: 'border-box',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '24px',
    height: '24px',
    margin: '-6px 0 -6px -6px',
    marginInlineEnd: '-2px',
    verticalAlign: 'middle',
    cursor: 'pointer',
  },
  '.cm-ink-checkbox': {
    margin: '0',
    cursor: 'pointer',
    // Clicks resolve on the wrapper; the input is decorative so its native
    // toggle never competes with the document-driven `checked`.
    pointerEvents: 'none',
  },
  '.cm-ink-image-img': {
    maxWidth: '100%',
    borderRadius: '4px',
    verticalAlign: 'bottom',
  },
  '.cm-ink-image-block': {
    padding: '2px 0 4px',
  },
  '.cm-ink-image-placeholder': {
    border: '1px dashed var(--ink-block-border, #cbd5e1)',
    borderRadius: '4px',
    padding: '0 6px',
    color: 'var(--ink-block-muted, #5f6b7a)',
    fontSize: '0.9em',
    cursor: 'default',
  },
  '.cm-ink-frontmatter': {
    color: '#8b95a3',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: '0.85em',
  },
} satisfies ThemeSpec)

const livePreviewBaseTheme = EditorView.baseTheme(livePreviewRules)

/**
 * The Obsidian-style live-preview layer: syntax delimiters hidden away from
 * the selection, styled blocks, clickable checkboxes, bullet glyphs for list
 * markers, link chips, image placeholders, divider widgets for rules,
 * `==highlight==` marks, faded `%%comments%%`, autolinked bare URLs,
 * `> [!type]` callouts, footnote chips, read-only rendered tables, and
 * hanging indents that align wrapped list lines with the item's text.
 * Pair with `glyphdownMarkdown()` and `glyphdownHighlighting()`.
 */
export function livePreview(): Extension {
  return [
    // Before livePreviewField: state fields update/initialize in
    // configuration order, and computeDecorations reads tableEditField.
    tableEditor(),
    livePreviewField,
    listHangingIndent,
    livePreviewBaseTheme,
    calloutBaseTheme,
    footnoteBaseTheme,
    tableBaseTheme,
    commentField,
    commentBaseTheme,
  ]
}
