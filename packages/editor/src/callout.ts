import type { EditorState } from '@codemirror/state'
import { EditorView, WidgetType } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'

// ---------------------------------------------------------------------------
// Obsidian-style callouts: `> [!type] Optional Title` blockquotes
// ---------------------------------------------------------------------------

/**
 * Obsidian's callout type set, aliases included, mapped to the canonical type
 * that carries the icon + color. Unknown types fall back to `note` styling
 * (Obsidian's behavior), keeping the written type as the title.
 */
export const CALLOUT_ALIASES: Record<string, string> = {
  note: 'note',
  abstract: 'abstract',
  summary: 'abstract',
  tldr: 'abstract',
  info: 'info',
  todo: 'todo',
  tip: 'tip',
  hint: 'tip',
  important: 'tip',
  success: 'success',
  check: 'success',
  done: 'success',
  question: 'question',
  help: 'question',
  faq: 'question',
  warning: 'warning',
  caution: 'warning',
  attention: 'warning',
  failure: 'failure',
  fail: 'failure',
  missing: 'failure',
  danger: 'danger',
  error: 'danger',
  bug: 'bug',
  example: 'example',
  quote: 'quote',
  cite: 'quote',
}

/** Canonical callout type for a written type (case-insensitive; unknown → note). */
export function canonicalCalloutType(written: string): string {
  return CALLOUT_ALIASES[written.toLowerCase()] ?? 'note'
}

/** The title Obsidian shows when none is written: the type, capitalized. */
export function fallbackCalloutTitle(written: string): string {
  return written.charAt(0).toUpperCase() + written.slice(1).toLowerCase()
}

const svg = (inner: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`

/**
 * Inline SVG per canonical type. Path data copied from lucide's static SVGs
 * (https://lucide.dev, ISC license): pencil, clipboard-list, info,
 * circle-check-big, flame, check, circle-help, triangle-alert, x, zap, bug,
 * list, quote — Obsidian's icon mapping.
 */
export const CALLOUT_ICONS: Record<string, string> = {
  // pencil
  note: svg(
    '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
  ),
  // clipboard-list
  abstract: svg(
    '<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/>',
  ),
  // info
  info: svg('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>'),
  // circle-check-big
  todo: svg('<path d="M21.801 10A10 10 0 1 1 17 3.335"/><path d="m9 11 3 3L22 4"/>'),
  // flame
  tip: svg('<path d="M12 3q1 4 4 6.5t3 5.5a1 1 0 0 1-14 0 5 5 0 0 1 1-3 1 1 0 0 0 5 0c0-2-1.5-3-1.5-5q0-2 2.5-4"/>'),
  // check
  success: svg('<path d="M20 6 9 17l-5-5"/>'),
  // circle-help
  question: svg(
    '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  ),
  // triangle-alert
  warning: svg(
    '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  ),
  // x
  failure: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  // zap
  danger: svg(
    '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
  ),
  // bug
  bug: svg(
    '<path d="M12 20v-9"/><path d="M14 7a4 4 0 0 1 4 4v3a6 6 0 0 1-12 0v-3a4 4 0 0 1 4-4z"/><path d="M14.12 3.88 16 2"/><path d="M21 21a4 4 0 0 0-3.81-4"/><path d="M21 5a4 4 0 0 1-3.55 3.97"/><path d="M22 13h-4"/><path d="M3 21a4 4 0 0 1 3.81-4"/><path d="M3 5a4 4 0 0 0 3.55 3.97"/><path d="M6 13H2"/><path d="m8 2 1.88 1.88"/><path d="M9 7.13V6a3 3 0 1 1 6 0v1.13"/>',
  ),
  // list
  example: svg(
    '<path d="M3 5h.01"/><path d="M3 12h.01"/><path d="M3 19h.01"/><path d="M8 5h13"/><path d="M8 12h13"/><path d="M8 19h13"/>',
  ),
  // quote
  quote: svg(
    '<path d="M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/><path d="M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/>',
  ),
}

/**
 * Per-type accent colors — the light defaults behind the
 * `--ink-callout-<type>` CSS vars (Obsidian's palette). The line tint derives
 * from the same var via color-mix, so the app tunes one var per type for
 * dark mode (declared in glyphdownTheme, the --ink-highlight-bg pattern).
 */
export const CALLOUT_COLORS: Record<string, string> = {
  note: '#086ddd',
  abstract: '#00bfbc',
  info: '#086ddd',
  todo: '#086ddd',
  tip: '#00bfbc',
  success: '#08b94e',
  question: '#ec7500',
  warning: '#ec7500',
  failure: '#e93147',
  danger: '#e93147',
  bug: '#e93147',
  example: '#7852ee',
  quote: '#9e9e9e',
}

// ---------------------------------------------------------------------------
// Header detection
// ---------------------------------------------------------------------------

export interface CalloutHeader {
  /** The type exactly as written inside `[!…]`. */
  written: string
  /** Canonical type (aliases and unknowns resolved). */
  canonical: string
  /** The `[!type]` marker plus any fold char and following space. */
  markerFrom: number
  markerTo: number
  /** The written title on the header line; empty (from === to) when absent. */
  titleFrom: number
  titleTo: number
}

/**
 * Detects a callout header on a Blockquote node. The verified parse shape: the
 * blockquote's first paragraph starts (on the blockquote's first line) with a
 * URL-less Link whose text is `[!type]`. An Obsidian fold marker directly
 * after the bracket (`[!type]-` / `[!type]+`) is absorbed into the marker —
 * v1 renders folded and unfolded callouts identically (no folding).
 */
export function parseCalloutHeader(state: EditorState, blockquote: SyntaxNode): CalloutHeader | null {
  const doc = state.doc
  const para = blockquote.getChild('Paragraph')
  if (!para) return null
  const firstLine = doc.lineAt(blockquote.from)
  if (para.from < firstLine.from || para.from >= firstLine.to) return null
  const link = para.firstChild
  if (!link || link.name !== 'Link' || link.from !== para.from) return null
  if (link.getChild('URL')) return null
  const match = /^\[!([A-Za-z][\w-]*)\]$/.exec(doc.sliceString(link.from, link.to))
  if (!match) return null
  let markerTo = link.to
  const fold = doc.sliceString(markerTo, markerTo + 1)
  if (fold === '-' || fold === '+') markerTo++
  // The marker must end the word: next comes a space, the line end, or EOF.
  const next = doc.sliceString(markerTo, markerTo + 1)
  if (next !== '' && next !== ' ' && next !== '\n') return null
  const titleTo = Math.min(para.to, firstLine.to)
  let titleFrom = Math.min(markerTo, titleTo)
  while (titleFrom < titleTo && doc.sliceString(titleFrom, titleFrom + 1) === ' ') titleFrom++
  const written = match[1]!
  return {
    written,
    canonical: canonicalCalloutType(written),
    markerFrom: link.from,
    markerTo,
    titleFrom,
    titleTo,
  }
}

// ---------------------------------------------------------------------------
// The header widget (icon + fallback title)
// ---------------------------------------------------------------------------

export class CalloutHeaderWidget extends WidgetType {
  constructor(
    readonly canonical: string,
    /** Shown when no title is written; null when the doc text carries one. */
    readonly fallbackTitle: string | null,
  ) {
    super()
  }

  override eq(other: CalloutHeaderWidget): boolean {
    return other.canonical === this.canonical && other.fallbackTitle === this.fallbackTitle
  }

  override toDOM(): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'cm-ink-callout-header'
    const icon = document.createElement('span')
    icon.className = 'cm-ink-callout-icon'
    // Static SVG strings from this module — never user input.
    icon.innerHTML = CALLOUT_ICONS[this.canonical] ?? CALLOUT_ICONS['note']!
    wrap.appendChild(icon)
    if (this.fallbackTitle !== null) {
      const title = document.createElement('span')
      title.className = 'cm-ink-callout-title'
      title.textContent = this.fallbackTitle
      wrap.appendChild(title)
    }
    return wrap
  }

  override ignoreEvent(): boolean {
    // Let the editor handle pointer events: a click places the caret inside
    // the blockquote, revealing the raw syntax (the BulletWidget convention).
    return false
  }
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

// style-mod's StyleSpec, without depending on the transitive package directly.
type ThemeSpec = Parameters<typeof EditorView.baseTheme>[0]

const calloutRules: ThemeSpec = {
  '.cm-ink-callout': {
    // The same metrics as cm-ink-blockquote (3px border + 14px padding), so a
    // caret entering/leaving the callout never shifts the text column. Keep
    // --ink-line-pad in lockstep for any nested-list hang calc.
    paddingLeft: '14px',
    '--ink-line-pad': '14px',
  },
  '.cm-ink-callout-header': {
    display: 'inline-flex',
    alignItems: 'center',
  },
  '.cm-ink-callout-icon': {
    display: 'inline-flex',
    alignItems: 'center',
    marginRight: '6px',
    verticalAlign: 'middle',
  },
  '.cm-ink-callout-icon svg': {
    width: '1.05em',
    height: '1.05em',
  },
  '.cm-ink-callout-title': {
    fontWeight: '600',
  },
}
for (const [type, color] of Object.entries(CALLOUT_COLORS)) {
  const accent = `var(--ink-callout-${type}, ${color})`
  calloutRules[`.cm-ink-callout-${type}`] = {
    borderLeft: `3px solid ${accent}`,
    backgroundColor: `color-mix(in srgb, ${accent} 8%, transparent)`,
  }
  calloutRules[`.cm-ink-callout-${type} .cm-ink-callout-title`] = { color: accent }
  calloutRules[`.cm-ink-callout-${type} .cm-ink-callout-icon`] = { color: accent }
}
// A callout nested inside a regular quote: the border-left position belongs
// to the OUTER quote (level 1), so it keeps the quote's gray bar — the
// callout accent stays in the tint, icon, and title. Declared after the
// per-type rules so it wins the cascade tie against their border-left.
calloutRules['.cm-ink-callout-nested'] = {
  borderLeftColor: 'var(--ink-block-border, #cbd5e1)',
}

export const calloutBaseTheme = EditorView.baseTheme(calloutRules)
