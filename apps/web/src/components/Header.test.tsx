// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

/**
 * Header account-menu tests (fix/mobile-nav).
 *
 * The avatar menu used to open on group-hover/group-focus-within only —
 * Tailwind v4 gates hover variants behind `@media (hover: hover)` and iOS
 * Safari never focuses a <button> on tap, so Sign out was unreachable on
 * phones. The menu is now click-toggled with useDismissable (the app's
 * standard dropdown pattern, see NotificationsBell); these tests pin:
 *  - closed by default, opened by a tap/click on the avatar (aria-expanded);
 *  - Sign out is in the open menu and signs out + navigates to /login;
 *  - Escape and outside pointerdown both dismiss;
 *  - signed out: no account menu at all;
 *  - the Documents/Settings text links collapse below sm (className pin —
 *    jsdom does no layout, so the responsive classes are the testable
 *    surface) while the mobile Settings icon link stays.
 */

// Controllable router state + session, same scaffold as FileTreeShell.test.tsx.
const h = vi.hoisted(() => ({
  routerState: {
    location: { pathname: '/' },
    matches: [{ context: { session: null as { user: { id: string } } | null } }],
  },
  sessionUser: null as { id: string; name: string; email: string } | null,
  navigations: [] as unknown[],
  signOuts: 0,
}))

vi.mock('@tanstack/react-router', () => ({
  useRouterState: ({ select }: { select: (s: typeof h.routerState) => unknown }) => select(h.routerState),
  useNavigate: () => (args: unknown) => {
    h.navigations.push(args)
  },
  Link: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) =>
    createElement(
      'a',
      { className: props['className'] as string, 'aria-label': props['aria-label'] as string, href: props['to'] as string },
      children,
    ),
}))

vi.mock('../lib/api.ts', () => ({
  fetchMe: () => Promise.resolve(null),
}))

// Mocked at the session.ts layer: the real module carries the worker-bound
// getServerSession server function, which the standalone test vite config
// cannot resolve.
vi.mock('../lib/session.ts', () => ({
  useSession: () => ({ data: h.sessionUser ? { user: h.sessionUser } : null }),
  signOut: () => {
    h.signOuts += 1
    return Promise.resolve()
  },
}))

vi.mock('./ThemeToggle', () => ({ default: () => null }))
vi.mock('./NotificationsBell.tsx', () => ({ default: () => null }))
vi.mock('./FeedbackButton.tsx', () => ({ default: () => null }))

// Imported after the mocks are registered.
import Header from './Header.tsx'

const USER = { id: 'user-1', name: 'Test User', email: 'test@example.com' }

function wrap(ui: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return createElement(QueryClientProvider, { client: queryClient }, ui)
}

function renderHeader() {
  return render(wrap(createElement(Header)))
}

const menuButton = (root: HTMLElement) => root.querySelector<HTMLButtonElement>('[aria-label="Account menu"]')
const signOutButton = (root: HTMLElement) =>
  Array.from(root.querySelectorAll('button')).find((b) => b.textContent === 'Sign out') ?? null

beforeEach(() => {
  h.routerState.location.pathname = '/'
  h.routerState.matches[0]!.context.session = null
  h.sessionUser = USER
  h.navigations = []
  h.signOuts = 0
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Header account menu', () => {
  it('is closed by default and opens on click (touch-reachable, not hover-gated)', () => {
    const { container } = renderHeader()
    const button = menuButton(container)
    expect(button).not.toBeNull()
    expect(button!.getAttribute('aria-expanded')).toBe('false')
    expect(signOutButton(container)).toBeNull()
    expect(container.textContent).not.toContain(USER.email)

    fireEvent.click(button!)
    expect(button!.getAttribute('aria-expanded')).toBe('true')
    expect(signOutButton(container)).not.toBeNull()
    expect(container.textContent).toContain(USER.email)

    // Second tap toggles it back closed. Real taps fire pointerdown BEFORE
    // click — the sequence that breaks if menuRef ever stops wrapping the
    // toggle (useDismissable would dismiss on pointerdown, then the click
    // would reopen).
    act(() => button!.dispatchEvent(new Event('pointerdown', { bubbles: true })))
    fireEvent.click(button!)
    expect(signOutButton(container)).toBeNull()
    expect(button!.getAttribute('aria-expanded')).toBe('false')
  })

  it('signs out, resets the menu, and navigates to /login', async () => {
    const { container } = renderHeader()
    fireEvent.click(menuButton(container)!)
    fireEvent.click(signOutButton(container)!)
    await waitFor(() => expect(h.signOuts).toBe(1))
    await waitFor(() => expect(h.navigations).toEqual([{ to: '/login' }]))
    expect(signOutButton(container)).toBeNull()
  })

  it('dismisses on Escape and on pointerdown outside (useDismissable wiring)', () => {
    const { container } = renderHeader()
    const button = menuButton(container)!

    fireEvent.click(button)
    expect(signOutButton(container)).not.toBeNull()
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(signOutButton(container)).toBeNull()
    expect(button.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(button)
    expect(signOutButton(container)).not.toBeNull()
    // Inside the wrapper: stays open (the ref contains button + panel).
    act(() => signOutButton(container)!.dispatchEvent(new Event('pointerdown', { bubbles: true })))
    expect(signOutButton(container)).not.toBeNull()
    // Outside: dismissed.
    act(() => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })))
    expect(signOutButton(container)).toBeNull()
    expect(button.getAttribute('aria-expanded')).toBe('false')
  })

  it('renders no account menu when signed out', () => {
    h.sessionUser = null
    const { container } = renderHeader()
    expect(menuButton(container)).toBeNull()
    expect(signOutButton(container)).toBeNull()
  })
})

describe('Header responsive nav', () => {
  it('collapses the Documents/Settings text links below sm and keeps the mobile Settings icon', () => {
    const { container } = renderHeader()
    // jsdom does no CSS layout — the responsive classes are the contract.
    const docsLink = Array.from(container.querySelectorAll('a')).find((a) => a.textContent === 'Documents')
    expect(docsLink).not.toBeUndefined()
    const linkGroup = docsLink!.parentElement!
    expect(linkGroup.classList.contains('hidden')).toBe(true)
    expect(linkGroup.classList.contains('sm:flex')).toBe(true)
    // The icon-only Settings link survives as the mobile path to /settings.
    const settingsIcon = container.querySelector('[aria-label="Settings"]')
    expect(settingsIcon).not.toBeNull()
    expect(settingsIcon!.classList.contains('sm:hidden')).toBe(true)
    expect(settingsIcon!.getAttribute('href')).toBe('/settings')
  })
})
