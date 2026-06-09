/**
 * Browser-side analytics + error reporting (PostHog), mirroring the email
 * module's contract: GRACEFUL DEGRADATION is hard — when VITE_POSTHOG_KEY is
 * unset every helper here is a silent no-op and posthog-js is never even
 * downloaded. Nothing in the app may branch on analytics being configured.
 *
 * PERFORMANCE: posthog-js is loaded via dynamic import from initAnalytics()
 * (called in a root-shell effect, i.e. after first paint), so it lives in its
 * own code-split chunk and never sits in the editor's critical path. Events
 * fired before the chunk lands are queued and flushed in order.
 *
 * Event names/properties are typed against lib/analytics-events.ts — the one
 * central registry. Autocapture stays OFF; every event is intentional.
 */
import type { AnalyticsEventName, AnalyticsEvents } from './analytics-events.ts'

/** The slice of the posthog-js singleton we use (keeps tests dependency-free). */
export interface PostHogLike {
  capture(event: string, properties?: Record<string, unknown>): unknown
  identify(distinctId: string, properties?: Record<string, unknown>): unknown
  reset(): void
  captureException(error: unknown, additionalProperties?: Record<string, unknown>): unknown
}

export type PostHogLoader = (key: string, host: string) => Promise<PostHogLike>

export const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com'

/** localStorage marker for the sign_in transition (anonymous → this user). */
const LAST_UID_KEY = 'glyphdown:analytics:uid'

interface AnalyticsState {
  initialized: boolean
  enabled: boolean
  client: PostHogLike | null
  queue: Array<(ph: PostHogLike) => void>
  /** Fallback marker when localStorage is unavailable (private mode, tests). */
  memoryLastUid: string | null
  listenersInstalled: boolean
}

function freshState(): AnalyticsState {
  return { initialized: false, enabled: false, client: null, queue: [], memoryLastUid: null, listenersInstalled: false }
}

let state = freshState()

/** Test hook: wipe module state between cases. */
export function _resetAnalyticsForTest(): void {
  state = freshState()
}

/** Strip the share token from URL-ish strings before they leave the browser. */
export function scrubShareToken(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    const url = new URL(value)
    if (url.searchParams.has('share')) {
      url.searchParams.set('share', 'redacted')
      return url.toString()
    }
    return value
  } catch {
    return value
  }
}

const defaultLoader: PostHogLoader = async (key, host) => {
  // posthog-js's npm bootstrap flushes its internal request queue on
  // DOMContentLoaded — an event that has usually ALREADY fired by the time
  // this deferred chunk evaluates (readyState 'interactive'), which would
  // leave every event queued in the SDK forever. Waiting for the document to
  // be fully loaded sidesteps that and keeps the SDK entirely out of the
  // first-load critical path (verified live: events stall without this).
  await documentComplete()
  // Dynamic import = separate chunk, fetched after first paint.
  const { default: posthog } = await import('posthog-js')
  posthog.init(key, {
    api_host: host,
    // A docs app: events stay intentional. No autocapture, no recordings.
    autocapture: false,
    capture_pageview: false, // captured manually on router navigation
    capture_pageleave: false,
    capture_exceptions: false, // we wire window error listeners ourselves (queued pre-load)
    disable_session_recording: true,
    persistence: 'localStorage+cookie',
    // The npm bootstrap enables the batching queue on DOMContentLoaded — at
    // module-eval time, BEFORE a late dynamic import has called init() — so
    // a deferred load like ours would never flush batched events. Send each
    // (rare, intentional) event immediately instead (verified live).
    request_batching: false,
    // Share-link capability tokens must never reach a third party.
    before_send: (event) => {
      if (event?.properties) {
        for (const prop of ['$current_url', '$referrer', '$prev_pageview_pathname']) {
          if (prop in event.properties) event.properties[prop] = scrubShareToken(event.properties[prop])
        }
      }
      return event
    },
  })
  return posthog
}

/**
 * Initialize analytics for this page. Safe to call repeatedly (first call wins);
 * a no-op during SSR and whenever no key is configured. Loading happens in
 * the background — callers never wait on it.
 */
export function initAnalytics(opts: { key?: string; host?: string; loader?: PostHogLoader } = {}): void {
  if (state.initialized) return
  state.initialized = true

  const key = opts.key ?? (import.meta.env.VITE_POSTHOG_KEY as string | undefined)
  if (!key || key.trim() === '') return // unconfigured: everything stays a no-op
  // Only the loader needs a browser; tests drive a fake loader from node.
  if (opts.loader === undefined && typeof window === 'undefined') return

  state.enabled = true
  installGlobalErrorListeners()

  const host = firstNonBlank(opts.host, import.meta.env.VITE_POSTHOG_HOST as string | undefined) ?? DEFAULT_POSTHOG_HOST
  const loader = opts.loader ?? defaultLoader
  loader(key, host).then(
    (ph) => {
      state.client = ph
      const queued = state.queue
      state.queue = []
      for (const fn of queued) runSafely(fn, ph)
    },
    (err: unknown) => {
      // Ad blockers, offline, CDN hiccups: analytics dies quietly, app doesn't.
      state.enabled = false
      state.queue = []
      console.warn('[analytics] posthog-js failed to load — analytics disabled for this session', err)
    },
  )
}

function documentComplete(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof document === 'undefined' || document.readyState === 'complete') {
      resolve()
      return
    }
    window.addEventListener('load', () => resolve(), { once: true })
  })
}

function firstNonBlank(...values: Array<string | undefined>): string | undefined {
  for (const v of values) if (v && v.trim() !== '') return v
  return undefined
}

function runSafely(fn: (ph: PostHogLike) => void, ph: PostHogLike): void {
  try {
    fn(ph)
  } catch (err) {
    console.warn('[analytics] capture failed', err)
  }
}

/** Run against the client now, or queue until the chunk loads. No-op when disabled. */
function withClient(fn: (ph: PostHogLike) => void): void {
  if (!state.enabled) return
  if (state.client) runSafely(fn, state.client)
  else state.queue.push(fn)
}

/** Fire one intentional product event (typed against the central registry). */
export function track<E extends AnalyticsEventName>(event: E, properties: AnalyticsEvents[E]): void {
  withClient((ph) => ph.capture(event, properties))
}

/** Manual $pageview — called by the root shell on every router navigation. */
export function trackPageview(): void {
  withClient((ph) => ph.capture('$pageview'))
}

/**
 * Tie events to the signed-in user. Distinct id is the user id; email/name
 * become person properties (PostHog needs them for the people view — no other
 * PII is ever sent). Fires `sign_in` exactly once per anonymous→user
 * transition on this browser (the marker is cleared by resetAnalytics).
 */
export function identifyUser(user: { id: string; email?: string; name?: string }): void {
  if (!state.enabled) return
  withClient((ph) =>
    ph.identify(user.id, {
      ...(user.email ? { email: user.email } : {}),
      ...(user.name ? { name: user.name } : {}),
    }),
  )
  if (readLastUid() !== user.id) {
    writeLastUid(user.id)
    track('sign_in', {})
  }
}

/** Sign-out: detach the person so the next visitor starts anonymous. */
export function resetAnalytics(): void {
  if (!state.enabled) return
  clearLastUid()
  withClient((ph) => ph.reset())
}

/** Report an exception (error boundary, window.onerror, unhandledrejection, call sites). */
export function captureError(error: unknown, context?: Record<string, unknown>): void {
  withClient((ph) => ph.captureException(error, context))
}

/**
 * window.onerror + unhandledrejection → captureError. Installed by
 * initAnalytics (enabled only), so errors thrown before the posthog chunk
 * lands still get queued and reported.
 */
function installGlobalErrorListeners(): void {
  if (state.listenersInstalled || typeof window === 'undefined') return
  state.listenersInstalled = true
  window.addEventListener('error', (event) => {
    captureError(event.error ?? new Error(String(event.message)), { $exception_source: 'window.onerror' })
  })
  window.addEventListener('unhandledrejection', (event) => {
    const reason: unknown = event.reason
    captureError(reason instanceof Error ? reason : new Error(String(reason)), {
      $exception_source: 'unhandledrejection',
    })
  })
}

// ---------------------------------------------------------------------------
// sign_in transition marker (localStorage with in-memory fallback)
// ---------------------------------------------------------------------------

function readLastUid(): string | null {
  try {
    return window.localStorage.getItem(LAST_UID_KEY) ?? state.memoryLastUid
  } catch {
    return state.memoryLastUid
  }
}

function writeLastUid(uid: string): void {
  state.memoryLastUid = uid
  try {
    window.localStorage.setItem(LAST_UID_KEY, uid)
  } catch {
    // private mode etc. — memory fallback already holds it
  }
}

function clearLastUid(): void {
  state.memoryLastUid = null
  try {
    window.localStorage.removeItem(LAST_UID_KEY)
  } catch {
    // ignore
  }
}
