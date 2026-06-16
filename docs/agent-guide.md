# Glyphdown agent guide

The deep reference for agents using the `glyphdown` CLI to collaborate on Glyphdown docs. The short version lives in [`skills/glyphdown/SKILL.md`](../skills/glyphdown/SKILL.md); this file covers every command, the sync model, exit-code recovery, suggestions, assets, and etiquette. Everything here is verified against the CLI source (`packages/cli/src/`) and `--help` output.

## Setup

```sh
export GLYPHDOWN_API_KEY=gd_sk_...                  # minted in Settings → Agents
export GLYPHDOWN_SERVER=https://your-server.example # optional; default https://glyphdown.com

# or persist both to ~/.config/glyphdown/config.json (mode 600):
glyphdown login --key gd_sk_... --server https://your-server.example
```

Resolution order: `GLYPHDOWN_API_KEY` env → `GLYPHDOWN_SERVER` env → the config file. Actions made with an API key attribute to the agent identity ("Claude Code · run by …") in cursors, bylines, and history. `glyphdown login` without `--key` is the human device-code flow; `glyphdown logout` removes stored credentials.

## Command table

`<doc>` accepts a doc id or a doc URL (`https://server/d/<docId>`).

| Command | Does |
|---|---|
| `glyphdown login [--key <key>] [--server <url>]` | store an API key (agents) or device-code sign-in (humans) |
| `glyphdown logout` | remove stored credentials (revokes the session server-side when possible) |
| `glyphdown list [--json]` | docs you can access: id, your role, title |
| `glyphdown vaults [--json]` | vaults you own or that are shared with you: id, your role, name |
| `glyphdown cat <target> [--clean \| --version <id>] [--folder <folderRef> \| --doc <doc>] [--json]` | print a doc or HTML asset; asset refs are URLs or filename + scope |
| `glyphdown new <name> [--folder <folderId> \| --vault <vault>] [--json]` | create a doc (name slugified into `<slug>.md`); prints id + URL. Neither flag → your default vault |
| `glyphdown mv <file> <new-name>` | rename a tracked doc: local file AND server filename together |
| `glyphdown rm <file> [--force]` / `glyphdown delete <file> [--force]` | delete a tracked doc on the server, archive the local file, and remove local tracking metadata |
| `glyphdown clone [dir] [--vault <vault>]` | mirror every accessible folder/doc — or one vault's subtree — into a workspace (default `./glyphdown`, or `./<vault-slug>` with `--vault`) |
| `glyphdown pull [doc] [path] [--clean] [--folder <folderRef>]` | pull one doc — or a whole folder by id/exact name (vault names/ids work: a vault IS a folder) |
| `glyphdown push [path] [--all] [--suggest] [--force] [-m <note>]` | merge local file edits into the live doc through the CRDT |
| `glyphdown sync [dir] [--force] [--json]` | two-way mirror sync of the whole workspace |
| `glyphdown history <target> [--folder <folderRef> \| --doc <doc>] [--json]` | list doc versions or HTML asset versions |
| `glyphdown comments <target> [--folder <folderRef> \| --doc <doc>] [--json]` | list open doc or HTML asset comment threads |
| `glyphdown comment <target> --body <b> [--reply <id>] [--resolve <id>] [--line <n>] [--folder <folderRef> \| --doc <doc>]` | add / reply / resolve doc or HTML asset comments |
| `glyphdown suggestions <doc> [--json]` | list open suggestions with their +/− parts |
| `glyphdown share <doc> [--role <r>] [--json]` | create an anyone-with-link share link (default role: viewer); prints the URL |
| `glyphdown share list <doc> [--json]` | active share links for a doc, with URLs |
| `glyphdown share revoke <doc> <token> [--json]` | revoke a share link (a `?share=<token>` URL needs no separate token) |
| `glyphdown share [list\|revoke] --folder <folderRef> …` | same three, for a folder/vault (the link covers its whole subtree) |
| `glyphdown share <asset> [list\|revoke] [--folder <folderRef>] …` | per-file HTML asset links (folder-scoped, view/comment only); target by viewer URL or filename + `--folder` |
| `glyphdown snapshot <target> -m <msg> [--folder <folderRef> \| --doc <doc>]` | create a named doc version, or name the current HTML asset version |

## Vaults

Every doc lives in exactly one **vault** — an Obsidian-style root namespace (a
special root folder; the account's top level contains only vaults). A whole
vault can be shared with you at a role, so check `glyphdown vaults` to see
what you can reach.

- `--vault <vault>` (on `new` and `clone`) takes a vault **name
  (case-insensitive)** or **id**. Vault names are unique per owner; when an
  owned and a shared vault share a name the CLI errors and lists the ids —
  pass the id.
- `glyphdown new` with neither `--folder` nor `--vault` creates the doc in the
  key owner's **default vault** (`Home` unless changed) — fine for scratch
  docs, but prefer an explicit `--vault`/`--folder` when the user named a
  place.
- `glyphdown clone --vault <vault>` makes a workspace confined to that vault:
  clone AND every later `sync` in it ignore everything outside the vault.
  A full `glyphdown clone` shows vaults as the top-level directories.

## Workspace anatomy

```
work/                          # clone root
  .glyphdown/
    workspace.json             # {version, serverUrl, clonedAt} — marks a full-account mirror
    <docId>/meta.json          # {docId, serverUrl, baseHash, pulledAt, file, versionId?}
    <docId>/base.md            # the merge base — NEVER edit this
    tombstones.json            # finalized local delete bookkeeping
    trash/docs/                # archived markdown files from glyphdown rm
    assets.json                # asset sync state {filename: {etag, size, mtimeMs}}
  launch-plan.md               # doc in the workspace root (canonical server filename, verbatim)
  team/                        # vaults and folders alike — one dir per server folder
    .glyphdown/folder.json     # {folderId, folderName, serverUrl} — dir ↔ folder, keyed by id
    .glyphdown/<docId>/...     # per-doc bookkeeping, same shape everywhere
    plan.md
    diagram.png                # folder asset, lives next to the docs
```

- **Never edit anything under `.glyphdown/`** — `base.md` is the three-way merge base; corrupting it corrupts every future push. (Workspaces from the pre-rename `ink` CLI use `.ink/` instead; both are honored, never migrated.)
- **Filenames are canonical slugs**: a doc's server name is `[a-z0-9-]+.md`, and that IS the local file name on every machine. The `# heading` inside is just content — never a name source. Messy new-file names slugify on creation (`My Notes.md → my-notes.md`, the local file renames to match).
- A `glyphdown pull --folder` directory is a valid mirror subtree as-is; `glyphdown sync` detects the shape (workspace.json → account mirror, folder.json → folder subtree, bare doc metas → single-dir) and recurses.
- A vault clone (`glyphdown clone --vault`) is a folder workspace rooted at the vault: the workspace root carries `folder.json` (pointing at the vault's folder id) instead of `workspace.json`, which is exactly what scopes sync to the vault's subtree.

## The three-way base model

Why concurrent human edits survive your pushes:

1. **Pull** writes the doc text plus `base.md` and its sha-256 `baseHash` — a record of what the server looked like when you last converged.
2. **Push** sends `{newText, baseHash}`. If the server's base cache misses, the CLI automatically re-sends `base.md` from disk (you'll see `server base cache missed — re-sent base.md` on stderr).
3. The server computes `diff(base, yourText)` — only what YOU changed — and fuzzy-patches it onto the **current** doc text inside the document's CRDT. Human edits made since your pull are untouched.
4. Hunks that no longer match (a human rewrote the same region) are returned verbatim, never silently dropped → exit 2.
5. **Degenerate guard**: if the doc drifted from your base AND your diff deletes >60% of the base, the push is refused (exit 3) — that shape usually means a stale agent about to flatten human work.
6. On clean success the base files advance to your pushed text, so you can keep editing and push again without re-pulling.

All text is normalized to `\n` line endings at every boundary; CRLF is safe to write.

## Sync decision matrix

`glyphdown sync` operates on the cwd by default — run it inside the workspace, or pass the directory (`glyphdown sync work`). It reconciles every tracked doc with one GET per doc, sequentially. Per tracked doc:

| Local vs base | Server vs base | Action | Effect |
|---|---|---|---|
| unchanged | unchanged | `up to date` | nothing |
| changed | unchanged | `pushed` | server now matches your file; base advances |
| unchanged | changed | `pulled` | your file overwritten with server text; base advances |
| changed | changed (identical text) | `up to date` | base advances, nothing sent |
| changed | changed | `merged` | push (server CRDT-merges), merged text re-fetched into your file; `failedHunks` count if any |
| changed, deletes >60% of a drifted base | — | `skipped (degenerate)` | file left alone; re-pull or `--force` |
| local file deleted | — | `local missing — re-pulled` | re-downloaded; use `glyphdown rm <file>` for an intentional server delete |
| — | doc deleted on server | `remote gone` | warning; local file left alone |

Workspace-level actions in the same run:

| Change | Action | Effect |
|---|---|---|
| new local `.md` file | `created` | new server doc named after the file (slugified if messy; local file renames to match), in the folder matching its directory, content pushed |
| tracked file's name ≠ server filename (web-UI rename / migration) | `renamed locally: old → new` (note) | local file renamed to the canonical name, manifest updated |
| new local directory containing `.md`/assets | `folder created` | server folder created at the matching path; empty dirs skipped |
| new server doc | `new` | materialized into the matching local dir |
| new server folder | `new folder (server)` | materialized as a nested local dir |
| server folder rename/move | `folder renamed (server)` | noted only; the local dir is NOT renamed/moved (mapping is by folder id) |

**Deletions never propagate implicitly** (docs and assets both): deleting a
tracked file by hand re-pulls it. Use `glyphdown rm <file>` (alias:
`glyphdown delete <file>`) when you mean to delete the server doc; it archives
the local file under `.glyphdown/trash/docs/`, removes active metadata, and
prevents later syncs from re-pulling that doc. It refuses if the remote changed
since your local base; re-sync first or pass `--force` only when discarding
remote edits is intentional.

**Local renames are not detected.** Renaming a tracked file by hand re-pulls the old name AND creates a duplicate doc from the new file — sync warns loudly when it sees that pattern. Use `glyphdown mv <file> <new-name>` (server rename first — a `filename taken` collision aborts before anything moves — then the local file and manifest).

## Exit codes and recovery

| Code | Meaning |
|---|---|
| 0 | clean |
| 2 | failed hunks — part of your change could not be applied |
| 3 | degenerate push refused / skipped |
| 1 | everything else (auth, network, 403/404/429, bad args) |

`glyphdown sync` aggregates: 2 if any doc had failed hunks, else 3 if any degenerate skip, else 1 if any failure, else 0. `glyphdown push --all` keeps the shared code when all failures agree (all 2s → 2), otherwise 1.

### Recovering from exit 2 (failed hunks)

After `glyphdown push`: the failed hunks were printed to stderr verbatim (like git `.rej` files) and **your base did not advance**.

```sh
glyphdown pull <doc>        # get the current server text (overwrites your file — copy it aside first if needed)
# re-apply ONLY the failed edits to the fresh text
glyphdown push <file>
```

After `glyphdown sync` (action `merged` with a `failedHunks` count): your file now contains the merged server text — the failed edits are simply **missing from it**. Re-apply them to the file and `glyphdown sync` again. (Sync reports the count, not the hunk bodies — diff your intended text against the merged file to find what's missing.)

### Recovering from exit 3 (degenerate)

The message is: `doc has concurrent edits and your change rewrites most of it — re-pull or --force (deletes N% of the base)`. The doc moved under you and your change looks like a flatten.

```sh
cp plan.md /tmp/mine.md     # keep your version
glyphdown pull <doc> plan.md      # fresh server text (in a sync workspace: delete/restore via sync)
# redo your edits against the fresh text, surgically
glyphdown push plan.md
```

Only when the full rewrite is genuinely intended (e.g. the user asked you to replace the doc):

```sh
glyphdown snapshot <doc> -m "pre-rewrite"   # escape hatch for humans
glyphdown push plan.md --force              # or: glyphdown sync --force
```

Never `--force` reflexively on a doc humans share — it is the one way to destroy concurrent work.

### Other rejections (exit 1)

- `server rejected the base even after re-sending it — re-pull and retry`: re-pull, redo, push.
- `rate-limited — retry in Ns`: wait, retry. Pushes are limited to 60/min per identity.
- `filename taken`: pick another name (`mv`/`new` only; creation via sync auto-suffixes `-2`, `-3`, … instead).

## Suggestion lifecycle

For changes a human should review before they land:

```sh
glyphdown push plan.md --suggest -m "tightened the intro"
# → suggestion <id> created (version <v>)
# → base unchanged — re-pull after the suggestion is reviewed
```

- The doc text the OWNER sees gains pending suggestion marks; nothing is hard-applied.
- Your local base does NOT advance. Don't keep pushing on top — wait for review, then re-pull (or sync).
- Keys with the **suggester role** on a doc can't edit directly: every plain `push`/`sync` lands as a suggestion automatically (sync reports `pushed — landed as suggestion <id> — base unchanged`).
- Humans accept/reject each suggestion in the web UI. Inspect open ones yourself:

```sh
glyphdown suggestions <doc> --json   # [{id, authorName, note?, status, parts: [{kind: insert|delete, anchor…}]}]
glyphdown cat <doc>                  # working view: pending suggested insertions included
glyphdown cat <doc> --clean          # "reject all" view; also: glyphdown pull <doc> --clean
glyphdown history <doc> --json       # saved versions
glyphdown cat <doc> --version <id>   # read a saved version
```

`-m/--message` on a suggest push is shown as the suggestion's note — always say why.

## Comments

```sh
glyphdown comments <doc> --json                          # open threads: id, author, anchor quote, replies
glyphdown comment <doc> --body "Should this ship?"       # doc-level thread
glyphdown comment <doc> --line 12 --body "typo here"     # anchored to line 12 (1-based, current working text)
glyphdown comment <doc> --reply c42 --body "fixed in the last push"
glyphdown comment <doc> --resolve c42                    # resolve; add --body to reply first, then resolve
glyphdown comments "https://server/f/<folderId>/file/page.html" --json
glyphdown comment page.html --folder <folderId> --body "Check this HTML file"  # asset-level thread
glyphdown comment page.html --folder <folderId> --reply c42 --body "fixed"
```

- `comments` shows open threads only; anchored threads quote their text, `[orphaned]` marks anchors whose text was edited away.
- CLI-created HTML asset comments are file-level. Node/element picking happens in the web viewer; the CLI can list, reply, and resolve those threads after they exist.
- Comment bodies are markdown; @-mention as `@[userId]`.
- Good etiquette: when a comment asks for a change, make the edit (push or suggest), then `--reply` with what you did and `--resolve`.

## Share links (anyone-with-link)

Create, list, and revoke public share links — the same links the web UI's
share dialog manages. **Owner-only** on the target: a non-owner key gets the
403 `forbidden` error.

```sh
glyphdown share <doc>                         # create a viewer link; prints the URL
glyphdown share <doc> --role editor --json    # roles: viewer | commenter | suggester | editor
glyphdown share list <doc> --json             # active links: token, role, createdAt, url
glyphdown share revoke <doc> <token>          # revoke by token
glyphdown share revoke "https://glyphdown.com/d/<docId>?share=<token>"   # token read from the URL
```

- `glyphdown share <doc>` is shorthand for `glyphdown share create <doc>`; the default role is **viewer**.
- The printed URL is the web landing page: `https://<server>/d/<docId>?share=<token>`. Anyone with it gets the link's role on the doc (anonymous visitors are capped at viewer).
- **Folders and vaults** use `--folder <folderRef>` (id or exact name; vault names work — a vault IS a folder) instead of the doc positional. A folder link grants its role over the folder's **entire subtree**, and its URL is `https://<server>/f/<folderId>?share=<token>`:

```sh
glyphdown share --folder Research --role commenter   # create
glyphdown share list --folder Research --json        # list
glyphdown share revoke --folder Research <token>     # revoke — the token is the only positional
```

- **Per-file HTML assets** can be shared on their own — the same per-file link the web file viewer mints. These are **folder/vault assets only** and **view/comment only** (`suggester`/`editor` are rejected up front; a static file has no suggest/edit surface). The recipient lands on the file viewer: `https://<server>/f/<folderId>/file/<filename>?share=<token>`. Target the asset by its viewer URL or by filename + `--folder` (exactly as `comments`/`history` do — a bare `--folder <ref>` without a filename still shares the whole folder):

```sh
glyphdown share https://glyphdown.com/f/f1/file/page.html --role commenter  # create (default role: viewer)
glyphdown share page.html --folder Research                                 # create by filename
glyphdown share list page.html --folder Research --json                     # list per-file links
glyphdown share revoke --folder Research page.html <token>                  # revoke — filename THEN token
glyphdown share revoke "https://glyphdown.com/f/f1/file/page.html?share=<token>"  # token read from the URL
```

- The token IS the capability — treat it like a secret; don't paste share URLs into public places unless that's the point. Revoking kills anonymous access immediately (signed-in sessions that rode the link drop at their next request).

## Assets

- Syncable asset files are images (`png, jpg, jpeg, gif, webp, svg, avif`) and standalone HTML files (`html, htm`) — max **10 MB**. Everything else (and all dotfiles) is ignored, noted once per sync.
- Reference images **folder-relative** in markdown: the file sits next to the doc, embed as `![alt](diagram.png)`. All docs in a folder share one asset namespace; folderless docs each carry their own.
- HTML files in folder workspaces upload as folder assets and sync prints the viewer URL (`<server>/f/<folderId>/file/<filename>`) when it uploads one.
- Asset refs accepted by `cat`, `history`, `comments`, `comment`, and `snapshot` are either the viewer URL (`https://server/f/<folderId>/file/<filename>`), an API asset URL, or a filename plus `--folder <folderRef>` / `--doc <docId>`.
- HTML asset uploads create version rows automatically. Use `glyphdown history <asset>` to list them, `glyphdown cat <asset> --version <id>` to read one, and `glyphdown snapshot <asset> -m "label"` to name the current asset version.
- Filenames are normalized server-side (basename only, lowercase, whitespace → `-`); the CLI records the server's name if it differs.
- Conflict rule: an asset changed both locally and on the server keeps the **local** copy with a warning (`conflict-local-kept`) — assets don't merge.
- No delete propagation: a deleted local asset re-downloads on the next sync.

## Multi-agent / shared-doc etiquette

- **Converge before and after editing**: `glyphdown sync && edit && glyphdown sync`. Long gaps between pull and push are what produce failed hunks and degenerate refusals.
- **One sync at a time per workspace.** The CLI already processes docs sequentially (rate limits, readable output); don't run parallel syncs/pushes over the same tree.
- Rate limit: **60 pushes/min per identity**. `push --all` and `sync` pace themselves by being sequential; on `rate-limited` honor the printed retry delay.
- Prefer many **small, surgical pushes** over one giant rewrite — character-level diffs preserve everyone's comment/suggestion anchors in the runs you didn't touch.
- `glyphdown snapshot <doc-or-html-asset> -m "..."` before any bulk transformation, so humans have a named restore point/version label.
- On docs humans are actively editing, prefer `--suggest` for opinionated rewrites.

## Troubleshooting

| Symptom | Meaning | Fix |
|---|---|---|
| `not authenticated — run glyphdown login …` (401) | no/invalid credential | set `GLYPHDOWN_API_KEY` or `glyphdown login --key gd_sk_...`; check the key wasn't revoked |
| `forbidden — your role on this doc does not allow that` (403) | role too low (e.g. commenter trying to push) | ask for a higher role, or use what the role allows (comment/suggest) |
| `doc not found — check the id/URL and your access` (404) | bad id, deleted doc, or no access | `glyphdown list --json` to see what you can reach |
| `filename taken` (409) | rename/create collides in that folder | pick another name |
| `rate-limited — retry in Ns` (429) | >60 pushes/min | wait `N` seconds, retry; keep operations sequential |
| `… is already a Glyphdown workspace — run glyphdown sync there` | clone into an existing workspace | `glyphdown sync` instead |
| `multiple pulled docs here … pass the file path` | bare `glyphdown push` in a multi-doc dir | `glyphdown push <path>` |
| `no .glyphdown metadata for <file> …` | file isn't tracked | `glyphdown pull <doc> <path>` first, or create it via `sync` |
| sync warning about a re-pull + a new doc in the same folder | you renamed a tracked file by hand → duplicate doc | delete the duplicate in the web UI; use `glyphdown mv` next time |

## JSON output shapes

- `glyphdown list --json` → `[{id, filename, title, folderId, ownerUserId, role, createdAt, updatedAt}]`
- `glyphdown vaults --json` → `[{id, name, ownerUserId, role, createdAt}]`
- `glyphdown cat <doc> --json` → `{docId, view, text, versionId}`; `glyphdown cat <asset> --json` → `{target:'asset', scope, id, filename, versionId, contentType, etag, text}`
- `glyphdown new <name> --json` → the doc meta plus `url`
- `glyphdown sync --json` → `[{docId, file, action, failedHunks?, message?}]` — one record per doc AND per folder action (folder actions use the folder id as `docId` and `dir/` as `file`). Asset outcomes ride stderr/human output, not the JSON.
- `glyphdown history <target> --json` → doc `VersionMeta[]` or asset `AssetVersionMeta[]`
- `glyphdown comments <target> --json` → open `Comment[]` (anchor quotes/node labels, replies, reactions)
- `glyphdown suggestions <doc> --json` → open `SuggestionRecord[]` (insert/delete parts with anchors)
- `glyphdown share … --json` → create: `{target: 'doc'|'folder', id, token, role, createdAt, url}`; list: `[{token, role, createdAt, url}]`; revoke: `{ok: true, target, id, token}`

Write commands print short human-readable confirmations — rely on the exit code.
