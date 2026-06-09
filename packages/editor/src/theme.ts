import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { HighlightStyle, defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'

const prose = "'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif"
const mono = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

/**
 * Markdown-aware highlighting: document-style headings, emphasis, links.
 * Fenced code blocks pick up their language's default highlighting via the
 * defaultHighlightStyle fallback.
 *
 * Headings ride a modular type scale (~1.2 minor-third, slightly compressed at
 * the top). Size carries h1–h3; h4–h6 hold near body size and differentiate by
 * WEIGHT (h4), COLOR (h5), and CAPS+tracking (h6) so the hierarchy survives
 * where size alone runs out. These font sizes are the inline-span source of
 * truth — they style the heading text in both live-preview and raw/source mode.
 * The matching `.cm-ink-hN` line rules in glyphdownTheme add the per-level
 * line-height, letter-spacing, margins, caps, and the h1/h2 anchor rule; that
 * line class is applied in BOTH the resting and caret-revealed states, so
 * revealing the `#` markers never reflows a heading (the regression gate).
 */
export const glyphdownHighlightStyle = HighlightStyle.define([
  { tag: tags.heading1, fontSize: '1.6em', fontWeight: '700' },
  { tag: tags.heading2, fontSize: '1.35em', fontWeight: '700' },
  { tag: tags.heading3, fontSize: '1.25em', fontWeight: '600' },
  { tag: tags.heading4, fontSize: '1.08em', fontWeight: '700' },
  { tag: tags.heading5, fontSize: '0.95em', fontWeight: '700', color: 'var(--ink-heading-muted, #5f6b7a)' },
  {
    tag: tags.heading6,
    fontSize: '0.84em',
    fontWeight: '700',
    color: 'var(--ink-heading-muted, #5f6b7a)',
  },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.monospace, fontFamily: mono },
  { tag: tags.link, color: 'var(--accent, #2563eb)' },
  { tag: tags.url, color: 'var(--ink-faint, #8b95a3)' },
  { tag: tags.quote, color: 'var(--ink-block-muted, #5f6b7a)' },
  { tag: tags.contentSeparator, color: 'var(--ink-faint, #9ca3af)' },
  // Markdown syntax marks (#, *, >, -, `, [, ]) — dimmed when revealed.
  { tag: tags.processingInstruction, color: 'var(--ink-faint, #9aa3af)' },
])

export function glyphdownHighlighting(): Extension {
  return [syntaxHighlighting(glyphdownHighlightStyle), syntaxHighlighting(defaultHighlightStyle, { fallback: true })]
}

/**
 * A minimal document-like default theme. Everything is plain CSS classes so
 * apps can override or replace it wholesale.
 */
export const glyphdownTheme = EditorView.theme({
  '&': {
    backgroundColor: '#ffffff',
    // Body ink: bb's soft charcoal. Routed through --ink so the app's light +
    // dark tokens drive it; the fallback is the standalone soft-charcoal value.
    color: 'var(--ink, #33373d)',
    // ==Highlight== background (cm-ink-highlight in the live-preview layer).
    // A CSS custom property so the app's dark mode can tune it without
    // touching the editor package.
    '--ink-highlight-bg': 'rgba(255, 213, 0, 0.35)',
    // Callout accents (light defaults, Obsidian's palette). One var per
    // canonical type: the left border, icon, and title color use it
    // directly and the line tint derives from it via color-mix — so dark
    // mode only has to override these vars (no dark hook exists in this
    // theme; the app's `[data-theme="dark"]` block tunes them, exactly like
    // --ink-highlight-bg above).
    '--ink-callout-note': '#086ddd',
    '--ink-callout-abstract': '#00bfbc',
    '--ink-callout-info': '#086ddd',
    '--ink-callout-todo': '#086ddd',
    '--ink-callout-tip': '#00bfbc',
    '--ink-callout-success': '#08b94e',
    '--ink-callout-question': '#ec7500',
    '--ink-callout-warning': '#ec7500',
    '--ink-callout-failure': '#e93147',
    '--ink-callout-danger': '#e93147',
    '--ink-callout-bug': '#e93147',
    '--ink-callout-example': '#7852ee',
    '--ink-callout-quote': '#9e9e9e',
    // Footnote ref chips + definition labels.
    '--ink-footnote-accent': '#2563eb',
    // Read-only rendered tables: --ink-table-border / --ink-table-header-bg
    // are NOT declared here for the same shadowing reason as the NB below —
    // the app aliases them at :root and consuming rules carry light fallbacks.
    // NB: --ink-heading-muted (h5/h6 ink) is intentionally NOT declared here.
    // Vars set on this `&` block
    // shadow the app's `:root[data-theme=dark]` overrides (a closer
    // declaration wins over inherited :root), so dark tuning would never land.
    // Instead the consuming rules carry a light fallback (`var(--x, <light>)`)
    // and the app declares both light + dark values on :root, which inherit
    // cleanly into the editor.
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-content': {
    fontFamily: prose,
    fontSize: '17px',
    // Body copy: a relaxed reading measure (~1.65). Headings, code, and other
    // blocks override this per-element via their line classes.
    lineHeight: '1.65',
    padding: '32px 0',
    maxWidth: '44rem',
    margin: '0 auto',
    caretColor: 'var(--ink, #33373d)',
  },

  // --- Heading type scale + vertical rhythm -------------------------------
  // Sizing lives on the inline spans (glyphdownHighlightStyle); these line
  // rules carry the per-level line-height (unitless, so it scales with the
  // span's font-size), the negative letter-spacing on large headings, the
  // caps treatment, and the rhythm margins. The line class is present in both
  // resting and revealed states, so none of this reflows on caret reveal.
  //
  // Rhythm: each heading takes more space ABOVE than below (margin-top grows
  // with rank; a small negative margin-bottom pulls the following text up
  // toward the heading it introduces). Source blank lines still separate
  // paragraphs, so body spacing stays uniform while sections gain air.
  // Headings hold the original near-black so softening BODY ink (--ink) doesn't
  // drag heading darkness down with it. h1–h4 would otherwise inherit the
  // softened body color; h5/h6 set their own (muted) color and are unaffected.
  // Routed through --ink-heading so the app can retune for dark mode; the
  // fallback is the pre-softening ink. Color-only on the always-present line
  // class → reflow-safe.
  '.cm-ink-heading': { fontWeight: '700', color: 'var(--ink-heading, #1c2733)' },
  // The rhythm space is PADDING, not margin. CodeMirror's vertical height model
  // measures line blocks via offset geometry (offsetHeight/offsetTop), which
  // EXCLUDES margin but INCLUDES padding. A vertical margin on a `.cm-line`
  // decoration class therefore desyncs CM's internal Y model from the painted
  // layout — coordsAtPos/posAtCoords drift upward by the accumulated margin, so
  // a click lands a line (or several, after many headings) above the target.
  // Padding keeps the visual spacing identical while staying inside the box CM
  // measures, so the height model and the paint agree → zero click drift.
  // Headings carry no background or border, so margin↔padding is pixel-identical.
  // Set the VERTICAL axis via longhand only: horizontal line padding stays
  // owned by the `.cm-line` rule below (and the app's three-class override), so
  // headings keep the body text column. A `padding` shorthand here would zero
  // that horizontal padding.
  '.cm-ink-h1': {
    lineHeight: '1.2',
    letterSpacing: '-0.02em',
    paddingTop: '0.4em',
    paddingBottom: '0.1em',
  },
  '.cm-ink-h2': {
    lineHeight: '1.25',
    letterSpacing: '-0.015em',
    paddingTop: '1.4em',
    paddingBottom: '0.2em',
  },
  '.cm-ink-h3': { lineHeight: '1.3', letterSpacing: '-0.01em', paddingTop: '1.3em', paddingBottom: '0.1em' },
  '.cm-ink-h4': { lineHeight: '1.4', paddingTop: '1.2em', paddingBottom: '0.1em' },
  '.cm-ink-h5': { lineHeight: '1.4', paddingTop: '1.1em', paddingBottom: '0.1em' },
  '.cm-ink-h6': {
    lineHeight: '1.4',
    paddingTop: '1.1em',
    paddingBottom: '0.1em',
    textTransform: 'uppercase',
    letterSpacing: '0.07em',
  },
  // The first heading at the very top of a doc shouldn't push itself down past
  // the content's own top padding. Overrides the padding-top set above (the
  // rhythm space is padding now, so the top clamp is too).
  '.cm-content > .cm-ink-h1:first-child, .cm-content > .cm-ink-h2:first-child': {
    paddingTop: '0.1em',
  },
  '.cm-line': {
    // Horizontal longhand (not the `padding` shorthand) so the per-level
    // heading/hr line classes can set paddingTop/paddingBottom for vertical
    // rhythm WITHOUT this rule resetting it to 0 on the cascade. The vertical
    // rhythm lives in padding (CM6's height model excludes margin, includes
    // padding — see the heading block above), so it must not be clobbered here.
    paddingLeft: '16px',
    paddingRight: '16px',
    // Base line padding for the live-preview hanging-indent rule
    // (cm-ink-list-line): its padding-left calc() adds --ink-hang on top of
    // this var, so the var must mirror the padding-left above. Apps that
    // override .cm-line padding must override --ink-line-pad in the same rule
    // (apps/web does: 20px).
    '--ink-line-pad': '16px',
  },
  '.cm-scroller': { overflow: 'auto' },
  '.cm-cursor': { borderLeftColor: 'var(--ink, #33373d)' },
})
