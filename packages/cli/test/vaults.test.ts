import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { VaultMeta } from '@glyphdown/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import type { SyncDocResult } from '../src/index.ts'
import { CliError, createApi, readFolderConfig, readWorkspaceConfig, resolveVault, sha256Hex } from '../src/index.ts'
import { SERVER, type FakeServer, fetchFor, folder, harness, server, serverDoc } from './fake-server.ts'

const dirs: string[] = []
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ink-vaults-test-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * A post-migration account: two vaults (no root docs — every doc lives in
 * some vault's subtree), with a nested folder inside Home.
 */
function vaultedAccount(): FakeServer {
  const state = server({
    folders: [
      folder('v-home', 'Home'),
      folder('v-research', 'Research'),
      folder('f-notes', 'Notes', 'v-home'),
    ],
  })
  state.docs.set('d-plan', serverDoc('d-plan', 'Plan', '# Plan\n', 'v-home'))
  state.docs.set('d-note', serverDoc('d-note', 'Daily', 'daily note\n', 'f-notes'))
  state.docs.set('d-paper', serverDoc('d-paper', 'Paper', '# Paper\n', 'v-research'))
  return state
}

function apiFor(state: FakeServer) {
  return createApi({ serverUrl: SERVER, apiKey: 'gd_sk_test', fetchImpl: fetchFor(state) })
}

// ---------------------------------------------------------------------------
// glyphdown vaults
// ---------------------------------------------------------------------------

describe('glyphdown vaults', () => {
  it('lists vaults as id / role / name lines', async () => {
    const state = vaultedAccount()
    const h = harness(tmp(), state)
    await h.run(['vaults'])
    expect(h.lines).toHaveLength(2)
    expect(h.lines[0]).toContain('v-home')
    expect(h.lines[0]).toContain('owner')
    expect(h.lines[0]).toContain('Home')
    expect(h.lines[1]).toContain('Research')
    // Plain folders are NOT vaults.
    expect(h.lines.join('\n')).not.toContain('f-notes')
  })

  it('emits VaultMeta JSON with --json', async () => {
    const state = vaultedAccount()
    const h = harness(tmp(), state)
    await h.run(['vaults', '--json'])
    const vaults = JSON.parse(h.lines.join('\n')) as VaultMeta[]
    expect(vaults.map((v) => v.id)).toEqual(['v-home', 'v-research'])
    expect(vaults[0]).toEqual({ id: 'v-home', name: 'Home', ownerUserId: 'u1', role: 'owner', createdAt: 1 })
  })

  it('prints "no vaults" when there are none', async () => {
    const h = harness(tmp(), server())
    await h.run(['vaults'])
    expect(h.lines).toEqual(['no vaults'])
  })
})

// ---------------------------------------------------------------------------
// resolveVault — name/id resolution via /api/vaults
// ---------------------------------------------------------------------------

describe('resolveVault', () => {
  it('resolves by id, exact name, and case-insensitive name', async () => {
    const api = apiFor(vaultedAccount())
    expect((await resolveVault(api, 'v-research')).name).toBe('Research')
    expect((await resolveVault(api, 'Research')).id).toBe('v-research')
    expect((await resolveVault(api, 'rEsEaRcH')).id).toBe('v-research')
  })

  it('never resolves a plain folder name (vault refs go through /api/vaults)', async () => {
    const api = apiFor(vaultedAccount())
    await expect(resolveVault(api, 'Notes')).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(CliError)
      expect((error as CliError).message).toContain('no vault matches "Notes"')
      expect((error as CliError).message).toContain('v-home') // lists accessible vaults
      return true
    })
  })

  it('errors listing candidates when owned + shared vaults share a name', async () => {
    // Names are unique per OWNER — a vault shared by someone else can still
    // collide with an owned one.
    const state = vaultedAccount()
    state.folders.push({
      id: 'v-theirs',
      name: 'research',
      kind: 'vault',
      parentId: null,
      ownerUserId: 'u2',
      role: 'editor',
      createdAt: 9,
    })
    await expect(resolveVault(apiFor(state), 'research')).rejects.toSatisfy((error: unknown) => {
      expect((error as CliError).exitCode).toBe(1)
      expect((error as CliError).message).toContain('ambiguous')
      expect((error as CliError).message).toContain('v-research')
      expect((error as CliError).message).toContain('v-theirs')
      return true
    })
  })

  it('explains when the caller has no vaults at all', async () => {
    await expect(resolveVault(apiFor(server()), 'Home')).rejects.toSatisfy((error: unknown) => {
      expect((error as CliError).message).toContain('no accessible vaults')
      return true
    })
  })
})

// ---------------------------------------------------------------------------
// glyphdown new --vault
// ---------------------------------------------------------------------------

describe('glyphdown new --vault', () => {
  it("creates the doc at the vault's top level, resolving the name case-insensitively", async () => {
    const state = vaultedAccount()
    const h = harness(tmp(), state)
    await h.run(['new', 'Findings', '--vault', 'research', '--json'])
    const meta = JSON.parse(h.lines.join('\n')) as { id: string; folderId: string | null }
    expect(state.docs.get(meta.id)?.meta.folderId).toBe('v-research')
  })

  it('rejects --folder combined with --vault', async () => {
    const h = harness(tmp(), vaultedAccount())
    await expect(h.run(['new', 'X', '--vault', 'Home', '--folder', 'f-notes'])).rejects.toSatisfy(
      (error: unknown) => {
        expect((error as CliError).exitCode).toBe(1)
        expect((error as CliError).message).toContain('either --folder or --vault')
        return true
      },
    )
  })

  it('with neither flag sends no folderId — the server lands it in the default vault', async () => {
    const state = vaultedAccount()
    const h = harness(tmp(), state)
    await h.run(['new', 'Loose', '--json'])
    const meta = JSON.parse(h.lines.join('\n')) as { id: string }
    // The fake (like a pre-vault server) records null; the REAL server
    // resolves no-folderId to the caller's default vault (phase 1).
    expect(state.docs.get(meta.id)?.meta.folderId).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// glyphdown clone --vault
// ---------------------------------------------------------------------------

describe('glyphdown clone --vault', () => {
  it('mirrors only the vault subtree, rooted by folder.json (not workspace.json)', async () => {
    const state = vaultedAccount()
    const dir = tmp()
    const h = harness(dir, state)
    await h.run(['clone', '--vault', 'home', 'work'])

    const root = join(dir, 'work')
    // The root is linked to the VAULT's folder id — pull --folder's layout.
    expect(readFolderConfig(root)).toEqual({ folderId: 'v-home', folderName: 'Home', serverUrl: SERVER })
    expect(readWorkspaceConfig(root)).toBeNull()

    // Vault-level doc in the root, subfolder materialized with its doc.
    expect(readFileSync(join(root, 'plan.md'), 'utf8')).toBe('# Plan\n')
    expect(readFolderConfig(join(root, 'notes'))?.folderId).toBe('f-notes')
    expect(readFileSync(join(root, 'notes', 'daily.md'), 'utf8')).toBe('daily note\n')

    // The other vault is NOT cloned.
    expect(existsSync(join(root, 'research'))).toBe(false)
    expect(existsSync(join(root, 'paper.md'))).toBe(false)

    // Full base bookkeeping for the root doc.
    const meta = JSON.parse(readFileSync(join(root, '.glyphdown', 'd-plan', 'meta.json'), 'utf8')) as Record<string, unknown>
    expect(meta.baseHash).toBe(sha256Hex('# Plan\n'))
    expect(h.lines.join('\n')).toContain('cloned vault Home: 1 folder(s), 2 doc(s)')
  })

  it('defaults the target dir to the slugified vault name', async () => {
    const state = vaultedAccount()
    const dir = tmp()
    const h = harness(dir, state)
    await h.run(['clone', '--vault', 'Research'])
    expect(readFolderConfig(join(dir, 'research'))?.folderId).toBe('v-research')
    expect(readFileSync(join(dir, 'research', 'paper.md'), 'utf8')).toBe('# Paper\n')
  })

  it('sync in a vault clone stays confined to the subtree', async () => {
    const state = vaultedAccount()
    const dir = tmp()
    const h = harness(dir, state)
    await h.run(['clone', '--vault', 'Home', 'work'])
    const root = join(dir, 'work')
    h.lines.length = 0

    // Server gains a doc in BOTH vaults plus a folder in the other vault.
    state.docs.set('d-todo', serverDoc('d-todo', 'Todo', 'todo\n', 'v-home'))
    state.docs.set('d-cite', serverDoc('d-cite', 'Cites', 'cites\n', 'v-research'))
    state.folders.push(folder('f-data', 'Data', 'v-research'))
    // And a local edit + a new local file inside the vault workspace.
    writeFileSync(join(root, 'plan.md'), '# Plan\n\nupdated\n')
    writeFileSync(join(root, 'scratch.md'), 'scratch\n')

    await h.run(['sync', 'work', '--json'])
    const results = JSON.parse(h.lines.join('\n')) as SyncDocResult[]
    const byId = new Map(results.map((r) => [r.docId, r]))

    expect(byId.get('d-todo')?.action).toBe('new') // in-vault server doc materializes
    expect(byId.get('d-plan')?.action).toBe('pushed')
    expect(byId.has('d-cite')).toBe(false) // other vault: ignored
    expect(byId.has('f-data')).toBe(false)
    expect(existsSync(join(root, 'cites.md'))).toBe(false)
    expect(existsSync(join(root, 'data'))).toBe(false)

    // The new local file became a doc INSIDE the vault.
    const created = results.find((r) => r.action === 'created')
    expect(created).toBeDefined()
    expect(state.docs.get(created!.docId)?.meta.folderId).toBe('v-home')
  })

  it('errors on an unknown vault ref before touching the filesystem', async () => {
    const dir = tmp()
    const h = harness(dir, vaultedAccount())
    await expect(h.run(['clone', '--vault', 'nope', 'work'])).rejects.toSatisfy((error: unknown) => {
      expect((error as CliError).exitCode).toBe(1)
      expect((error as CliError).message).toContain('no vault matches "nope"')
      return true
    })
    expect(existsSync(join(dir, 'work'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Full clone of a post-migration account
// ---------------------------------------------------------------------------

describe('glyphdown clone (account with vaults)', () => {
  it('renders vaults as top-level directories and sync round-trips', async () => {
    const state = vaultedAccount()
    const dir = tmp()
    const h = harness(dir, state)
    await h.run(['clone', 'work'])

    const root = join(dir, 'work')
    expect(readWorkspaceConfig(root)).toMatchObject({ serverUrl: SERVER })
    // Vaults are just root folders to the mirror: top-level dirs, mapped by id.
    expect(readFolderConfig(join(root, 'home'))?.folderId).toBe('v-home')
    expect(readFolderConfig(join(root, 'research'))?.folderId).toBe('v-research')
    expect(readFileSync(join(root, 'home', 'plan.md'), 'utf8')).toBe('# Plan\n')
    expect(readFileSync(join(root, 'home', 'notes', 'daily.md'), 'utf8')).toBe('daily note\n')
    expect(readFileSync(join(root, 'research', 'paper.md'), 'utf8')).toBe('# Paper\n')
    expect(h.lines.join('\n')).toContain('3 folder(s), 3 doc(s)')

    // Round trip: a local edit in one vault and a new server doc in the other
    // converge in a single sync.
    h.lines.length = 0
    writeFileSync(join(root, 'research', 'paper.md'), '# Paper\n\nrevised\n')
    state.docs.set('d-new', serverDoc('d-new', 'Inbox', 'inbox\n', 'v-home'))
    await h.run(['sync', 'work', '--json'])
    const byId = new Map((JSON.parse(h.lines.join('\n')) as SyncDocResult[]).map((r) => [r.docId, r]))
    expect(byId.get('d-paper')?.action).toBe('pushed')
    expect(state.docs.get('d-paper')?.text).toBe('# Paper\n\nrevised\n')
    expect(byId.get('d-new')).toMatchObject({ action: 'new', file: 'home/inbox.md' })
    expect(readFileSync(join(root, 'home', 'inbox.md'), 'utf8')).toBe('inbox\n')
  })
})

// ---------------------------------------------------------------------------
// pull --folder accepts vault refs (a vault IS a folder)
// ---------------------------------------------------------------------------

describe('glyphdown pull --folder with a vault ref', () => {
  it('accepts a vault name case-insensitively and pulls its top-level docs', async () => {
    const state = vaultedAccount()
    const dir = tmp()
    const h = harness(dir, state)
    await h.run(['pull', '--folder', 'rESEARCH'])

    const target = join(dir, 'research')
    expect(readFolderConfig(target)).toEqual({ folderId: 'v-research', folderName: 'Research', serverUrl: SERVER })
    expect(readFileSync(join(target, 'paper.md'), 'utf8')).toBe('# Paper\n')
  })

  it('still prefers an exact plain-folder name match over the vault fallback', async () => {
    const state = vaultedAccount()
    const dir = tmp()
    const h = harness(dir, state)
    await h.run(['pull', '--folder', 'Notes'])
    expect(readFolderConfig(join(dir, 'notes'))?.folderId).toBe('f-notes')
  })
})
