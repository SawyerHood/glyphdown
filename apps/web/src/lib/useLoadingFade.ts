import { useEffect, useState } from 'react'

export type LoadingFadePhase = 'loading' | 'fading' | 'done'

export const LOADING_FADE_MS = 150

/**
 * Drives the skeleton → content crossfade for async surfaces (the doc editor
 * column while the Yjs provider syncs).
 *
 * - `loading` true  → 'loading' immediately, on the very same render (the
 *   overlay must cover the first frame after a doc switch — no stale-content
 *   or empty-editor flash).
 * - `loading` false → 'fading' for `fadeMs` (overlay transitions to opacity
 *   0 while the content fades in), then 'done' (overlay unmounts).
 *
 * The ~80ms "don't flash a skeleton for fast loads" delay is handled in CSS
 * (`.skeleton-appear`'s animation-delay), not here: during that window the
 * overlay is plain paper, so a fast sync shows no skeleton at all.
 */
export function useLoadingFade(loading: boolean, fadeMs: number = LOADING_FADE_MS): LoadingFadePhase {
  // True once the post-loading fade has finished.
  const [settled, setSettled] = useState(!loading)

  useEffect(() => {
    if (loading) {
      setSettled(false)
      return
    }
    const timer = setTimeout(() => setSettled(true), fadeMs)
    return () => clearTimeout(timer)
  }, [loading, fadeMs])

  if (loading) return 'loading'
  return settled ? 'done' : 'fading'
}
