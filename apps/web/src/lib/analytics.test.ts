import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetAnalyticsForTest,
  captureError,
  DEFAULT_POSTHOG_HOST,
  identifyUser,
  initAnalytics,
  resetAnalytics,
  scrubShareToken,
  track,
  trackPageview,
  type PostHogLike,
} from './analytics.ts'
import { ANALYTICS_EVENT_NAMES, type AnalyticsEventName } from './analytics-events.ts'

function fakePostHog() {
  return {
    capture: vi.fn(),
    identify: vi.fn(),
    reset: vi.fn(),
    captureException: vi.fn(),
  } satisfies PostHogLike
}

/** Loader resolved manually so tests can exercise the pre-load queue. */
function deferredLoader() {
  let resolve!: (ph: PostHogLike) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<PostHogLike>((res, rej) => {
    resolve = res
    reject = rej
  })
  const loader = vi.fn(() => promise)
  return { loader, resolve, reject }
}

const flushMicrotasks = () => new Promise<void>((res) => setTimeout(res, 0))

beforeEach(() => {
  _resetAnalyticsForTest()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('graceful degradation (no key)', () => {
  // "No key" must mean NO key: the dev machine's apps/web/.env sets
  // VITE_POSTHOG_KEY (vitest loads .env like any vite build), and
  // initAnalytics falls back to it when opts.key is absent — so blank it out
  // or these tests would exercise the configured path.
  beforeEach(() => {
    vi.stubEnv('VITE_POSTHOG_KEY', '')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('initAnalytics without a key never invokes the loader', () => {
    const { loader } = deferredLoader()
    initAnalytics({ loader })
    expect(loader).not.toHaveBeenCalled()
  })

  it('a blank key counts as unconfigured', () => {
    const { loader } = deferredLoader()
    initAnalytics({ key: '   ', loader })
    expect(loader).not.toHaveBeenCalled()
  })

  it('every helper is a silent no-op when unconfigured', async () => {
    const { loader } = deferredLoader()
    initAnalytics({ loader })
    expect(() => {
      track('doc_created', { docId: 'd1', source: 'file-tree' })
      trackPageview()
      identifyUser({ id: 'u1', email: 'a@b.co' })
      resetAnalytics()
      captureError(new Error('boom'))
    }).not.toThrow()
    await flushMicrotasks()
    expect(loader).not.toHaveBeenCalled()
  })

  it('track before init is also a no-op (nothing queued or thrown)', async () => {
    track('folder_created', {})
    const ph = fakePostHog()
    initAnalytics({ key: 'phc_test', loader: () => Promise.resolve(ph) })
    await flushMicrotasks()
    expect(ph.capture).not.toHaveBeenCalled()
  })
})

describe('with a key configured', () => {
  it('loads via the loader with the key and default host', () => {
    const { loader } = deferredLoader()
    initAnalytics({ key: 'phc_test', loader })
    expect(loader).toHaveBeenCalledTimes(1)
    expect(loader).toHaveBeenCalledWith('phc_test', DEFAULT_POSTHOG_HOST)
  })

  it('respects an explicit host', () => {
    const { loader } = deferredLoader()
    initAnalytics({ key: 'phc_test', host: 'https://eu.i.posthog.com', loader })
    expect(loader).toHaveBeenCalledWith('phc_test', 'https://eu.i.posthog.com')
  })

  it('second init is ignored (first call wins)', () => {
    const { loader } = deferredLoader()
    initAnalytics({ key: 'phc_test', loader })
    initAnalytics({ key: 'phc_other', loader })
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('queues events fired before the chunk loads and flushes them in order', async () => {
    const ph = fakePostHog()
    const { loader, resolve } = deferredLoader()
    initAnalytics({ key: 'phc_test', loader })

    trackPageview()
    track('doc_created', { docId: 'd1', source: 'file-tree' })
    track('search_performed', { resultCount: 3 })
    expect(ph.capture).not.toHaveBeenCalled()

    resolve(ph)
    await flushMicrotasks()
    expect(ph.capture.mock.calls).toEqual([
      ['$pageview'],
      ['doc_created', { docId: 'd1', source: 'file-tree' }],
      ['search_performed', { resultCount: 3 }],
    ])
  })

  it('captures directly once loaded', async () => {
    const ph = fakePostHog()
    initAnalytics({ key: 'phc_test', loader: () => Promise.resolve(ph) })
    await flushMicrotasks()
    track('version_named', { docId: 'd9' })
    expect(ph.capture).toHaveBeenCalledWith('version_named', { docId: 'd9' })
  })

  it('captureError forwards to posthog.captureException with context', async () => {
    const ph = fakePostHog()
    initAnalytics({ key: 'phc_test', loader: () => Promise.resolve(ph) })
    await flushMicrotasks()
    const err = new Error('boom')
    captureError(err, { $exception_source: 'window.onerror' })
    expect(ph.captureException).toHaveBeenCalledWith(err, { $exception_source: 'window.onerror' })
  })

  it('a loader failure disables analytics quietly (no throw, queue dropped)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ph = fakePostHog()
    const { loader, reject } = deferredLoader()
    initAnalytics({ key: 'phc_test', loader })
    trackPageview()
    reject(new Error('adblocked'))
    await flushMicrotasks()
    track('folder_created', {})
    expect(ph.capture).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
  })

  it('a throwing capture never propagates to the caller', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ph = fakePostHog()
    ph.capture.mockImplementation(() => {
      throw new Error('posthog internal')
    })
    initAnalytics({ key: 'phc_test', loader: () => Promise.resolve(ph) })
    await flushMicrotasks()
    expect(() => trackPageview()).not.toThrow()
    expect(warn).toHaveBeenCalled()
  })
})

describe('identify / reset / sign_in transition', () => {
  it('identify sends id + person props and fires sign_in once per user', async () => {
    const ph = fakePostHog()
    initAnalytics({ key: 'phc_test', loader: () => Promise.resolve(ph) })
    await flushMicrotasks()

    identifyUser({ id: 'u1', email: 'ada@example.com', name: 'Ada' })
    expect(ph.identify).toHaveBeenCalledWith('u1', { email: 'ada@example.com', name: 'Ada' })
    expect(ph.capture).toHaveBeenCalledWith('sign_in', {})

    // Same user re-identified (every page load): no second sign_in.
    ph.capture.mockClear()
    identifyUser({ id: 'u1', email: 'ada@example.com', name: 'Ada' })
    expect(ph.capture).not.toHaveBeenCalledWith('sign_in', {})
  })

  it('reset clears the marker so the next sign-in fires sign_in again', async () => {
    const ph = fakePostHog()
    initAnalytics({ key: 'phc_test', loader: () => Promise.resolve(ph) })
    await flushMicrotasks()

    identifyUser({ id: 'u1' })
    resetAnalytics()
    expect(ph.reset).toHaveBeenCalledTimes(1)

    ph.capture.mockClear()
    identifyUser({ id: 'u1' })
    expect(ph.capture).toHaveBeenCalledWith('sign_in', {})
  })
})

describe('event registry', () => {
  it('is centralized: the runtime list mirrors the type map exactly', () => {
    const expected: AnalyticsEventName[] = [
      'sign_in',
      'doc_created',
      'folder_created',
      'vault_created',
      'vault_deleted',
      'doc_opened',
      'doc_shared',
      'vault_shared',
      'invite_sent',
      'invite_accepted',
      'suggestion_created',
      'suggestion_accepted',
      'suggestion_rejected',
      'comment_created',
      'version_named',
      'search_performed',
      'cli_push',
    ]
    expect([...ANALYTICS_EVENT_NAMES].sort()).toEqual([...expected].sort())
    expect(new Set(ANALYTICS_EVENT_NAMES).size).toBe(ANALYTICS_EVENT_NAMES.length)
  })
})

describe('scrubShareToken (privacy)', () => {
  it('redacts the share token from URLs', () => {
    expect(scrubShareToken('https://glyphdown.com/d/doc1?share=secret-token')).toBe(
      'https://glyphdown.com/d/doc1?share=redacted',
    )
  })

  it('leaves share-less URLs and non-URLs untouched', () => {
    expect(scrubShareToken('https://glyphdown.com/d/doc1')).toBe('https://glyphdown.com/d/doc1')
    expect(scrubShareToken('not a url')).toBe('not a url')
    expect(scrubShareToken(42)).toBe(42)
  })
})
