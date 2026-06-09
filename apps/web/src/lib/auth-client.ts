import { deviceAuthorizationClient } from 'better-auth/client/plugins'
import { createAuthClient } from 'better-auth/react'

/**
 * Browser-side better-auth client. Same-origin (the auth handler is mounted
 * at /api/auth/* in server.ts), so no baseURL needed.
 *
 * deviceAuthorizationClient powers /device: GET /device (claim a user code
 * for the signed-in user) + POST /device/approve | /device/deny.
 */
export const authClient = createAuthClient({
  plugins: [deviceAuthorizationClient()],
})
