import { describe, expect, it } from 'vitest'
import { EditorSelection, EditorState } from '@codemirror/state'
import type { Decoration } from '@codemirror/view'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { glyphdownMarkdown, livePreview, mathField, MathWidget } from '../src/index.ts'
import { listDecorations, previewState, type DecoEntry } from './helpers.ts'

// ---------------------------------------------------------------------------
// Parser: InlineMath / BlockMath node emission
// ---------------------------------------------------------------------------

interface MathNode {
  name: string
  from: number
  to: number
}

function parse(doc: string): EditorState {
  const state = EditorState.create({ doc, extensions: [glyphdownMarkdown()] })
  ensureSyntaxTree(state, state.doc.length, 5000)
  return state
}

function mathNodes(doc: string): MathNode[] {
  const state = parse(doc)
  const out: MathNode[] = []
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name === 'InlineMath' || node.name === 'BlockMath') {
        out.push({ name: node.name, from: node.from, to: node.to })
      }
    },
  })
  return out
}

describe('inline math parsing ($...$)', () => {
  it('parses inline math mid-sentence with marks', () => {
    const doc = 'Euler: $e^{i\\pi} + 1 = 0$ wow'
    const nodes = mathNodes(doc)
    expect(nodes).toEqual([{ name: 'InlineMath', from: 7, to: 25 }])
    expect(doc.slice(7, 25)).toBe('$e^{i\\pi} + 1 = 0$')
  })

  it('keeps the TeX between the marks unparsed (no emphasis inside math)', () => {
    const state = parse('x $a_i * b_i * c$ y')
    let sawEmphasis = false
    syntaxTree(state).iterate({
      enter: (node) => {
        if (node.name === 'Emphasis') sawEmphasis = true
      },
    })
    expect(sawEmphasis).toBe(false)
    expect(mathNodes('x $a_i * b_i * c$ y')).toHaveLength(1)
  })

  it("rejects Obsidian's spaced forms: $ x $, $x $, $ x$", () => {
    expect(mathNodes('a $ x $ b')).toEqual([])
    expect(mathNodes('a $x $ b')).toEqual([])
    expect(mathNodes('a $ x$ b')).toEqual([])
  })

  it('skips a space-preceded $ and closes on the next valid one', () => {
    // Obsidian renders `a $ b` for `$a $ b$`.
    const nodes = mathNodes('see $a $ b$ end')
    expect(nodes).toEqual([{ name: 'InlineMath', from: 4, to: 11 }])
  })

  it('does not match price strings', () => {
    expect(mathNodes('it costs $20 and $30 today')).toEqual([])
  })

  it('does not open from an escaped dollar', () => {
    expect(mathNodes('pay \\$5 now')).toEqual([])
  })

  it('does not close on an escaped dollar', () => {
    expect(mathNodes('a $x\\$ b')).toEqual([])
  })

  it('does not span lines', () => {
    expect(mathNodes('a $x\ny$ b')).toEqual([])
  })

  it('parses paragraph-embedded $$...$$ as display math (spaces allowed)', () => {
    const doc = 'before $$ \\sum_i x_i $$ after'
    const nodes = mathNodes(doc)
    expect(nodes).toEqual([{ name: 'InlineMath', from: 7, to: 23 }])
    expect(doc.slice(7, 23)).toBe('$$ \\sum_i x_i $$')
  })

  it('keeps blank $$ $$ and $$$$ literal', () => {
    expect(mathNodes('a $$ $$ b')).toEqual([])
    expect(mathNodes('a $$$$ b')).toEqual([])
  })
})

describe('block math parsing ($$...$$)', () => {
  it('parses a multi-line block', () => {
    const doc = '$$\nx^2 + y^2 = z^2\n$$'
    expect(mathNodes(doc)).toEqual([{ name: 'BlockMath', from: 0, to: doc.length }])
  })

  it('parses a single-line block', () => {
    expect(mathNodes('$$E = mc^2$$')).toEqual([{ name: 'BlockMath', from: 0, to: 12 }])
  })

  it('interrupts a paragraph without a blank line', () => {
    const doc = 'text\n$$\nx\n$$'
    expect(mathNodes(doc)).toEqual([{ name: 'BlockMath', from: 5, to: doc.length }])
  })

  it('an unclosed $$ extends to the end of the document (fenced-code parity)', () => {
    const doc = '$$\nx + y\nmore text'
    expect(mathNodes(doc)).toEqual([{ name: 'BlockMath', from: 0, to: doc.length }])
  })

  it('parses inside a blockquote and stops when the quote ends', () => {
    const doc = '> $$\n> x\n\nplain'
    const nodes = mathNodes(doc)
    expect(nodes).toEqual([{ name: 'BlockMath', from: 2, to: 8 }])
    expect(doc.slice(2, 8)).toBe('$$\n> x')
  })

  it('keeps a line-start $$$$ literal', () => {
    expect(mathNodes('$$$$')).toEqual([])
  })
})

describe('math in code contexts stays raw', () => {
  it('inline code', () => {
    expect(mathNodes('a `$x$` b')).toEqual([])
  })

  it('fenced code blocks (inline and block forms)', () => {
    expect(mathNodes('```\n$x$\n$$\ny\n$$\n```')).toEqual([])
  })

  it('an inline-code span after a $ wins (no greedy match across backticks)', () => {
    // Regression: `$20` must not close on the `$` inside the later code span.
    expect(mathNodes('Prices $20 and $30 are not math, and `$y$` raw')).toEqual([])
  })

  it('an inline-code span still parses as code, not consumed by a stray $', () => {
    const state = parse('Prices $20 and `$y$` raw')
    let sawCode = false
    syntaxTree(state).iterate({
      enter: (node) => {
        if (node.name === 'InlineCode') sawCode = true
      },
    })
    expect(sawCode).toBe(true)
    expect(mathNodes('Prices $20 and `$y$` raw')).toEqual([])
  })

  it('indented code blocks', () => {
    expect(mathNodes('para\n\n    $$\n    x\n    $$')).toEqual([])
  })

  it('frontmatter', () => {
    expect(mathNodes('---\ntitle: $x$\n---\n\nbody')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Decorations (mathField)
// ---------------------------------------------------------------------------

function mathDecorations(state: EditorState): DecoEntry[] {
  return listDecorations(state.field(mathField))
}

function tagged(state: EditorState, tag: string): DecoEntry[] {
  return mathDecorations(state).filter((d) => d.deco.spec['glyphdown'] === tag)
}

function withClass(state: EditorState, cls: string): DecoEntry[] {
  return mathDecorations(state).filter((d) => {
    const c: unknown = (d.deco as Decoration).spec['class']
    return typeof c === 'string' && c.split(' ').includes(cls)
  })
}

describe('inline math decorations', () => {
  it('replaces with an inline KaTeX widget away from the caret', () => {
    const state = previewState('a $x^2$ b', 0)
    const [deco] = tagged(state, 'math')
    expect(deco).toBeDefined()
    expect(deco!.from).toBe(2)
    expect(deco!.to).toBe(7)
    const widget = deco!.deco.spec['widget'] as MathWidget
    expect(widget).toBeInstanceOf(MathWidget)
    expect(widget.src).toBe('x^2')
    expect(widget.display).toBe(false)
    expect(widget.block).toBe(false)
  })

  it('reveals tinted raw source when the caret is inside', () => {
    const state = previewState('a $x^2$ b', 4)
    expect(tagged(state, 'math')).toEqual([])
    const [mark] = withClass(state, 'cm-ink-math-src')
    expect(mark).toBeDefined()
    expect(mark!.from).toBe(2)
    expect(mark!.to).toBe(7)
  })

  it('renders paragraph-embedded $$...$$ in display mode', () => {
    const state = previewState('a $$x+y$$ b', 0)
    const widget = tagged(state, 'math')[0]!.deco.spec['widget'] as MathWidget
    expect(widget.src).toBe('x+y')
    expect(widget.display).toBe(true)
    expect(widget.block).toBe(false)
  })
})

describe('block math decorations', () => {
  const doc = 'intro\n\n$$\n\\int_0^1 x\\,dx\n$$\n\nafter'

  it('replaces the whole block with a display widget away from the caret', () => {
    const state = previewState(doc, 0)
    const [deco] = tagged(state, 'math-block')
    expect(deco).toBeDefined()
    // Snapped to full lines: `$$` open line start → `$$` close line end.
    expect(deco!.from).toBe(7)
    expect(deco!.to).toBe(27)
    const widget = deco!.deco.spec['widget'] as MathWidget
    expect(widget.src).toBe('\\int_0^1 x\\,dx')
    expect(widget.display).toBe(true)
    expect(widget.block).toBe(true)
    expect(deco!.deco.spec['block']).toBe(true)
  })

  it('reveals tinted raw source when the caret touches any of its lines', () => {
    const state = previewState(doc, 12) // inside the TeX line
    expect(tagged(state, 'math-block')).toEqual([])
    expect(withClass(state, 'cm-ink-math-src')).toHaveLength(1)
  })
})

describe('rendering gates and exclusions', () => {
  it('renders nothing without livePreview() in the configuration (source mode)', () => {
    const state = EditorState.create({
      doc: 'a $x^2$ b\n\n$$\ny\n$$',
      selection: EditorSelection.single(0),
      extensions: [glyphdownMarkdown()],
    })
    ensureSyntaxTree(state, state.doc.length, 5000)
    const refreshed = state.update({ selection: EditorSelection.single(0) }).state
    expect(mathDecorations(refreshed)).toEqual([])
  })

  it('decorates nothing inside code fences', () => {
    const state = previewState('```\n$x$\n$$\ny\n$$\n```', 0)
    expect(mathDecorations(state)).toEqual([])
  })

  it('mathless documents produce no math decorations', () => {
    const state = previewState('# title\n\njust prose with a $5 price', 0)
    expect(mathDecorations(state)).toEqual([])
  })
})

describe('livePreview() compatibility', () => {
  it('hides nothing from the live-preview field itself (fields stay independent)', () => {
    // The math widget lives in mathField; livePreviewField must not also
    // try to own the `$` range (no duplicate replacements).
    const state = previewState('a $x^2$ b', 0)
    const lpDecos = listDecorations(state.field(mathField))
    expect(lpDecos).toHaveLength(1)
  })
})
