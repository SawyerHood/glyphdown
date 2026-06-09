import {
  createStartHandler,
  defaultStreamHandler,
  type RequestHandler,
} from '@tanstack/react-start/server'
import type { Register } from '@tanstack/react-router'
import { createServerEntry } from '@tanstack/react-start/server-entry'
import { routePartykitRequest } from 'partyserver'
import { env, waitUntil } from 'cloudflare:workers'
import { createAuth } from './auth.ts'
import { asAppEnv } from './env.ts'
import { authenticate, trustedHeaders } from './api/auth.ts'
import { handleApi } from './api/router.ts'
import { captureServerException } from './analytics-server.ts'

// The Durable Object classes must be exported from the Worker's main module.
export { DocDO, SearchDO } from '@glyphdown/sync'

const startFetch: RequestHandler<Register> = createStartHandler(defaultStreamHandler)

export default createServerEntry({
  async fetch(request) {
    try {
      const url = new URL(request.url)

      // better-auth (sign-in/out, OAuth callbacks, session). Mounted BEFORE the
      // api router; the auth instance is constructed per request — D1 bindings
      // are per-invocation and a module singleton silently breaks on Workers.
      if (url.pathname.startsWith('/api/auth/')) {
        return await createAuth(asAppEnv(env)).handler(request)
      }

      // Public REST API (CLI + web UI): authenticated in the router, then
      // proxied to the per-document DO. Must run before the Start handler.
      if (url.pathname.startsWith('/api/')) {
        const apiResponse = await handleApi(request)
        if (apiResponse) return apiResponse
      }

      // Yjs sync websockets + DO-routed requests use PartyServer's URL
      // convention: /parties/doc-d-o/:docId. Authenticate, then forward with
      // trusted identity headers — the DO believes whatever we set here.
      if (url.pathname.startsWith('/parties/')) {
        const docId = url.pathname.split('/')[3]
        const auth = await authenticate(request, docId)
        if (!auth) return new Response('unauthorized', { status: 401 })
        const forwarded = new Request(request, { headers: trustedHeaders(auth, request.headers) })
        const response = await routePartykitRequest(forwarded, env as never)
        if (response) return response
      }

      return await startFetch(request)
    } catch (err) {
      // Error reporting only — the error is RETHROWN unchanged so the Worker
      // 500s exactly as before. Capture rides waitUntil (zero added latency)
      // and no-ops when POSTHOG_KEY is unset. Worker layer only by design:
      // DO errors surface here through their proxied calls when they 5xx.
      reportWorkerError(err, request)
      throw err
    }
  },
})

/** Background-capture a Worker-layer exception; never throws, never awaited. */
function reportWorkerError(err: unknown, request: Request): void {
  try {
    const task = captureServerException(
      err,
      { url: request.url, method: request.method },
      { env: asAppEnv(env) },
    )
    try {
      waitUntil(task)
    } catch {
      // Outside a request context (shouldn't happen) — let it float; the
      // capture itself never rejects.
      void task
    }
  } catch (captureErr) {
    console.error('[analytics] error capture failed:', captureErr)
  }
}
