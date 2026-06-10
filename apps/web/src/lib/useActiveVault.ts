import { useEffect, useMemo } from 'react'
import { useRouterState } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { listDocs, listFolders, type FolderInfo } from './api.ts'
import { getStoredVaultId, resolveActiveVault, setStoredVaultId, vaultIdForFolder } from './vaults.ts'

/**
 * The ACTIVE vault for the chrome (header switcher, quick-switcher scoping).
 * URL first so links stay shareable — viewing a folder (`/?folder=`) or a doc
 * (`/d/:id`) in vault X makes X active — then the persisted localStorage
 * choice, then the default-vault heuristic (lib/vaults.ts). Whatever resolves
 * is persisted so a bare `/` reopens the last vault.
 *
 * Null while the ['folders'] query loads (SSR included — no hydration
 * mismatch, localStorage is only consulted once data exists) and for users
 * with no vaults at all.
 */
export function useActiveVault(): FolderInfo | null {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const folderParam = useRouterState({
    select: (s) => {
      const folder = (s.location.search as Record<string, unknown>)['folder']
      return typeof folder === 'string' && folder !== '' ? folder : null
    },
  })
  const docId = useMemo(() => {
    const match = /^\/d\/([^/]+)/.exec(pathname)
    return match?.[1] ? decodeURIComponent(match[1]) : null
  }, [pathname])

  const foldersQuery = useQuery({ queryKey: ['folders'], queryFn: listFolders })
  // The doc lookup only matters on editor routes — don't fetch docs elsewhere.
  const docsQuery = useQuery({ queryKey: ['docs'], queryFn: listDocs, enabled: docId !== null })

  const vault = useMemo(() => {
    const folders = foldersQuery.data
    if (folders === undefined) return null
    const urlFolderId = docId !== null ? (docsQuery.data?.find((d) => d.id === docId)?.folderId ?? null) : folderParam
    if (urlFolderId !== null) {
      const vaultId = vaultIdForFolder(folders, urlFolderId)
      const fromUrl = vaultId !== null ? folders.find((f) => f.id === vaultId) : undefined
      if (fromUrl) return fromUrl
    }
    return resolveActiveVault(folders, getStoredVaultId())
  }, [foldersQuery.data, docsQuery.data, docId, folderParam])

  const vaultId = vault?.id ?? null
  useEffect(() => {
    if (vaultId !== null) setStoredVaultId(vaultId)
  }, [vaultId])

  return vault
}
