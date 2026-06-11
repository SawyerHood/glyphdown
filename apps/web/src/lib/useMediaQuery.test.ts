// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useIsMobile, useMediaQuery } from './useMediaQuery.ts'

type Listener = (e: { matches: boolean }) => void

function stubMatchMedia(initial: (query: string) => boolean) {
  const listeners = new Map<string, Set<Listener>>()
  const current = new Map<string, boolean>()
  vi.stubGlobal('matchMedia', (query: string) => {
    if (!current.has(query)) current.set(query, initial(query))
    return {
      get matches() {
        return current.get(query)!
      },
      media: query,
      addEventListener: (_: 'change', cb: Listener) => {
        if (!listeners.has(query)) listeners.set(query, new Set())
        listeners.get(query)!.add(cb)
      },
      removeEventListener: (_: 'change', cb: Listener) => {
        listeners.get(query)?.delete(cb)
      },
    }
  })
  return {
    set(query: string, matches: boolean) {
      current.set(query, matches)
      for (const cb of listeners.get(query) ?? []) cb({ matches })
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useMediaQuery', () => {
  it('reads the initial match and tracks change events', () => {
    const media = stubMatchMedia(() => true)
    const { result } = renderHook(() => useMediaQuery('(max-width: 1023.98px)'))
    expect(result.current).toBe(true)

    act(() => media.set('(max-width: 1023.98px)', false))
    expect(result.current).toBe(false)

    act(() => media.set('(max-width: 1023.98px)', true))
    expect(result.current).toBe(true)
  })

  it('falls back to false when matchMedia is unavailable (SSR/jsdom)', () => {
    vi.stubGlobal('matchMedia', undefined)
    const { result } = renderHook(() => useMediaQuery('(max-width: 1023.98px)'))
    expect(result.current).toBe(false)
  })

  it('useIsMobile mirrors the lg breakpoint query', () => {
    const seen: string[] = []
    stubMatchMedia((q) => {
      seen.push(q)
      return false
    })
    renderHook(() => useIsMobile())
    expect(seen[0]).toBe('(max-width: 1023.98px)')
  })
})
