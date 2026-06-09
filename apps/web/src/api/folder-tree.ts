import { MAX_FOLDER_DEPTH, ROLES, type Role } from '@glyphdown/protocol'

/**
 * Pure helpers for the nested-folder tree (no I/O — unit-tested in
 * folder-tree.test.ts). The API layer fetches folder rows from D1 and feeds
 * them here for ancestor walks, cycle/depth validation on moves, descendant
 * closures for permission inheritance, and delete-promotion planning.
 *
 * Every walk is cycle-safe via a visited set even though the API never
 * persists a cycle — a corrupted row must degrade to a truncated chain, not
 * an infinite loop.
 */

export { MAX_FOLDER_DEPTH }

/** The minimal folder shape every helper needs. */
export interface FolderRef {
  id: string
  parentId: string | null
}

export function folderIndex<T extends FolderRef>(folders: Iterable<T>): Map<string, T> {
  const map = new Map<string, T>()
  for (const f of folders) map.set(f.id, f)
  return map
}

/**
 * Ancestor chain starting at `folderId` (inclusive) and walking to the root:
 * `[folderId, parent, grandparent, …]`. Unknown ids and cycles truncate the
 * chain. Empty array when folderId is null (doc at root) or unknown.
 */
export function ancestorChain(byId: Map<string, FolderRef>, folderId: string | null): string[] {
  const chain: string[] = []
  const seen = new Set<string>()
  let current = folderId
  while (current !== null && !seen.has(current)) {
    const folder = byId.get(current)
    if (!folder) break
    chain.push(current)
    seen.add(current)
    current = folder.parentId
  }
  return chain
}

/** Depth of a folder: a root folder has depth 1. 0 for unknown ids. */
export function folderDepth(byId: Map<string, FolderRef>, folderId: string): number {
  return ancestorChain(byId, folderId).length
}

/**
 * All folder ids in the subtree rooted at `rootId`, root included (root
 * first, then breadth-first descendants).
 */
export function subtreeFolderIds(folders: Iterable<FolderRef>, rootId: string): string[] {
  const children = new Map<string, string[]>()
  for (const f of folders) {
    if (f.parentId === null) continue
    const list = children.get(f.parentId) ?? []
    list.push(f.id)
    children.set(f.parentId, list)
  }
  const result: string[] = []
  const seen = new Set<string>([rootId])
  let frontier = [rootId]
  while (frontier.length > 0) {
    result.push(...frontier)
    const next: string[] = []
    for (const id of frontier) {
      for (const child of children.get(id) ?? []) {
        if (seen.has(child)) continue
        seen.add(child)
        next.push(child)
      }
    }
    frontier = next
  }
  return result
}

/** Height of the subtree rooted at `rootId`: 1 for a leaf folder. */
export function subtreeHeight(folders: Iterable<FolderRef>, rootId: string): number {
  const all = [...folders]
  const byId = folderIndex(all)
  const inSubtree = new Set(subtreeFolderIds(all, rootId))
  let height = 1
  for (const id of inSubtree) {
    // Depth of each subtree member relative to the root.
    let relative = 1
    let current = byId.get(id)
    const seen = new Set<string>()
    while (current && current.id !== rootId && !seen.has(current.id)) {
      seen.add(current.id)
      relative++
      current = current.parentId !== null ? byId.get(current.parentId) : undefined
    }
    if (relative > height) height = relative
  }
  return height
}

export type MoveValidation =
  | { ok: true }
  | { ok: false; reason: 'cycle' | 'too-deep' | 'parent-not-found' }

/**
 * Validate moving `folderId` under `newParentId` (null = to root):
 *  - CYCLE: the target must not be the folder itself or any of its
 *    descendants — checked by walking the target's ancestor chain and
 *    rejecting if it passes through the moved folder.
 *  - DEPTH: the moved subtree's height plus the target's depth must stay
 *    within MAX_FOLDER_DEPTH.
 */
export function validateMove(
  folders: Iterable<FolderRef>,
  folderId: string,
  newParentId: string | null,
): MoveValidation {
  const all = [...folders]
  const byId = folderIndex(all)
  const height = subtreeHeight(all, folderId)

  if (newParentId === null) {
    return height <= MAX_FOLDER_DEPTH ? { ok: true } : { ok: false, reason: 'too-deep' }
  }
  if (!byId.has(newParentId)) return { ok: false, reason: 'parent-not-found' }
  // Self or descendant target ⇒ the target's ancestor chain hits folderId.
  if (ancestorChain(byId, newParentId).includes(folderId)) return { ok: false, reason: 'cycle' }
  if (folderDepth(byId, newParentId) + height > MAX_FOLDER_DEPTH) return { ok: false, reason: 'too-deep' }
  return { ok: true }
}

function maxOf(a: Role | undefined, b: Role | undefined): Role | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return ROLES.indexOf(a) >= ROLES.indexOf(b) ? a : b
}

/**
 * Propagate folder grants down the tree: a grant on folder F applies to F and
 * every descendant; a folder's effective role is the max over its own grant
 * and everything inherited from ancestors. Returns the effective role for
 * every folder that ends up with one (the descendant closure of the granted
 * set). Folders whose parents are absent from `folders` are treated as roots.
 */
export function propagateFolderRoles(
  folders: Iterable<FolderRef>,
  grants: ReadonlyMap<string, Role>,
): Map<string, Role> {
  const all = [...folders]
  const byId = folderIndex(all)
  const effective = new Map<string, Role>()
  for (const folder of all) {
    // Max grant along this folder's ancestor chain (cycle-safe).
    let role: Role | undefined
    for (const id of ancestorChain(byId, folder.id)) role = maxOf(role, grants.get(id))
    if (role !== undefined) effective.set(folder.id, role)
  }
  // Granted folders not present in `folders` still count for themselves.
  for (const [id, role] of grants) {
    if (!byId.has(id)) effective.set(id, maxOf(effective.get(id), role)!)
  }
  return effective
}

/** The folder ids covered by a granted set: the grants plus all descendants. */
export function descendantClosure(folders: Iterable<FolderRef>, grantedIds: Iterable<string>): Set<string> {
  const all = [...folders]
  const closure = new Set<string>()
  for (const id of grantedIds) {
    closure.add(id)
    for (const sub of subtreeFolderIds(all, id)) closure.add(sub)
  }
  return closure
}

export interface DeletePlan {
  /** Where direct children (folders AND docs) are promoted: the deleted folder's parent, null = root. */
  promoteToParentId: string | null
  /** Direct child folders to re-parent. */
  childFolderIds: string[]
  /** Every folder in the deleted folder's subtree (deleted folder first) — the recheck fanout scope. */
  subtreeFolderIds: string[]
}

/**
 * Plan a folder delete: direct child folders (and the folder's docs, handled
 * by the caller with one UPDATE) promote to the deleted folder's parent;
 * deeper descendants keep their parents and simply re-root through the
 * promoted children.
 */
export function planFolderDelete(folders: Iterable<FolderRef>, folderId: string): DeletePlan | null {
  const all = [...folders]
  const target = all.find((f) => f.id === folderId)
  if (!target) return null
  return {
    promoteToParentId: target.parentId,
    childFolderIds: all.filter((f) => f.parentId === folderId).map((f) => f.id),
    subtreeFolderIds: subtreeFolderIds(all, folderId),
  }
}
