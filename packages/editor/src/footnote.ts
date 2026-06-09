import type { EditorState } from '@codemirror/state'
import { EditorView, WidgetType } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import type { Line, MarkdownConfig } from '@lezer/markdown'
import { tags as t } from '@lezer/highlight'

// ---------------------------------------------------------------------------
// Footnote lezer extensions
//
// Adapted from SilverBullet (https://github.com/silverbulletmd/silverbullet,
// MIT licensed), client/markdown_parser/footnote.ts — the FootnoteRef inline
// parser and the FootnoteDefinition block parser, with SilverBullet's custom
// highlight tags swapped for the stock processingInstruction tag (the same
// dimmed-marker styling every other revealed delimiter uses here).
// ---------------------------------------------------------------------------

const footnoteRefRegex = /^\[\^([^\]\s]+)\]/

/**
 * `[^label]` inline footnote references. Runs before the built-in Link parser
 * (after Emphasis), so the bracket never becomes a link-start delimiter.
 * Emits FootnoteRef wrapping FootnoteRefMark (`[^`, `]`) and FootnoteRefLabel.
 */
const footnoteRefExtension: MarkdownConfig = {
  defineNodes: [
    { name: 'FootnoteRef' },
    { name: 'FootnoteRefMark', style: t.processingInstruction },
    { name: 'FootnoteRefLabel' },
  ],
  parseInline: [
    {
      name: 'FootnoteRef',
      parse(cx, next, pos) {
        if (next !== 91 /* '[' */) return -1
        const match = footnoteRefRegex.exec(cx.slice(pos, cx.end))
        if (!match) return -1
        // Followed by ':' → a definition's label, not a reference.
        const afterMatch = pos + match[0].length
        if (afterMatch < cx.end && cx.slice(afterMatch, afterMatch + 1) === ':') return -1
        const endPos = pos + match[0].length
        return cx.addElement(
          cx.elt('FootnoteRef', pos, endPos, [
            cx.elt('FootnoteRefMark', pos, pos + 2), // [^
            cx.elt('FootnoteRefLabel', pos + 2, endPos - 1),
            cx.elt('FootnoteRefMark', endPos - 1, endPos), // ]
          ]),
        )
      },
      after: 'Emphasis',
    },
  ],
}

const footnoteDefRegex = /^\[\^([^\]\s]+)\]:\s?/

/**
 * `[^label]: body` definition blocks (body may continue on lines indented by
 * 4+ spaces or a tab, with blank lines allowed between continuation
 * paragraphs). Runs before LinkReference so `[^1]: …` never parses as a link
 * reference definition. Emits FootnoteDefinition wrapping FootnoteDefMark
 * (`[^`, `]:`), FootnoteDefLabel, and an inline-parsed FootnoteDefBody.
 */
const footnoteDefinitionExtension: MarkdownConfig = {
  defineNodes: [
    { name: 'FootnoteDefinition', block: true },
    { name: 'FootnoteDefMark', style: t.processingInstruction },
    { name: 'FootnoteDefLabel' },
    { name: 'FootnoteDefBody' },
  ],
  parseBlock: [
    {
      name: 'FootnoteDefinition',
      parse: (cx, line: Line) => {
        const match = footnoteDefRegex.exec(line.text)
        if (!match) return false
        const label = match[1]!
        const markLen = match[0].length // [^label]: plus one optional space
        const startPos = cx.parsedPos
        let bodyText = line.text.slice(markLen)
        let endPos = cx.parsedPos + line.text.length + 1

        // Consume continuation lines (indented by 4+ spaces or tab); blank
        // lines are allowed between continuation paragraphs.
        while (cx.nextLine()) {
          if (/^(?: {4}|\t)/.test(line.text)) {
            bodyText += `\n${line.text}`
            endPos = cx.parsedPos + line.text.length + 1
          } else if (line.text.trim() === '') {
            bodyText += '\n'
            endPos = cx.parsedPos + line.text.length + 1
          } else {
            break
          }
        }
        // Trim trailing blank lines from the body. (Adaptation: SilverBullet
        // keeps one trailing newline here, which makes the node end on the
        // blank line after the definition; trimming all of them keeps the
        // definition's line styling off that blank line.)
        while (bodyText.endsWith('\n')) {
          bodyText = bodyText.slice(0, -1)
          endPos--
        }

        const labelStart = startPos + 2 // after [^
        const labelEnd = labelStart + label.length
        const markEnd = startPos + markLen // after `[^label]: `
        const bodyEnd = endPos - 1 // exclude the trailing newline

        const elts = [
          cx.elt('FootnoteDefMark', startPos, startPos + 2), // [^
          cx.elt('FootnoteDefLabel', labelStart, labelEnd),
          cx.elt('FootnoteDefMark', labelEnd, labelEnd + 2), // ]:
        ]
        if (bodyEnd > markEnd) {
          elts.push(cx.elt('FootnoteDefBody', markEnd, bodyEnd, cx.parser.parseInline(bodyText, markEnd)))
        }
        cx.addElement(cx.elt('FootnoteDefinition', startPos, bodyEnd, elts))
        return true
      },
      before: 'LinkReference',
    },
  ],
}

/**
 * Both footnote parser extensions, ready for `markdown({ extensions })`.
 * (SilverBullet's `^[inline footnote]` syntax is intentionally not ported —
 * Glyphdown sticks to the `[^label]` + `[^label]:` pair.)
 */
export const footnoteExtension: MarkdownConfig[] = [footnoteRefExtension, footnoteDefinitionExtension]

// ---------------------------------------------------------------------------
// Definition lookup
// ---------------------------------------------------------------------------

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Position of the `[^label]:` definition for a footnote label, or null when
 * none exists. Prefers the syntax tree (immune to look-alike text inside code
 * blocks); falls back to a line-anchored text search for not-yet-parsed
 * regions of large documents.
 */
export function findFootnoteDefinition(state: EditorState, label: string): number | null {
  let found: number | null = null
  syntaxTree(state).iterate({
    enter: (node): boolean | void => {
      if (found !== null) return false
      if (node.name !== 'FootnoteDefinition') return
      const labelNode = node.node.getChild('FootnoteDefLabel')
      if (labelNode && state.doc.sliceString(labelNode.from, labelNode.to) === label) {
        found = node.from
      }
      return false
    },
  })
  if (found !== null) return found
  const match = new RegExp(`^\\[\\^${escapeRegExp(label)}\\]:`, 'm').exec(state.doc.toString())
  return match ? match.index : null
}

// ---------------------------------------------------------------------------
// The reference chip widget
// ---------------------------------------------------------------------------

export class FootnoteRefWidget extends WidgetType {
  constructor(readonly label: string) {
    super()
  }

  override eq(other: FootnoteRefWidget): boolean {
    return other.label === this.label
  }

  override toDOM(view: EditorView): HTMLElement {
    const sup = document.createElement('sup')
    sup.className = 'cm-ink-footnote-ref'
    sup.textContent = this.label
    sup.title = `[^${this.label}]`
    sup.addEventListener('mousedown', (event) => {
      event.preventDefault()
      // Jump to the matching `[^label]:` definition (the checkbox pattern:
      // resolve positions at click time, never from stale construction state).
      // No definition → place the caret on the ref itself, revealing the
      // syntax, so the click never goes dead.
      const def = findFootnoteDefinition(view.state, this.label)
      const pos = def ?? view.posAtDOM(sup)
      view.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: 'center' }),
      })
      view.focus()
    })
    return sup
  }

  override ignoreEvent(): boolean {
    // The widget owns its clicks (jump-to-definition), like the checkbox.
    return true
  }
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

/**
 * Footnote styling. `--ink-footnote-accent` is the app's tuning hook
 * (declared with a light default in glyphdownTheme; dark mode overrides it on
 * the app side, the --ink-highlight-bg pattern).
 */
export const footnoteBaseTheme = EditorView.baseTheme({
  '.cm-ink-footnote-ref': {
    color: 'var(--ink-footnote-accent, #2563eb)',
    fontWeight: '600',
    cursor: 'pointer',
    padding: '0 1px',
  },
  // Definition lines are muted like blockquotes; the syntax always stays
  // visible (Obsidian shows footnote definitions as written). The muted ink
  // routes through the shared block-muted var so dark mode keeps contrast.
  '.cm-ink-footnote-def': {
    color: 'var(--ink-block-muted, #5f6b7a)',
    fontSize: '0.9em',
  },
  '.cm-ink-footnote-def-label': {
    color: 'var(--ink-footnote-accent, #2563eb)',
    fontWeight: '600',
  },
})
