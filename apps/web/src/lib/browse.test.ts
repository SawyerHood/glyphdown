import { describe, expect, it } from 'vitest'
import type { DocMeta } from '@glyphdown/protocol'
import type { FolderInfo } from './api.ts'
import { breadcrumbChain, folderListing, recentDocs } from './browse.ts'

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

describe('breadcrumbChain', () => {
  it('returns [] for an unknown folder id', () => {
    expect(breadcrumbChain([folder('f1', 'a')], 'nope')).toEqual([])
  })

  it('returns just the folder for a root folder', () => {
    const f = folder('f1', 'a')
    expect(breadcrumbChain([f], 'f1')).toEqual([f])
  })

  it('walks parentId links, topmost ancestor first', () => {
    const a = folder('f1', 'a')
    const b = folder('f2', 'b', 'f1')
    const c = folder('f3', 'c', 'f2')
    expect(breadcrumbChain([c, a, b], 'f3').map((f) => f.id)).toEqual(['f1', 'f2', 'f3'])
  })

  it('ends the chain at an orphan (parentId pointing at an invisible folder)', () => {
    const b = folder('f2', 'b', 'invisible')
    const c = folder('f3', 'c', 'f2')
    expect(breadcrumbChain([b, c], 'f3').map((f) => f.id)).toEqual(['f2', 'f3'])
  })

  it('terminates on parentId cycles with the target last', () => {
    const a = folder('f1', 'a', 'f2')
    const b = folder('f2', 'b', 'f1')
    expect(breadcrumbChain([a, b], 'f1').map((f) => f.id)).toEqual(['f2', 'f1'])
  })
})

describe('folderListing', () => {
  it('lists the root: folders alphabetical, then docs alphabetical', () => {
    const listing = folderListing(
      [doc('d1', 'zeta'), doc('d2', 'Alpha'), doc('d3', 'in-folder', 'f1')],
      [folder('f1', 'work'), folder('f2', 'Archive')],
      null,
    )
    expect(listing).not.toBeNull()
    expect(listing!.folders.map((f) => f.name)).toEqual(['Archive', 'work'])
    expect(listing!.docs.map((d) => d.title)).toEqual(['Alpha', 'zeta'])
  })

  it('lists one folder: its subfolders and docs only, sorted', () => {
    const listing = folderListing(
      [doc('d1', 'Charlie', 'f1'), doc('d2', 'alpha', 'f1'), doc('d3', 'elsewhere', 'f2'), doc('d4', 'loose')],
      [folder('f1', 'Inbox'), folder('f2', 'Other'), folder('f3', 'zub', 'f1'), folder('f4', 'Asub', 'f1')],
      'f1',
    )
    expect(listing!.folders.map((f) => f.name)).toEqual(['Asub', 'zub'])
    expect(listing!.docs.map((d) => d.title)).toEqual(['alpha', 'Charlie'])
  })

  it('lists nested folders (the deep-create case)', () => {
    const listing = folderListing(
      [doc('d1', 'deep-doc', 'f3')],
      [folder('f1', 'projects'), folder('f2', 'deep', 'f1'), folder('f3', 'deeper', 'f2')],
      'f3',
    )
    expect(listing!.folders).toEqual([])
    expect(listing!.docs.map((d) => d.title)).toEqual(['deep-doc'])
  })

  it('returns null for a folder the viewer cannot see', () => {
    expect(folderListing([], [folder('f1', 'a')], 'gone')).toBeNull()
  })

  it('promotes orphans to the root listing (invisible parents)', () => {
    const listing = folderListing(
      [doc('d1', 'shared-doc', 'invisible-folder')],
      [folder('f1', 'shared-folder', 'invisible-parent')],
      null,
    )
    expect(listing!.folders.map((f) => f.id)).toEqual(['f1'])
    expect(listing!.docs.map((d) => d.id)).toEqual(['d1'])
  })

  it('keeps empty folders listable', () => {
    const listing = folderListing([], [folder('f1', 'Empty')], 'f1')
    expect(listing).toEqual({ folders: [], docs: [] })
  })
})

describe('recentDocs', () => {
  const all = [doc('d1', 'one'), doc('d2', 'two'), doc('d3', 'three')]

  it('keeps recency order and drops unknown ids', () => {
    expect(recentDocs(all, ['d3', 'gone', 'd1']).map((d) => d.id)).toEqual(['d3', 'd1'])
  })

  it('caps at the limit', () => {
    expect(recentDocs(all, ['d1', 'd2', 'd3'], 2).map((d) => d.id)).toEqual(['d1', 'd2'])
  })

  it('returns [] when nothing was visited', () => {
    expect(recentDocs(all, [])).toEqual([])
  })
})
