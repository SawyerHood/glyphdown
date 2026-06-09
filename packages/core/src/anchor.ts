import * as Y from 'yjs'
import { REANCHOR_THRESHOLD, type TextQuote, captureQuote, findQuote, similarity } from './quote.ts'

/**
 * A position-tracked range over the document text. Relative positions track
 * exactly through live CRDT edits; the quote allows fuzzy re-anchoring after
 * out-of-band rewrites (CLI push merges) and graceful orphaning; the hint
 * biases re-anchoring toward the range's last known offset.
 */
export interface Anchor {
  /** base64-encoded Y.RelativePosition, association: right */
  start: string
  /** base64-encoded Y.RelativePosition, association: left */
  end: string
  quote: TextQuote
  /** last known start offset (TextPositionSelector-style search hint) */
  hint: number
  status: 'anchored' | 'orphaned'
}

export interface Range {
  start: number
  end: number
}

function docOf(ytext: Y.Text): Y.Doc {
  const doc = ytext.doc
  if (!doc) throw new Error('Y.Text must be attached to a Y.Doc')
  return doc
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64_LOOKUP = new Map([...B64].map((c, i) => [c, i]))

function toBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    out += B64[a >> 2]! + B64[((a & 3) << 4) | ((b ?? 0) >> 4)]!
    out += b === undefined ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)]!
    out += c === undefined ? '=' : B64[c & 63]!
  }
  return out
}

function fromBase64(s: string): Uint8Array {
  const clean = s.replace(/=+$/, '')
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let bi = 0
  for (let i = 0; i < clean.length; i += 4) {
    const n = [0, 1, 2, 3].map((k) => B64_LOOKUP.get(clean[i + k] ?? '') ?? 0)
    const chunk = (n[0]! << 18) | (n[1]! << 12) | (n[2]! << 6) | n[3]!
    const have = Math.min(4, clean.length - i)
    if (have > 1) bytes[bi++] = (chunk >> 16) & 0xff
    if (have > 2) bytes[bi++] = (chunk >> 8) & 0xff
    if (have > 3) bytes[bi++] = chunk & 0xff
  }
  return bytes
}

export function encodeRelPos(pos: Y.RelativePosition): string {
  return toBase64(Y.encodeRelativePosition(pos))
}

export function decodeRelPos(s: string): Y.RelativePosition {
  return Y.decodeRelativePosition(fromBase64(s))
}

export function createAnchor(ytext: Y.Text, start: number, end: number): Anchor {
  const text = ytext.toString()
  return {
    start: encodeRelPos(Y.createRelativePositionFromTypeIndex(ytext, start, 0)),
    end: encodeRelPos(Y.createRelativePositionFromTypeIndex(ytext, end, -1)),
    quote: captureQuote(text, start, end),
    hint: start,
    status: 'anchored',
  }
}

/**
 * Resolve an anchor's relative positions to current offsets. Returns null if
 * either position no longer resolves or the range inverted (its content was
 * removed out from under it). Resolution ignores undone deletions so every
 * client and the server agree on shared anchor positions (yjs#638).
 */
export function resolveAnchor(ytext: Y.Text, anchor: Anchor): Range | null {
  const doc = docOf(ytext)
  const start = Y.createAbsolutePositionFromRelativePosition(decodeRelPos(anchor.start), doc, false)
  const end = Y.createAbsolutePositionFromRelativePosition(decodeRelPos(anchor.end), doc, false)
  if (!start || !end || start.type !== ytext || end.type !== ytext) return null
  if (end.index < start.index) return null
  return { start: start.index, end: end.index }
}

/**
 * Validate an anchor after the document may have been rewritten out-of-band.
 * Keeps it if the resolved range still matches its quote; otherwise tries to
 * re-anchor by quote search; otherwise orphans it. Returns the (possibly
 * updated) anchor and its current range when anchored.
 */
export function validateOrReanchor(ytext: Y.Text, anchor: Anchor): { anchor: Anchor; range: Range | null } {
  const text = ytext.toString()
  const resolved = resolveAnchor(ytext, anchor)

  if (resolved && anchor.quote.exact.length > 0) {
    const current = text.slice(resolved.start, resolved.end)
    if (similarity(current, anchor.quote.exact) >= REANCHOR_THRESHOLD) {
      // Refresh hint (and stale status) so future re-anchoring starts near home.
      return { anchor: { ...anchor, hint: resolved.start, status: 'anchored' }, range: resolved }
    }
  } else if (resolved && anchor.quote.exact.length === 0) {
    return { anchor, range: resolved }
  }

  const found = findQuote(text, anchor.quote, resolved?.start ?? anchor.hint)
  if (found) {
    // Re-mint positions AND refresh the quote: stale quotes degrade every
    // subsequent fuzzy match, so each successful re-anchor becomes the new
    // reference (Hypothesis behavior).
    const reanchored = createAnchor(ytext, found.start, found.end)
    return { anchor: reanchored, range: { start: found.start, end: found.end } }
  }

  return { anchor: { ...anchor, status: 'orphaned' }, range: null }
}
