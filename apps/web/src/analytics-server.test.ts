import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  captureServerEvent,
  captureServerException,
  DEFAULT_POSTHOG_HOST,
} from './analytics-server.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

const okFetch = () => vi.fn(async () => new Response('{"status":1}', { status: 200 }))

describe('server capture degradation (no POSTHOG_KEY)', () => {
  it('returns analytics-not-configured and never fetches', async () => {
    const fetchImpl = vi.fn()
    const result = await captureServerEvent(
      'cli_push',
      'u1',
      { docId: 'd1', mode: 'edit', principalType: 'user' },
      { env: {}, fetchImpl: fetchImpl as unknown as typeof fetch },
    )
    expect(result).toEqual({ captured: false, reason: 'analytics-not-configured' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('treats a blank key as unconfigured', async () => {
    const fetchImpl = vi.fn()
    const result = await captureServerException(
      new Error('boom'),
      { url: 'https://glyphdown.com/api/docs', method: 'GET' },
      { env: { POSTHOG_KEY: '  ' }, fetchImpl: fetchImpl as unknown as typeof fetch },
    )
    expect(result).toEqual({ captured: false, reason: 'analytics-not-configured' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('captureServerEvent', () => {
  it('POSTs the event to <host>/capture/ with key, distinct_id, and properties', async () => {
    const fetchImpl = okFetch()
    const result = await captureServerEvent(
      'cli_push',
      'agent-1',
      { docId: 'd1', mode: 'suggest', principalType: 'agent' },
      { env: { POSTHOG_KEY: 'phc_server' }, fetchImpl: fetchImpl as unknown as typeof fetch },
    )
    expect(result).toEqual({ captured: true })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${DEFAULT_POSTHOG_HOST}/capture/`)
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body['api_key']).toBe('phc_server')
    expect(body['event']).toBe('cli_push')
    expect(body['distinct_id']).toBe('agent-1')
    expect(body['properties']).toMatchObject({ docId: 'd1', mode: 'suggest', principalType: 'agent' })
    expect(typeof body['timestamp']).toBe('string')
  })

  it('uses POSTHOG_HOST when set (trailing slashes trimmed)', async () => {
    const fetchImpl = okFetch()
    await captureServerEvent(
      'cli_push',
      'u1',
      { docId: 'd1', mode: 'edit', principalType: 'user' },
      {
        env: { POSTHOG_KEY: 'phc', POSTHOG_HOST: 'https://eu.i.posthog.com/' },
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    )
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe('https://eu.i.posthog.com/capture/')
  })

  it('maps a non-2xx response to capture-failed (never throws)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 401 }))
    const result = await captureServerEvent(
      'cli_push',
      'u1',
      { docId: 'd1', mode: 'edit', principalType: 'user' },
      { env: { POSTHOG_KEY: 'phc' }, fetchImpl: fetchImpl as unknown as typeof fetch },
    )
    expect(result).toEqual({ captured: false, reason: 'capture-failed' })
  })

  it('maps a network error to capture-failed (never throws)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET')
    })
    const result = await captureServerEvent(
      'cli_push',
      'u1',
      { docId: 'd1', mode: 'edit', principalType: 'user' },
      { env: { POSTHOG_KEY: 'phc' }, fetchImpl: fetchImpl as unknown as typeof fetch },
    )
    expect(result).toEqual({ captured: false, reason: 'capture-failed' })
  })
})

describe('captureServerException', () => {
  it('captures $exception with message, stack, url, and method', async () => {
    const fetchImpl = okFetch()
    const err = new Error('database exploded')
    const result = await captureServerException(
      err,
      { url: 'https://glyphdown.com/api/docs/d1/push', method: 'POST' },
      { env: { POSTHOG_KEY: 'phc' }, fetchImpl: fetchImpl as unknown as typeof fetch },
    )
    expect(result).toEqual({ captured: true })
    const body = JSON.parse(
      (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    ) as { event: string; properties: Record<string, unknown> }
    expect(body.event).toBe('$exception')
    expect(body.properties['$exception_message']).toBe('database exploded')
    expect(body.properties['$exception_type']).toBe('Error')
    expect(body.properties['$exception_list']).toEqual([
      { type: 'Error', value: 'database exploded', mechanism: { handled: false, synthetic: false } },
    ])
    expect(typeof body.properties['$exception_stack_trace_raw']).toBe('string')
    expect(body.properties['url']).toBe('https://glyphdown.com/api/docs/d1/push')
    expect(body.properties['method']).toBe('POST')
  })

  it('strips query strings from the captured URL (share/invite tokens)', async () => {
    const fetchImpl = okFetch()
    await captureServerException(
      new Error('x'),
      { url: 'https://glyphdown.com/d/doc1?share=secret-token', method: 'GET' },
      { env: { POSTHOG_KEY: 'phc' }, fetchImpl: fetchImpl as unknown as typeof fetch },
    )
    const body = JSON.parse(
      (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    ) as { properties: Record<string, unknown> }
    expect(body.properties['url']).toBe('https://glyphdown.com/d/doc1')
  })

  it('wraps non-Error throwables', async () => {
    const fetchImpl = okFetch()
    await captureServerException(
      'string throw',
      { url: 'https://glyphdown.com/', method: 'GET' },
      { env: { POSTHOG_KEY: 'phc' }, fetchImpl: fetchImpl as unknown as typeof fetch },
    )
    const body = JSON.parse(
      (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    ) as { properties: Record<string, unknown> }
    expect(body.properties['$exception_message']).toBe('string throw')
  })
})
