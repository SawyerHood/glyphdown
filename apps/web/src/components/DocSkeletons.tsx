import { PenLine } from 'lucide-react'

/**
 * Loading skeletons for the document editor surfaces.
 *
 * Kept deliberately lightweight (react + one lucide icon only): the doc route
 * imports `EditorShellSkeleton` for its SSR/cold-load shell, so nothing from
 * the client-only editor stack may leak in here.
 *
 * Anti-flash: bars carry `.skeleton-appear`, which keeps them invisible for
 * the first ~80ms (CSS animation-delay). If the real content lands faster
 * than that, the user never sees a skeleton — just a quiet paper surface.
 * Shimmer + appear animations are disabled under prefers-reduced-motion
 * (see styles.css).
 */

/** Prose line widths — varied so the ghost paragraph reads as text. `null` = paragraph break. */
const PROSE_LINES: ReadonlyArray<string | null> = [
  '96%',
  '100%',
  '88%',
  '62%',
  null,
  '92%',
  '100%',
  '97%',
  '74%',
  null,
  '99%',
  '91%',
  '83%',
]

/**
 * Ghost of the document column. Mirrors the live editor's column metrics
 * (`.cm-content`: max-width 65ch, centered, 40px top padding, 20px gutters —
 * see styles.css) so the skeleton → content crossfade causes no layout shift.
 */
export function DocumentSkeleton() {
  return (
    <div aria-hidden className="h-full overflow-hidden bg-[var(--paper)]">
      <div className="skeleton-appear mx-auto max-w-[65ch] px-5 pt-10">
        {/* Title-width bar (mirrors the H1 line) */}
        <div className="skeleton-bar mb-8 h-7 w-1/2" />
        {PROSE_LINES.map((width, i) =>
          width === null ? (
            <div key={i} className="h-4" />
          ) : (
            <div key={i} className="skeleton-bar mb-3 h-4" style={{ width }} />
          ),
        )}
      </div>
    </div>
  )
}

/**
 * Full-page shell for true cold loads only (SSR shell + the one-time dynamic
 * import of the editor stack). Mirrors the editor chrome: same h-12 toolbar
 * frame and document column as DocEditorPage, so hydration swaps content
 * inside a stable frame instead of flashing a spinner.
 */
export function EditorShellSkeleton() {
  return (
    <div className="flex h-screen flex-col bg-[var(--bg-base)]">
      <header className="z-40 flex h-12 shrink-0 items-center gap-2 border-b border-[var(--line)] bg-[var(--paper)] px-3">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-[var(--accent)] text-white">
          <PenLine size={13} />
        </span>
        <div aria-hidden className="skeleton-appear skeleton-bar h-3.5 w-36" />
      </header>
      <div className="min-h-0 flex-1">
        <DocumentSkeleton />
      </div>
    </div>
  )
}

/**
 * Ghost rows for the sidebar panels (comments / suggestions / backlinks).
 * Rendered only while the backing query is actually loading — cached docs
 * render their real rows instantly and never see this.
 */
export function PanelSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div aria-hidden className="skeleton-appear flex flex-col gap-3 p-4">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex flex-col gap-2 rounded-lg border border-[var(--line)] p-3">
          <div className="flex items-center gap-2">
            <div className="skeleton-bar h-6 w-6 rounded-full" />
            <div className="skeleton-bar h-3 w-24" />
          </div>
          <div className="skeleton-bar h-3 w-full" />
          <div className="skeleton-bar h-3 w-2/3" />
        </div>
      ))}
    </div>
  )
}
