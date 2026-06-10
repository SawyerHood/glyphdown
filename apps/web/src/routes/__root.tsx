import { useEffect, useState } from 'react'
import { HeadContent, Scripts, createRootRoute, redirect, useRouterState } from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import Header from '../components/Header'
import FileTreeShell from '../components/FileTreeShell.tsx'
import QuickSwitcher from '../components/QuickSwitcher.tsx'
import AppErrorBoundary from '../components/AppErrorBoundary.tsx'
import { getServerSession } from '../lib/session.ts'
import { identifyUser, initAnalytics, trackPageview } from '../lib/analytics.ts'
import { installChunkReloadHandler } from '../lib/chunkReload.ts'

import appCss from '../styles.css?url'

const THEME_INIT_SCRIPT = `(function(){try{var stored=window.localStorage.getItem('theme');var mode=(stored==='light'||stored==='dark'||stored==='auto')?stored:'auto';var prefersDark=window.matchMedia('(prefers-color-scheme: dark)').matches;var resolved=mode==='auto'?(prefersDark?'dark':'light'):mode;var root=document.documentElement;root.classList.remove('light','dark');root.classList.add(resolved);if(mode==='auto'){root.removeAttribute('data-theme')}else{root.setAttribute('data-theme',mode)}root.style.colorScheme=resolved;}catch(e){}})();`

export const Route = createRootRoute({
  // Signed-out visitors are sent to /login — except the login page itself,
  // share-link access (/d/:docId?share=<token>, which supports anonymous
  // viewers on view-role links), invite landing pages (/invite/:token must
  // render for recipients with no account yet), and the home page (which
  // renders the public landing page when signed out — see routes/index.tsx).
  beforeLoad: async ({ location }) => {
    if (location.pathname === '/login' || location.pathname.startsWith('/login/')) return { session: null }
    const search = location.search as Record<string, unknown>
    if (typeof search['share'] === 'string') return { session: null }
    const session = await getServerSession()
    if (!session) {
      if (location.pathname === '/' || location.pathname.startsWith('/invite/')) return { session: null }
      // Preserve the destination (e.g. /device?user_code=...) through the
      // sign-in round trip.
      throw redirect({ to: '/login', search: { next: location.href } })
    }
    return { session }
  },
  head: () => ({
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1',
      },
      {
        title: 'Glyphdown',
      },
    ],
    links: [
      {
        rel: 'stylesheet',
        href: appCss,
      },
      // SVG favicon (lucide square-pen on the accent tile); .ico stays as the
      // legacy fallback for browsers that ignore SVG icons.
      {
        rel: 'icon',
        type: 'image/svg+xml',
        href: '/favicon.svg',
      },
    ],
  }),
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 5_000, retry: 1 },
        },
      }),
  )
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const session = useRouterState({ select: (s) => s.matches[0]?.context.session ?? null })

  // Analytics (PostHog) — a silent no-op when VITE_POSTHOG_KEY is unset.
  // initAnalytics runs in a post-paint effect and dynamic-imports posthog-js
  // in its own chunk; events fired meanwhile are queued. Initialized for
  // EVERYONE (signed-in users and anonymous share-link viewers alike).
  useEffect(() => {
    initAnalytics()
    // Stale-deploy self-healing: reload when a lazy chunk 404s after a deploy
    // (vite:preloadError). Installed once; the shell never unmounts.
    installChunkReloadHandler()
  }, [])
  // $pageview on every router navigation (autocapture/pageview-capture is off).
  useEffect(() => {
    trackPageview()
  }, [pathname])
  // Tie events to the signed-in user (id + email/name person properties; the
  // anonymous→user transition fires sign_in). Logout resets in Header.
  const sessionUserId = session?.user.id ?? null
  useEffect(() => {
    if (session !== null) identifyUser(session.user)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-identify per user id, not per session object identity
  }, [sessionUserId])
  // The editor + history routes own the full viewport; everything else gets
  // the standard app chrome. Login gets neither chrome nor the file tree, and
  // neither do the signed-out home page (the public landing page) or invite
  // landing pages (focused accept card; may render with no session at all).
  const isLogin = pathname === '/login' || pathname.startsWith('/login/')
  const isLanding = pathname === '/' && session === null
  const isInvite = pathname.startsWith('/invite/')
  // Folder/vault share-link landing (/f/:folderId) brings its own minimal
  // header and may render with no session at all — no shell, no tree.
  const isFolderShare = pathname.startsWith('/f/')
  const isEditor = pathname.startsWith('/d/')

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <HeadContent />
      </head>
      <body className="font-sans antialiased">
        <QueryClientProvider client={queryClient}>
          <AppErrorBoundary>
            {isLogin || isLanding || isInvite || isFolderShare ? (
              children
            ) : (
              <FileTreeShell floatingToggle={isEditor}>
                {isEditor ? null : <Header />}
                {children}
              </FileTreeShell>
            )}
            {isLogin || isInvite || isFolderShare ? null : <QuickSwitcher />}
          </AppErrorBoundary>
        </QueryClientProvider>
        <Scripts />
      </body>
    </html>
  )
}
