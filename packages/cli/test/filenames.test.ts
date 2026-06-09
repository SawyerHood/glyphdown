import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SyncDocResult } from '../src/index.ts'
import { CliError, fileForDoc, listMetas, warnLikelyLocalRename } from '../src/index.ts'
import { SERVER, type FakeServer, folder, harness, server, serverDoc, track } from './fake-server.ts'

/**
 * The filename-canonical model end to end: docs ARE files — the server
 * `filename` is the local file name, sync converges drifted names, creation
 * is named after the file (slugified), `glyphdown mv` is the rename path,
 * and clone(sync(x)) == x for names.
 */

const dirs: string[] = []
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ink-filenames-test-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function parseResults(lines: string[]): SyncDocResult[] {
  return JSON.parse(lines.join('\n')) as SyncDocResult[]
}

/** Every non-dot file path in a tree, relative, sorted. */
function fileTree(dir: string, rel = ''): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue
    const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
    if (entry.isDirectory()) out.push(...fileTree(join(dir, entry.name), childRel))
    else out.push(childRel)
  }
  return out
}

// ---------------------------------------------------------------------------
// fileForDoc — server filename verbatim, local-collision suffixes only
// ---------------------------------------------------------------------------

describe('fileForDoc', () => {
  it('uses the canonical filename verbatim', () => {
    expect(fileForDoc({ filename: 'the-garden.md', title: 'anything' }, new Set())).toBe('the-garden.md')
  })

  it('suffixes only when a different local file claims the stem', () => {
    const used = new Set(['the-garden'])
    expect(fileForDoc({ filename: 'the-garden.md', title: 't' }, used)).toBe('the-garden-2.md')
  })

  it('falls back to the slugified title for pre-filename servers', () => {
    expect(fileForDoc({ filename: '', title: 'The Garden' }, new Set())).toBe('the-garden.md')
  })
})

// ---------------------------------------------------------------------------
// sync creation sends the FILE NAME (slugified) — and converges on the
// server's canonical answer
// ---------------------------------------------------------------------------

describe('sync: create sends filename', () => {
  it('a messy local name is slugified, reported, and the local file renamed to match', async () => {
    const state = server({ folders: [folder('f1', 'Specs')] })
    state.docs.set('d1', serverDoc('d1', 'Existing', 'x\n', 'f1'))

    const dir = tmp()
    const h = harness(dir, state)
    await h.run(['pull', '--folder', 'f1'])
    const target = join(dir, 'specs')
    writeFileSync(join(target, 'My Notes.md'), '# Heading Is Content\n')

    h.lines.length = 0
    await h.run(['sync', target, '--json'])
    const results = parseResults(h.lines)

    const created = results.find((r) => r.action === 'created')!
    expect(created.file).toBe('my-notes.md')
    // The server doc is named after the FILE — never the heading.
    const doc = [...state.docs.values()].find((d) => d.meta.id === created.docId)!
    expect(doc.meta.filename).toBe('my-notes.md')
    expect(doc.meta.title).toBe('my-notes')
    // Local side converged: the messy name is gone, the slug file exists.
    expect(existsSync(join(target, 'My Notes.md'))).toBe(false)
    expect(readFileSync(join(target, 'my-notes.md'), 'utf8')).toBe('# Heading Is Content\n')
    expect(h.errors.join('\n')).toContain('My Notes.md → my-notes.md')
    // The manifest tracks the canonical name.
    expect(listMetas(target).some((m) => m.file === 'my-notes.md')).toBe(true)
  })

  it('a server-side name collision suffixes the doc AND renames the local file to the suffix', async () => {
    const state = server({ folders: [folder('f1', 'Specs')] })
    state.docs.set('d1', serverDoc('d1', 'plan', 'server plan\n', 'f1'))

    const dir = tmp()
    const h = harness(dir, state)
    await h.run(['pull', '--folder', 'f1'])
    const target = join(dir, 'specs')

    // Manufacture the collision: a second doc named plan.md appears on the
    // server while an untracked local plan-2.md… simpler: untracked local
    // file whose slug collides with the existing tracked plan.md cannot
    // exist (same name = same file), so collide via a second folder doc
    // created concurrently — the fake suffixes POSTs within the scope.
    state.docs.set('d2', serverDoc('d2', 'notes', 'n\n', 'f1'))
    writeFileSync(join(target, 'Notes!.md'), 'local notes\n') // slug 'notes.md' — taken by d2

    h.lines.length = 0
    await h.run(['sync', target, '--json'])
    const results = parseResults(h.lines)
    const created = results.find((r) => r.action === 'created')!
    expect(created.file).toBe('notes-2.md')
    const doc = [...state.docs.values()].find((d) => d.meta.id === created.docId)!
    expect(doc.meta.filename).toBe('notes-2.md')
    expect(existsSync(join(target, 'notes-2.md'))).toBe(true)
    expect(existsSync(join(target, 'Notes!.md'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// One-time local convergence: server filename wins
// ---------------------------------------------------------------------------

describe('sync: filename convergence', () => {
  it('renames the local file to the canonical server name and updates the manifest', async () => {
    const state = server({ folders: [folder('f1', 'Specs')] })
    state.docs.set('d1', serverDoc('d1', 'new-name', 'text\n', 'f1'))

    const dir = tmp()
    // A pre-rename workspace: tracked under the OLD name.
    mkdirSync(join(dir, 'specs'), { recursive: true })
    const target = join(dir, 'specs')
    track(target, 'old-name.md', 'd1', 'text\n')
    writeFileSync(join(target, '.glyphdown', 'folder.json'), JSON.stringify({ folderId: 'f1', folderName: 'Specs', serverUrl: SERVER }))

    const h = harness(dir, state)
    await h.run(['sync', target, '--json'])
    const results = parseResults(h.lines)

    expect(existsSync(join(target, 'old-name.md'))).toBe(false)
    expect(readFileSync(join(target, 'new-name.md'), 'utf8')).toBe('text\n')
    expect(listMetas(target)[0]!.file).toBe('new-name.md')
    const result = results.find((r) => r.docId === 'd1')!
    expect(result.file).toBe('new-name.md')
    expect(result.message).toContain('renamed locally: old-name.md → new-name.md')
  })

  it('does not clobber an existing local file with the canonical name — warns instead', async () => {
    const state = server()
    state.docs.set('d1', serverDoc('d1', 'new-name', 'text\n'))

    // Plain doc dir (no folder.json): the squatter file is never created as
    // a doc here, so the only question is whether convergence overwrites it.
    const dir = tmp()
    track(dir, 'old-name.md', 'd1', 'text\n')
    writeFileSync(join(dir, 'new-name.md'), 'unrelated local file\n')

    const h = harness(dir, state)
    await h.run(['sync', '--json'])
    expect(readFileSync(join(dir, 'old-name.md'), 'utf8')).toBe('text\n')
    expect(readFileSync(join(dir, 'new-name.md'), 'utf8')).toBe('unrelated local file\n')
    expect(listMetas(dir)[0]!.file).toBe('old-name.md')
    expect(h.errors.join('\n')).toContain('a local file with that name already exists')
  })
})

// ---------------------------------------------------------------------------
// clone(sync(x)) == x — names are identical on a second machine
// ---------------------------------------------------------------------------

describe('clone symmetry', () => {
  it('a fresh clone reproduces exactly the file names the first workspace has', async () => {
    const state = server({ folders: [folder('f-team', 'Team'), folder('f-proj', 'Projects', 'f-team')] })
    state.docs.set('d-root', serverDoc('d-root', 'readme', '# Readme\n', null))
    state.docs.set('d-team', serverDoc('d-team', 'team-notes', 'notes\n', 'f-team'))

    // Machine one: clone, add files (messy names included), sync them up.
    const dirA = tmp()
    const hA = harness(dirA, state)
    await hA.run(['clone', 'work'])
    const rootA = join(dirA, 'work')
    writeFileSync(join(rootA, 'team', 'projects', 'Roadmap 2026.md'), '# Roadmap\n')
    writeFileSync(join(rootA, 'scratch.md'), 'scratch\n')
    await hA.run(['sync', rootA])

    // Machine two: a fresh clone of the same account.
    const dirB = tmp()
    const hB = harness(dirB, state)
    await hB.run(['clone', 'mirror'])
    const rootB = join(dirB, 'mirror')

    expect(fileTree(rootB)).toEqual(fileTree(rootA))
    // And the messy name is the same SLUG on both machines.
    expect(existsSync(join(rootA, 'team', 'projects', 'roadmap-2026.md'))).toBe(true)
    expect(existsSync(join(rootB, 'team', 'projects', 'roadmap-2026.md'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// glyphdown mv
// ---------------------------------------------------------------------------

describe('glyphdown mv', () => {
  function pulledWorkspace(state: FakeServer): { dir: string; h: ReturnType<typeof harness> } {
    const dir = tmp()
    track(dir, 'draft.md', 'd1', 'text\n')
    return { dir, h: harness(dir, state) }
  }

  it('renames the local file AND the server filename, updating the manifest', async () => {
    const state = server()
    state.docs.set('d1', serverDoc('d1', 'draft', 'text\n'))
    const { dir, h } = pulledWorkspace(state)

    await h.run(['mv', 'draft.md', 'final-plan'])

    expect(state.docs.get('d1')!.meta.filename).toBe('final-plan.md')
    expect(existsSync(join(dir, 'draft.md'))).toBe(false)
    expect(readFileSync(join(dir, 'final-plan.md'), 'utf8')).toBe('text\n')
    expect(listMetas(dir)[0]!.file).toBe('final-plan.md')
    expect(h.lines.join('\n')).toContain('renamed draft.md → final-plan.md')
  })

  it('slugifies the new name and says so', async () => {
    const state = server()
    state.docs.set('d1', serverDoc('d1', 'draft', 'text\n'))
    const { dir, h } = pulledWorkspace(state)

    await h.run(['mv', 'draft.md', 'Final Plan.md'])
    expect(state.docs.get('d1')!.meta.filename).toBe('final-plan.md')
    expect(existsSync(join(dir, 'final-plan.md'))).toBe(true)
    expect(h.errors.join('\n')).toContain('Final Plan.md → final-plan.md')
  })

  it('aborts cleanly on a server 409 filename-taken — nothing moves locally', async () => {
    const state = server()
    state.docs.set('d1', serverDoc('d1', 'draft', 'text\n'))
    state.docs.set('d2', serverDoc('d2', 'final-plan', 'other\n'))
    const { dir, h } = pulledWorkspace(state)

    await expect(h.run(['mv', 'draft.md', 'final-plan'])).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(CliError)
      expect((error as CliError).message).toContain('filename taken')
      return true
    })
    expect(state.docs.get('d1')!.meta.filename).toBe('draft.md')
    expect(existsSync(join(dir, 'draft.md'))).toBe(true)
    expect(existsSync(join(dir, 'final-plan.md'))).toBe(false)
    expect(listMetas(dir)[0]!.file).toBe('draft.md')
  })

  it('refuses when the target file already exists locally', async () => {
    const state = server()
    state.docs.set('d1', serverDoc('d1', 'draft', 'text\n'))
    const { dir, h } = pulledWorkspace(state)
    writeFileSync(join(dir, 'final-plan.md'), 'squatter\n')

    await expect(h.run(['mv', 'draft.md', 'final-plan'])).rejects.toSatisfy((error: unknown) => {
      expect((error as CliError).message).toContain('already exists here')
      return true
    })
    expect(state.docs.get('d1')!.meta.filename).toBe('draft.md') // server untouched
  })
})

// ---------------------------------------------------------------------------
// Local-rename detection warning (rename is out of scope v1 — warn loudly)
// ---------------------------------------------------------------------------

describe('warnLikelyLocalRename', () => {
  it('warns when a re-pull and a create land in the same directory', () => {
    const lines: string[] = []
    warnLikelyLocalRename(
      [
        { docId: 'a', file: 'team/old.md', action: 'repulled' },
        { docId: 'b', file: 'team/new.md', action: 'created' },
      ],
      (l) => lines.push(l),
    )
    expect(lines.join('\n')).toContain('glyphdown mv')
    expect(lines.join('\n')).toContain('DUPLICATE')
  })

  it('stays silent for unrelated directories or actions', () => {
    const lines: string[] = []
    warnLikelyLocalRename(
      [
        { docId: 'a', file: 'team/old.md', action: 'repulled' },
        { docId: 'b', file: 'other/new.md', action: 'created' },
        { docId: 'c', file: 'team/x.md', action: 'pushed' },
      ],
      (l) => lines.push(l),
    )
    expect(lines).toEqual([])
  })

  it('fires end-to-end when a tracked file is renamed by hand', async () => {
    const state = server({ folders: [folder('f1', 'Specs')] })
    state.docs.set('d1', serverDoc('d1', 'plan', 'text\n', 'f1'))

    const dir = tmp()
    const h = harness(dir, state)
    await h.run(['pull', '--folder', 'f1'])
    const target = join(dir, 'specs')

    // The unsupported path: rename by hand instead of `glyphdown mv`.
    rmSync(join(target, 'plan.md'))
    writeFileSync(join(target, 'renamed-plan.md'), 'text\n')

    h.lines.length = 0
    await h.run(['sync', target, '--json'])
    const results = parseResults(h.lines)
    expect(results.find((r) => r.docId === 'd1')?.action).toBe('repulled')
    expect(results.some((r) => r.action === 'created')).toBe(true)
    expect(h.errors.join('\n')).toContain('glyphdown mv')
  })
})
