// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { dismissNux, isNuxDismissed, resetNux } from './nux.ts'

// Same trick as FileTreeShell.test.tsx: this vitest/jsdom combination exposes
// a stub window.localStorage without Storage methods (node's experimental
// webstorage leaks in); install a real in-memory one.
const store = new Map<string, string>()
Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  },
})

beforeEach(() => {
  store.clear()
})

describe('nux state', () => {
  it('starts undismissed, dismisses, and resets per user', () => {
    expect(isNuxDismissed('u1')).toBe(false)
    dismissNux('u1')
    expect(isNuxDismissed('u1')).toBe(true)
    expect(isNuxDismissed('u2')).toBe(false)
    resetNux('u1')
    expect(isNuxDismissed('u1')).toBe(false)
  })
})
