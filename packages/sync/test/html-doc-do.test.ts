import { describe, expect, it, vi } from 'vitest'
import { createNodeAnchor, parseHtmlNodeIndex } from '@glyphdown/core'
import { HEADER_ASSET, HEADER_PRINCIPAL, HEADER_ROLE, type Comment, type Principal, type Role } from '@glyphdown/protocol'
import { HtmlDocDO } from '../src/html-doc-do.ts'

vi.mock('partyserver', () => ({ Server: class {} }))

const HEADER_COMMENT_AUTHOR = 'x-glyphdown-comment-author'

const user: Principal = { id: 'u1', type: 'user', name: 'Una' }
const agent: Principal = { id: 'a1', type: 'agent', name: 'Claude', ownerUserId: 'u1' }

interface StoredCommentRow {
  data: string
  created_at: number
  rowid: number
}

class FakeSql {
  readonly comments = new Map<string, StoredCommentRow>()
  readonly contentMeta = new Map<string, { etag: string | null; contentHash: string | null; parsedAt: number | null }>()
  readonly nodeIndex = new Map<string, { data: string; updatedAt: number }>()
  private rowid = 0

  exec<T = Record<string, unknown>>(query: string, ...params: unknown[]): T[] {
    const normalized = query.replace(/\s+/g, ' ').trim()
    if (normalized.startsWith('CREATE TABLE')) return []

    if (normalized.startsWith('INSERT OR IGNORE INTO content_meta')) {
      if (!this.contentMeta.has(params[0] as string)) {
        this.contentMeta.set(params[0] as string, { etag: null, contentHash: null, parsedAt: null })
      }
      return []
    }

    if (normalized === 'UPDATE content_meta SET etag = ?, content_hash = ?, parsed_at = ? WHERE asset_id = ?') {
      this.contentMeta.set(params[3] as string, {
        etag: params[0] as string | null,
        contentHash: params[1] as string | null,
        parsedAt: params[2] as number,
      })
      return []
    }

    if (normalized === 'INSERT OR REPLACE INTO node_index (key, data, updated_at) VALUES (?, ?, ?)') {
      this.nodeIndex.set(params[0] as string, { data: params[1] as string, updatedAt: params[2] as number })
      return []
    }

    if (normalized === 'SELECT data FROM node_index WHERE key = ?') {
      const row = this.nodeIndex.get(params[0] as string)
      return row ? [({ data: row.data } as T)] : []
    }

    if (normalized === 'SELECT data FROM comments ORDER BY created_at, rowid') {
      return [...this.comments.values()]
        .sort((a, b) => a.created_at - b.created_at || a.rowid - b.rowid)
        .map((row) => ({ data: row.data }) as T)
    }

    if (normalized === 'SELECT data FROM comments WHERE id = ?') {
      const row = this.comments.get(params[0] as string)
      return row ? [({ data: row.data } as T)] : []
    }

    if (normalized.startsWith('INSERT OR REPLACE INTO comments')) {
      this.comments.set(params[0] as string, {
        data: params[1] as string,
        created_at: params[2] as number,
        rowid: ++this.rowid,
      })
      return []
    }

    throw new Error(`unexpected SQL: ${query}`)
  }
}

function makeDo() {
  const sql = new FakeSql()
  const instance = Object.create(HtmlDocDO.prototype) as HtmlDocDO & {
    ctx: { storage: { sql: FakeSql } }
  }
  Object.defineProperty(instance, 'ctx', { value: { storage: { sql } } })
  return { instance, sql }
}

function request(path: string, opts: { method?: string; body?: unknown; principal?: Principal | null; role?: Role; assetId?: string } = {}) {
  const headers = new Headers()
  headers.set(HEADER_ASSET, opts.assetId ?? 'asset-1')
  if (opts.principal !== null) headers.set(HEADER_PRINCIPAL, JSON.stringify(opts.principal ?? user))
  headers.set(HEADER_ROLE, opts.role ?? 'commenter')
  if (opts.body !== undefined) headers.set('content-type', 'application/json')
  return new Request(`https://do${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
}

describe('HtmlDocDO comment REST surface', () => {
  it('persists doc-level asset comments and shared mutations', async () => {
    const { instance, sql } = makeDo()

    const createdRes = await instance.onRequest(request('/comments', { method: 'POST', body: { body: 'overall note' } }))
    expect(createdRes.status).toBe(200)
    const created = (await createdRes.json()) as Comment
    expect(created).toMatchObject({
      anchor: null,
      anchorKind: null,
      authorId: 'u1',
      authorName: 'Una',
      body: 'overall note',
      resolved: false,
      reactions: {},
      replies: [],
    })
    expect(sql.contentMeta.has('asset-1')).toBe(true)

    const replyRes = await instance.onRequest(
      request(`/comments/${created.id}/replies`, {
        method: 'POST',
        principal: agent,
        body: { body: 'reply body' },
      }),
    )
    expect(replyRes.status).toBe(200)
    expect(replyRes.headers.get(HEADER_COMMENT_AUTHOR)).toBe('u1')
    expect(await replyRes.json()).toMatchObject({ authorId: 'a1', authorName: 'Claude', body: 'reply body' })

    const reactionRes = await instance.onRequest(
      request(`/comments/${created.id}/reactions`, { method: 'POST', body: { emoji: 'ship' } }),
    )
    expect(reactionRes.status).toBe(200)
    expect((await reactionRes.json()) as Comment).toMatchObject({ reactions: { ship: ['u1'] } })

    const resolveRes = await instance.onRequest(
      request(`/comments/${created.id}/resolve`, { method: 'POST', body: { resolved: true } }),
    )
    expect(resolveRes.status).toBe(200)
    expect(await resolveRes.json()).toEqual({ resolved: true })

    const listedRes = await instance.onRequest(request('/comments'))
    expect(listedRes.status).toBe(200)
    const listed = (await listedRes.json()) as { comments: Comment[] }
    expect(listed.comments).toHaveLength(1)
    expect(listed.comments[0]).toMatchObject({
      id: created.id,
      resolved: true,
      replies: [expect.objectContaining({ body: 'reply body' })],
      reactions: { ship: ['u1'] },
    })
  })

  it('enforces trusted headers, write role, and rejects unindexed node anchors', async () => {
    const { instance } = makeDo()

    expect((await instance.onRequest(request('/comments', { method: 'POST', principal: null, body: { body: 'x' } }))).status).toBe(401)
    expect((await instance.onRequest(request('/comments', { method: 'POST', role: 'viewer', body: { body: 'x' } }))).status).toBe(403)
    expect((await instance.onRequest(request('/comments', { assetId: '', body: undefined }))).status).toBe(400)

    const nodeAttempt = await instance.onRequest(
      request('/comments', {
        method: 'POST',
        body: {
          body: 'on a node',
          nodeAnchor: {
            schema: 1,
            path: [],
            fingerprint: { tag: 'body' },
            domHint: 0,
            label: 'body',
            status: 'anchored',
          },
        },
      }),
    )
    expect(nodeAttempt.status).toBe(400)
    expect(await nodeAttempt.json()).toEqual({ error: 'content-not-indexed' })
  })

  it('indexes uploaded HTML and persists server-validated node comments', async () => {
    const { instance, sql } = makeDo()
    const html = '<main><button id="save">Save changes</button><button>Cancel changes</button></main>'
    const indexed = await instance.onRequest(
      request('/admin/content', {
        method: 'POST',
        role: 'editor',
        body: { etag: 'e1', contentHash: 'h1', html },
      }),
    )
    expect(indexed.status).toBe(200)
    expect(await indexed.json()).toMatchObject({ ok: true, nodes: 4, changed: 0 })
    expect(sql.contentMeta.get('asset-1')).toMatchObject({ etag: 'e1', contentHash: 'h1' })
    expect(sql.nodeIndex.has('asset-1')).toBe(true)

    const anchor = createNodeAnchor(parseHtmlNodeIndex(html), { domIndex: 2 })!
    const createdRes = await instance.onRequest(
      request('/comments', {
        method: 'POST',
        body: {
          body: 'button note',
          nodeAnchor: { ...anchor, path: [{ tag: 'body', nthOfType: 99 }], domHint: 99 },
        },
      }),
    )
    expect(createdRes.status).toBe(200)
    const created = (await createdRes.json()) as Comment
    expect(created).toMatchObject({
      anchor: null,
      anchorKind: 'node',
      body: 'button note',
      nodeAnchor: {
        status: 'anchored',
        label: 'button "Save changes"',
        domHint: 2,
        fingerprint: { id: 'save' },
      },
    })
    expect(created.nodeAnchor?.path).not.toEqual([{ tag: 'body', nthOfType: 99 }])

    const clientOnly = await instance.onRequest(
      request('/comments', {
        method: 'POST',
        body: {
          body: 'dynamic only',
          nodeAnchor: { ...anchor, clientResolveOnly: true },
        },
      }),
    )
    expect(clientOnly.status).toBe(400)
    expect(await clientOnly.json()).toEqual({ error: 'client-resolve-only' })
  })

  it('revalidates stored node comments when uploaded HTML changes', async () => {
    const { instance } = makeDo()
    const firstHtml = '<main><section><button id="save">Save changes</button></section></main>'
    await instance.onRequest(
      request('/admin/content', {
        method: 'POST',
        role: 'editor',
        body: { etag: 'e1', contentHash: 'h1', html: firstHtml },
      }),
    )
    const anchor = createNodeAnchor(parseHtmlNodeIndex(firstHtml), { domIndex: 3 })!
    const created = (await (
      await instance.onRequest(
        request('/comments', {
          method: 'POST',
          body: { body: 'follow this button', nodeAnchor: anchor },
        }),
      )
    ).json()) as Comment

    const movedHtml = '<main><p>Intro text</p><div><button id="save">Save changes</button></div></main>'
    const moved = await instance.onRequest(
      request('/admin/content', {
        method: 'POST',
        role: 'editor',
        body: { etag: 'e2', contentHash: 'h2', html: movedHtml },
      }),
    )
    expect(moved.status).toBe(200)
    expect(await moved.json()).toMatchObject({ ok: true, changed: 1, anchored: 1, orphaned: 0 })

    const afterMove = (await (await instance.onRequest(request('/comments'))).json()) as { comments: Comment[] }
    expect(afterMove.comments[0]?.id).toBe(created.id)
    expect(afterMove.comments[0]?.nodeAnchor).toMatchObject({ status: 'anchored', domHint: 4 })

    const removed = await instance.onRequest(
      request('/admin/content', {
        method: 'POST',
        role: 'editor',
        body: { etag: 'e3', contentHash: 'h3', html: '<main><p>No button here</p></main>' },
      }),
    )
    expect(removed.status).toBe(200)
    expect(await removed.json()).toMatchObject({ ok: true, changed: 1, anchored: 0, orphaned: 1 })

    const afterRemove = (await (await instance.onRequest(request('/comments'))).json()) as { comments: Comment[] }
    expect(afterRemove.comments[0]?.nodeAnchor).toMatchObject({ status: 'orphaned' })
  })
})
