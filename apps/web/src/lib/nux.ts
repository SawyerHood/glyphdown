/**
 * First-run welcome dialog (NUX) state, per user, per browser. localStorage
 * on purpose: no server round-trip, and "Show the welcome guide again" in
 * Settings is just a key delete. Storage errors (private mode, SSR) degrade
 * to "dismissed" so the dialog can never wedge a broken-storage session.
 */

const key = (userId: string) => `glyphdown:nux:dismissed:${userId}`

export function isNuxDismissed(userId: string): boolean {
  try {
    // `=== 'string'` (not `!== null`): defensive against nonstandard storage
    // shims that return undefined for missing keys.
    return typeof window.localStorage.getItem(key(userId)) === 'string'
  } catch {
    return true
  }
}

export function dismissNux(userId: string): void {
  try {
    window.localStorage.setItem(key(userId), String(Date.now()))
  } catch {
    // best-effort
  }
}

export function resetNux(userId: string): void {
  try {
    window.localStorage.removeItem(key(userId))
  } catch {
    // best-effort
  }
}
