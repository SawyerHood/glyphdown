import type * as Y from 'yjs'
import { type Range, createAnchor, resolveAnchor } from './anchor.ts'
import type { Suggestion, SuggestionPart } from './suggestions.ts'

/** Edits more than this far apart in time start a new suggestion. */
export const COALESCE_WINDOW_MS = 30_000
/** Edits separated by more than this many paragraph breaks start a new suggestion. */
export const COALESCE_MAX_PARAGRAPH_GAP = 1

export interface SuggestSessionOptions {
  newId: () => string
  now?: () => number
  coalesceMs?: number
  /** Yjs transaction origin for attribution. */
  origin?: unknown
}

interface ResolvedPart {
  suggestion: Suggestion
  part: SuggestionPart
  range: Range
}

/**
 * Applies one author's live edits with suggest-mode semantics:
 * - insertions land in the text, tracked as suggested-insert parts
 * - deletions of original text are only *marked* (suggested-delete parts)
 * - deletions of the author's own pending insertions are applied for real
 * - insertions inside the author's own marked-deletion range split the mark,
 *   so delete parts only ever cover original document text
 * - consecutive nearby edits coalesce into one reviewable Suggestion
 *
 * The caller (editor plugin or server) persists the suggestions returned by
 * `touched()` after each edit — an edit can modify parts of an earlier open
 * suggestion (e.g. extending or splitting), not just the current one.
 */
export class SuggestSession {
  private currentSuggestion: Suggestion | null = null
  private readonly openSuggestions: Suggestion[] = []
  private touchedIds = new Set<string>()
  private lastEditAt = 0

  constructor(
    private readonly ytext: Y.Text,
    private readonly authorId: string,
    private readonly opts: SuggestSessionOptions,
  ) {}

  get current(): Suggestion | null {
    return this.currentSuggestion
  }

  /** Suggestions modified by the most recent insert/delete call (to persist). */
  touched(): Suggestion[] {
    return this.openSuggestions.filter((s) => this.touchedIds.has(s.id))
  }

  /** End the coalescing window; the next edit starts a new suggestion. */
  flush(): void {
    this.currentSuggestion = null
  }

  insert(pos: number, text: string): Suggestion {
    const suggestion = this.ensureCurrent(pos)
    if (text.length === 0) return suggestion
    this.touchedIds = new Set([suggestion.id])

    this.transact(() => {
      this.ytext.insert(pos, text)

      // Ranges resolve post-insert: an interior insertion already grew its part's
      // range; an insertion at the right edge (pos == range.end) did not and
      // needs the anchor extended below.
      const touching = this.resolvedParts('insert').find((rp) => rp.range.start <= pos && pos <= rp.range.end)
      if (touching) {
        const desired: Range = {
          start: Math.min(touching.range.start, pos),
          end: Math.max(touching.range.end, pos + text.length),
        }
        if (touching.range.start !== desired.start || touching.range.end !== desired.end) {
          touching.part.anchor = createAnchor(this.ytext, desired.start, desired.end)
        }
        this.touchedIds.add(touching.suggestion.id)
      } else {
        suggestion.parts.push({ kind: 'insert', anchor: createAnchor(this.ytext, pos, pos + text.length) })
      }

      // An insertion strictly inside one of the author's own marked deletions got
      // swallowed by that range — split the mark so it keeps covering only
      // original text and the insertion stays an independent suggested-insert.
      const swallowing = this.resolvedParts('delete').find(
        (rp) => rp.range.start < pos && pos + text.length < rp.range.end,
      )
      if (swallowing) {
        const { suggestion: owner, part, range } = swallowing
        const halves: SuggestionPart[] = []
        if (pos > range.start) {
          halves.push({ kind: 'delete', anchor: createAnchor(this.ytext, range.start, pos) })
        }
        if (range.end > pos + text.length) {
          halves.push({ kind: 'delete', anchor: createAnchor(this.ytext, pos + text.length, range.end) })
        }
        owner.parts.splice(owner.parts.indexOf(part), 1, ...halves)
        this.touchedIds.add(owner.id)
      }
    })

    this.lastEditAt = this.now()
    return suggestion
  }

  delete(start: number, end: number): Suggestion {
    const suggestion = this.ensureCurrent(start)
    if (end <= start) return suggestion
    this.touchedIds = new Set([suggestion.id])

    this.transact(() => {
      // Segments over the author's own pending insertions get deleted for real;
      // everything else becomes (or already is) a suggested deletion.
      const ownInserts = this.resolvedParts('insert')
        .filter((rp) => rp.range.start < end && start < rp.range.end)
        .sort((a, b) => b.range.start - a.range.start)

      let cursor = end
      const overlaps: Range[] = [] // built right-to-left, stays descending
      const gaps: Range[] = []
      for (const rp of ownInserts) {
        const segStart = Math.max(start, rp.range.start)
        const segEnd = Math.min(cursor, rp.range.end)
        if (segEnd < cursor) gaps.push({ start: segEnd, end: cursor })
        if (segEnd > segStart) overlaps.push({ start: segStart, end: segEnd })
        this.touchedIds.add(rp.suggestion.id)
        cursor = Math.min(segStart, cursor)
      }
      if (start < cursor) gaps.push({ start, end: cursor })

      // Mark before mutating: anchor creation needs stable positions, and the
      // new anchors then track the physical deletions below automatically.
      for (const seg of gaps) this.markDeletion(suggestion, seg)
      for (const seg of overlaps) this.ytext.delete(seg.start, seg.end - seg.start)

      // Prune insert parts that the physical deletions collapsed.
      for (const open of this.openSuggestions) {
        const before = open.parts.length
        open.parts = open.parts.filter((p) => {
          if (p.kind !== 'insert') return true
          const range = resolveAnchor(this.ytext, p.anchor)
          return range !== null && range.end > range.start
        })
        if (open.parts.length !== before) this.touchedIds.add(open.id)
      }
    })

    this.lastEditAt = this.now()
    return suggestion
  }

  private markDeletion(suggestion: Suggestion, seg: Range): void {
    // Skip subsegments already marked for deletion; merge with adjacent marks.
    const existing = this.resolvedParts('delete').sort((a, b) => a.range.start - b.range.start)
    let gaps: Range[] = [seg]
    for (const rp of existing) {
      gaps = gaps.flatMap((g) => {
        if (rp.range.end <= g.start || g.end <= rp.range.start) return [g]
        const out: Range[] = []
        if (g.start < rp.range.start) out.push({ start: g.start, end: rp.range.start })
        if (rp.range.end < g.end) out.push({ start: rp.range.end, end: g.end })
        return out
      })
    }
    for (const gap of gaps) {
      if (gap.end <= gap.start) continue
      const adjacent = this.resolvedParts('delete').find((rp) => rp.range.end === gap.start || rp.range.start === gap.end)
      if (adjacent) {
        const union: Range = {
          start: Math.min(adjacent.range.start, gap.start),
          end: Math.max(adjacent.range.end, gap.end),
        }
        adjacent.part.anchor = createAnchor(this.ytext, union.start, union.end)
        this.touchedIds.add(adjacent.suggestion.id)
      } else {
        suggestion.parts.push({ kind: 'delete', anchor: createAnchor(this.ytext, gap.start, gap.end) })
      }
    }
  }

  private ensureCurrent(pos: number): Suggestion {
    const now = this.now()
    const window = this.opts.coalesceMs ?? COALESCE_WINDOW_MS
    const s = this.currentSuggestion
    if (s && s.status === 'open' && now - this.lastEditAt <= window && this.isNear(s, pos)) {
      return s
    }
    const fresh: Suggestion = {
      id: this.opts.newId(),
      authorId: this.authorId,
      createdAt: now,
      status: 'open',
      parts: [],
    }
    this.currentSuggestion = fresh
    this.openSuggestions.push(fresh)
    return fresh
  }

  private isNear(suggestion: Suggestion, pos: number): boolean {
    if (suggestion.parts.length === 0) return true
    const text = this.ytext.toString()
    let best = Number.POSITIVE_INFINITY
    for (const part of suggestion.parts) {
      const range = resolveAnchor(this.ytext, part.anchor)
      if (!range) continue
      const gapStart = Math.min(Math.max(range.start, Math.min(pos, range.end)), pos)
      const gapEnd = Math.max(Math.min(range.end, Math.max(pos, range.start)), pos)
      const breaks = countParagraphBreaks(text.slice(gapStart, gapEnd))
      best = Math.min(best, breaks)
    }
    return best <= COALESCE_MAX_PARAGRAPH_GAP
  }

  /** All resolvable parts of the given kind across this session's open suggestions. */
  private resolvedParts(kind: SuggestionPart['kind']): ResolvedPart[] {
    const out: ResolvedPart[] = []
    for (const suggestion of this.openSuggestions) {
      if (suggestion.status !== 'open') continue
      for (const part of suggestion.parts) {
        if (part.kind !== kind) continue
        const range = resolveAnchor(this.ytext, part.anchor)
        if (range && range.end > range.start) out.push({ suggestion, part, range })
      }
    }
    return out
  }

  private transact(fn: () => void): void {
    const doc = this.ytext.doc
    if (!doc) throw new Error('Y.Text must be attached to a Y.Doc')
    doc.transact(fn, this.opts.origin)
  }

  private now(): number {
    return (this.opts.now ?? Date.now)()
  }
}

function countParagraphBreaks(s: string): number {
  let n = 0
  for (let i = 0; i < s.length - 1; i++) {
    if (s[i] === '\n' && s[i + 1] === '\n') {
      n++
      while (i < s.length - 1 && s[i + 1] === '\n') i++
    }
  }
  return n
}
