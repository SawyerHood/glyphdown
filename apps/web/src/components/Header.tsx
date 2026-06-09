import { Link, useNavigate, useRouterState } from '@tanstack/react-router'
import { PanelLeft, PenLine, Settings } from 'lucide-react'
import ThemeToggle from './ThemeToggle'
import NotificationsBell from './NotificationsBell.tsx'
import { resetAnalytics } from '../lib/analytics.ts'
import { signOut, useSession } from '../lib/session.ts'
import { useShellSignedIn } from '../lib/sessionGate.ts'
import { initials, presenceColor } from '../lib/presence.ts'
import { toggleFileTree, useFileTreeOpen } from '../lib/fileTreePanel.ts'

export default function Header() {
  const { data: session } = useSession()
  const navigate = useNavigate()
  const user = session?.user
  const treeOpen = useFileTreeOpen()
  // The home page is the file browser — no sidebar there, so no toggle either.
  const onDocRoute = useRouterState({ select: (s) => s.location.pathname.startsWith('/d/') })
  // Same synchronous gate as FileTreeShell: signed-out (anonymous share-link)
  // visitors never see the toggle, not even for a frame.
  const signedIn = useShellSignedIn()

  return (
    <header className="sticky top-0 z-50 border-b border-[var(--line)] bg-[var(--header-bg)] backdrop-blur-md">
      <nav className="page-wrap flex items-center gap-3 py-2.5">
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

        <div className="ml-2 flex items-center gap-3 text-sm font-medium">
          <Link to="/" className="nav-link" activeProps={{ className: 'nav-link is-active' }} activeOptions={{ exact: true }}>
            Documents
          </Link>
          <Link to="/settings" className="nav-link" activeProps={{ className: 'nav-link is-active' }}>
            Settings
          </Link>
        </div>

        <div className="ml-auto flex items-center gap-1">
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
            <div className="group relative ml-1">
              <button
                type="button"
                className="flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-bold text-white"
                style={{ backgroundColor: presenceColor(user.id).color }}
                title={user.name}
              >
                {initials(user.name)}
              </button>
              <div className="invisible absolute right-0 top-full z-50 mt-1 w-48 rounded-lg border border-[var(--line)] bg-[var(--paper)] p-1 opacity-0 shadow-lg transition group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100">
                <p className="m-0 truncate px-2 py-1.5 text-xs text-[var(--ink-faint)]">{user.email}</p>
                <button
                  type="button"
                  onClick={async () => {
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
            </div>
          ) : null}
        </div>
      </nav>
    </header>
  )
}
