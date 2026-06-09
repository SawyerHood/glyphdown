/**
 * Recently visited doc ids (most-recent-first) in localStorage — feeds the
 * quick switcher's recency boost (lib/fuzzy.ts). Best-effort: storage errors
 * (private mode, SSR) degrade to an empty list.
 */

import { readWithLegacyMigration } from './localStorage.ts'

const KEY = 'glyphdown:recent-docs'
// Pre-rename key name, migrated on first read (see lib/localStorage.ts).
const LEGACY_KEY = 'inkroom:recent-docs'
const MAX_RECENTS = 20

export function getRecentDocIds(): string[] {
  try {
    const raw = readWithLegacyMigration(KEY, LEGACY_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function recordRecentDoc(docId: string): void {
  try {
    const next = [docId, ...getRecentDocIds().filter((id) => id !== docId)].slice(0, MAX_RECENTS)
    window.localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // best-effort only
  }
}
