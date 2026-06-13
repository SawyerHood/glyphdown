// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MAX_ASSET_BYTES, type AssetMeta, type DocMeta, type FolderMeta, type UploadAssetResponse } from '@glyphdown/protocol'
import { DOC_DRAG_MIME, FOLDER_DRAG_MIME } from '../FileTree.tsx'

const h = vi.hoisted(() => ({
  docs: [] as DocMeta[],
  folders: [] as FolderMeta[],
  assets: [] as AssetMeta[],
  createdDoc: null as DocMeta | null,
  createDoc: vi.fn(),
  pushDocContent: vi.fn(),
  uploadFolderAsset: vi.fn(),
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
  Link: ({
    children,
    to,
    params,
    search,
    className,
    title,
  }: {
    children?: ReactNode
    to: unknown
    params?: unknown
    search?: unknown
    className?: string
    title?: string
  }) => createElement('a', { href: hrefFor(to, params, search), className, title }, children),
  useNavigate: () => () => {},
}))

vi.mock('../../lib/api.ts', () => {
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
    createDoc: h.createDoc,
    createFolder: vi.fn(),
    deleteDoc: vi.fn(),
    deleteFolder: vi.fn(),
    deleteFolderAsset: vi.fn(),
    folderAssetUrl: (folderId: string, filename: string) =>
      `/api/folders/${encodeURIComponent(folderId)}/assets/${encodeURIComponent(filename)}`,
    listDocs: () => Promise.resolve(h.docs),
    listFolderAssets: () => Promise.resolve(h.assets),
    listFolders: () => Promise.resolve(h.folders),
    moveFolder: vi.fn(),
    patchDoc: vi.fn(),
    pushDocContent: h.pushDocContent,
    renameFolder: vi.fn(),
    uploadFolderAsset: h.uploadFolderAsset,
  }
})

vi.mock('../../lib/analytics.ts', () => ({ track: vi.fn() }))
vi.mock('../VaultSwitcher.tsx', () => ({ default: () => createElement('span', null, 'Vault') }))

import FileBrowser from './FileBrowser.tsx'

function folder(id: string, name: string, parentId: string | null, role: FolderMeta['role']): FolderMeta {
  return {
    id,
    name,
    kind: parentId === null ? 'vault' : 'folder',
    parentId,
    ownerUserId: 'user-1',
    role,
    createdAt: 1,
  }
}

function doc(id: string, title: string, folderId: string, role: DocMeta['role'] = 'owner'): DocMeta {
  return {
    id,
    title,
    filename: `${title}.md`,
    folderId,
    ownerUserId: 'user-1',
    role,
    createdAt: 1,
    updatedAt: 2,
  }
}

function upload(filename: string, contentType: string): UploadAssetResponse {
  return {
    path: filename,
    asset: {
      id: `asset-${filename}`,
      filename,
      contentType,
      size: 1,
      etag: `etag-${filename}`,
      createdBy: 'user-1',
      createdAt: 1,
    },
  }
}

function renderBrowser(folderRole: FolderMeta['role'] = 'owner') {
  h.folders = [folder('vault-1', 'Vault', null, 'owner'), folder('folder-1', 'Folder', 'vault-1', folderRole)]
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(createElement(QueryClientProvider, { client }, createElement(FileBrowser, { folderId: 'folder-1' })))
}

async function browserMain(): Promise<HTMLElement> {
  await screen.findByText('Folder')
  const main = document.querySelector('main')
  expect(main).not.toBeNull()
  return main!
}

function file(name: string, type: string, body = 'body'): File {
  return new File([body], name, { type })
}

function oversizeFile(name: string, type: string): File {
  const f = file(name, type)
  Object.defineProperty(f, 'size', { configurable: true, value: MAX_ASSET_BYTES + 1 })
  return f
}

function dragData(files: readonly File[], types: readonly string[] = ['Files']) {
  return {
    dataTransfer: {
      types: [...types],
      files,
      dropEffect: 'none',
      effectAllowed: 'all',
      getData: vi.fn(() => ''),
      setData: vi.fn(),
    },
  }
}

async function dropFiles(files: readonly File[], types?: readonly string[]) {
  const main = await browserMain()
  fireEvent.dragEnter(main, dragData(files, types))
  fireEvent.drop(main, dragData(files, types))
}

beforeEach(() => {
  h.docs = []
  h.folders = []
  h.assets = []
  h.createdDoc = doc('created-doc', 'notes', 'folder-1')
  h.createDoc.mockResolvedValue(h.createdDoc)
  h.pushDocContent.mockResolvedValue({ ok: true, rev: 1 })
  h.uploadFolderAsset.mockImplementation((_folderId: string, filename: string, blob: Blob) =>
    Promise.resolve(upload(filename, blob.type)),
  )
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('FileBrowser OS file dropzone', () => {
  it('routes a mixed drop to image, HTML, and markdown imports with one summary toast', async () => {
    renderBrowser('owner')

    await dropFiles([
      file('chart.png', 'image/png'),
      file('page.html', 'text/html', '<h1>Page</h1>'),
      file('notes.md', 'text/markdown', '# Notes'),
      file('archive.zip', 'application/zip'),
    ])

    await waitFor(() => expect(h.uploadFolderAsset).toHaveBeenCalledTimes(2))
    expect(h.uploadFolderAsset.mock.calls[0]![0]).toBe('folder-1')
    expect(h.uploadFolderAsset.mock.calls[0]![1]).toBe('chart.png')
    expect((h.uploadFolderAsset.mock.calls[0]![2] as Blob).type).toBe('image/png')
    expect(h.uploadFolderAsset.mock.calls[1]![0]).toBe('folder-1')
    expect(h.uploadFolderAsset.mock.calls[1]![1]).toBe('page.html')
    expect((h.uploadFolderAsset.mock.calls[1]![2] as Blob).type).toBe('text/html')
    expect(h.createDoc).toHaveBeenCalledWith({ filename: 'notes', folderId: 'folder-1' })
    expect(h.pushDocContent).toHaveBeenCalledWith('created-doc', '# Notes')
    expect((await screen.findByRole('status')).textContent).toContain(
      'Uploaded 1 image · Uploaded 1 HTML file · Imported 1 doc · skipped 1 unsupported file',
    )
  })

  it('accepts a drop anywhere on the page, not just over the list', async () => {
    renderBrowser('owner')
    await browserMain() // ensure mounted before dropping outside <main>

    // document.body sits outside the file list; the window-level listeners
    // should still catch the drop.
    fireEvent.dragEnter(document.body, dragData([file('chart.png', 'image/png')]))
    fireEvent.drop(document.body, dragData([file('chart.png', 'image/png')]))

    await waitFor(() => expect(h.uploadFolderAsset).toHaveBeenCalledTimes(1))
    expect(h.uploadFolderAsset.mock.calls[0]![1]).toBe('chart.png')
  })

  it('uses the HTML asset path for extension-only HTML files', async () => {
    renderBrowser('owner')

    await dropFiles([file('page.htm', '', '<p>Page</p>')])

    await waitFor(() => expect(h.uploadFolderAsset).toHaveBeenCalledTimes(1))
    expect(h.uploadFolderAsset).toHaveBeenCalledWith('folder-1', 'page.htm', expect.any(Blob))
    expect((h.uploadFolderAsset.mock.calls[0]![2] as Blob).type).toBe('text/html')
    expect((await screen.findByRole('status')).textContent).toContain('Uploaded 1 HTML file')
  })

  it('ignores internal doc and folder drags even when the event also carries Files', async () => {
    renderBrowser('owner')

    await dropFiles([file('chart.png', 'image/png')], ['Files', DOC_DRAG_MIME])
    await dropFiles([file('notes.md', 'text/markdown', '# Notes')], ['Files', FOLDER_DRAG_MIME])

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(h.uploadFolderAsset).not.toHaveBeenCalled()
    expect(h.createDoc).not.toHaveBeenCalled()
    expect(h.pushDocContent).not.toHaveBeenCalled()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('skips viewer and commenter drops without calling upload or doc import APIs', async () => {
    for (const role of ['viewer', 'commenter'] as const) {
      cleanup()
      vi.clearAllMocks()
      renderBrowser(role)

      await dropFiles([file('chart.png', 'image/png'), file('notes.md', 'text/markdown', '# Notes')])

      expect((await screen.findByRole('status')).textContent).toContain('skipped 2 files without permission')
      expect(h.uploadFolderAsset).not.toHaveBeenCalled()
      expect(h.createDoc).not.toHaveBeenCalled()
      expect(h.pushDocContent).not.toHaveBeenCalled()
    }
  })

  it('lets a non-owner editor drop assets but skips markdown doc import', async () => {
    renderBrowser('editor')

    await dropFiles([
      file('chart.png', 'image/png'),
      file('page.html', 'text/html', '<h1>Page</h1>'),
      file('notes.md', 'text/markdown', '# Notes'),
    ])

    await waitFor(() => expect(h.uploadFolderAsset).toHaveBeenCalledTimes(2))
    expect(h.createDoc).not.toHaveBeenCalled()
    expect(h.pushDocContent).not.toHaveBeenCalled()
    expect((await screen.findByRole('status')).textContent).toContain(
      'Uploaded 1 image · Uploaded 1 HTML file · skipped 1 file without permission',
    )
  })

  it('skips oversize files client-side', async () => {
    renderBrowser('owner')

    await dropFiles([oversizeFile('huge.png', 'image/png')])

    expect((await screen.findByRole('status')).textContent).toContain('skipped 1 oversize file')
    expect(h.uploadFolderAsset).not.toHaveBeenCalled()
    expect(h.createDoc).not.toHaveBeenCalled()
    expect(h.pushDocContent).not.toHaveBeenCalled()
  })
})
