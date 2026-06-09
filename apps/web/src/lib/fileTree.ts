import type { AssetMeta, DocMeta } from '@glyphdown/protocol'
import type { FolderInfo } from './api.ts'

/**
 * Pure tree model for the slide-out file tree (Obsidian model: one tree where
 * every doc — and every folder — always exists). Folders nest under their
 * parentId; at every level child folders come first (alphabetical), then that
 * folder's docs (alphabetical). The root level is root folders followed by
 * folderless docs.
 *
 * Never-lose-a-node guarantees:
 * - Docs whose folderId points at a folder the viewer cannot see (e.g. a doc
 *   shared directly out of someone else's folder) surface at the root.
 * - Folders whose parentId points at an invisible folder (e.g. a folder
 *   shared into the viewer mid-tree) surface at the root too.
 * - Pathological parentId cycles (stale cache between concurrent moves —
 *   the server itself rejects them) are broken by promoting the cycle to the
 *   root rather than dropping it.
 */

export interface TreeFolderNode {
  kind: 'folder'
  folder: FolderInfo
  /** Nested subfolders, sorted alphabetically (case-insensitive). */
  children: TreeFolderNode[]
  /** Docs directly inside this folder, sorted alphabetically. */
  docs: DocMeta[]
}

export interface TreeDocNode {
  kind: 'doc'
  doc: DocMeta
}

export type TreeNode = TreeFolderNode | TreeDocNode

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' })

/** Alphabetical, case-insensitive, with the id as a deterministic tiebreak. */
const docOrder = (a: DocMeta, b: DocMeta) => byName(a.title, b.title) || a.id.localeCompare(b.id)
const folderOrder = (a: FolderInfo, b: FolderInfo) => byName(a.name, b.name) || a.id.localeCompare(b.id)

export function buildFileTree(docs: readonly DocMeta[], folders: readonly FolderInfo[]): TreeNode[] {
  const known = new Set(folders.map((f) => f.id))

  const docsByFolder = new Map<string, DocMeta[]>()
  const rootDocs: DocMeta[] = []
  for (const doc of docs) {
    if (doc.folderId !== null && known.has(doc.folderId)) {
      const list = docsByFolder.get(doc.folderId)
      if (list) list.push(doc)
      else docsByFolder.set(doc.folderId, [doc])
    } else {
      rootDocs.push(doc)
    }
  }

  // Folders with no parent — or an invisible one — are roots (orphan promotion).
  const childrenByParent = new Map<string, FolderInfo[]>()
  const rootFolders: FolderInfo[] = []
  for (const folder of folders) {
    if (folder.parentId !== null && known.has(folder.parentId)) {
      const list = childrenByParent.get(folder.parentId)
      if (list) list.push(folder)
      else childrenByParent.set(folder.parentId, [folder])
    } else {
      rootFolders.push(folder)
    }
  }

  // `placed` doubles as the cycle guard: a child already placed elsewhere is
  // skipped, so recursion always terminates.
  const placed = new Set<string>()
  const buildFolder = (folder: FolderInfo): TreeFolderNode => {
    placed.add(folder.id)
    const children = (childrenByParent.get(folder.id) ?? [])
      .filter((child) => !placed.has(child.id))
      .sort(folderOrder)
      .map(buildFolder)
    return { kind: 'folder', folder, children, docs: (docsByFolder.get(folder.id) ?? []).sort(docOrder) }
  }

  const nodes: TreeNode[] = rootFolders.sort(folderOrder).map(buildFolder)
  // Defensive: folders trapped in a parentId cycle are unreachable from any
  // root — promote one representative per cycle (in name order) so every
  // folder still appears exactly once.
  for (const folder of [...folders].sort(folderOrder)) {
    if (!placed.has(folder.id)) nodes.push(buildFolder(folder))
  }

  for (const doc of rootDocs.sort(docOrder)) nodes.push({ kind: 'doc', doc })
  return nodes
}

/**
 * Order for a folder's image-asset rows in the tree (rendered after the
 * folder's docs): alphabetical by filename, mirroring docOrder, with the id
 * as a deterministic tiebreak. Returns a new array — never mutates.
 */
export function sortAssets(assets: readonly AssetMeta[]): AssetMeta[] {
  return [...assets].sort((a, b) => byName(a.filename, b.filename) || a.id.localeCompare(b.id))
}

/**
 * Human-readable byte size for the asset viewer caption ("824 B", "1.4 KB",
 * "10 MB"). One decimal below 10, none at 10+ — compact, never wider than
 * five characters plus the unit.
 */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'] as const
  let value = Math.max(0, bytes)
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  const text = unit === 0 ? String(Math.round(value)) : value >= 10 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, '')
  return `${text} ${units[unit]}`
}

/**
 * The ids of `folderId` plus every (visible) descendant — exactly the set of
 * folders the server would reject as a move target for `folderId` with a 400
 * 'cycle'. Used for instant client-side drop-target validation; tolerant of
 * cycles in the input.
 */
export function folderWithDescendants(folders: readonly FolderInfo[], folderId: string): Set<string> {
  const childIds = new Map<string, string[]>()
  for (const folder of folders) {
    if (folder.parentId === null) continue
    const list = childIds.get(folder.parentId)
    if (list) list.push(folder.id)
    else childIds.set(folder.parentId, [folder.id])
  }
  const out = new Set<string>([folderId])
  const stack = [folderId]
  for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
    for (const child of childIds.get(id) ?? []) {
      if (!out.has(child)) {
        out.add(child)
        stack.push(child)
      }
    }
  }
  return out
}
