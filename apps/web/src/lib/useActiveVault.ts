import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { useRouterState } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { listDocs, listFolders, type FolderInfo } from './api.ts'
import { getStoredVaultId, resolveActiveVault, setStoredVaultId, vaultIdForFolder } from './vaults.ts'

/**
 * Explicit in-place switch (the sidebar footer switcher): the user picked a
 * vault WITHOUT navigating, so it must beat the URL-derived vault — otherwise
 * the open doc's vault would immediately reassert itself. The override lives
 * until the location changes (any navigation re-derives from the URL again,
 * keeping shared links shareable).
 */
let overrideId: string | null = null
const overrideListeners = new Set<() => void>()
const subscribeOverride = (listener: () => void) => {
  overrideListeners.add(listener)
  return () => void overrideListeners.delete(listener)
}
const getOverrideId = () => overrideId
const getServerOverrideId = () => null

/** Make `id` the active vault in place (no navigation) and persist it. */
export function overrideActiveVault(id: string): void {
  setStoredVaultId(id)
  if (overrideId === id) return
  overrideId = id
  overrideListeners.forEach((l) => l())
}

function clearVaultOverride(): void {
  if (overrideId === null) return
  overrideId = null
  overrideListeners.forEach((l) => l())
}

/**
 * The ACTIVE vault for the chrome (vault switcher, quick-switcher scoping).
 * An explicit in-place switch (overrideActiveVault, cleared on navigation)
 * first, then the URL so links stay shareable — viewing a folder
 * (`/?folder=`) or a doc (`/d/:id`) in vault X makes X active — then the
 * persisted localStorage choice, then the default-vault heuristic
 * (lib/vaults.ts). Whatever resolves is persisted so a bare `/` reopens the
 * last vault.
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

  // Any navigation invalidates an in-place override: the new URL decides.
  const override = useSyncExternalStore(subscribeOverride, getOverrideId, getServerOverrideId)
  const locKey = `${pathname}::${folderParam ?? ''}`
  const prevLocKey = useRef(locKey)
  useEffect(() => {
    if (prevLocKey.current === locKey) return
    prevLocKey.current = locKey
    clearVaultOverride()
  }, [locKey])

  const vault = useMemo(() => {
    const folders = foldersQuery.data
    if (folders === undefined) return null
    if (override !== null) {
      const chosen = folders.find((f) => f.id === override && f.kind === 'vault')
      if (chosen) return chosen
    }
    const urlFolderId = docId !== null ? (docsQuery.data?.find((d) => d.id === docId)?.folderId ?? null) : folderParam
    if (urlFolderId !== null) {
      const vaultId = vaultIdForFolder(folders, urlFolderId)
      const fromUrl = vaultId !== null ? folders.find((f) => f.id === vaultId) : undefined
      if (fromUrl) return fromUrl
    }
    return resolveActiveVault(folders, getStoredVaultId())
  }, [foldersQuery.data, docsQuery.data, docId, folderParam, override])

  const vaultId = vault?.id ?? null
  useEffect(() => {
    if (vaultId !== null) setStoredVaultId(vaultId)
  }, [vaultId])

  return vault
}
