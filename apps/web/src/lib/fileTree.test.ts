import { describe, expect, it } from 'vitest'
import type { AssetMeta, DocMeta } from '@glyphdown/protocol'
import type { FolderInfo } from './api.ts'
import {
  buildFileTree,
  folderWithDescendants,
  formatBytes,
  sortAssets,
  type TreeFolderNode,
  type TreeNode,
} from './fileTree.ts'

const doc = (id: string, title: string, folderId: string | null = null): DocMeta => ({
  id,
  title,
  filename: `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`,
  folderId,
  ownerUserId: 'u1',
  role: 'owner',
  createdAt: 0,
  updatedAt: 0,
})

const folder = (id: string, name: string, parentId: string | null = null): FolderInfo => ({
  id,
  name,
  kind: parentId === null ? 'vault' : 'folder',
  parentId,
  ownerUserId: 'u1',
  role: 'owner',
  createdAt: 0,
})

/** Folder -> [name, childShapes, docTitles]; doc -> title. */
type Shaped = string | [string, Shaped[], string[]]
const shape = (nodes: TreeNode[]): Shaped[] =>
  nodes.map((n) =>
    n.kind === 'folder'
      ? [n.folder.name, shape(n.children), n.docs.map((d) => d.title)]
      : n.doc.title,
  )

const allFolderIds = (nodes: TreeNode[]): string[] =>
  nodes.flatMap((n) =>
    n.kind === 'folder' ? [n.folder.id, ...allFolderIds(n.children)] : [],
  )

const allDocIds = (nodes: TreeNode[]): string[] =>
  nodes.flatMap((n) => (n.kind === 'folder' ? allDocIds(n.children).concat(n.docs.map((d) => d.id)) : [n.doc.id]))

describe('buildFileTree', () => {
  it('returns an empty tree for empty inputs', () => {
    expect(buildFileTree([], [])).toEqual([])
  })

  it('sorts root folders alphabetically (case-insensitive), then root docs alphabetically', () => {
    const tree = buildFileTree(
      [doc('d1', 'zeta'), doc('d2', 'Alpha'), doc('d3', 'beta')],
      [folder('f1', 'work'), folder('f2', 'Archive'), folder('f3', 'notes')],
    )
    expect(shape(tree)).toEqual([
      ['Archive', [], []],
      ['notes', [], []],
      ['work', [], []],
      'Alpha',
      'beta',
      'zeta',
    ])
  })

  it('groups docs under their folder, alphabetically by title', () => {
    const tree = buildFileTree(
      [doc('d1', 'Charlie', 'f1'), doc('d2', 'alpha', 'f1'), doc('d3', 'Bravo', 'f1'), doc('d4', 'loose')],
      [folder('f1', 'Inbox')],
    )
    expect(shape(tree)).toEqual([['Inbox', [], ['alpha', 'Bravo', 'Charlie']], 'loose'])
  })

  it('keeps empty folders in the tree', () => {
    const tree = buildFileTree([], [folder('f1', 'Empty')])
    expect(shape(tree)).toEqual([['Empty', [], []]])
  })

  it('nests folders under their parentId, recursively', () => {
    const tree = buildFileTree(
      [doc('d1', 'leaf doc', 'f3'), doc('d2', 'mid doc', 'f2')],
      [folder('f1', 'Top'), folder('f2', 'Mid', 'f1'), folder('f3', 'Deep', 'f2')],
    )
    expect(shape(tree)).toEqual([['Top', [['Mid', [['Deep', [], ['leaf doc']]], ['mid doc']]], []]])
  })

  it('sorts child folders and docs alphabetically (case-insensitive) at every level', () => {
    const tree = buildFileTree(
      [doc('d1', 'zed', 'f1'), doc('d2', 'Apple', 'f1'), doc('d3', 'b', 'f3'), doc('d4', 'A', 'f3')],
      [
        folder('f1', 'Root'),
        folder('f2', 'zulu', 'f1'),
        folder('f3', 'Alpha', 'f1'),
        folder('f4', 'mike', 'f1'),
      ],
    )
    expect(shape(tree)).toEqual([
      [
        'Root',
        [
          ['Alpha', [], ['A', 'b']],
          ['mike', [], []],
          ['zulu', [], []],
        ],
        ['Apple', 'zed'],
      ],
    ])
  })

  it('keeps the root level ordered folders-first, then folderless docs', () => {
    const tree = buildFileTree(
      [doc('d1', 'aaa first alphabetically')],
      [folder('f1', 'zzz last alphabetically')],
    )
    expect(shape(tree)).toEqual([['zzz last alphabetically', [], []], 'aaa first alphabetically'])
  })

  it('surfaces docs pointing at an unknown (invisible) folder at the root', () => {
    // A doc shared directly with the viewer can live in a folder the viewer
    // cannot list — it must still exist somewhere in the tree.
    const tree = buildFileTree([doc('d1', 'Shared doc', 'someone-elses-folder')], [folder('f1', 'Mine')])
    expect(shape(tree)).toEqual([['Mine', [], []], 'Shared doc'])
  })

  it('promotes folders whose parentId points at an invisible folder to the root', () => {
    // A folder shared into the viewer mid-tree: its parent is not visible, so
    // it surfaces at the root (sorted among the other root folders), keeping
    // its own visible subtree intact.
    const tree = buildFileTree(
      [doc('d1', 'inside orphan', 'f2')],
      [folder('f1', 'Bravo'), folder('f2', 'Adopted', 'invisible-parent'), folder('f3', 'Child', 'f2')],
    )
    expect(shape(tree)).toEqual([
      ['Adopted', [['Child', [], []]], ['inside orphan']],
      ['Bravo', [], []],
    ])
  })

  it('never loses a folder, even on a pathological parentId cycle', () => {
    // The server rejects cycles, but a stale client cache between two
    // concurrent moves could briefly show one — promote it, never drop it.
    const tree = buildFileTree(
      [doc('d1', 'trapped', 'f2')],
      [folder('f1', 'One', 'f2'), folder('f2', 'Two', 'f1'), folder('f3', 'Normal')],
    )
    expect(allFolderIds(tree).sort()).toEqual(['f1', 'f2', 'f3'])
    expect(allDocIds(tree)).toEqual(['d1'])
  })

  it('places every doc exactly once across nesting levels', () => {
    const docs = [
      doc('d1', 'a', 'f1'),
      doc('d2', 'b', 'f2'),
      doc('d3', 'c', null),
      doc('d4', 'd', 'ghost'),
      doc('d5', 'e', 'f3'),
    ]
    const tree = buildFileTree(docs, [folder('f1', 'One'), folder('f2', 'Two', 'f1'), folder('f3', 'Three', 'f2')])
    expect(allDocIds(tree).sort()).toEqual(['d1', 'd2', 'd3', 'd4', 'd5'])
    expect(allFolderIds(tree).sort()).toEqual(['f1', 'f2', 'f3'])
  })

  it('breaks title ties deterministically by id', () => {
    const tree = buildFileTree([doc('d2', 'Same'), doc('d1', 'Same')], [])
    expect(tree.map((n) => (n.kind === 'doc' ? n.doc.id : ''))).toEqual(['d1', 'd2'])
  })

  it('breaks folder name ties deterministically by id', () => {
    const tree = buildFileTree([], [folder('f2', 'Same'), folder('f1', 'Same')])
    expect(tree.map((n) => (n.kind === 'folder' ? n.folder.id : ''))).toEqual(['f1', 'f2'])
  })

  it('does not mutate its inputs', () => {
    const docs = [doc('d2', 'b'), doc('d1', 'a')]
    const folders = [folder('f2', 'B'), folder('f1', 'A', 'f2')]
    buildFileTree(docs, folders)
    expect(docs.map((d) => d.id)).toEqual(['d2', 'd1'])
    expect(folders.map((f) => f.id)).toEqual(['f2', 'f1'])
  })

  it('exposes children/docs on every nested node', () => {
    const tree = buildFileTree([], [folder('f1', 'Top'), folder('f2', 'Kid', 'f1')])
    const top = tree[0] as TreeFolderNode
    expect(top.children).toHaveLength(1)
    expect(top.children[0]?.folder.id).toBe('f2')
    expect(top.children[0]?.children).toEqual([])
    expect(top.children[0]?.docs).toEqual([])
  })
})

describe('folderWithDescendants', () => {
  const forest = [
    folder('f1', 'Top'),
    folder('f2', 'Mid', 'f1'),
    folder('f3', 'Deep', 'f2'),
    folder('f4', 'Sibling', 'f1'),
    folder('f5', 'Other root'),
    folder('f6', 'Other child', 'f5'),
  ]

  it('returns the folder itself plus every transitive descendant', () => {
    expect([...folderWithDescendants(forest, 'f1')].sort()).toEqual(['f1', 'f2', 'f3', 'f4'])
    expect([...folderWithDescendants(forest, 'f2')].sort()).toEqual(['f2', 'f3'])
  })

  it('returns only the folder itself for a leaf', () => {
    expect([...folderWithDescendants(forest, 'f3')]).toEqual(['f3'])
  })

  it('does not include unrelated trees', () => {
    expect(folderWithDescendants(forest, 'f1').has('f5')).toBe(false)
    expect(folderWithDescendants(forest, 'f1').has('f6')).toBe(false)
  })

  it('terminates on a parentId cycle', () => {
    const cyclic = [folder('a', 'A', 'b'), folder('b', 'B', 'a')]
    expect([...folderWithDescendants(cyclic, 'a')].sort()).toEqual(['a', 'b'])
  })
})

const asset = (id: string, filename: string): AssetMeta => ({
  id,
  filename,
  contentType: 'image/png',
  size: 1,
  etag: 'e',
  createdBy: 'u1',
  createdAt: 0,
})

describe('sortAssets', () => {
  it('orders alphabetically by filename, case-insensitive', () => {
    const sorted = sortAssets([asset('a1', 'zebra.png'), asset('a2', 'Apple.png'), asset('a3', 'mango.jpg')])
    expect(sorted.map((a) => a.filename)).toEqual(['Apple.png', 'mango.jpg', 'zebra.png'])
  })

  it('breaks filename ties deterministically by id', () => {
    const sorted = sortAssets([asset('b', 'pic.png'), asset('a', 'pic.png')])
    expect(sorted.map((a) => a.id)).toEqual(['a', 'b'])
  })

  it('returns a new array without mutating the input', () => {
    const input = [asset('a2', 'b.png'), asset('a1', 'a.png')]
    const sorted = sortAssets(input)
    expect(sorted).not.toBe(input)
    expect(input.map((a) => a.id)).toEqual(['a2', 'a1'])
  })

  it('handles empty input', () => {
    expect(sortAssets([])).toEqual([])
  })
})

describe('formatBytes', () => {
  it('formats bytes below 1 KB as B', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(824)).toBe('824 B')
    expect(formatBytes(1023)).toBe('1023 B')
  })

  it('formats KB with one decimal below 10, none at 10+', () => {
    expect(formatBytes(1024)).toBe('1 KB')
    expect(formatBytes(1434)).toBe('1.4 KB')
    expect(formatBytes(10 * 1024)).toBe('10 KB')
    expect(formatBytes(500 * 1024)).toBe('500 KB')
  })

  it('formats MB and GB', () => {
    expect(formatBytes(1024 * 1024)).toBe('1 MB')
    expect(formatBytes(2.5 * 1024 * 1024)).toBe('2.5 MB')
    expect(formatBytes(10 * 1024 * 1024)).toBe('10 MB')
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3 GB')
  })

  it('clamps negatives to zero', () => {
    expect(formatBytes(-5)).toBe('0 B')
  })
})
