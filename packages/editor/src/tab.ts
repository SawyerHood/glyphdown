import { indentLess, indentMore } from '@codemirror/commands'
import { indentUnit, syntaxTree } from '@codemirror/language'
import { EditorSelection, type EditorState, type Extension, Prec, type StateCommand } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'

/** Markdown list nesting unit: two spaces. */
const MARKDOWN_INDENT = '  '

/**
 * True when the line holding `pos` is a list item line (bullet, ordered, or
 * task): walk up the Lezer syntax tree from the line's first non-whitespace
 * character looking for a ListItem ancestor. Checking the marker position
 * (rather than the cursor) makes the answer independent of where on the line
 * the cursor sits.
 */
function onListItemLine(state: EditorState, pos: number): boolean {
  const line = state.doc.lineAt(pos)
  const content = line.from + (/^[ \t]*/.exec(line.text)?.[0].length ?? 0)
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(Math.min(content, line.to), 1)
  for (; node; node = node.parent) {
    if (node.name === 'ListItem') return true
  }
  return false
}

/**
 * Markdown-aware Tab:
 *
 * - Non-empty selection, or any cursor on a list item line → indentMore
 *   (whole selected lines gain one indent unit; userEvent 'input.indent').
 * - Empty selection on a non-list line → insert the indent unit at the
 *   cursor (not at line start), userEvent 'input.type' so suggest mode and
 *   other input-routing capture it like ordinary typing. This is also the
 *   behavior inside code fences on non-list lines: indentation is inserted
 *   at the cursor rather than at line start.
 */
export const markdownTabCommand: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false
  if (state.selection.ranges.some((range) => !range.empty || onListItemLine(state, range.head))) {
    return indentMore({ state, dispatch })
  }
  const unit = state.facet(indentUnit)
  dispatch(
    state.update({
      ...state.changeByRange((range) => ({
        changes: { from: range.from, insert: unit },
        range: EditorSelection.cursor(range.from + unit.length),
      })),
      scrollIntoView: true,
      userEvent: 'input.type',
    }),
  )
  return true
}

/**
 * Tab / Shift-Tab for the markdown editor: markdownTabCommand on Tab,
 * indentLess on Shift-Tab, plus a two-space indentUnit (the markdown list
 * nesting unit, consumed by indentMore/indentLess and the cursor insertion).
 * The keymap is Prec.high so it runs ahead of default-precedence bindings;
 * an autocomplete keymap (Prec.highest, none configured today) would still
 * take priority.
 */
export function markdownTab(): Extension {
  return [
    indentUnit.of(MARKDOWN_INDENT),
    Prec.high(keymap.of([{ key: 'Tab', run: markdownTabCommand, shift: indentLess }])),
  ]
}
