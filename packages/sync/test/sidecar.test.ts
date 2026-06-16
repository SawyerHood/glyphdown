import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { materializeSuggestion, resolveAnchor } from '@glyphdown/core'
import type { Comment, Principal } from '@glyphdown/protocol'
import {
  CommentStore,
  MIN_ANCHOR_CHARS,
  ORPHAN_REJECT_NOTE,
  TextAnchorStrategy,
  type StoredSuggestion,
  anchorsEqual,
  buildComment,
  buildReply,
  reattachComment,
  revalidateAnchors,
  revalidateComments,
  revalidateSuggestions,
  textCommentAnchors,
  toggleReaction,
  validateRange,
} from '../src/sidecar.ts'

const user: Principal = { id: 'u1', type: 'user', name: 'Una' }
const agent: Principal = { id: 'a1', type: 'agent', name: 'Claude', ownerUserId: 'u1' }

function docWith(text: string): Y.Text {
  const doc = new Y.Doc()
  const ytext = doc.getText('content')
  ytext.insert(0, text)
  return ytext
}

/** Serialize/deserialize the way the DO stores rows in SQLite. */
function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function inMemoryCommentStore(ytext: Y.Text) {
  const comments: Comment[] = []
  const broadcasts: Comment[] = []
  const store = new CommentStore({
    content: () => ytext,
    strategy: TextAnchorStrategy,
    anchors: textCommentAnchors,
    all: () => comments,
    load: (id) => comments.find((comment) => comment.id === id) ?? null,
    save: (comment) => {
      const index = comments.findIndex((current) => current.id === comment.id)
      if (index === -1) comments.push(comment)
      else comments[index] = comment
    },
    broadcast: (comment) => broadcasts.push(comment),
  })
  return { broadcasts, comments, store }
}

const BASE = 'para one: alpha bravo charlie\n\npara two: delta echo foxtrot\n\npara three: golf hotel india'

describe('validateRange', () => {
  it('rejects anchors shorter than 8 chars of text', () => {
    const result = validateRange({ start: 0, end: MIN_ANCHOR_CHARS - 1 }, 100)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('anchor-too-short')
  })

  it('rejects out-of-bounds and malformed ranges', () => {
    expect(validateRange({ start: -1, end: 20 }, 100).ok).toBe(false)
    expect(validateRange({ start: 0, end: 101 }, 100).ok).toBe(false)
    expect(validateRange({ start: 20, end: 10 }, 100).ok).toBe(false)
    expect(validateRange({ start: 0.5, end: 20 }, 100).ok).toBe(false)
    expect(validateRange({ start: '0', end: 20 }, 100).ok).toBe(false)
    expect(validateRange(null, 100).ok).toBe(false)
    expect(validateRange({ start: 0, end: MIN_ANCHOR_CHARS }, 100).ok).toBe(true)
  })
})

describe('buildComment', () => {
  it('builds a range comment whose JSON round-trip still resolves', () => {
    const ytext = docWith(BASE)
    const start = BASE.indexOf('golf hotel india')
    const end = start + 'golf hotel india'.length
    const built = buildComment(ytext, user, 'nice phrasing', { start, end })
    expect(built.ok).toBe(true)
    if (!built.ok) return

    const stored = roundTrip(built.value)
    expect(stored).toEqual(built.value)
    expect(stored.anchor?.quote.exact).toBe('golf hotel india')
    expect(stored.authorId).toBe('u1')
    expect(stored.authorName).toBe('Una')
    expect(stored.resolved).toBe(false)
    expect(stored.replies).toEqual([])

    // Anchors survive serialization: base64 relative positions still resolve.
    expect(resolveAnchor(ytext, stored.anchor!)).toEqual({ start, end })

    // ...and keep tracking live CRDT edits after the round-trip.
    ytext.insert(0, 'PREFIX ')
    expect(resolveAnchor(ytext, stored.anchor!)).toEqual({ start: start + 7, end: end + 7 })
  })

  it('builds doc-level comments without an anchor', () => {
    const ytext = docWith(BASE)
    const built = buildComment(ytext, agent, 'overall: looks good')
    expect(built.ok).toBe(true)
    if (built.ok) expect(built.value.anchor).toBeNull()
  })

  it('rejects empty bodies and too-short ranges', () => {
    const ytext = docWith(BASE)
    expect(buildComment(ytext, user, '   ').ok).toBe(false)
    expect(buildComment(ytext, user, 'x', { start: 0, end: 4 }).ok).toBe(false)
    expect(buildComment(ytext, user, 'x', { start: 0, end: BASE.length + 1 }).ok).toBe(false)
  })
})

describe('buildReply / toggleReaction / reattachComment', () => {
  it('validates reply bodies and attributes the author', () => {
    expect(buildReply(user, '').ok).toBe(false)
    const built = buildReply(agent, 'agree')
    expect(built.ok).toBe(true)
    if (built.ok) {
      expect(built.value.authorId).toBe('a1')
      expect(built.value.authorName).toBe('Claude')
      expect(built.value.reactions).toEqual({})
    }
  })

  it('toggles reactions per principal and drops empty sets', () => {
    let reactions: Record<string, string[]> = {}
    reactions = toggleReaction(reactions, '👍', 'u1')
    expect(reactions).toEqual({ '👍': ['u1'] })
    reactions = toggleReaction(reactions, '👍', 'a1')
    expect(reactions).toEqual({ '👍': ['u1', 'a1'] })
    reactions = toggleReaction(reactions, '👍', 'u1')
    expect(reactions).toEqual({ '👍': ['a1'] })
    reactions = toggleReaction(reactions, '👍', 'a1')
    expect(reactions).toEqual({})
  })

  it('reattaches an orphaned comment to a new range', () => {
    const ytext = docWith(BASE)
    const built = buildComment(ytext, user, 'body', { start: 0, end: 12 })
    expect(built.ok).toBe(true)
    if (!built.ok) return
    const orphaned: Comment = { ...built.value, anchor: { ...built.value.anchor!, status: 'orphaned' } }

    const start = BASE.indexOf('delta echo')
    const reattached = reattachComment(ytext, orphaned, { start, end: start + 'delta echo'.length })
    expect(reattached.ok).toBe(true)
    if (!reattached.ok) return
    expect(reattached.value.anchor?.status).toBe('anchored')
    expect(reattached.value.anchor?.quote.exact).toBe('delta echo')
    expect(resolveAnchor(ytext, reattached.value.anchor!)).toEqual({ start, end: start + 'delta echo'.length })

    expect(reattachComment(ytext, orphaned, { start: 0, end: 3 }).ok).toBe(false)
  })
})

describe('TextAnchorStrategy / CommentStore', () => {
  it('builds equivalent text anchors through the strategy', () => {
    const ytext = docWith(BASE)
    const direct = buildComment(ytext, user, 'body', { start: 0, end: 12 })
    const viaStrategy = TextAnchorStrategy.buildFromInput(ytext, { start: 0, end: 12 })
    expect(direct.ok).toBe(true)
    expect(viaStrategy.ok).toBe(true)
    if (!direct.ok || !viaStrategy.ok || viaStrategy.value === null) return
    expect(TextAnchorStrategy.minimumOk(viaStrategy.value)).toBe(true)
    expect(anchorsEqual(direct.value.anchor!, viaStrategy.value)).toBe(true)
  })

  it('persists and broadcasts shared comment mutations', () => {
    const ytext = docWith(BASE)
    const { broadcasts, comments, store } = inMemoryCommentStore(ytext)

    const created = store.create(user, 'initial comment', { start: 0, end: 12 })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(comments).toHaveLength(1)
    expect(broadcasts).toHaveLength(1)

    const reply = store.reply(created.value.id, agent, 'reply')
    expect(reply.ok).toBe(true)
    if (!reply.ok) return
    expect(reply.value.reply.authorId).toBe('a1')
    expect(reply.value.rootAuthorId).toBe('u1')
    expect(comments[0]!.replies).toHaveLength(1)

    const reacted = store.react(created.value.id, 'ship', user)
    expect(reacted.ok).toBe(true)
    expect(comments[0]!.reactions).toEqual({ ship: ['u1'] })

    const resolved = store.resolve(created.value.id, true)
    expect(resolved.ok).toBe(true)
    if (resolved.ok) expect(resolved.value.resolved).toBe(true)
    expect(comments[0]!.resolved).toBe(true)

    const start = BASE.indexOf('delta echo')
    const reattached = store.reattach(created.value.id, { start, end: start + 'delta echo'.length })
    expect(reattached.ok).toBe(true)
    if (reattached.ok) expect(reattached.value.anchor?.quote.exact).toBe('delta echo')
    expect(broadcasts).toHaveLength(5)
  })

  it('revalidates comments without suggestion handling', () => {
    const ytext = docWith(BASE)
    const comment = commentOn(ytext, 'golf hotel india')
    const moved = 'para three: golf hotel india\n\npara one: alpha bravo charlie'
    ytext.doc!.transact(() => {
      ytext.delete(0, ytext.length)
      ytext.insert(0, moved)
    })

    const changed = revalidateComments(ytext, [comment], TextAnchorStrategy, textCommentAnchors)
    expect(changed).toHaveLength(1)
    expect(changed[0]!.anchor?.status).toBe('anchored')
    expect(resolveAnchor(ytext, changed[0]!.anchor!)).toEqual({
      start: 12,
      end: 12 + 'golf hotel india'.length,
    })
  })
})

function commentOn(ytext: Y.Text, exact: string): Comment {
  const text = ytext.toString()
  const start = text.indexOf(exact)
  expect(start).toBeGreaterThanOrEqual(0)
  const built = buildComment(ytext, user, `on "${exact}"`, { start, end: start + exact.length })
  expect(built.ok).toBe(true)
  if (!built.ok) throw new Error(built.error)
  return roundTrip(built.value) // store like the DO does
}

describe('revalidateAnchors', () => {
  it('reports nothing on an untouched document', () => {
    const ytext = docWith(BASE)
    const comment = commentOn(ytext, 'golf hotel india')
    const result = revalidateAnchors(ytext, [comment], [])
    expect(result.comments).toEqual([])
    expect(result.suggestions).toEqual([])
    expect(result.rejected).toEqual([])
  })

  it('refreshes hints after live edits shift the range', () => {
    const ytext = docWith(BASE)
    const comment = commentOn(ytext, 'golf hotel india')
    ytext.insert(0, 'INTRO PARAGRAPH\n\n')

    const result = revalidateAnchors(ytext, [comment], [])
    expect(result.comments).toHaveLength(1)
    const updated = result.comments[0]!
    expect(updated.anchor?.status).toBe('anchored')
    const expectedStart = ytext.toString().indexOf('golf hotel india')
    expect(updated.anchor?.hint).toBe(expectedStart)
    expect(resolveAnchor(ytext, updated.anchor!)).toEqual({
      start: expectedStart,
      end: expectedStart + 'golf hotel india'.length,
    })
  })

  it('re-anchors by quote search after a destructive delete+reinsert rewrite', () => {
    const ytext = docWith(BASE)
    const comment = commentOn(ytext, 'golf hotel india')

    // Out-of-band rewrite that nulls every relative position: full replace.
    const moved = 'para three: golf hotel india\n\npara one: alpha bravo charlie'
    ytext.doc!.transact(() => {
      ytext.delete(0, ytext.length)
      ytext.insert(0, moved)
    })

    const result = revalidateAnchors(ytext, [comment], [])
    expect(result.comments).toHaveLength(1)
    const updated = result.comments[0]!
    expect(updated.anchor?.status).toBe('anchored')
    const start = moved.indexOf('golf hotel india')
    expect(resolveAnchor(ytext, updated.anchor!)).toEqual({ start, end: start + 'golf hotel india'.length })
    // Re-anchoring re-mints the quote so future fuzzy matches stay fresh.
    expect(updated.anchor?.quote.exact).toBe('golf hotel india')
  })

  it('orphans comments whose text is gone (and can re-find it later)', () => {
    const ytext = docWith(BASE)
    const comment = commentOn(ytext, 'golf hotel india')

    ytext.doc!.transact(() => {
      ytext.delete(0, ytext.length)
      ytext.insert(0, 'entirely unrelated replacement body with no shared phrasing')
    })

    const result = revalidateAnchors(ytext, [comment], [])
    expect(result.comments).toHaveLength(1)
    expect(result.comments[0]!.anchor?.status).toBe('orphaned')
    // The stored quote survives for the "Orphaned" sidebar section.
    expect(result.comments[0]!.anchor?.quote.exact).toBe('golf hotel india')

    // If the text comes back, the next revalidation pass re-anchors it.
    ytext.insert(ytext.length, '\n\nrestored: golf hotel india')
    const again = revalidateAnchors(ytext, [roundTrip(result.comments[0]!)], [])
    expect(again.comments).toHaveLength(1)
    expect(again.comments[0]!.anchor?.status).toBe('anchored')
  })

  it('auto-rejects suggestions with orphaned parts and strips their insert text', () => {
    const ytext = docWith(BASE)
    const target = BASE.replace('delta ', '').replace('golf', 'SUGGESTED golf')
    const suggestion: StoredSuggestion = {
      ...materializeSuggestion(ytext, target, { id: 's1', authorId: agent.id, createdAt: 1 }),
      authorName: agent.name,
    }
    expect(suggestion.parts.some((p) => p.kind === 'delete')).toBe(true)
    expect(suggestion.parts.some((p) => p.kind === 'insert')).toBe(true)
    expect(ytext.toString()).toContain('SUGGESTED')
    expect(ytext.toString()).toContain('delta') // proposed deletion retained while open

    // Out-of-band rewrite destroys the middle paragraph (the delete part's home).
    const text = ytext.toString()
    const start = text.indexOf('para two')
    const end = text.indexOf('\n\npara three')
    ytext.doc!.transact(() => {
      ytext.delete(start, end - start)
      ytext.insert(start, 'totally rewritten middle section')
    })

    const stored = roundTrip(suggestion)
    const result = revalidateAnchors(ytext, [], [stored])
    expect(result.rejected).toHaveLength(1)
    expect(result.rejected[0]!.id).toBe('s1')
    expect(result.rejected[0]!.status).toBe('rejected')
    expect(result.rejected[0]!.systemNote).toBe(ORPHAN_REJECT_NOTE)
    // Rejection removed the still-resolving suggested insertion from content.
    expect(ytext.toString()).not.toContain('SUGGESTED')
    expect(ytext.toString()).toContain('golf hotel india')
  })

  it('keeps suggestions whose anchors all still resolve, reporting refreshed ones', () => {
    const ytext = docWith(BASE)
    const target = BASE.replace('golf', 'SUGGESTED golf')
    const suggestion: StoredSuggestion = {
      ...materializeSuggestion(ytext, target, { id: 's2', authorId: agent.id, createdAt: 1 }),
      authorName: agent.name,
    }

    // A live edit far away shifts offsets; anchors track, hints refresh.
    ytext.insert(0, 'INTRO\n\n')
    const result = revalidateAnchors(ytext, [], [roundTrip(suggestion)])
    expect(result.rejected).toEqual([])
    expect(result.suggestions).toHaveLength(1)
    expect(result.suggestions[0]!.status).toBe('open')
    expect(ytext.toString()).toContain('SUGGESTED')
  })

  it('skips non-open suggestions entirely', () => {
    const ytext = docWith(BASE)
    const target = BASE.replace('golf', 'SUGGESTED golf')
    const suggestion: StoredSuggestion = {
      ...materializeSuggestion(ytext, target, { id: 's3', authorId: agent.id, createdAt: 1 }),
      authorName: agent.name,
      status: 'accepted',
    }
    ytext.doc!.transact(() => {
      ytext.delete(0, ytext.length)
      ytext.insert(0, 'gone')
    })
    const result = revalidateAnchors(ytext, [], [roundTrip(suggestion)])
    expect(result.suggestions).toEqual([])
    expect(result.rejected).toEqual([])
  })

  it('revalidates suggestions without comment handling', () => {
    const ytext = docWith(BASE)
    const target = BASE.replace('golf', 'SUGGESTED golf')
    const suggestion: StoredSuggestion = {
      ...materializeSuggestion(ytext, target, { id: 's4', authorId: agent.id, createdAt: 1 }),
      authorName: agent.name,
    }

    ytext.insert(0, 'INTRO\n\n')
    const result = revalidateSuggestions(ytext, [roundTrip(suggestion)])
    expect(result.rejected).toEqual([])
    expect(result.suggestions).toHaveLength(1)
    expect(result.suggestions[0]!.id).toBe('s4')
  })
})
