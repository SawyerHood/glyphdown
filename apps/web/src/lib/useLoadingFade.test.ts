// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useLoadingFade } from './useLoadingFade.ts'

const FADE = 150

function setup(loading: boolean) {
  return renderHook(({ loading }: { loading: boolean }) => useLoadingFade(loading, FADE), {
    initialProps: { loading },
  })
}

describe('useLoadingFade', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts done when not loading (cached doc: no skeleton, no fade)', () => {
    const hook = setup(false)
    expect(hook.result.current).toBe('done')
    act(() => vi.advanceTimersByTime(FADE * 2))
    expect(hook.result.current).toBe('done')
  })

  it('starts loading when loading', () => {
    const hook = setup(true)
    expect(hook.result.current).toBe('loading')
  })

  it('stays loading while loading, regardless of elapsed time', () => {
    const hook = setup(true)
    act(() => vi.advanceTimersByTime(10_000))
    expect(hook.result.current).toBe('loading')
  })

  it('crossfades for fadeMs once loading completes, then settles', () => {
    const hook = setup(true)
    hook.rerender({ loading: false })
    expect(hook.result.current).toBe('fading')
    act(() => vi.advanceTimersByTime(FADE - 1))
    expect(hook.result.current).toBe('fading')
    act(() => vi.advanceTimersByTime(1))
    expect(hook.result.current).toBe('done')
  })

  it('returns to loading on the same render a new load starts (doc switch covers frame one)', () => {
    const hook = setup(true)
    hook.rerender({ loading: false })
    act(() => vi.advanceTimersByTime(FADE))
    expect(hook.result.current).toBe('done')

    // Switch to an unsynced doc: must be 'loading' immediately.
    hook.rerender({ loading: true })
    expect(hook.result.current).toBe('loading')
  })

  it('cancels a pending fade if loading restarts mid-fade (hammering between docs)', () => {
    const hook = setup(true)
    hook.rerender({ loading: false })
    expect(hook.result.current).toBe('fading')

    // New load starts before the fade finished.
    hook.rerender({ loading: true })
    expect(hook.result.current).toBe('loading')
    act(() => vi.advanceTimersByTime(FADE * 2))
    expect(hook.result.current).toBe('loading')

    // And the next completion still runs a full fade.
    hook.rerender({ loading: false })
    expect(hook.result.current).toBe('fading')
    act(() => vi.advanceTimersByTime(FADE))
    expect(hook.result.current).toBe('done')
  })
})
