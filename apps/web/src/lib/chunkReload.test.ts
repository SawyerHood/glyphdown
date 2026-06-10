// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { installChunkReloadHandler } from './chunkReload.ts'

// Same trick as nux.test.ts: node's experimental webstorage leaks a stub
// without Storage methods; install a real in-memory sessionStorage.
const store = new Map<string, string>()
Object.defineProperty(window, 'sessionStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  },
})

const reload = vi.fn()
Object.defineProperty(window, 'location', {
  configurable: true,
  value: { ...window.location, reload },
})

beforeAll(() => {
  // Once for the whole file — a second install would double the listener.
  installChunkReloadHandler()
})

beforeEach(() => {
  store.clear()
  reload.mockClear()
})

describe('installChunkReloadHandler', () => {
  it('reloads on the first preload error, then guards against a loop', () => {
    const first = new Event('vite:preloadError', { cancelable: true })
    window.dispatchEvent(first)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(first.defaultPrevented).toBe(true)

    // A second failure right after the "reload" must surface, not cycle.
    const second = new Event('vite:preloadError', { cancelable: true })
    window.dispatchEvent(second)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(second.defaultPrevented).toBe(false)
  })

  it('reloads again once the loop window has passed', () => {
    store.set('glyphdown:chunk-reload-at', String(Date.now() - 60_000))
    window.dispatchEvent(new Event('vite:preloadError', { cancelable: true }))
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
