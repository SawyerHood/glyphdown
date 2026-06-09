# glyphdown

The Glyphdown CLI (hosted at <https://glyphdown.com>; source at
<https://github.com/SawyerHood/glyphdown>). Built for AI agents (Claude Code, etc.) that collaborate on
markdown documents as first-class participants: pull a doc to a plain file,
edit it with normal tools, push it back — the server merges your diff through
the CRDT so concurrent human edits survive. `glyphdown clone` mirrors your
whole account as a directory tree and `glyphdown sync` keeps it converged
both ways.

```sh
npm i -g glyphdown
glyphdown --help
```

## Install

1. **npm** (the primary path — Node >= 20, zero dependencies, single-file bundle):

   ```sh
   npm i -g glyphdown     # or: pnpm add -g glyphdown
   # one-off, no install:
   npx glyphdown --help
   ```

2. **Compiled binary** (no Node/Bun required at runtime; built from the repo):

   ```sh
   pnpm --filter glyphdown build:bin       # → packages/cli/dist/glyphdown (host platform)
   pnpm --filter glyphdown build:bin:all   # → dist/glyphdown-{darwin-arm64,darwin-x64,linux-x64,linux-arm64}
   cp packages/cli/dist/glyphdown ~/.local/bin/glyphdown  # or anywhere on PATH
   ```

   Cross-compiles via `bun build --compile --target=...` — build any of the
   four targets from any machine.

3. **tsx** in the workspace (dev): `pnpm --filter glyphdown dev <command>`
   (or `npx tsx packages/cli/src/bin.ts <command>`).

> **Note:** Node's native type-stripping (`node --experimental-strip-types`
> or Node 23+ running `.ts` directly) can NOT run this CLI from **source** —
> it uses TypeScript parameter properties, which type-stripping does not
> erase. The npm package ships a plain-JS bundle, so any Node >= 20 runs it;
> from the repo use the compiled binary or `tsx`.

## Auth

Resolution order (first hit wins):

1. `GLYPHDOWN_API_KEY` env — the agent path. Actions attribute to the agent identity.
2. `GLYPHDOWN_SERVER` env — server URL override (default: `https://glyphdown.com`).
3. `~/.config/glyphdown/config.json` (mode 600), written by `glyphdown login`.

The pre-rename `INKROOM_*` (and older `INKWELL_*`) `API_KEY` / `SERVER` /
`CONFIG_DIR` variables are still honored as silent fallbacks, and an existing
`~/.config/inkroom/config.json` (else `~/.config/inkwell/config.json`) is
auto-migrated to `~/.config/glyphdown/` on first run. Keys minted before the
rename (`ink_sk_…`) keep working — new keys mint as `gd_sk_…`.

```sh
export GLYPHDOWN_API_KEY=gd_sk_...               # minted in Settings → Agents
export GLYPHDOWN_SERVER=https://your-server.example  # optional self-host override

# or persist them:
glyphdown login --key gd_sk_... --server https://your-server.example
```

`glyphdown login` without `--key` (human device-code sign-in, RFC 8628) errors
with "server support pending" until the auth phase lands.

## Agent workflow

```sh
glyphdown list --json                       # docs you can access
glyphdown pull https://glyphdown.com/d/abc123 # or: glyphdown pull abc123 notes.md
# ... edit launch-plan.md with your normal tools ...
glyphdown push launch-plan.md -m "tighten the intro"
```

`glyphdown pull` writes the doc under its **canonical filename** (every doc's
name IS a file name — a slug ending in `.md`, e.g. `launch-plan.md`; the
server stores it and every machine uses it verbatim) plus `.glyphdown/<docId>/meta.json`
(`{docId, serverUrl, baseHash, pulledAt, file, versionId?}`) and
`.glyphdown/<docId>/base.md` — the pulled base, hashed over EOL-normalized text.
`glyphdown push` diffs your file against that base server-side; if the server's base
cache misses it automatically re-sends `base.md`. On clean success the base
files are updated so you can keep editing and push again without re-pulling.

### Exit codes (check these)

| Code | Meaning | What to do |
|---|---|---|
| 0 | applied cleanly | base files updated; keep editing |
| 2 | partially applied — failed hunks printed to stderr (like git `.rej`) | re-pull, re-apply the failed edits, push again |
| 3 | degenerate push refused: "doc has concurrent edits and your change rewrites most of it — re-pull or --force" | re-pull and redo, or `--force` if the rewrite is intentional |
| 1 | anything else (auth, network, bad args) | read stderr |

## Mirror workflow (clone + sync)

Mirror **everything you can access** — the full nested folder tree, every doc,
every image asset — and keep it converged:

```sh
glyphdown clone [dir]  # default dir: ./glyphdown
cd glyphdown
# ... edit pulled files, create new .md files, mkdir new folders ...
glyphdown sync               # true two-way mirror, recursive
```

`glyphdown clone` materializes each accessible folder as a nested directory
(slugified name; sibling collisions get `-2`, `-3`, …; folders whose parent
you cannot access are promoted to the root), pulls each doc into its folder's
directory (root-level docs land in the workspace root), and downloads each
folder's assets alongside its docs. Cloning into an existing workspace is an
error — run `glyphdown sync` there instead.

`glyphdown sync` then reconciles the whole tree, sequentially (rate limits):

| Change | Action |
|---|---|
| tracked doc edited locally / remotely / both | pushed / pulled / merged — same per-doc semantics as the table below |
| **new local `.md` file** | doc created on the server **named after the file** (slugified when messy — `My Notes.md → my-notes.md`, reported; the local file renames to match; the `# heading` is just content), in the folder matching its directory, content pushed (`created`) |
| tracked doc whose **server filename differs** from the local name (web-UI rename, or the one-time filename migration) | local file **renamed to the canonical name** (`renamed locally: old → new`) and the manifest updated — one-time convergence, after which names round-trip verbatim |
| **new local directory** (containing `.md`/image files) | folder created server-side with the parentId matching its path, then its contents processed (`folder created`); empty dirs are skipped |
| **new server doc** | materialized into the matching local dir, nested paths included (`new`) |
| **new server folder** | materialized as a nested local dir (`new folder (server)`) |
| server-side folder **rename/move** | noted (`folder renamed (server)`); the local dir is **not** renamed or moved — mapping is by folder id in `.glyphdown/folder.json`, so sync keeps resolving it (v1) |
| tracked doc, **local file deleted** | re-pulled from the server (`local missing — re-pulled`); the server doc is never deleted |
| **doc deleted server-side** | warning (`remote gone`); the local file is left alone |

**Deletions never propagate in either direction** (v1): deleting a local file
re-downloads it on the next sync (same for assets); deleting a server doc
leaves the local file in place with a warning. Delete on the server via the
web UI when you mean it.

**Renames: use `glyphdown mv`.** Sync does NOT detect local renames — renaming
a tracked file by hand re-pulls the old name AND creates a duplicate doc from
the new file (sync warns loudly when it sees that pattern). The supported
path renames the local file and PATCHes the server filename together, and
updates the manifest:

```sh
glyphdown mv launch-plan.md launch-plan-v2     # .md optional; names slugify
```

A name already used in the doc's folder (or your root, for folderless docs)
is rejected with `filename taken` — nothing moves.

Dotfiles (including the bookkeeping dir) and non-markdown/non-image files are ignored (noted once
per sync on stderr).

### Workspace layout

- `.glyphdown/workspace.json` at the clone root: `{version, serverUrl,
  clonedAt}` — marks a full-account mirror.
- every folder dir: `.glyphdown/folder.json` (`{folderId, folderName,
  serverUrl}`) — the dir ↔ folder mapping, keyed by id (renames don't break it).
- every dir: `.glyphdown/<docId>/{meta.json,base.md}` per tracked doc and
  `.glyphdown/assets.json` — identical to the single-folder layout, so an old
  `glyphdown pull --folder` workspace is recognized as a mirror subtree as-is:
  no migration, `glyphdown sync` just detects the shape and recurses.
- workspaces created by the pre-rename `ink` CLI keep their `.ink/`
  bookkeeping dir and are detected exactly the same way — `.glyphdown/` is
  checked first, then `.ink/`; whichever exists is used (never migrated).

### Agent examples

```sh
# Mirror the account, work anywhere in the tree, push everything back:
glyphdown clone work && cd work
echo '# Standup 2026-06-06' > team/standups/2026-06-06.md   # new doc
mkdir -p team/research && echo '# Findings' > team/research/findings.md  # new folder + doc
glyphdown sync --json
# [
#   { "docId": "…", "file": "team/research/", "action": "folder-created" },
#   { "docId": "…", "file": "team/research/findings.md", "action": "created", "message": "\"Findings\"" },
#   { "docId": "…", "file": "team/standups/2026-06-06.md", "action": "created", … }
# ]

# Long-running agent loop: converge before and after editing.
glyphdown sync && $EDITOR team/plan.md && glyphdown sync
```

`glyphdown sync --json` emits one record per doc **and** per folder action
(`folder-created` / `folder-new` / `folder-renamed` use the folder id as
`docId` and `dir/` as `file`); the original fields are unchanged.

## Folder workflow

Work on a whole folder of docs as a directory of markdown files:

```sh
glyphdown pull --folder "Launch Specs"     # or: glyphdown pull --folder <folderId> [dir]
cd launch-specs                      # default dir: <slugified folder name>
# ... edit any of the pulled .md files ...
glyphdown push --all                       # push every file that drifted from its base
glyphdown sync                             # two-way reconcile (+ discover new folder docs)
```

`glyphdown pull --folder <folderRef>` accepts a folder id or its exact name (an
ambiguous name errors and lists the candidate ids). Every non-deleted doc in
the folder lands under its canonical server filename (local-only collisions
get `-2`, `-3`, …) with the
usual `.glyphdown/<docId>/` base bookkeeping, plus `.glyphdown/folder.json`
(`{folderId, folderName, serverUrl}`) linking the directory to the folder.

`glyphdown push --all [dir]` compares each tracked file's hash against its recorded
base and pushes only the changed ones — sequentially, to respect the
60 pushes/min rate limit. `--suggest`/`--force`/`-m` pass through to every
push. It continues past per-doc failures: if all failures share one exit code
(2 or 3) that code is kept, otherwise it exits 1 with a summary.

`glyphdown sync [dir]` reconciles every tracked doc in both directions with one GET
per doc:

| State | Action |
|---|---|
| neither side changed | `up to date` |
| local file changed | push; base advances to your text |
| server changed | local file overwritten with server text (`pulled`) |
| both changed | push (the server CRDT-merges), then the merged text is re-fetched into your file (`merged`, with a failed-hunk count if any) |
| degenerate push refused | `skipped (degenerate)` — file left alone; use `--force` if intentional |
| doc added to the folder server-side | pulled as `new` (needs `.glyphdown/folder.json`) |
| doc deleted server-side | warning; local file left alone (`remote gone`) |

A folder workspace is a mirror subtree: `glyphdown sync` in it also picks up the
mirror behaviors scoped to that folder — new local `.md` files become docs in
the linked folder, new local subdirectories become child folders, and server
subfolders/docs materialize as nested dirs (see the mirror workflow above).

Sync exit codes: `0` all clean, `2` any failed hunks, `3` any degenerate skip,
`1` other failures.

### Agent examples

```sh
# Process review feedback across a whole folder:
glyphdown pull --folder "Q3 Planning" work && cd work
# ... edit files ...
glyphdown push --all -m "apply review feedback"

# Keep a long-running agent's working copy converged with human edits:
glyphdown sync --json   # machine-readable per-doc results:
# [{ "docId": "...", "file": "plan.md", "action": "merged", "failedHunks": 0 }, ...]
case $? in
  2) echo "re-apply the failed hunks" ;;
  3) echo "re-pull or rerun with --force" ;;
esac
```

### Suggesting instead of editing

```sh
glyphdown push --suggest -m "proposed rewording"   # lands as a reviewable suggestion set
glyphdown suggestions abc123 --json                # open suggestions with +/- quoted parts
```

After `--suggest`, the local base is left unchanged — re-pull once the
suggestion is reviewed.

## Reading

```sh
glyphdown cat abc123              # working view (includes pending suggested insertions)
glyphdown cat abc123 --clean      # "reject all" view
glyphdown cat abc123 --json       # { docId, view, text, versionId }
glyphdown pull abc123 --clean     # pull the clean view instead
```

`<doc>` accepts a doc id or a doc URL (`https://server/d/<docId>`).

## Comments

```sh
glyphdown comments abc123 --json                      # open threads with anchor quotes
glyphdown comment abc123 --body "Should this ship?"   # doc-level comment
glyphdown comment abc123 --line 12 --body "typo here" # anchored to line 12
glyphdown comment abc123 --reply c42 --body "fixed"   # reply to thread c42
glyphdown comment abc123 --resolve c42                # resolve (add --body to reply first)
```

## Other commands

```sh
glyphdown new "Launch Plan" [--folder f]   # create a doc; prints id + URL
glyphdown snapshot abc123 -m "pre-rewrite" # named version (do this before big pushes)
```

## JSON output

Every read command (`list`, `cat`, `comments`, `suggestions`, `new`) takes
`--json` for machine-readable output, and `glyphdown sync --json` emits the per-doc
result records. Other write commands print short human-readable
confirmations; rely on the exit code.

## Notes for integrators

- All text is normalized to `\n` line endings on every pull/push boundary —
  CRLF written by Windows tools is safe.
- `baseHash` is sha-256 (hex) over the normalized base text.
- Don't edit `.glyphdown/` (or a legacy workspace's `.ink/`) by hand; it is
  the push bookkeeping.
- Library use (monorepo workspaces only — the npm package ships just the
  binary): `import { createApi, pushWithBase, createProgram } from 'glyphdown'`.
