// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { renderToString } from 'react-dom/server'
import { createElement, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

/**
 * Regression tests for the anonymous share-link sidebar flash
 * (fix/sidebar-anon-flash).
 *
 * The shell used to gate panel visibility on the async ['me'] query alone —
 * unresolved (undefined) on the first client render, so `data === null` read
 * as "signed in" and the panel flashed open for a frame or two before the
 * query resolved null and collapsed it. The gate is now SYNCHRONOUS-first:
 * the root route's beforeLoad resolves `session` into router context before
 * anything renders (null for anonymous visitors and for every ?share= load),
 * and the ['me'] probe can only UPGRADE the gate (signed-in user opening a
 * share link), never reveal-then-hide.
 *
 * These tests drive FileTreeShell and Header with a mocked router state
 * (pathname + matches[0].context.session) and assert:
 *  - null context session + me→null: ZERO panel/scrim/toggle markup, from the
 *    SSR HTML through every client commit (MutationObserver-backed);
 *  - context session present: the panel mounts open from the first client
 *    commit (persisted open state), without waiting for any query;
 *  - null context session + me→user (signed-in visitor on a share link): the
 *    chrome appears once the probe resolves — an upgrade, never a flash.
 */

// Controllable router state: the components select pathname and the root
// match's context session from it.
const h = vi.hoisted(() => ({
  routerState: {
    location: { pathname: '/d/doc-1' },
    matches: [{ context: { session: null as { user: { id: string } } | null } }],
  },
  me: null as { id: string; name: string; type: 'user' } | null,
}))

vi.mock('@tanstack/react-router', () => ({
  useRouterState: ({ select }: { select: (s: typeof h.routerState) => unknown }) => select(h.routerState),
  useNavigate: () => () => {},
  Link: ({ children }: { children?: ReactNode }) => createElement('a', null, children),
}))

vi.mock('../lib/api.ts', () => ({
  fetchMe: () => Promise.resolve(h.me),
}))

// Header pulls the better-auth store for the avatar; keep it inert here.
// (Mocked at the session.ts layer: the real module also carries the
// worker-bound getServerSession server function, which the standalone test
// vite config cannot resolve.)
vi.mock('../lib/session.ts', () => ({
  useSession: () => ({ data: null }),
  signOut: () => Promise.resolve(),
}))

vi.mock('./FileTree.tsx', () => ({
  default: () => createElement('div', { 'data-testid': 'file-tree' }),
}))
vi.mock('./ThemeToggle', () => ({ default: () => null }))
vi.mock('./NotificationsBell.tsx', () => ({ default: () => null }))

// Imported after the mocks are registered.
import FileTreeShell from './FileTreeShell.tsx'
import Header from './Header.tsx'
import { setFileTreeOpen } from '../lib/fileTreePanel.ts'

const SESSION = { user: { id: 'user-1' } }

// This vitest/jsdom combination exposes a stub window.localStorage without
// Storage methods (node's experimental webstorage leaks in); install a real
// in-memory one so the persisted-open precondition can be set up.
const store = new Map<string, string>()
Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  },
})

function wrap(ui: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return createElement(QueryClientProvider, { client: queryClient }, ui)
}

function shell(floatingToggle = true) {
  return wrap(
    createElement(FileTreeShell, { floatingToggle, children: createElement('main', null, 'doc body') }),
  )
}

/** Counts panel chrome in a DOM subtree: the aside, the scrim, any toggle. */
function chromeCount(root: HTMLElement): number {
  return root.querySelectorAll('aside, [aria-label="Open file tree"], [aria-label="Toggle file tree"]').length
}

beforeEach(() => {
  // Persisted "panel open" — the precondition for the historical flash.
  window.localStorage.setItem('glyphdown:tree:open', '1')
  setFileTreeOpen(true)
  h.routerState.location.pathname = '/d/doc-1'
  h.routerState.matches[0]!.context.session = null
  h.me = null
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('FileTreeShell signed-in gate', () => {
  it('anonymous share-link visitor: zero frames of panel/scrim/toggle, including SSR HTML', async () => {
    // SSR HTML: no panel markup at all for a null context session.
    const ssr = renderToString(shell())
    expect(ssr).toContain('doc body')
    expect(ssr).not.toContain('<aside')
    expect(ssr).not.toContain('file tree')

    // Client: watch every DOM commit — the chrome must never mount, even
    // transiently, while the panel state hydrates and the ['me'] probe
    // (resolving null) settles.
    let everMounted = 0
    const host = document.createElement('div')
    document.body.appendChild(host)
    const observer = new MutationObserver(() => {
      everMounted = Math.max(everMounted, chromeCount(host))
    })
    observer.observe(host, { childList: true, subtree: true })

    const { container } = render(shell(), { container: host })
    // First commit (panel state already hydrated open from localStorage).
    expect(chromeCount(container)).toBe(0)
    // Let the ['me'] query resolve (null) and re-render.
    await waitFor(() => expect(container.textContent).toContain('doc body'))
    await new Promise((r) => setTimeout(r, 20))
    expect(chromeCount(container)).toBe(0)
    expect(everMounted).toBe(0)
    observer.disconnect()
  })

  it('signed-in user (context session): panel mounts open on the first client commit, before any query resolves', () => {
    h.routerState.matches[0]!.context.session = SESSION
    // fetchMe intentionally still resolves null — the synchronous context
    // session alone must show the panel.
    const { container } = render(shell())
    const aside = container.querySelector('aside')
    expect(aside).not.toBeNull()
    expect(aside!.className).toContain('translate-x-0')
    expect(aside!.getAttribute('aria-hidden')).toBe('false')
    expect(container.querySelector('[data-testid="file-tree"]')).not.toBeNull()
  })

  it('signed-in user (context session) with panel closed: aside stays mounted but off-screen, toggle shows', () => {
    h.routerState.matches[0]!.context.session = SESSION
    setFileTreeOpen(false)
    const { container } = render(shell())
    const aside = container.querySelector('aside')
    expect(aside).not.toBeNull()
    expect(aside!.className).toContain('-translate-x-full')
    expect(container.querySelector('[aria-label="Open file tree"]')).not.toBeNull()
  })

  it('signed-in visitor on a share link (null context, me resolves a principal): chrome appears once — an upgrade, never a hide', async () => {
    h.me = { id: 'user-1', name: 'Test User', type: 'user' }
    const { container } = render(shell())
    // Synchronous default: hidden (context session is null on ?share= loads).
    expect(chromeCount(container)).toBe(0)
    // The probe resolving a principal upgrades the gate.
    await waitFor(() => expect(container.querySelector('aside')).not.toBeNull())
    expect(container.querySelector('aside')!.className).toContain('translate-x-0')
  })

  it('signed-in user off doc routes: no panel chrome', () => {
    h.routerState.matches[0]!.context.session = SESSION
    h.routerState.location.pathname = '/settings'
    // floatingToggle mirrors the root-layout wiring: only editor (/d/*)
    // routes get the floating toggle.
    const { container } = render(shell(false))
    expect(chromeCount(container)).toBe(0)
    expect(container.textContent).toContain('doc body')
  })
})

describe('Header tree toggle gate', () => {
  it('anonymous on a doc route: no toggle, in SSR HTML or on the client', async () => {
    const ssr = renderToString(wrap(createElement(Header)))
    expect(ssr).not.toContain('Toggle file tree')

    const { container } = render(wrap(createElement(Header)))
    expect(container.querySelector('[aria-label="Toggle file tree"]')).toBeNull()
    await new Promise((r) => setTimeout(r, 20))
    expect(container.querySelector('[aria-label="Toggle file tree"]')).toBeNull()
  })

  it('signed-in (context session) on a doc route: toggle renders from the first commit', () => {
    h.routerState.matches[0]!.context.session = SESSION
    const { container } = render(wrap(createElement(Header)))
    expect(container.querySelector('[aria-label="Toggle file tree"]')).not.toBeNull()
  })

  it('signed-in off doc routes: no toggle (home/settings own their navigation)', () => {
    h.routerState.matches[0]!.context.session = SESSION
    h.routerState.location.pathname = '/'
    const { container } = render(wrap(createElement(Header)))
    expect(container.querySelector('[aria-label="Toggle file tree"]')).toBeNull()
  })
})
