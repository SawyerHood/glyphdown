// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { AssetMeta, DocMeta, FolderListingFolderMeta } from '@glyphdown/protocol'

const h = vi.hoisted(() => ({
  routerState: {
    location: { pathname: '/' },
    matches: [{ context: { session: { user: { id: 'user-1' } } } }],
  },
  docs: [] as DocMeta[],
  folders: [] as FolderListingFolderMeta[],
  assets: [] as AssetMeta[],
}))

function hrefFor(to: unknown, params: unknown, search: unknown): string {
  let path = String(to)
  for (const [key, value] of Object.entries((params ?? {}) as Record<string, string>)) {
    path = path.replace(`$${key}`, encodeURIComponent(value))
  }
  const query = new URLSearchParams((search ?? {}) as Record<string, string>).toString()
  return query ? `${path}?${query}` : path
}

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({
    ...opts,
    useParams: () => ({ folderId: 'f1', filename: 'page.html' }),
    useSearch: () => ({}),
    useRouteContext: () => ({ session: h.routerState.matches[0]!.context.session }),
    useNavigate: () => () => {},
  }),
  Link: ({
    children,
    to,
    params,
    search,
    className,
    title,
    ...props
  }: {
    children?: ReactNode
    to: unknown
    params?: unknown
    search?: unknown
    className?: string
    title?: string
    [key: string]: unknown
  }) =>
    createElement(
      'a',
      {
        href: hrefFor(to, params, search),
        className,
        title,
        download: props['download'] as string | undefined,
        target: props['target'] as string | undefined,
        rel: props['rel'] as string | undefined,
      },
      children,
    ),
  useNavigate: () => () => {},
  useRouterState: ({ select }: { select: (s: typeof h.routerState) => unknown }) => select(h.routerState),
}))

vi.mock('../lib/api.ts', () => {
  class ApiError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
    ) {
      super(code)
    }
  }
  return {
    ApiError,
    addFolderMember: vi.fn(),
    assetUrl: () => '',
    createFolderInvite: vi.fn(),
    createFolderShareLink: vi.fn(),
    createDoc: vi.fn(),
    createFolder: vi.fn(),
    createVault: vi.fn(),
    deleteAsset: vi.fn(),
    deleteDoc: vi.fn(),
    deleteFolder: vi.fn(),
    deleteFolderAsset: vi.fn(),
    deleteVault: vi.fn(),
    fetchMe: () => Promise.resolve(null),
    folderAssetUrl: (folderId: string, filename: string, share?: string) =>
      `/api/folders/${encodeURIComponent(folderId)}/assets/${encodeURIComponent(filename)}${share ? `?share=${encodeURIComponent(share)}` : ''}`,
    getDoc: vi.fn(),
    getFolderListing: vi.fn(),
    listAssets: vi.fn(),
    listDocs: () => Promise.resolve(h.docs),
    listFolderAssets: () => Promise.resolve(h.assets),
    listFolderInvites: vi.fn(),
    listFolderMembers: vi.fn(),
    listFolderShareLinks: vi.fn(),
    listFolders: () => Promise.resolve(h.folders),
    moveFolder: vi.fn(),
    patchDoc: vi.fn(),
    renameFolder: vi.fn(),
    removeFolderMember: vi.fn(),
    revokeFolderShareLink: vi.fn(),
    revokeInvite: vi.fn(),
    uploadFolderAsset: vi.fn(),
  }
})

vi.mock('../lib/analytics.ts', () => ({ track: vi.fn() }))

import FileBrowser from '../components/browser/FileBrowser.tsx'
import { SubtreeBrowser } from './f.$folderId.tsx'
import { HtmlAssetViewerChrome } from './f.$folderId_.file.$filename.tsx'

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

function folder(id: string, name: string, parentId: string | null, role = 'viewer', assets: AssetMeta[] = []): FolderListingFolderMeta {
  return {
    id,
    name,
    kind: parentId === null ? 'vault' : 'folder',
    parentId,
    ownerUserId: 'user-1',
    role: role as FolderListingFolderMeta['role'],
    createdAt: 1,
    assets,
  }
}

function doc(id: string, title: string, folderId: string): DocMeta {
  return {
    id,
    title,
    filename: `${title}.md`,
    folderId,
    ownerUserId: 'user-1',
    role: 'viewer',
    createdAt: 1,
    updatedAt: 2,
  }
}

function renderWithQuery(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(createElement(QueryClientProvider, { client }, ui))
}

beforeEach(() => {
  h.docs = []
  h.folders = []
  h.assets = []
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('HTML asset viewer', () => {
  it('uses an opaque-origin scripts-only sandbox and propagates share tokens to raw URLs', () => {
    const { container } = render(
      createElement(HtmlAssetViewerChrome, {
        folderId: 'sub',
        filename: 'report.html',
        folderName: 'Subfolder',
        share: 'tok-v1',
        asset: asset('a-html', 'report.html', 'text/html'),
      }),
    )

    const iframe = screen.getByTitle('report.html') as HTMLIFrameElement
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts')
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-same-origin')
    expect(iframe.getAttribute('src')).toBe('/api/folders/sub/assets/report.html?share=tok-v1')

    const rawLinks = [...container.querySelectorAll('a')].filter((a) => a.getAttribute('href') === '/api/folders/sub/assets/report.html?share=tok-v1')
    expect(rawLinks.length).toBe(2)
  })
})

describe('HTML asset listing rows', () => {
  it('renders HTML assets in the share-link folder listing and carries the share token to the viewer link', () => {
    const html = asset('a-html', 'report.html', 'text/html')
    const image = asset('a-img', 'chart.png', 'image/png')
    const root = folder('v1', 'Vault', null, 'viewer')
    const current = folder('sub', 'Subfolder', 'v1', 'viewer', [image, html])

    render(
      createElement(SubtreeBrowser, {
        root,
        current,
        all: [root, current],
        docs: [doc('d1', 'notes', 'sub')],
        share: 'tok-v1',
      }),
    )

    const htmlLink = screen.getByText('report.html').closest('a')
    expect(htmlLink?.getAttribute('href')).toBe('/f/sub/file/report.html?share=tok-v1')
    expect(screen.queryByText('chart.png')).toBeNull()
  })

  it('renders HTML assets in the authenticated folder browser and shows editor upload affordance', async () => {
    h.folders = [folder('v1', 'Vault', null, 'owner'), folder('f1', 'Folder', 'v1', 'editor')]
    h.docs = [doc('d1', 'notes', 'f1')]
    h.assets = [asset('a-img', 'chart.png', 'image/png'), asset('a-html', 'page.html', 'text/html')]

    const { container } = renderWithQuery(createElement(FileBrowser, { folderId: 'f1' }))

    await waitFor(() => expect(screen.getByText('page.html')).toBeTruthy())
    const htmlLink = screen.getByText('page.html').closest('a')
    expect(htmlLink?.getAttribute('href')).toBe('/f/f1/file/page.html')
    expect(screen.getByText('chart.png')).toBeTruthy()
    expect(container.textContent).toContain('Upload HTML')
  })
})
