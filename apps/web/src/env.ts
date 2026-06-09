import type { DocDO, SearchDO } from '@glyphdown/sync'

/**
 * Worker bindings + secrets this app reads. Bindings (DB, DocDO) come from
 * wrangler.jsonc; the string values are secrets supplied via `.dev.vars`
 * locally (see `.dev.vars.example`) and `wrangler secret put` in production.
 *
 * `worker-configuration.d.ts` (wrangler types) covers the bindings; secrets
 * are typed here because they are intentionally absent from wrangler.jsonc.
 */
export interface AppEnv {
  DB: D1Database
  /** R2 bucket for doc/folder image assets (wrangler.jsonc r2_buckets). */
  ASSETS: R2Bucket
  DocDO: DurableObjectNamespace<DocDO>
  /** Single global search index DO (full-text + wiki-link backlinks). */
  SearchDO: DurableObjectNamespace<SearchDO>
  BETTER_AUTH_SECRET?: string
  BETTER_AUTH_URL?: string
  GITHUB_CLIENT_ID?: string
  GITHUB_CLIENT_SECRET?: string
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  /**
   * Resend API key for outbound email (invites, mention notifications).
   * OPTIONAL — when unset the app logs would-be emails and every flow still
   * completes (the share dialog offers copy-link instead).
   */
  RESEND_API_KEY?: string
  /** From header, e.g. `Glyphdown <invites@glyphdown.com>` (must be a Resend-verified domain). */
  EMAIL_FROM?: string
  /**
   * PostHog project API key for SERVER-side capture (cli_push + Worker error
   * reporting). OPTIONAL — when unset all server capture no-ops silently.
   * The browser side uses VITE_POSTHOG_KEY (a vite build-time env var), not this.
   */
  POSTHOG_KEY?: string
  /** PostHog ingestion host; defaults to https://us.i.posthog.com when unset. */
  POSTHOG_HOST?: string
}

/** Cast helper for the `cloudflare:workers` env import. */
export function asAppEnv(env: unknown): AppEnv {
  return env as AppEnv
}
