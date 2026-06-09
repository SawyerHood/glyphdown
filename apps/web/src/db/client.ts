import { drizzle } from 'drizzle-orm/d1'
import * as schema from './schema.ts'

/**
 * Drizzle over the per-invocation D1 binding. Always construct from the
 * current request's env — never cache across requests (Workers bindings are
 * per-invocation; the same rule that mandates per-request better-auth).
 */
export function createDb(d1: D1Database) {
  return drizzle(d1, { schema })
}

export type Db = ReturnType<typeof createDb>
