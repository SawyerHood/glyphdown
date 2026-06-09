import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { bearer, deviceAuthorization } from 'better-auth/plugins'
import { tanstackStartCookies } from 'better-auth/tanstack-start'
import { createDb } from './db/client.ts'
import * as schema from './db/schema.ts'
import type { AppEnv } from './env.ts'

/** client_id the `glyphdown` CLI sends on /device/code and /device/token. */
export const DEVICE_CLIENT_ID = 'glyphdown-cli'
/** Pre-rename client_id — still accepted so old `ink` binaries can sign in. */
export const DEVICE_CLIENT_ID_LEGACY = 'ink-cli'

/**
 * Per-request better-auth instance. NEVER hoist this into a module singleton:
 * D1 bindings are per-invocation on Workers and a cached instance silently
 * breaks under write contention (30s hangs — see docs/research.md webapp).
 *
 * cookieCache stays off (better-auth #4203; re-verify before enabling).
 */
export function createAuth(env: AppEnv) {
  const db = createDb(env.DB)
  return betterAuth({
    database: drizzleAdapter(db, {
      provider: 'sqlite',
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
        deviceCode: schema.deviceCode,
      },
    }),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    socialProviders: {
      github: {
        clientId: env.GITHUB_CLIENT_ID ?? '',
        clientSecret: env.GITHUB_CLIENT_SECRET ?? '',
      },
      google: {
        clientId: env.GOOGLE_CLIENT_ID ?? '',
        clientSecret: env.GOOGLE_CLIENT_SECRET ?? '',
      },
    },
    // Cookie plugin must stay last (better-auth warns otherwise). It is a
    // no-op outside a TanStack Start server-function context — the /api/auth
    // handler mount sets cookies on its own Response.
    plugins: [
      // RFC 8628 device flow for `glyphdown login`: POST /api/auth/device/code,
      // poll POST /api/auth/device/token; humans approve at /device (the
      // verification_uri resolves against the app origin, not /api/auth).
      deviceAuthorization({
        expiresIn: '15m',
        interval: '5s',
        verificationUri: '/device',
        validateClient: (clientId) => clientId === DEVICE_CLIENT_ID || clientId === DEVICE_CLIENT_ID_LEGACY,
        // 1.6.14 quirk: the options zod schema requires `schema` to be
        // present (z.custom without .optional()); {} = default model/fields.
        schema: {},
      }),
      // Lets `Authorization: Bearer <session token>` (the device-flow
      // access_token) authenticate auth.api.getSession + /api/auth routes.
      // Tokens are HMAC-verified against the secret before being trusted.
      bearer(),
      tanstackStartCookies(),
    ],
  })
}

export type Auth = ReturnType<typeof createAuth>
