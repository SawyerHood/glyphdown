import {
  type EditorState,
  type Extension,
  type Range as RangeValue,
  StateField,
} from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import type Katex from 'katex'
import { livePreviewField, touchesSelection } from './live-preview.ts'

// ---------------------------------------------------------------------------
// Lazy KaTeX loading
// ---------------------------------------------------------------------------
//
// KaTeX (~270KB min + fonts) is loaded on demand the first time a math node
// actually renders, so documents without math pay zero bundle cost. The
// stylesheet rides the same dynamic chunk: vite extracts the CSS import into
// a code-split asset it injects alongside the chunk, fonts included — the app
// needs no katex wiring at all.

type KatexModule = typeof Katex

let loadedKatex: KatexModule | null = null
let katexPromise: Promise<KatexModule> | null = null

/**
 * Kick off (or join) the KaTeX load. A failed load clears the cached promise
 * so a later math widget retries instead of pinning the editor to a one-off
 * network error.
 */
export function loadKatex(): Promise<KatexModule> {
  katexPromise ??= Promise.all([
    import('katex'),
    // CSS load failures (or environments that cannot import CSS) must not
    // block math rendering itself.
    import('katex/dist/katex.min.css').catch(() => undefined),
  ]).then(
    ([mod]) => {
      loadedKatex = mod.default
      return loadedKatex
    },
    (err: unknown) => {
      katexPromise = null
      throw err
    },
  )
  return katexPromise
}

/** The synchronously-available KaTeX module, if the lazy load has finished. */
export function katexIfLoaded(): KatexModule | null {
  return loadedKatex
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Soft red used for KaTeX's own error spans and our catch-all fallback. */
const MATH_ERROR_COLOR = '#b3554d'

/** The raw delimited form of a math node's source, for placeholders/errors. */
export function delimitedMath(src: string, display: boolean): string {
  return display ? `$$${src}$$` : `$${src}$`
}

/**
 * Render TeX into `el`. `throwOnError: false` downgrades KaTeX parse errors
 * to inline soft-red source spans; anything KaTeX still throws on lands in
 * the catch and renders the raw delimited source in the same tint — a math
 * widget can never take down the decoration pass.
 */
export function renderMathInto(katex: KatexModule, el: HTMLElement, src: string, display: boolean): void {
  try {
    el.innerHTML = katex.renderToString(src, {
      displayMode: display,
      // html only: the default html-and-mathml duplicates every symbol in a
      // hidden MathML tree (copy/paste + screen-reader duplication inside an
      // editor widget).
      output: 'html',
      throwOnError: false,
      errorColor: MATH_ERROR_COLOR,
      trust: false,
    })
    el.classList.remove('cm-ink-math-error')
  } catch (err) {
    el.textContent = delimitedMath(src, display)
    el.classList.add('cm-ink-math-error')
    el.title = err instanceof Error ? err.message : String(err)
  }
}

export class MathWidget extends WidgetType {
  constructor(
    /** TeX source, delimiters stripped. */
    readonly src: string,
    /** KaTeX displayMode (block `$$...$$` and paragraph-embedded `$$...$$`). */
    readonly display: boolean,
    /** Rendered as its own centered block line (line-start `$$...$$`). */
    readonly block = false,
  ) {
    super()
  }

  override eq(other: MathWidget): boolean {
    return other.src === this.src && other.display === this.display && other.block === this.block
  }

  override toDOM(view: EditorView): HTMLElement {
    const el = document.createElement(this.block ? 'div' : 'span')
    el.className = this.block ? 'cm-ink-math cm-ink-math-block' : 'cm-ink-math'
    const katex = loadedKatex
    if (katex) {
      renderMathInto(katex, el, this.src, this.display)
      return el
    }
    // KaTeX not here yet: dimmed raw source as a placeholder, swapped for
    // the real render in place once the chunk arrives (requestMeasure tells
    // the view about the height change; no decoration rebuild needed).
    el.classList.add('cm-ink-math-loading')
    el.textContent = delimitedMath(this.src, this.display)
    loadKatex()
      .then((loaded) => {
        if (!el.isConnected) return
        el.classList.remove('cm-ink-math-loading')
        renderMathInto(loaded, el, this.src, this.display)
        view.requestMeasure()
      })
      .catch(() => {
        // Load failed (likely offline): the raw-source placeholder stays,
        // and the next widget render retries via the cleared promise.
      })
    return el
  }

  override ignoreEvent(): boolean {
    // Let the editor handle pointer events: a click on rendered math places
    // the caret inside the syntax, revealing the raw source (the BulletWidget
    // convention).
    return false
  }
}

// ---------------------------------------------------------------------------
// Decorations (sharing live-preview's touchesSelection reveal gate —
// read-only editors never reveal raw TeX source)
// ---------------------------------------------------------------------------

function computeMathDecorations(state: EditorState): DecorationSet {
  // Math widgets belong to the live-preview layer: when the app strips
  // livePreview() (source mode), math stays raw markdown too. The parser
  // nodes are still in the tree; only the rendering is gated.
  if (state.field(livePreviewField, false) === undefined) return Decoration.none
  const decos: RangeValue<Decoration>[] = []
  const doc = state.doc

  syntaxTree(state).iterate({
    enter: (node): boolean | void => {
      if (node.name === 'InlineMath') {
        if (touchesSelection(state, node.from, node.to)) {
          // Caret inside: raw `$...$` source, subtly tinted.
          decos.push(Decoration.mark({ class: 'cm-ink-math-src' }).range(node.from, node.to))
          return false
        }
        const text = doc.sliceString(node.from, node.to)
        const display = text.startsWith('$$')
        const src = display ? text.slice(2, -2) : text.slice(1, -1)
        decos.push(
          Decoration.replace({
            glyphdown: 'math',
            widget: new MathWidget(src, display),
          }).range(node.from, node.to),
        )
        return false
      }
      if (node.name === 'BlockMath') {
        // Snap to whole lines: block replace decorations must cover full
        // lines, and the math's lines hold nothing else anyway.
        const from = doc.lineAt(node.from).from
        const to = doc.lineAt(Math.min(node.to, doc.length)).to
        if (touchesSelection(state, from, to)) {
          decos.push(Decoration.mark({ class: 'cm-ink-math-src' }).range(node.from, node.to))
          return false
        }
        // Delimiters via the parser's marks — `src` is exactly the TeX
        // between them (unclosed blocks have no closing mark).
        const marks = node.node.getChildren('BlockMathMark')
        const open = marks[0]
        const close = marks.length > 1 ? marks[marks.length - 1] : undefined
        const src = doc.sliceString(open ? open.to : node.from, close ? close.from : node.to).trim()
        decos.push(
          Decoration.replace({
            glyphdown: 'math-block',
            widget: new MathWidget(src, true, true),
            block: true,
          }).range(from, to),
        )
        return false
      }
    },
  })

  return Decoration.set(decos, true)
}

/**
 * Math decorations computed from InlineMath/BlockMath syntax nodes (see
 * math-syntax.ts). Recomputed on doc changes, selection changes, async parse
 * progress, and reconfiguration (the live-preview compartment toggle).
 */
export const mathField = StateField.define<DecorationSet>({
  create: computeMathDecorations,
  update(value, tr) {
    if (
      tr.docChanged ||
      tr.selection ||
      tr.reconfigured ||
      syntaxTree(tr.state) !== syntaxTree(tr.startState)
    ) {
      return computeMathDecorations(tr.state)
    }
    return value
  },
  provide: (f) => EditorView.decorations.from(f),
})

const mathBaseTheme = EditorView.baseTheme({
  '.cm-ink-math-block': {
    textAlign: 'center',
    padding: '4px 0',
  },
  // Paragraph-embedded `$$...$$`: KaTeX's display wrapper carries a 1em
  // vertical margin meant for standalone blocks — tame it inline.
  '.cm-ink-math .katex-display': {
    margin: '0.2em 0',
  },
  // Caret-revealed raw source.
  '.cm-ink-math-src': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: '0.9em',
    color: '#8b7ad8',
  },
  // Raw-source placeholder while the KaTeX chunk loads.
  '.cm-ink-math-loading': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: '0.9em',
    opacity: '0.55',
  },
  // The catch-all fallback for TeX KaTeX refused to render at all.
  '.cm-ink-math-error': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: '0.9em',
    color: '#b3554d',
    backgroundColor: 'rgba(217, 83, 79, 0.08)',
    borderRadius: '3px',
    padding: '0 2px',
  },
})

/**
 * KaTeX math rendering for `$inline$` and `$$block$$` nodes: lazy-loaded
 * KaTeX widgets away from the caret, raw tinted source when the selection
 * touches the math, soft-red fallbacks for invalid TeX. Decoration-only —
 * never mutates the document, so it is safe under suggest mode and collab.
 * Bundled into `glyphdownMarkdown()`; inert (raw text) when `livePreview()`
 * is not in the configuration.
 */
export function mathPreview(): Extension {
  return [mathField, mathBaseTheme]
}
