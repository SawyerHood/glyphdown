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
