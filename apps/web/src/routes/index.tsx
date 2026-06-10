import { useEffect } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import FileBrowser from '../components/browser/FileBrowser.tsx'
import Landing from '../components/landing/Landing.tsx'
import WelcomeNux from '../components/WelcomeNux.tsx'
import { listFolders } from '../lib/api.ts'
import { getStoredVaultId, resolveActiveVault, setStoredVaultId, vaultIdForFolder } from '../lib/vaults.ts'

/**
 * `/` is the file browser for signed-in users and the public landing page for
 * everyone else (the root guard lets signed-out visitors through here only).
 *
 * The browser navigates folders via the validated `?folder=<id>` search param
 * and is ROOTED AT THE ACTIVE VAULT: a bare `/` resolves the active vault
 * (last used via localStorage, else the default-vault heuristic — for members
 * with no owned vaults, their first shared vault) and redirects to its
 * listing, so the URL always names the folder and stays shareable. Visiting a
 * folder also records its vault as active. Accounts with no vault yet (never
 * created anything) keep the legacy empty root view — the first doc mints the
 * `Home` vault server-side.
 */
export const Route = createFileRoute('/')({
  validateSearch: (search: Record<string, unknown>): { folder?: string } =>
    typeof search['folder'] === 'string' && search['folder'] !== '' ? { folder: search['folder'] } : {},
  component: Home,
})

function Home() {
  const { session } = Route.useRouteContext()
  const { folder } = Route.useSearch()
  if (!session) return <Landing />
  return (
    <>
      <VaultRootedBrowser folderId={folder ?? null} />
      <WelcomeNux userId={session.user.id} />
    </>
  )
}

function VaultRootedBrowser({ folderId }: { folderId: string | null }) {
  const navigate = Route.useNavigate()
  const foldersQuery = useQuery({ queryKey: ['folders'], queryFn: listFolders })
  const folders = foldersQuery.data

  // Bare `/`: the active vault (when one exists) is where the browser roots.
  const activeVault = folderId === null && folders !== undefined ? resolveActiveVault(folders, getStoredVaultId()) : null

  // Keep the URL canonical (`/?folder=<vaultId>`) so it can be shared/bookmarked.
  const activeVaultId = activeVault?.id ?? null
  useEffect(() => {
    if (activeVaultId !== null) void navigate({ search: { folder: activeVaultId }, replace: true })
  }, [activeVaultId, navigate])

  // Remember the vault the URL lands in — bare `/` reopens it next time.
  useEffect(() => {
    if (folderId === null || folders === undefined) return
    const vaultId = vaultIdForFolder(folders, folderId)
    if (vaultId !== null) setStoredVaultId(vaultId)
  }, [folderId, folders])

  // Render the vault listing immediately (the redirect just rewrites the URL)
  // — no flash of the root level on the way in.
  return <FileBrowser folderId={folderId ?? activeVaultId} />
}
