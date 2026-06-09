import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createApi,
  decideAssetSync,
  docAssetOps,
  md5Hex,
  pullAssets,
  readAssetState,
  syncAssets,
  writeAssetState,
  type AssetState,
} from '../src/index.ts'

const dirs: string[] = []
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ink-assets-test-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Pure decision matrix
// ---------------------------------------------------------------------------

const LOCAL = { size: 10, mtimeMs: 1000 }
const RECORD: AssetState = { etag: 'aaa', size: 10, mtimeMs: 1000 }

describe('decideAssetSync', () => {
  it('new-local → upload (no overwrite)', () => {
    expect(decideAssetSync({ local: LOCAL, remote: null, recorded: null })).toEqual({
      action: 'upload',
      overwrite: false,
    })
  })

  it('new-remote → download', () => {
    expect(decideAssetSync({ local: null, remote: { etag: 'bbb' }, recorded: null })).toEqual({
      action: 'download',
    })
  })

  it('changed-local (size or mtime drifted, remote still recorded) → upload overwrite', () => {
    expect(
      decideAssetSync({ local: { size: 12, mtimeMs: 1000 }, remote: { etag: 'aaa' }, recorded: RECORD }),
    ).toEqual({ action: 'upload', overwrite: true })
    expect(
      decideAssetSync({ local: { size: 10, mtimeMs: 2000 }, remote: { etag: 'aaa' }, recorded: RECORD }),
    ).toEqual({ action: 'upload', overwrite: true })
  })

  it('changed-remote (etag drifted, local matches record) → download', () => {
    expect(decideAssetSync({ local: LOCAL, remote: { etag: 'bbb' }, recorded: RECORD })).toEqual({
      action: 'download',
    })
  })

  it('both-changed → conflict-local-kept (images do not merge)', () => {
    expect(
      decideAssetSync({ local: { size: 12, mtimeMs: 2000 }, remote: { etag: 'bbb' }, recorded: RECORD }),
    ).toEqual({ action: 'conflict-local-kept' })
  })

  it('both-changed but bytes identical → up-to-date (record refresh)', () => {
    expect(
      decideAssetSync({
        local: { size: 12, mtimeMs: 2000 },
        remote: { etag: 'bbb' },
        recorded: RECORD,
        bytesIdentical: true,
      }),
    ).toEqual({ action: 'up-to-date' })
  })

  it('unchanged → up-to-date', () => {
    expect(decideAssetSync({ local: LOCAL, remote: { etag: 'aaa' }, recorded: RECORD })).toEqual({
      action: 'up-to-date',
    })
  })

  it('both exist, never synced: identical bytes start tracking, different bytes conflict', () => {
    expect(
      decideAssetSync({ local: LOCAL, remote: { etag: 'xxx' }, recorded: null, bytesIdentical: true }),
    ).toEqual({ action: 'up-to-date' })
    expect(
      decideAssetSync({ local: LOCAL, remote: { etag: 'xxx' }, recorded: null, bytesIdentical: false }),
    ).toEqual({ action: 'conflict-local-kept' })
  })

  it('remote deleted but local still present → re-upload; local deleted → re-download', () => {
    expect(decideAssetSync({ local: LOCAL, remote: null, recorded: RECORD })).toEqual({
      action: 'upload',
      overwrite: false,
    })
    expect(decideAssetSync({ local: null, remote: { etag: 'aaa' }, recorded: RECORD })).toEqual({
      action: 'download',
    })
  })

  it('stale record with nothing on either side → forget', () => {
    expect(decideAssetSync({ local: null, remote: null, recorded: RECORD })).toEqual({ action: 'forget' })
  })
})

// ---------------------------------------------------------------------------
// syncAssets / pullAssets against a mocked fetch (doc-scoped asset routes)
// ---------------------------------------------------------------------------

interface ServerAsset {
  data: Uint8Array
  etag: string
  contentType: string
}

interface AssetServer {
  assets: Map<string, ServerAsset>
  uploads: Array<{ filename: string; overwrite: boolean }>
  downloads: string[]
}

function assetServer(initial: Record<string, Uint8Array> = {}): AssetServer {
  const assets = new Map<string, ServerAsset>()
  for (const [name, data] of Object.entries(initial)) {
    assets.set(name, { data, etag: md5Hex(data), contentType: 'image/png' })
  }
  return { assets, uploads: [], downloads: [] }
}

function metaOf(name: string, a: ServerAsset) {
  return {
    id: `asset-${name}`,
    filename: name,
    contentType: a.contentType,
    size: a.data.byteLength,
    etag: a.etag,
    createdBy: 'u1',
    createdAt: 1,
  }
}

function fetchFor(state: AssetServer): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = init?.method ?? 'GET'
    const path = url.pathname

    if (method === 'GET' && /^\/api\/(?:docs|folders)\/[^/]+\/assets$/.test(path)) {
      return new Response(
        JSON.stringify({ assets: [...state.assets.entries()].map(([n, a]) => metaOf(n, a)) }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    const fileMatch = path.match(/^\/api\/(?:docs|folders)\/[^/]+\/assets\/([^/]+)$/)
    if (method === 'GET' && fileMatch) {
      const asset = state.assets.get(decodeURIComponent(fileMatch[1]!))
      if (!asset) return new Response(JSON.stringify({ error: 'not-found' }), { status: 404 })
      state.downloads.push(decodeURIComponent(fileMatch[1]!))
      return new Response(asset.data.slice() as unknown as RequestInit['body'] as never, {
        status: 200,
        headers: { 'content-type': asset.contentType, etag: `"${asset.etag}"` },
      })
    }
    if (method === 'POST' && /^\/api\/docs\/[^/]+\/assets$/.test(path)) {
      const raw = url.searchParams.get('filename')!
      const filename = raw.toLowerCase().replace(/\s+/g, '-')
      const overwrite = url.searchParams.get('overwrite') === 'true'
      const data = new Uint8Array(init?.body as Uint8Array)
      let stored = filename
      if (state.assets.has(filename) && !overwrite) {
        const dot = filename.lastIndexOf('.')
        for (let i = 2; state.assets.has(stored); i++) {
          stored = `${filename.slice(0, dot)}-${i}${filename.slice(dot)}`
        }
      }
      const asset: ServerAsset = { data, etag: md5Hex(data), contentType: 'image/png' }
      state.assets.set(stored, asset)
      state.uploads.push({ filename: stored, overwrite })
      return new Response(JSON.stringify({ asset: metaOf(stored, asset), path: stored }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    throw new Error(`asset fake server: unhandled ${method} ${path}`)
  }) as typeof fetch
}

function opsFor(state: AssetServer) {
  const api = createApi({ serverUrl: 'https://ink.example', apiKey: 'gd_sk_t', fetchImpl: fetchFor(state) })
  return docAssetOps(api, 'doc1')
}

/** Write a local file and record it as in-sync with the given server bytes. */
function recordSynced(dir: string, name: string, data: Uint8Array): void {
  const path = join(dir, name)
  writeFileSync(path, data)
  const stat = statSync(path)
  const state = readAssetState(dir)
  state[name] = { etag: md5Hex(data), size: stat.size, mtimeMs: stat.mtimeMs }
  writeAssetState(dir, state)
}

const BYTES_A = new Uint8Array([1, 2, 3, 4])
const BYTES_B = new Uint8Array([9, 8, 7, 6, 5])
const noop = () => {}

describe('syncAssets (two-way, mocked fetch)', () => {
  it('pushes a new local image and records the server etag', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'pic.png'), BYTES_A)
    const server = assetServer()
    const results = await syncAssets({ dir, ops: opsFor(server), mode: 'two-way', err: noop })
    expect(results).toEqual([{ filename: 'pic.png', action: 'pushed' }])
    expect(server.uploads).toEqual([{ filename: 'pic.png', overwrite: false }])
    expect(readAssetState(dir)['pic.png']).toMatchObject({ etag: md5Hex(BYTES_A), size: 4 })
  })

  it('pulls a new remote image to disk', async () => {
    const dir = tmp()
    const server = assetServer({ 'diagram.png': BYTES_A })
    const results = await syncAssets({ dir, ops: opsFor(server), mode: 'two-way', err: noop })
    expect(results).toEqual([{ filename: 'diagram.png', action: 'pulled' }])
    expect(new Uint8Array(readFileSync(join(dir, 'diagram.png')))).toEqual(BYTES_A)
    expect(readAssetState(dir)['diagram.png']).toMatchObject({ etag: md5Hex(BYTES_A) })
  })

  it('pushes a changed local image with overwrite', async () => {
    const dir = tmp()
    const server = assetServer({ 'pic.png': BYTES_A })
    recordSynced(dir, 'pic.png', BYTES_A)
    writeFileSync(join(dir, 'pic.png'), BYTES_B) // size differs → changed-local
    const results = await syncAssets({ dir, ops: opsFor(server), mode: 'two-way', err: noop })
    expect(results).toEqual([{ filename: 'pic.png', action: 'pushed' }])
    expect(server.uploads).toEqual([{ filename: 'pic.png', overwrite: true }])
    expect(server.assets.get('pic.png')!.data).toEqual(BYTES_B)
  })

  it('pulls a changed remote image (local untouched)', async () => {
    const dir = tmp()
    const server = assetServer()
    recordSynced(dir, 'pic.png', BYTES_A)
    server.assets.set('pic.png', { data: BYTES_B, etag: md5Hex(BYTES_B), contentType: 'image/png' })
    const results = await syncAssets({ dir, ops: opsFor(server), mode: 'two-way', err: noop })
    expect(results).toEqual([{ filename: 'pic.png', action: 'pulled' }])
    expect(new Uint8Array(readFileSync(join(dir, 'pic.png')))).toEqual(BYTES_B)
  })

  it('keeps local on both-changed, uploads it, and warns', async () => {
    const dir = tmp()
    const server = assetServer()
    recordSynced(dir, 'pic.png', BYTES_A)
    server.assets.set('pic.png', { data: BYTES_B, etag: md5Hex(BYTES_B), contentType: 'image/png' })
    const localEdit = new Uint8Array([5, 5, 5])
    writeFileSync(join(dir, 'pic.png'), localEdit)
    const warnings: string[] = []
    const results = await syncAssets({ dir, ops: opsFor(server), mode: 'two-way', err: (l) => warnings.push(l) })
    expect(results).toEqual([{ filename: 'pic.png', action: 'conflict-local-kept' }])
    expect(server.assets.get('pic.png')!.data).toEqual(localEdit)
    expect(server.uploads).toEqual([{ filename: 'pic.png', overwrite: true }])
    expect(warnings.some((w) => w.includes('keeping local'))).toBe(true)
  })

  it('reports up-to-date when nothing changed (no uploads, no downloads)', async () => {
    const dir = tmp()
    const server = assetServer({ 'pic.png': BYTES_A })
    recordSynced(dir, 'pic.png', BYTES_A)
    const results = await syncAssets({ dir, ops: opsFor(server), mode: 'two-way', err: noop })
    expect(results).toEqual([{ filename: 'pic.png', action: 'up-to-date' }])
    expect(server.uploads).toEqual([])
    expect(server.downloads).toEqual([])
  })

  it('adopts identical never-synced files without uploading (md5 == etag)', async () => {
    const dir = tmp()
    const server = assetServer({ 'pic.png': BYTES_A })
    writeFileSync(join(dir, 'pic.png'), BYTES_A) // same bytes, no assets.json
    const results = await syncAssets({ dir, ops: opsFor(server), mode: 'two-way', err: noop })
    expect(results).toEqual([{ filename: 'pic.png', action: 'up-to-date' }])
    expect(server.uploads).toEqual([])
    expect(readAssetState(dir)['pic.png']).toMatchObject({ etag: md5Hex(BYTES_A) })
  })

  it('skips non-image and oversized files', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'notes.md'), '# hi')
    writeFileSync(join(dir, 'data.bin'), BYTES_A)
    const server = assetServer()
    const results = await syncAssets({ dir, ops: opsFor(server), mode: 'two-way', err: noop })
    expect(results).toEqual([])
    expect(server.uploads).toEqual([])
  })
})

describe('syncAssets (push mode — glyphdown push --all)', () => {
  it('uploads new and changed local files but never downloads', async () => {
    const dir = tmp()
    const server = assetServer({ 'remote-only.png': BYTES_A })
    writeFileSync(join(dir, 'new.png'), BYTES_B)
    const results = await syncAssets({ dir, ops: opsFor(server), mode: 'push', err: noop })
    expect(results).toEqual([{ filename: 'new.png', action: 'pushed' }])
    expect(server.downloads).toEqual([])
    expect(readFileSync(join(dir, 'new.png'))).toBeTruthy()
    expect(() => readFileSync(join(dir, 'remote-only.png'))).toThrow() // not pulled
  })
})

describe('pullAssets (glyphdown pull / pull --folder)', () => {
  it('downloads remote assets and records state', async () => {
    const dir = tmp()
    const server = assetServer({ 'a.png': BYTES_A, 'b.png': BYTES_B })
    const results = await pullAssets({ dir, ops: opsFor(server), err: noop })
    expect(results.map((r) => `${r.filename}:${r.action}`)).toEqual(['a.png:pulled', 'b.png:pulled'])
    expect(new Uint8Array(readFileSync(join(dir, 'a.png')))).toEqual(BYTES_A)
    expect(new Uint8Array(readFileSync(join(dir, 'b.png')))).toEqual(BYTES_B)
  })

  it('skips files whose recorded etag and size still match', async () => {
    const dir = tmp()
    const server = assetServer({ 'a.png': BYTES_A })
    recordSynced(dir, 'a.png', BYTES_A)
    const results = await pullAssets({ dir, ops: opsFor(server), err: noop })
    expect(results).toEqual([{ filename: 'a.png', action: 'up-to-date' }])
    expect(server.downloads).toEqual([])
  })

  it('re-downloads when the remote etag changed', async () => {
    const dir = tmp()
    const server = assetServer()
    recordSynced(dir, 'a.png', BYTES_A)
    server.assets.set('a.png', { data: BYTES_B, etag: md5Hex(BYTES_B), contentType: 'image/png' })
    const results = await pullAssets({ dir, ops: opsFor(server), err: noop })
    expect(results).toEqual([{ filename: 'a.png', action: 'pulled' }])
    expect(new Uint8Array(readFileSync(join(dir, 'a.png')))).toEqual(BYTES_B)
  })
})
