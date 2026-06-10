import { useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronDown, FolderRoot, Plus, Trash2, UserPlus } from 'lucide-react'
import { ApiError, createVault, deleteVault, listFolders, type FolderInfo } from '../lib/api.ts'
import { listVaults, pickDefaultVault, setStoredVaultId } from '../lib/vaults.ts'
import { overrideActiveVault, useActiveVault } from '../lib/useActiveVault.ts'
import { useDismissable } from '../lib/useDismissable.ts'
import { track } from '../lib/analytics.ts'
import { Badge, Button, Dialog, Input } from './ui.tsx'
import VaultShareDialog from './VaultShareDialog.tsx'

/**
 * The vault switcher: the active vault's name opens a dropdown listing every
 * vault the user can see — owned first, shared with a role badge — plus
 * inline "New vault" creation and, for an owned active vault, the share and
 * delete flows.
 *
 * Two placements share all of that:
 * - `heading` — the file browser's breadcrumb ROOT (the vault crumb itself is
 *   the trigger). Switching navigates to the picked vault's listing
 *   (`/?folder=<vaultId>`) and persists the choice (lib/vaults.ts); the
 *   active vault follows the URL (lib/useActiveVault.ts) so shared links
 *   select the vault they live in.
 * - `sidebar` — pinned at the BOTTOM of the editor's file-tree panel, where
 *   there is no file browser. The dropdown opens UPWARD, and switching does
 *   NOT navigate away from the open doc: it changes the active vault in
 *   place (overrideActiveVault) so Cmd+K scoping, the `/` redirect and new
 *   docs follow the choice.
 *
 * Hidden until a vault exists (brand-new accounts get `Home` on signup or
 * with their first doc).
 */
export default function VaultSwitcher({ variant }: { variant: 'heading' | 'sidebar' }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [deleting, setDeleting] = useState<FolderInfo | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  useDismissable(open, ref, () => {
    setOpen(false)
    setCreating(false)
  })

  const foldersQuery = useQuery({ queryKey: ['folders'], queryFn: listFolders })
  const vaults = listVaults(foldersQuery.data ?? [])
  const active = useActiveVault()
  if (vaults.length === 0 || active === null) return null

  const close = () => {
    setOpen(false)
    setCreating(false)
  }
  const switchTo = (vault: FolderInfo) => {
    close()
    if (variant === 'sidebar') {
      // Stay on the open doc — just change which vault is "active".
      overrideActiveVault(vault.id)
      return
    }
    setStoredVaultId(vault.id)
    void navigate({ to: '/', search: { folder: vault.id } })
  }

  return (
    <div ref={ref} className={variant === 'sidebar' ? 'relative shrink-0 border-t border-[var(--line)] p-2' : 'relative min-w-0'}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={`Vault: ${active.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        className={
          variant === 'sidebar'
            ? `flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[13px] font-medium transition hover:bg-[var(--paper-soft)] ${
                open ? 'bg-[var(--paper-soft)] text-[var(--ink)]' : 'text-[var(--ink)]'
              }`
            : `flex min-w-0 max-w-72 items-center gap-1.5 rounded-md px-2 py-1 text-sm font-semibold text-[var(--ink)] transition hover:bg-[var(--paper-soft)] ${
                open ? 'bg-[var(--paper-soft)]' : ''
              }`
        }
      >
        <FolderRoot size={14} className="shrink-0 text-[var(--accent)]" />
        <span className={variant === 'sidebar' ? 'min-w-0 flex-1 truncate' : 'truncate'}>{active.name}</span>
        <ChevronDown size={13} className="shrink-0 text-[var(--ink-faint)]" />
      </button>

      {open ? (
        <div
          role="menu"
          className={`absolute left-0 z-50 w-60 rounded-lg border border-[var(--line)] bg-[var(--paper)] p-1 shadow-lg ${
            // Sidebar footer: open upward so the menu stays on-screen.
            variant === 'sidebar' ? 'bottom-full mb-1 ml-1' : 'top-full mt-1'
          }`}
        >
          <p className="island-kicker m-0 px-2 pb-1 pt-1.5">Vaults</p>
          {vaults.map((vault) => (
            <button
              key={vault.id}
              type="button"
              role="menuitem"
              onClick={() => switchTo(vault)}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-[var(--ink)] hover:bg-[var(--paper-soft)]"
            >
              <FolderRoot size={13} className="shrink-0 text-[var(--ink-faint)]" />
              <span className="min-w-0 flex-1 truncate">{vault.name}</span>
              {vault.role !== 'owner' ? <Badge tone="blue">{vault.role}</Badge> : null}
              {vault.id === active.id ? <Check size={13} className="shrink-0 text-[var(--accent)]" /> : null}
            </button>
          ))}

          <div className="mx-1 my-1 border-t border-[var(--line)]" />
          {creating ? (
            <NewVaultRow
              takenNames={vaults.map((v) => v.name)}
              onCreated={(vault) => {
                void queryClient.invalidateQueries({ queryKey: ['folders'] })
                switchTo(vault)
              }}
              onCancel={() => setCreating(false)}
            />
          ) : (
            <button
              type="button"
              role="menuitem"
              onClick={() => setCreating(true)}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-[var(--ink)] hover:bg-[var(--paper-soft)]"
            >
              <Plus size={13} className="shrink-0 text-[var(--ink-faint)]" />
              New vault
            </button>
          )}

          {active.role === 'owner' ? (
            <>
              <div className="mx-1 my-1 border-t border-[var(--line)]" />
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  close()
                  setSharing(true)
                }}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-[var(--ink)] hover:bg-[var(--paper-soft)]"
              >
                <UserPlus size={13} className="shrink-0 text-[var(--ink-faint)]" />
                Share “{active.name}”…
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  close()
                  setDeleting(active)
                }}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950"
              >
                <Trash2 size={13} className="shrink-0" />
                Delete “{active.name}”…
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      <VaultShareDialog vault={active} open={sharing} onClose={() => setSharing(false)} />
      {deleting ? (
        <DeleteVaultDialog
          vault={deleting}
          fallback={pickDefaultVault((foldersQuery.data ?? []).filter((f) => f.id !== deleting.id))}
          onClose={() => setDeleting(null)}
        />
      ) : null}
    </div>
  )
}

/** Inline create row (the file tree's inline-input pattern, menu-sized). */
function NewVaultRow({
  takenNames,
  onCreated,
  onCancel,
}: {
  takenNames: readonly string[]
  onCreated: (vault: FolderInfo) => void
  onCancel: () => void
}) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const create = useMutation({
    mutationFn: (vaultName: string) => createVault(vaultName),
    onSuccess: (meta) => {
      track('vault_created', {})
      onCreated({ ...meta, kind: 'vault', parentId: null })
    },
    onError: (err) => {
      setError(
        err instanceof ApiError && err.code === 'name-taken'
          ? 'You already have a vault with that name.'
          : 'Could not create the vault.',
      )
    },
  })
  const commit = () => {
    const trimmed = name.trim()
    if (trimmed === '') return onCancel()
    if (takenNames.some((n) => n.toLowerCase() === trimmed.toLowerCase())) {
      setError('You already have a vault with that name.')
      return
    }
    create.mutate(trimmed)
  }

  return (
    <div className="px-2 py-1.5">
      <div className="flex items-center gap-1.5">
        <FolderRoot size={13} className="shrink-0 text-[var(--ink-faint)]" />
        <input
          autoFocus
          value={name}
          placeholder="Vault name"
          disabled={create.isPending}
          onChange={(e) => {
            setName(e.target.value)
            setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') onCancel()
          }}
          onBlur={() => {
            if (!create.isPending && name.trim() === '') onCancel()
          }}
          className="min-w-0 flex-1 rounded border border-[var(--accent)] bg-[var(--paper)] px-1 py-0.5 text-[13px] text-[var(--ink)] outline-none placeholder:text-[var(--ink-faint)]"
        />
      </div>
      {error ? <p className="m-0 mt-1 text-[11px] text-red-600">{error}</p> : null}
    </div>
  )
}

/**
 * Typed-name delete confirmation: a vault delete trashes EVERY doc inside,
 * so the plain ConfirmDialog is not enough — the user types the vault's name
 * first. Server guards (`last-vault`, `default-vault`) get distinct copy.
 */
function DeleteVaultDialog({
  vault,
  fallback,
  onClose,
}: {
  vault: FolderInfo
  /** Where the browser lands after the delete (the remaining default vault). */
  fallback: FolderInfo | null
  onClose: () => void
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [typed, setTyped] = useState('')
  const [error, setError] = useState<string | null>(null)

  const del = useMutation({
    mutationFn: () => deleteVault(vault.id),
    onSuccess: () => {
      track('vault_deleted', {})
      void queryClient.invalidateQueries({ queryKey: ['docs'] })
      void queryClient.invalidateQueries({ queryKey: ['folders'] })
      if (fallback) setStoredVaultId(fallback.id)
      onClose()
      void navigate({ to: '/', search: fallback ? { folder: fallback.id } : {} })
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'last-vault') {
        setError('This is your only vault — create another one before deleting it.')
      } else if (err instanceof ApiError && err.code === 'default-vault') {
        setError('This is your default vault (where new docs land) — it can’t be deleted.')
      } else {
        setError('Could not delete the vault.')
      }
    },
  })

  const confirmed = typed === vault.name
  return (
    <Dialog open onClose={onClose} title="Delete vault">
      <p className="m-0 mb-3 text-sm text-[var(--ink-soft)]">
        Deleting <strong className="text-[var(--ink)]">“{vault.name}”</strong> moves every document inside it to the
        trash and removes all of its folders. Anyone the vault was shared with loses access.
      </p>
      <p className="m-0 mb-2 text-xs text-[var(--ink-faint)]">
        Type <code className="rounded bg-[var(--paper-soft)] px-1 py-0.5">{vault.name}</code> to confirm.
      </p>
      <Input value={typed} onChange={setTyped} autoFocus placeholder={vault.name} />
      {error ? <p className="m-0 mt-2 text-xs text-red-600">{error}</p> : null}
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="danger" disabled={!confirmed || del.isPending} onClick={() => del.mutate()}>
          Delete vault
        </Button>
      </div>
    </Dialog>
  )
}
