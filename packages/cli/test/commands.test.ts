import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Comment, DocMeta, PushResponse, ShareLinkRole } from '@glyphdown/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Api } from '../src/index.ts'
import { CliError, createProgram, sha256Hex, writePull } from '../src/index.ts'

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
    createVersion: vi.fn(async () => ({
      id: 'ver1',
      createdAt: 3,
      name: 'before rewrite',
      authorIds: ['u1'],
      kind: 'named' as const,
      sizeBytes: 10,
    })),
    listDocShareLinks: vi.fn(async () => [{ token: 'tok1', role: 'viewer' as const, createdAt: 5 }]),
    createDocShareLink: vi.fn(async (_docId: string, role: ShareLinkRole) => ({ token: 'tok-new', role, createdAt: 6 })),
    revokeDocShareLink: vi.fn(async () => undefined),
    listFolderShareLinks: vi.fn(async () => [{ token: 'ftok1', role: 'editor' as const, createdAt: 7 }]),
    createFolderShareLink: vi.fn(async (_folderId: string, role: ShareLinkRole) => ({ token: 'ftok-new', role, createdAt: 8 })),
    revokeFolderShareLink: vi.fn(async () => undefined),
    listDocAssets: vi.fn(async () => []),
    listFolderAssets: vi.fn(async () => []),
    downloadDocAsset: vi.fn(async () => ({ data: new Uint8Array(), etag: null, contentType: null })),
    downloadFolderAsset: vi.fn(async () => ({ data: new Uint8Array(), etag: null, contentType: null })),
    uploadDocAsset: vi.fn(),
    uploadFolderAsset: vi.fn(),
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
  function pulledDir(): string {
    const dir = tmp()
    writePull(
      { targetPath: 'doc.md', docId: 'doc1', serverUrl: 'https://ink.example', text: '# Title\n\nbase\n', versionId: 'v1' },
      dir,
    )
    return dir
  }

  it('deletes the remote doc, archives the local file, removes active metadata, and writes a tombstone', async () => {
    const dir = pulledDir()
    writeFileSync(join(dir, 'doc.md'), '# Title\n\nlocal notes\n')
    const api = fakeApi()
    const h = harness(dir, api)

    await h.run(['rm', 'doc.md', '--json'])

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
    const api = fakeApi()
    const h = harness(dir, api)

    await h.run(['delete', 'doc.md'])

    expect(api.deleteDoc).toHaveBeenCalledWith('doc1')
    expect(h.lines.join('\n')).toContain('deleted doc.md on the server')
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

  it('errors when both a doc and --folder are passed, or neither', async () => {
    const api = fakeApi({ listFolders: vi.fn(async () => [FOLDER]) })
    const h = harness(tmp(), api)
    await expect(h.run(['share', 'doc1', '--folder', 'f1'])).rejects.toSatisfy((error: unknown) => {
      expect((error as CliError).message).toContain('not both')
      return true
    })
    await expect(h.run(['share', 'list'])).rejects.toSatisfy((error: unknown) => {
      expect((error as CliError).message).toContain('missing target')
      return true
    })
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
})
