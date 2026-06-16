import type { PushResponse } from '@glyphdown/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CliError, createApi, pushWithBase } from '../src/index.ts'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const SERVER = 'https://ink.example'
const KEY = 'gd_sk_test123'

function apiWith(fetchMock: typeof fetch) {
  return createApi({ serverUrl: SERVER, apiKey: KEY, fetchImpl: fetchMock })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createApi', () => {
  it('sends Authorization: Bearer and hits the protocol paths', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ docs: [] }))
    vi.stubGlobal('fetch', fetchMock)
    // default fetchImpl path: rely on the stubbed global
    const api = createApi({ serverUrl: `${SERVER}/`, apiKey: KEY })
    await api.listDocs()

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit]
    expect(url).toBe(`${SERVER}/api/docs`)
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`)
  })

  it('sends a device-flow sessionToken as Bearer, with apiKey taking priority', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ docs: [] })) as unknown as typeof fetch
    const tokenApi = createApi({ serverUrl: SERVER, sessionToken: 'sess_tok', fetchImpl: fetchMock })
    await tokenApi.listDocs()
    const calls = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls
    expect((calls[0]![1] as RequestInit).headers).toMatchObject({ authorization: 'Bearer sess_tok' })

    const bothApi = createApi({ serverUrl: SERVER, apiKey: KEY, sessionToken: 'sess_tok', fetchImpl: fetchMock })
    await bothApi.listDocs()
    expect((calls[1]![1] as RequestInit).headers).toMatchObject({ authorization: `Bearer ${KEY}` })
  })

  it('maps 401 to an auth error that mentions login', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'unauthenticated' }, 401)) as unknown as typeof fetch
    const api = apiWith(fetchMock)
    await expect(api.listDocs()).rejects.toThrowError(/glyphdown login|GLYPHDOWN_API_KEY/)
  })

  it('normalizes EOLs on pulled content and reads the version header', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response('a\r\nb\r\nc', {
          status: 200,
          headers: { 'content-type': 'text/markdown', 'x-glyphdown-version': 'v42' },
        }),
    ) as unknown as typeof fetch
    const api = apiWith(fetchMock)
    const content = await api.getContent('doc1')
    expect(content.text).toBe('a\nb\nc')
    expect(content.versionId).toBe('v42')
  })

  it('falls back to the legacy x-inkroom-* headers from a pre-rename server', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response('hello', {
          status: 200,
          headers: {
            'content-type': 'text/markdown',
            'x-inkroom-version': 'v7',
            'x-inkroom-base-hash': 'hash7',
          },
        }),
    ) as unknown as typeof fetch
    const api = apiWith(fetchMock)
    const content = await api.getContent('doc1')
    expect(content.versionId).toBe('v7')
    expect(content.baseHash).toBe('hash7')
  })

  it('returns PushResponse rejections (degenerate) instead of throwing', async () => {
    const degenerate: PushResponse = { ok: false, reason: 'degenerate', deletedRatio: 0.83 }
    const fetchMock = vi.fn(async () => jsonResponse(degenerate, 409)) as unknown as typeof fetch
    const api = apiWith(fetchMock)
    const res = await api.push('doc1', { newText: 'x', baseHash: 'h' })
    expect(res).toEqual(degenerate)
  })

  it('throws mapped errors for non-PushResponse push failures', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'unauthenticated' }, 401)) as unknown as typeof fetch
    const api = apiWith(fetchMock)
    await expect(api.push('doc1', { newText: 'x', baseHash: 'h' })).rejects.toBeInstanceOf(CliError)
  })

  it('deletes a doc with DELETE /api/docs/:id', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true })) as unknown as typeof fetch
    const api = apiWith(fetchMock)
    await api.deleteDoc('doc1')
    const [url, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0]! as [string, RequestInit]
    expect(url).toBe(`${SERVER}/api/docs/doc1`)
    expect(init.method).toBe('DELETE')
  })
})

describe('share links', () => {
  it('lists doc share links: GET /share-links, unwrapped', async () => {
    const links = [{ token: 'tok1', role: 'viewer', createdAt: 5 }]
    const fetchMock = vi.fn(async () => jsonResponse({ shareLinks: links })) as unknown as typeof fetch
    const api = apiWith(fetchMock)
    await expect(api.listDocShareLinks('doc1')).resolves.toEqual(links)
    const [url, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0]! as [string, RequestInit]
    expect(url).toBe(`${SERVER}/api/docs/doc1/share-links`)
    expect(init.method).toBe('GET')
  })

  it('creates a doc share link: POST with the role in the body', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ token: 'tok2', role: 'editor', createdAt: 6 })) as unknown as typeof fetch
    const api = apiWith(fetchMock)
    const link = await api.createDocShareLink('doc1', 'editor')
    expect(link).toEqual({ token: 'tok2', role: 'editor', createdAt: 6 })
    const [url, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0]! as [string, RequestInit]
    expect(url).toBe(`${SERVER}/api/docs/doc1/share-links`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ role: 'editor' })
  })

  it('revokes a doc share link: DELETE /share-links/:token (token URL-encoded)', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true })) as unknown as typeof fetch
    const api = apiWith(fetchMock)
    await api.revokeDocShareLink('doc1', 'tok/3')
    const [url, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0]! as [string, RequestInit]
    expect(url).toBe(`${SERVER}/api/docs/doc1/share-links/tok%2F3`)
    expect(init.method).toBe('DELETE')
  })

  it('folder share links ride /api/folders/:id/share-links', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ shareLinks: [] }))
      .mockResolvedValueOnce(jsonResponse({ token: 'ftok', role: 'viewer', createdAt: 7 }))
      .mockResolvedValueOnce(jsonResponse({ ok: true })) as unknown as typeof fetch
    const api = apiWith(fetchMock)
    await expect(api.listFolderShareLinks('f1')).resolves.toEqual([])
    await expect(api.createFolderShareLink('f1', 'viewer')).resolves.toEqual({ token: 'ftok', role: 'viewer', createdAt: 7 })
    await api.revokeFolderShareLink('f1', 'ftok')
    const calls = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<[string, RequestInit]>
    expect(calls.map(([url, init]) => `${init.method} ${url}`)).toEqual([
      `GET ${SERVER}/api/folders/f1/share-links`,
      `POST ${SERVER}/api/folders/f1/share-links`,
      `DELETE ${SERVER}/api/folders/f1/share-links/ftok`,
    ])
  })

  it('maps a 403 (non-owner) to the forbidden CliError', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'forbidden' }, 403)) as unknown as typeof fetch
    const api = apiWith(fetchMock)
    await expect(api.createDocShareLink('doc1', 'viewer')).rejects.toThrowError(/forbidden/)
  })
})

describe('versions and asset comments', () => {
  it('lists doc versions and reads a specific doc version', async () => {
    const version = { id: 'v1', createdAt: 1, authorIds: ['u1'], kind: 'named', sizeBytes: 8 }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ versions: [version] }))
      .mockResolvedValueOnce(jsonResponse({ text: 'a\r\nb\r\n' })) as unknown as typeof fetch
    const api = apiWith(fetchMock)

    await expect(api.listVersions('doc1')).resolves.toEqual([version])
    await expect(api.getVersionText('doc1', 'v1')).resolves.toBe('a\nb\n')

    const calls = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<[string, RequestInit]>
    expect(calls.map(([url, init]) => `${init.method} ${url}`)).toEqual([
      `GET ${SERVER}/api/docs/doc1/versions`,
      `GET ${SERVER}/api/docs/doc1/versions/v1`,
    ])
  })

  it('uses the filename-addressed asset comment routes', async () => {
    const comment = { id: 'c1' }
    const reply = { id: 'r1' }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ comments: [comment] }))
      .mockResolvedValueOnce(jsonResponse(comment))
      .mockResolvedValueOnce(jsonResponse(reply))
      .mockResolvedValueOnce(jsonResponse({ resolved: true })) as unknown as typeof fetch
    const api = apiWith(fetchMock)

    await expect(api.listDocAssetComments('doc1', 'page.html')).resolves.toEqual([comment])
    await expect(api.createFolderAssetComment('f1', 'page.html', { body: 'file note' })).resolves.toEqual(comment)
    await expect(api.replyToDocAssetComment('doc1', 'page.html', 'c1', 'fixed')).resolves.toEqual(reply)
    await api.resolveFolderAssetComment('f1', 'page.html', 'c1')

    const calls = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<[string, RequestInit]>
    expect(calls.map(([url, init]) => `${init.method} ${url}`)).toEqual([
      `GET ${SERVER}/api/docs/doc1/assets/page.html/comments`,
      `POST ${SERVER}/api/folders/f1/assets/page.html/comments`,
      `POST ${SERVER}/api/docs/doc1/assets/page.html/comments/c1/replies`,
      `POST ${SERVER}/api/folders/f1/assets/page.html/comments/c1/resolve`,
    ])
    expect(JSON.parse(calls[1]![1].body as string)).toEqual({ body: 'file note' })
    expect(JSON.parse(calls[3]![1].body as string)).toEqual({ resolved: true })
  })

  it('lists, names, and downloads asset versions', async () => {
    const version = {
      id: 'av1',
      assetId: 'a1',
      contentHash: 'hash',
      size: 12,
      etag: 'etag',
      createdBy: 'u1',
      createdAt: 1,
      current: true,
    }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ versions: [version] }))
      .mockResolvedValueOnce(jsonResponse({ ...version, message: 'Baseline' }))
      .mockResolvedValueOnce(
        new Response(new Uint8Array([60, 104, 49, 62]), {
          status: 200,
          headers: { 'content-type': 'text/html', etag: '"etag-old"' },
        }),
      ) as unknown as typeof fetch
    const api = apiWith(fetchMock)

    await expect(api.listFolderAssetVersions('f1', 'page.html')).resolves.toEqual([version])
    await expect(api.nameDocAssetVersion('doc1', 'page.html', 'av1', 'Baseline')).resolves.toMatchObject({
      id: 'av1',
      message: 'Baseline',
    })
    await expect(api.downloadFolderAsset('f1', 'page.html', 'av/old')).resolves.toMatchObject({
      data: new Uint8Array([60, 104, 49, 62]),
      etag: 'etag-old',
      contentType: 'text/html',
    })

    const calls = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<[string, RequestInit]>
    expect(calls.map(([url, init]) => `${init.method} ${url}`)).toEqual([
      `GET ${SERVER}/api/folders/f1/assets/page.html/versions`,
      `POST ${SERVER}/api/docs/doc1/assets/page.html/versions/av1/name`,
      `GET ${SERVER}/api/folders/f1/assets/page.html?version=av%2Fold`,
    ])
  })
})

describe('pushWithBase', () => {
  const ok: PushResponse = { ok: true, mode: 'edit', applied: 1, failedHunks: [], versionId: 'v2' }

  it('clean push: single request, no baseText, base hash forwarded', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(ok)) as unknown as typeof fetch
    const api = apiWith(fetchMock)
    const outcome = await pushWithBase(api, {
      docId: 'doc1',
      newText: 'new text\n',
      baseHash: 'abc123',
      baseText: 'base text\n',
    })
    expect(outcome.response).toEqual(ok)
    expect(outcome.resentBase).toBe(false)
    const calls = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls
    expect(calls).toHaveLength(1)
    const [url, init] = calls[0]! as [string, RequestInit]
    expect(url).toBe(`${SERVER}/api/docs/doc1/push`)
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body).toEqual({ newText: 'new text\n', baseHash: 'abc123' })
  })

  it('drifted push with base cache miss: re-sends base.md text', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: false, reason: 'base-missing' } satisfies PushResponse, 409))
      .mockResolvedValueOnce(jsonResponse(ok)) as unknown as typeof fetch
    const api = apiWith(fetchMock)
    const outcome = await pushWithBase(api, {
      docId: 'doc1',
      newText: 'edited\n',
      baseHash: 'h1',
      baseText: 'original base\n',
      note: 'tidy up',
    })
    expect(outcome.response).toEqual(ok)
    expect(outcome.resentBase).toBe(true)
    const calls = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls
    expect(calls).toHaveLength(2)
    const first = JSON.parse((calls[0]![1] as RequestInit).body as string) as Record<string, unknown>
    const second = JSON.parse((calls[1]![1] as RequestInit).body as string) as Record<string, unknown>
    expect(first.baseText).toBeUndefined()
    expect(second.baseText).toBe('original base\n')
    expect(second.baseHash).toBe('h1')
    expect(second.note).toBe('tidy up')
  })

  it('degenerate rejection is returned for the command layer to map to exit 3', async () => {
    const degenerate: PushResponse = { ok: false, reason: 'degenerate', deletedRatio: 0.9 }
    const fetchMock = vi.fn(async () => jsonResponse(degenerate, 409)) as unknown as typeof fetch
    const api = apiWith(fetchMock)
    const outcome = await pushWithBase(api, { docId: 'd', newText: 'n', baseHash: 'h', baseText: 'b' })
    expect(outcome.response).toEqual(degenerate)
  })

  it('failed hunks pass through verbatim', async () => {
    const partial: PushResponse = {
      ok: true,
      mode: 'edit',
      applied: 2,
      failedHunks: ['@@ -1,4 +1,9 @@\n-old\n+new\n'],
      versionId: 'v3',
    }
    const fetchMock = vi.fn(async () => jsonResponse(partial)) as unknown as typeof fetch
    const api = apiWith(fetchMock)
    const outcome = await pushWithBase(api, { docId: 'd', newText: 'n', baseHash: 'h', baseText: 'b' })
    expect(outcome.response).toEqual(partial)
  })

  it('suggest pushes forward the suggest flag and return the suggestion id', async () => {
    const suggested: PushResponse = { ok: true, mode: 'suggest', suggestionId: 's1', versionId: 'v4' }
    const fetchMock = vi.fn(async () => jsonResponse(suggested)) as unknown as typeof fetch
    const api = apiWith(fetchMock)
    const outcome = await pushWithBase(api, {
      docId: 'd',
      newText: 'n',
      baseHash: 'h',
      baseText: 'b',
      suggest: true,
    })
    expect(outcome.response).toEqual(suggested)
    const calls = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls
    const body = JSON.parse((calls[0]![1] as RequestInit).body as string) as Record<string, unknown>
    expect(body.suggest).toBe(true)
  })
})
