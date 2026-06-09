import type { Extension } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { yamlFrontmatter } from '@codemirror/lang-yaml'
import { languages } from '@codemirror/language-data'
import type { DelimiterType, MarkdownConfig } from '@lezer/markdown'
import { tags } from '@lezer/highlight'
import { footnoteExtension } from './footnote.ts'
import { mathSyntax } from './math-syntax.ts'
import { mathPreview } from './math.ts'

// ---------------------------------------------------------------------------
// ==Highlight== inline syntax (Obsidian-style)
// ---------------------------------------------------------------------------

/**
 * Punctuation test for delimiter flanking rules — cloned from @lezer/markdown
 * (the built-in Strikethrough uses the same check), with the same unicode
 * upgrade when the runtime supports property escapes.
 */
let Punctuation = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~\xA1\u2010-\u2027]/
try {
  Punctuation = new RegExp('[\\p{S}|\\p{P}]', 'u')
} catch {
  // older runtimes keep the ASCII approximation
}

const HighlightDelim: DelimiterType = { resolve: 'Highlight', mark: 'HighlightMark' }

/**
 * `==highlighted==` inline syntax, an exact structural clone of the built-in
 * GFM Strikethrough extension with `==` delimiters instead of `~~`. Emits a
 * `Highlight` node wrapping two `HighlightMark` children; the live-preview
 * layer styles the content (`cm-ink-highlight`) and hides the marks away
 * from the selection.
 */
export const highlightExtension: MarkdownConfig = {
  defineNodes: [
    {
      name: 'Highlight',
      style: { 'Highlight/...': tags.special(tags.content) },
    },
    {
      name: 'HighlightMark',
      style: tags.processingInstruction,
    },
  ],
  parseInline: [
    {
      name: 'Highlight',
      parse(cx, next, pos) {
        if (next !== 61 /* '=' */ || cx.char(pos + 1) !== 61 || cx.char(pos + 2) === 61) return -1
        const before = cx.slice(pos - 1, pos)
        const after = cx.slice(pos + 2, pos + 3)
        const sBefore = /\s|^$/.test(before)
        const sAfter = /\s|^$/.test(after)
        const pBefore = Punctuation.test(before)
        const pAfter = Punctuation.test(after)
        return cx.addDelimiter(
          HighlightDelim,
          pos,
          pos + 2,
          !sAfter && (!pAfter || sBefore || pBefore),
          !sBefore && (!pBefore || sAfter || pAfter),
        )
      },
      after: 'Emphasis',
    },
  ],
}

/**
 * The Glyphdown markdown language: GFM markdownLanguage as the base dialect,
 * `==highlight==` inline syntax, `[^1]` footnote refs/definitions,
 * `$math$`/`$$math$$` nodes (with their KaTeX rendering layer), fenced
 * code blocks highlighted via the full language-data registry, and a YAML
 * frontmatter block (`---` fences at the top of the document).
 */
export function glyphdownMarkdown(): Extension {
  return [
    yamlFrontmatter({
      content: markdown({
        base: markdownLanguage,
        codeLanguages: languages,
        addKeymap: true,
        extensions: [highlightExtension, footnoteExtension, mathSyntax],
      }),
    }),
    // KaTeX math rendering rides the language bundle (math.ts) so the app
    // needs no extra wiring; its field renders nothing unless livePreview()
    // is also in the configuration (source mode stays raw).
    mathPreview(),
  ]
}
