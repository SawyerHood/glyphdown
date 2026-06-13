# Glyphdown — Product & Architecture Spec

> Status: v1 — interview decisions are final and all technology choices are research-verified (see `docs/research.md` for the findings digest; §14 for the pinned stack).

Glyphdown is Google Docs for markdown files: real-time multiplayer editing, range-anchored comments, suggestion mode, edit history, and a CLI designed for AI agents to collaborate on documents as first-class participants.

## 1. Core principles

1. **The markdown file is the document.** The canonical form of every document is plain markdown text, collaboratively edited through a Y.Text CRDT. There is no rich-text tree of record; anything the editor renders is a view over the text. `glyphdown pull` gives you the real document, byte-for-byte.
2. **Agents are collaborators, not integrations.** AI agents (Claude Code, etc.) connect with their own identity, edit documents through the same CRDT as humans, and their comments/suggestions/edits are attributed to them ("Claude · run by kirby").
3. **Degrade gracefully, never destroy.** Concurrent edits merge through the CRDT; comments that lose their anchor become "orphaned" rather than vanishing; large CLI rewrites are guarded, not silently applied.

## 2. Product decisions (from owner interview, June 2026)

| Decision | Choice |
|---|---|
| Audience | Public product eventually; v1 = personal docs, link sharing, invites. **No teams** — *vaults* (Obsidian-style root namespaces; every doc lives in exactly one, a whole vault is shareable at a role) are the workspace-shaped primitive (June 2026). |
| Source of truth | Plain markdown text in Y.Text |
| Editor | Obsidian-style **live preview** on CodeMirror 6 (not Milkdown/ProseMirror). True-WYSIWYG view possible later as an additive second editor. |
| Suggestions | **Sidecar** anchored range-edits (not CriticMarkup in-file). Any editor can accept/reject. |
| Comments | Sidecar, anchored with Yjs relative positions + text-quote fallback re-anchoring. Threads, @mentions, emoji reactions, doc-level comments, resolve. |
| History | Auto-snapshots + named versions; view, diff vs current, restore. Full keystroke timeline not required. |
| Multiplayer | Multiple simultaneous editors/cursors. "Multi edits" means nothing beyond this. |
| Offline | Tolerate connection blips only (buffer + resync). No long-offline local-first. |
| Permissions | Full role set on links and invites: **view / comment / suggest / edit** (+ owner). |
| Auth | GitHub + Google OAuth, self-managed (better-auth ⏳). |
| Doc organization | Folders/collections with shared permissions; share a folder with a person or agent. |
| Agent surface | **CLI only** (`glyphdown`). Agents shell out to it. No MCP server in v1. |
| Agent flow | `glyphdown pull` → edit local file with normal tools → `glyphdown push`; server merges the diff through the CRDT. |
| Agent writes | **Direct edits by default**; `--suggest` makes a push land as a suggestion set. |
| Agent identity | Distinct identities with minted API keys; v1 access = inherits owner's access, distinct attribution. |
| Notifications | In-app only (bell/inbox). Email later. |
| Name | **Glyphdown** at glyphdown.com (renamed Inkwell → Inkroom → Glyphdown; infra ids pinned to `inkwell` — worker/D1/R2 names — keep the original string, see `apps/web/wrangler.jsonc`); CLI binary `glyphdown` (previously `ink`). |
| Testing | Heavy property/fuzz tests on core logic (merge, anchoring, suggestion transforms, snapshot/restore). E2E suites optional/later. |

## 3. System architecture

```
┌────────────┐   HTTPS (SSR, REST)   ┌─────────────────────────────┐
│  Browser    │◄─────────────────────►│  Cloudflare Worker          │
│  TanStack   │   WebSocket (Yjs)     │  ├─ TanStack Start app      │
│  Start UI   │◄──────────┐           │  ├─ REST API (/api/*)       │
│  CodeMirror │           └──────────►│  ├─ better-auth (D1)        │
└────────────┘                        │  └─ routes WS → DocDO       │
┌────────────┐   HTTPS (REST)         │                             │
│  glyphdown  │◄─────────────────────►│  ┌──────────────────────┐   │
│  CLI/agents │                       │  │ DocDO (per document) │   │
└────────────┘                        │  │  Y.Doc + persistence │   │
                                      │  │  comments/suggestions│   │
        ┌───────┐                     │  │  snapshots/versions  │   │
        │  D1   │◄────────────────────┤  └──────────────────────┘   │
        └───────┘  users/docs/ACLs    └─────────────────────────────┘
```

- **One Worker** hosts the TanStack Start app, the REST API, and routes WebSocket upgrades to the per-document Durable Object. Verified pattern: custom `src/server.ts` with `createServerEntry` that re-exports the DO class; WS upgrades flow through a Start server route that validates auth then `stub.fetch(request)` (dotnize/tanstack-websockets-cloudflare is the reference). Fallback if a Start release breaks upgrade passthrough: match the WS path in `server.ts` before delegating to the Start handler.
- **DocDO** (one Durable Object per document, SQLite-backed via `new_sqlite_classes`) extends y-partyserver's `YServer` with `static options = { hibernate: true }`. It owns the Y.Doc, the update-log persistence, and sidecar tables for comments, suggestions, and version snapshots.
- **D1** holds cross-document relational data only: users, auth, folders, docs metadata, memberships, share links, agents, notifications. Comment/suggestion bodies live in the DocDO (keeps D1 small and the data next to its anchors).

### 3.1 Document model

- **Docs are files — the FILENAME is the canonical name.** Every doc has a `filename`: a slug ending in `.md` (charset `[a-z0-9-]`, e.g. `the-garden.md`), unique among live docs in its scope (its folder, or the owner's root when folderless; collisions on create auto-suffix `-2`, `-3`, …; renames and moves 409 `filename-taken`). The web UI displays the filename **stem** everywhere (no `.md` — Obsidian-style) and rename inputs live-slug as you type; the CLI uses the filename verbatim as the local file name, so the same doc has the same name on every machine (`clone(sync(x)) == x`). `DocMeta.title` stays in the API payload but is now *derived* — always the filename stem. The `# H1` heading inside the markdown is just content and is never read for naming. Wiki links (`[[name]]`) resolve against filename stems via slug normalization, so legacy `[[Title With Spaces]]` links keep resolving. Rename a tracked file with `glyphdown mv <file> <new-name>` (renames locally AND on the server); renaming by hand makes a duplicate doc (sync warns loudly).
- Inside the Y.Doc: a single `Y.Text` named `content` — the markdown document. Nothing else lives in the CRDT.
- Comments and suggestions are **sidecar records in DocDO SQLite**, anchored to `content` via the composite anchors of §6.1. They are *not* Y types: role enforcement stays trivial (commenters never write the CRDT), and doc compaction can't corrupt them. Changes broadcast to connected clients as JSON messages over the same WebSocket.
- Markdown export reads only `content` (see §6 for how pending suggestions interact with export).

### 3.2 Sync protocol

- WebSocket at `GET /api/doc/:docId/ws`: standard Yjs sync + awareness (binary frames) plus JSON control messages (comments/suggestions/version events).
- **Clients must use y-partyserver's `YProvider`** (browser and any future CLI watch mode): it is the only stock client that suppresses the y-protocols awareness 15-second heartbeat, which otherwise wakes the hibernating DO continuously and erases the cost savings.
- Auth on upgrade: session cookie (browser) or `Authorization: Bearer <api key>` (CLI). The Worker validates identity + role (per-request better-auth instance + D1 ACL check), then forwards to the DO with trusted headers (`X-Glyphdown-User`, `X-Glyphdown-Role`, `X-Glyphdown-Agent`).
- Role enforcement server-side in the DO: viewers/commenters get `content` writes rejected; suggesters' writes must be consistent with suggestion semantics (§6.4).
- Awareness payload: `{ name, color, isAgent, userId }` → remote cursors + presence avatars. Ghost-cursor mitigation: client nulls awareness state on `visibilitychange`/`beforeunload`; server clears state in `onClose`/`onError`.

### 3.3 Persistence (DocDO SQLite)

- **Every incoming Yjs update is written as its own row** in the DO's `update` handler (y-durableobjects' YTransactionStorage design). Do not rely on y-partyserver's debounced `onSave` (can lose ~10 s of edits on eviction).
- Compaction at ~500 rows or ~1 MB: replay the update log into a fresh Y.Doc and re-encode with `encodeStateAsUpdate`, **never rebuild from plain text** — replay preserves CRDT item identity (and therefore every stored anchor); a text rebuild nulls all anchors at once. Chunk the compacted blob across rows near the 2 MB row cap; spill to R2 above ~1.5 MB.
- `onLoad()`: apply compacted state + pending update rows.
- Cache: latest serialized markdown + state vector stored on each compaction for fast REST reads.
- Yjs gc stays **on** (y-partyserver hardcodes it); history and attribution are built on markdown snapshots + the retained update log (§7), never on `Y.Snapshot`/`PermanentUserData`.
- Limits v1: document ≤ 2 MB markdown; ≤ 50 concurrent connections per doc; rate limits in §8.3.

## 4. Permissions

Roles, strictly increasing: `viewer < commenter < suggester < editor < owner`.

| Capability | viewer | commenter | suggester | editor | owner |
|---|---|---|---|---|---|
| Read doc + comments + suggestions | ✅ | ✅ | ✅ | ✅ | ✅ |
| Create/reply/react/resolve comments | | ✅ | ✅ | ✅ | ✅ |
| Create suggestions (incl. `glyphdown push --suggest`) | | | ✅ | ✅ | ✅ |
| Withdraw **own** open suggestion | | | ✅ | ✅ | ✅ |
| Direct edits to content | | | | ✅ | ✅ |
| Accept/reject any suggestion | | | | ✅ | ✅ |
| Create named versions, restore versions | | | | ✅ | ✅ |
| Manage sharing (links, invites), rename, delete doc | | | | | ✅ |

- **Grants**: a user's effective role on a doc = max(direct doc membership, containing-folder membership, share-link role if accessed via link). Owner = creator (transfer later).
- **Share links**: tokenized URLs carrying a role (`view`/`comment`/`suggest`/`edit`); revocable; anonymous visitors via view links get read-only without an account; comment-and-above requires sign-in (attribution).
- **Folders**: docs belong to ≤ 1 folder. Folder membership grants the same role on all contained docs. Sharing a folder with an agent = granting its owner's agent identity membership.
- **Agents (v1)**: an agent inherits its owner's access to everything; its actions are attributed to the agent identity. A reserved `scope` field (`inherit` for v1) allows narrowing later.

## 5. The editor (web)

CodeMirror 6 over `@codemirror/lang-markdown` (GFM `markdownLanguage` + `codeLanguages` from `@codemirror/language-data` for free fenced-code highlighting; `yamlFrontmatter` from `@codemirror/lang-yaml`), bound to Y.Text via `y-codemirror.next` 0.3.5 (`yCollab` with `Y.UndoManager` + `yUndoManagerKeymap`; **never** include CM's own `history()`), with an in-house Obsidian-style live-preview extension modeled on SilverBullet's MIT `client/codemirror/` plugins (decorator StateField + cursor-in-range reveal + `Decoration.replace`/`widget`):

- **Hide-syntax-at-cursor**: decorations from the Lezer syntax tree render formatting (bold/italic/strikethrough/inline code) and hide delimiter characters except where the selection intersects the node (or its line, for block syntax).
- **Block rendering**: styled headings, bullet/ordered/task lists (clickable checkboxes), blockquotes, horizontal rules, fenced code blocks with syntax highlighting, link "chips" (click opens, cursor-enter reveals syntax), images rendered inline as block widgets.
- **v1 punts**: tables render as styled monospace text (full table widget later); no LaTeX; no embeds.
- **Multiplayer**: remote selections/cursors with name flags (awareness); local undo isolated per user (Yjs UndoManager scoped to local origin).
- **Modes**: Edit ↔ Suggest toggle (suggesters are locked to Suggest); a raw source-mode toggle (plain markdown, no preview) as a cheap escape hatch.
- **Comments UI**: highlighted ranges + margin indicators; sidebar with threads (range-anchored and doc-level), reply box, emoji reactions, resolve/reopen, orphaned section; @mention autocomplete over doc members.
- **Suggestions UI**: inserted-text in green, deletions struck-through red, per-suggestion popover (author, note, Accept / Reject) and a sidebar list with Accept all / Reject all.

## 6. Comments & suggestions

### 6.1 Anchors

```ts
type Anchor = {
  start: RelPos        // serialized Y.RelativePosition into content (assoc: right)
  end: RelPos          // (assoc: left — boundary insertions fall outside the range)
  quote: { exact: string; prefix: string; suffix: string }  // 32-char context, W3C TextQuoteSelector-style
  hint: number         // last known start offset (TextPositionSelector-style search bias)
  status: 'anchored' | 'orphaned'
}
```

Implemented in `@glyphdown/core` (`anchor.ts`, `quote.ts`) with these verified rules:

- Relative positions track ranges exactly through live CRDT editing; resolution always passes `followUndoneDeletions=false` so server and all clients agree (yjs#638).
- After any out-of-band rewrite (CLI push merge), the DO re-validates every anchor: kept if positions resolve and the range still matches `quote.exact` at similarity ≥ 0.5; else **re-anchored** by quote search (exact `indexOf` candidates scored by prefix/suffix context and hint distance, then fuzzy bitap fallback accepted only at similarity ≥ 0.8 — markdown is self-similar and a wrong re-anchor is worse than an orphan); else marked `orphaned`.
- Every successful re-anchor **re-mints positions and refreshes the quote + hint** so fuzzy quality doesn't degrade over time (Hypothesis behavior).
- Comment UI rejects selections shorter than 8 characters of anchor text (too ambiguous to ever re-anchor).
- Orphaned comments stay in the sidebar under "Orphaned", showing their quote; users can re-attach manually (select a new range) or resolve. Orphaned suggestions are auto-rejected with a system note.

### 6.2 Comments

```ts
type Comment = {
  id: string
  anchor: Anchor | null          // null = doc-level comment
  authorId: string               // user or agent id
  body: string                   // markdown; @mentions as @[userId]
  createdAt: number
  resolved: boolean
  reactions: Record<emoji, principalId[]>
  replies: Reply[]               // { id, authorId, body, createdAt, reactions }
}
```

Stored in the `comments` Y.Map. Mentions trigger a DO → Worker event that writes a D1 notification.

### 6.3 Suggestions

A suggestion is a set of pending text changes by one author, reviewed as a unit:

```ts
type Suggestion = {
  id: string
  authorId: string
  createdAt: number
  status: 'open' | 'accepted' | 'rejected' | 'withdrawn'
  note?: string
  parts: SuggestionPart[]
}
type SuggestionPart =
  | { kind: 'insert', anchor: Anchor }   // anchor spans the inserted text (already present in content)
  | { kind: 'delete', anchor: Anchor }   // anchor spans text proposed for deletion (still present in content)
```

**Representation choice (important):** suggested **insertions are physically present** in `content`, tracked by their anchor; suggested **deletions remain present**, marked by their anchor. This keeps editing natural (you type your suggestion as real text) and concurrent merging sound. Consequences:

- The editor renders insert-ranges green and delete-ranges struck-through.
- **Accept** insert → just close the record. **Reject** insert → delete the anchored range. **Accept** delete → delete the anchored range. **Reject** delete → close the record. All transforms are single Y.Text transactions, valid even if the doc drifted (anchors track).
- **Drift guard on accept** (GitHub "outdated" policy, implemented in core): before applying a delete part, the current anchored text is verified against the part's captured quote at similarity ≥ 0.8; mismatched parts are skipped and reported as *outdated* instead of splicing changed text. Accept runs inside the DO so verification and application share one transaction.
- **Export views**: `working` (default — text as-is, includes pending insertions and not-yet-deleted text) and `clean` (pending insert ranges stripped — "reject all" view). `glyphdown pull` defaults to `working`; `--clean` available. Doc rendering for viewers uses `working` with suggestion styling.

### 6.4 Suggest mode mechanics

In suggest mode the editor wraps every local transaction: typed text becomes/extends an open `insert` part by the same author at that position; deletions don't delete — they create/extend a `delete` part over the range (selection-delete included). Consecutive edits within 30s and ≤ 1 paragraph apart coalesce into one suggestion. The DO enforces that a `suggester`-role connection only produces content changes consistent with suggestion semantics (insertions must be covered by that author's open insert-anchors; no uncovered deletions).

## 7. Edit history

- **Auto-snapshots**: the DO snapshots (markdown text + state vector + active-author set) when ≥ 500 updates or 10 min of activity since the last one, and when the last client disconnects.
- **Named versions**: editors can "Name this version" (stores a snapshot with a label) — also exposed as `glyphdown snapshot -m "msg"` for agents.
- **UI**: version list (auto + named), view any version read-only, side-by-side text diff vs current, **Restore** (replaces content in one transaction — restoring is itself an edit, so history is never lost).
- Snapshots live in DO SQLite; markdown bodies > 100 KB or versions older than 90 days spill to R2 ⏳.

## 8. Agents & the `glyphdown` CLI

### 8.1 Identity & auth

- Users mint agents in Settings → Agents: name ("Claude Code"), generates `gd_sk_…` API key (hash stored; pre-rename `ink_sk_…` keys remain valid). Attribution everywhere: cursor flags, suggestion/comment bylines, history authors ("Claude Code · run by kirby").
- `glyphdown login` (interactive): **better-auth Device Authorization flow (RFC 8628)** — works headless where localhost-callback OAuth fails; stores a user token (OS credential store when available, chmod-600 file fallback; no keytar — archived). Actions attribute to the human.
- `GLYPHDOWN_API_KEY` env or `glyphdown login --key` — actions attribute to the agent. This is the path agents use. The pre-rename `INKROOM_*` (and older `INKWELL_*`) `API_KEY` / `SERVER` / `CONFIG_DIR` variables are honored as silent fallbacks, and `~/.config/inkroom/config.json` (else `~/.config/inkwell/config.json`) is auto-migrated to `~/.config/glyphdown/` on first run.
- Distribution: scoped npm package (`@glyphdown/cli`, bin `ink` — the bare npm name `ink` is taken) runnable via `npx`, plus `bun build --compile` cross-compiled binaries on GitHub releases. No native addons.

### 8.2 Commands

```
glyphdown list [folder]               # docs you can access
glyphdown vaults                      # vaults you own or that are shared with you (name, id, role)
glyphdown cat <doc>                   # print markdown (working view) to stdout
glyphdown clone [dir] [--vault v]     # mirror your account — or one vault (name|id) — into a workspace
glyphdown sync [dir]                  # two-way mirror sync of a cloned/pulled workspace
glyphdown pull <doc> [path]           # write doc.md + record base in .glyphdown/<docId>/
glyphdown pull --folder <ref> [dir]   # pull a whole folder; <ref> is an id or name — vault refs work too
glyphdown push [path] [--suggest] [--force] [-m note]
glyphdown new <name> [--folder f | --vault v]  # create doc named <slug-of-name>.md; neither flag → your default vault
glyphdown mv <file> <new-name>        # rename a tracked doc: local file AND server filename, atomically
glyphdown rm <file> [--force]         # delete a tracked doc on the server; archive local file and remove tracking
glyphdown comments <doc>              # list open threads (text quotes + ids)
glyphdown comment <doc> --reply <threadId> --body "..."   # reply; --resolve to resolve
glyphdown comment <doc> --line N --body "..."             # new anchored comment
glyphdown suggestions <doc>           # list open suggestions
glyphdown snapshot <doc> -m "msg"     # named version
```

`<doc>` accepts a doc id, URL, or unique title prefix.

Vault refs (`--vault`) resolve by id or case-insensitive name via `GET
/api/vaults` (vault names are unique per owner; an owned/shared-name collision
errors listing the candidate ids). `glyphdown clone --vault` writes the
workspace root's `.glyphdown/folder.json` pointing at the vault's folder id —
the exact layout `pull --folder` produces — so `glyphdown sync` confines
itself to the vault's subtree with no extra workspace state.

### 8.3 Push merge algorithm (server-side, in the DO)

Implemented in `@glyphdown/core` (`merge.ts`, `mergePush`) on `@sanity/diff-match-patch` (the maintained, surrogate-safe fork; google/diff-match-patch is archived) — the same shape Obsidian Sync, Relay, and Automerge `updateText` use in production.

1. `glyphdown pull` writes `doc.md` plus `.glyphdown/<docId>/meta.json` `{docId, serverVersionId, baseHash}` and `.glyphdown/<docId>/base.md` (an existing pre-rename `.ink/` bookkeeping dir is detected and kept — never migrated). The server also caches the pulled base content-addressed by hash (TTL-evicted) — never reconstructed from Yjs state vectors (that would require gc:false and unbounded doc growth).
2. `glyphdown push` sends `{ docId, newText, baseHash }`; if the server's base cache misses, the CLI re-sends `base.md` from disk. All text normalized to `\n` line endings at every boundary (CRLF corrupts position bookkeeping).
3. Fast path: if `currentText == baseText`, apply `diff(baseText, newText)` (with semantic cleanup) directly as Y.Text ops in one transaction (origin = pushing identity).
4. Merge path: `makePatches(diff)` → `applyPatches` fuzzy-matched against the **current** text → land the minimal `diff(current, mergedResult)` as Y.Text ops. The per-patch result flags are checked; failed hunks are returned to the CLI verbatim (like git `.rej`), exit code 2 — never silently dropped.
5. **Degenerate-diff guard**: if the doc drifted from base AND the diff deletes > 60% of the base, refuse with exit code 3 ("doc has concurrent edits and your change rewrites most of it — re-pull or --force"). Character-level (not line-level) diffing is part of the anchoring contract: it preserves unchanged runs and therefore the anchors inside them.
6. `--suggest`: instead of direct ops, materialize the diff as one Suggestion (`materializeSuggestion` in core: insert parts physically inserted + anchored; delete parts anchored, text retained).
7. After any merge: re-validate all comment/suggestion anchors (§6.1) in the same DO execution.
8. Everything (read current → diff → apply) happens inside one DO transaction — never in a stateless Worker against a fetched copy.
9. Rate limit: 60 pushes/min per identity.

## 9. Web app

- **Routes**: `/` dashboard (folders + docs, recent activity), `/d/:docId` editor (share dialog, comments sidebar, suggestion list, presence), `/d/:docId/history`, `/settings` (profile, Agents/API keys), `/login`.
- **Stack**: TanStack Start (React 19) on the Worker. Start is production-grade but still **RC** — pin `@tanstack/react-start`, `@cloudflare/vite-plugin`, and `wrangler`, and treat upgrades as deliberate events. Bindings via `import { env } from 'cloudflare:workers'` (works in dev because the Vite plugin runs the app in workerd); types from `wrangler types`. Server functions for CRUD against D1 (drizzle); the editor talks WS directly to the DO.
- **Auth**: better-auth 1.6.x with the drizzle-d1 adapter and TanStack Start cookie plugin. **One auth instance per request** (a module singleton silently breaks on Workers — D1 bindings are per-invocation); pass `waitUntil`; leave `cookieCache` off.
- **Notifications**: bell + inbox backed by D1 `notifications`; created on @mention, share-invite, suggestion-on-your-doc, comment-reply; polled via TanStack Query on focus/interval (a per-user notification DO only if latency ever matters; no SSE from DOs — defeats hibernation billing).

## 10. D1 schema (sketch)

```sql
users(id, email, name, avatar_url, username, created_at)
-- + better-auth tables (sessions, accounts, verification)
agents(id, owner_user_id, name, key_hash, scope DEFAULT 'inherit', created_at, revoked_at)
folders(id, owner_user_id, name, created_at)
docs(id, title, filename, folder_id NULL, owner_user_id, created_at, updated_at, deleted_at NULL)
--   filename: canonical slug name '<slug>.md' — unique among live docs per scope
--   (partial unique indexes: (folder_id, filename) and root (owner_user_id, filename));
--   title is legacy/derived (the filename stem) — kept for cheap back-compat only
doc_members(doc_id, principal_id, principal_type 'user'|'agent', role, added_by, created_at)
folder_members(folder_id, principal_id, principal_type, role, created_at)
share_links(token, target_type 'doc'|'folder', target_id, role, created_by, created_at, revoked_at NULL)
notifications(id, user_id, type, payload_json, created_at, read_at NULL)
```

Doc content, comments, suggestions, versions: in each doc's DO, not D1.

## 11. Edge cases & failure modes

- **WS drop / blip**: client buffers local updates (Yjs), reconnects with backoff, resyncs via state vectors. Banner after 10 s offline; hard-reload prompt after 5 min.
- **Push onto heavily-drifted doc**: fuzzy patches partially apply → CLI prints applied/failed hunks; failed hunks exit code 2.
- **Anchor loss**: comments orphan (visible, re-attachable); suggestions auto-reject with system note.
- **Two editors accept the same suggestion concurrently**: accept transform is idempotent (status flip via Y.Map last-writer-wins; text op guarded by anchor still resolving).
- **Suggester disconnects mid-suggestion**: open suggestion remains; coalescing window simply ends.
- **Doc deleted while clients connected**: DO broadcasts close event; soft-delete with 30-day trash.
- **Oversize doc**: pushes/edits beyond 2 MB rejected with clear error.
- **Revoked key/membership**: Worker re-validates on every upgrade + REST call; DO drops connections on a revocation event.

## 12. Testing requirements (mandated)

Property/fuzz tests (fast-check + vitest) over the pure core in `packages/core`:

1. **Push merge**: random base doc, random concurrent CRDT edits, random local file edits → push merge preserves both intents when disjoint; never throws; degenerate guard fires when (and only when) thresholds met.
2. **Anchoring**: random anchored ranges + random edit storms → anchors either track exactly (live edits) or re-anchor/orphan correctly (out-of-band rewrites); no silent drift onto wrong text.
3. **Suggestion transforms**: random suggestion sets + doc drift → accept/reject produce exactly the expected text in all orderings; idempotent under concurrent acceptance.
4. **Snapshot/restore**: snapshot → edits → restore yields snapshot text exactly; history monotonicity.
5. **Export views**: `working`/`clean` views consistent with open suggestion parts under random suggestion states.

## 13. Build order

1. **M1 Sync + editor core**: scaffold; DocDO with Yjs sync + persistence; CodeMirror live-preview editor; two browsers editing one doc.
2. **M2 Auth + docs CRUD**: better-auth (GitHub/Google), dashboard, folders, share links, roles enforced.
3. **M3 Comments**: anchors, threads, sidebar, reactions, resolve, orphaning, mentions + notifications.
4. **M4 Suggestions**: suggest mode, rendering, accept/reject, role enforcement.
5. **M5 History**: snapshots, versions UI, restore.
6. **M6 CLI**: `glyphdown` (previously `ink`) with pull/push merge (+ `--suggest`), agents/API keys, comments commands.
7. **M7 Hardening + deploy**: test suite complete, limits, prod deploy, smoke tests.

## 14. Pinned stack (research-verified, June 2026)

| Layer | Choice | Note |
|---|---|---|
| CRDT | `yjs` ^13.6.31 | **Single version enforced via pnpm overrides** — duplicate yjs or `@codemirror/state`/`view` instances silently break sync entirely. v14 (attributions) tracked but not adopted. |
| Editor binding | `y-codemirror.next` 0.3.5 (pinned) | Stable line targets yjs 13; main branch is the unstable v14 rewrite. |
| Editor | `@codemirror/lang-markdown` 6.5+, `@codemirror/language-data`, `@codemirror/lang-yaml` | CodeMirror moved to code.haverbeke.berlin (GitHub repos archived); npm releases continue. Live preview built in-house on SilverBullet's MIT patterns; `codemirror-live-markdown`/`@atomic-editor` are alpha references, not dependencies. |
| Sync server | `y-partyserver` ≥2.2.0 + `partyserver` ≥0.5.6 | `hibernate: true`; YProvider client mandatory (awareness heartbeat otherwise defeats hibernation); BYO update-log persistence (§3.3). |
| Workers | `wrangler` 4.x, `@cloudflare/workers-types` ^4.20260424, `nodejs_compat` | DocDO declared with `new_sqlite_classes`. |
| Web | `@tanstack/react-start` ~1.168 (RC) + `@cloudflare/vite-plugin` ^1.23 | Custom `server.ts` via `createServerEntry`, re-exports DO. |
| Auth | `better-auth` 1.6.x + drizzle-d1 | GitHub + Google social providers; Device Authorization plugin for the CLI. |
| Diff | `@sanity/diff-match-patch` ^3.2 | google/diff-match-patch is archived. |
| DB | D1 (metadata) + DocDO SQLite (doc data) | D1 10 GB cap is fine for metadata-only; comment bodies live in the DO. |
| Tests | vitest 4 + fast-check 4 | Property suites in `packages/core` (26 passing). |

Deferred (post-v1): MCP server with targeted edit tools (avoids whole-file agent rewrites); read-only CriticMarkup rendering of `{++ ++}`/`{-- --}` found in files; Yjs v14 attribution-based suggestions behind the existing accept/reject interface; read-replica tier for viral read-heavy docs.
