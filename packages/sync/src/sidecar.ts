import type * as Y from 'yjs'
import { type Anchor, createAnchor, rejectSuggestion, validateOrReanchor } from '@glyphdown/core'
import type { Comment, CommentReply, Principal, SuggestionRecord } from '@glyphdown/protocol'

/**
 * Pure sidecar-record logic for the DocDO: comment construction/validation,
 * reaction toggling, manual re-attachment, and post-rewrite anchor
 * revalidation. Kept free of Durable Object APIs so it can be unit-tested
 * against a plain Y.Doc.
 */

/** Anchored ranges shorter than this are too ambiguous to ever re-anchor (SPEC §6.1). */
export const MIN_ANCHOR_CHARS = 8

/** System note attached when an orphaned suggestion is auto-rejected (SPEC §6.1). */
export const ORPHAN_REJECT_NOTE =
  'Auto-rejected: the suggested ranges could no longer be located after the document was rewritten.'

/** A suggestion row as stored in the DO: the wire record plus server bookkeeping. */
export interface StoredSuggestion extends SuggestionRecord {
  /** Count of delete parts skipped as outdated by the accept drift guard. */
  outdatedParts?: number
  /** Server-attached annotation (e.g. the auto-reject reason). */
  systemNote?: string
}

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string }

export interface CommentRange {
  start: number
  end: number
}

export function validateRange(value: unknown, textLength: number): Validated<CommentRange> {
  if (typeof value !== 'object' || value === null) return { ok: false, error: 'range-required' }
  const { start, end } = value as { start?: unknown; end?: unknown }
  if (typeof start !== 'number' || typeof end !== 'number' || !Number.isInteger(start) || !Number.isInteger(end)) {
    return { ok: false, error: 'range-invalid' }
  }
  if (start < 0 || end > textLength || end < start) return { ok: false, error: 'range-out-of-bounds' }
  if (end - start < MIN_ANCHOR_CHARS) return { ok: false, error: 'anchor-too-short' }
  return { ok: true, value: { start, end } }
}

/** Build a protocol Comment row; `range` omitted/null = doc-level comment. */
export function buildComment(
  ytext: Y.Text,
  principal: Principal,
  body: unknown,
  range?: unknown,
  id: string = crypto.randomUUID(),
  createdAt: number = Date.now(),
): Validated<Comment> {
  if (typeof body !== 'string' || body.trim().length === 0) return { ok: false, error: 'body-required' }
  let anchor: Anchor | null = null
  if (range !== undefined && range !== null) {
    const valid = validateRange(range, ytext.length)
    if (!valid.ok) return valid
    anchor = createAnchor(ytext, valid.value.start, valid.value.end)
  }
  return {
    ok: true,
    value: {
      id,
      anchor,
      authorId: principal.id,
      authorName: principal.name,
      body,
      createdAt,
      resolved: false,
      reactions: {},
      replies: [],
    },
  }
}

export function buildReply(
  principal: Principal,
  body: unknown,
  id: string = crypto.randomUUID(),
  createdAt: number = Date.now(),
): Validated<CommentReply> {
  if (typeof body !== 'string' || body.trim().length === 0) return { ok: false, error: 'body-required' }
  return {
    ok: true,
    value: { id, authorId: principal.id, authorName: principal.name, body, createdAt, reactions: {} },
  }
}

/** Toggle a principal's reaction; empty reaction sets are dropped. */
export function toggleReaction(
  reactions: Record<string, string[]>,
  emoji: string,
  principalId: string,
): Record<string, string[]> {
  const current = reactions[emoji] ?? []
  const next = current.includes(principalId) ? current.filter((id) => id !== principalId) : [...current, principalId]
  const out = { ...reactions }
  if (next.length === 0) delete out[emoji]
  else out[emoji] = next
  return out
}

/** Manually re-attach a comment to a freshly selected range (orphan recovery). */
export function reattachComment(ytext: Y.Text, comment: Comment, range: unknown): Validated<Comment> {
  const valid = validateRange(range, ytext.length)
  if (!valid.ok) return valid
  return { ok: true, value: { ...comment, anchor: createAnchor(ytext, valid.value.start, valid.value.end) } }
}

function anchorsEqual(a: Anchor, b: Anchor): boolean {
  return (
    a.start === b.start &&
    a.end === b.end &&
    a.hint === b.hint &&
    a.status === b.status &&
    a.quote.exact === b.quote.exact &&
    a.quote.prefix === b.quote.prefix &&
    a.quote.suffix === b.quote.suffix
  )
}

export interface RevalidationResult {
  /** Comments whose anchor changed (re-anchored, refreshed, or orphaned). */
  comments: Comment[]
  /** Open suggestions whose part anchors changed but all still resolve. */
  suggestions: StoredSuggestion[]
  /** Open suggestions auto-rejected because a part anchor orphaned (SPEC §6.1). */
  rejected: StoredSuggestion[]
}

/**
 * Re-validate every comment/suggestion anchor after an out-of-band rewrite
 * (CLI push merge, version restore, suggestion accept/reject deletions).
 * Comments orphan gracefully; suggestions with any orphaned part are
 * auto-rejected — which strips their still-resolving suggested-insert ranges
 * from `ytext` (mutation happens here, in one transaction per rejection).
 */
export function revalidateAnchors(
  ytext: Y.Text,
  comments: Comment[],
  suggestions: StoredSuggestion[],
  origin?: unknown,
): RevalidationResult {
  const changedComments: Comment[] = []
  for (const comment of comments) {
    if (!comment.anchor) continue
    const { anchor } = validateOrReanchor(ytext, comment.anchor)
    if (!anchorsEqual(anchor, comment.anchor)) changedComments.push({ ...comment, anchor })
  }

  const changedSuggestions: StoredSuggestion[] = []
  const rejected: StoredSuggestion[] = []
  for (const suggestion of suggestions) {
    if (suggestion.status !== 'open') continue
    let changed = false
    let orphaned = false
    const parts = suggestion.parts.map((part) => {
      const { anchor } = validateOrReanchor(ytext, part.anchor)
      if (anchor.status === 'orphaned') orphaned = true
      if (anchorsEqual(anchor, part.anchor)) return part
      changed = true
      return { ...part, anchor }
    })
    if (orphaned) {
      const next = rejectSuggestion(ytext, { ...suggestion, parts }, origin) as StoredSuggestion
      rejected.push({ ...next, systemNote: ORPHAN_REJECT_NOTE })
    } else if (changed) {
      changedSuggestions.push({ ...suggestion, parts })
    }
  }

  return { comments: changedComments, suggestions: changedSuggestions, rejected }
}
