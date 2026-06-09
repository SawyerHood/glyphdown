import { slugifyDocStem } from '@glyphdown/protocol'

/**
 * Doc-name input helpers (filesystem model: docs are named by slug filename
 * stems). `liveSlug` maps a name field AS THE USER TYPES — lowercase,
 * invalid runs to '-', no dash runs, no leading dash — but tolerates a
 * trailing dash so typing "my notes" feels natural mid-word. Commit the
 * final value through `slugifyDocStem` (protocol) to trim the edge.
 */
export function liveSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+/, '')
}

/**
 * Wiki-link target → comparable slug key. Same charset rules as
 * slugifyDocStem but WITHOUT the 'untitled' fallback: an unusable target
 * ('???') must not resolve to a doc that happens to be named `untitled`.
 */
export function wikiSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export { slugifyDocStem }
