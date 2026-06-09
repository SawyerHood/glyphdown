import type * as Y from 'yjs'
import { DIFF_DELETE, DIFF_EQUAL, DIFF_INSERT, cleanupSemantic, makeDiff } from '@sanity/diff-match-patch'
import { type Anchor, type Range, createAnchor, resolveAnchor } from './anchor.ts'
import { FUZZY_ACCEPT_THRESHOLD, similarity } from './quote.ts'

export type SuggestionStatus = 'open' | 'accepted' | 'rejected' | 'withdrawn'

export type SuggestionPart =
  | { kind: 'insert'; anchor: Anchor } // anchor spans suggested text, physically present in content
  | { kind: 'delete'; anchor: Anchor } // anchor spans text proposed for deletion, still present

export interface Suggestion {
  id: string
  authorId: string
  createdAt: number
  status: SuggestionStatus
  note?: string
  parts: SuggestionPart[]
}

function transact(ytext: Y.Text, fn: () => void, origin?: unknown): void {
  const doc = ytext.doc
  if (!doc) throw new Error('Y.Text must be attached to a Y.Doc')
  doc.transact(fn, origin)
}

function resolvedRanges(ytext: Y.Text, parts: SuggestionPart[], kind: SuggestionPart['kind']): Range[] {
  return parts
    .filter((p) => p.kind === kind)
    .map((p) => resolveAnchor(ytext, p.anchor))
    .filter((r): r is Range => r !== null && r.end > r.start)
}

function deleteRangesDescending(ytext: Y.Text, ranges: Range[]): void {
  const sorted = [...ranges].sort((a, b) => b.start - a.start)
  for (const r of sorted) ytext.delete(r.start, r.end - r.start)
}

/**
 * Accept: suggested insertions stay (already in content); proposed deletions
 * are applied — but only where the anchored text still matches the suggestion's
 * captured quote, so a drifted anchor can't splice unrelated text (GitHub's
 * "outdated" policy). Skipped parts are reported, never silently dropped.
 */
export function acceptSuggestion(
  ytext: Y.Text,
  suggestion: Suggestion,
  origin?: unknown,
): { suggestion: Suggestion; outdatedParts: SuggestionPart[] } {
  if (suggestion.status !== 'open') return { suggestion, outdatedParts: [] }
  const text = ytext.toString()
  const outdatedParts: SuggestionPart[] = []
  const safe: Range[] = []
  for (const part of suggestion.parts) {
    if (part.kind !== 'delete') continue
    const range = resolveAnchor(ytext, part.anchor)
    if (!range || range.end <= range.start) continue // already gone — nothing to apply
    const current = text.slice(range.start, range.end)
    if (similarity(current, part.anchor.quote.exact) >= FUZZY_ACCEPT_THRESHOLD) {
      safe.push(range)
    } else {
      outdatedParts.push(part)
    }
  }
  transact(ytext, () => deleteRangesDescending(ytext, safe), origin)
  return { suggestion: { ...suggestion, status: 'accepted' }, outdatedParts }
}

/** Reject: suggested insertions are removed; proposed deletions are kept. */
export function rejectSuggestion(ytext: Y.Text, suggestion: Suggestion, origin?: unknown): Suggestion {
  if (suggestion.status !== 'open') return suggestion
  transact(ytext, () => deleteRangesDescending(ytext, resolvedRanges(ytext, suggestion.parts, 'insert')), origin)
  return { ...suggestion, status: 'rejected' }
}

/**
 * The document as it reads with all open suggestions rejected: open suggested
 * insertions stripped, text pending deletion retained. (The "clean" export view;
 * the "working" view is simply ytext.toString().)
 */
export function cleanText(ytext: Y.Text, openSuggestions: Suggestion[]): string {
  const text = ytext.toString()
  const ranges = openSuggestions
    .filter((s) => s.status === 'open')
    .flatMap((s) => resolvedRanges(ytext, s.parts, 'insert'))
    .sort((a, b) => a.start - b.start)
  let out = ''
  let pos = 0
  for (const r of ranges) {
    if (r.start < pos) continue // overlapping insert ranges: outer one already stripped
    out += text.slice(pos, r.start)
    pos = r.end
  }
  return out + text.slice(pos)
}

export interface MaterializeInput {
  id: string
  authorId: string
  createdAt: number
  note?: string
}

/**
 * Turn a base→new text diff into a Suggestion against the current content
 * (used by `glyphdown push --suggest`): suggested insertions are physically inserted
 * and anchored; suggested deletions are anchored but the text is retained.
 * Assumes the diff was computed against the Y.Text's current content.
 */
export function materializeSuggestion(
  ytext: Y.Text,
  newText: string,
  input: MaterializeInput,
  origin?: unknown,
): Suggestion {
  const diffs = cleanupSemantic(makeDiff(ytext.toString(), newText))
  const parts: SuggestionPart[] = []
  transact(ytext, () => {
    let index = 0
    for (const [op, chunk] of diffs) {
      if (op === DIFF_EQUAL) {
        index += chunk.length
      } else if (op === DIFF_INSERT) {
        ytext.insert(index, chunk)
        parts.push({ kind: 'insert', anchor: createAnchor(ytext, index, index + chunk.length) })
        index += chunk.length
      } else if (op === DIFF_DELETE) {
        parts.push({ kind: 'delete', anchor: createAnchor(ytext, index, index + chunk.length) })
        index += chunk.length // proposed-deleted text is retained until accept
      }
    }
  }, origin)
  return { ...input, status: 'open', parts }
}
