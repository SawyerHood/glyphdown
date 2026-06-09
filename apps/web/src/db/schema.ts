import { sql } from 'drizzle-orm'
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core'

/**
 * D1 schema (SPEC §10): cross-document relational data only. Doc content,
 * comments, suggestions, and versions live in each document's DocDO.
 *
 * The first four tables are better-auth's core schema (user/session/account/
 * verification) with snake_case column names; better-auth's drizzle adapter
 * maps its models onto them via the JS property names.
 */

// ---------------------------------------------------------------------------
// better-auth tables
// ---------------------------------------------------------------------------

export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' })
    .notNull()
    .default(false),
  image: text('image'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
})

export const session = sqliteTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    token: text('token').notNull().unique(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index('session_user_id_idx').on(t.userId)],
)

export const account = sqliteTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp_ms' }),
    refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp_ms' }),
    scope: text('scope'),
    password: text('password'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index('account_user_id_idx').on(t.userId)],
)

export const verification = sqliteTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date()),
})

/**
 * better-auth deviceAuthorization plugin model (RFC 8628 device flow for
 * `ink login`). Rows are short-lived: the plugin deletes them on token
 * issue, denial, and expired-poll.
 */
export const deviceCode = sqliteTable(
  'device_code',
  {
    id: text('id').primaryKey(),
    deviceCode: text('device_code').notNull(),
    userCode: text('user_code').notNull(),
    /** Set when a signed-in user opens /device with the code ("claimed"). */
    userId: text('user_id'),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    /** 'pending' | 'approved' | 'denied' */
    status: text('status').notNull(),
    lastPolledAt: integer('last_polled_at', { mode: 'timestamp_ms' }),
    pollingInterval: integer('polling_interval'),
    clientId: text('client_id'),
    scope: text('scope'),
  },
  (t) => [
    index('device_code_device_code_idx').on(t.deviceCode),
    index('device_code_user_code_idx').on(t.userCode),
  ],
)

// ---------------------------------------------------------------------------
// Glyphdown tables (timestamps are plain epoch-ms integers, matching the
// protocol's number fields)
// ---------------------------------------------------------------------------

const PRINCIPAL_TYPES = ['user', 'agent'] as const
/** Grantable roles: owner is never stored — it derives from docs.owner_user_id. */
const MEMBER_ROLES = ['viewer', 'commenter', 'suggester', 'editor'] as const

export const agents = sqliteTable(
  'agents',
  {
    id: text('id').primaryKey(),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** sha-256 hex of the full `gd_sk_…` (or legacy `ink_sk_…`) key; the raw key is never stored. */
    keyHash: text('key_hash').notNull().unique(),
    /** Reserved for narrowing later; v1 = inherit the owner's access. */
    scope: text('scope').notNull().default('inherit'),
    createdAt: integer('created_at').notNull(),
    revokedAt: integer('revoked_at'),
  },
  (t) => [index('agents_owner_idx').on(t.ownerUserId)],
)

export const folders = sqliteTable(
  'folders',
  {
    id: text('id').primaryKey(),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /**
     * Nested folders: null = root. Plain nullable FK on purpose — folder
     * deletion promotes children to the deleted folder's parent in code
     * (DELETE /api/folders/:id), so no ON DELETE action ever fires. The
     * depth cap (≤ 10) and cycle guard are enforced in the API layer.
     */
    parentId: text('parent_id').references((): AnySQLiteColumn => folders.id),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('folders_owner_idx').on(t.ownerUserId), index('folders_parent_idx').on(t.parentId)],
)

export const docs = sqliteTable(
  'docs',
  {
    id: text('id').primaryKey(),
    /**
     * LEGACY — kept physically for cheap back-compat, but no longer the
     * doc's name. `filename` is canonical; the API derives DocMeta.title
     * from the filename stem and writes the stem here on create/rename so
     * old readers of this column stay roughly coherent. Never display or
     * match against this directly.
     */
    title: text('title').notNull(),
    /**
     * The canonical doc name (filesystem model): a slug ending in `.md`
     * (charset [a-z0-9-], e.g. `the-garden.md`). Unique among LIVE docs in
     * its scope — same folder_id, or the owner's root when folder_id IS
     * NULL — enforced by the two partial unique indexes below (SQLite
     * treats NULLs as distinct, so root scope needs its own owner-keyed
     * index). Soft-deleted docs release their name (deleted_at IS NULL
     * predicates). The '' default exists only because SQLite cannot ADD a
     * NOT NULL column without one; the backfill migration fills every row
     * and the API always writes a real name.
     */
    filename: text('filename').notNull().default(''),
    folderId: text('folder_id').references(() => folders.id, { onDelete: 'set null' }),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    /** Soft delete (30-day trash, SPEC §11). */
    deletedAt: integer('deleted_at'),
  },
  (t) => [
    index('docs_owner_idx').on(t.ownerUserId),
    index('docs_folder_idx').on(t.folderId),
    uniqueIndex('docs_folder_filename_unique')
      .on(t.folderId, t.filename)
      .where(sql`folder_id IS NOT NULL AND deleted_at IS NULL`),
    uniqueIndex('docs_root_filename_unique')
      .on(t.ownerUserId, t.filename)
      .where(sql`folder_id IS NULL AND deleted_at IS NULL`),
  ],
)

export const docMembers = sqliteTable(
  'doc_members',
  {
    docId: text('doc_id')
      .notNull()
      .references(() => docs.id, { onDelete: 'cascade' }),
    principalId: text('principal_id').notNull(),
    principalType: text('principal_type', { enum: PRINCIPAL_TYPES }).notNull(),
    role: text('role', { enum: MEMBER_ROLES }).notNull(),
    addedBy: text('added_by').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.docId, t.principalId] }), index('doc_members_principal_idx').on(t.principalId)],
)

export const folderMembers = sqliteTable(
  'folder_members',
  {
    folderId: text('folder_id')
      .notNull()
      .references(() => folders.id, { onDelete: 'cascade' }),
    principalId: text('principal_id').notNull(),
    principalType: text('principal_type', { enum: PRINCIPAL_TYPES }).notNull(),
    role: text('role', { enum: MEMBER_ROLES }).notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.folderId, t.principalId] }),
    index('folder_members_principal_idx').on(t.principalId),
  ],
)

export const shareLinks = sqliteTable(
  'share_links',
  {
    token: text('token').primaryKey(),
    targetType: text('target_type', { enum: ['doc', 'folder'] }).notNull(),
    targetId: text('target_id').notNull(),
    role: text('role', { enum: MEMBER_ROLES }).notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: integer('created_at').notNull(),
    revokedAt: integer('revoked_at'),
  },
  (t) => [index('share_links_target_idx').on(t.targetType, t.targetId)],
)

/**
 * Image/file assets referenced by docs (markdown-relative paths). Exactly one
 * of folder_id / doc_id is set: a doc's asset namespace is its containing
 * folder when it has one, else the doc itself (assetScopeFor in api/assets.ts).
 * Bytes live in R2 under r2_key; this row is the metadata + name index.
 * SQLite treats NULL as distinct in unique indexes, so doc-scoped rows never
 * collide with each other on (folder_id, filename) and vice versa.
 */
export const assets = sqliteTable(
  'assets',
  {
    id: text('id').primaryKey(),
    folderId: text('folder_id').references(() => folders.id, { onDelete: 'cascade' }),
    docId: text('doc_id').references(() => docs.id, { onDelete: 'cascade' }),
    /** Normalized (lowercase, no spaces/path separators/leading dots). */
    filename: text('filename').notNull(),
    r2Key: text('r2_key').notNull(),
    contentType: text('content_type').notNull(),
    size: integer('size').notNull(),
    /** R2 etag of the stored object — lets list endpoints expose change detection without R2 head() calls. */
    etag: text('etag').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('assets_folder_filename_idx').on(t.folderId, t.filename),
    uniqueIndex('assets_doc_filename_idx').on(t.docId, t.filename),
  ],
)

/**
 * Email invitations (docs + folders). One row per outstanding (or settled)
 * invite. Two lifecycles share the table:
 *  - Unknown email: row starts PENDING (accepted_at/accepted_by NULL); the
 *    recipient signs up and POST /api/invites/:token/accept grants the
 *    membership. Token possession is authority — the accepting account's
 *    email may differ from `email`.
 *  - Existing user: the membership is granted immediately and the row is
 *    written pre-accepted (audit trail + the shared rate-limit counter).
 * Re-inviting the same email deletes the pending row and mints a new token.
 */
export const invites = sqliteTable(
  'invites',
  {
    token: text('token').primaryKey(),
    /** Always stored lowercased/trimmed. */
    email: text('email').notNull(),
    targetType: text('target_type', { enum: ['doc', 'folder'] }).notNull(),
    targetId: text('target_id').notNull(),
    role: text('role', { enum: MEMBER_ROLES }).notNull(),
    /** Principal id (user or agent acting for the owner) who sent it. */
    invitedBy: text('invited_by').notNull(),
    createdAt: integer('created_at').notNull(),
    acceptedAt: integer('accepted_at'),
    acceptedBy: text('accepted_by'),
    revokedAt: integer('revoked_at'),
  },
  (t) => [
    index('invites_email_idx').on(t.email),
    index('invites_target_idx').on(t.targetType, t.targetId),
    /** Serves the per-inviter rate-limit count (invited_by + window). */
    index('invites_inviter_idx').on(t.invitedBy, t.createdAt),
  ],
)

/**
 * Per-user preferences. Kept out of the better-auth-managed `user` table on
 * purpose (its schema belongs to the auth library). Missing row = defaults.
 * email_notifications gates NON-transactional email (mentions); invites are
 * transactional and ignore it.
 */
export const userPrefs = sqliteTable('user_prefs', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  /** 1 = send mention/notification emails (default), 0 = opted out. */
  emailNotifications: integer('email_notifications').notNull().default(1),
})

export const notifications = sqliteTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** 'mention' | 'doc-shared' | … */
    type: text('type').notNull(),
    payloadJson: text('payload_json').notNull(),
    createdAt: integer('created_at').notNull(),
    readAt: integer('read_at'),
  },
  (t) => [index('notifications_user_idx').on(t.userId, t.readAt)],
)
