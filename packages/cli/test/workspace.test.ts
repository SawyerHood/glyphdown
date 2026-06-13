import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeEol } from '@glyphdown/core'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CliError,
  archiveDocFile,
  findWorkspace,
  parseDocRef,
  recordBase,
  removeDocState,
  sha256Hex,
  slugify,
  workspaceRoot,
  writePull,
  writeTombstone,
} from '../src/index.ts'

const dirs: string[] = []
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ink-cli-test-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('writePull', () => {
  it('writes the md file plus .glyphdown/<docId>/{meta.json,base.md} with the hash over normalized text', () => {
    const dir = tmp()
    const text = normalizeEol('# Title\r\n\r\nBody\r\n') // boundary normalization happens before writePull
    const ws = writePull(
      { targetPath: 'title.md', docId: 'docA', serverUrl: 'https://ink.example', text, versionId: 'v1' },
      dir,
    )

    expect(readFileSync(join(dir, 'title.md'), 'utf8')).toBe('# Title\n\nBody\n')
    expect(readFileSync(join(dir, '.glyphdown', 'docA', 'base.md'), 'utf8')).toBe('# Title\n\nBody\n')

    const meta = JSON.parse(readFileSync(join(dir, '.glyphdown', 'docA', 'meta.json'), 'utf8')) as Record<string, unknown>
    expect(meta.docId).toBe('docA')
    expect(meta.serverUrl).toBe('https://ink.example')
    expect(meta.baseHash).toBe(sha256Hex('# Title\n\nBody\n'))
    expect(meta.versionId).toBe('v1')
    expect(meta.file).toBe('title.md')
    expect(typeof meta.pulledAt).toBe('number')
    expect(ws.meta.baseHash).toBe(meta.baseHash)
  })
})

describe('findWorkspace', () => {
  it('finds the workspace by explicit path and normalizes the stored base', () => {
    const dir = tmp()
    writePull({ targetPath: 'doc.md', docId: 'd1', serverUrl: 'https://s', text: 'hello\n' }, dir)
    const ws = findWorkspace('doc.md', dir)
    expect(ws.meta.docId).toBe('d1')
    expect(ws.baseText).toBe('hello\n')
    expect(ws.path).toBe(join(dir, 'doc.md'))
  })

  it('finds the single pulled doc when no path is given', () => {
    const dir = tmp()
    writePull({ targetPath: 'only.md', docId: 'solo', serverUrl: 'https://s', text: 'x\n' }, dir)
    const ws = findWorkspace(undefined, dir)
    expect(ws.meta.docId).toBe('solo')
    expect(ws.meta.file).toBe('only.md')
  })

  it('refuses an ambiguous push when multiple docs are pulled in one directory', () => {
    const dir = tmp()
    writePull({ targetPath: 'a.md', docId: 'da', serverUrl: 'https://s', text: 'a\n' }, dir)
    writePull({ targetPath: 'b.md', docId: 'db', serverUrl: 'https://s', text: 'b\n' }, dir)
    expect(() => findWorkspace(undefined, dir)).toThrowError(/multiple pulled docs/)
  })

  it('errors with guidance when there is no metadata', () => {
    const dir = tmp()
    writeFileSync(join(dir, 'stray.md'), 'not pulled\n')
    try {
      findWorkspace('stray.md', dir)
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(CliError)
      expect((error as CliError).exitCode).toBe(1)
      expect((error as CliError).message).toMatch(/glyphdown pull/)
    }
  })
})

describe('legacy .ink workspaces', () => {
  it('keeps using an existing .ink/ dir — metas found, bases written back, no migration', () => {
    const dir = tmp()
    // Simulate a workspace created by the pre-rename `ink` CLI.
    mkdirSync(join(dir, '.ink', 'dL'), { recursive: true })
    writeFileSync(join(dir, '.ink', 'dL', 'base.md'), 'legacy base\n')
    writeFileSync(
      join(dir, '.ink', 'dL', 'meta.json'),
      JSON.stringify({
        docId: 'dL',
        serverUrl: 'https://s',
        baseHash: sha256Hex('legacy base\n'),
        pulledAt: 1,
        file: 'doc.md',
      }),
    )
    writeFileSync(join(dir, 'doc.md'), 'legacy base\n')

    const ws = findWorkspace('doc.md', dir)
    expect(ws.baseText).toBe('legacy base\n')

    recordBase({ dir, file: 'doc.md', docId: 'dL', serverUrl: 'https://s', text: 'updated\n' })
    expect(readFileSync(join(dir, '.ink', 'dL', 'base.md'), 'utf8')).toBe('updated\n')
    // The legacy dir keeps being used; no .glyphdown/ is created beside it.
    expect(existsSync(join(dir, '.glyphdown'))).toBe(false)
  })

  it('prefers .glyphdown/ when both bookkeeping dirs exist, else uses .ink/, else defaults to .glyphdown/', () => {
    const dir = tmp()
    expect(workspaceRoot(dir)).toBe(join(dir, '.glyphdown'))
    mkdirSync(join(dir, '.ink'), { recursive: true })
    expect(workspaceRoot(dir)).toBe(join(dir, '.ink'))
    mkdirSync(join(dir, '.glyphdown'), { recursive: true })
    expect(workspaceRoot(dir)).toBe(join(dir, '.glyphdown'))
  })
})

describe('recordBase', () => {
  it('refreshes base.md and meta.json after a successful push', () => {
    const dir = tmp()
    writePull({ targetPath: 'doc.md', docId: 'd1', serverUrl: 'https://s', text: 'before\n' }, dir)
    const meta = recordBase({
      dir,
      file: 'doc.md',
      docId: 'd1',
      serverUrl: 'https://s',
      text: 'after\n',
      versionId: 'v9',
    })
    expect(readFileSync(join(dir, '.glyphdown', 'd1', 'base.md'), 'utf8')).toBe('after\n')
    expect(meta.baseHash).toBe(sha256Hex('after\n'))
    const stored = JSON.parse(readFileSync(join(dir, '.glyphdown', 'd1', 'meta.json'), 'utf8')) as Record<string, unknown>
    expect(stored.baseHash).toBe(meta.baseHash)
    expect(stored.versionId).toBe('v9')
  })
})

describe('delete helpers', () => {
  it('archives a tracked doc file, removes active state, and writes a tombstone', () => {
    const dir = tmp()
    const ws = writePull({ targetPath: 'doc.md', docId: 'd1', serverUrl: 'https://s', text: 'before\n' }, dir)
    writeFileSync(join(dir, 'doc.md'), 'local edit\n')

    const archived = archiveDocFile(dir, ws.meta, 'docs')
    expect(archived).not.toBeNull()
    expect(archived).toContain(join(dir, '.glyphdown', 'trash', 'docs'))
    expect(readFileSync(archived!, 'utf8')).toBe('local edit\n')
    expect(existsSync(join(dir, 'doc.md'))).toBe(false)

    writeTombstone(dir, {
      docId: ws.meta.docId,
      file: ws.meta.file,
      serverUrl: ws.meta.serverUrl,
      baseHash: ws.meta.baseHash,
      origin: 'rm-command',
      recordedAt: 123,
      archivedPath: archived!,
      localChanged: true,
    })
    const tombstones = JSON.parse(readFileSync(join(dir, '.glyphdown', 'tombstones.json'), 'utf8')) as Record<string, unknown>
    expect(tombstones).toMatchObject({ version: 1, docs: { d1: { file: 'doc.md', origin: 'rm-command' } } })

    removeDocState(dir, 'd1')
    expect(existsSync(join(dir, '.glyphdown', 'd1'))).toBe(false)
  })
})

describe('helpers', () => {
  it('slugify produces filesystem-friendly names', () => {
    expect(slugify('My Doc: Draft #2!')).toBe('my-doc-draft-2')
    expect(slugify('   ')).toBe('untitled')
  })

  it('sha256Hex matches a known vector', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('parseDocRef accepts ids and /d/:docId URLs', () => {
    expect(parseDocRef('doc-123')).toBe('doc-123')
    expect(parseDocRef('https://ink.example/d/doc-123')).toBe('doc-123')
    expect(parseDocRef('https://ink.example/d/doc-123/history')).toBe('doc-123')
  })
})
