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

export interface AnchorStrategy<TAnchor, TContent> {
  buildFromInput(content: TContent, input: unknown): Validated<TAnchor | null>
  validate(content: TContent, anchor: TAnchor): { anchor: TAnchor; resolved: boolean }
  reattach(content: TContent, input: unknown): Validated<TAnchor>
  equals(a: TAnchor, b: TAnchor): boolean
  minimumOk(anchor: TAnchor): boolean
}

export interface CommentAnchorAdapter<TAnchor> {
  get(comment: Comment): TAnchor | null
  set(comment: Comment, anchor: TAnchor | null): Comment
}

export interface CommentStoreOptions<TAnchor, TContent> {
  content: () => TContent
  strategy: AnchorStrategy<TAnchor, TContent>
  anchors: CommentAnchorAdapter<TAnchor>
  all: () => Comment[]
  load: (id: string) => Comment | null
  save: (comment: Comment) => void
  broadcast?: (comment: Comment) => void
}

export interface ReplyResult {
  comment: Comment
  reply: CommentReply
  rootAuthorId: string
}

export interface ResolveResult {
  comment: Comment
  resolved: boolean
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

function textAnchorMinimumOk(anchor: Anchor): boolean {
  return anchor.quote.exact.length >= MIN_ANCHOR_CHARS
}

export function anchorsEqual(a: Anchor, b: Anchor): boolean {
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

export const TextAnchorStrategy: AnchorStrategy<Anchor, Y.Text> = {
  buildFromInput(ytext, input) {
    if (input === undefined || input === null) return { ok: true, value: null }
    const valid = validateRange(input, ytext.length)
    if (!valid.ok) return valid
    const anchor = createAnchor(ytext, valid.value.start, valid.value.end)
    if (!textAnchorMinimumOk(anchor)) return { ok: false, error: 'anchor-too-short' }
    return { ok: true, value: anchor }
  },
  validate(ytext, anchor) {
    const result = validateOrReanchor(ytext, anchor)
    return { anchor: result.anchor, resolved: result.range !== null }
  },
  reattach(ytext, input) {
    const valid = validateRange(input, ytext.length)
    if (!valid.ok) return valid
    const anchor = createAnchor(ytext, valid.value.start, valid.value.end)
    if (!textAnchorMinimumOk(anchor)) return { ok: false, error: 'anchor-too-short' }
    return { ok: true, value: anchor }
  },
  equals: anchorsEqual,
  minimumOk: textAnchorMinimumOk,
}

export const textCommentAnchors: CommentAnchorAdapter<Anchor> = {
  get: (comment) => comment.anchor,
  set: (comment, anchor) => ({ ...comment, anchor }),
}

function buildCommentRecord<TAnchor, TContent>(
  content: TContent,
  strategy: AnchorStrategy<TAnchor, TContent>,
  anchors: CommentAnchorAdapter<TAnchor>,
  principal: Principal,
  body: unknown,
  anchorInput?: unknown,
  id: string = crypto.randomUUID(),
  createdAt: number = Date.now(),
): Validated<Comment> {
  if (typeof body !== 'string' || body.trim().length === 0) return { ok: false, error: 'body-required' }
  const builtAnchor = strategy.buildFromInput(content, anchorInput)
  if (!builtAnchor.ok) return builtAnchor
  if (builtAnchor.value !== null && !strategy.minimumOk(builtAnchor.value)) {
    return { ok: false, error: 'anchor-too-short' }
  }
  const comment: Comment = {
    id,
    anchor: null,
    authorId: principal.id,
    authorName: principal.name,
    body,
    createdAt,
    resolved: false,
    reactions: {},
    replies: [],
  }
  return { ok: true, value: anchors.set(comment, builtAnchor.value) }
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
  return buildCommentRecord(ytext, TextAnchorStrategy, textCommentAnchors, principal, body, range, id, createdAt)
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
  const valid = TextAnchorStrategy.reattach(ytext, range)
  if (!valid.ok) return valid
  return { ok: true, value: textCommentAnchors.set(comment, valid.value) }
}

export function revalidateComments<TAnchor, TContent>(
  content: TContent,
  comments: Comment[],
  strategy: AnchorStrategy<TAnchor, TContent>,
  anchors: CommentAnchorAdapter<TAnchor>,
): Comment[] {
  const changedComments: Comment[] = []
  for (const comment of comments) {
    const current = anchors.get(comment)
    if (!current) continue
    const { anchor } = strategy.validate(content, current)
    if (!strategy.equals(anchor, current)) changedComments.push(anchors.set(comment, anchor))
  }
  return changedComments
}

export interface SuggestionRevalidationResult {
  /** Open suggestions whose part anchors changed but all still resolve. */
  suggestions: StoredSuggestion[]
  /** Open suggestions auto-rejected because a part anchor orphaned (SPEC §6.1). */
  rejected: StoredSuggestion[]
}

export function revalidateSuggestions(
  ytext: Y.Text,
  suggestions: StoredSuggestion[],
  origin?: unknown,
): SuggestionRevalidationResult {
  const changedSuggestions: StoredSuggestion[] = []
  const rejected: StoredSuggestion[] = []
  for (const suggestion of suggestions) {
    if (suggestion.status !== 'open') continue
    let changed = false
    let orphaned = false
    const parts = suggestion.parts.map((part) => {
      const { anchor } = TextAnchorStrategy.validate(ytext, part.anchor)
      if (anchor.status === 'orphaned') orphaned = true
      if (TextAnchorStrategy.equals(anchor, part.anchor)) return part
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

  return { suggestions: changedSuggestions, rejected }
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
  const changedComments = revalidateComments(ytext, comments, TextAnchorStrategy, textCommentAnchors)
  const suggestionResult = revalidateSuggestions(ytext, suggestions, origin)
  return { comments: changedComments, ...suggestionResult }
}

export class CommentStore<TAnchor, TContent> {
  constructor(private readonly options: CommentStoreOptions<TAnchor, TContent>) {}

  build(
    principal: Principal,
    body: unknown,
    anchorInput?: unknown,
    id: string = crypto.randomUUID(),
    createdAt: number = Date.now(),
  ): Validated<Comment> {
    return buildCommentRecord(
      this.options.content(),
      this.options.strategy,
      this.options.anchors,
      principal,
      body,
      anchorInput,
      id,
      createdAt,
    )
  }

  create(principal: Principal, body: unknown, anchorInput?: unknown): Validated<Comment> {
    const built = this.build(principal, body, anchorInput)
    if (!built.ok) return built
    this.persist(built.value)
    return built
  }

  reply(commentId: string, principal: Principal, body: unknown): Validated<ReplyResult> {
    const comment = this.options.load(commentId)
    if (!comment) return { ok: false, error: 'not-found' }
    const built = buildReply(principal, body)
    if (!built.ok) return built
    const updated: Comment = { ...comment, replies: [...comment.replies, built.value] }
    this.persist(updated)
    return { ok: true, value: { comment: updated, reply: built.value, rootAuthorId: comment.authorId } }
  }

  resolve(commentId: string, resolvedInput: unknown): Validated<ResolveResult> {
    const comment = this.options.load(commentId)
    if (!comment) return { ok: false, error: 'not-found' }
    const resolved = typeof resolvedInput === 'boolean' ? resolvedInput : !comment.resolved
    const updated: Comment = { ...comment, resolved }
    this.persist(updated)
    return { ok: true, value: { comment: updated, resolved } }
  }

  react(commentId: string, emoji: unknown, principal: Principal): Validated<Comment> {
    const comment = this.options.load(commentId)
    if (!comment) return { ok: false, error: 'not-found' }
    if (typeof emoji !== 'string' || emoji.length === 0 || emoji.length > 32) {
      return { ok: false, error: 'bad-emoji' }
    }
    const updated: Comment = { ...comment, reactions: toggleReaction(comment.reactions, emoji, principal.id) }
    this.persist(updated)
    return { ok: true, value: updated }
  }

  reattach(commentId: string, anchorInput: unknown): Validated<Comment> {
    const comment = this.options.load(commentId)
    if (!comment) return { ok: false, error: 'not-found' }
    const valid = this.options.strategy.reattach(this.options.content(), anchorInput)
    if (!valid.ok) return valid
    if (!this.options.strategy.minimumOk(valid.value)) return { ok: false, error: 'anchor-too-short' }
    const updated = this.options.anchors.set(comment, valid.value)
    this.persist(updated)
    return { ok: true, value: updated }
  }

  revalidate(): Comment[] {
    const changed = revalidateComments(
      this.options.content(),
      this.options.all(),
      this.options.strategy,
      this.options.anchors,
    )
    for (const comment of changed) this.persist(comment)
    return changed
  }

  private persist(comment: Comment): void {
    this.options.save(comment)
    this.options.broadcast?.(comment)
  }
}
