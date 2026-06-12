import { useEffect, useState } from 'react'

/**
 * Subscribe to a CSS media query. SSR-safe: the server (and any environment
 * without matchMedia, e.g. jsdom without a shim) renders the `false` branch
 * and the first client effect corrects it.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false,
  )

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(query)
    const onChange = () => setMatches(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])

  return matches
}

/**
 * Narrow-viewport check for behavior (not styling — use `lg:` classes there).
 * Mirrors Tailwind's `lg` breakpoint, the same cutoff FileTreeShell uses to
 * switch the file tree from push-aside to overlay.
 */
export function useIsMobile(): boolean {
  return useMediaQuery('(max-width: 1023.98px)')
}
