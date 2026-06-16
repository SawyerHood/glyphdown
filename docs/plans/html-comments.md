# Plan: Comments on HTML Documents (v2)

> Status: proposal / not implemented. **v2** — revised after an adversarial gpt-5.5 validation
> of v1, then a second gpt-5.5 verification pass that drove the precision fixes below (full
> reports: [`html-comments-validation.md`](./html-comments-validation.md); verification verdicts
> folded inline). Scope: document-level and node/element-level comments on HTML assets, plus
> HTML versioning.

## Changelog — what v2 fixes (and why)

v1 was directionally right but **overstated reuse** of the markdown comment stack and
**under-specified the asset layer**. The validation found 8 blockers; v2 resolves each:

1. **Asset identity is now the first contract (§2.1).** HTML assets are addressed by
   `folder/doc scope + filename` (with a legacy doc-scoped fallback), *not* by a free-standing
   id. v2 resolves an `AssetRow` first (reusing `resolveAssetRow`, `assets.ts:123`) and keys the
   per-asset DO by that immutable `row.id`.
2. **Routing is net-new, not a `FORWARDABLE` tweak (§2.2, §4.2).** Folder/doc asset handlers
   match `/assets/:filename` *exactly* (`assets.ts:228,266`); nested `/comments` 404s today.
3. **Live transport does not reuse PartyServer doc routing (§2.3).** `/parties/*` authenticates
   the path segment as a `docId` (`server.ts:43-48`); v1 → REST + polling, DO WebSocket later.
4. **Injected-runtime security is treated as a blocker (§2.4, §12).** The runtime shares the
   iframe JS realm with user HTML, so all `gd:*` messages are **untrusted**; the server is the
   only authority. **Decision: keep author scripts** (no strict-CSP mode) and secure the message
   boundary + secretless delivery instead.
5. **Versioning backfill no longer destroys bytes (§7.1, §9).** Legacy first-overwrite copies
   existing bytes to `v1` *before* writing the new object.
6. **Reuse claims are reframed as refactors (§2.5, §4.3, §5).** `sidecar.ts`/`CommentsSidebar`
   are `Y.Text`/text-range-bound; v2 specifies the extraction work.
7. **NodeAnchor is best-effort, not CRDT identity (§3).** Explicit grammar, scoring, thresholds,
   "never wrong-node" invariant, Worker-safe parser, and browser/server parity contract.
8. **Net-new fields/endpoints are labeled as such (throughout).** `NodeAnchor`, `textRange`,
   `clientResolveOnly`, `asset_versions`, `current_version_id`, asset comment routes — none exist.

## 1. Problem & current state

| | Markdown docs | HTML assets |
|---|---|---|
| Identity | First-class `docs` row (`schema.ts`), `filename`, ACLs, share links | `assets` row scoped to a folder **or** a legacy doc; addressed by scope+filename; no own ACL |
| Bytes | Y.Text `content` in a per-doc `DocDO` | R2 object at `${scope.kind}/${scope.id}/${filename}` (`assets.ts:62`) |
| id | `docId` (routable) | `assets.id` — a stable UUID (`assets.ts:326`), but **not** in the public URL |
| Live channel | WebSocket → `DocDO` (Yjs + JSON ctrl msgs) | none — plain `GET` of an R2 object |
| Comments | full system (anchors, threads, replies, reactions, resolve, orphan, @mentions) | **none** |
| Render | CodeMirror live-preview, comment marks | `<iframe sandbox="allow-scripts">` (no `allow-same-origin`), CSP `sandbox allow-scripts` (`assets.ts:358`, route `f.$folderId_.file.$filename.tsx:121`) |

**Confirmed-accurate v1 claims** (validation §5): the markdown/DO/R2/D1 model; comments live in
`DocDO` SQLite and are forwarded from the Worker; `anchor: null` already means a doc-level
comment (`protocol/src/index.ts:47`, `sidecar.ts:55`); text anchors use `TextQuote`
{exact,prefix,suffix} + relative positions + fuzzy re-anchor (`core/src/anchor.ts`); a second
SQLite-backed DO is feasible with explicit wiring.

**The central problem is unchanged but sharper:** markdown anchors are positions in a *CRDT
text*; HTML has no CRDT and is an R2 blob re-uploaded wholesale. We need (a) a **structural
anchor** for HTML nodes, (b) a **home** for HTML comments, (c) a way to **interact with nodes
inside a sandboxed cross-origin iframe** without trusting that frame, and (d) an **asset
identity/auth contract** that v1 skipped.

## 2. Architecture

### 2.1 Asset identity & routing (the first contract)

Every comment operation begins by resolving the **canonical asset row**, then addresses storage
by its immutable id:

- Reuse `resolveAssetRow(db, scope, filename, fallbackDocIds)` (`assets.ts:123`) — the same
  resolver `streamAsset`/`deleteAsset` use, including the legacy doc-scoped fallback
  (`assets.ts:102-132`). It is **currently private** in `assets.ts`, so step one is to export it
  (or place the new comment/version handlers inside `assets.ts`) — one shared resolver for comment
  endpoints, the viewer, and versioning.
- Key the per-asset DO by **`row.id`** (a `crypto.randomUUID()`, `assets.ts:326`).
- **Why this is viable:** the CLI's changed-file push uses `overwrite=true`, which **updates the
  existing row in place and preserves `row.id`** while changing bytes/etag (`assets.ts:309-319`).
  So the normal "agent edits the HTML and re-pushes" path keeps a stable id — exactly the case
  comments and cross-version re-anchoring care about.
- **Identity edge cases to document:** a non-overwrite name collision creates a *new* id +
  suffixed filename (`assets.ts:322`); a delete-then-recreate of the same filename creates a
  *new* id (`assets.ts:375`) → its comments do not carry over (they belong to the old id). There
  is no asset rename/move route today, so comments are bound to the immutable asset id; rename is
  deferred (§6).

### 2.2 Where HTML comments live → `HtmlDocDO` (per asset, keyed by `row.id`)

A second Durable Object class. It holds **no Y.Doc** (HTML is an R2 blob, not a CRDT). It owns:

- a `comments` SQLite table identical to `DocDO`'s (`do.ts:177`);
- `content_meta(asset_id, etag, content_hash, parsed_at)` + a cached **node fingerprint index**
  (§3) — a rebuildable cache, not source of truth;
- comment CRUD + **re-anchor on content change**.

Because `HtmlDocDO` has no Y.Doc, it must **not** extend `y-partyserver`'s `YServer` (which
persists Yjs updates and broadcasts via YServer messages, `do.ts:108-116`). Use plain
PartyServer `Server` or raw DO WebSockets/Storage for comment state.

**New REST routes** (resolved by the Worker, then forwarded to `HtmlDocDO` with trusted headers).
The **public** surface stays filename/scope-addressed (consistent with today's asset URLs); the
asset-id form is the **internal** DO key only. The real routes to add:

```
GET/POST  /api/folders/:folderId/assets/:filename/comments[...]
GET/POST  /api/docs/:docId/assets/:filename/comments[...]
GET       /api/folders/:folderId/assets/:filename/versions   (+ /:vid/raw, /:vid/restore)  (§7)
```

The Worker resolves `(scope, filename) → AssetRow` and addresses `HtmlDocDO` by `row.id`. This is
**net-new routing**: today `handleFolderAssets`/`handleDocAssets` match `/assets/:filename`
*exactly* (`assets.ts:228,266`) and `FORWARDABLE` only applies under `/api/docs/:id`
(`router.ts:53`), so nested comment/version paths must be added explicitly — they cannot be
reached by extending the existing matchers. (A top-level `/api/assets/:assetId/...` could be added
too, but then it needs its own by-id lookup + auth; the filename-addressed form reuses the
existing scope/role resolution and is preferred.)

### 2.3 Live updates → REST + polling first, DO WebSocket later

v1 assumed a WebSocket like the doc editor. But `/parties/*` authenticates the path segment as a
`docId` (`server.ts:43-48`) and the access-revocation recheck fanout only calls **doc** DOs in a
folder subtree (`router.ts:~533`). Reusing that for assets would leak access after revocation and
needs an asset-aware auth path.

- **v1 transport:** REST writes + TanStack-Query polling on focus/interval (the same mechanism
  notifications already use, SPEC §9). Simple, no revocation-fanout gap, no new party namespace.
- **Later (optional):** a dedicated `HtmlDocDO` WebSocket under a **separate** party namespace
  with asset/folder-aware auth **and** a parallel revocation fanout over asset rows + legacy
  fallback rows. Only build this if latency demands it.

### 2.4 Targeting nodes inside the sandboxed iframe → injected runtime, **zero trust**

The iframe is `sandbox="allow-scripts"` without `allow-same-origin`, and the asset response sets
CSP `sandbox allow-scripts` (`assets.ts:358-360`). The parent **cannot** read the iframe DOM, so
node interaction requires code running *inside* the frame. v1 proposed an injected runtime +
postMessage; v2 keeps that but **fixes the trust model**, which is a blocker:

- Under `sandbox="allow-scripts"`, the injected runtime shares **one JS realm** with the
  user-authored HTML. User scripts can **forge/observe `gd:*` messages** and read anything in the
  iframe URL. Opaque-origin makes `event.origin` checks meaningless.
- **Product decision: keep author scripts (no strict CSP mode).** Comment mode preserves the
  existing `sandbox allow-scripts` behavior — JS-driven dashboards keep working — and **all
  security comes from the message boundary, not from locking down the frame.** We do not nonce-gate
  or disable author scripts. (Consequence accepted: an author's own script can forge `gd:*`
  messages and even tamper with the injected runtime/markers — but that only distorts the author's
  view of their own document; it is not a privilege escalation, since they already control the
  HTML. Security therefore depends only on the two hard requirements below.)
- **Therefore the iframe is never authoritative.** All `gd:*` messages are **untrusted UI
  hints**. The two load-bearing rules:
  - **The server validates every anchor** against the stored bytes before persisting a
    create/reattach; a forged `gd:select` only *opens a composer* that a human/principal must
    submit, and the parent (which holds the session/share credential) decides what to POST. A
    client "I resolved this" never persists state.
  - **No secrets reach the iframe.** The commenting view must not be loaded with `?share=` or any
    token in its URL or body (see the secretless-delivery fix in §2.4.1). The frame receives only
    public bytes + a per-view nonce.
  - `event.source === iframe.contentWindow` + a per-view nonce (or a `MessageChannel` port handed
    in at load) are **active-frame correlation + schema filtering** — they keep *other* frames/tabs
    out and reject malformed messages; they are **not** authentication against the same-realm
    author script (which can also post). That gap is exactly why the server stays sole authority.

#### 2.4.1 Serving path & secretless delivery

- Do **not** mutate `streamAsset` (it forwards raw R2 bytes with `content-length` from object
  size, `assets.ts:352-362`, and the same URL backs open/download). Add a distinct
  **commenting-view endpoint** that buffers the bytes, injects the runtime + per-view nonce, keeps
  `sandbox allow-scripts`, and owns its own ETag/content-length/cache-control — leaving
  raw/open/download byte-clean.
- **Secretless delivery for share-link views.** The current viewer authenticates the iframe via
  `?share=<token>` in the asset URL (`f.$folderId_.file.$filename.tsx`, `lib/api.ts:~501`). For
  commenting, the **parent** fetches the commenting-view bytes with the `x-glyphdown-share` header
  (the existing `SHARE_HEADER`, `auth.ts:20`) and hands them to the iframe via `srcdoc`/blob, so
  the token never enters a URL or the frame's reachable state.

### 2.5 One comment model, two anchor kinds

- **Document-level:** the existing `anchor:null` case — a `Comment` with no node anchor.
- **Node-level:** a `Comment` carrying a `NodeAnchor` (§3).

Most of `sidecar.ts` is **not** anchor-agnostic today: `buildComment`/`reattachComment`/
`revalidateAnchors` take a `Y.Text` and call `createAnchor`/`validateOrReanchor`
(`sidecar.ts:46,105,139`); `validateRange` is text-range-bound via `textLength`/`MIN_ANCHOR_CHARS`
(`sidecar.ts:34`), and `revalidateAnchors` also relies on `anchorsEqual` for change detection
(`sidecar.ts:111`). Only `buildReply` and `toggleReaction` are already pure. So §4.3 specifies a
real refactor that keeps the pure pieces shared and abstracts the anchor-touching pieces (build,
validate, reattach, **equality**) behind a strategy.

```
public filename URL ──resolveAssetRow──► assetId ──► HtmlDocDO(row.id)
                                                         ├─ comments table
                                                         ├─ node fingerprint index (cache)
                                                         └─ re-anchor on upload
commenting-view endpoint ──inject runtime──► sandboxed iframe ◄─untrusted postMessage─► parent UI
                                                                          REST + poll ─► HtmlDocDO
```

## 3. Stable node identifiers (`NodeAnchor`)

The HTML analogue of the text anchor — but **best-effort structural/fingerprint anchoring, not
CRDT identity**. It is a deterministic lookup over a re-parsed blob; it cannot "track live edits"
the way `Y.RelativePosition` does. The contract we keep from markdown is **graceful failure:
re-anchor or orphan, never silently land on the wrong node.**

```ts
type NodeAnchor = {
  schema: 1
  path: NodeStep[]          // canonical path from a stable ancestor (see grammar below)
  fingerprint: {            // identity of the target node
    tag: string
    id?: string
    classesRaw?: string[]   // as-authored (diagnostics / exact match)
    classesNorm?: string[]  // de-hashed + sorted — WEAK scoring evidence only (§8)
    role?: string; ariaLabel?: string; name?: string
    attrs?: Record<string,string>   // small allowlist: type, href(host+path), alt, data-*
  }
  quote?: { exact: string; prefix: string; suffix: string }  // normalized node text + context
  textRange?: { start: number; end: number; unit: 'utf16' }  // sub-range inside node text
  domHint: number           // document-order index at creation (search bias, like Anchor.hint)
  label: string             // human name, e.g. `button "Save"` (§8) — display only
  status: 'anchored' | 'orphaned'
  clientResolveOnly?: true  // node only exists after JS runs — display-only, server cannot verify
}
type NodeStep = { tag: string; nthOfType: number; id?: string; clsNorm?: string }
```

**Path grammar (canonical, deterministic):** from the nearest ancestor with an `id` (else the
body), each step is `tag` + `nth-of-type` index among same-tag siblings, optionally annotated
with `id`/normalized-class for scoring. `<html>`/`<head>` excluded; SVG/`<template>`/foreign
content and invalid-HTML recovery follow the chosen parser's tree (§3 parser). Construction and
matching share one pure function so they cannot diverge.

**Resolution (runtime in-iframe; identical core on the server):**

   All four steps run the **same scorer** (below); they differ only in the candidate set.
1. **Exact path** lands on exactly one node, and that node's `score` (below) clears
   `NODE_VALIDATE` → `anchored`. (`NODE_VALIDATE` replaces the vague "tag + ≥N of {…}"; `tag` must
   match and the remaining fingerprint fields contribute to the score, with `id` weighted high.)
2. **Fingerprint search** over the whole tree; score each candidate:
   `score = wTag·tagMatch + wId·idMatch + wRole·roleMatch + wQuote·similarity(quote.exact, text) +
   wPath·pathSuffixOverlap + wHint·hintProximity` (weights pinned as constants). Accept the best
   **only if** it clears `NODE_FUZZY_ACCEPT` *and* beats the runner-up by the **ambiguity margin**
   `Δ` (uniqueness guard). Re-mint `path`/`domHint` on success (degrade guard).
3. **Quote-only** fallback for prose nodes → the smallest enclosing element, **subject to the same
   guard**: the quote-only candidate must clear `NODE_FUZZY_ACCEPT` *and* beat the runner-up by `Δ`;
   equal/ambiguous quote matches **orphan** (never pick arbitrarily — that would violate the
   never-wrong-node invariant).
4. **Orphan** otherwise → `status:'orphaned'`, re-attachable.

**Thresholds** are node-specific constants (do **not** silently reuse the text constants
`REANCHOR_THRESHOLD=0.5`/fuzzy `0.8` from `core/src/quote.ts` without rationale): `NODE_VALIDATE`
(path+fingerprint agreement), `NODE_FUZZY_ACCEPT`, ambiguity margin `Δ`, and a **minimum-anchor
guard** (reject anchors with no id, no meaningful class/role, and <8 chars of text — push the
user to an ancestor or doc-level). Tie-breaks are deterministic (lowest document order).

**Worker-safe parser + parity contract.** There is no HTML parser dependency in `core`/`sync`
today (`core/package.json`, `sync/package.json`). Choose a **pure-JS, workerd-compatible**
parser (e.g. `parse5`/`htmlparser2`; `linkedom` if a DOM-ish API helps) and put the **normalized
node-index + scorer in `packages/core`** so the in-browser runtime and the `HtmlDocDO` use the
**same pure code** over the same normalized tree. Define normalization (whitespace collapsing,
entity decoding, script/style/hidden-node exclusion, text-extraction rules) and ship
**browser-vs-server parity fixtures** asserting identical resolution. **Dynamic-DOM policy:** the
server validates only statically-parsed nodes; anchors on script-created nodes are
`clientResolveOnly` — display-only, **never persisted from the client**, never server-guaranteed.

## 4. Data model & API

### 4.1 Protocol (`packages/protocol/src/index.ts`) — all net-new

Today `Comment.anchor` is `Anchor | null` and `Anchor` is text/Yjs-shaped
(`protocol/src/index.ts:47`, `core/src/anchor.ts:10`); `CreateCommentRequest` has only
`{body, range?}`. Add:

- `NodeAnchor`/`NodeStep` (above).
- A **discriminated anchor** on the comment. Recommended: `Comment.anchorKind: 'text'|'node'|null`
  with `Comment.textAnchor?: Anchor` and `Comment.nodeAnchor?: NodeAnchor` (purely additive — the
  markdown path keeps reading `anchor`/`textAnchor` untouched; a back-compat alias keeps existing
  clients working).
- `CreateAssetCommentRequest: { body, nodeAnchor?: NodeAnchor }` (omit for doc-level).
- A `schema` version field on `NodeAnchor` for forward migration.
- Asset comment WS/event message types (mirroring the doc `{t:'comment'|'comment-removed'}`).

### 4.2 Storage & routing

- `HtmlDocDO` (`comments`, `content_meta`, `node_index`), keyed by `row.id`.
- New asset-comment routes (§2.2) — explicit, not via `FORWARDABLE`. Worker resolves the asset
  row, computes the caller's effective role (§4.4), and forwards with the **existing** trusted
  headers — `HEADER_PRINCIPAL` (`X-Glyphdown-Principal`, the JSON-encoded principal) and
  `HEADER_ROLE` (`X-Glyphdown-Role`), set by `trustedHeaders` (`auth.ts:104-107`) — plus a new
  `X-Glyphdown-Asset` for the resolved asset id. (There is no separate `User`/`Agent` header; the
  principal carries identity + agent attribution.)
- **Wiring checklist (none of this exists today):** export `HtmlDocDO` from `@glyphdown/sync`;
  re-export in `apps/web/src/server.ts:17` (currently only `DocDO, SearchDO`); add the binding +
  a `new_sqlite_classes` migration tag in `wrangler.jsonc`; add the namespace to the app env
  types; thread it into `assets.ts` (today only `DB`/`ASSETS` reach that layer) so `uploadAsset`
  can call the DO; regenerate worker types.

### 4.3 Shared comment core (refactor, not a freebie)

Extract a `CommentStore` parameterized by an anchor strategy. Keep the already-pure pieces
(`buildReply`, `toggleReaction`) shared; abstract the anchor-touching ops:

```ts
interface AnchorStrategy<TAnchor, TContent> {
  buildFromInput(content: TContent, input): Validated<TAnchor | null>   // wraps createAnchor / NodeAnchor build
  validate(content: TContent, anchor: TAnchor): { anchor: TAnchor; resolved: boolean }
  reattach(content: TContent, input): Validated<TAnchor>
  equals(a: TAnchor, b: TAnchor): boolean   // each strategy owns change-detection (text = anchorsEqual)
  minimumOk(anchor: TAnchor): boolean
}
```

`equals` is what lets the shared revalidation loop decide "did this anchor change?" without
knowing the anchor shape — the text strategy supplies `anchorsEqual` (`sidecar.ts:111`), the node
strategy a structural compare.

`TextAnchorStrategy` wraps `validateRange`/`createAnchor`/`reattachComment`/`validateOrReanchor`
over `Y.Text`. `NodeAnchorStrategy` wraps the §3 core over parsed HTML. **Split comment
revalidation from suggestion revalidation** — today `revalidateAnchors` handles both and
auto-rejects orphaned suggestions (`sidecar.ts:139-171`); `HtmlDocDO` has no suggestions, so the
shared store must do comment-only revalidation with suggestion support parameterized out.

### 4.4 Authorization (net-new — assets have no ACL today)

- **Folder-scoped asset:** effective role = caller's role on the containing folder (or a folder
  share-link role). **Legacy doc-scoped asset:** role of the owning doc; when exposed via a
  folder fallback, the resolved containing-folder role.
- **Gate:** read = `viewer`; comment/reply/react/resolve = `commenter`+ (mirrors SPEC §4 doc
  comments); upload/restore = `editor`+.
- **Share links:** `share_links.target_type` is only `doc|folder` today (`schema.ts:255`). A
  **folder** share link carrying the `commenter` role authorizes comments on contained HTML
  assets — but **only for signed-in callers**: per SPEC §4, anonymous view-link visitors are
  read-only; comment-and-above requires sign-in for attribution. So an anonymous share visitor
  stays `viewer` even on a `commenter` link. **Independent per-asset share links are deferred**
  (require a `target_type='asset'` migration).
- **Write auth is net-new for assets.** Today the pre-auth folder-asset surface is **GET-only**
  (anonymous share reads); the new comment **write** routes must explicitly authorize a signed-in
  share-link caller (resolve the share token → principal → effective role ≥ `commenter`) before
  forwarding. This path does not exist yet.
- **Revocation:** if a `HtmlDocDO` WebSocket is ever added (§2.3), the recheck fanout
  (`router.ts:~533`) must be extended to asset DOs over folder asset rows + legacy fallback rows.
  REST+poll v1 sidesteps this.

### 4.5 Notifications & lifecycle

- The mention/reply hooks (`notifyMentions`/`notifyCommentReply`, `router.ts:~1511`) take a
  `DocRow` and emit `docId`/`docTitle`. Introduce a generic **`CommentTarget`** descriptor
  (`{kind:'doc'|'asset', id, label, deepLink, folderId?, filename?}`) and refactor both helpers
  around it so asset comments produce the same D1 notifications with correct deep links.
- **Asset lifecycle hooks:** on overwrite (`assets.ts:309`) call `HtmlDocDO` to re-parse + re-
  anchor; on delete (`assets.ts:365`) call it to tombstone/clean up (or accept orphaned DO state
  + lazy GC). Define abuse limits: anchor-JSON size, path depth, attr/class counts, body size,
  replies/thread, comments/asset (comment rows are stored whole in DO SQLite, `do.ts:794`).

## 5. UI / UX

### 5.1 Reframe sidebar reuse as extract + adapter

`CommentsSidebar` is **not** reusable verbatim: it imports the text `Anchor`/`Range`, takes
`resolveRange(anchor: Anchor)`, keys cache by `commentsKey(docId)`, builds pending comments from
Yjs relative positions, sorts by text range, and creates comments from `{range}`
(`CommentsSidebar.tsx:6,22,37,80,107`). Extract a **presentational thread-list shell** (author,
body, @mention render, reactions, replies, resolve, reattach affordance) and inject:

- a CRUD/cache **service** (doc vs asset),
- a **pending-anchor** model (text selection vs node pick),
- a **quote/label renderer** (text quote vs `NodeAnchor.label` + snippet),
- a **document-order sort key** — for nodes there is no `range.start`, so the in-iframe runtime
  (or the server's parsed index) supplies a stable order key,
- a **reattach** flow (text range vs node pick).

### 5.2 In-iframe interaction (untrusted)

- Commenting-view endpoint injects the runtime (§2.4). A "Comment" toggle turns on hover-outline
  + click-to-pick **inside** the frame; the runtime posts an *untrusted* candidate `NodeAnchor`,
  the parent shows the composer, and **the server validates** on submit.
- Existing comments render as markers **drawn by the runtime inside the frame** (the parent can't
  draw over it); the parent sends anchors, the runtime resolves + positions + reports failures
  (→ orphaned) and a document-order key per anchor.
- Text-region comments: the runtime captures `textRange`+quote for a phrase within a node.

### 5.3 Mobile

Reuse the bottom-sheet/selection-pill pattern from commit 6018e10, but it's embedded in
`DocEditorPage` today (`DocEditorPage.tsx:~179,1020`) — extract a shared sheet shell or duplicate
it for the HTML viewer. Touch = tap-to-pick + confirm pill; markers become tappable dots; the
sheet lists threads in document order as primary navigation.

### 5.4 CLI

`glyphdown comments <asset>` / `glyphdown comment <asset> …` accept an HTML asset ref (folder +
filename or URL). v1 CLI: **list / reply / resolve / doc-level create** (no DOM for node picking;
a `--selector`/`--text` node form that the server resolves against stored bytes can come later).
Update `program.ts`, `api.ts`, `README.md`, `docs/agent-guide.md` together (AGENTS.md mandate).

## 6. Edge cases

- **HTML edited so a node moves/changes** → server re-anchor on upload (§3); unique match kept
  (refreshed), else orphaned. With versioning (§7) this becomes diff-driven.
- **Node removed / overlapping / nested** → orphan (re-attachable); markers stack with offset;
  document-order from the runtime/server; overlapping picks show a disambiguation list.
- **Non-element text** → within-node `textRange`+quote; pure inter-element whitespace isn't
  commentable (force to the enclosing block). Cross-element ranges deferred.
- **Dynamic / JS-rendered HTML** → `clientResolveOnly` anchors are **display-only**, never
  server-validated, never persisted from the client (§3).
- **Permissions/share** → §4.4. Folder share links grant asset comments; per-asset links
  deferred.
- **Export / sync** → comments are DO sidecar, never written into the blob; raw/open/download
  stay byte-clean (§2.4). CLI push surfaces "N re-anchored, M orphaned" like the merge hunk
  report.
- **Asset replaced / delete+recreate** → same filename, new `row.id` ⇒ comments belong to the old
  id (don't carry over); detect a substantially-changed file via low re-anchor rate and banner.
  **No rename route exists**, so comments are bound to the immutable id; rename/move deferred.
- **Large HTML (≤10 MB, `MAX_ASSET_BYTES`)** → cap parsed bytes / node count / captured
  text+attrs; chunk the index across DO SQLite rows; skip indexing + fall back to client-only
  resolution with a clear flag when over budget.

## 7. HTML document versioning (history)

### 7.1 Storage (with the backfill fix)

- **"Overwrite-only" is imprecise:** today a same-name upload overwrites **in place only when
  `overwrite=true`** (preserving `row.id`, `assets.ts:309-319`); otherwise it **auto-suffixes** a
  new filename+id (`assets.ts:322`). Versioning replaces the in-place overwrite with
  append-version.
- **Bytes → R2, content-addressed in a global blob store** `asset-blobs/sha256/<hash>` (not
  `assets/{assetId}/v/<hash>`, which would defeat cross-asset dedup). A `content_objects(hash,
  size, refcount)` table refcounts blobs. **Mechanics:** inserting a version (incl. restore) for a
  hash **increments** its refcount (creating the row + uploading the blob only on 0→1); deleting a
  version, pruning, or an asset cascade **decrements** it; all in the **same D1 transaction** as
  the version-row change. GC deletes `asset-blobs/sha256/<hash>` only when refcount reaches 0
  (and never for a hash pinned by an open comment, §7.3).
- **Version records → D1 `asset_versions`** (works even before an `HtmlDocDO` exists):
  ```sql
  asset_versions(id, asset_id→assets.id ON DELETE CASCADE,
                 content_hash, size, etag, created_by, created_at, message NULL)
  -- assets.current_version_id → asset_versions.id  (NULLABLE for un-backfilled legacy rows)
  ```
- **`content_hash` is a server-computed SHA-256** (version identity); keep R2 `etag` for
  HTTP/cache/CLI change-detection (the CLI treats single-part etags as MD5, `assets.ts:314`,
  `cli/src/assets.ts`). Don't conflate the two.
- **Backfill safety (blocker fix):** on the **first** append-version of a legacy asset whose
  `current_version_id` is null, **copy the existing R2 bytes to the content-addressed `v1` key
  before** writing the new object (today overwrite clobbers the same `r2Key`, `assets.ts:310`).
  Legacy reads tolerate a null `current_version_id`.
- **Concurrent uploads:** insert-version + advance `current_version_id` in **one D1 transaction**;
  define stale-current (last-writer-wins for *current*, all versions retained).

### 7.2 API / CLI / Web

- API: list versions; stream a version (`?version=`/`/versions/:vid/raw`, same CSP rules);
  **restore** = copy old bytes to a new current version (**always a new audit row**, even if bytes
  are identical — dedup applies to *blobs*, not version rows); name a version (editor+). Nested
  version routes are net-new (asset handlers match `/assets/:filename` exactly today,
  `assets.ts:228,266`).
- CLI: `glyphdown push` auto-creates a version (blob dedup ⇒ no-op when unchanged);
  `history`/`cat --version`/`snapshot -m`.
- Web: a History panel (mirror `/d/:docId/history`); view a version read-only in the iframe; diff
  via (a) side-by-side rendered iframes + (b) raw-source text diff (reuse the markdown diff
  viewer); restore (editor+).

### 7.3 Comments synergy & pinning

- Each comment records the `versionId` it was authored against. New upload → **diff-driven
  re-anchor**: structurally diff prev↔new parsed trees to map old node→new node, falling back to
  §3 fingerprint search where ambiguous. **This depends on node anchors + `HtmlDocDO`**, so it is
  *not* an independent early deliverable (see rollout).
- **Pin** any version referenced by an open comment so retention/pruning can't delete the bytes a
  comment points back to ("originally on v{n} → view").

## 8. Useful ideas from agentation (adapted, not adopted)

agentation runs **in-page with full DOM access** and stores annotations in localStorage by URL —
a fundamentally more permissive model than our sandboxed, server-revalidated one. Port the ideas,
not the assumptions:

- **Human labels** (`identifyElement`): `button "Save"`, `h2 "Pricing"`, `icon in "Submit"
  button` → `NodeAnchor.label` + CLI output. Display only.
- **CSS-module hash stripping**: useful but **weak evidence** — it does *not* tame Tailwind churn
  and can collapse distinct nodes. Store both `classesRaw` and `classesNorm`; normalized classes
  are one scoring signal among many (§3), tested against collision-heavy fixtures.
- **Readable path** (`getElementPath`): basis for the path grammar, but we add `nth-of-type` and
  a **canonical** construction (agentation omits indexing since it holds a live element ref).
- **Nearby context** (`getNearbyText`/`getNearbyElements`): informs `quote.prefix/suffix`, but
  DOM text extraction ≠ markdown's linear string — define whitespace/hidden/script-exclusion
  rules before claiming parity.
- **Shadow DOM crossing**: runtime-only nicety; the server revalidator sees only static R2 bytes,
  so support shadow DOM only for static/declarative/open roots under the parser contract.
- **Browser/server canonicalization** must live in one pure `packages/core` module used by both
  the runtime and the DO (§3) — agentation's in-page helpers don't define cross-environment
  parity.
- **Not adopted:** x/y bounding boxes as *identity* (ephemeral render hint only), localStorage,
  computed-style forensics.

## 9. Migration / backfill

- **No comment data migration** — protocol additions are additive (§4.1); markdown comments
  untouched.
- **`HtmlDocDO` is more than a wrangler edit:** package export + `server.ts` re-export + wrangler
  binding + `new_sqlite_classes` migration tag + env typing + a forwarding helper + regenerated
  types (§4.2). Lazy creation on first comment → no asset backfill needed for comments.
- **Versioning migration:** add `asset_versions` + `content_objects` + nullable
  `assets.current_version_id` (D1/drizzle migration via `drizzle.config.ts`); seed `v1` lazily on
  first re-upload (with the copy-before-overwrite step, §7.1) **or** a one-shot job that copies
  each existing HTML asset's bytes to a content-addressed `v1` and sets the pointer. Additive.
- **Deferred migration:** `share_links.target_type='asset'` for per-asset share links (§4.4).
- Feature-flag the commenting view (the injected-runtime CSP change ships behind a flag).

## 10. Testing

Per SPEC §12 (fast-check property/fuzz over pure `packages/core`). Most suites are **post-
refactor** (the abstractions don't exist yet):

- **Node-anchor property tests with a model oracle:** generate an abstract DOM with stable model
  ids → render to HTML → apply model-aware edits (identity-preserving / ambiguity-producing /
  destructive) → assert the anchor resolves to the **expected model id or orphans, never the wrong
  node**. Define the three edit categories explicitly with expected outcomes/thresholds.
- **Parser/browser parity fixtures:** the in-browser resolution and the Worker-side resolution
  agree on the shared corpus (entities, whitespace, foreign content, recovery).
- **Class-normalization** collision tests (Tailwind/CSS-module churn).
- **Shared `CommentStore` parity:** same behavior under `TextAnchorStrategy` and
  `NodeAnchorStrategy` (build/reply/resolve/react/reattach); comment-only revalidation excludes
  suggestion logic.
- **Refactor regression (Phase A):** lock current markdown comment behavior — response
  bodies/statuses, ordering, `HEADER_COMMENT_AUTHOR` reply notify, broadcasts, role gates,
  reattach, post-rewrite revalidation (`do.ts:362-617`, `sidecar.ts`).
- **Versioning:** schema/migration tests first; then dedup (identical re-upload ⇒ no new blob,
  but restore ⇒ new version row), copy-before-overwrite backfill, cascade on delete, concurrent-
  upload transaction, version pinning vs pruning.
- **Diff-driven re-anchor invariant** = "never wrong-node" (the v1 "never worse than fingerprint"
  is too strong — heuristics regress on duplicate subtrees / reordered lists); measure orphan-rate
  improvement on a corpus, don't assert monotonicity.
- **Integration:** route/auth matrix (viewer/commenter/editor × folder/legacy-doc/share-token);
  opaque-origin postMessage (forged-message rejection, source/nonce checks); byte-clean
  raw/open/download; asset delete/recreate lifecycle; CLI/API compatibility.
- Gate: `pnpm -r typecheck && pnpm -r test && pnpm --filter web build`.

## 11. Rollout (re-sequenced)

1. **Phase A — shared comment-core refactor.** Extract `CommentStore`/`AnchorStrategy`; **treat
   as risky** (markdown behavior is spread across DO routing, permissions, ordering, reply-notify
   headers, broadcasts, sidecar). Gate on the regression suite (§10) — *not* assumed zero-change.
2. **Phase B — asset identity + `HtmlDocDO` + auth + doc-level comments.** Shared asset resolver,
   new routes, authorization model, REST+poll transport, `CommentTarget` notifications. **Doc-
   level only** (no anchors to re-anchor yet).
3. **Phase C — `NodeAnchor` core + parser/canonicalization** in `packages/core` (+ model-oracle
   property suite + parity fixtures). No UI.
4. **Phase D — injected runtime + security model + UI adapters.** Commenting-view endpoint,
   untrusted postMessage protocol, in-iframe markers/picker, extracted sidebar shell. Node-level
   comments on (server-validated).
5. **Phase E — versioning workstream.** Storage/migration, append-version + copy-before-overwrite,
   versioned streaming, history panel, restore. (History can land any time after Phase B.)
6. **Phase F — diff-driven re-anchor.** Depends on C + E (node anchors + retained versions +
   comment version provenance).
7. **Phase G — mobile.** 8. **Phase H — CLI.** 9. **Phase I — hardening:** per-asset share links,
   abuse limits, revocation fanout (if a DO socket lands), "file changed substantially" banner,
   then unflag.

## 12. Risks & open questions

- **Injected-runtime trust boundary (BLOCKING).** Runtime shares the iframe realm with user HTML,
  so messages are forgeable and opaque-origin defeats origin checks. **Product decision (§2.4):
  keep author scripts** — we do *not* lock down the frame — and rely entirely on a zero-trust
  message boundary. The two requirements that carry all the security weight: (1) the **server is
  sole authority** (validates every anchor against stored bytes; the iframe never persists state),
  and (2) **no secret ever reaches the frame** (secretless `srcdoc`/blob delivery, share token via
  the `x-glyphdown-share` header, §2.4.1). Residual accepted risk: an author can only distort their
  *own* document's comment overlay — not a cross-tenant escalation. Still needs a security review of
  the delivery path and the message schema.
- **Asset live routing/auth (MAJOR).** `/parties/*` is docId-keyed and revocation fanout is doc-
  only; a `HtmlDocDO` socket needs a new namespace + asset-aware auth + asset revocation fanout.
  Mitigated by REST+poll v1.
- **R2/D1/DO consistency (MAJOR).** Upload writes R2 then D1; a post-write DO hook can leave the
  DO stale. Make reconciliation idempotent; DO compares cached `etag`/`content_hash` on read/write
  and self-heals.
- **Worker-side HTML parsing & parity (MAJOR).** No parser today; browser DOM vs server parser can
  differ on recovery/whitespace/namespaces, and JS-rendered nodes are server-invisible. Mitigation
  = pinned pure parser + shared core + parity fixtures + `clientResolveOnly` policy.
- **Large-HTML indexing limits (MAJOR).** Parsing/indexing up to 10 MB in a DO can blow CPU/
  memory/row limits. Mitigation = caps + chunked index + skip/fallback (§6).
- **Anchor stability on churny HTML** (regenerated dashboards, hashed classes). Composite anchors
  + dedup + orphan-not-misanchor; expect a real orphan rate — tune thresholds on a corpus.
- **Per-asset DO vs promote-HTML-to-first-class-doc.** Per-asset DO ships faster. First-class docs
  reuse *some* ACL surface but **not for free**: share links target only doc/folder, and markdown
  history stores Y.Text + state vectors, **not** R2 HTML bytes — HTML history still needs §7.
  Recommend per-asset DO now; revisit before GA.
- **Open questions:** canonical Worker-safe parser choice; HTML diff UX (rendered vs source vs
  semantic); retention thresholds + version pinning policy; whether comments should ever follow a
  future asset rename/move. *(The keep-author-scripts vs strict-CSP question is decided — §2.4 keeps
  scripts and hardens the message boundary.)*

---

### Key file references (verified against the working tree)

- Asset backend: `apps/web/src/api/assets.ts` — `resolveAssetRow`:123, `uploadAsset`/overwrite:309-319,
  `streamAsset`:341-362, `deleteAsset`:365-376, scopes/keys:40-64; `apps/web/src/db/schema.ts` (`assets`,
  `share_links`)
- Worker routing/auth: `apps/web/src/server.ts` (party routing:43-48, DO exports:17),
  `apps/web/src/api/router.ts` (`FORWARDABLE`:53, folder assets, recheck fanout, `notifyMentions`/`notifyCommentReply`)
- Comment core: `packages/sync/src/sidecar.ts` (`buildComment`:46, `validateRange`:34, `reattachComment`:105,
  `revalidateAnchors`:139), `packages/sync/src/do.ts` (comments table:177, routes:362-617, persistence:783-799)
- Anchors: `packages/core/src/anchor.ts`, `packages/core/src/quote.ts`
- Protocol: `packages/protocol/src/index.ts` (`Comment`/`Anchor`:35-130, `AssetMeta`:395-431)
- HTML viewer: `apps/web/src/routes/f.$folderId_.file.$filename.tsx` (iframe:121-126)
- Sidebar / mobile: `apps/web/src/components/editor/CommentsSidebar.tsx`,
  `apps/web/src/components/editor/DocEditorPage.tsx`, `packages/editor/src/annotations.ts`
- CLI: `packages/cli/src/program.ts`, `packages/cli/src/api.ts`, `packages/cli/src/assets.ts`
- DO wiring: `apps/web/wrangler.jsonc`; validation companion: `docs/plans/html-comments-validation.md`
