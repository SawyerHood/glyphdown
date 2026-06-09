/**
 * Pure sliding-window logic for push rate limiting (SPEC §8.3.9: 60 pushes
 * per minute per identity). The DocDO records each push attempt as a row in
 * its `pushes(identity, ts)` table, loads that identity's timestamps, and
 * delegates the allow/deny + pruning decision here so the window math stays
 * unit-testable without a Durable Object.
 */

export const PUSH_RATE_LIMIT = 60
export const PUSH_RATE_WINDOW_MS = 60_000

export interface PushWindowDecision {
  allowed: boolean
  /** Pushes counted inside the window, including the current attempt. */
  countInWindow: number
  /** Rows with `ts <= pruneBefore` are outside every future window — delete them. */
  pruneBefore: number
  /** When denied: whole seconds until enough of the window expires to admit one push. */
  retryAfterSec: number
}

/**
 * Decide whether a push attempted at `now` is allowed.
 *
 * `timestamps` are the identity's recorded push timestamps INCLUDING the
 * current attempt (the DO inserts first, then decides — denied attempts keep
 * consuming the window, so hammering past the limit never drains it).
 * A timestamp is inside the window when `now - windowMs < ts` (strict: a
 * push exactly `windowMs` old has expired).
 */
export function decidePushWindow(
  timestamps: readonly number[],
  now: number,
  limit: number = PUSH_RATE_LIMIT,
  windowMs: number = PUSH_RATE_WINDOW_MS,
): PushWindowDecision {
  const pruneBefore = now - windowMs
  const inWindow: number[] = []
  for (const ts of timestamps) {
    if (ts > pruneBefore) inWindow.push(ts)
  }
  const allowed = inWindow.length <= limit
  let retryAfterSec = 0
  if (!allowed) {
    // A retry at time T (which records its own row) passes when at most
    // limit-1 of the current entries remain in its window — i.e. once the
    // (count - limit) oldest entries have aged out.
    inWindow.sort((a, b) => a - b)
    const gate = inWindow[inWindow.length - limit] ?? inWindow[0]!
    retryAfterSec = Math.max(1, Math.ceil((gate + windowMs - now) / 1000))
  }
  return { allowed, countInWindow: inWindow.length, pruneBefore, retryAfterSec }
}
