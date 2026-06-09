import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { materializeSuggestion } from '@glyphdown/core'
import type { SuggestionRecord } from '@glyphdown/protocol'
import {
  type DeltaOp,
  type OffsetRange,
  checkSuggesterDelta,
  invertDelta,
  mergeRanges,
  ownOpenInsertRanges,
} from '../src/enforce.ts'

const BASE = 'para one: alpha bravo charlie\n\npara two: delta echo foxtrot\n\npara three: golf hotel india'

function docWith(text: string): Y.Text {
  const doc = new Y.Doc()
  const ytext = doc.getText('content')
  ytext.insert(0, text)
  return ytext
}

/** Apply `fn` in a transaction with `origin` and capture the resulting delta. */
function applyAndCapture(ytext: Y.Text, origin: unknown, fn: () => void): DeltaOp[] {
  let delta: DeltaOp[] = []
  const observer = (event: Y.YTextEvent, txn: Y.Transaction) => {
    if (txn.origin === origin) delta = event.delta as DeltaOp[]
  }
  ytext.observe(observer)
  ytext.doc!.transact(fn, origin)
  ytext.unobserve(observer)
  return delta
}

describe('mergeRanges', () => {
  it('merges overlapping and adjacent ranges, keeps gaps', () => {
    expect(
      mergeRanges([
        { start: 10, end: 20 },
        { start: 5, end: 12 },
        { start: 20, end: 25 },
        { start: 40, end: 50 },
      ]),
    ).toEqual([
      { start: 5, end: 25 },
      { start: 40, end: 50 },
    ])
  })

  it('does not mutate its input', () => {
    const input: OffsetRange[] = [
      { start: 3, end: 9 },
      { start: 1, end: 4 },
    ]
    mergeRanges(input)
    expect(input).toEqual([
      { start: 3, end: 9 },
      { start: 1, end: 4 },
    ])
  })
})

describe('checkSuggesterDelta', () => {
  const own: OffsetRange[] = [
    { start: 10, end: 20 },
    { start: 30, end: 40 },
  ]

  it('allows any text insertion (new or extending a suggested insert)', () => {
    expect(checkSuggesterDelta([{ insert: 'hello' }], own).ok).toBe(true)
    expect(checkSuggesterDelta([{ retain: 25 }, { insert: 'x' }], own).ok).toBe(true)
    expect(checkSuggesterDelta([{ insert: 'fresh' }], []).ok).toBe(true)
  })

  it('allows deletions fully inside the author\'s own insert ranges', () => {
    expect(checkSuggesterDelta([{ retain: 12 }, { delete: 5 }], own).ok).toBe(true)
    expect(checkSuggesterDelta([{ retain: 10 }, { delete: 10 }], own).ok).toBe(true)
  })

  it('rejects deletions outside or straddling own insert ranges', () => {
    expect(checkSuggesterDelta([{ delete: 5 }], own).ok).toBe(false)
    expect(checkSuggesterDelta([{ retain: 15 }, { delete: 10 }], own).ok).toBe(false) // 15..25 straddles
    expect(checkSuggesterDelta([{ retain: 25 }, { delete: 2 }], own).ok).toBe(false) // gap
    expect(checkSuggesterDelta([{ delete: 1 }], []).ok).toBe(false)
  })

  it('allows a deletion spanning own ranges that became adjacent', () => {
    const adjacent: OffsetRange[] = [
      { start: 10, end: 20 },
      { start: 20, end: 30 },
    ]
    expect(checkSuggesterDelta([{ retain: 15 }, { delete: 10 }], adjacent).ok).toBe(true)
  })

  it('accounts for prior inserts not advancing pre-state offsets', () => {
    // Delta positions for retain/delete are pre-state; an insert in between
    // must not shift the deletion's coverage check.
    expect(checkSuggesterDelta([{ retain: 12 }, { insert: 'abc' }, { delete: 5 }], own).ok).toBe(true)
    expect(checkSuggesterDelta([{ retain: 18 }, { insert: 'abc' }, { delete: 5 }], own).ok).toBe(false)
  })

  it('rejects formatting attributes and embed inserts', () => {
    expect(checkSuggesterDelta([{ retain: 12, attributes: { bold: true } }], own).ok).toBe(false)
    expect(checkSuggesterDelta([{ insert: 'x', attributes: { bold: true } }], own).ok).toBe(false)
    expect(checkSuggesterDelta([{ insert: { embed: 'img' } }], own).ok).toBe(false)
  })

  it('reports a reason on violation', () => {
    const verdict = checkSuggesterDelta([{ retain: 2 }, { delete: 3 }], own)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toContain('delete-outside-own-insert')
  })
})

describe('ownOpenInsertRanges', () => {
  function suggestionFor(ytext: Y.Text, target: string, id: string, authorId: string): SuggestionRecord {
    return { ...materializeSuggestion(ytext, target, { id, authorId, createdAt: 1 }), authorName: authorId }
  }

  it('resolves only the author\'s open insert parts', () => {
    const ytext = docWith(BASE)
    const mine = suggestionFor(ytext, ytext.toString().replace('golf', 'MINE golf'), 's1', 'a1')
    const theirs = suggestionFor(ytext, ytext.toString().replace('alpha', 'THEIRS alpha'), 's2', 'a2')
    const closed: SuggestionRecord = {
      ...suggestionFor(ytext, ytext.toString().replace('delta', 'CLOSED delta'), 's3', 'a1'),
      status: 'accepted',
    }
    // A pure-delete suggestion contributes no insert ranges.
    const deleteOnly = suggestionFor(ytext, ytext.toString().replace('echo ', ''), 's4', 'a1')
    expect(deleteOnly.parts.every((p) => p.kind === 'delete')).toBe(true)

    const text = ytext.toString()
    const ranges = ownOpenInsertRanges(ytext, [mine, theirs, closed, deleteOnly], 'a1')
    expect(ranges).toHaveLength(1)
    // The diff may align the inserted run as 'MINE ' or ' MINE'.
    expect(text.slice(ranges[0]!.start, ranges[0]!.end)).toContain('MINE')
    expect(ranges[0]!.end - ranges[0]!.start).toBe('MINE '.length)
  })

  it('tracks live edits through the relative-position anchors', () => {
    const ytext = docWith(BASE)
    const mine = suggestionFor(ytext, ytext.toString().replace('golf', 'MINE golf'), 's1', 'a1')
    const before = ownOpenInsertRanges(ytext, [mine], 'a1')
    ytext.insert(0, 'INTRO\n\n')
    const after = ownOpenInsertRanges(ytext, [mine], 'a1')
    expect(after).toEqual(before.map((r) => ({ start: r.start + 'INTRO\n\n'.length, end: r.end + 'INTRO\n\n'.length })))
    expect(ytext.toString().slice(after[0]!.start, after[0]!.end)).toContain('MINE')
  })
})

describe('invertDelta (revert path on real Y.Docs)', () => {
  it('reverts a deletion exactly', () => {
    const ytext = docWith(BASE)
    const connection = { id: 'conn' }
    const preText = ytext.toString()
    const delta = applyAndCapture(ytext, connection, () => ytext.delete(10, 15))
    expect(checkSuggesterDelta(delta, []).ok).toBe(false)
    ytext.doc!.transact(() => ytext.applyDelta(invertDelta(delta, preText)), 'server-enforce')
    expect(ytext.toString()).toBe(preText)
  })

  it('reverts a mixed replace (delete + insert) exactly', () => {
    const ytext = docWith(BASE)
    const connection = { id: 'conn' }
    const preText = ytext.toString()
    const delta = applyAndCapture(ytext, connection, () => {
      ytext.delete(5, 8)
      ytext.insert(5, 'INJECTED')
      ytext.delete(40, 4)
    })
    ytext.doc!.transact(() => ytext.applyDelta(invertDelta(delta, preText)), 'server-enforce')
    expect(ytext.toString()).toBe(preText)
  })

  it('reverts formatting by nulling the applied attributes', () => {
    const ytext = docWith(BASE)
    const connection = { id: 'conn' }
    const preText = ytext.toString()
    const delta = applyAndCapture(ytext, connection, () => ytext.format(0, 8, { bold: true }))
    expect(checkSuggesterDelta(delta, []).ok).toBe(false)
    ytext.doc!.transact(() => ytext.applyDelta(invertDelta(delta, preText)), 'server-enforce')
    expect(ytext.toString()).toBe(preText)
    expect((ytext.toDelta() as DeltaOp[]).every((op) => op.attributes === undefined)).toBe(true)
  })

  it('reverts a malicious remote update applied with the connection origin, and clients converge', () => {
    // Mirrors the DocDO flow: y-partyserver applies the client's sync message
    // in a transaction whose origin is the Connection; the observer validates
    // and reverts in a 'server-enforce' transaction.
    const serverDoc = new Y.Doc()
    const server = serverDoc.getText('content')
    server.insert(0, BASE)

    const clientDoc = new Y.Doc()
    Y.applyUpdate(clientDoc, Y.encodeStateAsUpdate(serverDoc))
    const client = clientDoc.getText('content')

    // Suggester client deletes original text it never suggested-inserted.
    const evil = BASE.indexOf('para two')
    client.delete(evil, 'para two: delta echo foxtrot'.length)

    const connection = { id: 'ws-1' }
    const preText = server.toString()
    let delta: DeltaOp[] = []
    server.observe((event, txn) => {
      if (txn.origin === connection) delta = event.delta as DeltaOp[]
    })
    Y.applyUpdate(serverDoc, Y.encodeStateAsUpdate(clientDoc, Y.encodeStateVector(serverDoc)), connection)

    expect(checkSuggesterDelta(delta, []).ok).toBe(false)
    serverDoc.transact(() => server.applyDelta(invertDelta(delta, preText)), 'server-enforce')
    expect(server.toString()).toBe(preText)

    // The offender (before being closed) and everyone else converge on the revert.
    Y.applyUpdate(clientDoc, Y.encodeStateAsUpdate(serverDoc, Y.encodeStateVector(clientDoc)))
    expect(client.toString()).toBe(preText)
  })

  it('does NOT flag a legit suggester retracting their own pending insertion', () => {
    const serverDoc = new Y.Doc()
    const server = serverDoc.getText('content')
    server.insert(0, BASE)
    const suggestion: SuggestionRecord = {
      ...materializeSuggestion(server, server.toString().replace('golf', 'PENDING golf'), {
        id: 's1',
        authorId: 'a1',
        createdAt: 1,
      }),
      authorName: 'a1',
    }

    const clientDoc = new Y.Doc()
    Y.applyUpdate(clientDoc, Y.encodeStateAsUpdate(serverDoc))
    const client = clientDoc.getText('content')

    const connection = { id: 'ws-2' }
    // Pre-state snapshot, as the DO takes before super.onMessage.
    const ownRanges = ownOpenInsertRanges(server, [suggestion], 'a1')
    expect(ownRanges).toHaveLength(1)

    // The suggester retracts their own pending insertion (a real delete —
    // same pre-state offsets on the synced client and the server).
    client.delete(ownRanges[0]!.start, ownRanges[0]!.end - ownRanges[0]!.start)

    let delta: DeltaOp[] = []
    server.observe((event, txn) => {
      if (txn.origin === connection) delta = event.delta as DeltaOp[]
    })
    Y.applyUpdate(serverDoc, Y.encodeStateAsUpdate(clientDoc, Y.encodeStateVector(serverDoc)), connection)

    expect(checkSuggesterDelta(delta, ownRanges).ok).toBe(true)
    expect(server.toString()).not.toContain('PENDING')
  })

  it('round-trips random edit storms (inverse is exact)', () => {
    let seed = 42
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % n
    }
    for (let trial = 0; trial < 25; trial++) {
      const ytext = docWith(BASE)
      const preText = ytext.toString()
      const origin = { trial }
      const delta = applyAndCapture(ytext, origin, () => {
        for (let i = 0; i < 1 + rand(4); i++) {
          const len = ytext.length
          if (len > 0 && rand(2) === 0) {
            const start = rand(len)
            ytext.delete(start, Math.min(1 + rand(10), len - start))
          } else {
            ytext.insert(rand(len + 1), `<${trial}.${i}>`)
          }
        }
      })
      ytext.doc!.transact(() => ytext.applyDelta(invertDelta(delta, preText)), 'server-enforce')
      expect(ytext.toString()).toBe(preText)
    }
  })
})
