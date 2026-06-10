---
name: glyphdown
description: Collaborate on Glyphdown docs (Google Docs for markdown) via the glyphdown CLI. Use when users ask to edit my glyphdown docs, sync my markdown notes, pull my notes, push this writeup, leave suggestions on the doc, comment on a doc, clone my glyphdown workspace, or any markdown collaboration with glyphdown.com docs. Trigger phrases include "glyphdown", "sync my notes", "pull the doc", "push my edits", "suggest changes on the doc", "check comments on the doc".
---

# Glyphdown

CLI for collaborating on Glyphdown markdown docs. Humans edit live in the web UI; you edit plain `.md` files and the server CRDT-merges, so concurrent human work survives — as long as you follow the rules below.

Full reference: [docs/agent-guide.md](https://github.com/SawyerHood/glyphdown/blob/main/docs/agent-guide.md) (works from the repo or a CLI-installed copy).

## Auth

`export GLYPHDOWN_API_KEY=gd_sk_...` (minted in Settings → Agents) or `glyphdown login --key gd_sk_...`. Server defaults to `https://glyphdown.com`; override with `GLYPHDOWN_SERVER` or `--server`.

## Core loop

```sh
glyphdown clone work && cd work   # once; mirrors every folder/doc you can access (default dir: ./glyphdown)
# ... edit .md files, add images, mkdir new folders — normal tools ...
glyphdown sync                    # two-way reconcile, run before AND after editing
```

`sync` operates on the cwd — run it inside the workspace (or pass the dir: `glyphdown sync work`).

**Vaults**: every doc lives in one vault (an Obsidian-style root namespace; a full clone shows vaults as top-level dirs). `glyphdown vaults --json` lists yours; `glyphdown clone --vault <name|id>` makes a workspace confined to one vault (clone and sync both ignore everything outside it); `glyphdown new <name> --vault <vault>` creates at its top level. Vault names resolve case-insensitively; with neither `--vault` nor `--folder`, `new` lands in the key owner's default vault.

Sync prints one action per doc/folder: `pushed` / `pulled` / `merged` / `created` (new local file → new doc) / `new` (new server doc) / `folder created` / `new folder (server)` / `renamed locally: old → new` / `local missing — re-pulled` / `remote gone` / `up to date`.

**Exit codes** (always check): `0` clean · `2` failed hunks — printed like git `.rej`; re-apply those edits by hand and sync again · `3` degenerate skip — your change rewrites most of a doc that drifted; re-pull and redo, or `--force` ONLY if the rewrite is intentional — never blind `--force` on a shared doc · `1` anything else (read stderr).

Single docs without a clone: `glyphdown pull <id|url>` → edit → `glyphdown push <file>`.

## Suggestions instead of edits

For reviewable changes: `glyphdown push <file> --suggest -m "why"` (or sync with a suggester-role key — pushes land as suggestions automatically). Humans accept/reject in the web UI; your local base does not advance — re-pull after review. List with `glyphdown suggestions <doc> --json`.

## Renames

`glyphdown mv <file> <new-name>` — NEVER bare `mv`: sync does not detect renames, so the old name re-pulls and the new file becomes a duplicate doc. `mv` renames the local file and the server filename together.

## Comments

```sh
glyphdown comments <doc> --json                       # open threads
glyphdown comment <doc> --body "..." [--line N]       # new (line-anchored) comment
glyphdown comment <doc> --reply <id> --body "..."     # reply
glyphdown comment <doc> --resolve <id> [--body "..."] # resolve (reply first if --body)
```

## Rules

- `--json` on read commands (`list`, `vaults`, `cat`, `comments`, `suggestions`, `new`, `sync`) for parsing.
- Filenames are canonical slugs (`[a-z0-9-]` + `.md`); the file name IS the doc name everywhere. The `# heading` is just content.
- Don't rewrite >60% of a shared doc in one push (the server refuses with exit 3). `glyphdown snapshot <doc> -m "msg"` before big changes.
- Deletions never propagate: deleted local files re-pull; server-deleted docs warn (`remote gone`) and stay local. Delete via the web UI.
- Never edit `.glyphdown/` (the push bookkeeping). Sync sequentially — one sync at a time per workspace; pushes are rate-limited 60/min.
