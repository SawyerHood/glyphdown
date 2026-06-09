import type { DragEvent } from 'react'
import { Link } from '@tanstack/react-router'
import { ChevronRight, Home } from 'lucide-react'
import type { FolderInfo } from '../../lib/api.ts'

/**
 * Drive-style breadcrumb trail for the home file browser: Home → … → current
 * folder. Every segment except the current one is a navigation link AND a
 * drop target — dragging a doc/folder row onto a crumb moves it there (the
 * canonical "move up" gesture in a one-folder-at-a-time browser).
 *
 * Drop validity beyond what's gated here (same-scope no-ops, cycles) is
 * enforced by the guarded moves in useFileMutations, so a stray drop is a
 * silent no-op rather than an error.
 */
export default function Breadcrumbs({
  chain,
  dragOverId,
  hasDrag,
  setDragOver,
  onDropTo,
}: {
  /** Ancestor chain (topmost first, current folder last); [] at the root. */
  chain: readonly FolderInfo[]
  /** Currently highlighted drop target ('root' = the Home crumb). */
  dragOverId: string | 'root' | null
  /** Whether the active drag carries a doc/folder payload we accept. */
  hasDrag: (e: DragEvent) => boolean
  setDragOver: (id: string | 'root' | null) => void
  /** Move the dragged item to `parentId` (null = root). */
  onDropTo: (e: DragEvent, parentId: string | null) => void
}) {
  const atRoot = chain.length === 0

  /** Shared drop-target behavior for every non-current crumb. */
  const dropProps = (targetId: string | 'root', parentId: string | null, allowed: boolean) => ({
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
      onDropTo(e, parentId)
    },
  })

  const crumbClass = (highlight: boolean) =>
    `flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-sm no-underline transition ${
      highlight
        ? 'bg-[var(--accent-soft)] text-[var(--accent)] outline outline-1 -outline-offset-1 outline-[var(--accent)]'
        : 'text-[var(--ink-soft)] hover:bg-[var(--paper-soft)] hover:text-[var(--ink)]'
    }`

  return (
    <nav aria-label="Folders" className="flex min-w-0 flex-wrap items-center gap-0.5">
      {atRoot ? (
        <span
          aria-current="page"
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-semibold text-[var(--ink)]"
        >
          <Home size={14} className="shrink-0 text-[var(--ink-soft)]" />
          Home
        </span>
      ) : (
        <Link to="/" className={crumbClass(dragOverId === 'root')} {...dropProps('root', null, true)}>
          <Home size={14} className="shrink-0" />
          Home
        </Link>
      )}

      {chain.map((folder, i) => {
        const isCurrent = i === chain.length - 1
        return (
          <span key={folder.id} className="flex min-w-0 items-center gap-0.5">
            <ChevronRight size={13} aria-hidden className="shrink-0 text-[var(--ink-faint)]" />
            {isCurrent ? (
              <span
                aria-current="page"
                title={folder.name}
                className="flex min-w-0 items-center rounded-md px-2 py-1 text-sm font-semibold text-[var(--ink)]"
              >
                <span className="truncate">{folder.name}</span>
              </span>
            ) : (
              <Link
                to="/"
                search={{ folder: folder.id }}
                title={folder.name}
                className={crumbClass(dragOverId === folder.id)}
                {...dropProps(folder.id, folder.id, folder.role === 'owner')}
              >
                <span className="truncate">{folder.name}</span>
              </Link>
            )}
          </span>
        )
      })}
    </nav>
  )
}
