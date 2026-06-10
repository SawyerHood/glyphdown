import { describe, expect, it } from 'vitest'
import type { Role } from '@glyphdown/protocol'
import type { FolderInfo } from './api.ts'
import { docVaultId, listVaults, pickDefaultVault, resolveActiveVault, vaultIdForFolder } from './vaults.ts'

function folder(
  id: string,
  opts: { kind?: 'folder' | 'vault'; parentId?: string | null; role?: Role; name?: string; createdAt?: number } = {},
): FolderInfo {
  return {
    id,
    name: opts.name ?? id,
    kind: opts.kind ?? 'folder',
    parentId: opts.parentId ?? null,
    ownerUserId: 'alice',
    role: opts.role ?? 'owner',
    createdAt: opts.createdAt ?? 1,
  }
}

const vault = (id: string, opts: Parameters<typeof folder>[1] = {}) => folder(id, { ...opts, kind: 'vault' })

describe('listVaults', () => {
  it('owned vaults first, then shared, each alphabetical; plain folders excluded', () => {
    const folders = [
      vault('v-z', { name: 'Zebra' }),
      vault('v-a', { name: 'alpha' }),
      vault('v-shared', { name: 'Beta', role: 'viewer' }),
      folder('f1', { parentId: 'v-a' }),
    ]
    expect(listVaults(folders).map((v) => v.id)).toEqual(['v-a', 'v-z', 'v-shared'])
  })
})

describe('vaultIdForFolder / docVaultId', () => {
  const folders = [
    vault('v1'),
    folder('f1', { parentId: 'v1' }),
    folder('f2', { parentId: 'f1' }),
    folder('orphan', { parentId: 'missing' }),
    folder('loop-a', { parentId: 'loop-b' }),
    folder('loop-b', { parentId: 'loop-a' }),
  ]

  it('walks the parent chain to the vault root', () => {
    expect(vaultIdForFolder(folders, 'f2')).toBe('v1')
    expect(vaultIdForFolder(folders, 'v1')).toBe('v1')
  })

  it('returns null for unknown folders, orphaned chains, and cycles', () => {
    expect(vaultIdForFolder(folders, 'nope')).toBeNull()
    expect(vaultIdForFolder(folders, 'orphan')).toBeNull()
    expect(vaultIdForFolder(folders, 'loop-a')).toBeNull()
  })

  it('docVaultId maps a doc through its folder (null for folderless)', () => {
    expect(docVaultId({ folderId: 'f1' }, folders)).toBe('v1')
    expect(docVaultId({ folderId: null }, folders)).toBeNull()
  })
})

describe('pickDefaultVault / resolveActiveVault', () => {
  it('prefers the owned vault named Home (case-insensitive), else the oldest owned', () => {
    const withHome = [vault('v-old', { createdAt: 1 }), vault('v-home', { name: 'home', createdAt: 9 })]
    expect(pickDefaultVault(withHome)?.id).toBe('v-home')
    const noHome = [vault('v-b', { createdAt: 2 }), vault('v-a', { createdAt: 1 })]
    expect(pickDefaultVault(noHome)?.id).toBe('v-a')
  })

  it('falls back to the oldest shared vault for a member with no owned vaults', () => {
    const shared = [
      vault('v-s2', { role: 'editor', createdAt: 5 }),
      vault('v-s1', { role: 'viewer', createdAt: 2 }),
    ]
    expect(pickDefaultVault(shared)?.id).toBe('v-s1')
    expect(pickDefaultVault([folder('f1')])).toBeNull()
  })

  it('resolveActiveVault honors a still-visible stored id, else falls back', () => {
    const folders = [vault('v-home', { name: 'Home' }), vault('v-work', { name: 'Work' })]
    expect(resolveActiveVault(folders, 'v-work')?.id).toBe('v-work')
    expect(resolveActiveVault(folders, 'v-gone')?.id).toBe('v-home')
    expect(resolveActiveVault(folders, null)?.id).toBe('v-home')
    // A stored id pointing at a plain folder never activates.
    expect(resolveActiveVault([...folders, folder('f1', { parentId: 'v-home' })], 'f1')?.id).toBe('v-home')
  })
})
