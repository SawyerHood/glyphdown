import { useQuery } from '@tanstack/react-query'
import { useRouterState } from '@tanstack/react-router'
import { fetchMe } from './api.ts'
import type { SessionUser } from './session.ts'

/**
 * Synchronous, flash-free session reads for the UI chrome.
 *
 * Client-only sibling of lib/session.ts (which carries the worker-bound
 * `getServerSession` server function): components and unit tests can import
 * these hooks without pulling `cloudflare:workers` into the module graph.
 */

/**
 * Synchronous session read from router context. The root route's beforeLoad
 * resolves `session` before anything renders — during SSR and on the client —
 * so this never flips after the first frame, unlike the async client probes
 * (the ['me'] query / the better-auth store). Null for anonymous visitors AND
 * for every `?share=` load: the root guard short-circuits with
 * `{ session: null }` on share links without looking the session up.
 */
export function useRouteSession(): { user: SessionUser } | null {
  return useRouterState({ select: (s) => s.matches[0]?.context.session ?? null })
}

/**
 * Signed-in gate for the file-tree chrome (panel, scrim, Header/floating
 * toggles). Synchronous-first: the router-context session decides the very
 * first render — including the SSR HTML — so anonymous share-link visitors
 * get ZERO frames of chrome. The shared ['me'] probe (same key/options as the
 * editor page, so the query is deduped) can only UPGRADE the gate: a
 * signed-in user opening a `?share=` link has `session: null` in context (the
 * root guard skips the lookup there) and regains the chrome once the probe
 * resolves to their principal. Anonymous visitors resolve to null, so the
 * probe can never reveal-then-hide — no flash is possible.
 */
export function useShellSignedIn(): boolean {
  const session = useRouteSession()
  const me = useQuery({ queryKey: ['me'], queryFn: fetchMe, staleTime: 60_000 })
  return session !== null || (me.data !== undefined && me.data !== null)
}
