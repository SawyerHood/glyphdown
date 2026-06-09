import { createServerFn } from '@tanstack/react-start'
import { authClient } from './auth-client.ts'

/**
 * Session access for the UI layer.
 *
 * - `useSession()` — reactive client hook (better-auth store).
 * - `getServerSession()` — server function used by route guards (works during
 *   SSR and client navigation).
 *
 * Synchronous (flash-free) session reads from router context live in
 * lib/sessionGate.ts — kept out of this module so client unit tests can
 * import them without dragging the worker-only server-function graph along.
 */

export const useSession = authClient.useSession

export function signOut() {
  return authClient.signOut()
}

export interface SessionUser {
  id: string
  name: string
  email: string
  image: string | null
}

export const getServerSession = createServerFn({ method: 'GET' }).handler(
  async (): Promise<{ user: SessionUser } | null> => {
    // Dynamic imports keep worker-only modules out of the client graph.
    const [{ getRequest }, { env }, { createAuth }, { asAppEnv }] = await Promise.all([
      import('@tanstack/react-start/server'),
      import('cloudflare:workers'),
      import('../auth.ts'),
      import('../env.ts'),
    ])
    const auth = createAuth(asAppEnv(env))
    const session = await auth.api.getSession({ headers: getRequest().headers })
    if (!session) return null
    const { id, name, email, image } = session.user
    return { user: { id, name, email, image: image ?? null } }
  },
)
