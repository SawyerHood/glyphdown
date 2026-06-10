/**
 * Vitest stand-in for the `cloudflare:workers` module (aliased in
 * vitest.config.ts — node's ESM loader cannot resolve the cloudflare:
 * scheme). Tests mutate `env`'s properties to inject fake bindings
 * (router.test.ts); modules read it lazily per request, so per-test
 * assignment is race-free.
 */
export const env: Record<string, unknown> = {}

export function waitUntil(promise: Promise<unknown>): void {
  // Detach like the runtime does; swallow rejections so fire-and-forget
  // best-effort tasks (search index feeds) never fail a test.
  void Promise.resolve(promise).catch(() => {})
}

/** Base class partyserver's Server extends — never instantiated in tests. */
export class DurableObject {
  constructor(
    public ctx: unknown,
    public env: unknown,
  ) {}
}
