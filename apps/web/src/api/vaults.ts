import { and, eq } from 'drizzle-orm'
import { folders, userPrefs } from '../db/schema.ts'
import type { Db } from '../db/client.ts'

/**
 * Vaults (Phase 1 foundation): a vault is a special root folder — a
 * `folders` row with kind='vault' and parent_id NULL. Post-backfill
 * invariant: every doc lives in some vault's subtree, and the root level
 * contains only vaults (router.ts enforces both on every write).
 *
 * `ensureDefaultVault` is the one shared helper (plan §1): give a user a
 * usable default vault, creating the `Home` vault on first need. Used by
 * new-user signup (auth.ts databaseHooks), createDoc's no-folderId fallback,
 * and trash restore; the backfill script applies the same semantics in SQL.
 */

const DEFAULT_VAULT_NAME = 'Home'

type VaultRow = typeof folders.$inferSelect

/** First name not colliding (case-insensitively) with an existing vault: `Home`, `Home-2`, … */
export function availableVaultName(base: string, takenLower: ReadonlySet<string>): string {
  if (!takenLower.has(base.toLowerCase())) return base
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`
    if (!takenLower.has(candidate.toLowerCase())) return candidate
  }
}

/**
 * The user's default vault id, creating it if needed. Idempotent:
 *  1. a valid user_prefs.default_vault_id (existing, owned, kind='vault')
 *     wins;
 *  2. else the user's oldest vault (preferring one named `Home`) is adopted
 *     as the default — heals a missing/stale pref without minting Home-2;
 *  3. else a fresh `Home` vault is created (suffixed -2, -3, … on the
 *     unlikely vault-name collision) and recorded as the default.
 */
export async function ensureDefaultVault(db: Db, userId: string): Promise<string> {
  const pref = (await db.select().from(userPrefs).where(eq(userPrefs.userId, userId)).limit(1))[0]
  const owned = await db
    .select()
    .from(folders)
    .where(and(eq(folders.ownerUserId, userId), eq(folders.kind, 'vault')))

  if (pref?.defaultVaultId) {
    const valid = owned.find((v) => v.id === pref.defaultVaultId)
    if (valid) return valid.id
  }

  let vault: VaultRow | undefined = pickDefault(owned)
  if (!vault) {
    vault = {
      id: crypto.randomUUID(),
      ownerUserId: userId,
      name: availableVaultName(DEFAULT_VAULT_NAME, new Set(owned.map((v) => v.name.toLowerCase()))),
      kind: 'vault',
      parentId: null,
      createdAt: Date.now(),
    }
    await db.insert(folders).values(vault)
  }

  // Reaching here means the pref was missing or stale — record the healed id.
  await db
    .insert(userPrefs)
    .values({ userId, defaultVaultId: vault.id })
    .onConflictDoUpdate({ target: userPrefs.userId, set: { defaultVaultId: vault.id } })
  return vault.id
}

/** Oldest owned vault, preferring an exact (case-insensitive) `Home`. */
function pickDefault(owned: VaultRow[]): VaultRow | undefined {
  const byAge = [...owned].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  return byAge.find((v) => v.name.toLowerCase() === DEFAULT_VAULT_NAME.toLowerCase()) ?? byAge[0]
}
