import type * as Y from 'yjs'
import {
  DIFF_DELETE,
  DIFF_EQUAL,
  DIFF_INSERT,
  type Diff,
  applyPatches,
  cleanupSemantic,
  makeDiff,
  makePatches,
  stringifyPatch,
} from '@sanity/diff-match-patch'

/** Fraction of the base document that may be deleted before a drifted push is refused. */
export const DEGENERATE_DELETE_RATIO = 0.6

/**
 * Normalize line endings to \n. Must run on every text entering the system
 * (CLI pull/push boundaries, server merge entry): CRLF reintroduced by a
 * Windows-side edit corrupts Y.Text position bookkeeping downstream.
 */
export function normalizeEol(s: string): string {
  return s.replace(/\r\n?/g, '\n')
}

export interface MergeOptions {
  /** Apply even when the diff is degenerate against a drifted document. */
  force?: boolean
  /** Yjs transaction origin for attribution. */
  origin?: unknown
}

export type PushResult =
  | { ok: true; applied: number; failedHunks: string[] }
  | { ok: false; reason: 'degenerate'; deletedRatio: number }

export interface MergeComputation {
  /** What the document should become after merging base→next into current. */
  target: string
  /** Stringified patches that could not be placed against current content. */
  failedHunks: string[]
  /** Fraction of the base text the push deletes (degenerate-guard input). */
  deletedRatio: number
  /** Whether the document had drifted from the pushed base. */
  drifted: boolean
}

/**
 * Compute the merged result of a base→next edit against the current text
 * without touching the document: exact when current == base, fuzzy patch
 * application when drifted. Used by direct pushes (then landed as CRDT ops)
 * and by --suggest pushes (then materialized as a suggestion).
 */
export function computeMergedTarget(current: string, baseText: string, newText: string): MergeComputation {
  const drifted = current !== baseText
  if (baseText === newText) return { target: current, failedHunks: [], deletedRatio: 0, drifted }

  const diffs = cleanupSemantic(makeDiff(baseText, newText))
  const deletedRatio = deletedChars(diffs) / Math.max(baseText.length, 1)
  if (!drifted) return { target: newText, failedHunks: [], deletedRatio, drifted }

  const patches = makePatches(diffs)
  const [merged, results] = applyPatches(patches, current)
  const failedHunks = patches.filter((_, i) => !results[i]).map((p) => stringifyPatch(p))
  return { target: merged, failedHunks, deletedRatio, drifted }
}

/**
 * Merge a CLI push into the live document: diff base → new, then land that
 * diff on the current Y.Text. If the document hasn't drifted from base the
 * diff applies exactly; otherwise patches are fuzzy-matched against current
 * content so concurrent edits are preserved. Hunks that cannot be placed are
 * returned (never silently dropped).
 */
export function mergePush(ytext: Y.Text, baseText: string, newText: string, opts: MergeOptions = {}): PushResult {
  const current = ytext.toString()
  const comp = computeMergedTarget(current, baseText, newText)

  if (comp.drifted && !opts.force && comp.deletedRatio > DEGENERATE_DELETE_RATIO) {
    return { ok: false, reason: 'degenerate', deletedRatio: comp.deletedRatio }
  }

  if (comp.target === current) return { ok: true, applied: 0, failedHunks: comp.failedHunks }
  const landing = cleanupSemantic(makeDiff(current, comp.target))
  applyDiffsToYText(ytext, landing, opts.origin)
  return { ok: true, applied: countChanges(landing), failedHunks: comp.failedHunks }
}

/** Apply a diff (computed against the Y.Text's current content) as CRDT ops in one transaction. */
export function applyDiffsToYText(ytext: Y.Text, diffs: Diff[], origin?: unknown): void {
  const doc = ytext.doc
  if (!doc) throw new Error('Y.Text must be attached to a Y.Doc')
  doc.transact(() => {
    let index = 0
    for (const [op, chunk] of diffs) {
      if (op === DIFF_EQUAL) {
        index += chunk.length
      } else if (op === DIFF_DELETE) {
        ytext.delete(index, chunk.length)
      } else if (op === DIFF_INSERT) {
        ytext.insert(index, chunk)
        index += chunk.length
      }
    }
  }, origin)
}

function deletedChars(diffs: Diff[]): number {
  let n = 0
  for (const [op, chunk] of diffs) if (op === DIFF_DELETE) n += chunk.length
  return n
}

function countChanges(diffs: Diff[]): number {
  let n = 0
  for (const [op] of diffs) if (op !== DIFF_EQUAL) n++
  return n
}
