import type { FolderInfo } from './api.ts'

/**
 * Client-side vault model (vaults plan §4). A vault is a root folder row
 * (kind='vault'), so everything here derives from the shared ['folders']
 * query — no extra endpoint round-trips:
 *
 * - the switcher list (owned vaults first, then shared, each alphabetical);
 * - a folder's vault (walk parentId to the root) — used to scope the quick
 *   switcher, search results, and the Recent strip to the active vault;
 * - the ACTIVE vault: the vault the current URL lives in when derivable
 *   (links stay shareable), else the persisted localStorage choice, else the
 *   default-vault heuristic.
 */

const ACTIVE_VAULT_KEY = 'glyphdown:active-vault'

const byName = (a: FolderInfo, b: FolderInfo) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id)

/** Every vault visible to the caller: owned first, then shared, each alphabetical. */
export function listVaults(folders: readonly FolderInfo[]): FolderInfo[] {
  const vaults = folders.filter((f) => f.kind === 'vault')
  return [
    ...vaults.filter((v) => v.role === 'owner').sort(byName),
    ...vaults.filter((v) => v.role !== 'owner').sort(byName),
  ]
}

/**
 * The vault at the top of `folderId`'s parent chain. Null when the folder is
 * unknown or its visible chain tops out at a non-vault (e.g. a plain folder
 * shared into the viewer mid-tree). Cycle-safe like breadcrumbChain.
 */
export function vaultIdForFolder(folders: readonly FolderInfo[], folderId: string): string | null {
  const byId = new Map(folders.map((f) => [f.id, f]))
  const seen = new Set<string>()
  let cur = byId.get(folderId)
  while (cur !== undefined && !seen.has(cur.id)) {
    seen.add(cur.id)
    if (cur.kind === 'vault') return cur.id
    cur = cur.parentId === null ? undefined : byId.get(cur.parentId)
  }
  return null
}

/** The vault a doc lives in (via its folder chain); null when not derivable. */
export function docVaultId(doc: { folderId: string | null }, folders: readonly FolderInfo[]): string | null {
  return doc.folderId === null ? null : vaultIdForFolder(folders, doc.folderId)
}

/**
 * Fallback vault when nothing is stored (or the stored vault disappeared):
 * the oldest OWNED vault, preferring one named `Home` — the same heuristic
 * the server's ensureDefaultVault uses to pick/heal the default vault — and,
 * for a member with no owned vaults, the oldest shared vault.
 */
export function pickDefaultVault(folders: readonly FolderInfo[]): FolderInfo | null {
  const byAge = (a: FolderInfo, b: FolderInfo) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)
  const vaults = folders.filter((f) => f.kind === 'vault')
  const owned = vaults.filter((v) => v.role === 'owner').sort(byAge)
  if (owned.length > 0) return owned.find((v) => v.name.toLowerCase() === 'home') ?? owned[0]!
  return [...vaults].sort(byAge)[0] ?? null
}

/** The active vault: the stored choice when still visible, else the default. */
export function resolveActiveVault(folders: readonly FolderInfo[], storedId: string | null): FolderInfo | null {
  if (storedId !== null) {
    const stored = folders.find((f) => f.id === storedId && f.kind === 'vault')
    if (stored) return stored
  }
  return pickDefaultVault(folders)
}

// ---------------------------------------------------------------------------
// Persistence (best-effort, like lib/recents.ts: storage errors degrade to
// "nothing stored")
// ---------------------------------------------------------------------------

export function getStoredVaultId(): string | null {
  try {
    return window.localStorage.getItem(ACTIVE_VAULT_KEY)
  } catch {
    return null
  }
}

export function setStoredVaultId(id: string): void {
  try {
    window.localStorage.setItem(ACTIVE_VAULT_KEY, id)
  } catch {
    // best-effort only
  }
}
