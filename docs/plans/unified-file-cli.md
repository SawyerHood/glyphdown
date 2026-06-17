# Unified file CLI — treat docs and other files the same

> Goal (user): simplify the glyphdown CLI surface so **docs (`.md`) and other files
> (html/images, a.k.a. assets) are treated similarly**, in the CLI and in the
> user/agent mental model. Unify the *surface*, not the storage engine.
>
> Grounded in a code-verified workflow (probe × 4 → synthesis → adversarial critique).
> Supersedes the separate `asset add / asset ls / asset url` namespace proposed in
> [asset-ux-remediation.md](asset-ux-remediation.md).

## The problem, in UX terms

Today the CLI carries **two mental models**:

- **Docs are first-class:** `new`, `cat`, `list`, `rm`, `mv`, `share`, `comments`,
  `history`, a `/d/<id>` URL on create.
- **Other files are second-class:** no create verb at all (bytes only reach the
  server as a side effect of `sync`/`push --all` scanning a directory), invisible to
  `list`, and addressable only by `--folder <id> <filename>` or a viewer URL.

That split is the root of the reported friction (cloning a 33-doc vault just to upload
one `.html`; `list` never showing the file; `share <filename>` failing). The fix is to
collapse it into **one model: "everything in a folder is a file, addressed by its
filename."** The code already leans this way — `DocMeta` calls itself "the filesystem
model," and an asset's filename is documented as "the markdown-relative path docs embed."

## Why "other files" need a folder today (and how to remove that)

Docs let the server pick scope: `createDoc({filename, folderId?})` — when `folderId` is
omitted, the server homes the doc in your default vault via `ensureDefaultVault`
(`apps/web/src/api/router.ts:202-209`; `apps/web/src/api/vaults.ts:39`). Other files
have **no such default path**: the only upload routes are `POST /api/docs/:id/assets`
and `POST /api/folders/:id/assets` — scope lives in the URL and is baked into the
storage key `assetR2Key(scope, filename)` (`apps/web/src/api/assets.ts:68`). There is no
`/api/assets`.

**Fix: add `POST /api/assets` that, with no scope, calls `ensureDefaultVault` — a
near-verbatim copy of `createDoc`'s no-folder branch.** Net effect: `glyphdown add
report.html` with no flags just works and lands in your default vault, exactly like
`glyphdown new`.

> A CLI-side default instead of a server route is **blocked today**: nothing exposes
> your default vault to the client — `VaultMeta` has no flag (`protocol index.ts:377`),
> `GET /api/vaults` has no marker (`router.ts:1479`), and `GET /api/prefs` returns only
> `{ emailNotifications }` (`router.ts:1794`). The CLI could only *guess* the default
> and would drift the moment you set a non-`Home` one. The server route is the clean path.

## What stays split (and should)

The **storage/merge engine** must not unify, and the user never sees it:

- Docs are Yjs CRDT text with a true 3-way merge (`base.md` + server reconcile,
  `sync.ts:593-617`) — the whole point: concurrent human + agent edits merge.
- Other files are opaque blobs; `decideAssetSync` is upload / download / up-to-date /
  conflict (last-write-wins) by size+etag (`assets.ts:137-172`). You can't
  character-merge a PNG, and HTML through a text CRDT would corrupt.

So: **two backends, two reconcile algorithms, one file facade.** Images get no Durable
Object; only HTML assets get a comment sidecar — keep it that way.

## The unified command surface

**Fold files into the existing verbs — do not ship a separate `asset` namespace.** The
read/share verbs are *already* polymorphic; a parallel namespace would re-fork exactly
what we're merging.

| verb | doc | other file | status |
|------|-----|-----------|--------|
| `add <file>` | create doc from a local file | upload file → `POST /api/assets` | **new unified verb** |
| `cat <name>` | ✅ | ✅ (via `--folder`/`--doc`/URL) | already unified (`program.ts:377`) |
| `ls` / `list` | `listDocs` only (`program.ts:345`) | add `listFolderAssets` | **unify** |
| `url <name>` | `/d/<id>` (only printed at create) | `/f/<folderId>/file/<name>` (only printed for HTML during sync) | **unify** (new idempotent verb, both kinds, images too) |
| `rm <name>` | ✅ (`program.ts:506`) | wire existing `DELETE …/assets/<name>` | **unify** |
| `mv` | `renameDoc` (`program.ts:471`) | needs a rename-preserving-id endpoint | **unify (deferred — see caveat)** |
| `share` / `comments` / `comment` / `history` / `snapshot` | ✅ | ✅ | already unified (`resolveAssetTarget`, `program.ts:123`) |
| `new <name>` | empty doc | n/a — a file *is* its bytes; route real files through `add` | keep doc-only |

### The one rule, and its one catch

- **`add` dispatches on file extension** — safe, because you hand it a real local file:
  `.md` ⇒ doc; a syncable file ext (images + html, `SYNCABLE_ASSET_FILE_EXTENSIONS`,
  `protocol index.ts:494-500`) ⇒ file; anything else ⇒ error.
- **Referring to something by *name* later is the catch.** The server gates uploads on
  *content-type, not extension* (`assets.ts:360-364`), so a doc **and** a file can legally
  share a name (e.g. both `report.md`) in one folder — separate tables, no storage
  collision. So extension is *not* a safe dispatch for `cat`/`rm`/`mv <name>`. Those need
  **lookup-based** resolution against both namespaces with an ambiguity error (or
  `--kind doc|file`), which needs a server name-resolution endpoint that doesn't exist
  yet (`docref.ts:4-6`). Until it lands, file *references* stay explicit (`--folder` +
  name, or a URL) — the status quo.

## Phased plan

**Phase 1 — ships the unified model for the common path (no blockers).**
1. `POST /api/assets` reusing `ensureDefaultVault` (`router.ts` dispatch + `assets.ts`
   upload machinery; `protocol` route descriptor). **M**
2. CLI `add <file>` unified verb: extension dispatch, optional `--folder`/`--vault`/`--doc`,
   defaults to the default vault, prints the URL; `--share` mints a link inline. **M**
3. `ls`/`list` shows docs **and** files in one folder view (surface the already-existing
   `listFolderAssets`/`listDocAssets`). **S**
4. `url <name>` unified, idempotent, both kinds, emits viewer URLs for images too (today
   only HTML, only during sync, `assets.ts:391`). **S**

This alone delivers "single file in → URL out, no clone" and one mental model for create,
list, and URL lookup.

**Phase 2 — by-name reference for files (needs small new endpoints).**
5. Server name-resolution endpoint (resolve a filename → doc or file within a folder,
   with ambiguity signalled), then by-name `cat`/`rm` for files + a `--kind` tiebreaker.
6. `mv` for files: requires a rename-preserving-id endpoint so the rename keeps the
   asset's stable id — otherwise the comment thread + version history silently orphan (an
   asset's identity is `(scope, filename)`; the internal id backs comments/versions/share
   targets, `assets.ts:566`, `roles.ts:252`). **Decide if `mv` for files is in scope.**

**Already done — no work:** `cat`/`share`/`comments`/`history`/`snapshot` on files, and
per-file HTML share links with anonymous `?share=` access (v0.5.1).

## Decisions for the maintainer

1. **`POST /api/assets` (server default) vs CLI-side default** → server (CLI-side is
   blocked until the default vault is exposed to clients).
2. **Unified verbs vs `asset` namespace** → unified verbs (matches the polymorphic read
   side; namespace keeps files visibly second-class).
3. **Same-name doc + file collisions** → legal at rest; pick a policy for by-name verbs
   (`--kind` flag and/or ambiguity error) and build the name-resolution endpoint, or keep
   file references explicit for now.
4. **`new` for files** → keep `new` doc-only; a file is its bytes, so `add` is its create.
5. **Asset `mv`/rename** → only with a rename-preserving-id endpoint; otherwise defer.
