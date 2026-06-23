import {
  EditorSelection,
  type EditorState,
  type Extension,
  type SelectionRange,
  MapMode,
  RangeSet,
  RangeValue,
  StateEffect,
  StateField,
  type TransactionSpec,
} from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'

// ---------------------------------------------------------------------------
// Pair tables
// ---------------------------------------------------------------------------

/** Same-char pairs that only open at a word boundary (emphasis + quotes). */
const GUARDED_SAME = '*_~"'
/** Same-char pairs that open anywhere (inline code). */
const UNGUARDED_SAME = '`'
const SAME_CHARS = GUARDED_SAME + UNGUARDED_SAME

const BRACKETS: Record<string, string> = { '(': ')', '[': ']', '{': '}' }
const CLOSING_BRACKETS: Record<string, string> = { ')': '(', ']': '[', '}': '{' }

/**
 * The opener boundary guard: a guarded char may only start a pair at line
 * start or after whitespace / another delimiter, so `snake_case` and `2*3`
 * keep their literal characters.
 */
const BOUNDARY_BEFORE = /[\s([{>"'*~_-]/

function boundaryOk(state: EditorState, pos: number): boolean {
  const line = state.doc.lineAt(pos)
  if (pos === line.from) return true
  return BOUNDARY_BEFORE.test(state.doc.sliceString(pos - 1, pos))
}

const WORD_CHAR = /[\p{L}\p{N}_']/u
const WORD_LETTER = /\p{L}/u

interface TextRange {
  from: number
  to: number
  anchor: number
  head: number
}

function isWordChar(ch: string): boolean {
  return ch.length > 0 && WORD_CHAR.test(ch)
}

function expandWordAt(state: EditorState, pos: number): TextRange | null {
  if (pos < 0 || pos >= state.doc.length || !isWordChar(state.doc.sliceString(pos, pos + 1))) return null

  let from = pos
  while (from > 0 && isWordChar(state.doc.sliceString(from - 1, from))) from--

  let to = pos + 1
  while (to < state.doc.length && isWordChar(state.doc.sliceString(to, to + 1))) to++

  const text = state.doc.sliceString(from, to)
  if (!WORD_LETTER.test(text)) return null

  return { from, to, anchor: from, head: to }
}

function wordNextToCursor(state: EditorState, pos: number): TextRange | null {
  const before = pos > 0 ? state.doc.sliceString(pos - 1, pos) : ''
  const after = state.doc.sliceString(pos, pos + 1)
  const beforeWord = isWordChar(before)
  const afterWord = isWordChar(after)
  if (beforeWord === afterWord) return null
  return afterWord ? expandWordAt(state, pos) : expandWordAt(state, pos - 1)
}

function wordAtOrNextToCursor(state: EditorState, pos: number): TextRange | null {
  if (pos < state.doc.length && isWordChar(state.doc.sliceString(pos, pos + 1))) return expandWordAt(state, pos)
  if (pos > 0 && isWordChar(state.doc.sliceString(pos - 1, pos))) return expandWordAt(state, pos - 1)
  return null
}

function rangeTextTarget(state: EditorState, range: SelectionRange): TextRange {
  if (!range.empty) return { from: range.from, to: range.to, anchor: range.anchor, head: range.head }
  return wordAtOrNextToCursor(state, range.head) ?? { from: range.head, to: range.head, anchor: range.head, head: range.head }
}

function isWrapped(state: EditorState, range: TextRange, open: string, close: string): boolean {
  return (
    range.from >= open.length &&
    range.to + close.length <= state.doc.length &&
    state.doc.sliceString(range.from - open.length, range.from) === open &&
    state.doc.sliceString(range.to, range.to + close.length) === close
  )
}

// ---------------------------------------------------------------------------
// Tracking auto-inserted closers
// ---------------------------------------------------------------------------

/** Marks the position of an auto-inserted closer (in post-change coordinates). */
const trackCloserEffect = StateEffect.define<number>({
  map(value, mapping) {
    const mapped = mapping.mapPos(value, -1, MapMode.TrackAfter)
    return mapped === null ? undefined : mapped
  },
})

class TrackedCloser extends RangeValue {
  override startSide = 1
  override endSide = -1
}
const trackedCloser = new TrackedCloser()

/**
 * Positions of auto-inserted closing characters, mapped through document
 * changes (the default TrackDel map mode drops an entry as soon as its text
 * is deleted). Skip and backspace-pair rules consult this set so they never
 * eat characters the user typed themselves.
 */
const trackedClosersField = StateField.define<RangeSet<TrackedCloser>>({
  create: () => RangeSet.empty,
  update(value, tr) {
    value = value.map(tr.changes)
    for (const effect of tr.effects) {
      if (effect.is(trackCloserEffect)) {
        value = value.update({ add: [trackedCloser.range(effect.value, effect.value + 1)] })
      }
    }
    return value
  },
})

/**
 * Was the character at `pos` auto-inserted as a pair closer (and not yet
 * consumed)? Exposed so other extensions (wiki-link completion) can tell an
 * auto-closed `]` apart from one the user typed.
 */
export function isTrackedCloser(state: EditorState, pos: number): boolean {
  const field = state.field(trackedClosersField, false)
  if (!field) return false
  let found = false
  field.between(pos, pos + 1, (from) => {
    if (from === pos) found = true
  })
  return found
}

// ---------------------------------------------------------------------------
// Pure handlers
// ---------------------------------------------------------------------------

/**
 * Code-fence transform: typing a backtick when the current line holds exactly
 * optional-indent + "``" before the cursor expands to a fenced block — the
 * opening fence on the current line, the cursor alone on a fresh indented
 * line, and a closing fence below. Tracked auto-closed backticks sitting
 * right after the cursor are consumed so they don't linger as strays.
 */
function fenceTransform(state: EditorState): TransactionSpec | null {
  if (state.selection.ranges.length !== 1) return null
  const range = state.selection.main
  if (!range.empty) return null
  const head = range.head
  const line = state.doc.lineAt(head)
  const match = /^([ \t]*)``$/.exec(state.doc.sliceString(line.from, head))
  if (!match) return null
  const indent = match[1]!
  let consumeTo = head
  while (
    consumeTo < line.to &&
    state.doc.sliceString(consumeTo, consumeTo + 1) === '`' &&
    isTrackedCloser(state, consumeTo)
  ) {
    consumeTo++
  }
  return {
    changes: [
      { from: head, to: consumeTo, insert: '`\n' + indent },
      { from: line.to, insert: '\n' + indent + '```' },
    ],
    selection: EditorSelection.cursor(head + 2 + indent.length),
    scrollIntoView: true,
    userEvent: 'input.type',
  }
}

/**
 * Pure auto-close logic for a typed character: returns the transaction spec
 * implementing pairing / skipping / doubling / wrapping / fence expansion,
 * or null when the default insertion should happen. Dispatching the spec is
 * the caller's job (the inputHandler below, or tests).
 */
export function autoCloseInsert(state: EditorState, ch: string): TransactionSpec | null {
  if (state.readOnly || ch.length !== 1) return null

  if (ch === '`') {
    const fence = fenceTransform(state)
    if (fence) return fence
  }

  const bracketClose = BRACKETS[ch]
  const isSame = SAME_CHARS.includes(ch)
  const isClosingBracket = CLOSING_BRACKETS[ch] !== undefined
  if (!isSame && bracketClose === undefined && !isClosingBracket) return null

  let dont = false
  const byRange = state.changeByRange((range) => {
    // Selection wrap: any opener around a non-empty range, selection kept inside.
    if (!range.empty) {
      if (isSame || bracketClose !== undefined) {
        const closer = bracketClose ?? ch
        return {
          changes: [
            { from: range.from, insert: ch },
            { from: range.to, insert: closer },
          ],
          effects: trackCloserEffect.of(range.to + 1),
          range: EditorSelection.range(range.anchor + 1, range.head + 1),
        }
      }
      dont = true
      return { range }
    }

    const head = range.head
    const before = head > 0 ? state.doc.sliceString(head - 1, head) : ''
    const after = state.doc.sliceString(head, head + 1)

    if (isSame) {
      // Doubling: extend an empty/extending pair on both sides (*|* -> **|**).
      if (before === ch && after === ch) {
        return {
          changes: { from: head, insert: ch + ch },
          effects: trackCloserEffect.of(head + 1),
          range: EditorSelection.cursor(head + 1),
        }
      }
      // Skip: move over an auto-inserted closer instead of typing a new one.
      if (after === ch && isTrackedCloser(state, head)) {
        return { range: EditorSelection.cursor(head + 1) }
      }
      // Boundary word wrap: *word| / |word + * becomes *word*, with the
      // wrapped word selected so a second * naturally makes **word**.
      if (ch === '*') {
        const word = wordNextToCursor(state, head)
        if (word) {
          return {
            changes: [
              { from: word.from, insert: ch },
              { from: word.to, insert: ch },
            ],
            effects: trackCloserEffect.of(word.to + 1),
            range: EditorSelection.range(word.from + 1, word.to + 1),
          }
        }
      }
      // Close: open a pair when the boundary guard passes.
      if (UNGUARDED_SAME.includes(ch) || boundaryOk(state, head)) {
        return {
          changes: { from: head, insert: ch + ch },
          effects: trackCloserEffect.of(head + 1),
          range: EditorSelection.cursor(head + 1),
        }
      }
      dont = true
      return { range }
    }

    if (bracketClose !== undefined) {
      return {
        changes: { from: head, insert: ch + bracketClose },
        effects: trackCloserEffect.of(head + 1),
        range: EditorSelection.cursor(head + 1),
      }
    }

    // Closing bracket: skip a tracked auto-inserted closer, nothing more.
    if (after === ch && isTrackedCloser(state, head)) {
      return { range: EditorSelection.cursor(head + 1) }
    }
    dont = true
    return { range }
  })
  if (dont) return null

  return { ...byRange, scrollIntoView: true, userEvent: 'input.type' }
}

export function markdownFormat(state: EditorState, open: string, close = open): TransactionSpec | null {
  if (state.readOnly || open.length === 0 || close.length === 0) return null

  const byRange = state.changeByRange((selectionRange) => {
    const target = rangeTextTarget(state, selectionRange)

    if (isWrapped(state, target, open, close)) {
      return {
        changes: [
          { from: target.from - open.length, to: target.from },
          { from: target.to, to: target.to + close.length },
        ],
        range: EditorSelection.range(target.anchor - open.length, target.head - open.length),
      }
    }

    return {
      changes: [
        { from: target.from, insert: open },
        { from: target.to, insert: close },
      ],
      range: EditorSelection.range(target.anchor + open.length, target.head + open.length),
    }
  })

  return { ...byRange, scrollIntoView: true, userEvent: 'input.type' }
}

function formatCommand(open: string, close = open) {
  return (view: EditorView): boolean => {
    const spec = markdownFormat(view.state, open, close)
    if (!spec) return false
    view.dispatch(spec)
    return true
  }
}

/**
 * Pure Backspace logic: when every cursor sits inside an empty pair whose
 * closer was auto-inserted, delete both characters. Returns null otherwise
 * so the keymap falls through to the default behavior.
 */
export function autoCloseBackspace(state: EditorState): TransactionSpec | null {
  if (state.readOnly) return null

  let dont = false
  const byRange = state.changeByRange((range) => {
    if (range.empty && range.head > 0) {
      const head = range.head
      const before = state.doc.sliceString(head - 1, head)
      const after = state.doc.sliceString(head, head + 1)
      const emptyPair = (SAME_CHARS.includes(before) && after === before) || BRACKETS[before] === after
      if (emptyPair && isTrackedCloser(state, head)) {
        return {
          changes: { from: head - 1, to: head + 1 },
          range: EditorSelection.cursor(head - 1),
        }
      }
    }
    dont = true
    return { range }
  })
  if (dont) return null

  return { ...byRange, scrollIntoView: true, userEvent: 'delete.backward' }
}

// ---------------------------------------------------------------------------
// The extension
// ---------------------------------------------------------------------------

const inputHandler = EditorView.inputHandler.of((view, from, to, insert) => {
  if (view.compositionStarted || view.state.readOnly) return false
  const sel = view.state.selection.main
  if (from !== sel.from || to !== sel.to) return false
  const spec = autoCloseInsert(view.state, insert)
  if (!spec) return false
  view.dispatch(spec)
  return true
})

const autoCloseKeymap = keymap.of([
  {
    key: 'Backspace',
    run: (view: EditorView) => {
      const spec = autoCloseBackspace(view.state)
      if (!spec) return false
      view.dispatch(spec)
      return true
    },
  },
  { key: 'Mod-b', run: formatCommand('**') },
  { key: 'Mod-i', run: formatCommand('*') },
  { key: 'Mod-u', run: formatCommand('<u>', '</u>') },
])

/**
 * Markdown auto-closing pairs: emphasis (* _ ~), quotes (` "), brackets
 * ([ ( {), ``` fence expansion, Backspace deleting empty pairs, and common
 * formatting shortcuts (Mod-B/I/U). All insertions dispatch as 'input.type'
 * so suggest mode routes them through the SuggestSession like ordinary
 * typing. Place before the default keymap so the Backspace binding wins over
 * deleteCharBackward.
 */
export function markdownAutoClose(): Extension {
  return [trackedClosersField, inputHandler, autoCloseKeymap]
}
