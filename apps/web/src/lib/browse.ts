import type { DocMeta } from '@glyphdown/protocol'
import type { FolderInfo } from './api.ts'
import { buildFileTree, type TreeFolderNode, type TreeNode } from './fileTree.ts'

/**
 * Pure helpers for the home-page file browser (Drive model: one folder's
 * contents at a time, navigated via the `?folder=` search param).
 *
 * Listing reuses buildFileTree so the browser inherits its guarantees —
 * orphan docs/folders (parent invisible to the viewer) surface at the root,
 * parentId cycles are broken instead of dropped, and every group is sorted
 * alphabetically (folders first, then docs).
 */

export interface FolderListing {
  /** Direct subfolders, alphabetical. */
  folders: FolderInfo[]
  /** Docs directly inside, alphabetical. */
  docs: DocMeta[]
}

/**
 * Ancestor chain for the breadcrumb bar: topmost visible ancestor first, the
 * folder itself last. Built from parentId links; tolerant of bad data —
 * an unknown id returns [], a parentId pointing at an invisible folder ends
 * the chain there (the orphan is its own top), and parentId cycles terminate
 * via the seen-set instead of looping.
 */
export function breadcrumbChain(folders: readonly FolderInfo[], folderId: string): FolderInfo[] {
  const byId = new Map(folders.map((f) => [f.id, f]))
  const chain: FolderInfo[] = []
  const seen = new Set<string>()
  for (
    let cur = byId.get(folderId);
    cur !== undefined && !seen.has(cur.id);
    cur = cur.parentId === null ? undefined : byId.get(cur.parentId)
  ) {
    seen.add(cur.id)
    chain.unshift(cur)
  }
  return chain
}

const findNode = (nodes: readonly TreeNode[], folderId: string): TreeFolderNode | null => {
  for (const node of nodes) {
    if (node.kind !== 'folder') continue
    if (node.folder.id === folderId) return node
    const hit = findNode(node.children, folderId)
    if (hit) return hit
  }
  return null
}

/**
 * The contents of one folder (`folderId === null` = the root level). Returns
 * null when the folder is not visible to the viewer (deleted, revoked, or a
 * pasted/stale URL) so the browser can show a not-found state.
 */
export function folderListing(
  docs: readonly DocMeta[],
  folders: readonly FolderInfo[],
  folderId: string | null,
): FolderListing | null {
  const tree = buildFileTree(docs, folders)
  if (folderId === null) {
    return {
      folders: tree.flatMap((n) => (n.kind === 'folder' ? [n.folder] : [])),
      docs: tree.flatMap((n) => (n.kind === 'doc' ? [n.doc] : [])),
    }
  }
  const node = findNode(tree, folderId)
  return node === null ? null : { folders: node.children.map((c) => c.folder), docs: node.docs }
}

/**
 * The "Recent" strip at the root: the visible docs among `recentIds`
 * (most-recent-first, from lib/recents.ts), capped at `limit`.
 */
export function recentDocs(docs: readonly DocMeta[], recentIds: readonly string[], limit = 5): DocMeta[] {
  const byId = new Map(docs.map((d) => [d.id, d]))
  const out: DocMeta[] = []
  for (const id of recentIds) {
    const doc = byId.get(id)
    if (doc) out.push(doc)
    if (out.length >= limit) break
  }
  return out
}
