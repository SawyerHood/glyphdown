import { describe, expect, it } from 'vitest'
import { PUSH_RATE_LIMIT, PUSH_RATE_WINDOW_MS, decidePushWindow } from '../src/ratelimit.ts'

/**
 * SPEC §8.3.9: 60 pushes/min per identity. `timestamps` always include the
 * current attempt (the DO inserts the row before deciding).
 */
describe('decidePushWindow', () => {
  const NOW = 1_750_000_000_000

  function attempts(n: number, spreadMs = 50_000): number[] {
    // n attempts inside the window, newest at NOW.
    return Array.from({ length: n }, (_, i) => NOW - Math.floor((spreadMs * i) / Math.max(1, n - 1)))
  }

  it('allows pushes up to the limit', () => {
    expect(decidePushWindow([NOW], NOW).allowed).toBe(true)
    const atLimit = decidePushWindow(attempts(PUSH_RATE_LIMIT), NOW)
    expect(atLimit.countInWindow).toBe(PUSH_RATE_LIMIT)
    expect(atLimit.allowed).toBe(true)
  })

  it('denies the push past the limit', () => {
    const over = decidePushWindow(attempts(PUSH_RATE_LIMIT + 1), NOW)
    expect(over.countInWindow).toBe(PUSH_RATE_LIMIT + 1)
    expect(over.allowed).toBe(false)
  })

  it('ignores timestamps outside the window', () => {
    const old = Array.from({ length: 100 }, (_, i) => NOW - PUSH_RATE_WINDOW_MS - 1 - i * 1000)
    const decision = decidePushWindow([...old, NOW], NOW)
    expect(decision.countInWindow).toBe(1)
    expect(decision.allowed).toBe(true)
  })

  it('treats a timestamp exactly one window old as expired (strict boundary)', () => {
    const boundary = NOW - PUSH_RATE_WINDOW_MS
    const decision = decidePushWindow([boundary, NOW], NOW)
    expect(decision.countInWindow).toBe(1)
    // ...and pruneBefore covers it, so the DO deletes exactly the expired rows.
    expect(decision.pruneBefore).toBe(boundary)
    expect(boundary <= decision.pruneBefore).toBe(true)
  })

  it('keeps denying while the window stays saturated (denied attempts count)', () => {
    // 61 attempts at NOW, then another a second later: the previous denial's
    // row is still in the window, so the follow-up is denied too.
    const saturated = attempts(PUSH_RATE_LIMIT + 1, 0)
    expect(decidePushWindow(saturated, NOW).allowed).toBe(false)
    const retry = NOW + 1000
    expect(decidePushWindow([...saturated, retry], retry).allowed).toBe(false)
  })

  it('frees capacity once old pushes age out', () => {
    const burst = Array.from({ length: PUSH_RATE_LIMIT + 1 }, () => NOW)
    expect(decidePushWindow(burst, NOW).allowed).toBe(false)
    const later = NOW + PUSH_RATE_WINDOW_MS + 1
    expect(decidePushWindow([...burst, later], later).allowed).toBe(true)
  })

  it('honors custom limit and window', () => {
    expect(decidePushWindow([5, 6, 7], 7, 3, 10).allowed).toBe(true)
    expect(decidePushWindow([5, 6, 7, 8], 8, 3, 10).allowed).toBe(false)
    expect(decidePushWindow([5, 6, 7, 18], 18, 3, 10).countInWindow).toBe(1)
  })

  it('does not mutate its input', () => {
    const input = [NOW - 10, NOW]
    decidePushWindow(input, NOW)
    expect(input).toEqual([NOW - 10, NOW])
  })
})

describe('retryAfterSec', () => {
  const NOW2 = 1_000_000
  it('is zero when allowed', () => {
    expect(decidePushWindow([NOW2], NOW2).retryAfterSec).toBe(0)
  })

  it('waits for the gating entry to age out', () => {
    // limit 3, window 10s: entries at 1s,2s,3s + denied attempt at 4s.
    // A retry records its own row, so TWO priors must expire (1s and 2s):
    // gate = 2s entry, admissible at 12s -> retryAfter 8s.
    const d = decidePushWindow([1000, 2000, 3000, 4000], 4000, 3, 10_000)
    expect(d.allowed).toBe(false)
    expect(d.retryAfterSec).toBe(8) // (2000 + 10000 - 4000) / 1000
    // And a retry at exactly NOW + retryAfter is admitted.
    const retryAt = 4000 + d.retryAfterSec * 1000
    expect(decidePushWindow([1000, 2000, 3000, 4000, retryAt], retryAt, 3, 10_000).allowed).toBe(true)
  })

  it('is at least 1 second', () => {
    const d = decidePushWindow([0, 1, 2, 9999], 9999, 3, 10_000)
    expect(d.allowed).toBe(false)
    expect(d.retryAfterSec).toBeGreaterThanOrEqual(1)
  })
})
