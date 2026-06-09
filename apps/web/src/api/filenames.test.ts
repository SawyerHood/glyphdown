import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { DOC_FILENAME_RE, docFilenameStem, normalizeDocFilename, slugifyDocStem } from '@glyphdown/protocol'
import { availableFilename, filenameForCreate, filenameFromPatch } from './filenames.ts'

// ---------------------------------------------------------------------------
// Protocol slug helpers (the canonical rule shared by server, web, and CLI)
// ---------------------------------------------------------------------------

describe('slugifyDocStem', () => {
  it('lowercases and collapses non-alphanumeric runs to single dashes', () => {
    expect(slugifyDocStem('The Garden')).toBe('the-garden')
    expect(slugifyDocStem('  Q3 — Plan! (v2) ')).toBe('q3-plan-v2')
    expect(slugifyDocStem('already-clean')).toBe('already-clean')
    expect(slugifyDocStem('Crème Brûlée')).toBe('cr-me-br-l-e')
  })

  it('falls back to untitled when nothing usable remains', () => {
    expect(slugifyDocStem('')).toBe('untitled')
    expect(slugifyDocStem('???')).toBe('untitled')
    expect(slugifyDocStem('---')).toBe('untitled')
  })
})

describe('normalizeDocFilename / docFilenameStem', () => {
  it('round-trips: stem + .md', () => {
    expect(normalizeDocFilename('My Notes')).toBe('my-notes.md')
    expect(normalizeDocFilename('My Notes.md')).toBe('my-notes.md')
    expect(normalizeDocFilename('My Notes.MD')).toBe('my-notes.md')
    expect(docFilenameStem('my-notes.md')).toBe('my-notes')
  })

  it('every normalized output is a valid stored filename', () => {
    for (const raw of ['The Garden', 'foo.md', '  ', '-x-', 'A B C.md']) {
      expect(DOC_FILENAME_RE.test(normalizeDocFilename(raw))).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

describe('filenameForCreate (POST /api/docs — lenient)', () => {
  it('filename wins over title and is normalized', () => {
    expect(filenameForCreate({ filename: 'the-garden.md', title: 'Whatever' })).toBe('the-garden.md')
    expect(filenameForCreate({ filename: 'My Notes' })).toBe('my-notes.md')
  })

  it('a bare title is slugified into a filename', () => {
    expect(filenameForCreate({ title: 'The Garden' })).toBe('the-garden.md')
  })

  it('defaults to untitled.md', () => {
    expect(filenameForCreate(null)).toBe('untitled.md')
    expect(filenameForCreate({})).toBe('untitled.md')
    expect(filenameForCreate({ title: '   ' })).toBe('untitled.md')
  })
})

describe('filenameFromPatch (PATCH rename — strict filename, lenient legacy title)', () => {
  it('accepts a valid slug with or without .md', () => {
    expect(filenameFromPatch({ filename: 'the-garden.md' })).toBe('the-garden.md')
    expect(filenameFromPatch({ filename: 'the-garden' })).toBe('the-garden.md')
    expect(filenameFromPatch({ filename: 'a-2' })).toBe('a-2.md')
  })

  it('rejects non-slug filenames (the UI live-slugs; the CLI pre-slugs)', () => {
    expect(filenameFromPatch({ filename: 'My Doc.md' })).toBe('invalid')
    expect(filenameFromPatch({ filename: 'UPPER.md' })).toBe('invalid')
    expect(filenameFromPatch({ filename: 'a--b.md' })).toBe('invalid')
    expect(filenameFromPatch({ filename: '-x.md' })).toBe('invalid')
    expect(filenameFromPatch({ filename: 'x-.md' })).toBe('invalid')
    expect(filenameFromPatch({ filename: '' })).toBe('invalid')
    expect(filenameFromPatch({ filename: 7 })).toBe('invalid')
  })

  it('slugifies legacy { title } payloads', () => {
    expect(filenameFromPatch({ title: 'The Garden' })).toBe('the-garden.md')
    expect(filenameFromPatch({ title: '  ' })).toBe('invalid')
  })

  it('returns null when no rename was requested', () => {
    expect(filenameFromPatch({})).toBeNull()
    expect(filenameFromPatch({ folderId: 'f1' } as Record<string, unknown>)).toBeNull()
  })
})

describe('availableFilename', () => {
  it('returns the base when free, else the first -N suffix', () => {
    expect(availableFilename('a.md', new Set())).toBe('a.md')
    expect(availableFilename('a.md', new Set(['a.md']))).toBe('a-2.md')
    expect(availableFilename('a.md', new Set(['a.md', 'a-2.md', 'a-3.md']))).toBe('a-4.md')
  })
})

// ---------------------------------------------------------------------------
// Migration 0004 backfill — the EXACT SQL shipped to D1, run against sqlite.
// Verifies: slugify parity with slugifyDocStem, deterministic scope dedupe
// (ORDER BY created_at, id), root-vs-folder scoping, soft-deleted docs
// releasing names, and the partial unique indexes holding afterwards.
// ---------------------------------------------------------------------------

const MIGRATION = readFileSync(
  join(__dirname, '..', '..', 'drizzle', '0004_windy_the_executioner.sql'),
  'utf8',
)

function migratedDb(rows: Array<{ id: string; title: string; folderId?: string | null; owner?: string; createdAt?: number; deletedAt?: number | null }>) {
  const db = new Database(':memory:')
  // The pre-0004 docs shape (FKs omitted — irrelevant to the backfill).
  db.exec(`CREATE TABLE docs (id TEXT PRIMARY KEY, title TEXT NOT NULL, folder_id TEXT,
    owner_user_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER);`)
  const insert = db.prepare('INSERT INTO docs VALUES (?, ?, ?, ?, ?, ?, ?)')
  for (const r of rows) {
    insert.run(r.id, r.title, r.folderId ?? null, r.owner ?? 'u1', r.createdAt ?? 1, r.createdAt ?? 1, r.deletedAt ?? null)
  }
  db.exec(MIGRATION.replaceAll('--> statement-breakpoint', ''))
  return db
}

function filenamesOf(db: InstanceType<typeof Database>): Map<string, string> {
  const rows = db.prepare('SELECT id, filename FROM docs').all() as Array<{ id: string; filename: string }>
  return new Map(rows.map((r) => [r.id, r.filename]))
}

describe('migration 0004 backfill', () => {
  it('slugifies titles exactly like slugifyDocStem', () => {
    const titles = ['The Garden', '  Q3 — Plan! (v2) ', 'already-clean', 'Crème Brûlée', '???', 'UPPER case']
    const db = migratedDb(titles.map((title, i) => ({ id: `d${i}`, title, owner: `u${i}` })))
    const names = filenamesOf(db)
    titles.forEach((title, i) => {
      expect(names.get(`d${i}`)).toBe(`${slugifyDocStem(title)}.md`)
    })
  })

  it('dedupes scope collisions deterministically by created_at (oldest keeps the base name)', () => {
    const db = migratedDb([
      { id: 'newer', title: 'Foo', createdAt: 5 },
      { id: 'oldest', title: 'foo!', createdAt: 1 },
      { id: 'middle', title: 'FOO', createdAt: 3 },
    ])
    const names = filenamesOf(db)
    expect(names.get('oldest')).toBe('foo.md')
    expect(names.get('middle')).toBe('foo-2.md')
    expect(names.get('newer')).toBe('foo-3.md')
  })

  it('a suffixed name colliding with a pre-existing base name resolves (Foo, Foo, Foo 2)', () => {
    const db = migratedDb([
      { id: 'a', title: 'Foo', createdAt: 1 },
      { id: 'b', title: 'Foo', createdAt: 2 },
      { id: 'c', title: 'Foo 2', createdAt: 3 },
    ])
    const names = [...filenamesOf(db).values()].sort()
    // All distinct, all valid — exact suffixes are pass-order details.
    expect(new Set(names).size).toBe(3)
    for (const name of names) expect(DOC_FILENAME_RE.test(name)).toBe(true)
    expect(filenamesOf(db).get('a')).toBe('foo.md') // oldest keeps the base
  })

  it('scopes by folder and by owner root — same name can coexist across scopes', () => {
    const db = migratedDb([
      { id: 'root-u1', title: 'Notes', owner: 'u1' },
      { id: 'root-u2', title: 'Notes', owner: 'u2' },
      { id: 'in-f1', title: 'Notes', owner: 'u1', folderId: 'f1' },
      { id: 'in-f2', title: 'Notes', owner: 'u1', folderId: 'f2' },
    ])
    const names = filenamesOf(db)
    expect(names.get('root-u1')).toBe('notes.md')
    expect(names.get('root-u2')).toBe('notes.md')
    expect(names.get('in-f1')).toBe('notes.md')
    expect(names.get('in-f2')).toBe('notes.md')
  })

  it('soft-deleted docs get a filename but release the name to live docs', () => {
    const db = migratedDb([
      { id: 'trashed', title: 'Plan', createdAt: 1, deletedAt: 99 },
      { id: 'live', title: 'Plan', createdAt: 2 },
    ])
    const names = filenamesOf(db)
    expect(names.get('live')).toBe('plan.md') // no -2: the trashed doc does not count
    expect(names.get('trashed')).toBe('plan.md')
  })

  it('leaves the partial unique indexes enforcing live-scope uniqueness', () => {
    const db = migratedDb([{ id: 'a', title: 'One' }, { id: 'b', title: 'Two' }])
    expect(() =>
      db.prepare('UPDATE docs SET filename = ? WHERE id = ?').run('one.md', 'b'),
    ).toThrow(/UNIQUE/)
    // …but a soft-deleted doc may share the name.
    db.prepare('UPDATE docs SET deleted_at = 1 WHERE id = ?').run('a')
    expect(() => db.prepare('UPDATE docs SET filename = ? WHERE id = ?').run('one.md', 'b')).not.toThrow()
  })
})
