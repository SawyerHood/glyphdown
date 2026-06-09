import { DOC_FILENAME_RE, docFilenameStem, normalizeDocFilename } from '@glyphdown/protocol'

/**
 * Pure doc-filename request parsing + allocation (unit-tested in
 * filenames.test.ts). The filesystem model: `filename` is the doc's canonical
 * name — a slug ending in `.md`, unique among live docs in its scope (its
 * folder, or the owner's root). `title` is derived (the stem) and only kept
 * for back-compat.
 */

/**
 * POST /api/docs name resolution — lenient: an explicit `filename` wins and
 * is normalized (slugified) rather than rejected; a bare `title` is slugified
 * into a filename; neither yields `untitled.md`. Creation never fails on a
 * name (scope collisions are suffixed by the caller via availableFilename).
 */
export function filenameForCreate(payload: { filename?: unknown; title?: unknown } | null): string {
  if (typeof payload?.filename === 'string' && payload.filename.trim() !== '') {
    return normalizeDocFilename(payload.filename)
  }
  if (typeof payload?.title === 'string' && payload.title.trim() !== '') {
    return normalizeDocFilename(payload.title)
  }
  return 'untitled.md'
}

/**
 * PATCH /api/docs/:id rename parsing. Returns:
 *  - null     — no rename requested (neither key present),
 *  - 'invalid'— a rename was requested but the value is unusable,
 *  - string   — the validated `<slug>.md` to store.
 * `filename` is STRICT (the web UI gives live slug feedback, the CLI
 * pre-slugifies — a non-slug here is a caller bug): with or without the
 * `.md`, the stem must already match [a-z0-9][a-z0-9-]*. Legacy `title`
 * payloads are slugified instead, so old clients keep working.
 */
export function filenameFromPatch(payload: { filename?: unknown; title?: unknown }): string | 'invalid' | null {
  if (payload.filename !== undefined) {
    if (typeof payload.filename !== 'string') return 'invalid'
    const withExt = payload.filename.endsWith('.md') ? payload.filename : `${payload.filename}.md`
    // Already-canonical names are exactly the fixed points of normalization
    // (this also rejects dash runs / edge dashes the RE alone would let by).
    return DOC_FILENAME_RE.test(withExt) && normalizeDocFilename(withExt) === withExt ? withExt : 'invalid'
  }
  if (payload.title !== undefined) {
    if (typeof payload.title !== 'string' || payload.title.trim() === '') return 'invalid'
    return normalizeDocFilename(payload.title)
  }
  return null
}

/**
 * First free name: `base`, else `<stem>-2.md`, `<stem>-3.md`, … against the
 * scope's taken set. Deterministic given the same inputs — the same -N
 * suffixing the backfill migration and the CLI's local allocator use.
 */
export function availableFilename(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base
  const stem = docFilenameStem(base)
  for (let n = 2; ; n++) {
    const candidate = `${stem}-${n}.md`
    if (!taken.has(candidate)) return candidate
  }
}
