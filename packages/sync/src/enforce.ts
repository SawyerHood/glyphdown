import type * as Y from 'yjs'
import { resolveAnchor } from '@glyphdown/core'
import type { SuggestionRecord } from '@glyphdown/protocol'

/**
 * Server-side suggester enforcement (SPEC §6.4): pure delta-vs-anchors logic
 * for the DocDO. y-partyserver applies every remote sync message in a
 * transaction whose origin is the sending Connection (verified in
 * y-partyserver/dist/server/index.js: `handleMessage` passes `connection` as
 * `transactionOrigin` into `syncProtocol.readSyncStep2` / `readUpdate`), so
 * the DO can observe Y.Text deltas, attribute them to a connection, and
 * validate suggester-role writes:
 *
 *  - insertions are always acceptable text-wise: they either extend one of
 *    the author's open suggested-insert anchors or start a new suggested
 *    insert (which the client registers via a `suggestion-upsert` message
 *    that follows the Yjs update on the same socket, so ordering holds);
 *  - deletions must fall entirely inside the author's own open
 *    suggested-insert ranges (retracting your own pending insertion is the
 *    only real deletion suggest mode performs — original text is only ever
 *    *marked* for deletion);
 *  - formatting attributes and non-string (embed) inserts are never valid:
 *    `content` is plain markdown.
 *
 * On violation the DO applies `invertDelta` in a 'server-enforce' origin
 * transaction and closes the offending connection (4403).
 */

/** A Y.Text event delta op (Quill shape), as delivered by YTextEvent.delta. */
export interface DeltaOp {
  retain?: number
  insert?: string | object
  delete?: number
  attributes?: Record<string, unknown>
}

export interface OffsetRange {
  start: number
  end: number
}

export type SuggesterVerdict = { ok: true } | { ok: false; reason: string }

/** Sort + merge overlapping/adjacent ranges so coverage checks see unions. */
export function mergeRanges(ranges: readonly OffsetRange[]): OffsetRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)
  const merged: OffsetRange[] = []
  for (const range of sorted) {
    const last = merged[merged.length - 1]
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end)
    else merged.push({ ...range })
  }
  return merged
}

/**
 * Resolve the author's open suggested-insert anchors to current offsets.
 * Call BEFORE applying a remote message: the returned ranges are pre-state
 * coordinates, matching the retain/delete offsets of the resulting delta.
 */
export function ownOpenInsertRanges(
  ytext: Y.Text,
  suggestions: readonly SuggestionRecord[],
  authorId: string,
): OffsetRange[] {
  const ranges: OffsetRange[] = []
  for (const suggestion of suggestions) {
    if (suggestion.status !== 'open' || suggestion.authorId !== authorId) continue
    for (const part of suggestion.parts) {
      if (part.kind !== 'insert') continue
      const range = resolveAnchor(ytext, part.anchor)
      if (range && range.end > range.start) ranges.push(range)
    }
  }
  return mergeRanges(ranges)
}

/**
 * Validate a suggester connection's Y.Text delta against that author's open
 * suggested-insert ranges (both in pre-transaction coordinates).
 */
export function checkSuggesterDelta(
  delta: readonly DeltaOp[],
  ownInsertRanges: readonly OffsetRange[],
): SuggesterVerdict {
  const merged = mergeRanges(ownInsertRanges)
  let pre = 0
  for (const op of delta) {
    if (op.attributes && Object.keys(op.attributes).length > 0) {
      return { ok: false, reason: 'formatting-not-allowed' }
    }
    if (op.retain !== undefined) {
      pre += op.retain
    } else if (op.insert !== undefined) {
      if (typeof op.insert !== 'string') return { ok: false, reason: 'non-text-insert' }
      // Text insertions are fine anywhere (extend an anchor or start a new
      // suggested insert) — see module docs.
    } else if (op.delete !== undefined) {
      const end = pre + op.delete
      if (!merged.some((r) => r.start <= pre && end <= r.end)) {
        return { ok: false, reason: `delete-outside-own-insert:${pre}+${op.delete}` }
      }
      pre = end
    }
  }
  return { ok: true }
}

/**
 * Compute the delta that undoes `delta`, applicable to the POST-transaction
 * text. `preText` is the document text from before the transaction (needed to
 * restore deleted content — Y.Text deltas carry only delete counts).
 * Formatting retains invert by nulling every attribute key (valid because
 * `content` never carries attributes legitimately).
 */
export function invertDelta(delta: readonly DeltaOp[], preText: string): DeltaOp[] {
  const inverse: DeltaOp[] = []
  let pre = 0
  for (const op of delta) {
    if (op.retain !== undefined) {
      if (op.attributes && Object.keys(op.attributes).length > 0) {
        inverse.push({
          retain: op.retain,
          attributes: Object.fromEntries(Object.keys(op.attributes).map((k) => [k, null])),
        })
      } else {
        inverse.push({ retain: op.retain })
      }
      pre += op.retain
    } else if (op.insert !== undefined) {
      inverse.push({ delete: typeof op.insert === 'string' ? op.insert.length : 1 })
    } else if (op.delete !== undefined) {
      inverse.push({ insert: preText.slice(pre, pre + op.delete) })
      pre += op.delete
    }
  }
  // Trailing retains are no-ops for applyDelta.
  while (inverse.length > 0) {
    const last = inverse[inverse.length - 1]!
    if (last.retain !== undefined && last.attributes === undefined) inverse.pop()
    else break
  }
  return inverse
}
