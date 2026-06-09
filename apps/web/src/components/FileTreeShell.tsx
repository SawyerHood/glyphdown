import { useEffect, type ReactNode } from 'react'
import { useRouterState } from '@tanstack/react-router'
import { PanelLeft } from 'lucide-react'
import { useShellSignedIn } from '../lib/sessionGate.ts'
import {
  hydrateFileTreePanel,
  setFileTreeOpen,
  toggleFileTree,
  useFileTreeOpen,
} from '../lib/fileTreePanel.ts'
import FileTree from './FileTree.tsx'

/**
 * Slide-out left file-tree panel (Obsidian style), mounted around the page
 * content at the root layout so the editor page itself stays untouched.
 *
 * - ≥1024px: the panel pushes the content (padding-left transition).
 * - <1024px: the panel overlays the page behind a scrim.
 * - Toggled from the Header button, the floating button on full-bleed pages
 *   (the editor owns its own toolbar), or Cmd/Ctrl+\.
 * - Hidden entirely for signed-out visitors (anonymous share-link viewers) —
 *   gated SYNCHRONOUSLY on the router-context session (resolved by the root
 *   route's beforeLoad before anything renders), so an anonymous visitor
 *   never sees a frame of panel/scrim/toggle even when localStorage has the
 *   panel open. See useShellSignedIn() in lib/sessionGate.ts.
 * - Hidden entirely on the home page ('/'): the file browser there IS the
 *   file navigation, so the panel, its toggles, and Cmd+\ all stand down
 *   (without touching the persisted open state other routes restore).
 */
export default function FileTreeShell({
  children,
  floatingToggle = false,
}: {
  children: ReactNode
  floatingToggle?: boolean
}) {
  const open = useFileTreeOpen()
  // Whitelist: the tree only renders beside documents (/d/* editor,
  // history, image viewer) — never on home/settings/device/invite pages.
  const onDocRoute = useRouterState({ select: (s) => s.location.pathname.startsWith('/d/') })

  // Flash-free signed-in gate: router context first (synchronous, SSR-safe),
  // with the shared ['me'] probe as an upgrade-only fallback for signed-in
  // users on ?share= links (where the root guard leaves context.session null).
  const signedIn = useShellSignedIn()

  useEffect(() => {
    hydrateFileTreePanel()
  }, [])

  useEffect(() => {
    if (!onDocRoute) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '\\' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        toggleFileTree()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onDocRoute])

  const showPanel = open && signedIn && onDocRoute

  return (
    <>
      {signedIn && onDocRoute ? (
        <aside
          aria-label="File tree"
          aria-hidden={!showPanel}
          {...(showPanel ? {} : { inert: true })}
          className={`fixed inset-y-0 left-0 z-[60] w-[260px] border-r border-[var(--line)] bg-[var(--paper)] transition-transform duration-200 ease-out ${
            showPanel ? 'translate-x-0' : '-translate-x-full'
          }`}
        >
          <FileTree onClose={() => setFileTreeOpen(false)} />
        </aside>
      ) : null}

      {/* Scrim: narrow screens only — wide screens push the content instead. */}
      {showPanel ? (
        <div
          className="fixed inset-0 z-[55] bg-black/40 lg:hidden"
          onClick={() => setFileTreeOpen(false)}
          aria-hidden
        />
      ) : null}

      {/* The editor routes have no app Header; give them a floating toggle
          below the editor toolbar instead. */}
      {floatingToggle && signedIn && !showPanel ? (
        <button
          type="button"
          onClick={() => setFileTreeOpen(true)}
          title="Open file tree (⌘\)"
          aria-label="Open file tree"
          className="fixed left-2 top-14 z-40 rounded-md border border-[var(--line)] bg-[var(--paper)] p-1.5 text-[var(--ink-soft)] shadow-sm transition hover:bg-[var(--paper-soft)] hover:text-[var(--ink)]"
        >
          <PanelLeft size={15} />
        </button>
      ) : null}

      <div className={`transition-[padding] duration-200 ease-out ${showPanel ? 'lg:pl-[260px]' : ''}`}>
        {children}
      </div>
    </>
  )
}
