import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PushResponse } from '@glyphdown/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import type { SyncDocResult } from '../src/index.ts'
import { CliError, md5Hex, readFolderConfig, sha256Hex, writeFolderConfig } from '../src/index.ts'
import { SERVER, folder, harness, server, serverAsset, serverDoc, track } from './fake-server.ts'

const dirs: string[] = []
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ink-sync-test-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// glyphdown pull --folder
// ---------------------------------------------------------------------------

describe('glyphdown pull --folder', () => {
  it('pulls every folder doc, suffixing colliding slugs, and records folder.json', async () => {
    const state = server({ folders: [folder('f1', 'Launch Specs')] })
    state.docs.set('d1', serverDoc('d1', 'Plan', '# Plan one\n', 'f1'))
    state.docs.set('d2', serverDoc('d2', 'Plan', '# Plan two\n', 'f1'))
    state.docs.set('d3', serverDoc('d3', 'Elsewhere', '# not in folder\n', null))

    const dir = tmp()
    const h = harness(dir, state)
    await h.run(['pull', '--folder', 'Launch Specs'])

    const target = join(dir, 'launch-specs')
    expect(readFileSync(join(target, 'plan.md'), 'utf8')).toBe('# Plan one\n')
    expect(readFileSync(join(target, 'plan-2.md'), 'utf8')).toBe('# Plan two\n')
    expect(existsSync(join(target, 'elsewhere.md'))).toBe(false)

    const meta = JSON.parse(readFileSync(join(target, '.glyphdown', 'd2', 'meta.json'), 'utf8')) as Record<string, unknown>
    expect(meta.file).toBe('plan-2.md')
    expect(meta.baseHash).toBe(sha256Hex('# Plan two\n'))

    expect(readFolderConfig(target)).toEqual({ folderId: 'f1', folderName: 'Launch Specs', serverUrl: SERVER })
    expect(h.lines.join('\n')).toContain('2 doc(s)')
  })

  it('errors listing the candidates when a folder name is ambiguous, but accepts the id', async () => {
    const state = server({ folders: [folder('fa', 'Specs'), folder('fb', 'Specs')] })
    state.docs.set('d1', serverDoc('d1', 'Doc', 'text\n', 'fa'))

    const dir = tmp()
    const h = harness(dir, state)
    await expect(h.run(['pull', '--folder', 'Specs'])).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(CliError)
      expect((error as CliError).exitCode).toBe(1)
      expect((error as CliError).message).toContain('fa')
      expect((error as CliError).message).toContain('fb')
      return true
    })

    await h.run(['pull', '--folder', 'fa', 'dest'])
    expect(readFileSync(join(dir, 'dest', 'doc.md'), 'utf8')).toBe('text\n')
  })

  it('downloads folder assets into the target dir and skips them on re-pull', async () => {
    const state = server({ folders: [folder('f1', 'Specs')] })
    state.docs.set('d1', serverDoc('d1', 'Doc', '![d](diagram.png)\n', 'f1'))
    const bytes = new Uint8Array([1, 2, 3, 4, 5])
    state.assets.set('diagram.png', serverAsset('diagram.png', bytes))

    const dir = tmp()
    const h = harness(dir, state)
    await h.run(['pull', '--folder', 'f1'])

    const target = join(dir, 'specs')
    expect(new Uint8Array(readFileSync(join(target, 'diagram.png')))).toEqual(bytes)
    expect(h.lines.some((l) => l.includes('asset diagram.png') && l.includes('pulled'))).toBe(true)
    const assetState = JSON.parse(readFileSync(join(target, '.glyphdown', 'assets.json'), 'utf8')) as Record<
      string,
      { etag: string; size: number }
    >
    expect(assetState['diagram.png']).toMatchObject({ etag: md5Hex(bytes), size: 5 })

    // Re-pull: size+etag match the recorded state → no second download line.
    h.lines.length = 0
    await h.run(['pull', '--folder', 'f1'])
    expect(h.lines.some((l) => l.includes('asset diagram.png') && l.includes('pulled'))).toBe(false)
  })
})

describe('glyphdown sync + push --all with assets', () => {
  it('sync pushes new local images and pulls new remote ones', async () => {
    const state = server({ folders: [folder('f1', 'Specs')] })
    state.docs.set('d1', serverDoc('d1', 'Doc', 'text\n', 'f1'))
    const remoteBytes = new Uint8Array([7, 7, 7])
    state.assets.set('remote.png', serverAsset('remote.png', remoteBytes))

    const dir = tmp()
    const h = harness(dir, state)
    await h.run(['pull', '--folder', 'f1'])
    const target = join(dir, 'specs')

    const localBytes = new Uint8Array([9, 9, 9, 9])
    writeFileSync(join(target, 'local.png'), localBytes)
    state.assets.set('added-later.png', serverAsset('added-later.png', new Uint8Array([4, 4])))

    await h.run(['sync', target])
    expect(state.assets.get('local.png')!.data).toEqual(localBytes)
    expect(state.assetUploads.at(-1)).toMatchObject({ scope: 'folder', id: 'f1', filename: 'local.png', overwrite: false })
    expect(new Uint8Array(readFileSync(join(target, 'added-later.png')))).toEqual(new Uint8Array([4, 4]))
    expect(h.lines.some((l) => l.includes('asset local.png') && l.includes('pushed'))).toBe(true)
    expect(h.lines.some((l) => l.includes('asset added-later.png') && l.includes('pulled'))).toBe(true)
  })

  it('push --all uploads changed images with overwrite and never downloads', async () => {
    const state = server({ folders: [folder('f1', 'Specs')] })
    state.docs.set('d1', serverDoc('d1', 'Doc', 'text\n', 'f1'))
    state.assets.set('pic.png', serverAsset('pic.png', new Uint8Array([1, 1, 1])))
    state.assets.set('remote-only.png', serverAsset('remote-only.png', new Uint8Array([2])))

    const dir = tmp()
    const h = harness(dir, state)
    await h.run(['pull', '--folder', 'f1'])
    const target = join(dir, 'specs')

    const edited = new Uint8Array([3, 3, 3, 3, 3])
    writeFileSync(join(target, 'pic.png'), edited)
    rmSync(join(target, 'remote-only.png'))

    await h.run(['push', '--all', target])
    expect(state.assets.get('pic.png')!.data).toEqual(edited)
    expect(state.assetUploads.at(-1)).toMatchObject({ scope: 'folder', id: 'f1', filename: 'pic.png', overwrite: true })
    // push mode never downloads — the deleted local copy stays deleted.
    expect(existsSync(join(target, 'remote-only.png'))).toBe(false)
    expect(h.lines.some((l) => l.includes('asset pic.png') && l.includes('pushed'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// glyphdown push --all
// ---------------------------------------------------------------------------

describe('glyphdown push --all', () => {
  it('detects dirty docs by base hash and pushes only those, sequentially', async () => {
    const state = server()
    state.docs.set('d1', serverDoc('d1', 'A', 'one\n'))
    state.docs.set('d2', serverDoc('d2', 'B', 'two\n'))

    const dir = tmp()
    track(dir, 'a.md', 'd1', 'one\n')
    track(dir, 'b.md', 'd2', 'two\n')
    writeFileSync(join(dir, 'b.md'), 'two edited\r\n') // CRLF must be normalized before hashing

    const h = harness(dir, state)
    await h.run(['push', '--all'])

    expect(state.pushes.map((p) => p.docId)).toEqual(['d2'])
    expect(state.pushes[0]!.body.newText).toBe('two edited\n')
    expect(readFileSync(join(dir, '.glyphdown', 'd2', 'base.md'), 'utf8')).toBe('two edited\n')
    expect(readFileSync(join(dir, '.glyphdown', 'd1', 'base.md'), 'utf8')).toBe('one\n')
    const joined = h.lines.join('\n')
    expect(joined).toContain('unchanged a.md')
    expect(joined).toContain('pushed b.md')
    expect(joined).toContain('1 pushed, 1 unchanged, 0 failed')
  })

  it('keeps exit 3 when the single failure is a degenerate rejection', async () => {
    const state = server({
      onPush: () => ({ ok: false, reason: 'degenerate', deletedRatio: 0.8 }),
    })
    state.docs.set('d1', serverDoc('d1', 'A', 'one\n'))

    const dir = tmp()
    track(dir, 'a.md', 'd1', 'one\n')
    writeFileSync(join(dir, 'a.md'), 'rewrite\n')

    const h = harness(dir, state)
    await expect(h.run(['push', '--all'])).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(CliError)
      expect((error as CliError).exitCode).toBe(3)
      return true
    })
    expect(readFileSync(join(dir, '.glyphdown', 'd1', 'base.md'), 'utf8')).toBe('one\n')
    expect(h.errors.join('\n')).toContain('rewrites most of it')
  })

  it('exits 1 with a summary when multiple distinct failures occur, continuing past each', async () => {
    const state = server({
      onPush: (docId): PushResponse =>
        docId === 'd1' ? { ok: false, reason: 'degenerate', deletedRatio: 0.9 } : { ok: false, reason: 'forbidden' },
    })
    state.docs.set('d1', serverDoc('d1', 'A', 'one\n'))
    state.docs.set('d2', serverDoc('d2', 'B', 'two\n'))

    const dir = tmp()
    track(dir, 'a.md', 'd1', 'one\n')
    track(dir, 'b.md', 'd2', 'two\n')
    writeFileSync(join(dir, 'a.md'), 'one edited\n')
    writeFileSync(join(dir, 'b.md'), 'two edited\n')

    const h = harness(dir, state)
    await expect(h.run(['push', '--all'])).rejects.toSatisfy((error: unknown) => {
      expect((error as CliError).exitCode).toBe(1)
      expect((error as CliError).message).toContain('2 of 2')
      return true
    })
    // Both docs were attempted despite the first failure.
    expect(state.pushes.map((p) => p.docId).sort()).toEqual(['d1', 'd2'])
  })
})

// ---------------------------------------------------------------------------
// glyphdown sync
// ---------------------------------------------------------------------------

function parseResults(lines: string[]): Map<string, SyncDocResult> {
  const results = JSON.parse(lines.join('\n')) as SyncDocResult[]
  return new Map(results.map((r) => [r.docId, r]))
}

describe('glyphdown sync', () => {
  it('runs the full decision matrix: none/local/remote/both/new/remote-gone', async () => {
    const state = server({ folders: [folder('f1', 'Specs')] })
    state.docs.set('d-none', serverDoc('d-none', 'None', 'unchanged\n', 'f1'))
    state.docs.set('d-local', serverDoc('d-local', 'Local', 'local base\n', 'f1'))
    state.docs.set('d-remote', serverDoc('d-remote', 'Remote', 'remote base\n', 'f1'))
    state.docs.set('d-both', serverDoc('d-both', 'Both', 'both base\n', 'f1'))
    state.docs.set('d-new', serverDoc('d-new', 'New Doc', 'fresh from the folder\n', 'f1'))
    // d-gone is tracked locally but no longer exists server-side.

    const dir = tmp()
    track(dir, 'none.md', 'd-none', 'unchanged\n')
    track(dir, 'local.md', 'd-local', 'local base\n')
    track(dir, 'remote.md', 'd-remote', 'remote base\n')
    track(dir, 'both.md', 'd-both', 'both base\n')
    track(dir, 'gone.md', 'd-gone', 'orphaned\n')
    writeFolderConfig(dir, { folderId: 'f1', folderName: 'Specs', serverUrl: SERVER })

    // Drift each side.
    writeFileSync(join(dir, 'local.md'), 'local base\nlocal edit\n')
    state.docs.get('d-remote')!.text = 'remote base\nremote edit\n'
    state.docs.get('d-remote')!.versionId = 'v2'
    writeFileSync(join(dir, 'both.md'), 'both base\nlocal half\n')
    state.docs.get('d-both')!.text = 'both base\nremote half\n'
    state.onPush = (docId) => {
      if (docId !== 'd-both') return undefined
      const doc = state.docs.get('d-both')!
      doc.text = 'both base\nlocal half\nremote half\n' // the CRDT merge result
      doc.versionId = 'v-merged'
      return { ok: true, mode: 'edit', applied: 1, failedHunks: [], versionId: 'v-merged' }
    }

    const h = harness(dir, state)
    await h.run(['sync', '--json']) // resolves: exit 0 — remote-gone only warns

    const results = parseResults(h.lines)
    expect(results.get('d-none')?.action).toBe('up-to-date')
    expect(results.get('d-local')?.action).toBe('pushed')
    expect(results.get('d-remote')?.action).toBe('pulled')
    expect(results.get('d-both')?.action).toBe('merged')
    expect(results.get('d-gone')?.action).toBe('remote-gone')
    expect(results.get('d-new')?.action).toBe('new')
    expect(results.size).toBe(6)

    // local only: server received the push; base advanced to the local text.
    expect(state.pushes.map((p) => p.docId).sort()).toEqual(['d-both', 'd-local'])
    expect(readFileSync(join(dir, '.glyphdown', 'd-local', 'base.md'), 'utf8')).toBe('local base\nlocal edit\n')

    // remote only: file overwritten with the fetched text, base advanced.
    expect(readFileSync(join(dir, 'remote.md'), 'utf8')).toBe('remote base\nremote edit\n')
    expect(readFileSync(join(dir, '.glyphdown', 'd-remote', 'base.md'), 'utf8')).toBe('remote base\nremote edit\n')

    // both changed: the merged text was re-fetched into file + base.
    expect(readFileSync(join(dir, 'both.md'), 'utf8')).toBe('both base\nlocal half\nremote half\n')
    expect(readFileSync(join(dir, '.glyphdown', 'd-both', 'base.md'), 'utf8')).toBe('both base\nlocal half\nremote half\n')

    // new folder doc: pulled with full bookkeeping.
    expect(readFileSync(join(dir, 'new-doc.md'), 'utf8')).toBe('fresh from the folder\n')
    expect(existsSync(join(dir, '.glyphdown', 'd-new', 'meta.json'))).toBe(true)

    // remote gone: warned, local file left alone.
    expect(readFileSync(join(dir, 'gone.md'), 'utf8')).toBe('orphaned\n')
    expect(h.errors.join('\n')).toContain('gone on the server')
  })

  it('skips a degenerate push (file left alone) and exits 3 — unless --force', async () => {
    const state = server()
    state.docs.set('d1', serverDoc('d1', 'Doc', 'base text\n'))

    const dir = tmp()
    track(dir, 'doc.md', 'd1', 'base text\n')
    writeFileSync(join(dir, 'doc.md'), 'total rewrite\n')
    state.docs.get('d1')!.text = 'base text\ndrifted\n' // concurrent server edit
    state.onPush = (_docId, body) =>
      body.force ? undefined : { ok: false, reason: 'degenerate', deletedRatio: 0.9 }

    const h = harness(dir, state)
    await expect(h.run(['sync'])).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(CliError)
      expect((error as CliError).exitCode).toBe(3)
      return true
    })
    expect(readFileSync(join(dir, 'doc.md'), 'utf8')).toBe('total rewrite\n')
    expect(readFileSync(join(dir, '.glyphdown', 'd1', 'base.md'), 'utf8')).toBe('base text\n')
    expect(h.lines.join('\n')).toContain('skipped (degenerate)')

    const h2 = harness(dir, state)
    await h2.run(['sync', '--force', '--json'])
    const results = parseResults(h2.lines)
    expect(results.get('d1')?.action).toBe('merged')
    expect(state.pushes.at(-1)?.body.force).toBe(true)
  })

  it('reports failed hunks on a merge and exits 2', async () => {
    const state = server()
    state.docs.set('d1', serverDoc('d1', 'Doc', 'base text\n'))

    const dir = tmp()
    track(dir, 'doc.md', 'd1', 'base text\n')
    writeFileSync(join(dir, 'doc.md'), 'base text\nlocal edit\n')
    state.docs.get('d1')!.text = 'base text\nremote edit\n'
    state.onPush = () => {
      state.docs.get('d1')!.text = 'base text\nremote edit\nlocal edit\n'
      return { ok: true, mode: 'edit', applied: 1, failedHunks: ['@@ -1 +1 @@\n-x\n+y\n'], versionId: 'v9' }
    }

    const h = harness(dir, state)
    await expect(h.run(['sync', '--json'])).rejects.toSatisfy((error: unknown) => {
      expect((error as CliError).exitCode).toBe(2)
      return true
    })
    const results = parseResults(h.lines)
    expect(results.get('d1')?.action).toBe('merged')
    expect(results.get('d1')?.failedHunks).toBe(1)
    // The merged server text still converged locally.
    expect(readFileSync(join(dir, 'doc.md'), 'utf8')).toBe('base text\nremote edit\nlocal edit\n')
  })

  it('errors with guidance when there is nothing to sync', async () => {
    const h = harness(tmp(), server())
    await expect(h.run(['sync'])).rejects.toSatisfy((error: unknown) => {
      expect((error as CliError).exitCode).toBe(1)
      expect((error as CliError).message).toMatch(/glyphdown pull/)
      return true
    })
  })
})
