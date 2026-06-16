import { and, eq, inArray, isNull } from 'drizzle-orm'
import { MAX_FOLDER_DEPTH, ROLES, type Principal, type Role } from '@glyphdown/protocol'
import { docMembers, docs, folderMembers, folders, shareLinks } from '../db/schema.ts'
import { propagateFolderRoles } from './folder-tree.ts'
import type { Db } from '../db/client.ts'

/**
 * Effective doc role per SPEC §4, extended for nested folders:
 *   role = max(owner-from-docs.owner_user_id, doc_members,
 *              folder_members on the doc's folder OR ANY ANCESTOR,
 *              share-link role when accessed via link — doc links, or folder
 *              links whose folder is the doc's folder or any ancestor)
 * Agents act with their owner's access (v1 scope = inherit), attributed to
 * the agent identity. Anonymous callers are only ever granted `viewer`, and
 * only through a view-role share link.
 *
 * `computeDocRole` stays pure (unit-tested in roles.test.ts): the data-fetch
 * layer (`resolveDocAccess`) loads the doc's folder ancestor chain and the
 * caller's grant rows from D1 and feeds them in.
 */

export interface DocRow {
  id: string
  /** Legacy column — DocMeta.title is derived from the filename stem now. */
  title: string
  /** Canonical doc name: `<slug>.md`, unique among live docs in its scope. */
  filename: string
  folderId: string | null
  ownerUserId: string
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}

export interface MembershipRow {
  principalId: string
  principalType: 'user' | 'agent'
  role: Role
}

/** folder_members rows carry their folder so inheritance can scope them. */
export interface FolderMembershipRow extends MembershipRow {
  folderId: string
}

export interface ShareLinkRow {
  targetType: 'doc' | 'folder' | 'asset'
  targetId: string
  role: Role
  revokedAt: number | null
}

export function maxRole(a: Role | null, b: Role | null): Role | null {
  if (a === null) return b
  if (b === null) return a
  return ROLES.indexOf(a) >= ROLES.indexOf(b) ? a : b
}

/** The user whose access a principal exercises (agents inherit their owner). */
export function effectiveUserId(principal: Principal | null): string | null {
  if (!principal) return null
  if (principal.type === 'agent') return principal.ownerUserId ?? null
  return principal.id
}

export function computeDocRole(input: {
  doc: Pick<DocRow, 'id' | 'ownerUserId'>
  /**
   * The doc's folder ancestor chain, nearest first: [folder, parent, …,
   * root]. Empty when the doc sits at the root. Grants and folder share
   * links apply when their folder is anywhere on this chain.
   */
  ancestorFolderIds: string[]
  principal: Principal | null
  docMembers: MembershipRow[]
  folderMembers: FolderMembershipRow[]
  shareLink: ShareLinkRow | null
}): Role | null {
  const { doc, ancestorFolderIds, principal, shareLink } = input
  const userId = effectiveUserId(principal)

  let role: Role | null = null
  if (userId !== null && userId === doc.ownerUserId) role = 'owner'

  const matches = (m: MembershipRow): boolean => {
    // Direct grant to this principal (user or agent identity)…
    if (principal && m.principalType === principal.type && m.principalId === principal.id) return true
    // …or, for agents, a grant to the human they act for.
    return userId !== null && m.principalType === 'user' && m.principalId === userId
  }
  for (const m of input.docMembers) if (matches(m)) role = maxRole(role, m.role)
  for (const m of input.folderMembers) {
    if (ancestorFolderIds.includes(m.folderId) && matches(m)) role = maxRole(role, m.role)
  }

  if (shareLink && shareLink.revokedAt === null) {
    const targetsDoc =
      (shareLink.targetType === 'doc' && shareLink.targetId === doc.id) ||
      (shareLink.targetType === 'folder' && ancestorFolderIds.includes(shareLink.targetId))
    if (targetsDoc) {
      if (principal) {
        role = maxRole(role, shareLink.role)
      } else if (shareLink.role === 'viewer') {
        // Anonymous visitors: read-only via view links; comment-and-above
        // requires sign-in (attribution).
        role = maxRole(role, 'viewer')
      }
    }
  }

  return role
}

export interface DocAccess {
  doc: DocRow
  role: Role | null
}

/**
 * Walk parent_id from `folderId` to the root with one D1 lookup per level
 * (depth is API-capped at MAX_FOLDER_DEPTH, so ≤ 10 queries). Returns the
 * chain nearest-first, `folderId` included. Cycle/corruption-safe: unknown
 * parents and revisits truncate the walk.
 */
export async function fetchAncestorChain(db: Db, folderId: string | null): Promise<string[]> {
  const chain: string[] = []
  let current = folderId
  while (current !== null && !chain.includes(current) && chain.length <= MAX_FOLDER_DEPTH) {
    const row = (
      await db
        .select({ id: folders.id, parentId: folders.parentId })
        .from(folders)
        .where(eq(folders.id, current))
        .limit(1)
    )[0]
    if (!row) break
    chain.push(row.id)
    current = row.parentId
  }
  return chain
}

/** Load the doc + grant rows and compute the caller's effective role. */
export async function resolveDocAccess(
  db: Db,
  docId: string,
  principal: Principal | null,
  shareToken: string | null,
): Promise<DocAccess | null> {
  const docRow = (
    await db.select().from(docs).where(eq(docs.id, docId)).limit(1)
  )[0]
  if (!docRow) return null

  const ancestorFolderIds = await fetchAncestorChain(db, docRow.folderId)
  const ids = principalIds(principal)
  const memberRows =
    ids.length > 0
      ? await db
          .select()
          .from(docMembers)
          .where(and(eq(docMembers.docId, docId), inArray(docMembers.principalId, ids)))
      : []
  const folderRows =
    ids.length > 0 && ancestorFolderIds.length > 0
      ? await db
          .select()
          .from(folderMembers)
          .where(
            and(inArray(folderMembers.folderId, ancestorFolderIds), inArray(folderMembers.principalId, ids)),
          )
      : []
  const linkRow = shareToken
    ? ((await db.select().from(shareLinks).where(eq(shareLinks.token, shareToken)).limit(1))[0] ?? null)
    : null

  const role = computeDocRole({
    doc: docRow,
    ancestorFolderIds,
    principal,
    docMembers: memberRows,
    folderMembers: folderRows,
    shareLink: linkRow,
  })
  return { doc: docRow, role }
}

/**
 * Effective role on a FOLDER (used by the folder list/read routes): max of
 * owner and folder_members grants on the folder or any of its ancestors —
 * the same inheritance docs get, applied one level up.
 */
export async function resolveFolderRole(
  db: Db,
  folder: { id: string; ownerUserId: string },
  principal: Principal | null,
): Promise<Role | null> {
  const userId = effectiveUserId(principal)
  if (userId !== null && userId === folder.ownerUserId) return 'owner'
  const ids = principalIds(principal)
  if (ids.length === 0) return null

  const chain = await fetchAncestorChain(db, folder.id)
  if (chain.length === 0) return null
  const rows = await db
    .select()
    .from(folderMembers)
    .where(and(inArray(folderMembers.folderId, chain), inArray(folderMembers.principalId, ids)))

  let role: Role | null = null
  for (const m of rows) {
    const direct = principal && m.principalType === principal.type && m.principalId === principal.id
    const viaOwner = userId !== null && m.principalType === 'user' && m.principalId === userId
    if (direct || viaOwner) role = maxRole(role, m.role)
  }
  return role
}

/**
 * The role a share token confers on a FOLDER: the token must be an unrevoked
 * folder link whose target is the folder itself or any ancestor (links
 * inherit down the tree exactly like grants — same rule computeDocRole
 * applies to docs). Anonymous callers are capped the way doc links cap them:
 * only a view-role link grants anything, and it grants `viewer`.
 */
export async function folderShareLinkRole(
  db: Db,
  folderId: string,
  principal: Principal | null,
  shareToken: string | null,
): Promise<Role | null> {
  if (!shareToken) return null
  const link = (await db.select().from(shareLinks).where(eq(shareLinks.token, shareToken)).limit(1))[0]
  if (!link || link.revokedAt !== null || link.targetType !== 'folder') return null
  const chain = await fetchAncestorChain(db, folderId)
  if (!chain.includes(link.targetId)) return null
  if (principal) return link.role
  return link.role === 'viewer' ? 'viewer' : null
}

/**
 * The role a share token confers on a single ASSET (per-file HTML sharing): the
 * token must be an unrevoked link with targetType==='asset' and targetId equal
 * to this asset's id — an asset link is point-scoped (it never inherits up to
 * the folder, and a token for asset A grants nothing on asset B). Anonymous
 * callers are capped exactly like doc/folder links: only a view-role link
 * grants anything, and it grants `viewer` (comment-and-above needs sign-in for
 * attribution, SPEC §4).
 */
export async function assetShareLinkRole(
  db: Db,
  assetId: string,
  principal: Principal | null,
  shareToken: string | null,
): Promise<Role | null> {
  if (!shareToken) return null
  const link = (await db.select().from(shareLinks).where(eq(shareLinks.token, shareToken)).limit(1))[0]
  if (!link || link.revokedAt !== null || link.targetType !== 'asset' || link.targetId !== assetId) return null
  if (principal) return link.role
  return link.role === 'viewer' ? 'viewer' : null
}

/**
 * The doc-id closure of `doc`'s VAULT: ids of every live doc in the same
 * vault subtree. Null when the doc has no derivable vault (folderless, or a
 * root chain that tops out at a pre-backfill plain folder) — callers treat
 * null as "no vault scoping applies".
 */
export async function sameVaultDocIds(db: Db, doc: Pick<DocRow, 'folderId'>): Promise<Set<string> | null> {
  if (doc.folderId === null) return null
  const chain = await fetchAncestorChain(db, doc.folderId)
  if (chain.length === 0) return null
  const rootId = chain[chain.length - 1]!
  const root = (await db.select().from(folders).where(eq(folders.id, rootId)).limit(1))[0]
  if (!root || root.kind !== 'vault') return null
  const subtree = await fetchFolderSubtrees(db, [root.id])
  const folderIds = subtree.map((f) => f.id)
  const rows = await db
    .select({ id: docs.id })
    .from(docs)
    .where(and(inArray(docs.folderId, folderIds), isNull(docs.deletedAt)))
  return new Set(rows.map((r) => r.id))
}

export function principalIds(principal: Principal | null): string[] {
  if (!principal) return []
  const ids = [principal.id]
  const userId = effectiveUserId(principal)
  if (userId !== null && userId !== principal.id) ids.push(userId)
  return ids
}

// ---------------------------------------------------------------------------
// Accessible-docs closure — shared by GET /api/docs (the canonical docs list)
// and the search surface (GET /api/search permission filter, GET
// /api/docs/:id/backlinks), so search can never leak a doc the docs list
// would not show.
// ---------------------------------------------------------------------------

/** The caller's folder grants as folderId → max granted role. */
export async function folderGrantMap(db: Db, principalIds: string[]): Promise<Map<string, Role>> {
  if (principalIds.length === 0) return new Map()
  const rows = await db.select().from(folderMembers).where(inArray(folderMembers.principalId, principalIds))
  const map = new Map<string, Role>()
  for (const row of rows) {
    map.set(row.folderId, maxRole(map.get(row.folderId) ?? null, row.role) ?? row.role)
  }
  return map
}

/**
 * Fetch the given folders plus all their descendants, one query per tree
 * level (bounded by MAX_FOLDER_DEPTH). Duplicate-safe when subtrees overlap.
 */
export async function fetchFolderSubtrees(db: Db, rootIds: string[]): Promise<(typeof folders.$inferSelect)[]> {
  if (rootIds.length === 0) return []
  const seen = new Set<string>()
  const rows: (typeof folders.$inferSelect)[] = []
  let frontier = await db.select().from(folders).where(inArray(folders.id, rootIds))
  for (let level = 0; level < MAX_FOLDER_DEPTH && frontier.length > 0; level++) {
    const fresh = frontier.filter((r) => !seen.has(r.id))
    if (fresh.length === 0) break
    for (const r of fresh) seen.add(r.id)
    rows.push(...fresh)
    frontier = await db
      .select()
      .from(folders)
      .where(
        inArray(
          folders.parentId,
          fresh.map((r) => r.id),
        ),
      )
  }
  return rows
}

/**
 * Every live doc the principal can access, with their effective role on each:
 * owned docs, direct doc memberships, and folder grants applied to the
 * granted folders' ENTIRE subtrees (SPEC §4). Null = principal cannot
 * exercise any user's access (agent with no owner).
 */
export async function accessibleDocs(
  db: Db,
  principal: Principal,
): Promise<Map<string, { doc: DocRow; role: Role }> | null> {
  const userId = effectiveUserId(principal)
  if (userId === null) return null
  const ids = userId === principal.id ? [principal.id] : [principal.id, userId]

  const byId = new Map<string, { doc: DocRow; role: Role }>()
  const add = (doc: DocRow, role: Role) => {
    if (doc.deletedAt !== null) return
    const existing = byId.get(doc.id)
    byId.set(doc.id, { doc, role: existing ? (maxRole(existing.role, role) ?? role) : role })
  }

  const owned = await db
    .select()
    .from(docs)
    .where(and(eq(docs.ownerUserId, userId), isNull(docs.deletedAt)))
  for (const doc of owned) add(doc, 'owner')

  const viaDoc = await db
    .select({ doc: docs, role: docMembers.role })
    .from(docMembers)
    .innerJoin(docs, eq(docMembers.docId, docs.id))
    .where(and(inArray(docMembers.principalId, ids), isNull(docs.deletedAt)))
  for (const row of viaDoc) add(row.doc, row.role)

  // Folder grants apply to the granted folder's ENTIRE subtree: materialize
  // the descendant closure of the user's folder grants (the granted trees are
  // small — bounded by MAX_FOLDER_DEPTH), then pull every live doc in it.
  const grantMap = await folderGrantMap(db, ids)
  if (grantMap.size > 0) {
    const treeRows = await fetchFolderSubtrees(db, [...grantMap.keys()])
    const effective = propagateFolderRoles(treeRows, grantMap)
    if (effective.size > 0) {
      const inFolders = await db
        .select()
        .from(docs)
        .where(and(inArray(docs.folderId, [...effective.keys()]), isNull(docs.deletedAt)))
      for (const doc of inFolders) {
        const role = doc.folderId !== null ? effective.get(doc.folderId) : undefined
        if (role) add(doc, role)
      }
    }
  }

  return byId
}
