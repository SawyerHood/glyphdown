import {
  EditorSelection,
  type EditorState,
  type Extension,
  Facet,
  type Range as RangeValue,
  StateEffect,
  StateField,
} from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import type { SyntaxNode } from '@lezer/common'
import {
  autocompletion,
  pickedCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete'
import { isTrackedCloser } from './autoclose.ts'
import { touchesSelection } from './live-preview.ts'

// ---------------------------------------------------------------------------
// The app-provided context
// ---------------------------------------------------------------------------

export interface WikiLinkDoc {
  docId: string
  title: string
}

/**
 * What the editor needs from the app to make `[[Doc Title]]` links live:
 * title resolution, the completion candidates, navigation, and (optionally)
 * create-on-click for unresolved targets. Provide via `wikiLinkContext.of()`.
 * Without a provider the extension still renders chips — everything is just
 * unresolved and clicks are no-ops.
 */
export interface WikiLinkContext {
  /** Title → doc, matched case-insensitively with collapsed whitespace. */
  resolve(title: string): { docId: string } | null
  /** Completion candidates (titles the current user can link to). */
  list(): WikiLinkDoc[]
  /** Navigate to a doc (chip click on a resolved link). */
  open(docId: string): void
  /** Create a doc for an unresolved target; the chip click then opens it. */
  create?(title: string): Promise<{ docId: string }>
}

const emptyWikiLinkContext: WikiLinkContext = {
  resolve: () => null,
  list: () => [],
  open: () => {},
}

export const wikiLinkContext = Facet.define<WikiLinkContext, WikiLinkContext>({
  combine: (values) => values[0] ?? emptyWikiLinkContext,
})

/**
 * Dispatch this (no payload) to force the wiki-link field to recompute — the
 * app fires it when its docs list changes, so chips flip between resolved and
 * unresolved without a doc or selection change.
 */
export const refreshWikiLinksEffect = StateEffect.define<null>()

// ---------------------------------------------------------------------------
// Title normalization + resolution
// ---------------------------------------------------------------------------

/** Case-insensitive, whitespace-collapsed key for matching titles. */
export function normalizeWikiTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Resolve a written target against a docs list with normalized matching.
 * First match wins on duplicate titles.
 */
export function resolveWikiTitle(docs: readonly WikiLinkDoc[], title: string): { docId: string } | null {
  const key = normalizeWikiTitle(title)
  if (key === '') return null
  for (const doc of docs) {
    if (normalizeWikiTitle(doc.title) === key) return { docId: doc.docId }
  }
  return null
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export interface WikiLink {
  /** Whole `[[...]]` range. */
  from: number
  to: number
  /** The written target title (raw, not normalized). */
  target: string
  targetFrom: number
  targetTo: number
  /** Alias text after `|`, or null when absent/blank. */
  alias: string | null
  /** The visible label (alias when present, else the target). */
  labelFrom: number
  labelTo: number
}

/**
 * `[[Target]]` / `[[Target|alias]]`. Targets must be non-blank and cannot
 * contain brackets, pipes, or newlines (the markdown file is the document of
 * record — titles stay portable and readable). A blank alias (`[[T|]]`)
 * falls back to the target as the label.
 */
const WIKI_LINK_RE = /\[\[([^[\]\n|]+)(?:\|([^[\]\n]*))?\]\]/g

export function findWikiLinks(text: string): WikiLink[] {
  const out: WikiLink[] = []
  for (const m of text.matchAll(WIKI_LINK_RE)) {
    const target = m[1]!
    if (target.trim() === '') continue
    const from = m.index
    const to = from + m[0].length
    const targetFrom = from + 2
    const targetTo = targetFrom + target.length
    const rawAlias = m[2]
    const alias = rawAlias !== undefined && rawAlias.trim() !== '' ? rawAlias : null
    out.push({
      from,
      to,
      target,
      targetFrom,
      targetTo,
      alias,
      labelFrom: alias !== null ? targetTo + 1 : targetFrom,
      labelTo: alias !== null ? targetTo + 1 + alias.length : targetTo,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Decorations (parallel to live-preview.ts, sharing its touchesSelection
// reveal gate — read-only editors never reveal raw `[[...]]` syntax)
// ---------------------------------------------------------------------------

function hide(from: number, to: number): RangeValue<Decoration> {
  return Decoration.replace({ glyphdown: 'hide' }).range(from, to)
}

/** Node names where `[[...]]` is literal text, not a link. */
const EXCLUDED_NODES = new Set(['InlineCode', 'FencedCode', 'CodeBlock', 'CodeText', 'Frontmatter', 'URL'])

function inExcludedNode(state: EditorState, pos: number): boolean {
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent) {
    if (EXCLUDED_NODES.has(node.name)) return true
  }
  return false
}

function computeWikiLinkDecorations(state: EditorState): DecorationSet {
  const ctx = state.facet(wikiLinkContext)
  const decos: RangeValue<Decoration>[] = []
  for (const link of findWikiLinks(state.doc.toString())) {
    if (inExcludedNode(state, link.from + 1)) continue
    // Cursor entry reveals the raw syntax, like other live-preview chips.
    if (touchesSelection(state, link.from, link.to)) continue
    const resolved = ctx.resolve(link.target)
    decos.push(hide(link.from, link.labelFrom))
    decos.push(hide(link.labelTo, link.to))
    decos.push(
      Decoration.mark({
        glyphdown: 'wikilink',
        class: resolved ? 'cm-ink-wikilink' : 'cm-ink-wikilink cm-ink-wikilink-unresolved',
        attributes: {
          'data-wikilink': link.target,
          ...(resolved ? { 'data-doc-id': resolved.docId } : {}),
          title: resolved
            ? `Open "${link.target}"`
            : ctx.create
              ? `Create "${link.target}"`
              : `No document "${link.target}"`,
        },
      }).range(link.labelFrom, link.labelTo),
    )
  }
  return Decoration.set(decos, true)
}

/**
 * Wiki-link chips computed from the document text. Recomputed on doc changes,
 * selection changes, async parse progress (code-region exclusion),
 * reconfiguration (the readOnly compartment flip changes the reveal gate's
 * answer), and the app's refresh effect (docs list changed).
 */
export const wikiLinkField = StateField.define<DecorationSet>({
  create: computeWikiLinkDecorations,
  update(value, tr) {
    if (
      tr.docChanged ||
      tr.selection ||
      tr.reconfigured ||
      syntaxTree(tr.state) !== syntaxTree(tr.startState) ||
      tr.effects.some((e) => e.is(refreshWikiLinksEffect))
    ) {
      return computeWikiLinkDecorations(tr.state)
    }
    return value
  },
  provide: (f) => EditorView.decorations.from(f),
})

// ---------------------------------------------------------------------------
// Autocomplete
// ---------------------------------------------------------------------------

/**
 * How many auto-closed `]` characters at `pos` the completion should consume
 * so inserting `Title]]` doesn't double the closers. Typing `[[` through
 * markdownAutoClose leaves `[[|]]` (two tracked closers); re-completing
 * inside an existing link leaves the link's own untracked `]]`. A single
 * stray user-typed `]` is NOT consumed.
 */
export function wikiClosersToConsume(state: EditorState, pos: number): number {
  if (state.doc.sliceString(pos, pos + 2) === ']]') return 2
  if (state.doc.sliceString(pos, pos + 1) === ']' && isTrackedCloser(state, pos)) return 1
  return 0
}

/**
 * Insert a picked title as `Title]]` over [from, to) plus any closers that
 * should be consumed, leaving the cursor after the completed link. Dispatches
 * a normal `input.complete` transaction, so suggest mode's SuggestSession
 * captures it like ordinary typing.
 */
export function applyWikiLinkCompletion(
  view: EditorView,
  title: string,
  from: number,
  to: number,
  completion?: Completion,
): void {
  const insert = `${title}]]`
  view.dispatch({
    changes: { from, to: to + wikiClosersToConsume(view.state, to), insert },
    selection: EditorSelection.cursor(from + insert.length),
    scrollIntoView: true,
    userEvent: 'input.complete',
    ...(completion ? { annotations: pickedCompletion.of(completion) } : {}),
  })
}

const applyOption = (view: EditorView, completion: Completion, from: number, to: number): void => {
  applyWikiLinkCompletion(view, completion.label, from, to, completion)
}

/**
 * Completion source: active when the cursor sits after `[[` (plus a partial
 * target). Offers every title from the context's list(); the autocomplete
 * library fuzzy-filters them against the typed query. Inactive once a `|`
 * is typed — the title is settled, the user is writing the alias.
 */
export function wikiLinkCompletionSource(context: CompletionContext): CompletionResult | null {
  const match = context.matchBefore(/\[\[([^[\]\n|]*)$/)
  if (!match) return null
  const docs = context.state.facet(wikiLinkContext).list()
  if (docs.length === 0) return null
  const options: Completion[] = docs.map((doc) => ({ label: doc.title, apply: applyOption }))
  return { from: match.from + 2, options, validFor: /^[^[\]\n|]*$/ }
}

// ---------------------------------------------------------------------------
// Click handling + theme
// ---------------------------------------------------------------------------

const wikiLinkClickHandler = EditorView.domEventHandlers({
  // mousedown (the CheckboxWidget pattern): acting before the click would
  // move the cursor into the link keeps the chip's DOM stable. Modified
  // clicks fall through so the cursor can still be placed to edit.
  mousedown: (event, view) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false
    const el = event.target instanceof Element ? event.target.closest('.cm-ink-wikilink') : null
    const title = el?.getAttribute('data-wikilink')
    if (!title) return false
    const ctx = view.state.facet(wikiLinkContext)
    const resolved = ctx.resolve(title)
    if (resolved) {
      event.preventDefault()
      ctx.open(resolved.docId)
      return true
    }
    const create = ctx.create
    if (!create) return false // unresolved, no create flow: let the click place the cursor
    event.preventDefault()
    void create(title)
      .then(({ docId }) => ctx.open(docId))
      .catch(() => {}) // the app's create reports its own errors
    return true
  },
})

const wikiLinkBaseTheme = EditorView.baseTheme({
  '.cm-ink-wikilink': {
    color: 'var(--accent, #2563eb)',
    textDecoration: 'underline',
    textUnderlineOffset: '2px',
    cursor: 'pointer',
  },
  '.cm-ink-wikilink-unresolved': {
    color: '#8b95a3',
    textDecorationStyle: 'dashed',
  },
})

/**
 * Wiki links: `[[Doc Title]]` / `[[Doc Title|alias]]` chips with cursor-entry
 * reveal, click-to-open (or create-on-click for unresolved targets when the
 * context provides `create`), and `[[`-triggered title autocomplete. Pair
 * with `wikiLinkContext.of(...)` from the app. Note: the autocomplete source
 * is registered via `autocompletion({ override })` — compose other sources
 * here if the editor ever grows more completions.
 */
export function wikiLinks(): Extension {
  return [
    wikiLinkField,
    wikiLinkBaseTheme,
    wikiLinkClickHandler,
    autocompletion({ override: [wikiLinkCompletionSource], icons: false }),
  ]
}
