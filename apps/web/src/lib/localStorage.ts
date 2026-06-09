/**
 * localStorage read with a one-time migration from a pre-rename key name
 * (`inkroom:*` after the Inkroom → Glyphdown rename): when the new key is
 * absent and the legacy key exists, its value is copied to the new key (and
 * the legacy key removed) so the user's panel state / recents / editor mode
 * survive the rename. Best-effort: storage errors (private mode, SSR)
 * degrade to null, matching the call sites' existing behavior.
 */
export function readWithLegacyMigration(key: string, legacyKey: string): string | null {
  try {
    const current = window.localStorage.getItem(key)
    if (current !== null) return current
    const legacy = window.localStorage.getItem(legacyKey)
    if (legacy !== null) {
      window.localStorage.setItem(key, legacy)
      window.localStorage.removeItem(legacyKey)
    }
    return legacy
  } catch {
    return null
  }
}
