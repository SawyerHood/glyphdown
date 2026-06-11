import { useRef, useState } from 'react'
import { Link, useNavigate, useRouterState } from '@tanstack/react-router'
import { PanelLeft, PenLine, Settings } from 'lucide-react'
import ThemeToggle from './ThemeToggle'
import NotificationsBell from './NotificationsBell.tsx'
import FeedbackButton from './FeedbackButton.tsx'
import { resetAnalytics } from '../lib/analytics.ts'
import { signOut, useSession } from '../lib/session.ts'
import { useShellSignedIn } from '../lib/sessionGate.ts'
import { initials, presenceColor } from '../lib/presence.ts'
import { toggleFileTree, useFileTreeOpen } from '../lib/fileTreePanel.ts'
import { useDismissable } from '../lib/useDismissable.ts'

export default function Header() {
  const { data: session } = useSession()
  const navigate = useNavigate()
  const user = session?.user
  const treeOpen = useFileTreeOpen()
  // Account menu: click-toggled (the app's standard dropdown pattern — see
  // NotificationsBell). Hover/focus-within reveals never fire on touch
  // devices (Tailwind gates hover behind `@media (hover: hover)` and iOS
  // Safari doesn't focus buttons on tap), which made Sign out unreachable
  // on phones.
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  useDismissable(menuOpen, menuRef, () => setMenuOpen(false))
  // The home page is the file browser — no sidebar there, so no toggle either.
  const onDocRoute = useRouterState({ select: (s) => s.location.pathname.startsWith('/d/') })
  // Same synchronous gate as FileTreeShell: signed-out (anonymous share-link)
  // visitors never see the toggle, not even for a frame.
  const signedIn = useShellSignedIn()

  return (
    <header className="sticky top-0 z-50 border-b border-[var(--line)] bg-[var(--header-bg)] backdrop-blur-md">
      <nav className="page-wrap flex items-center gap-2 py-2.5 sm:gap-3">
        {!onDocRoute || !signedIn ? null : (
          <button
            type="button"
            onClick={toggleFileTree}
            title="Toggle file tree (⌘\)"
            aria-label="Toggle file tree"
            className={`-ml-2 rounded-md p-2 transition hover:bg-[var(--paper-soft)] hover:text-[var(--ink)] ${
              treeOpen ? 'text-[var(--accent)]' : 'text-[var(--ink-soft)]'
            }`}
          >
            <PanelLeft size={16} />
          </button>
        )}
        <Link to="/" className="flex items-center gap-2 text-[var(--ink)] no-underline">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--accent)] text-white">
            <PenLine size={15} />
          </span>
          <span className="display-title text-base font-bold tracking-tight">Glyphdown</span>
        </Link>

        {/* The vault switcher lives in the file browser's heading (and the
            sidebar's footer on doc routes), not here. Text links collapse
            below sm — the row's min-content otherwise exceeds narrow phones
            and pans the whole page sideways. Mobile keeps the logo (→ home)
            and the sm:hidden Settings icon below. */}
        <div className="ml-2 hidden items-center gap-3 text-sm font-medium sm:flex">
          <Link to="/" className="nav-link" activeProps={{ className: 'nav-link is-active' }} activeOptions={{ exact: true }}>
            Documents
          </Link>
          <Link to="/settings" className="nav-link" activeProps={{ className: 'nav-link is-active' }}>
            Settings
          </Link>
        </div>

        <div className="ml-auto flex items-center gap-1">
          {user ? <FeedbackButton /> : null}
          {user ? <NotificationsBell /> : null}
          <ThemeToggle />
          <Link
            to="/settings"
            className="rounded-md p-2 text-[var(--ink-soft)] transition hover:bg-[var(--paper-soft)] hover:text-[var(--ink)] sm:hidden"
            aria-label="Settings"
          >
            <Settings size={16} />
          </Link>
          {user ? (
            // The ref wraps BOTH the toggle and the panel: useDismissable
            // listens on pointerdown (fires before click), so a toggle
            // outside the ref would dismiss-then-reopen.
            <div className="relative ml-1" ref={menuRef}>
              <button
                type="button"
                onClick={() => setMenuOpen((v) => !v)}
                aria-expanded={menuOpen}
                aria-label="Account menu"
                // before:-inset-1.5 pads the hit area past the 28px circle
                // for touch without changing the visual.
                className="relative flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-bold text-white before:absolute before:-inset-1.5 before:content-['']"
                style={{ backgroundColor: presenceColor(user.id).color }}
                title={user.name}
              >
                {initials(user.name)}
              </button>
              {menuOpen ? (
                <div className="absolute right-0 top-full z-50 mt-1 w-48 rounded-lg border border-[var(--line)] bg-[var(--paper)] p-1 shadow-lg">
                  <p className="m-0 truncate px-2 py-1.5 text-xs text-[var(--ink-faint)]">{user.email}</p>
                  <button
                    type="button"
                    onClick={async () => {
                      setMenuOpen(false)
                      await signOut()
                      // Detach the PostHog person — the next visitor on this
                      // browser starts anonymous (no-op when unconfigured).
                      resetAnalytics()
                      void navigate({ to: '/login' })
                    }}
                    className="block w-full rounded px-2 py-1.5 text-left text-sm text-[var(--ink)] hover:bg-[var(--paper-soft)]"
                  >
                    Sign out
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </nav>
    </header>
  )
}
