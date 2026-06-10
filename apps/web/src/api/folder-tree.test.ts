import { describe, expect, it } from 'vitest'
import type { Role } from '@glyphdown/protocol'
import {
  MAX_FOLDER_DEPTH,
  ancestorChain,
  descendantClosure,
  folderDepth,
  folderIndex,
  planFolderDelete,
  propagateFolderRoles,
  subtreeFolderIds,
  subtreeHeight,
  validateMove,
  type FolderRef,
} from './folder-tree.ts'

/**
 * Fixture tree:
 *   A ─ B ─ C
 *   │   └── C2
 *   └─ B2
 *   X (separate root)
 */
const tree: FolderRef[] = [
  { id: 'A', parentId: null },
  { id: 'B', parentId: 'A' },
  { id: 'C', parentId: 'B' },
  { id: 'C2', parentId: 'B' },
  { id: 'B2', parentId: 'A' },
  { id: 'X', parentId: null },
]

/** A linear chain f1 -> f2 -> … -> fN (f1 is the root). */
function chainOf(n: number, prefix = 'f'): FolderRef[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i + 1}`,
    parentId: i === 0 ? null : `${prefix}${i}`,
  }))
}

describe('ancestorChain / folderDepth', () => {
  const byId = folderIndex(tree)

  it('walks nearest-first up to the root, inclusive', () => {
    expect(ancestorChain(byId, 'C')).toEqual(['C', 'B', 'A'])
    expect(ancestorChain(byId, 'A')).toEqual(['A'])
    expect(ancestorChain(byId, null)).toEqual([])
    expect(ancestorChain(byId, 'missing')).toEqual([])
  })

  it('computes depth (root = 1)', () => {
    expect(folderDepth(byId, 'A')).toBe(1)
    expect(folderDepth(byId, 'B')).toBe(2)
    expect(folderDepth(byId, 'C')).toBe(3)
    expect(folderDepth(byId, 'missing')).toBe(0)
  })

  it('survives a corrupted cycle by truncating', () => {
    const cyclic = folderIndex([
      { id: 'p', parentId: 'q' },
      { id: 'q', parentId: 'p' },
    ])
    expect(ancestorChain(cyclic, 'p')).toEqual(['p', 'q'])
  })
})

describe('subtreeFolderIds / subtreeHeight', () => {
  it('collects the root plus all descendants', () => {
    expect(new Set(subtreeFolderIds(tree, 'A'))).toEqual(new Set(['A', 'B', 'B2', 'C', 'C2']))
    expect(subtreeFolderIds(tree, 'B')).toEqual(expect.arrayContaining(['B', 'C', 'C2']))
    expect(subtreeFolderIds(tree, 'C')).toEqual(['C'])
    expect(subtreeFolderIds(tree, 'X')).toEqual(['X'])
  })

  it('computes subtree height (leaf = 1)', () => {
    expect(subtreeHeight(tree, 'A')).toBe(3)
    expect(subtreeHeight(tree, 'B')).toBe(2)
    expect(subtreeHeight(tree, 'C')).toBe(1)
    expect(subtreeHeight(tree, 'X')).toBe(1)
  })
})

describe('validateMove — cycle guard', () => {
  it('rejects moving a folder under itself', () => {
    expect(validateMove(tree, 'B', 'B')).toEqual({ ok: false, reason: 'cycle' })
  })

  it('rejects moving a folder under its direct child', () => {
    expect(validateMove(tree, 'B', 'C')).toEqual({ ok: false, reason: 'cycle' })
  })

  it('rejects moving a folder under a deep descendant', () => {
    expect(validateMove(tree, 'A', 'C')).toEqual({ ok: false, reason: 'cycle' })
  })

  it('allows moving under a sibling', () => {
    expect(validateMove(tree, 'C', 'C2')).toEqual({ ok: true })
    expect(validateMove(tree, 'B2', 'B')).toEqual({ ok: true })
  })

  it('allows moving to another root and to the root level', () => {
    expect(validateMove(tree, 'B', 'X')).toEqual({ ok: true })
    expect(validateMove(tree, 'B', null)).toEqual({ ok: true })
  })

  it('rejects an unknown target parent', () => {
    expect(validateMove(tree, 'B', 'nope')).toEqual({ ok: false, reason: 'parent-not-found' })
  })
})

describe('validateMove — depth cap', () => {
  it(`allows a chain of exactly ${MAX_FOLDER_DEPTH}`, () => {
    const chain = chainOf(MAX_FOLDER_DEPTH - 1)
    const loose: FolderRef[] = [...chain, { id: 'solo', parentId: null }]
    // moving solo under the deepest folder -> depth 10 exactly
    expect(validateMove(loose, 'solo', `f${MAX_FOLDER_DEPTH - 1}`)).toEqual({ ok: true })
  })

  it('rejects when target depth + subtree height exceeds the cap', () => {
    const chain = chainOf(MAX_FOLDER_DEPTH)
    const loose: FolderRef[] = [...chain, { id: 'solo', parentId: null }]
    expect(validateMove(loose, 'solo', `f${MAX_FOLDER_DEPTH}`)).toEqual({ ok: false, reason: 'too-deep' })
  })

  it('counts the moved SUBTREE height, not just the folder', () => {
    // sub1 -> sub2 -> sub3 (height 3), target at depth MAX-2: (MAX-2) + 3 > MAX.
    const chain = chainOf(MAX_FOLDER_DEPTH - 2)
    const sub = chainOf(3, 'sub')
    expect(validateMove([...chain, ...sub], 'sub1', `f${MAX_FOLDER_DEPTH - 2}`)).toEqual({
      ok: false,
      reason: 'too-deep',
    })
    // One level higher it fits exactly: (MAX-3) + 3 = MAX.
    expect(validateMove([...chain, ...sub], 'sub1', `f${MAX_FOLDER_DEPTH - 3}`)).toEqual({ ok: true })
  })
})

describe('descendantClosure / propagateFolderRoles', () => {
  it('closes over grants and all their descendants', () => {
    expect(descendantClosure(tree, ['B'])).toEqual(new Set(['B', 'C', 'C2']))
    expect(descendantClosure(tree, ['B', 'X'])).toEqual(new Set(['B', 'C', 'C2', 'X']))
    expect(descendantClosure(tree, [])).toEqual(new Set())
  })

  it('propagates a grant down the subtree', () => {
    const grants = new Map<string, Role>([['B', 'editor']])
    const roles = propagateFolderRoles(tree, grants)
    expect(roles.get('B')).toBe('editor')
    expect(roles.get('C')).toBe('editor')
    expect(roles.get('C2')).toBe('editor')
    expect(roles.has('A')).toBe(false)
    expect(roles.has('B2')).toBe(false)
    expect(roles.has('X')).toBe(false)
  })

  it('takes the max when grants stack along a path', () => {
    const grants = new Map<string, Role>([
      ['A', 'editor'],
      ['B', 'viewer'],
    ])
    const roles = propagateFolderRoles(tree, grants)
    expect(roles.get('A')).toBe('editor')
    expect(roles.get('B')).toBe('editor') // ancestor grant outranks
    expect(roles.get('C')).toBe('editor')
    const flipped = propagateFolderRoles(
      tree,
      new Map<string, Role>([
        ['A', 'viewer'],
        ['B', 'editor'],
      ]),
    )
    expect(flipped.get('B2')).toBe('viewer') // only the A grant reaches B2
    expect(flipped.get('C')).toBe('editor') // the deeper, stronger grant wins under B
  })

  it('keeps grants on folders missing from the fetched set', () => {
    const roles = propagateFolderRoles(tree, new Map<string, Role>([['ghost', 'viewer']]))
    expect(roles.get('ghost')).toBe('viewer')
  })
})

describe('planFolderDelete', () => {
  it('promotes direct children to the deleted folder parent and scopes the fanout to the subtree', () => {
    const plan = planFolderDelete(tree, 'B')
    expect(plan).not.toBeNull()
    expect(plan!.promoteToParentId).toBe('A')
    expect(new Set(plan!.childFolderIds)).toEqual(new Set(['C', 'C2']))
    expect(new Set(plan!.subtreeFolderIds)).toEqual(new Set(['B', 'C', 'C2']))
  })

  it('promotes to root when deleting a root folder', () => {
    const plan = planFolderDelete(tree, 'A')
    expect(plan!.promoteToParentId).toBeNull()
    expect(new Set(plan!.childFolderIds)).toEqual(new Set(['B', 'B2']))
    expect(new Set(plan!.subtreeFolderIds)).toEqual(new Set(['A', 'B', 'B2', 'C', 'C2']))
  })

  it('handles leaves and unknown folders', () => {
    const plan = planFolderDelete(tree, 'C')
    expect(plan!.promoteToParentId).toBe('B')
    expect(plan!.childFolderIds).toEqual([])
    expect(plan!.subtreeFolderIds).toEqual(['C'])
    expect(planFolderDelete(tree, 'missing')).toBeNull()
  })
})
