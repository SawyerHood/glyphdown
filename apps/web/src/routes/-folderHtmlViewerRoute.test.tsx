// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router'
import type { AssetMeta, FolderListingResponse } from '@glyphdown/protocol'

const h = vi.hoisted(() => ({
  listing: null as FolderListingResponse | null,
}))

vi.mock('../lib/api.ts', async () => {
  const actual = await vi.importActual<typeof import('../lib/api.ts')>('../lib/api.ts')
  return {
    ...actual,
    fetchMe: vi.fn(() => Promise.resolve(null)),
    getFolderListing: vi.fn(() => {
      if (h.listing === null) throw new actual.ApiError(404, 'not-found')
      return Promise.resolve(h.listing)
    }),
    listDocs: vi.fn(() => Promise.resolve([])),
    listFolderAssets: vi.fn(() => Promise.resolve([])),
    listFolders: vi.fn(() => Promise.resolve([])),
    listNotifications: vi.fn(() => Promise.resolve([])),
    searchDocs: vi.fn(() => Promise.resolve([])),
  }
})

vi.mock('../lib/session.ts', () => ({
  getServerSession: vi.fn(() => Promise.resolve(null)),
  signOut: vi.fn(() => Promise.resolve()),
  useSession: () => ({ data: null }),
}))

vi.mock('../lib/analytics.ts', () => ({
  identifyUser: vi.fn(),
  initAnalytics: vi.fn(),
  track: vi.fn(),
  trackPageview: vi.fn(),
}))

vi.mock('../lib/chunkReload.ts', () => ({
  installChunkReloadHandler: vi.fn(),
}))

import { routeTree } from '../routeTree.gen.ts'

function asset(id: string, filename: string, contentType: string): AssetMeta {
  return {
    id,
    filename,
    contentType,
    size: 10,
    etag: `etag-${id}`,
    createdBy: 'user-1',
    createdAt: 1,
  }
}

beforeEach(() => {
  h.listing = {
    folder: {
      id: 'f1',
      name: 'Shared Folder',
      kind: 'folder',
      parentId: 'v1',
      ownerUserId: 'user-1',
      role: 'viewer',
      createdAt: 1,
      assets: [asset('a-html', 'page.html', 'text/html')],
    },
    folders: [],
    docs: [],
  }

  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
  Element.prototype.scrollIntoView = vi.fn()
  window.scrollTo = vi.fn()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('folder HTML viewer route', () => {
  it('mounts the sandboxed iframe viewer at /f/:folderId/file/:filename and propagates share tokens', async () => {
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ['/f/f1/file/page.html?share=tok-v1'] }),
      defaultPreload: 'intent',
      defaultPreloadStaleTime: 0,
      scrollRestoration: false,
    })

    render(createElement(RouterProvider, { router }))

    await waitFor(() => expect(screen.getByTitle('page.html')).toBeTruthy())

    const iframe = screen.getByTitle('page.html') as HTMLIFrameElement
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts')
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-same-origin')
    expect(iframe.getAttribute('src')).toBe('/api/folders/f1/assets/page.html?share=tok-v1')
  })
})
