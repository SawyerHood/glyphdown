import { type EditorState, type Range as RangeValue, StateField } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import type { SyntaxNode } from '@lezer/common'

// ---------------------------------------------------------------------------
// %%comment%% spans (Obsidian-style), found by regex — the markdown parser
// has no node for them (the wikilink.ts pattern). v1 is single-line only;
// multi-line %% blocks are a known gap.
// ---------------------------------------------------------------------------

export interface InlineComment {
  /** Whole `%%...%%` range, delimiters included. */
  from: number
  to: number
  /** The text between the delimiters. */
  text: string
}

/**
 * `%%...%%` on a single line. Content may contain lone `%` characters but not
 * `%%` (the first closing pair ends the span) and never a newline.
 */
const COMMENT_RE = /%%((?:[^%\n]|%(?!%))*)%%/g

export function findComments(text: string): InlineComment[] {
  const out: InlineComment[] = []
  for (const m of text.matchAll(COMMENT_RE)) {
    out.push({ from: m.index, to: m.index + m[0].length, text: m[1]! })
  }
  return out
}

// ---------------------------------------------------------------------------
// Decorations
// ---------------------------------------------------------------------------

/** Node names where `%%...%%` is literal text, not a comment (the same code
 * guards wikilink.ts uses). */
const EXCLUDED_NODES = new Set(['InlineCode', 'FencedCode', 'CodeBlock', 'CodeText', 'Frontmatter', 'URL'])

function inExcludedNode(state: EditorState, pos: number): boolean {
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent) {
    if (EXCLUDED_NODES.has(node.name)) return true
  }
  return false
}

function computeCommentDecorations(state: EditorState): DecorationSet {
  const decos: RangeValue<Decoration>[] = []
  for (const comment of findComments(state.doc.toString())) {
    if (inExcludedNode(state, comment.from + 1)) continue
    // Obsidian-style: the whole span fades, delimiters included — nothing is
    // hidden, so there is no cursor-entry reveal to manage.
    decos.push(
      Decoration.mark({ glyphdown: 'comment', class: 'cm-ink-md-comment' }).range(comment.from, comment.to),
    )
  }
  return Decoration.set(decos, true)
}

/**
 * Faded `%%comment%%` spans. Recomputed on doc changes and async parse
 * progress (code-region exclusion); selection changes don't matter since
 * nothing is hidden.
 */
export const commentField = StateField.define<DecorationSet>({
  create: computeCommentDecorations,
  update(value, tr) {
    if (tr.docChanged || syntaxTree(tr.state) !== syntaxTree(tr.startState)) {
      return computeCommentDecorations(tr.state)
    }
    return value
  },
  provide: (f) => EditorView.decorations.from(f),
})

export const commentBaseTheme = EditorView.baseTheme({
  '.cm-ink-md-comment': {
    opacity: '0.45',
    fontStyle: 'italic',
  },
})
