import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AssetMeta, AssetVersionMeta, Comment, DocMeta, PushResponse, ShareLinkRole, VersionMeta } from '@glyphdown/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Api, FolderMeta } from '../src/index.ts'
import { CliError, createProgram, readAssetState, sha256Hex, writeAssetState, writeFolderConfig, writePull } from '../src/index.ts'

const dirs: string[] = []
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ink-cmd-test-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const DOC: DocMeta = {
  id: 'doc1',
  filename: 'launch-plan.md',
  title: 'launch-plan',
  folderId: null,
  ownerUserId: 'u1',
  role: 'editor',
  createdAt: 1,
  updatedAt: 2,
}

const DOC_VERSION: VersionMeta = {
  id: 'ver1',
  createdAt: 3,
  name: 'before rewrite',
  authorIds: ['u1'],
  kind: 'named',
  sizeBytes: 10,
}

const ASSET_VERSION: AssetVersionMeta = {
  id: 'av1',
  assetId: 'asset-page',
  contentHash: 'hash1',
  size: 42,
  etag: 'etag1',
  createdBy: 'u1',
  createdAt: 4,
  message: 'initial upload',
  current: true,
}

function fakeApi(overrides: Partial<Api> = {}): Api {
  return {
    me: vi.fn(async () => ({ id: 'u1', type: 'user' as const, name: 'kirby' })),
    listDocs: vi.fn(async () => [DOC]),
    getDoc: vi.fn(async () => DOC),
    createDoc: vi.fn(async () => DOC),
    renameDoc: vi.fn(async () => DOC),
    deleteDoc: vi.fn(async () => undefined),
    listFolders: vi.fn(async () => []),
    getFolder: vi.fn(),
    createFolder: vi.fn(),
    listVaults: vi.fn(async () => []),
    getContent: vi.fn(async () => ({ text: '# Launch Plan\n\nShip it.\n', versionId: 'v1', baseHash: null })),
    push: vi.fn(async (): Promise<PushResponse> => ({ ok: true, mode: 'edit', applied: 1, failedHunks: [], versionId: 'v2' })),
    listComments: vi.fn(async () => [] as Comment[]),
    createComment: vi.fn(),
    replyToComment: vi.fn(),
    resolveComment: vi.fn(async () => undefined),
    listSuggestions: vi.fn(async () => []),
    listVersions: vi.fn(async () => [DOC_VERSION]),
    getVersionText: vi.fn(async () => '# Old\n'),
    createVersion: vi.fn(async () => DOC_VERSION),
    listDocShareLinks: vi.fn(async () => [{ token: 'tok1', role: 'viewer' as const, createdAt: 5 }]),
    createDocShareLink: vi.fn(async (_docId: string, role: ShareLinkRole) => ({ token: 'tok-new', role, createdAt: 6 })),
    revokeDocShareLink: vi.fn(async () => undefined),
    listFolderShareLinks: vi.fn(async () => [{ token: 'ftok1', role: 'editor' as const, createdAt: 7 }]),
    createFolderShareLink: vi.fn(async (_folderId: string, role: ShareLinkRole) => ({ token: 'ftok-new', role, createdAt: 8 })),
    revokeFolderShareLink: vi.fn(async () => undefined),
    listAssetShareLinks: vi.fn(async () => [{ token: 'atok1', role: 'commenter' as const, createdAt: 9 }]),
    createAssetShareLink: vi.fn(async (_folderId: string, _filename: string, role: ShareLinkRole) => ({ token: 'atok-new', role, createdAt: 10 })),
    revokeAssetShareLink: vi.fn(async () => undefined),
    listDocAssets: vi.fn(async () => []),
    listFolderAssets: vi.fn(async () => []),
    downloadDocAsset: vi.fn(async () => ({ data: new Uint8Array(), etag: null, contentType: null })),
    downloadFolderAsset: vi.fn(async () => ({ data: new Uint8Array(), etag: null, contentType: null })),
    uploadDocAsset: vi.fn(),
    uploadFolderAsset: vi.fn(),
    uploadAsset: vi.fn(),
    renameFolderAsset: vi.fn(),
    renameDocAsset: vi.fn(),
    deleteFolderAsset: vi.fn(async () => undefined),
    deleteDocAsset: vi.fn(async () => undefined),
    listDocAssetComments: vi.fn(async () => []),
    listFolderAssetComments: vi.fn(async () => []),
    createDocAssetComment: vi.fn(),
    createFolderAssetComment: vi.fn(),
    replyToDocAssetComment: vi.fn(),
    replyToFolderAssetComment: vi.fn(),
    resolveDocAssetComment: vi.fn(async () => undefined),
    resolveFolderAssetComment: vi.fn(async () => undefined),
    listDocAssetVersions: vi.fn(async () => [ASSET_VERSION]),
    listFolderAssetVersions: vi.fn(async () => [ASSET_VERSION]),
    nameDocAssetVersion: vi.fn(async () => ASSET_VERSION),
    nameFolderAssetVersion: vi.fn(async () => ASSET_VERSION),
    ...overrides,
  }
}

interface Harness {
  api: Api
  lines: string[]
  errors: string[]
  run: (args: string[]) => Promise<void>
}

function harness(dir: string, api: Api): Harness {
  const lines: string[] = []
  const errors: string[] = []
  const program = createProgram({
    makeApi: () => api,
    env: { GLYPHDOWN_SERVER: 'https://ink.example', GLYPHDOWN_API_KEY: 'gd_sk_k' },
    cwd: () => dir,
    out: (l) => lines.push(l),
    err: (l) => errors.push(l),
  })
  return { api, lines, errors, run: (args) => program.parseAsync(args, { from: 'user' }).then(() => undefined) }
}

describe('glyphdown rm', () => {
  const baseText = '# Title\n\nbase\n'
  const baseHash = sha256Hex(baseText)

  function pulledDir(): string {
    const dir = tmp()
    writePull(
      { targetPath: 'doc.md', docId: 'doc1', serverUrl: 'https://ink.example', text: baseText, versionId: 'v1' },
      dir,
    )
    return dir
  }

  function rmApi(overrides: Partial<Api> = {}): Api {
    return fakeApi({
      getContent: vi.fn(async () => ({ text: baseText, versionId: 'v1', baseHash })),
      ...overrides,
    })
  }

  it('deletes the remote doc, archives the local file, removes active metadata, and writes a tombstone', async () => {
    const dir = pulledDir()
    writeFileSync(join(dir, 'doc.md'), '# Title\n\nlocal notes\n')
    const api = rmApi()
    const h = harness(dir, api)

    await h.run(['rm', 'doc.md', '--json'])

    expect(api.getContent).toHaveBeenCalledWith('doc1', 'working')
    expect(api.deleteDoc).toHaveBeenCalledWith('doc1')
    expect(existsSync(join(dir, 'doc.md'))).toBe(false)
    expect(existsSync(join(dir, '.glyphdown', 'doc1', 'meta.json'))).toBe(false)
    expect(existsSync(join(dir, '.glyphdown', 'doc1', 'base.md'))).toBe(false)

    const result = JSON.parse(h.lines.join('\n')) as { docId: string; action: string; archivedPath: string }
    expect(result).toMatchObject({ docId: 'doc1', file: 'doc.md', action: 'deleted' })
    expect(result.archivedPath).toContain(join(dir, '.glyphdown', 'trash', 'docs'))
    expect(readFileSync(result.archivedPath, 'utf8')).toBe('# Title\n\nlocal notes\n')

    const tombstones = JSON.parse(readFileSync(join(dir, '.glyphdown', 'tombstones.json'), 'utf8')) as {
      docs: Record<string, { origin: string; archivedPath: string; localChanged: boolean }>
    }
    expect(tombstones.docs.doc1).toMatchObject({
      origin: 'rm-command',
      archivedPath: result.archivedPath,
      localChanged: true,
    })
  })

  it('supports delete as an alias', async () => {
    const dir = pulledDir()
    const api = rmApi()
    const h = harness(dir, api)

    await h.run(['delete', 'doc.md'])

    expect(api.deleteDoc).toHaveBeenCalledWith('doc1')
    expect(h.lines.join('\n')).toContain('deleted doc.md on the server')
  })

  it('refuses to delete when the remote changed since the local base', async () => {
    const dir = pulledDir()
    writeFileSync(join(dir, 'doc.md'), '# Title\n\nlocal notes\n')
    const api = rmApi({
      getContent: vi.fn(async () => ({ text: '# Title\n\nremote notes\n', versionId: 'v2', baseHash: null })),
    })
    const h = harness(dir, api)

    await expect(h.run(['rm', 'doc.md'])).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(CliError)
      expect((error as CliError).exitCode).toBe(1)
      expect((error as CliError).message).toContain('remote changed since your base')
      return true
    })

    expect(api.deleteDoc).not.toHaveBeenCalled()
    expect(readFileSync(join(dir, 'doc.md'), 'utf8')).toBe('# Title\n\nlocal notes\n')
    expect(existsSync(join(dir, '.glyphdown', 'doc1', 'meta.json'))).toBe(true)
    expect(existsSync(join(dir, '.glyphdown', 'trash'))).toBe(false)
  })

  it('allows forced deletes when the remote changed since the local base', async () => {
    const dir = pulledDir()
    const api = rmApi({
      getContent: vi.fn(async () => ({ text: '# Title\n\nremote notes\n', versionId: 'v2', baseHash: null })),
    })
    const h = harness(dir, api)

    await h.run(['rm', 'doc.md', '--force'])

    expect(api.deleteDoc).toHaveBeenCalledWith('doc1')
    expect(existsSync(join(dir, 'doc.md'))).toBe(false)
    expect(existsSync(join(dir, '.glyphdown', 'doc1', 'meta.json'))).toBe(false)
  })

  it('restores the local file and keeps active metadata if the server delete fails', async () => {
    const dir = pulledDir()
    writeFileSync(join(dir, 'doc.md'), '# Title\n\nlocal notes\n')
    const api = rmApi({
      deleteDoc: vi.fn(async () => {
        throw new CliError(1, 'forbidden')
      }),
    })
    const h = harness(dir, api)

    await expect(h.run(['rm', 'doc.md'])).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(CliError)
      expect((error as CliError).message).toContain('forbidden')
      return true
    })

    expect(readFileSync(join(dir, 'doc.md'), 'utf8')).toBe('# Title\n\nlocal notes\n')
    expect(existsSync(join(dir, '.glyphdown', 'doc1', 'meta.json'))).toBe(true)
    expect(existsSync(join(dir, '.glyphdown', 'tombstones.json'))).toBe(false)
  })
})

describe('glyphdown list', () => {
  it('prints docs as JSON with --json', async () => {
    const h = harness(tmp(), fakeApi())
    await h.run(['list', '--json'])
    expect(JSON.parse(h.lines.join('\n'))).toEqual([DOC])
  })
})

describe('glyphdown pull', () => {
  it('writes <slug>.md plus base bookkeeping (happy path)', async () => {
    const dir = tmp()
    const h = harness(dir, fakeApi())
    await h.run(['pull', 'https://ink.example/d/doc1'])

    expect(readFileSync(join(dir, 'launch-plan.md'), 'utf8')).toBe('# Launch Plan\n\nShip it.\n')
    const meta = JSON.parse(readFileSync(join(dir, '.glyphdown', 'doc1', 'meta.json'), 'utf8')) as Record<string, unknown>
    expect(meta.docId).toBe('doc1')
    expect(meta.serverUrl).toBe('https://ink.example')
    expect(meta.baseHash).toBe(sha256Hex('# Launch Plan\n\nShip it.\n'))
    expect(readFileSync(join(dir, '.glyphdown', 'doc1', 'base.md'), 'utf8')).toBe('# Launch Plan\n\nShip it.\n')
    expect(h.api.getContent).toHaveBeenCalledWith('doc1', 'working')
  })

  it('downloads doc-scoped assets for a folderless doc into the same dir', async () => {
    const dir = tmp()
    const bytes = new Uint8Array([1, 2, 3])
    const h = harness(
      dir,
      fakeApi({
        listDocAssets: vi.fn(async () => [
          {
            id: 'a1',
            filename: 'shot.png',
            contentType: 'image/png',
            size: 3,
            etag: 'etag-1',
            createdBy: 'u1',
            createdAt: 1,
          },
        ]),
        downloadDocAsset: vi.fn(async () => ({ data: bytes, etag: 'etag-1', contentType: 'image/png' })),
      }),
    )
    await h.run(['pull', 'doc1'])
    expect(new Uint8Array(readFileSync(join(dir, 'shot.png')))).toEqual(bytes)
    const state = JSON.parse(readFileSync(join(dir, '.glyphdown', 'assets.json'), 'utf8')) as Record<string, unknown>
    expect(state['shot.png']).toMatchObject({ etag: 'etag-1', size: 3 })
    expect(h.lines.some((l) => l.includes('asset shot.png') && l.includes('pulled'))).toBe(true)
  })

  it('does not fetch assets for a doc that lives in a folder', async () => {
    const dir = tmp()
    const listDocAssets = vi.fn(async () => [])
    const h = harness(dir, fakeApi({ getDoc: vi.fn(async () => ({ ...DOC, folderId: 'f1' })), listDocAssets }))
    await h.run(['pull', 'doc1'])
    expect(listDocAssets).not.toHaveBeenCalled()
  })
})

describe('glyphdown push', () => {
  function pulledDir(): string {
    const dir = tmp()
    writePull(
      { targetPath: 'doc.md', docId: 'doc1', serverUrl: 'https://ink.example', text: '# Title\n\nbase\n' },
      dir,
    )
    return dir
  }

  it('normalizes EOLs, pushes, and updates base.md + meta.json on clean success', async () => {
    const dir = pulledDir()
    writeFileSync(join(dir, 'doc.md'), '# Title\r\n\r\nedited\r\n') // CRLF from a Windows-side edit
    const h = harness(dir, fakeApi())
    await h.run(['push', '-m', 'tidy'])

    const pushMock = h.api.push as ReturnType<typeof vi.fn>
    const [docId, req] = pushMock.mock.calls[0]! as [string, Record<string, unknown>]
    expect(docId).toBe('doc1')
    expect(req.newText).toBe('# Title\n\nedited\n')
    expect(req.baseHash).toBe(sha256Hex('# Title\n\nbase\n'))
    expect(req.note).toBe('tidy')

    expect(readFileSync(join(dir, '.glyphdown', 'doc1', 'base.md'), 'utf8')).toBe('# Title\n\nedited\n')
    const meta = JSON.parse(readFileSync(join(dir, '.glyphdown', 'doc1', 'meta.json'), 'utf8')) as Record<string, unknown>
    expect(meta.baseHash).toBe(sha256Hex('# Title\n\nedited\n'))
    expect(meta.versionId).toBe('v2')
  })

  it('exits 3 with the SPEC message on a degenerate rejection, leaving base untouched', async () => {
    const dir = pulledDir()
    writeFileSync(join(dir, 'doc.md'), 'total rewrite\n')
    const api = fakeApi({
      push: vi.fn(async (): Promise<PushResponse> => ({ ok: false, reason: 'degenerate', deletedRatio: 0.8 })),
    })
    const h = harness(dir, api)
    await expect(h.run(['push'])).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(CliError)
      expect((error as CliError).exitCode).toBe(3)
      expect((error as CliError).message).toContain(
        'doc has concurrent edits and your change rewrites most of it — re-pull or --force',
      )
      return true
    })
    expect(readFileSync(join(dir, '.glyphdown', 'doc1', 'base.md'), 'utf8')).toBe('# Title\n\nbase\n')
  })

  it('prints failed hunks and exits 2 without updating base', async () => {
    const dir = pulledDir()
    writeFileSync(join(dir, 'doc.md'), '# Title\n\nedited\n')
    const hunk = '@@ -1,5 +1,5 @@\n-base\n+edited\n'
    const api = fakeApi({
      push: vi.fn(
        async (): Promise<PushResponse> => ({ ok: true, mode: 'edit', applied: 1, failedHunks: [hunk], versionId: 'v3' }),
      ),
    })
    const h = harness(dir, api)
    await expect(h.run(['push'])).rejects.toSatisfy((error: unknown) => {
      expect((error as CliError).exitCode).toBe(2)
      return true
    })
    expect(h.errors.join('\n')).toContain(hunk)
    expect(readFileSync(join(dir, '.glyphdown', 'doc1', 'base.md'), 'utf8')).toBe('# Title\n\nbase\n')
  })

  it('re-sends the on-disk base when the server cache misses', async () => {
    const dir = pulledDir()
    writeFileSync(join(dir, 'doc.md'), '# Title\n\nedited\n')
    const push = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: 'base-missing' } satisfies PushResponse)
      .mockResolvedValueOnce({ ok: true, mode: 'edit', applied: 1, failedHunks: [], versionId: 'v4' } satisfies PushResponse)
    const h = harness(dir, fakeApi({ push: push as unknown as Api['push'] }))
    await h.run(['push'])
    expect(push).toHaveBeenCalledTimes(2)
    const retry = push.mock.calls[1]![1] as Record<string, unknown>
    expect(retry.baseText).toBe('# Title\n\nbase\n')
  })

  it('lands as a suggestion with --suggest and keeps base unchanged', async () => {
    const dir = pulledDir()
    writeFileSync(join(dir, 'doc.md'), '# Title\n\nproposal\n')
    const api = fakeApi({
      push: vi.fn(async (): Promise<PushResponse> => ({ ok: true, mode: 'suggest', suggestionId: 's1', versionId: 'v5' })),
    })
    const h = harness(dir, api)
    await h.run(['push', '--suggest', '-m', 'try this'])
    const req = (api.push as ReturnType<typeof vi.fn>).mock.calls[0]![1] as Record<string, unknown>
    expect(req.suggest).toBe(true)
    expect(req.note).toBe('try this')
    expect(h.lines.join('\n')).toContain('s1')
    expect(readFileSync(join(dir, '.glyphdown', 'doc1', 'base.md'), 'utf8')).toBe('# Title\n\nbase\n')
  })
})

describe('ink comment', () => {
  it('anchors a new comment to a line by computing character offsets', async () => {
    const api = fakeApi({
      getContent: vi.fn(async () => ({ text: 'line one\nline two\nline three\n', versionId: null, baseHash: null })),
      createComment: vi.fn(async () => ({ id: 'c1' }) as unknown as Comment),
    })
    const h = harness(tmp(), api)
    await h.run(['comment', 'doc1', '--body', 'check this', '--line', '2'])
    expect(api.createComment).toHaveBeenCalledWith('doc1', 'check this', { start: 9, end: 17 })
  })

  it('replies then resolves when --resolve is combined with --body', async () => {
    const api = fakeApi({
      replyToComment: vi.fn(async () => ({ id: 'r1' }) as unknown as Awaited<ReturnType<Api['replyToComment']>>),
    })
    const h = harness(tmp(), api)
    await h.run(['comment', 'doc1', '--resolve', 'c9', '--body', 'done'])
    expect(api.replyToComment).toHaveBeenCalledWith('doc1', 'c9', 'done')
    expect(api.resolveComment).toHaveBeenCalledWith('doc1', 'c9', true)
  })

  it('lists asset comments from an HTML viewer URL', async () => {
    const comment = {
      id: 'c1',
      anchor: null,
      anchorKind: null,
      authorId: 'u1',
      authorName: 'kirby',
      body: 'whole file',
      createdAt: 1,
      resolved: false,
      reactions: {},
      replies: [],
    } satisfies Comment
    const api = fakeApi({ listFolderAssetComments: vi.fn(async () => [comment]) })
    const h = harness(tmp(), api)

    await h.run(['comments', 'https://ink.example/f/f1/file/page.html', '--json'])

    expect(api.listFolderAssetComments).toHaveBeenCalledWith('f1', 'page.html')
    expect(JSON.parse(h.lines.join('\n'))).toEqual([comment])
  })

  it('creates file-level asset comments from a folder + filename ref', async () => {
    const api = fakeApi({
      listFolders: vi.fn(async () => [{ id: 'f1', name: 'Research', kind: 'folder' as const, parentId: null, ownerUserId: 'u1', role: 'editor' as const, createdAt: 1 }]),
      createFolderAssetComment: vi.fn(async () => ({ id: 'c-html' }) as unknown as Comment),
    })
    const h = harness(tmp(), api)

    await h.run(['comment', 'page.html', '--folder', 'Research', '--body', 'Needs a summary'])

    expect(api.createFolderAssetComment).toHaveBeenCalledWith('f1', 'page.html', { body: 'Needs a summary' })
    expect(h.lines.join('\n')).toContain('c-html')
  })

  it('replies to and resolves doc-scoped asset comments', async () => {
    const api = fakeApi({
      replyToDocAssetComment: vi.fn(async () => ({ id: 'r-html' }) as unknown as Awaited<ReturnType<Api['replyToDocAssetComment']>>),
    })
    const h = harness(tmp(), api)

    await h.run(['comment', 'page.html', '--doc', 'doc1', '--resolve', 'c-html', '--body', 'fixed'])

    expect(api.replyToDocAssetComment).toHaveBeenCalledWith('doc1', 'page.html', 'c-html', 'fixed')
    expect(api.resolveDocAssetComment).toHaveBeenCalledWith('doc1', 'page.html', 'c-html', true)
  })

  it('rejects line-anchored asset comments because CLI asset creation is file-level only', async () => {
    const api = fakeApi()
    const h = harness(tmp(), api)

    await expect(h.run(['comment', 'https://ink.example/f/f1/file/page.html', '--line', '3', '--body', 'here'])).rejects.toSatisfy(
      (error: unknown) => {
        expect((error as CliError).exitCode).toBe(1)
        expect((error as CliError).message).toContain('--line is only valid')
        return true
      },
    )
    expect(api.createFolderAssetComment).not.toHaveBeenCalled()
  })
})

describe('glyphdown cat/history for versions', () => {
  it('prints a doc version with cat --version', async () => {
    const api = fakeApi()
    const h = harness(tmp(), api)

    await h.run(['cat', 'doc1', '--version', 'ver1'])

    expect(api.getVersionText).toHaveBeenCalledWith('doc1', 'ver1')
    expect(h.lines.join('\n')).toBe('# Old\n')
  })

  it('prints an asset version with cat --version', async () => {
    const data = new TextEncoder().encode('<h1>Old</h1>')
    const api = fakeApi({
      downloadFolderAsset: vi.fn(async () => ({ data, etag: 'etag-old', contentType: 'text/html' })),
    })
    const h = harness(tmp(), api)

    await h.run(['cat', 'https://ink.example/f/f1/file/page.html', '--version', 'av1', '--json'])

    expect(api.downloadFolderAsset).toHaveBeenCalledWith('f1', 'page.html', 'av1')
    expect(JSON.parse(h.lines.join('\n'))).toMatchObject({
      target: 'asset',
      scope: 'folder',
      id: 'f1',
      filename: 'page.html',
      versionId: 'av1',
      text: '<h1>Old</h1>',
    })
  })

  it('lists doc and asset history', async () => {
    const api = fakeApi()
    const doc = harness(tmp(), api)
    await doc.run(['history', 'doc1', '--json'])
    expect(api.listVersions).toHaveBeenCalledWith('doc1')
    expect(JSON.parse(doc.lines.join('\n'))).toEqual([DOC_VERSION])

    const asset = harness(tmp(), api)
    await asset.run(['history', 'https://ink.example/f/f1/file/page.html', '--json'])
    expect(api.listFolderAssetVersions).toHaveBeenCalledWith('f1', 'page.html')
    expect(JSON.parse(asset.lines.join('\n'))).toEqual([ASSET_VERSION])
  })
})

describe('glyphdown share', () => {
  const FOLDER = {
    id: 'f1',
    name: 'Research',
    kind: 'vault' as const,
    parentId: null,
    ownerUserId: 'u1',
    role: 'owner' as const,
    createdAt: 1,
  }

  it('bare `share <doc>` creates a viewer link and prints the share URL first', async () => {
    const api = fakeApi()
    const h = harness(tmp(), api)
    await h.run(['share', 'https://ink.example/d/doc1'])
    expect(api.createDocShareLink).toHaveBeenCalledWith('doc1', 'viewer')
    expect(h.lines[0]).toBe('https://ink.example/d/doc1?share=tok-new')
  })

  it('forwards --role and emits the JSON shape with the url', async () => {
    const api = fakeApi()
    const h = harness(tmp(), api)
    await h.run(['share', 'doc1', '--role', 'editor', '--json'])
    expect(api.createDocShareLink).toHaveBeenCalledWith('doc1', 'editor')
    expect(JSON.parse(h.lines.join('\n'))).toEqual({
      target: 'doc',
      id: 'doc1',
      token: 'tok-new',
      role: 'editor',
      createdAt: 6,
      url: 'https://ink.example/d/doc1?share=tok-new',
    })
  })

  it('rejects a bad --role with exit 1 before hitting the API', async () => {
    const api = fakeApi()
    const h = harness(tmp(), api)
    await expect(h.run(['share', 'doc1', '--role', 'owner'])).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(CliError)
      expect((error as CliError).exitCode).toBe(1)
      expect((error as CliError).message).toContain('viewer, commenter, suggester, editor')
      return true
    })
    expect(api.createDocShareLink).not.toHaveBeenCalled()
  })

  it('share list prints token, role, and url per link (and the JSON shape)', async () => {
    const h = harness(tmp(), fakeApi())
    await h.run(['share', 'list', 'doc1', '--json'])
    expect(JSON.parse(h.lines.join('\n'))).toEqual([
      { token: 'tok1', role: 'viewer', createdAt: 5, url: 'https://ink.example/d/doc1?share=tok1' },
    ])

    const h2 = harness(tmp(), fakeApi())
    await h2.run(['share', 'list', 'doc1'])
    expect(h2.lines.join('\n')).toContain('https://ink.example/d/doc1?share=tok1')
  })

  it('share list reports an empty result', async () => {
    const h = harness(tmp(), fakeApi({ listDocShareLinks: vi.fn(async () => []) }))
    await h.run(['share', 'list', 'doc1'])
    expect(h.lines.join('\n')).toContain('no share links')
  })

  it('share revoke passes the token through', async () => {
    const api = fakeApi()
    const h = harness(tmp(), api)
    await h.run(['share', 'revoke', 'doc1', 'tok1'])
    expect(api.revokeDocShareLink).toHaveBeenCalledWith('doc1', 'tok1')
    expect(h.lines.join('\n')).toContain('revoked share link tok1')
  })

  it('share revoke extracts the token from a ?share= URL', async () => {
    const api = fakeApi()
    const h = harness(tmp(), api)
    await h.run(['share', 'revoke', 'https://ink.example/d/doc1?share=tok9', '--json'])
    expect(api.revokeDocShareLink).toHaveBeenCalledWith('doc1', 'tok9')
    expect(JSON.parse(h.lines.join('\n'))).toEqual({ ok: true, target: 'doc', id: 'doc1', token: 'tok9' })
  })

  it('share revoke without a token errors with exit 1', async () => {
    const api = fakeApi()
    const h = harness(tmp(), api)
    await expect(h.run(['share', 'revoke', 'doc1'])).rejects.toSatisfy((error: unknown) => {
      expect((error as CliError).exitCode).toBe(1)
      expect((error as CliError).message).toContain('missing token')
      return true
    })
    expect(api.revokeDocShareLink).not.toHaveBeenCalled()
  })

  it('--folder resolves the ref and uses the /f/ landing URL', async () => {
    const api = fakeApi({ listFolders: vi.fn(async () => [FOLDER]) })
    const h = harness(tmp(), api)
    await h.run(['share', '--folder', 'Research', '--json'])
    expect(api.createFolderShareLink).toHaveBeenCalledWith('f1', 'viewer')
    expect(JSON.parse(h.lines.join('\n'))).toMatchObject({
      target: 'folder',
      id: 'f1',
      token: 'ftok-new',
      url: 'https://ink.example/f/f1?share=ftok-new',
    })
  })

  it('share list --folder lists folder links with /f/ URLs', async () => {
    const api = fakeApi({ listFolders: vi.fn(async () => [FOLDER]) })
    const h = harness(tmp(), api)
    await h.run(['share', 'list', '--folder', 'f1', '--json'])
    expect(api.listFolderShareLinks).toHaveBeenCalledWith('f1')
    expect(JSON.parse(h.lines.join('\n'))).toEqual([
      { token: 'ftok1', role: 'editor', createdAt: 7, url: 'https://ink.example/f/f1?share=ftok1' },
    ])
  })

  it('share revoke --folder takes the token as the only positional', async () => {
    const api = fakeApi({ listFolders: vi.fn(async () => [FOLDER]) })
    const h = harness(tmp(), api)
    await h.run(['share', 'revoke', '--folder', 'Research', 'ftok1'])
    expect(api.revokeFolderShareLink).toHaveBeenCalledWith('f1', 'ftok1')
  })

  it('errors when neither a doc nor --folder is passed', async () => {
    const api = fakeApi({ listFolders: vi.fn(async () => [FOLDER]) })
    const h = harness(tmp(), api)
    await expect(h.run(['share', 'list'])).rejects.toSatisfy((error: unknown) => {
      expect((error as CliError).message).toContain('missing target')
      return true
    })
  })
})

describe('glyphdown share (per-file HTML assets)', () => {
  const FOLDER = {
    id: 'f1',
    name: 'Research',
    kind: 'vault' as const,
    parentId: null,
    ownerUserId: 'u1',
    role: 'owner' as const,
    createdAt: 1,
  }

  it('creates a per-file link from an asset URL and prints the file-viewer URL first', async () => {
    const api = fakeApi()
    const h = harness(tmp(), api)
    await h.run(['share', 'https://ink.example/f/f1/file/page.html', '--role', 'commenter'])
    expect(api.createAssetShareLink).toHaveBeenCalledWith('f1', 'page.html', 'commenter')
    expect(h.lines[0]).toBe('https://ink.example/f/f1/file/page.html?share=atok-new')
  })

  it('creates a per-file link from a filename + --folder ref (JSON shape)', async () => {
    const api = fakeApi({ listFolders: vi.fn(async () => [FOLDER]) })
    const h = harness(tmp(), api)
    await h.run(['share', 'page.html', '--folder', 'Research', '--json'])
    expect(api.createAssetShareLink).toHaveBeenCalledWith('f1', 'page.html', 'viewer')
    expect(JSON.parse(h.lines.join('\n'))).toEqual({
      target: 'asset',
      folderId: 'f1',
      filename: 'page.html',
      token: 'atok-new',
      role: 'viewer',
      createdAt: 10,
      url: 'https://ink.example/f/f1/file/page.html?share=atok-new',
    })
  })

  it('rejects suggest/edit roles for a per-file link before hitting the API', async () => {
    const api = fakeApi()
    const h = harness(tmp(), api)
    await expect(
      h.run(['share', 'https://ink.example/f/f1/file/page.html', '--role', 'editor']),
    ).rejects.toSatisfy((error: unknown) => {
      expect((error as CliError).exitCode).toBe(1)
      expect((error as CliError).message).toContain('view/comment only')
      return true
    })
    expect(api.createAssetShareLink).not.toHaveBeenCalled()
  })

  it('rejects a doc-scoped asset target with a clear error', async () => {
    const api = fakeApi()
    const h = harness(tmp(), api)
    await expect(h.run(['share', 'page.html', '--doc', 'doc1'])).rejects.toSatisfy((error: unknown) => {
      expect((error as CliError).exitCode).toBe(1)
      expect((error as CliError).message).toContain('folder/vault assets only')
      return true
    })
    expect(api.createAssetShareLink).not.toHaveBeenCalled()
  })

  it('lists per-file links with their file-viewer URLs', async () => {
    const api = fakeApi()
    const h = harness(tmp(), api)
    await h.run(['share', 'list', 'https://ink.example/f/f1/file/page.html', '--json'])
    expect(api.listAssetShareLinks).toHaveBeenCalledWith('f1', 'page.html')
    expect(JSON.parse(h.lines.join('\n'))).toEqual([
      { token: 'atok1', role: 'commenter', createdAt: 9, url: 'https://ink.example/f/f1/file/page.html?share=atok1' },
    ])
  })

  it('revokes a per-file link by filename + token under --folder', async () => {
    const api = fakeApi({ listFolders: vi.fn(async () => [FOLDER]) })
    const h = harness(tmp(), api)
    await h.run(['share', 'revoke', '--folder', 'Research', 'page.html', 'atok1'])
    expect(api.revokeAssetShareLink).toHaveBeenCalledWith('f1', 'page.html', 'atok1')
    expect(h.lines.join('\n')).toContain('revoked share link atok1 on asset f1/page.html')
  })

  it('revokes a per-file link from a ?share= asset URL', async () => {
    const api = fakeApi()
    const h = harness(tmp(), api)
    await h.run(['share', 'revoke', 'https://ink.example/f/f1/file/page.html?share=atok9', '--json'])
    expect(api.revokeAssetShareLink).toHaveBeenCalledWith('f1', 'page.html', 'atok9')
    expect(JSON.parse(h.lines.join('\n'))).toEqual({ ok: true, target: 'asset', id: 'f1/page.html', token: 'atok9' })
  })
})

describe('ink snapshot', () => {
  it('creates a named version', async () => {
    const api = fakeApi()
    const h = harness(tmp(), api)
    await h.run(['snapshot', 'doc1', '-m', 'before rewrite'])
    expect(api.createVersion).toHaveBeenCalledWith('doc1', 'before rewrite')
    expect(h.lines.join('\n')).toContain('ver1')
  })

  it('names the current asset version', async () => {
    const api = fakeApi()
    const h = harness(tmp(), api)

    await h.run(['snapshot', 'https://ink.example/f/f1/file/page.html', '-m', 'baseline'])

    expect(api.listFolderAssetVersions).toHaveBeenCalledWith('f1', 'page.html')
    expect(api.nameFolderAssetVersion).toHaveBeenCalledWith('f1', 'page.html', 'av1', 'baseline')
    expect(h.lines.join('\n')).toContain('av1')
  })
})

// ---------------------------------------------------------------------------
// Unified file surface: add / url / ls / rm / mv treat docs and assets alike.
// ---------------------------------------------------------------------------

function assetMetaOf(filename: string, contentType = 'text/html'): AssetMeta {
  return { id: `asset-${filename}`, filename, contentType, size: 11, etag: 'etag-1', createdBy: 'u1', createdAt: 9 }
}

function folderMetaOf(id: string, name: string): FolderMeta {
  return { id, name, kind: 'folder', parentId: null, ownerUserId: 'u1', role: 'editor', createdAt: 1 }
}

describe('glyphdown add', () => {
  it('uploads a single asset to the default vault and prints its viewer URL — no clone, no folder', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'report.html'), '<h1>hi</h1>')
    const uploadAsset = vi.fn(async () => ({ asset: assetMetaOf('report.html'), path: 'report.html', folderId: 'vault1', docId: null }))
    const h = harness(dir, fakeApi({ uploadAsset }))

    await h.run(['add', 'report.html'])

    expect(uploadAsset).toHaveBeenCalledWith('report.html', expect.any(Uint8Array), 'text/html', false)
    expect(h.lines[0]).toBe('https://ink.example/f/vault1/file/report.html')
  })

  it('uploads to a named folder when --folder is given', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'chart.png'), Buffer.from([1, 2, 3]))
    const uploadFolderAsset = vi.fn(async () => ({ asset: assetMetaOf('chart.png', 'image/png'), path: 'chart.png', folderId: 'f1', docId: null }))
    const h = harness(dir, fakeApi({ uploadFolderAsset, listFolders: vi.fn(async () => [folderMetaOf('f1', 'Docs')]) }))

    await h.run(['add', 'chart.png', '--folder', 'f1', '--json'])

    expect(uploadFolderAsset).toHaveBeenCalledWith('f1', 'chart.png', expect.any(Uint8Array), 'image/png', false)
    const out = JSON.parse(h.lines.join('\n')) as { target: string; folderId: string; url: string }
    expect(out).toMatchObject({ target: 'asset', folderId: 'f1', url: 'https://ink.example/f/f1/file/chart.png' })
  })

  it('creates a doc from a .md file and pushes its content in one command', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'notes.md'), '# Notes\n\nbody\n')
    const createDoc = vi.fn(async () => ({ ...DOC, id: 'docNew', filename: 'notes.md' }))
    const getContent = vi.fn(async () => ({ text: '', versionId: null, baseHash: sha256Hex('') }))
    const push = vi.fn(async (): Promise<PushResponse> => ({ ok: true, mode: 'edit', applied: 1, failedHunks: [], versionId: 'v9' }))
    const h = harness(dir, fakeApi({ createDoc, getContent, push }))

    await h.run(['add', 'notes.md', '--json'])

    expect(createDoc).toHaveBeenCalledWith({ filename: 'notes.md' })
    expect(push).toHaveBeenCalled()
    const out = JSON.parse(h.lines.join('\n')) as { target: string; id: string; pushed: boolean }
    expect(out).toMatchObject({ target: 'doc', id: 'docNew', pushed: true })
  })

  it('rejects an unsupported file type', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'data.bin'), Buffer.from([0]))
    const h = harness(dir, fakeApi())
    await expect(h.run(['add', 'data.bin'])).rejects.toThrow(/unsupported file type/)
  })
})

describe('glyphdown url', () => {
  it('prints an asset viewer URL idempotently after confirming it exists', async () => {
    const listFolderAssets = vi.fn(async () => [assetMetaOf('page.html')])
    const h = harness(tmp(), fakeApi({ listFolderAssets, listFolders: vi.fn(async () => [folderMetaOf('f1', 'Docs')]) }))

    await h.run(['url', 'page.html', '--folder', 'f1'])

    expect(listFolderAssets).toHaveBeenCalledWith('f1')
    expect(h.lines[0]).toBe('https://ink.example/f/f1/file/page.html')
  })

  it('errors when the asset is not found in its scope', async () => {
    const h = harness(tmp(), fakeApi({ listFolderAssets: vi.fn(async () => []), listFolders: vi.fn(async () => [folderMetaOf('f1', 'Docs')]) }))
    await expect(h.run(['url', 'missing.html', '--folder', 'f1'])).rejects.toThrow(/no file/)
  })

  it('prints a doc URL from an id', async () => {
    const h = harness(tmp(), fakeApi())
    await h.run(['url', 'doc1'])
    expect(h.lines[0]).toBe('https://ink.example/d/doc1')
  })
})

describe('glyphdown list --folder / ls', () => {
  it('lists docs and assets together for one folder', async () => {
    const listDocs = vi.fn(async () => [
      { ...DOC, id: 'd1', folderId: 'f1', title: 'launch-plan' },
      { ...DOC, id: 'd2', folderId: 'other', title: 'elsewhere' },
    ])
    const listFolderAssets = vi.fn(async () => [assetMetaOf('chart.png', 'image/png'), assetMetaOf('page.html', 'text/html')])
    const h = harness(tmp(), fakeApi({ listDocs, listFolderAssets, listFolders: vi.fn(async () => [folderMetaOf('f1', 'Docs')]) }))

    await h.run(['ls', '--folder', 'f1', '--json'])

    const out = JSON.parse(h.lines.join('\n')) as { docs: unknown[]; assets: unknown[] }
    expect(out.docs).toHaveLength(1)
    expect(out.assets).toHaveLength(2)
  })
})

describe('glyphdown rm (asset)', () => {
  it('deletes a folder asset, archives the local file, and clears its sync state', async () => {
    const dir = tmp()
    writeFolderConfig(dir, { folderId: 'f1', folderName: 'Docs', serverUrl: 'https://ink.example' })
    writeFileSync(join(dir, 'chart.png'), Buffer.from([1, 2, 3]))
    const deleteFolderAsset = vi.fn(async () => undefined)
    const h = harness(dir, fakeApi({ deleteFolderAsset }))

    await h.run(['rm', 'chart.png', '--json'])

    expect(deleteFolderAsset).toHaveBeenCalledWith('f1', 'chart.png')
    expect(existsSync(join(dir, 'chart.png'))).toBe(false)
    const out = JSON.parse(h.lines.join('\n')) as { action: string; archivedPath: string }
    expect(out.action).toBe('deleted')
    expect(out.archivedPath).toContain(join(dir, '.glyphdown', 'trash', 'assets'))
  })

  it('errors outside a workspace without an explicit scope', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'chart.png'), Buffer.from([1]))
    const h = harness(dir, fakeApi())
    await expect(h.run(['rm', 'chart.png'])).rejects.toThrow(/not in a folder workspace/)
  })
})

describe('glyphdown mv (asset)', () => {
  it('renames a folder asset on the server and on disk, preserving the asset id', async () => {
    const dir = tmp()
    writeFolderConfig(dir, { folderId: 'f1', folderName: 'Docs', serverUrl: 'https://ink.example' })
    writeFileSync(join(dir, 'old.html'), '<h1>x</h1>')
    const renameFolderAsset = vi.fn(async () => ({ asset: assetMetaOf('new.html'), path: 'new.html', folderId: 'f1', docId: null }))
    const h = harness(dir, fakeApi({ renameFolderAsset }))

    await h.run(['mv', 'old.html', 'new.html'])

    expect(renameFolderAsset).toHaveBeenCalledWith('f1', 'old.html', 'new.html')
    expect(existsSync(join(dir, 'old.html'))).toBe(false)
    expect(existsSync(join(dir, 'new.html'))).toBe(true)
  })

  it('moves the sync state entry to the new name', async () => {
    const dir = tmp()
    writeFolderConfig(dir, { folderId: 'f1', folderName: 'Docs', serverUrl: 'https://ink.example' })
    writeFileSync(join(dir, 'old.html'), '<h1>x</h1>')
    // seed a sync-state entry under the old name
    writeAssetState(dir, { 'old.html': { etag: 'e1', size: 7, mtimeMs: 1 } })
    const renameFolderAsset = vi.fn(async () => ({ asset: assetMetaOf('new.html'), path: 'new.html', folderId: 'f1', docId: null }))
    const h = harness(dir, fakeApi({ renameFolderAsset }))

    await h.run(['mv', 'old.html', 'new.html'])

    const state = readAssetState(dir)
    expect(state['old.html']).toBeUndefined()
    expect(state['new.html']).toMatchObject({ etag: 'e1' })
  })
})

describe('unified-file review fixes', () => {
  it('add: derives an asset content-type from the SOURCE file, not a bare --name (no HTML-as-image)', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'report.html'), '<h1>hi</h1>')
    const uploadAsset = vi.fn(async () => ({ asset: assetMetaOf('report.html'), path: 'report.html', folderId: 'v1', docId: null }))
    const h = harness(dir, fakeApi({ uploadAsset }))

    await h.run(['add', 'report.html', '--name', 'report']) // --name has no extension

    expect(uploadAsset).toHaveBeenCalledWith('report.html', expect.any(Uint8Array), 'text/html', false)
  })

  it('add: a .md whose content push is rejected exits non-zero (no silent half-create)', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'notes.md'), '# Notes\n\nbody\n')
    const createDoc = vi.fn(async () => ({ ...DOC, id: 'docX', filename: 'notes.md' }))
    const getContent = vi.fn(async () => ({ text: '', versionId: null, baseHash: sha256Hex('') }))
    const push = vi.fn(async () => ({ ok: false, reason: 'degenerate' }) as unknown as PushResponse)
    const h = harness(dir, fakeApi({ createDoc, getContent, push }))

    await expect(h.run(['add', 'notes.md'])).rejects.toThrow(/content not applied/)
  })

  it('mv: a doc rename honors --json', async () => {
    const dir = tmp()
    writePull({ targetPath: 'doc.md', docId: 'doc1', serverUrl: 'https://ink.example', text: '# t\n', versionId: 'v1' }, dir)
    const renameDoc = vi.fn(async () => ({ ...DOC, filename: 'renamed.md' }))
    const h = harness(dir, fakeApi({ renameDoc }))

    await h.run(['mv', 'doc.md', 'renamed', '--json'])

    const out = JSON.parse(h.lines.join('\n')) as { target: string; to: string; action: string }
    expect(out).toMatchObject({ target: 'doc', to: 'renamed.md', action: 'renamed' })
  })
})
