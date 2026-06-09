import { CliError } from './errors.ts'

/**
 * `<doc>` accepts a doc id or a doc URL (https://server/d/:docId[...]).
 * Unique-title-prefix resolution (SPEC §8.2) is a follow-up — it needs a
 * server-side search endpoint.
 */
export function parseDocRef(ref: string): string {
  if (!/^https?:\/\//i.test(ref)) return ref
  let url: URL
  try {
    url = new URL(ref)
  } catch {
    throw new CliError(1, `not a valid doc URL: ${ref}`)
  }
  const match = url.pathname.match(/\/d\/([^/]+)/)
  if (match?.[1]) return match[1]
  const segments = url.pathname.split('/').filter(Boolean)
  const last = segments[segments.length - 1]
  if (last) return last
  throw new CliError(1, `cannot extract a doc id from URL: ${ref}`)
}
