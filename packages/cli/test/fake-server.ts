import {
  normalizeAssetFilename,
  slugifyDocStem,
  type DocMeta,
  type PushRequest,
  type PushResponse,
  type VaultMeta,
} from '@glyphdown/protocol'
import type { FolderMeta } from '../src/index.ts'
import { createApi, createProgram, md5Hex, sha256Hex, writePull } from '../src/index.ts'

/**
 * Fake Glyphdown server behind a mocked fetch, shared by the sync/mirror
 * suites. One asset namespace for the whole server (folder and doc asset
 * routes serve the same map) — tests that need isolation use one scope.
 */

export const SERVER = 'https://ink.example'

export interface ServerDoc {
  meta: DocMeta
  text: string
  versionId: string
}

export interface ServerAsset {
  filename: string
  data: Uint8Array
  etag: string
  contentType: string
}

export interface FakeServer {
  folders: FolderMeta[]
  docs: Map<string, ServerDoc>
  pushes: Array<{ docId: string; body: PushRequest }>
  /** One asset namespace for the whole fake server (folder or doc scoped). */
  assets: Map<string, ServerAsset>
  assetUploads: Array<{ scope: 'doc' | 'folder'; id: string; filename: string; overwrite: boolean }>
  /** Simulate older servers that do not expose POST /api/folders/:id/assets. */
  folderAssetUploadStatus?: number
  /** Override push behavior per doc; return undefined for the default apply. */
  onPush?: (docId: string, body: PushRequest) => PushResponse | undefined
  /** Counter for ids minted by POST /api/docs and POST /api/folders. */
  idCounter: number
}

export function server(partial: Partial<FakeServer> = {}): FakeServer {
  return { folders: [], docs: new Map(), pushes: [], assets: new Map(), assetUploads: [], idCounter: 0, ...partial }
}

/** Matches production: single-part R2 etags are the md5 of the bytes. */
export function serverAsset(filename: string, data: Uint8Array, contentType = 'image/png'): ServerAsset {
  return { filename, data, etag: md5Hex(data), contentType }
}

export function assetMetaOf(a: ServerAsset) {
  return {
    id: `asset-${a.filename}`,
    filename: a.filename,
    contentType: a.contentType,
    size: a.data.byteLength,
    etag: a.etag,
    createdBy: 'u1',
    createdAt: 1,
  }
}

/**
 * A server doc named after `name`: filename = slugified name + '.md', title =
 * the stem (the real server derives title from the filename, post-backfill).
 */
export function serverDoc(id: string, name: string, text: string, folderId: string | null = null): ServerDoc {
  const stem = slugifyDocStem(name.replace(/\.md$/i, ''))
  return {
    meta: { id, filename: `${stem}.md`, title: stem, folderId, ownerUserId: 'u1', role: 'editor', createdAt: 1, updatedAt: 2 },
    text,
    versionId: 'v1',
  }
}

/** First free filename in a scope, '-2'/'-3' suffixed — mirrors the server. */
function availableIn(state: FakeServer, folderId: string | null, requested: string): string {
  const taken = new Set([...state.docs.values()].filter((d) => d.meta.folderId === folderId).map((d) => d.meta.filename))
  if (!taken.has(requested)) return requested
  const stem = requested.replace(/\.md$/, '')
  for (let n = 2; ; n++) {
    const candidate = `${stem}-${n}.md`
    if (!taken.has(candidate)) return candidate
  }
}

export function folder(id: string, name: string, parentId: string | null = null): FolderMeta {
  // Mirrors the post-vaults server shape: root rows are vaults.
  return { id, name, kind: parentId === null ? 'vault' : 'folder', parentId, ownerUserId: 'u1', role: 'owner', createdAt: 1 }
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

export function rejectionStatus(response: Extract<PushResponse, { ok: false }>): number {
  if (response.reason === 'rate-limited') return 429
  if (response.reason === 'forbidden') return 403
  if (response.reason === 'too-large') return 413
  return 409
}

export function fetchFor(state: FakeServer): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = init?.method ?? 'GET'
    const path = url.pathname

    if (method === 'GET' && path === '/api/folders') return jsonResponse({ folders: state.folders })
    if (method === 'GET' && path === '/api/vaults') {
      // Mirrors the real /api/vaults: vault rows (kind='vault') as VaultMeta,
      // oldest first — FolderMeta minus the fields a vault pins.
      const vaults = state.folders
        .filter((f) => f.kind === 'vault')
        .map(({ id, name, ownerUserId, role, createdAt }): VaultMeta => ({ id, name, ownerUserId, role, createdAt }))
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      return jsonResponse({ vaults })
    }
    if (method === 'POST' && path === '/api/folders') {
      const body = JSON.parse(init?.body as string) as { name?: string; parentId?: string }
      const parentId = body.parentId ?? null
      if (parentId !== null && !state.folders.some((f) => f.id === parentId)) {
        return jsonResponse({ error: 'parent-not-found' }, 404)
      }
      const created = folder(`folder-created-${++state.idCounter}`, body.name ?? '', parentId)
      state.folders.push(created)
      return jsonResponse(created)
    }
    if (method === 'GET' && path === '/api/docs') {
      return jsonResponse({ docs: [...state.docs.values()].map((d) => d.meta) })
    }
    if (method === 'POST' && path === '/api/docs') {
      const body = JSON.parse(init?.body as string) as { filename?: string; title?: string; folderId?: string }
      const folderId = body.folderId ?? null
      if (folderId !== null && !state.folders.some((f) => f.id === folderId)) {
        return jsonResponse({ error: 'folder-not-found' }, 404)
      }
      // filename wins; a bare title is slugified; collisions auto-suffix.
      const requested = `${slugifyDocStem((body.filename ?? body.title ?? 'untitled').replace(/\.md$/i, ''))}.md`
      const doc = serverDoc(`doc-created-${++state.idCounter}`, 'placeholder', '', folderId)
      doc.meta.filename = availableIn(state, folderId, requested)
      doc.meta.title = doc.meta.filename.replace(/\.md$/, '')
      doc.versionId = 'v0' // fresh docs start empty
      state.docs.set(doc.meta.id, doc)
      return jsonResponse(doc.meta)
    }

    const contentMatch = path.match(/^\/api\/docs\/([^/]+)\/content$/)
    if (method === 'GET' && contentMatch) {
      const doc = state.docs.get(contentMatch[1]!)
      if (!doc) return jsonResponse({ error: 'not-found' }, 404)
      return new Response(doc.text, {
        status: 200,
        headers: {
          'content-type': 'text/markdown; charset=utf-8',
          'x-glyphdown-version': doc.versionId,
          'x-glyphdown-base-hash': sha256Hex(doc.text),
          // The real server also echoes the legacy x-inkroom-* names for one
          // release; mirrored here so the fake stays faithful.
          'x-inkroom-version': doc.versionId,
          'x-inkroom-base-hash': sha256Hex(doc.text),
        },
      })
    }

    const pushMatch = path.match(/^\/api\/docs\/([^/]+)\/push$/)
    if (method === 'POST' && pushMatch) {
      const docId = pushMatch[1]!
      const doc = state.docs.get(docId)
      if (!doc) return jsonResponse({ error: 'not-found' }, 404)
      const body = JSON.parse(init?.body as string) as PushRequest
      state.pushes.push({ docId, body })
      const custom = state.onPush?.(docId, body)
      if (custom) return jsonResponse(custom, custom.ok ? 200 : rejectionStatus(custom))
      // Default: the doc adopts newText wholesale (fast path, no drift).
      doc.text = body.newText
      doc.versionId = `v-push-${state.pushes.length}`
      return jsonResponse({
        ok: true,
        mode: 'edit',
        applied: 1,
        failedHunks: [],
        versionId: doc.versionId,
      } satisfies PushResponse)
    }

    const docMatch = path.match(/^\/api\/docs\/([^/]+)$/)
    if (method === 'GET' && docMatch) {
      const doc = state.docs.get(docMatch[1]!)
      if (!doc) return jsonResponse({ error: 'not-found' }, 404)
      return jsonResponse(doc.meta)
    }
    if (method === 'DELETE' && docMatch) {
      const doc = state.docs.get(docMatch[1]!)
      if (!doc) return jsonResponse({ error: 'not-found' }, 404)
      state.docs.delete(doc.meta.id)
      return jsonResponse({ ok: true })
    }
    if (method === 'PATCH' && docMatch) {
      const doc = state.docs.get(docMatch[1]!)
      if (!doc) return jsonResponse({ error: 'not-found' }, 404)
      const body = JSON.parse(init?.body as string) as { filename?: string }
      if (typeof body.filename !== 'string') return jsonResponse({ error: 'bad-request' }, 400)
      const withExt = body.filename.endsWith('.md') ? body.filename : `${body.filename}.md`
      if (`${slugifyDocStem(withExt.replace(/\.md$/, ''))}.md` !== withExt) {
        return jsonResponse({ error: 'bad-filename' }, 400)
      }
      const clash = [...state.docs.values()].some(
        (d) => d.meta.id !== doc.meta.id && d.meta.folderId === doc.meta.folderId && d.meta.filename === withExt,
      )
      if (clash) return jsonResponse({ error: 'filename-taken' }, 409)
      doc.meta.filename = withExt
      doc.meta.title = withExt.replace(/\.md$/, '')
      return jsonResponse(doc.meta)
    }

    // --- assets (shared namespace; folder + doc routes serve the same map) --
    const assetListMatch = path.match(/^\/api\/(?:docs|folders)\/[^/]+\/assets$/)
    if (method === 'GET' && assetListMatch) {
      return jsonResponse({ assets: [...state.assets.values()].map(assetMetaOf) })
    }
    const assetFileMatch = path.match(/^\/api\/(?:docs|folders)\/[^/]+\/assets\/([^/]+)$/)
    if (method === 'GET' && assetFileMatch) {
      const asset = state.assets.get(decodeURIComponent(assetFileMatch[1]!))
      if (!asset) return jsonResponse({ error: 'not-found' }, 404)
      return new Response(asset.data.slice() as unknown as RequestInit['body'] as never, {
        status: 200,
        headers: {
          'content-type': asset.contentType,
          etag: `"${asset.etag}"`,
          'cache-control': 'private, max-age=3600',
        },
      })
    }
    const assetUploadMatch = path.match(/^\/api\/(docs|folders)\/([^/]+)\/assets$/)
    if (method === 'POST' && assetUploadMatch) {
      if (assetUploadMatch[1] === 'folders' && state.folderAssetUploadStatus !== undefined) {
        return jsonResponse({ error: 'method-not-allowed' }, state.folderAssetUploadStatus)
      }
      const filename = normalizeAssetFilename(url.searchParams.get('filename')!) ?? 'asset'
      const overwrite = url.searchParams.get('overwrite') === 'true'
      const body = init?.body as Uint8Array
      const data = new Uint8Array(body)
      let stored = filename
      if (state.assets.has(filename) && !overwrite) {
        const dot = filename.lastIndexOf('.')
        const stem = dot > 0 ? filename.slice(0, dot) : filename
        const ext = dot > 0 ? filename.slice(dot) : ''
        for (let i = 2; state.assets.has(stored); i++) stored = `${stem}-${i}${ext}`
      }
      const contentType = (init?.headers as Record<string, string>)['content-type'] ?? 'image/png'
      const asset = serverAsset(stored, data, contentType)
      state.assets.set(stored, asset)
      state.assetUploads.push({
        scope: assetUploadMatch[1] === 'folders' ? 'folder' : 'doc',
        id: assetUploadMatch[2]!,
        filename: stored,
        overwrite,
      })
      return jsonResponse({ asset: assetMetaOf(asset), path: stored })
    }

    throw new Error(`fake server: unhandled ${method} ${path}`)
  }) as typeof fetch
}

export interface Harness {
  lines: string[]
  errors: string[]
  run: (args: string[]) => Promise<void>
}

// picocolors turns styling on whenever CI is set, so harness assertions must
// see the unstyled text in any environment.
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
const stripAnsi = (s: string) => s.replace(ANSI_PATTERN, '')

export function harness(dir: string, state: FakeServer): Harness {
  const lines: string[] = []
  const errors: string[] = []
  const program = createProgram({
    makeApi: (cfg) => createApi({ serverUrl: cfg.serverUrl, apiKey: 'gd_sk_test', fetchImpl: fetchFor(state) }),
    env: { GLYPHDOWN_SERVER: SERVER, GLYPHDOWN_API_KEY: 'gd_sk_test' },
    cwd: () => dir,
    out: (l) => lines.push(stripAnsi(l)),
    err: (l) => errors.push(stripAnsi(l)),
  })
  return { lines, errors, run: (args) => program.parseAsync(args, { from: 'user' }).then(() => undefined) }
}

/** Track a doc locally exactly as a prior `glyphdown pull` would have. */
export function track(dir: string, file: string, docId: string, text: string): void {
  writePull({ targetPath: file, docId, serverUrl: SERVER, text, versionId: 'v1' }, dir)
}
