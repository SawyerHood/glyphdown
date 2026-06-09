import type { BlockContext, Element, InlineParser, Line, MarkdownConfig } from '@lezer/markdown'
import { tags } from '@lezer/highlight'

// ---------------------------------------------------------------------------
// $math$ / $$math$$ lezer syntax (Obsidian-parity delimiter rules)
// ---------------------------------------------------------------------------
//
// Inline `$...$` follows Obsidian's rule: the opening `$` must be immediately
// followed by a non-whitespace character and the closing `$` immediately
// preceded by one (`$x$` is math, `$ x $` is not) — that asymmetry is what
// keeps price strings ("$20 and $30") out of math. `$$...$$` is display math
// and has no such rule (`$$ x $$` renders).
//
// Because these are real lezer parsers, code contexts are excluded for free:
// fenced/indented code blocks consume their lines before the block parser
// runs, and inline-code/autolink spans never hand their `$` characters to
// inline parsers. The decoration layer (math.ts) therefore needs no
// syntax-tree exclusion guards of its own.
//
// Documented divergences from Obsidian (pragmatic choices, see also the
// parser comments):
// - Inline `$...$` must stay on one line.
// - A multi-line block's closing `$$` must end its line (trailing whitespace
//   ok). Obsidian splits the line mid-way and reflows the trailing text into
//   the next paragraph — doing that in an eager lezer block parser would
//   orphan the trailing text, so such a `$$` simply does not close the block.
// - `$$$$` / `$$ $$` (blank math) stays literal text.
// - A `\\` directly before a closing delimiter reads as "escaped delimiter"
//   even though TeX-wise it is an escaped backslash.
// - A backtick between the opener and a candidate closer aborts the match:
//   inline code wins (`` $20 and `$y$` `` is code, not math), matching
//   Obsidian. The cost is that math literally containing a backtick
//   (`$\texttt{`}$`, very rare) will not render.

const DOLLAR = 36
const BACKSLASH = 92
const BACKTICK = 96

function isSpace(ch: number): boolean {
  return ch === 32 || ch === 9 || ch === 10 || ch === 13
}

/**
 * Index of the first unescaped `$$` in `text` at or after `from`, or -1.
 */
function findDoubleDollar(text: string, from: number): number {
  for (let i = from; i < text.length - 1; i++) {
    const ch = text.charCodeAt(i)
    if (ch === BACKSLASH) {
      i++ // skip the escaped character
      continue
    }
    if (ch === DOLLAR && text.charCodeAt(i + 1) === DOLLAR) return i
  }
  return -1
}

/** Is everything from `pos` to the end of `text` whitespace? */
function onlySpaceAfter(text: string, pos: number): boolean {
  return /^\s*$/.test(text.slice(pos))
}

const inlineMathParser: InlineParser = {
  name: 'InlineMath',
  parse(cx, next, pos) {
    if (next !== DOLLAR || cx.char(pos - 1) === DOLLAR) return -1
    if (cx.char(pos + 1) === DOLLAR) {
      // `$$...$$` inside a paragraph (the block parser only claims line-start
      // `$$` runs): display math mid-sentence, spaces inside allowed. The
      // scan may cross the paragraph's soft line breaks.
      for (let i = pos + 2; i < cx.end - 1; i++) {
        const ch = cx.char(i)
        // A backtick starts an inline-code span (higher precedence); abort so
        // the `$$` opener stays literal and InlineCode claims the code span.
        if (ch === BACKTICK) return -1
        if (ch === BACKSLASH) {
          i++
          continue
        }
        if (ch === DOLLAR && cx.char(i + 1) === DOLLAR) {
          if (cx.slice(pos + 2, i).trim() === '') return -1 // blank math stays literal
          return cx.addElement(
            cx.elt('InlineMath', pos, i + 2, [
              cx.elt('InlineMathMark', pos, pos + 2),
              cx.elt('InlineMathMark', i, i + 2),
            ]),
          )
        }
      }
      return -1
    }
    // Single-`$` inline math, single-line only.
    if (pos + 1 >= cx.end || isSpace(cx.char(pos + 1))) return -1
    for (let i = pos + 2; i < cx.end; i++) {
      const ch = cx.char(i)
      if (ch === 10) return -1 // newline: inline math does not span lines
      // A backtick starts an inline-code span (parsed before this parser
      // reaches it via document order): inline code wins, so `$x` followed by
      // a code span never closes across it (`` $20 and `$y$` `` stays raw).
      if (ch === BACKTICK) return -1
      if (ch === BACKSLASH) {
        i++
        continue
      }
      if (ch === DOLLAR) {
        // A `$` preceded by whitespace cannot close — keep scanning, the
        // next candidate may (Obsidian: `$a $ b$` renders `a $ b`).
        if (isSpace(cx.char(i - 1))) continue
        return cx.addElement(
          cx.elt('InlineMath', pos, i + 1, [
            cx.elt('InlineMathMark', pos, pos + 1),
            cx.elt('InlineMathMark', i, i + 1),
          ]),
        )
      }
    }
    return -1
  },
  before: 'Emphasis',
}

/**
 * Composite-context markers (blockquote `>`s) recorded on a line. Internal
 * lezer state — read defensively so a library update degrades to "markers
 * missing from the tree inside math" instead of a crash.
 */
function lineMarkers(line: Line): readonly Element[] {
  const markers = (line as unknown as { markers?: Element[] }).markers
  return Array.isArray(markers) ? markers : []
}

/**
 * Has the surrounding composite block (blockquote/list) ended at this line?
 * Mirrors FencedCode's internal `line.depth >= cx.stack.length` guard; if
 * either internal field disappears, we degrade to FencedCode-without-guard
 * behavior (the block keeps consuming lines).
 */
function compositeEnded(cx: BlockContext, line: Line): boolean {
  const depth = (line as unknown as { depth?: number }).depth
  const stack = (cx as unknown as { stack?: { length: number } }).stack
  return typeof depth === 'number' && stack !== undefined && depth < stack.length
}

function parseBlockMath(cx: BlockContext, line: Line): boolean {
  if (line.next !== DOLLAR || line.text.charCodeAt(line.pos + 1) !== DOLLAR) return false
  const from = cx.lineStart + line.pos
  const contentStart = line.pos + 2
  const sameLineClose = findDoubleDollar(line.text, contentStart)
  if (sameLineClose >= 0) {
    // The closer sits on the opening line.
    if (line.text.slice(contentStart, sameLineClose).trim() === '') return false // `$$$$`: stays literal
    if (!onlySpaceAfter(line.text, sameLineClose + 2)) return false // `$$x$$ tail`: the inline parser owns it
    const to = cx.lineStart + sameLineClose + 2
    const children = [
      cx.elt('BlockMathMark', from, from + 2),
      cx.elt('BlockMathMark', to - 2, to),
    ]
    cx.nextLine()
    cx.addElement(cx.elt('BlockMath', from, to, children))
    return true
  }
  // Multi-line block: consume lines until one that ends with `$$` (FencedCode
  // shape). Unclosed `$$` extends to the end of the document/composite block,
  // exactly like an unclosed code fence.
  const children: Element[] = [cx.elt('BlockMathMark', from, from + 2)]
  let to = cx.lineStart + line.text.length
  while (cx.nextLine()) {
    if (compositeEnded(cx, line)) break
    for (const m of lineMarkers(line)) children.push(m)
    const close = findDoubleDollar(line.text, line.pos)
    if (close >= 0 && onlySpaceAfter(line.text, close + 2)) {
      to = cx.lineStart + close + 2
      children.push(cx.elt('BlockMathMark', to - 2, to))
      cx.nextLine()
      break
    }
    to = cx.lineStart + line.text.length
  }
  cx.addElement(cx.elt('BlockMath', from, to, children))
  return true
}

/**
 * Lezer-markdown extension adding Obsidian-style math nodes:
 *
 * - `InlineMath` — `$...$` (no-space flanking rule) and paragraph-embedded
 *   `$$...$$` (display math mid-sentence). Children: two `InlineMathMark`s.
 *   The TeX between the marks is NOT parsed as markdown (`$a_i * b_i$` keeps
 *   its underscores/stars).
 * - `BlockMath` — `$$` at the start of a line, closed by a `$$` ending a
 *   line (single- or multi-line). Children: `BlockMathMark`s plus any
 *   composite-block markers on inner lines.
 *
 * Rendering lives in math.ts; pair via `glyphdownMarkdown()`.
 */
export const mathSyntax: MarkdownConfig = {
  defineNodes: [
    { name: 'InlineMath', style: { 'InlineMath/...': tags.special(tags.content) } },
    { name: 'InlineMathMark', style: tags.processingInstruction },
    { name: 'BlockMath', block: true, style: { 'BlockMath/...': tags.special(tags.content) } },
    { name: 'BlockMathMark', style: tags.processingInstruction },
  ],
  parseInline: [inlineMathParser],
  parseBlock: [
    {
      name: 'BlockMath',
      parse: parseBlockMath,
      // `$$` interrupts a paragraph without a blank line (Obsidian behavior).
      endLeaf: (_cx, line) =>
        line.next === DOLLAR && line.text.charCodeAt(line.pos + 1) === DOLLAR,
      // Before FencedCode (arbitrary stable anchor); IndentedCode still runs
      // first, so a 4-space-indented `$$` stays a code block.
      before: 'FencedCode',
    },
  ],
}
