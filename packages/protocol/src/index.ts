import type { Anchor, Suggestion } from '@glyphdown/core'

// ---------------------------------------------------------------------------
// Identity & permissions
// ---------------------------------------------------------------------------

/** Roles in strictly increasing capability order. */
export const ROLES = ['viewer', 'commenter', 'suggester', 'editor', 'owner'] as const
export type Role = (typeof ROLES)[number]

export function roleAtLeast(role: Role, min: Role): boolean {
  return ROLES.indexOf(role) >= ROLES.indexOf(min)
}

export type PrincipalType = 'user' | 'agent'

/** The identity attached to a connection/request after the Worker validates auth. */
export interface Principal {
  id: string
  type: PrincipalType
  name: string
  /** For agents: the human the agent acts on behalf of. */
  ownerUserId?: string
}

/**
 * Trusted headers the Worker sets when forwarding an authenticated request or
 * WebSocket upgrade to the DocDO. The DO trusts these blindly — the DO is
 * never directly reachable from the internet.
 */
export const HEADER_PRINCIPAL = 'x-glyphdown-principal' // JSON Principal
export const HEADER_ROLE = 'x-glyphdown-role' // Role
export const HEADER_ASSET = 'x-glyphdown-asset' // Asset id resolved by the Worker
export const HEADER_ASSET_VERSION = 'x-glyphdown-asset-version' // Current asset version id, when known

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

export interface NodeStep {
  tag: string
  nthOfType: number
  id?: string
  clsNorm?: string
}

export interface NodeAnchor {
  schema: 1
  path: NodeStep[]
  fingerprint: {
    tag: string
    id?: string
    /** As-authored class list; diagnostic/exact-match evidence only. */
    classesRaw?: string[]
    /** De-hashed and sorted class list; weak scoring evidence only. */
    classesNorm?: string[]
    role?: string
    ariaLabel?: string
    name?: string
    /** Small allowlist: type, href(host+path), alt, data-* */
    attrs?: Record<string, string>
  }
  quote?: { exact: string; prefix: string; suffix: string }
  textRange?: { start: number; end: number; unit: 'utf16' }
  /** Document-order index at creation; search bias only. */
  domHint: number
  /** Human display label, e.g. `button "Save"`. */
  label: string
  status: 'anchored' | 'orphaned'
  /** Dynamic/client-only node; display-only and not server-persistable. */
  clientResolveOnly?: true
}

export type CommentAnchorKind = 'text' | 'node' | null

export interface CommentReply {
  id: string
  authorId: string
  authorName: string
  body: string
  createdAt: number
  reactions: Record<string, string[]>
}

export interface Comment {
  id: string
  /** Back-compat text-anchor field. null = doc-level comment. */
  anchor: Anchor | null
  /**
   * Additive discriminated anchor fields. Existing markdown clients can keep
   * reading `anchor`; new asset-comment clients read node anchors here.
   */
  anchorKind?: CommentAnchorKind
  textAnchor?: Anchor | null
  nodeAnchor?: NodeAnchor
  /** Asset comments record the asset version they were authored against. */
  versionId?: string
  authorId: string
  authorName: string
  body: string
  createdAt: number
  resolved: boolean
  reactions: Record<string, string[]>
  replies: CommentReply[]
}

// ---------------------------------------------------------------------------
// Suggestions (records from @glyphdown/core plus attribution metadata)
// ---------------------------------------------------------------------------

export interface SuggestionRecord extends Suggestion {
  authorName: string
  note?: string
}

// ---------------------------------------------------------------------------
// Versions / history
// ---------------------------------------------------------------------------

export interface VersionMeta {
  id: string
  createdAt: number
  /** Present for named versions; absent for auto-snapshots. */
  name?: string
  authorIds: string[]
  kind: 'auto' | 'named' | 'restore-point'
  sizeBytes: number
}

// ---------------------------------------------------------------------------
// DocDO REST surface (Worker -> DO via stub.fetch, path-based)
// ---------------------------------------------------------------------------
// GET    /content?view=working|clean      -> { text, versionId }
// POST   /push                            -> PushRequest / PushResponse
// GET    /comments                        -> { comments: Comment[] }
// POST   /comments                        -> CreateCommentRequest -> Comment
// POST   /comments/:id/replies            -> { body } -> CommentReply
// POST   /comments/:id/resolve            -> { resolved: boolean }
// POST   /comments/:id/reactions          -> { emoji } (toggles for principal)
// POST   /comments/:id/reattach           -> { start, end } -> Comment
// GET    /suggestions                     -> { suggestions: SuggestionRecord[] }
// POST   /suggestions/:id/accept          -> AcceptResponse
// POST   /suggestions/:id/reject          -> { ok: true }
// GET    /versions                        -> { versions: VersionMeta[] }
// GET    /versions/:id                    -> { text }
// POST   /versions                        -> { name? } -> VersionMeta (named snapshot)
// POST   /versions/:id/restore            -> { ok: true }

export interface PushRequest {
  newText: string
  /** sha-256 hex of the pulled base text. */
  baseHash: string
  /** Sent when the server's base cache misses (or on first push). */
  baseText?: string
  /** Land the push as a suggestion set instead of direct edits. */
  suggest?: boolean
  note?: string
  force?: boolean
}

export type PushResponse =
  | { ok: true; mode: 'edit'; applied: number; failedHunks: string[]; versionId: string }
  | { ok: true; mode: 'suggest'; suggestionId: string; versionId: string }
  | { ok: false; reason: 'degenerate'; deletedRatio: number }
  | { ok: false; reason: 'base-missing' } // resend with baseText
  | { ok: false; reason: 'forbidden' | 'too-large' | 'rate-limited'; retryAfterSec?: number }

export interface CreateCommentRequest {
  body: string
  /** Omitted = doc-level comment. */
  range?: { start: number; end: number }
}

export interface CreateAssetCommentRequest {
  body: string
  /** Omitted = asset-level comment. */
  nodeAnchor?: NodeAnchor
}

export interface CommentTarget {
  kind: 'doc' | 'asset'
  id: string
  label: string
  deepLink: string
  folderId?: string
  filename?: string
}

export interface AcceptResponse {
  ok: true
  outdatedParts: number
}

// ---------------------------------------------------------------------------
// WebSocket custom messages (JSON, alongside binary Yjs frames)
// ---------------------------------------------------------------------------
// Server -> client broadcasts keeping sidecar state live without polling.

export type DocEvent =
  | { t: 'comment'; comment: Comment }
  | { t: 'comment-removed'; id: string }
  | { t: 'suggestion'; suggestion: SuggestionRecord }
  | { t: 'suggestion-status'; id: string; status: Suggestion['status']; outdatedParts?: number }
  | { t: 'version'; version: VersionMeta }
  | { t: 'doc-deleted' }

export type AssetCommentEvent =
  | { t: 'comment'; comment: Comment }
  | { t: 'comment-removed'; id: string }

// Client -> server over the socket (suggest-mode sessions stream their
// suggestion records so other clients render them live).
export type ClientMessage = { t: 'suggestion-upsert'; suggestion: SuggestionRecord }

// ---------------------------------------------------------------------------
// Public HTTP API (Worker routes, used by the CLI and the web UI)
// ---------------------------------------------------------------------------
// All under /api, auth via session cookie or Authorization: Bearer gd_sk_...
//          (legacy ink_sk_ keys are still accepted)
//
// GET    /api/me                              -> { principal }
// GET    /api/docs                            -> { docs: DocMeta[] }
// POST   /api/docs                            -> { filename?, title?, folderId? } -> DocMeta
//          `filename` wins when both are sent; a bare title is slugified into
//          one. Scope collisions on CREATE are auto-suffixed (-2, -3, …) so
//          creation never fails on a name — read the canonical filename off
//          the response.
// GET    /api/docs/:id                        -> DocMeta
// PATCH  /api/docs/:id                        -> { filename? | title?, folderId? } -> DocMeta
//          Rename = { filename } (a slug stem, with or without `.md`; legacy
//          { title } payloads are slugified). Renames and folder moves
//          re-check uniqueness in the target scope and return 409
//          `filename-taken` on collision — no silent suffixing.
//          `folderId: null` is rejected (400 `bad-folder`): every doc lives
//          in a vault's subtree, there is no root scope to move into.
// DELETE /api/docs/:id                        -> { ok: true } (owner-only soft delete)
// POST   /api/docs/:id/restore                -> {} -> DocMeta (owner-only)
//          Restores a trashed doc. If its folder is gone (or it was trashed
//          from the pre-vault root), it re-homes into the owner's default
//          vault; filename collisions in the target scope are suffixed
//          (-2, -3, …) like create — restore never fails on a name.
// GET    /api/docs/:id/content?view=...       -> text/markdown (+ X-Glyphdown-Version, X-Glyphdown-Base-Hash;
//          the legacy X-Inkroom-* names are echoed alongside for one release
//          so outdated `ink` binaries keep working)
// POST   /api/docs/:id/push                   -> PushRequest -> PushResponse
// GET    /api/vaults                          -> { vaults: VaultMeta[] } (owned vaults + vaults with a DIRECT
//                                                folder_members grant on the vault root, with the effective role)
// POST   /api/vaults                          -> { name } -> VaultMeta (409 `name-taken` on a case-insensitive
//                                                collision with another of the caller's vaults)
// PATCH  /api/vaults/:id                      -> { name } -> VaultMeta (rename ONLY, owner-only; same 409
//                                                `name-taken` guard; vaults never move — a parentId is rejected
//                                                with 400 `vault-immovable`)
// DELETE /api/vaults/:id                      -> { ok } (owner-only; soft-deletes EVERY doc in the vault's
//                                                subtree into the 30-day trash and hard-deletes the subtree's
//                                                folder rows, so restore re-homes docs into the default vault.
//                                                400 `last-vault` / `default-vault` protect the caller's only
//                                                vault and their default vault)
// GET    /api/folders                         -> { folders: FolderMeta[] } (owned + granted + descendants of granted)
// POST   /api/folders                         -> { name, parentId } -> FolderMeta (parent required and caller-owned —
//                                                its chain must terminate in a vault; depth-capped)
// GET    /api/folders/:id                     -> FolderMeta (role = max over the folder's ancestor chain)
// PATCH  /api/folders/:id                     -> { name?, parentId?: string } -> FolderMeta
//                                                (move = owner-only; 400 `cycle` / `too-deep` on violation;
//                                                vaults cannot move at all and plain folders cannot move to
//                                                root — `parentId: null` is rejected with 400)
// DELETE /api/folders/:id                     -> { ok } (child folders + docs promote to the deleted folder's
//                                                parent; vaults are refused — 400 `vault-undeletable` — until the
//                                                dedicated vault-delete flow lands)
// ...comments/suggestions/versions proxied through to the DO surface above.

export interface DocMeta {
  id: string
  /**
   * The document's canonical name — a slug ending in `.md` (charset
   * [a-z0-9-], e.g. `the-garden.md`), unique within its scope (its folder, or
   * the owner's root when folderless). The filesystem model: this IS the
   * file's name in every CLI workspace, and the web UI displays its stem.
   */
  filename: string
  /**
   * Derived: the filename stem (no `.md`). Kept in the payload so pre-rename
   * consumers keep rendering something sane — never a free-text title anymore.
   */
  title: string
  folderId: string | null
  ownerUserId: string
  role: Role
  createdAt: number
  updatedAt: number
}

// ---------------------------------------------------------------------------
// Doc filenames (the canonical doc name — Obsidian-style "docs are files")
// ---------------------------------------------------------------------------

/** A valid stored doc filename: a non-empty [a-z0-9-] slug plus `.md`. */
export const DOC_FILENAME_RE = /^[a-z0-9][a-z0-9-]*\.md$/

/**
 * Slugify free text (a legacy title, a local file's stem, typed input) into a
 * doc filename stem: lowercase, every non-[a-z0-9] run collapsed to a single
 * `-`, edge dashes trimmed; `untitled` when nothing usable remains. The
 * doc-name sibling of normalizeAssetFilename below — stricter because doc
 * filenames are typed in wiki links and URLs.
 */
export function slugifyDocStem(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'untitled'
}

/** Normalize any requested name (with or without `.md`) to `<slug>.md`. */
export function normalizeDocFilename(raw: string): string {
  return `${slugifyDocStem(raw.replace(/\.md$/i, ''))}.md`
}

/** The display name of a doc filename: the stem, without `.md`. */
export function docFilenameStem(filename: string): string {
  return filename.replace(/\.md$/, '')
}

// ---------------------------------------------------------------------------
// Search (global index DO behind the Worker)
// ---------------------------------------------------------------------------
// GET /api/search?q=<query>[&vault=<vaultId>]  -> { results: SearchResult[] }
//   Full-text search over every doc the caller can access (same accessible
//   set as GET /api/docs, folder inheritance included). Titles come from D1.
//   `vault` (optional) narrows to that vault's subtree BEFORE the result
//   limit, so scoped searches aren't lossy; the caller must be able to see
//   the vault (owner or a folder grant on/under it), else 404.
// GET /api/docs/:id/backlinks      -> { docs: DocMeta[] }
//   Docs (visible to the caller) whose bodies wiki-link [[this doc's title]],
//   filtered to the linked doc's vault (wiki links resolve in-vault).

export interface SearchResult {
  docId: string
  title: string
  /** ±60 chars around the first hit; the hit is wrapped in «». */
  snippet: string
  /** Higher is better (engine-relative; FTS5 bm25 flipped positive). */
  score: number
}

/**
 * Folder row from the /api/folders surface. Folders nest (parentId) up to
 * MAX_FOLDER_DEPTH levels; a grant (membership or share link) on a folder
 * applies to every doc in its entire subtree, and `role` is the caller's
 * effective role: max(owner, folder_members on the folder or any ancestor).
 *
 * `kind` partitions the tree: every root row (parentId null) is a VAULT — an
 * Obsidian-style root namespace docs live under — and every non-root row is a
 * plain `folder`. Vaults cannot be moved or nested, plain folders cannot
 * become roots, and every doc lives in some vault's subtree.
 */
export type FolderKind = 'folder' | 'vault'

export interface FolderMeta {
  id: string
  name: string
  kind: FolderKind
  parentId: string | null
  ownerUserId: string
  role: Role
  createdAt: number
}

/**
 * Vault row from the /api/vaults surface. A vault IS a folder row (kind =
 * 'vault', parentId null) — these routes are thin wrappers that enforce the
 * vault invariants — so this is FolderMeta minus the fields a vault pins
 * (kind, parentId). `role` is owner for owned vaults, else the caller's max
 * DIRECT grant on the vault root (a grant on a subfolder shares that subtree,
 * not the vault).
 */
export interface VaultMeta {
  id: string
  name: string
  ownerUserId: string
  role: Role
  createdAt: number
}

/**
 * Maximum folder nesting depth (a root has depth 1). API-enforced. The vault
 * root consumes a level, so this is 11 — pre-vault trees could legitimately
 * be 10 deep and gained a vault above them in the backfill.
 */
export const MAX_FOLDER_DEPTH = 11

// ---------------------------------------------------------------------------
// Share links (anyone-with-link grants on a doc or folder)
// ---------------------------------------------------------------------------
// GET    /api/docs/:id/share-links            -> { shareLinks: ShareLink[] } (active links only)
// POST   /api/docs/:id/share-links            -> { role: ShareLinkRole } -> ShareLink
// DELETE /api/docs/:id/share-links/:token     -> { ok: true } (revoke; idempotent)
// ...and the same three under /api/folders/:id/share-links. All owner-only
// (403 otherwise). A folder link grants its role over the folder's ENTIRE
// subtree. Visitors present the token as ?share=<token> (or the
// X-Glyphdown-Share header); the shareable URLs are the web landing pages:
//   doc:    https://<server>/d/<docId>?share=<token>
//   folder: https://<server>/f/<folderId>?share=<token>

/** Roles a share link can grant — every role except owner. */
export const SHARE_LINK_ROLES = ['viewer', 'commenter', 'suggester', 'editor'] as const
export type ShareLinkRole = (typeof SHARE_LINK_ROLES)[number]

/** One active anyone-with-link grant. The token IS the capability — treat it as a secret. */
export interface ShareLink {
  token: string
  role: ShareLinkRole
  createdAt: number
}

// ---------------------------------------------------------------------------
// Folder share-link landing surface
// ---------------------------------------------------------------------------
// GET /api/folders/:id/listing            -> FolderListingResponse
//   The one folder-scoped read that accepts a share token (?share= /
//   X-Glyphdown-Share) the way doc GETs do, so a folder/vault share link has
//   a web landing page (/f/:folderId?share=<token>). The token must be an
//   unrevoked folder link whose target is :id or one of its ancestors;
//   anonymous visitors are capped at viewer (view-role links only), signed-in
//   visitors get max(own grants, link role). Returns the folder plus its
//   ENTIRE live subtree — never anything outside it.

export interface FolderListingFolderMeta extends FolderMeta {
  /** Assets scoped to this folder node. */
  assets: AssetMeta[]
}

export interface FolderListingResponse {
  /** The requested folder, with the caller's effective role. */
  folder: FolderListingFolderMeta
  /** Every visible descendant folder (the requested folder excluded). */
  folders: FolderListingFolderMeta[]
  /** Every live doc in the subtree (the requested folder included). */
  docs: DocMeta[]
}

// ---------------------------------------------------------------------------
// Assets (images and standalone HTML files stored in R2, scoped to a doc's
// folder — or the doc itself when it is folderless)
// ---------------------------------------------------------------------------
// POST   /api/docs/:id/assets?filename=<name>[&overwrite=true]
//          raw image/* or text/html body (≤ 10 MB), role editor+  -> UploadAssetResponse
// GET    /api/docs/:id/assets                        -> { assets: AssetMeta[] }
// GET    /api/docs/:id/assets/<filename>             -> bytes (viewer+, ETag,
//          cache-control: private; share token via ?share= / X-Glyphdown-Share —
//          the legacy X-Inkroom-Share header is still accepted)
// DELETE /api/docs/:id/assets/<filename>             -> { ok: true } (editor+)
// POST   /api/folders/:id/assets?filename=<name>[&overwrite=true]
//          raw image/* or text/html body (≤ 10 MB), folder role editor+
//          -> UploadAssetResponse
// GET    /api/folders/:id/assets                     -> { assets: AssetMeta[] }
// GET    /api/folders/:id/assets/<filename>          -> bytes (CLI sync flow)
// DELETE /api/folders/:id/assets/<filename>          -> { ok: true } (folder
//          role editor+ — mirrors the doc-scoped delete; sidebar viewer)

export interface AssetMeta {
  id: string
  /** Normalized filename — also the markdown-relative path docs embed. */
  filename: string
  contentType: string
  size: number
  /** R2 etag of the stored bytes (change detection for CLI sync). */
  etag: string
  createdBy: string
  createdAt: number
}

export interface UploadAssetResponse {
  asset: AssetMeta
  /** Markdown-relative path to embed: `![alt](<path>)`. */
  path: string
}

export interface AssetVersionMeta {
  id: string
  assetId: string
  contentHash: string
  size: number
  etag: string
  createdBy: string
  createdAt: number
  message?: string
  current: boolean
}

export const MAX_ASSET_BYTES = 10 * 1024 * 1024 // 10 MB

/** Image extensions the CLI sync scans for (lowercase, no dot). */
export const IMAGE_FILE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif'] as const

/** Standalone HTML asset extensions (lowercase, no dot). */
export const HTML_FILE_EXTENSIONS = ['html', 'htm'] as const

/** Asset extensions that can be synced as files (lowercase, no dot). */
export const SYNCABLE_ASSET_FILE_EXTENSIONS = [...IMAGE_FILE_EXTENSIONS, ...HTML_FILE_EXTENSIONS] as const

export type AssetKind = 'image' | 'html'

export function assetKindForContentType(contentType: string): AssetKind | null {
  const normalized = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  if (normalized.startsWith('image/')) return 'image'
  if (normalized === 'text/html') return 'html'
  return null
}

/**
 * Normalize an asset filename the way the server stores it: keep only the
 * basename (no path traversal), lowercase, whitespace → '-', strip control
 * characters and leading dots, cap at 200 chars keeping the extension.
 * Returns null when nothing usable remains. Shared by the Worker (upload
 * route) and the CLI (matching local files to server names).
 */
export function normalizeAssetFilename(raw: string): string | null {
  // Basename only: everything after the last path separator (either flavor).
  const base = raw.split(/[/\\]/).pop() ?? ''
  const name = base
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[\u0000-\u001f\u007f]/g, '') // residual control characters
    .replace(/^\.+/, '')
  if (name === '' || /^[-.]+$/.test(name)) return null
  if (name.length > 200) {
    const dot = name.lastIndexOf('.')
    const ext = dot > 0 ? name.slice(dot) : ''
    return name.slice(0, 200 - ext.length) + ext
  }
  return name
}
