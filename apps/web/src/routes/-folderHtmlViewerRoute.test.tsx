// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router'
import type { AssetMeta, Comment, FolderListingResponse, NodeAnchor, Principal } from '@glyphdown/protocol'

const h = vi.hoisted(() => ({
  listing: null as FolderListingResponse | null,
  comments: [] as Comment[],
  me: null as Principal | null,
}))

vi.mock('../lib/api.ts', async () => {
  const actual = await vi.importActual<typeof import('../lib/api.ts')>('../lib/api.ts')
  return {
    ...actual,
    fetchMe: vi.fn(() => Promise.resolve(h.me)),
    fetchFolderAssetCommentingView: vi.fn((_folderId: string, filename: string) =>
      Promise.resolve({ html: `<!doctype html><h1>${filename}</h1>`, nonce: 'nonce-test' }),
    ),
    getFolderListing: vi.fn(() => {
      if (h.listing === null) throw new actual.ApiError(404, 'not-found')
      return Promise.resolve(h.listing)
    }),
    listFolderAssetComments: vi.fn(() => Promise.resolve(h.comments)),
    listFolderMembers: vi.fn(() => Promise.resolve([])),
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

function nodeAnchor(label: string): NodeAnchor {
  return {
    schema: 1,
    path: [{ tag: 'body', nthOfType: 1 }, { tag: 'h1', nthOfType: 1 }],
    fingerprint: { tag: 'h1' },
    quote: { exact: 'Quarterly revenue', prefix: '', suffix: '' },
    domHint: 2,
    label,
    status: 'anchored',
  }
}

function comment(id: string, anchor: NodeAnchor): Comment {
  return {
    id,
    anchor: null,
    anchorKind: 'node',
    nodeAnchor: anchor,
    authorId: 'user-1',
    authorName: 'Ada',
    body: 'Check this total',
    createdAt: 1,
    resolved: false,
    reactions: {},
    replies: [],
  }
}

beforeEach(() => {
  h.comments = []
  h.me = null
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
  it('mounts the sandboxed iframe viewer at /f/:folderId/file/:filename without putting share tokens in the iframe URL', async () => {
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
    expect(iframe.getAttribute('src')).toBeNull()
    expect(iframe.getAttribute('srcdoc')).toContain('<h1>page.html</h1>')
    expect(iframe.getAttribute('srcdoc')).not.toContain('tok-v1')
  })

  it('opens a comments panel for node-anchored asset comments', async () => {
    h.me = { id: 'user-1', type: 'user', name: 'Ada' }
    h.comments = [comment('c1', nodeAnchor('h1 "Quarterly revenue"'))]
    h.listing = {
      folder: {
        id: 'f1',
        name: 'Shared Folder',
        kind: 'folder',
        parentId: 'v1',
        ownerUserId: 'user-1',
        role: 'commenter',
        createdAt: 1,
        assets: [asset('a-html', 'page.html', 'text/html')],
      },
      folders: [],
      docs: [],
    }

    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ['/f/f1/file/page.html?share=tok-comment'] }),
      defaultPreload: 'intent',
      defaultPreloadStaleTime: 0,
      scrollRestoration: false,
    })

    render(createElement(RouterProvider, { router }))

    await waitFor(() => expect(screen.getByTitle('page.html')).toBeTruthy())
    await waitFor(() => expect(screen.getByTitle('Comments').textContent).toContain('1'))

    // The comments panel is part of the desktop layout (matchMedia matches:false),
    // so it is open by default — no toggle click needed.
    expect(await screen.findByText('Check this total')).toBeTruthy()
    expect(screen.getByText('h1 "Quarterly revenue"')).toBeTruthy()
  })
})
