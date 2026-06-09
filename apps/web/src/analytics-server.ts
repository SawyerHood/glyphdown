/**
 * Worker-side PostHog capture (plain fetch to /capture/ — no SDK), following
 * the email module's contract: when POSTHOG_KEY is unset everything no-ops
 * silently and returns { captured: false, reason: 'analytics-not-configured' }.
 * Capture failures NEVER throw — analytics must not break a request.
 *
 * Scope: the Worker layer only. The DOs have no PostHog env vars by design —
 * DO failures surface through the Worker's proxied calls (5xx responses) and
 * the Worker's own error capture.
 *
 * Worker-only at capture time (reads `cloudflare:workers` env lazily) but
 * importable from node (vitest) — tests inject env + fetch via the options bag.
 */
import type { AnalyticsEventName, AnalyticsEvents } from './lib/analytics-events.ts'

export interface AnalyticsServerEnv {
  POSTHOG_KEY?: string
  POSTHOG_HOST?: string
}

export const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com'

export type ServerCaptureResult =
  | { captured: true }
  | { captured: false; reason: 'analytics-not-configured' | 'capture-failed' }

interface CaptureOptions {
  env?: AnalyticsServerEnv
  fetchImpl?: typeof fetch
}

async function capture(
  event: string,
  distinctId: string,
  properties: Record<string, unknown>,
  opts?: CaptureOptions,
): Promise<ServerCaptureResult> {
  try {
    // Lazy env read keeps `cloudflare:workers` out of the node test graph.
    const env: AnalyticsServerEnv =
      opts?.env ?? ((await import('cloudflare:workers')).env as unknown as AnalyticsServerEnv)
    const key = env.POSTHOG_KEY
    if (!key || key.trim() === '') return { captured: false, reason: 'analytics-not-configured' }

    const host = (
      env.POSTHOG_HOST && env.POSTHOG_HOST.trim() !== '' ? env.POSTHOG_HOST.trim() : DEFAULT_POSTHOG_HOST
    ).replace(/\/+$/, '')
    const fetchImpl = opts?.fetchImpl ?? fetch
    const res = await fetchImpl(`${host}/capture/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api_key: key,
        event,
        distinct_id: distinctId,
        properties: { ...properties, $lib: 'glyphdown-worker' },
        timestamp: new Date().toISOString(),
      }),
    })
    if (!res.ok) {
      console.error(`[analytics] PostHog rejected ${event} (${res.status})`)
      return { captured: false, reason: 'capture-failed' }
    }
    return { captured: true }
  } catch (err) {
    console.error(`[analytics] server capture failed for ${event}:`, err)
    return { captured: false, reason: 'capture-failed' }
  }
}

/** Fire one intentional server-side event (typed against the central registry). */
export function captureServerEvent<E extends AnalyticsEventName>(
  event: E,
  distinctId: string,
  properties: AnalyticsEvents[E],
  opts?: CaptureOptions,
): Promise<ServerCaptureResult> {
  return capture(event, distinctId, properties as Record<string, unknown>, opts)
}

/**
 * Report a Worker-layer exception as a PostHog $exception event:
 * {message, stack, url, method}. The URL is stripped to origin+pathname so
 * share/invite tokens riding query strings never leave the Worker.
 */
export function captureServerException(
  error: unknown,
  request: { url: string; method: string },
  opts?: CaptureOptions,
): Promise<ServerCaptureResult> {
  const err = error instanceof Error ? error : new Error(String(error))
  let url = request.url
  try {
    const parsed = new URL(request.url)
    url = parsed.origin + parsed.pathname
  } catch {
    // keep the raw value if it doesn't parse
  }
  return capture(
    '$exception',
    'glyphdown-worker',
    {
      // Modern error-tracking shape + legacy raw fields (renders either way).
      $exception_list: [{ type: err.name, value: err.message, mechanism: { handled: false, synthetic: false } }],
      $exception_message: err.message,
      $exception_type: err.name,
      ...(err.stack ? { $exception_stack_trace_raw: err.stack } : {}),
      $exception_level: 'error',
      url,
      method: request.method,
      runtime: 'cloudflare-worker',
    },
    opts,
  )
}
