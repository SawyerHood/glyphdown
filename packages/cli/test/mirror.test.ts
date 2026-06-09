import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SyncDocResult } from '../src/index.ts'
import { CliError, filenameForLocalFile, readFolderConfig, readWorkspaceConfig, sha256Hex } from '../src/index.ts'
import { SERVER, type FakeServer, folder, harness, server, serverAsset, serverDoc, track } from './fake-server.ts'

const dirs: string[] = []
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ink-mirror-test-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function parseResults(lines: string[]): Map<string, SyncDocResult> {
  const results = JSON.parse(lines.join('\n')) as SyncDocResult[]
  return new Map(results.map((r) => [r.docId, r]))
}

/** An account with a nested tree: Team > Projects > Q3, plus root docs. */
function nestedAccount(): FakeServer {
  const state = server({
    folders: [folder('f-team', 'Team'), folder('f-proj', 'Projects', 'f-team'), folder('f-q3', 'Q3', 'f-proj')],
  })
  state.docs.set('d-root', serverDoc('d-root', 'Readme', '# Readme\n', null))
  state.docs.set('d-team', serverDoc('d-team', 'Team Notes', 'team notes\n', 'f-team'))
  state.docs.set('d-q3', serverDoc('d-q3', 'Plan', 'q3 plan\n', 'f-q3'))
  return state
}

// ---------------------------------------------------------------------------
// glyphdown clone
// ---------------------------------------------------------------------------

describe('glyphdown clone', () => {
  it('mirrors the folder tree as nested dirs with docs in place and a root manifest', async () => {
    const state = nestedAccount()
    const dir = tmp()
    const h = harness(dir, state)
    await h.run(['clone', 'work'])

    const root = join(dir, 'work')
    expect(readFileSync(join(root, 'readme.md'), 'utf8')).toBe('# Readme\n')
    expect(readFileSync(join(root, 'team', 'team-notes.md'), 'utf8')).toBe('team notes\n')
    expect(readFileSync(join(root, 'team', 'projects', 'q3', 'plan.md'), 'utf8')).toBe('q3 plan\n')

    // dir ↔ folderId mapping by id, per directory.
    expect(readFolderConfig(join(root, 'team'))?.folderId).toBe('f-team')
    expect(readFolderConfig(join(root, 'team', 'projects'))?.folderId).toBe('f-proj')
    expect(readFolderConfig(join(root, 'team', 'projects', 'q3'))?.folderId).toBe('f-q3')

    // doc ↔ file mapping with full base bookkeeping in the nested dir.
    const meta = JSON.parse(
      readFileSync(join(root, 'team', 'projects', 'q3', '.glyphdown', 'd-q3', 'meta.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(meta.file).toBe('plan.md')
    expect(meta.baseHash).toBe(sha256Hex('q3 plan\n'))

    expect(readWorkspaceConfig(root)).toMatchObject({ serverUrl: SERVER })
    expect(h.lines.join('\n')).toContain('3 folder(s), 3 doc(s)')
  })

  it('suffixes colliding sibling slugs and promotes orphaned subtrees to the root', async () => {
    const state = server({
      folders: [
        folder('f-a', 'Specs'),
        folder('f-b', 'Specs'), // sibling slug collision at the root
        folder('f-orphan', 'Granted', 'f-invisible'), // parent not accessible
      ],
    })
    state.docs.set('d-a', serverDoc('d-a', 'A', 'a\n', 'f-a'))
    state.docs.set('d-b', serverDoc('d-b', 'B', 'b\n', 'f-b'))
    state.docs.set('d-o', serverDoc('d-o', 'O', 'o\n', 'f-orphan'))

    const dir = tmp()
    const h = harness(dir, state)
    await h.run(['clone', 'work'])

    const root = join(dir, 'work')
    expect(readFolderConfig(join(root, 'specs'))?.folderId).toBe('f-a')
    expect(readFolderConfig(join(root, 'specs-2'))?.folderId).toBe('f-b')
    expect(readFolderConfig(join(root, 'granted'))?.folderId).toBe('f-orphan')
    expect(readFileSync(join(root, 'specs-2', 'b.md'), 'utf8')).toBe('b\n')
    expect(readFileSync(join(root, 'granted', 'o.md'), 'utf8')).toBe('o\n')
  })

  it('downloads folder assets into the folder dir', async () => {
    const state = server({ folders: [folder('f1', 'Specs')] })
    state.docs.set('d1', serverDoc('d1', 'Doc', '![d](diagram.png)\n', 'f1'))
    const bytes = new Uint8Array([1, 2, 3])
    state.assets.set('diagram.png', serverAsset('diagram.png', bytes))

    const dir = tmp()
    const h = harness(dir, state)
    await h.run(['clone', 'work'])
    expect(new Uint8Array(readFileSync(join(dir, 'work', 'specs', 'diagram.png')))).toEqual(bytes)
  })

  it('refuses to re-clone into an existing workspace, pointing at sync', async () => {
    const state = nestedAccount()
    const dir = tmp()
    const h = harness(dir, state)
    await h.run(['clone', 'work'])
    await expect(h.run(['clone', 'work'])).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(CliError)
      expect((error as CliError).exitCode).toBe(1)
      expect((error as CliError).message).toContain('glyphdown sync')
      return true
    })
  })
})

// ---------------------------------------------------------------------------
// Recursive mirror sync
// ---------------------------------------------------------------------------

describe('glyphdown sync (mirror workspace)', () => {
  async function cloned(state: FakeServer): Promise<{ root: string; h: ReturnType<typeof harness> }> {
    const dir = tmp()
    const h = harness(dir, state)
    await h.run(['clone', 'work'])
    h.lines.length = 0
    return { root: join(dir, 'work'), h }
  }

  it('creates server docs from new local .md files — named after the FILE, never the heading', async () => {
    const state = nestedAccount()
    const { root, h } = await cloned(state)

    writeFileSync(join(root, 'team', 'projects', 'q3', 'retro.md'), '# Q3 Retro\n\nwhat went well\n')
    writeFileSync(join(root, 'scratch-pad.md'), 'no heading here\n')

    await h.run(['sync', root, '--json'])
    const results = [...parseResults(h.lines).values()]

    const created = results.filter((r) => r.action === 'created')
    expect(created).toHaveLength(2)

    const all = [...state.docs.values()].map((d) => d.meta)
    // The H1 heading ("Q3 Retro") is content — the doc is named retro.md.
    const retro = all.find((m) => m.filename === 'retro.md')!
    expect(retro.title).toBe('retro')
    expect(retro.folderId).toBe('f-q3')
    expect(state.docs.get(retro.id)!.text).toBe('# Q3 Retro\n\nwhat went well\n')

    const scratch = all.find((m) => m.filename === 'scratch-pad.md')!
    expect(scratch.folderId).toBeNull() // root file → folderless doc
    expect(state.docs.get(scratch.id)!.text).toBe('no heading here\n')

    // Both are now tracked: meta.json next to the file, base = pushed text.
    const meta = JSON.parse(
      readFileSync(join(root, 'team', 'projects', 'q3', '.glyphdown', retro.id, 'meta.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(meta.file).toBe('retro.md')
    expect(meta.baseHash).toBe(sha256Hex('# Q3 Retro\n\nwhat went well\n'))

    // Second sync: everything is up to date — nothing re-created.
    h.lines.length = 0
    await h.run(['sync', root, '--json'])
    const second = [...parseResults(h.lines).values()]
    expect(second.every((r) => r.action === 'up-to-date')).toBe(true)
  })

  it('creates server folders (with the right parentId) from new local dirs and skips empty ones', async () => {
    const state = nestedAccount()
    const { root, h } = await cloned(state)

    mkdirSync(join(root, 'team', 'archive', 'old'), { recursive: true })
    writeFileSync(join(root, 'team', 'archive', 'old', 'notes.md'), '# Old Notes\n')
    mkdirSync(join(root, 'empty-dir'))

    await h.run(['sync', root, '--json'])
    const results = [...parseResults(h.lines).values()]

    const folderCreated = results.filter((r) => r.action === 'folder-created')
    expect(folderCreated.map((r) => r.file).sort()).toEqual(['team/archive/', 'team/archive/old/'])

    const archive = state.folders.find((f) => f.name === 'archive')!
    const old = state.folders.find((f) => f.name === 'old')!
    expect(archive.parentId).toBe('f-team')
    expect(old.parentId).toBe(archive.id)
    expect(state.folders.some((f) => f.name === 'empty-dir')).toBe(false)

    const notes = [...state.docs.values()].find((d) => d.meta.filename === 'notes.md')!
    expect(notes.meta.folderId).toBe(old.id)
    expect(readFolderConfig(join(root, 'team', 'archive'))?.folderId).toBe(archive.id)
  })

  it('materializes new server folders and their docs as nested local dirs', async () => {
    const state = nestedAccount()
    const { root, h } = await cloned(state)

    state.folders.push(folder('f-new', 'Designs', 'f-proj'))
    state.docs.set('d-new', serverDoc('d-new', 'Mockups', 'mockups\n', 'f-new'))

    await h.run(['sync', root, '--json'])
    const results = parseResults(h.lines)
    expect(results.get('f-new')?.action).toBe('folder-new')
    expect(results.get('f-new')?.file).toBe('team/projects/designs/')
    expect(results.get('d-new')?.action).toBe('new')
    expect(readFileSync(join(root, 'team', 'projects', 'designs', 'mockups.md'), 'utf8')).toBe('mockups\n')
    expect(readFolderConfig(join(root, 'team', 'projects', 'designs'))?.folderId).toBe('f-new')
  })

  it('notes server-side folder renames without moving local dirs', async () => {
    const state = nestedAccount()
    const { root, h } = await cloned(state)

    state.folders.find((f) => f.id === 'f-q3')!.name = 'Q4'

    await h.run(['sync', root, '--json'])
    const results = parseResults(h.lines)
    expect(results.get('f-q3')?.action).toBe('folder-renamed')
    // The dir stays put; only the recorded name advances.
    expect(existsSync(join(root, 'team', 'projects', 'q3'))).toBe(true)
    expect(readFolderConfig(join(root, 'team', 'projects', 'q3'))?.folderName).toBe('Q4')

    // Noted once: the next sync is silent about it.
    h.lines.length = 0
    await h.run(['sync', root, '--json'])
    expect(parseResults(h.lines).get('f-q3')).toBeUndefined()
  })

  it('re-pulls a tracked doc whose local file was deleted (no delete propagation)', async () => {
    const state = nestedAccount()
    const { root, h } = await cloned(state)

    rmSync(join(root, 'team', 'team-notes.md'))

    await h.run(['sync', root, '--json'])
    const results = parseResults(h.lines)
    expect(results.get('d-team')?.action).toBe('repulled')
    expect(readFileSync(join(root, 'team', 'team-notes.md'), 'utf8')).toBe('team notes\n')
    expect(state.docs.has('d-team')).toBe(true) // server doc untouched
  })

  it('syncs edits, creations, and discoveries across the whole tree in one pass', async () => {
    const state = nestedAccount()
    const { root, h } = await cloned(state)

    writeFileSync(join(root, 'team', 'projects', 'q3', 'plan.md'), 'q3 plan\nrevised\n') // edit deep
    writeFileSync(join(root, 'team', 'budget.md'), '# Budget\n') // new local file
    state.docs.set('d-srv', serverDoc('d-srv', 'Roadmap', 'roadmap\n', 'f-proj')) // new server doc

    await h.run(['sync', root, '--json'])
    const results = [...parseResults(h.lines).values()]

    expect(results.find((r) => r.docId === 'd-q3')?.action).toBe('pushed')
    expect(state.docs.get('d-q3')!.text).toBe('q3 plan\nrevised\n')
    expect(results.find((r) => r.docId === 'd-srv')?.action).toBe('new')
    expect(readFileSync(join(root, 'team', 'projects', 'roadmap.md'), 'utf8')).toBe('roadmap\n')
    const budget = [...state.docs.values()].find((d) => d.meta.filename === 'budget.md')!
    expect(budget.meta.folderId).toBe('f-team')
  })

  it('notes ignored non-markdown, non-image files once', async () => {
    const state = nestedAccount()
    const { root, h } = await cloned(state)
    writeFileSync(join(root, 'team', 'data.csv'), 'a,b\n')
    writeFileSync(join(root, 'script.py'), 'print(1)\n')

    await h.run(['sync', root])
    expect(h.errors.join('\n')).toContain('ignored 2 non-markdown, non-image file(s)')
  })
})

// ---------------------------------------------------------------------------
// Backward compatibility: pre-mirror workspaces keep working
// ---------------------------------------------------------------------------

describe('glyphdown sync (legacy workspaces)', () => {
  it('detects an old folder workspace and gains creation + subtree recursion', async () => {
    const state = server({ folders: [folder('f1', 'Specs')] })
    state.docs.set('d1', serverDoc('d1', 'Doc', 'text\n', 'f1'))

    const dir = tmp()
    const h = harness(dir, state)
    await h.run(['pull', '--folder', 'f1']) // the OLD layout: dir + .glyphdown/folder.json
    const target = join(dir, 'specs')
    expect(readWorkspaceConfig(target)).toBeNull() // no migration artifact

    // New local file lands in the linked folder; new server subfolder
    // materializes as a nested dir.
    writeFileSync(join(target, 'extra.md'), '# Extra\n')
    state.folders.push(folder('f-sub', 'Sub', 'f1'))
    state.docs.set('d-sub', serverDoc('d-sub', 'Nested', 'nested\n', 'f-sub'))

    h.lines.length = 0
    await h.run(['sync', target, '--json'])
    const results = [...parseResults(h.lines).values()]

    const extra = [...state.docs.values()].find((d) => d.meta.filename === 'extra.md')!
    expect(extra.meta.folderId).toBe('f1')
    expect(results.find((r) => r.docId === extra.meta.id)?.action).toBe('created')
    expect(results.find((r) => r.docId === 'f-sub')?.action).toBe('folder-new')
    expect(readFileSync(join(target, 'sub', 'nested.md'), 'utf8')).toBe('nested\n')
  })

  it('keeps plain doc dirs (no folder.json) on the single-dir path — no creation', async () => {
    const state = server()
    state.docs.set('d1', serverDoc('d1', 'Doc', 'text\n'))

    const dir = tmp()
    track(dir, 'doc.md', 'd1', 'text\n')
    writeFileSync(join(dir, 'stray.md'), 'never pushed\n')

    const h = harness(dir, state)
    await h.run(['sync', '--json'])
    const results = parseResults(h.lines)
    expect(results.size).toBe(1)
    expect(results.get('d1')?.action).toBe('up-to-date')
    // The stray file was not turned into a server doc.
    expect([...state.docs.values()].some((d) => d.meta.title.includes('stray'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// filenameForLocalFile — the FILE NAME is the doc name (H1 is just content)
// ---------------------------------------------------------------------------

describe('filenameForLocalFile', () => {
  it('keeps an already-clean slug name verbatim', () => {
    expect(filenameForLocalFile('meeting-notes.md')).toBe('meeting-notes.md')
  })
  it('slugifies a messy local name', () => {
    expect(filenameForLocalFile('My Notes.md')).toBe('my-notes.md')
    expect(filenameForLocalFile('Q3 — Plan!.md')).toBe('q3-plan.md')
  })
  it('falls back to untitled when nothing usable remains', () => {
    expect(filenameForLocalFile('---.md')).toBe('untitled.md')
  })
})
