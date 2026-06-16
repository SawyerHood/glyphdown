import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { Principal } from '@glyphdown/protocol'
import * as schema from '../db/schema.ts'
import {
  assetShareLinkRole,
  computeDocRole,
  effectiveUserId,
  fetchAncestorChain,
  maxRole,
  resolveDocAccess,
  resolveFolderRole,
} from './roles.ts'
import type { Db } from '../db/client.ts'

const doc = { id: 'doc-1', ownerUserId: 'owner-1' }
const alice: Principal = { id: 'alice', type: 'user', name: 'Alice' }
const owner: Principal = { id: 'owner-1', type: 'user', name: 'Owner' }
const agent: Principal = { id: 'agent-1', type: 'agent', name: 'Claude Code', ownerUserId: 'owner-1' }
const strangerAgent: Principal = { id: 'agent-2', type: 'agent', name: 'Other Agent', ownerUserId: 'alice' }

/** Doc sits in folder-1, which is nested under folder-0 (the root). */
const chain = ['folder-1', 'folder-0']
const none = { ancestorFolderIds: chain, docMembers: [], folderMembers: [], shareLink: null }

describe('maxRole', () => {
  it('orders by capability, not lexically', () => {
    expect(maxRole('viewer', 'editor')).toBe('editor')
    expect(maxRole('owner', 'editor')).toBe('owner')
    expect(maxRole('commenter', 'suggester')).toBe('suggester')
    expect(maxRole(null, 'viewer')).toBe('viewer')
    expect(maxRole(null, null)).toBeNull()
  })
})

describe('effectiveUserId', () => {
  it('is the user for users, the owner for agents, null for anonymous', () => {
    expect(effectiveUserId(alice)).toBe('alice')
    expect(effectiveUserId(agent)).toBe('owner-1')
    expect(effectiveUserId(null)).toBeNull()
  })
})

describe('computeDocRole', () => {
  it('grants owner from docs.owner_user_id', () => {
    expect(computeDocRole({ doc, principal: owner, ...none })).toBe('owner')
  })

  it('returns null for unrelated users and anonymous callers', () => {
    expect(computeDocRole({ doc, principal: alice, ...none })).toBeNull()
    expect(computeDocRole({ doc, principal: null, ...none })).toBeNull()
  })

  it('takes the max of doc and folder memberships', () => {
    expect(
      computeDocRole({
        doc,
        ancestorFolderIds: chain,
        principal: alice,
        docMembers: [{ principalId: 'alice', principalType: 'user', role: 'commenter' }],
        folderMembers: [{ folderId: 'folder-1', principalId: 'alice', principalType: 'user', role: 'editor' }],
        shareLink: null,
      }),
    ).toBe('editor')
  })

  it('inherits a grant on any ancestor folder (grandparent reaches the doc)', () => {
    expect(
      computeDocRole({
        doc,
        ancestorFolderIds: chain,
        principal: alice,
        docMembers: [],
        folderMembers: [{ folderId: 'folder-0', principalId: 'alice', principalType: 'user', role: 'suggester' }],
        shareLink: null,
      }),
    ).toBe('suggester')
  })

  it('deeper (nearer) grant wins when it outranks the higher one — max over the chain', () => {
    expect(
      computeDocRole({
        doc,
        ancestorFolderIds: chain,
        principal: alice,
        docMembers: [],
        folderMembers: [
          { folderId: 'folder-0', principalId: 'alice', principalType: 'user', role: 'viewer' },
          { folderId: 'folder-1', principalId: 'alice', principalType: 'user', role: 'editor' },
        ],
        shareLink: null,
      }),
    ).toBe('editor')
  })

  it('higher (ancestor) grant wins when it outranks the nearer one — inheritance never downgrades', () => {
    expect(
      computeDocRole({
        doc,
        ancestorFolderIds: chain,
        principal: alice,
        docMembers: [],
        folderMembers: [
          { folderId: 'folder-0', principalId: 'alice', principalType: 'user', role: 'editor' },
          { folderId: 'folder-1', principalId: 'alice', principalType: 'user', role: 'viewer' },
        ],
        shareLink: null,
      }),
    ).toBe('editor')
  })

  it('doc grant beats a weaker folder grant', () => {
    expect(
      computeDocRole({
        doc,
        ancestorFolderIds: chain,
        principal: alice,
        docMembers: [{ principalId: 'alice', principalType: 'user', role: 'editor' }],
        folderMembers: [{ folderId: 'folder-0', principalId: 'alice', principalType: 'user', role: 'viewer' }],
        shareLink: null,
      }),
    ).toBe('editor')
  })

  it('ignores folder grants outside the ancestor chain (sibling folders)', () => {
    expect(
      computeDocRole({
        doc,
        ancestorFolderIds: chain,
        principal: alice,
        docMembers: [],
        folderMembers: [{ folderId: 'folder-sibling', principalId: 'alice', principalType: 'user', role: 'editor' }],
        shareLink: null,
      }),
    ).toBeNull()
  })

  it('a doc at the root inherits nothing from folders', () => {
    expect(
      computeDocRole({
        doc,
        ancestorFolderIds: [],
        principal: alice,
        docMembers: [],
        folderMembers: [{ folderId: 'folder-1', principalId: 'alice', principalType: 'user', role: 'editor' }],
        shareLink: null,
      }),
    ).toBeNull()
  })

  it('ignores memberships of other principals', () => {
    expect(
      computeDocRole({
        doc,
        ancestorFolderIds: chain,
        principal: alice,
        docMembers: [{ principalId: 'bob', principalType: 'user', role: 'editor' }],
        folderMembers: [{ folderId: 'folder-1', principalId: 'bob', principalType: 'user', role: 'editor' }],
        shareLink: null,
      }),
    ).toBeNull()
  })

  it('agents inherit their owner access (owner doc -> owner role)', () => {
    expect(computeDocRole({ doc, principal: agent, ...none })).toBe('owner')
  })

  it('agents inherit their owner memberships', () => {
    expect(
      computeDocRole({
        doc: { ...doc, ownerUserId: 'someone-else' },
        ancestorFolderIds: chain,
        principal: strangerAgent, // acts for alice
        docMembers: [{ principalId: 'alice', principalType: 'user', role: 'suggester' }],
        folderMembers: [],
        shareLink: null,
      }),
    ).toBe('suggester')
  })

  it('matches direct agent memberships on ancestor folders (folder shared with an agent)', () => {
    expect(
      computeDocRole({
        doc: { ...doc, ownerUserId: 'someone-else' },
        ancestorFolderIds: chain,
        principal: agent,
        docMembers: [],
        folderMembers: [{ folderId: 'folder-0', principalId: 'agent-1', principalType: 'agent', role: 'editor' }],
        shareLink: null,
      }),
    ).toBe('editor')
  })

  it('does not let a user id collide with an agent membership row', () => {
    expect(
      computeDocRole({
        doc: { ...doc, ownerUserId: 'someone-else' },
        ancestorFolderIds: chain,
        principal: { id: 'agent-1', type: 'user', name: 'Imposter' },
        docMembers: [{ principalId: 'agent-1', principalType: 'agent', role: 'editor' }],
        folderMembers: [],
        shareLink: null,
      }),
    ).toBeNull()
  })

  it('applies share links targeting the doc', () => {
    expect(
      computeDocRole({
        doc,
        ancestorFolderIds: chain,
        principal: alice,
        docMembers: [],
        folderMembers: [],
        shareLink: { targetType: 'doc', targetId: 'doc-1', role: 'suggester', revokedAt: null },
      }),
    ).toBe('suggester')
  })

  it('applies share links targeting the containing folder or any ancestor', () => {
    expect(
      computeDocRole({
        doc,
        ancestorFolderIds: chain,
        principal: alice,
        docMembers: [],
        folderMembers: [],
        shareLink: { targetType: 'folder', targetId: 'folder-1', role: 'editor', revokedAt: null },
      }),
    ).toBe('editor')
    expect(
      computeDocRole({
        doc,
        ancestorFolderIds: chain,
        principal: alice,
        docMembers: [],
        folderMembers: [],
        shareLink: { targetType: 'folder', targetId: 'folder-0', role: 'commenter', revokedAt: null },
      }),
    ).toBe('commenter')
  })

  it('ignores share links for other targets, sibling folders, and revoked links', () => {
    expect(
      computeDocRole({
        doc,
        ancestorFolderIds: chain,
        principal: alice,
        docMembers: [],
        folderMembers: [],
        shareLink: { targetType: 'doc', targetId: 'other-doc', role: 'editor', revokedAt: null },
      }),
    ).toBeNull()
    expect(
      computeDocRole({
        doc,
        ancestorFolderIds: chain,
        principal: alice,
        docMembers: [],
        folderMembers: [],
        shareLink: { targetType: 'folder', targetId: 'folder-sibling', role: 'editor', revokedAt: null },
      }),
    ).toBeNull()
    expect(
      computeDocRole({
        doc,
        ancestorFolderIds: chain,
        principal: alice,
        docMembers: [],
        folderMembers: [],
        shareLink: { targetType: 'doc', targetId: 'doc-1', role: 'editor', revokedAt: Date.now() },
      }),
    ).toBeNull()
  })

  it('share link never downgrades an existing grant', () => {
    expect(
      computeDocRole({
        doc,
        ancestorFolderIds: chain,
        principal: alice,
        docMembers: [{ principalId: 'alice', principalType: 'user', role: 'editor' }],
        folderMembers: [],
        shareLink: { targetType: 'doc', targetId: 'doc-1', role: 'viewer', revokedAt: null },
      }),
    ).toBe('editor')
  })

  it('anonymous visitors only get viewer, and only via view-role links', () => {
    expect(
      computeDocRole({
        doc,
        ancestorFolderIds: chain,
        principal: null,
        docMembers: [],
        folderMembers: [],
        shareLink: { targetType: 'doc', targetId: 'doc-1', role: 'viewer', revokedAt: null },
      }),
    ).toBe('viewer')
    expect(
      computeDocRole({
        doc,
        ancestorFolderIds: chain,
        principal: null,
        docMembers: [],
        folderMembers: [],
        shareLink: { targetType: 'doc', targetId: 'doc-1', role: 'editor', revokedAt: null },
      }),
    ).toBeNull()
  })
})

describe('resolveDocAccess (in-memory sqlite, nested folders)', () => {
  /**
   * Tree: root-A -> mid-B -> leaf-C, doc-1 in leaf-C; doc-root at the root.
   * bob has a grant on root-A only (inherits down to doc-1); carol has a
   * grant on leaf-C only.
   */
  function setup() {
    const sqlite = new Database(':memory:')
    sqlite.exec(`
      CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
        email_verified INTEGER NOT NULL DEFAULT 0, image TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE folders (id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, name TEXT NOT NULL,
        parent_id TEXT REFERENCES folders(id), created_at INTEGER NOT NULL);
      CREATE TABLE docs (id TEXT PRIMARY KEY, title TEXT NOT NULL, filename TEXT NOT NULL DEFAULT '',
        folder_id TEXT, owner_user_id TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER);
      CREATE TABLE doc_members (doc_id TEXT NOT NULL, principal_id TEXT NOT NULL, principal_type TEXT NOT NULL,
        role TEXT NOT NULL, added_by TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (doc_id, principal_id));
      CREATE TABLE folder_members (folder_id TEXT NOT NULL, principal_id TEXT NOT NULL, principal_type TEXT NOT NULL,
        role TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (folder_id, principal_id));
      CREATE TABLE share_links (token TEXT PRIMARY KEY, target_type TEXT NOT NULL, target_id TEXT NOT NULL,
        role TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER);
    `)
    const now = Date.now()
    const folder = sqlite.prepare('INSERT INTO folders VALUES (?, ?, ?, ?, ?)')
    folder.run('root-A', 'owner-1', 'A', null, now)
    folder.run('mid-B', 'owner-1', 'B', 'root-A', now)
    folder.run('leaf-C', 'owner-1', 'C', 'mid-B', now)
    const insertDoc = sqlite.prepare("INSERT INTO docs VALUES (?, ?, '', ?, ?, ?, ?, NULL)")
    insertDoc.run('doc-1', 'Hello', 'leaf-C', 'owner-1', now, now)
    insertDoc.run('doc-root', 'Loose', null, 'owner-1', now, now)
    sqlite
      .prepare('INSERT INTO doc_members VALUES (?, ?, ?, ?, ?, ?)')
      .run('doc-1', 'alice', 'user', 'commenter', 'owner-1', now)
    const member = sqlite.prepare('INSERT INTO folder_members VALUES (?, ?, ?, ?, ?)')
    member.run('root-A', 'bob', 'user', 'editor', now)
    member.run('leaf-C', 'carol', 'user', 'suggester', now)
    const link = sqlite.prepare('INSERT INTO share_links VALUES (?, ?, ?, ?, ?, ?, NULL)')
    link.run('tok-view', 'doc', 'doc-1', 'viewer', 'owner-1', now)
    link.run('tok-folder-A', 'folder', 'root-A', 'viewer', 'owner-1', now)
    // The better-sqlite3 driver is API-compatible with the d1 driver for the
    // query shapes resolveDocAccess uses.
    return drizzle(sqlite, { schema }) as unknown as Db
  }

  it('resolves owner / member / anonymous-link roles', async () => {
    const db = setup()
    expect((await resolveDocAccess(db, 'doc-1', owner, null))?.role).toBe('owner')
    expect((await resolveDocAccess(db, 'doc-1', alice, null))?.role).toBe('commenter')
    expect((await resolveDocAccess(db, 'doc-1', null, 'tok-view'))?.role).toBe('viewer')
    expect((await resolveDocAccess(db, 'doc-1', null, 'tok-missing'))?.role).toBeNull()
    expect((await resolveDocAccess(db, 'doc-1', { id: 'dave', type: 'user', name: 'D' }, null))?.role).toBeNull()
    expect(await resolveDocAccess(db, 'doc-missing', owner, null)).toBeNull()
  })

  it('a grant on a grandparent folder reaches the doc; sibling users get nothing', async () => {
    const db = setup()
    expect((await resolveDocAccess(db, 'doc-1', { id: 'bob', type: 'user', name: 'Bob' }, null))?.role).toBe('editor')
    expect((await resolveDocAccess(db, 'doc-1', { id: 'carol', type: 'user', name: 'C' }, null))?.role).toBe(
      'suggester',
    )
    // bob's grant on root-A does NOT reach a doc outside the tree.
    expect((await resolveDocAccess(db, 'doc-root', { id: 'bob', type: 'user', name: 'Bob' }, null))?.role).toBeNull()
  })

  it('a folder share link on an ancestor grants anonymous viewers access to subtree docs', async () => {
    const db = setup()
    expect((await resolveDocAccess(db, 'doc-1', null, 'tok-folder-A'))?.role).toBe('viewer')
    expect((await resolveDocAccess(db, 'doc-root', null, 'tok-folder-A'))?.role).toBeNull()
  })

  it('agents resolve through their owner', async () => {
    const db = setup()
    expect((await resolveDocAccess(db, 'doc-1', agent, null))?.role).toBe('owner')
    const aliceAgent: Principal = { id: 'agent-9', type: 'agent', name: 'A9', ownerUserId: 'alice' }
    expect((await resolveDocAccess(db, 'doc-1', aliceAgent, null))?.role).toBe('commenter')
    const bobAgent: Principal = { id: 'agent-10', type: 'agent', name: 'A10', ownerUserId: 'bob' }
    expect((await resolveDocAccess(db, 'doc-1', bobAgent, null))?.role).toBe('editor')
  })

  it('fetchAncestorChain walks nearest-first and tolerates roots', async () => {
    const db = setup()
    expect(await fetchAncestorChain(db, 'leaf-C')).toEqual(['leaf-C', 'mid-B', 'root-A'])
    expect(await fetchAncestorChain(db, 'root-A')).toEqual(['root-A'])
    expect(await fetchAncestorChain(db, null)).toEqual([])
    expect(await fetchAncestorChain(db, 'missing')).toEqual([])
  })

  it('resolveFolderRole inherits from ancestor folders', async () => {
    const db = setup()
    const leaf = { id: 'leaf-C', ownerUserId: 'owner-1' }
    expect(await resolveFolderRole(db, leaf, owner)).toBe('owner')
    expect(await resolveFolderRole(db, leaf, { id: 'bob', type: 'user', name: 'Bob' })).toBe('editor')
    expect(await resolveFolderRole(db, leaf, { id: 'carol', type: 'user', name: 'C' })).toBe('suggester')
    expect(await resolveFolderRole(db, { id: 'root-A', ownerUserId: 'owner-1' }, { id: 'carol', type: 'user', name: 'C' })).toBeNull()
    expect(await resolveFolderRole(db, leaf, null)).toBeNull()
  })
})

describe('assetShareLinkRole (per-file/asset share tokens)', () => {
  /**
   * Three live links: a viewer + a commenter link on asset-A, plus a viewer
   * link on asset-B; one revoked link on asset-A; and a folder link (wrong
   * target type) on folder-1.
   */
  function setup(): Db {
    const sqlite = new Database(':memory:')
    sqlite.exec(`
      CREATE TABLE share_links (token TEXT PRIMARY KEY, target_type TEXT NOT NULL, target_id TEXT NOT NULL,
        role TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER);
    `)
    const link = sqlite.prepare('INSERT INTO share_links VALUES (?, ?, ?, ?, ?, ?, ?)')
    const now = Date.now()
    link.run('tok-a-view', 'asset', 'asset-A', 'viewer', 'owner-1', now, null)
    link.run('tok-a-comment', 'asset', 'asset-A', 'commenter', 'owner-1', now, null)
    link.run('tok-b-view', 'asset', 'asset-B', 'viewer', 'owner-1', now, null)
    link.run('tok-a-dead', 'asset', 'asset-A', 'commenter', 'owner-1', now, 999)
    link.run('tok-folder', 'folder', 'folder-1', 'editor', 'owner-1', now, null)
    // A defensive case: a stored editor asset link (creation now rejects these).
    link.run('tok-a-edit', 'asset', 'asset-A', 'editor', 'owner-1', now, null)
    return drizzle(sqlite, { schema }) as unknown as Db
  }

  it('grants the signed-in caller the link role for its asset, nothing for another asset', async () => {
    const db = setup()
    expect(await assetShareLinkRole(db, 'asset-A', alice, 'tok-a-comment')).toBe('commenter')
    // A token for asset A confers nothing on asset B.
    expect(await assetShareLinkRole(db, 'asset-B', alice, 'tok-a-comment')).toBeNull()
    expect(await assetShareLinkRole(db, 'asset-A', alice, 'tok-b-view')).toBeNull()
  })

  it('caps anonymous callers at viewer, and only via a view link', async () => {
    const db = setup()
    expect(await assetShareLinkRole(db, 'asset-A', null, 'tok-a-view')).toBe('viewer')
    // Anonymous + comment link → nothing (comment-and-above needs sign-in).
    expect(await assetShareLinkRole(db, 'asset-A', null, 'tok-a-comment')).toBeNull()
    // Signed-in commenter link still grants commenter.
    expect(await assetShareLinkRole(db, 'asset-A', alice, 'tok-a-view')).toBe('viewer')
  })

  it('returns null for revoked tokens, folder-type tokens, missing tokens, and no token', async () => {
    const db = setup()
    expect(await assetShareLinkRole(db, 'asset-A', alice, 'tok-a-dead')).toBeNull()
    // A folder link is not an asset link, even pointed at a matching id.
    expect(await assetShareLinkRole(db, 'folder-1', alice, 'tok-folder')).toBeNull()
    expect(await assetShareLinkRole(db, 'asset-A', alice, 'tok-missing')).toBeNull()
    expect(await assetShareLinkRole(db, 'asset-A', alice, null)).toBeNull()
  })

  it('caps a stored suggest/edit role at commenter (asset links are view/comment only)', async () => {
    const db = setup()
    // Signed-in: an editor asset link confers at most commenter on a file.
    expect(await assetShareLinkRole(db, 'asset-A', alice, 'tok-a-edit')).toBe('commenter')
    // Anonymous: capped to commenter then denied (not a view link).
    expect(await assetShareLinkRole(db, 'asset-A', null, 'tok-a-edit')).toBeNull()
  })
})
