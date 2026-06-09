import { useSyncExternalStore } from 'react'
import { readWithLegacyMigration } from './localStorage.ts'

/**
 * Open/closed state for the slide-out file tree, shared between the Header
 * toggle and the panel shell and persisted to localStorage. A tiny external
 * store (not context) so the Header and the shell don't need a common
 * provider. SSR always sees "closed"; `hydrateFileTreePanel()` (called once
 * on mount) restores the stored value — first visit defaults to open on wide
 * screens, closed on narrow ones.
 */

const OPEN_KEY = 'glyphdown:tree:open'
const COLLAPSED_KEY = 'glyphdown:tree:collapsed'
// Pre-rename key names, migrated on first read (see lib/localStorage.ts).
const LEGACY_OPEN_KEY = 'inkroom:tree:open'
const LEGACY_COLLAPSED_KEY = 'inkroom:tree:collapsed'

let open = false
let hydrated = false
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

export function hydrateFileTreePanel() {
  if (hydrated || typeof window === 'undefined') return
  hydrated = true
  // readWithLegacyMigration swallows storage errors (private mode etc.) —
  // null falls through to the width-based default.
  const stored = readWithLegacyMigration(OPEN_KEY, LEGACY_OPEN_KEY)
  open = stored === null ? window.matchMedia('(min-width: 1024px)').matches : stored === '1'
  emit()
}

export function setFileTreeOpen(next: boolean) {
  open = next
  try {
    window.localStorage.setItem(OPEN_KEY, next ? '1' : '0')
  } catch {
    // best-effort persistence only
  }
  emit()
}

export function toggleFileTree() {
  setFileTreeOpen(!open)
}

const subscribe = (cb: () => void) => {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function useFileTreeOpen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => open,
    () => false,
  )
}

// ---------------------------------------------------------------------------
// Per-folder expanded state. Stored as a map of *collapsed* folder ids so
// new folders default to expanded without needing an entry.
// ---------------------------------------------------------------------------

export function loadCollapsedFolders(): Record<string, boolean> {
  try {
    const raw = readWithLegacyMigration(COLLAPSED_KEY, LEGACY_COLLAPSED_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, boolean> = {}
    for (const [key, value] of Object.entries(parsed)) if (value === true) out[key] = true
    return out
  } catch {
    return {}
  }
}

export function saveCollapsedFolders(collapsed: Record<string, boolean>) {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsed))
  } catch {
    // best-effort persistence only
  }
}
