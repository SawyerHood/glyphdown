import type { DragEvent } from 'react'
import { Link } from '@tanstack/react-router'
import { ChevronRight, Home, FolderRoot } from 'lucide-react'
import type { FolderInfo } from '../../lib/api.ts'
import VaultSwitcher from '../VaultSwitcher.tsx'

/**
 * Drive-style breadcrumb trail for the home file browser, ROOTED AT THE
 * VAULT: the chain's top folder (the vault) is the first crumb — there is no
 * "Home"/account-root crumb above it, because the root level holds only
 * vaults and nothing lives there. At the vault root the crumb IS the vault
 * switcher (heading-sized trigger; pick / create / share / delete); deeper
 * in, the vault crumb is a plain link back to the root, where the switcher
 * lives. Every segment except the current one is a navigation link AND a
 * drop target — dragging a doc/folder row onto a crumb moves it there,
 * stopping at the vault root (the canonical "move up" gesture in a
 * one-folder-at-a-time browser).
 *
 * Drop validity beyond what's gated here (same-scope no-ops, cycles) is
 * enforced by the guarded moves in useFileMutations, so a stray drop is a
 * silent no-op rather than an error.
 *
 * An empty chain only happens for accounts with no vault yet (nothing ever
 * created) — that renders the legacy static "Home" label.
 */
export default function Breadcrumbs({
  chain,
  dragOverId,
  hasDrag,
  setDragOver,
  onDropTo,
}: {
  /** Ancestor chain (vault first, current folder last); [] only pre-vault. */
  chain: readonly FolderInfo[]
  /** Currently highlighted drop target (a crumb's folder id). */
  dragOverId: string | 'root' | null
  /** Whether the active drag carries a doc/folder payload we accept. */
  hasDrag: (e: DragEvent) => boolean
  setDragOver: (id: string | 'root' | null) => void
  /** Move the dragged item into the crumb's folder. */
  onDropTo: (e: DragEvent, parentId: string) => void
}) {
  /** Shared drop-target behavior for every non-current crumb. */
  const dropProps = (targetId: string, allowed: boolean) => ({
    onDragOver: (e: DragEvent) => {
      if (!hasDrag(e) || !allowed) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      setDragOver(targetId)
    },
    onDragLeave: () => {
      setDragOver(null)
    },
    onDrop: (e: DragEvent) => {
      setDragOver(null)
      if (!allowed) return
      onDropTo(e, targetId)
    },
  })

  const crumbClass = (highlight: boolean) =>
    `flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-sm no-underline transition ${
      highlight
        ? 'bg-[var(--accent-soft)] text-[var(--accent)] outline outline-1 -outline-offset-1 outline-[var(--accent)]'
        : 'text-[var(--ink-soft)] hover:bg-[var(--paper-soft)] hover:text-[var(--ink)]'
    }`

  if (chain.length === 0) {
    return (
      <nav aria-label="Folders" className="flex min-w-0 flex-wrap items-center gap-0.5">
        <span
          aria-current="page"
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-semibold text-[var(--ink)]"
        >
          <Home size={14} className="shrink-0 text-[var(--ink-soft)]" />
          Home
        </span>
      </nav>
    )
  }

  return (
    <nav aria-label="Folders" className="flex min-w-0 flex-wrap items-center gap-0.5">
      {chain.map((folder, i) => {
        const isCurrent = i === chain.length - 1
        // The vault crumb gets the vault glyph; nested crumbs stay text-only.
        const icon = i === 0 ? <FolderRoot size={14} className="shrink-0" aria-hidden /> : null
        return (
          <span key={folder.id} className="flex min-w-0 items-center gap-0.5">
            {i > 0 ? <ChevronRight size={13} aria-hidden className="shrink-0 text-[var(--ink-faint)]" /> : null}
            {isCurrent && i === 0 && folder.kind === 'vault' ? (
              // At the vault root the crumb IS the switcher trigger.
              <VaultSwitcher variant="heading" />
            ) : isCurrent ? (
              <span
                aria-current="page"
                title={folder.name}
                className="flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-sm font-semibold text-[var(--ink)]"
              >
                {i === 0 ? <FolderRoot size={14} className="shrink-0 text-[var(--ink-soft)]" aria-hidden /> : null}
                <span className="truncate">{folder.name}</span>
              </span>
            ) : (
              <Link
                to="/"
                search={{ folder: folder.id }}
                title={folder.name}
                className={crumbClass(dragOverId === folder.id)}
                {...dropProps(folder.id, folder.role === 'owner')}
              >
                {icon}
                <span className="truncate">{folder.name}</span>
              </Link>
            )}
          </span>
        )
      })}
    </nav>
  )
}
