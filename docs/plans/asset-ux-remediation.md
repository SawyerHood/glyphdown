# Asset-UX remediation plan

> Validates an AI agent's report of friction in the single-asset upload/share flow against HEAD (CLI v0.5.1), and plans the fixes.
> Generated from a validation workflow (21 agents): per-claim code validation + adversarial verify + fix design + synthesis.
>
> **Superseded for command design by [unified-file-cli.md](unified-file-cli.md):** the
> maintainer chose to unify the CLI surface (fold files into existing verbs) rather than
> add a separate `asset add/ls/url` namespace. The *validation* below still stands; the
> command-shape recommendations are replaced by the unified plan.

## Validation summary

| Claim | Status | Current behavior at HEAD (v0.5.1) |
|---|---|---|
| **C1** No one-shot asset upload | **Confirmed** | No command takes a single file path and uploads it; bytes reach the server only via directory-scoped `sync`/`push --all`, which require a materialized workspace (`assetOpsFor`/`scanLocalAssets`, program.ts:241-250, assets.ts:95-118). |
| **C2** URL only prints on upload; no idempotent lookup | **Confirmed** | Viewer URL is built only in the upload branch (assets.ts:389-397); the up-to-date branch returns no message (assets.ts:367-373). No `url` command; `sync --json` emits only the doc/folder array (program.ts:827-830). The only idempotent URL is the *tokenized* share link, not the plain viewer URL. |
| **C3** Assets invisible to read commands | **Partial** | `list --json` still returns docs only (program.ts:341-355); **no asset-listing command exists**. BUT `cat --folder` and `cat <viewer-URL>` **already work** (program.ts:382-413, parseAssetUrlRef 71-101) — fixed in commit 68845fd. |
| **C4** `new` creates no content / no local file; no `--from`/stdin | **Confirmed** | `new` slugifies a name, calls `createDoc({filename, folderId})`, prints id+URL, writes nothing locally (program.ts:444-467). `createDoc` has no content field (api.ts:69,222-228). No `--from`/stdin anywhere in the CLI. |
| **C5** Relative asset links don't linkify in viewer | **Partial** | `[x](foo.html)` *does* render as a clickable chip (live-preview.ts:403-432) — the literal "plain text" symptom is **not reproduced**. But the href is never rewritten; the click opens the raw relative value against `/d/<docId>` → 404 (DocEditorPage.tsx:398-408). There is an `imageResolver` but **no `linkResolver`**. |
| **C6** Assets need auth, no share token | **Already fixed** | Anonymous `?share=` token access for assets ships end-to-end (router.ts:713-755,856-908; roles.ts:250-264; AssetShareDialog.tsx). Landed in PR #12 + v0.5.1 PR #13. **Do not rebuild.** |
| **C7** `share <filename>` failed; only `share <id>` worked | **Confirmed** | A bare filename positional with no `--folder`/`--doc` falls to `parseDocRef`, which returns the filename verbatim as a doc id → backend 404 (program.ts:1072-1087,1029; docref.ts:8-22). Asset sharing requires a viewer URL or filename+`--folder`. |

**Already addressed by v0.5.1 — do NOT rebuild:**
- **Asset `cat` by `--folder`/`--doc` and by viewer URL** (C3 sub-claims 2 & 3) — program.ts:382-413, parseAssetUrlRef 71-101.
- **Per-file HTML asset share links with anonymous `?share=` access** (C6 entirely) — router.ts:713-755,856-908; AssetShareDialog.tsx; CLI `share create` program.ts:1089-1135.
- **Asset comments and `cat --folder`** machinery is all in place; the new work just needs to *surface* it.

## What's genuinely missing

The "single asset in → URL out → share it" workflow breaks at four distinct points. All four reuse machinery that already exists; none requires new server endpoints.

**Gap A — No way to upload one file (C1).** `folderAssetOps(...).upload` (assets.ts:197-222) and `api.uploadFolderAsset` (api.ts:427-433) exist and already return `viewerUrl`/`fileViewerUrl` (assets.ts:421). But the only callers are `syncAssets` (assets.ts:382-386) driven off `scanLocalAssets` (whole-directory scan, assets.ts:95-118) and gated on a workspace existing. The upload *primitive* exists; the *command surface* does not. This is the root friction: the agent had to clone 33 docs to upload one file.

**Gap B — No idempotent URL lookup (C2 + C3 sub-claim 1).** Once an asset is up to date, there is no command that answers "what is its URL?" — the up-to-date branch drops the URL (assets.ts:367-373), `cat --json` returns no `url` field (program.ts:392-409), `history --json` has no URL (program.ts:862-864), and there is no `assets`/`url`/`ls` command at all (the list at program.ts:264-1266 has none). The asset-listing API methods exist (`listFolderAssets`/`listDocAssets`, api.ts:404-417) but are consumed only as a sync side-effect (assets.ts:250,300). The agent literally could not confirm its own upload via the CLI.

**Gap C — `share <filename>` doesn't resolve by filename (C7).** Sharing requires the user to already know either the asset viewer URL or to pass `--folder`. A bare filename silently becomes a phantom doc id (program.ts:1029, docref.ts:8-22). Even though the CLI knows how to map cwd → folder id (`readFolderConfig`, sync.ts:37-53), it never tries that fallback.

**Gap D — Relative links 404 in the rendered viewer (C5).** A relative `[x](foo.html)` becomes a clickable chip whose `data-href` is the raw relative string (live-preview.ts:429); `window.open` resolves it against `/d/<docId>` → 404 (DocEditorPage.tsx:398-408). An `imageResolver` rewrites relative *image* srcs (live-preview.ts:179-191, wired at DocEditorPage.tsx:439) but there is no analogous `linkResolver`. The agent's absolute-URL workaround was genuinely necessary.

**Plus C4** (separate workflow): `new` cannot create a doc *with content* in one step — orthogonal to the asset flow but a real, confirmed multi-step friction.

## Remediation plan (highest impact first)

The biggest leverage is a single new `asset` parent command exposing `add` + `ls` + `url`, plus the cwd filename fallback. That trio closes Gaps A, B, and C and directly delivers the agent's "one command" goal. Tackle those first.

---

### 1. `glyphdown asset` command group: `add`, `ls`, `url` (closes Gaps A + B, C1/C2/C3) — **Effort M, Risk Low**

Add a `program.command('asset')` parent (mirroring the `share` parent at program.ts:1089) with three subcommands. Consolidate the agent's proposals #1, #2 here.

**`asset add <file> [--folder <ref> | --vault <ref>] [--name <filename>] [--share [viewer|commenter]] [--json]`**
- Resolve scope with existing `resolveFolder`/`resolveVault` (sync.ts:70,96), rejecting both-set the way `new` does (program.ts:445).
- Read bytes (`readFileSync` → `Uint8Array`, as applyDecision does at assets.ts:385); derive filename via `normalizeAssetFilename` + basename; content-type via `assetContentType` (assets.ts:76); enforce `MAX_ASSET_BYTES` and `SYNCABLE_ASSET_FILE_EXTENSIONS` (protocol) — same guards as `scanLocalAssets` (assets.ts:106).
- Upload via **`folderAssetOps(api, folderId, serverUrl).upload(..., overwrite=true)`** (assets.ts:197-222) — NOT raw `api.uploadFolderAsset`, so the legacy-server HTML fallback and `viewerUrl` are reused.
- Print `ops.viewerUrl(uploaded.filename)` (the `/f/<folderId>/file/<filename>` page). With `--share`, also call `api.createAssetShareLink` + `assetShareUrl` (program.ts:1051,1107) via `parseAssetShareRole` (program.ts:1041).
- **Deliberately write no `.glyphdown` state** — stateless one-shot, no workspace required.

**`asset ls [scopeRef] [--folder <ref> | --doc <ref>] [--json]`** (C3 sub-claim 1)
- Resolve scope like `assetOpsFor`/`resolveAssetTarget`; call `api.listFolderAssets`/`listDocAssets` (api.ts:404-417); `--json` emits `AssetMeta[]` (protocol index.ts:461). Human output: `filename  contentType  size` + viewer URL for HTML (gate on `assetKindForContentType==='html'`, protocol index.ts:504). Output shape copied from `vaults` (program.ts:359-373).

**`asset url <target> [--folder <ref>] [--doc <ref>] [--json]`** (C2)
- Reuse `resolveAssetTarget` (program.ts:123-131). Build the URL from a new exported helper `assetViewerUrl(serverUrl, folderId, filename)` — extract the existing private `fileViewerUrl` (assets.ts:421-423) and reuse it both in `folderAssetOps` and here (one source of truth). Guard doc-scoped assets like `requireFolderAsset` (program.ts:1057-1065).

**Files:** `packages/cli/src/program.ts`, `packages/cli/src/assets.ts` (export `assetViewerUrl`), `packages/cli/package.json` (version bump), `docs/agent-guide.md`.
**Acceptance:** `glyphdown asset add page.html --folder X --json` uploads with no clone and prints a viewer URL; `asset ls --folder X --json` lists it; `asset url page.html --folder X` returns the same URL idempotently without re-upload.

---

### 2. `share`/`cat` resolve assets by filename from cwd (closes Gap C, C7) — **Effort S, Risk Low**

In `resolveShareAssetTarget` (program.ts:1072-1087) no-flag branch: when `parseAssetUrlRef` returns null AND the positional has a syncable asset extension, fall back to `readFolderConfig(cwd())` (sync.ts:37-53); if non-null, return `{type:'asset', scope:'folder', id: fc.folderId, filename}` — the exact `AssetTarget` shape that flows into `requireFolderAsset`→`createAssetShareLink`. When `readFolderConfig` is null, return null (preserves current doc-id/URL behavior + error messages). Apply the identical fallback in the shared `resolveAssetTarget` (program.ts:123-131, before the final `return parseAssetUrlRef`) so `cat`/`comments`/`history` get by-filename for free.

**Files:** `packages/cli/src/program.ts`, `docs/agent-guide.md` (help text at program.ts:1096,379).
**Acceptance:** From inside a pulled folder workspace, `glyphdown share page.html` mints a link without `--folder`; outside a workspace it still errors as today.

---

### 3. Emit asset URL in `sync` output even when up to date (C2 secondary) — **Effort S, Risk Low** *(secondary; #1's `asset url` already covers the lookup need)*

Add an optional `url?` field to `AssetSyncResult`, populated in **both** the upload branch and the up-to-date branch of `applyDecision` (assets.ts:367-397) via `opts.ops.viewerUrl`, gated on `assetKindForContentType==='html'`. This surfaces the URL in human output for unchanged assets. **Keep `sync --json`'s top-level `results` array shape unchanged** (pre-asset consumers depend on it per the program.ts:828 comment) — enrich additively, do not reshape. Given `asset url`/`asset ls` already deliver idempotent lookup, this is a nice-to-have, not load-bearing.

**Files:** `packages/cli/src/assets.ts` (and the `AssetSyncResult` type).
**Acceptance:** A `sync` over an unchanged HTML asset prints its viewer URL in human output; `sync --json` `results` array shape is byte-compatible with today.

---

### 4. `glyphdown new <name> --from <file> | --stdin` (C4) — **Effort M, Risk Low-Med** *(separate workflow)*

Keep `new`'s current preamble (createDoc → empty doc, program.ts:445-454). When `--from`/`--stdin` is supplied: read+`normalizeEol` the content; materialize the local file + base/meta via `writePull` with an **empty** base text (workspace.ts), then overwrite the on-disk `.md` with the content; push via **`pushWithBase`** (api.ts:598) — the same pipeline `push` uses — and advance the base with `recordBase` on success (mirrors program.ts:765-772). When neither flag is given, behavior is byte-for-byte unchanged. Needs an injectable stdin reader on `ProgramDeps` for testability (deps already inject env/cwd/out/err).

**Files:** `packages/cli/src/program.ts`, the CLI test file, `docs/agent-guide.md`.
**Acceptance:** `glyphdown new draft --from draft.md` creates the doc, writes a tracked local file, and the content lands server-side in one command; a follow-up edit is a plain `push`.

---

### 5. Linkify relative asset links in the viewer (Gap D, C5) — **Effort M, Risk Low-Med** *(web, independent track)*

Add a `linkResolver` Facet in `packages/editor/src/live-preview.ts` as a sibling of `imageResolver` (live-preview.ts:179-181), reusing the **same** relative-only gate `resolveImageSrc` (live-preview.ts:188-191). In the `case 'Link'` block, rewrite `data-href` from the raw url (line 429) through the resolver. Leave the GFM autolink `case 'URL'` alone (already absolute). Export `linkResolver` from the editor index. Wire it in `DocEditorPage.tsx` next to the imageResolver wiring (line 437-439): `linkResolver.of((href) => folderId ? folderFileViewerUrl(folderId, href, share) : href)`. **Note the folder-vs-doc mismatch:** `assetUrl` is doc-scoped (`/api/docs/...`, api.ts:604-607) but HTML assets live at `/f/<folderId>/file/<filename>` — add a `folderFileViewerUrl(folderId, filename, share)` helper in apps/web/src/lib/api.ts (next to `folderAssetUrl` at 653-656) targeting the **viewer route** for parity with CLI output. The click handler (DocEditorPage.tsx:398-408) needs no change.

**Files:** `packages/editor/src/live-preview.ts`, `packages/editor/src/index.ts`, `apps/web/src/components/editor/DocEditorPage.tsx`, `apps/web/src/lib/api.ts`, `docs/agent-guide.md`.
**Acceptance:** `[label](page.html)` in a folder doc opens `/f/<folderId>/file/page.html`; `[x](https://…)` and `[x](#anchor)` stay verbatim. Add a unit test mirroring the image-resolver tests.

---

### 6. Documentation (the fix for C3 sub-claims 2&3 and reinforcement everywhere) — **Effort S, Risk None**

No code needed for already-working `cat --folder`/`cat <viewer-URL>`. Update `docs/agent-guide.md` to: document `asset add`/`asset ls`/`asset url`; state `cat`/`share`/`comments` accept a filename with `--folder`/`--doc` or a viewer URL (lines 43,246-261,269-270); add the relative-link guidance parallel to the existing image guidance (line 269). **`docs/agent-guide.md` feeds the generated `skill-content.gen.ts`** — edit the source the gen script reads and regenerate; do not hand-edit the `.gen.ts`. This must accompany every code item above so future agents don't repeat C3/C7 confusion.

## Sequencing & dependencies

- **Land first (unblocks the agent's "one command" goal fastest):** Item **1** (`asset add`/`ls`/`url`). `asset add` alone delivers single-file-in-URL-out with no clone — the highest-impact single change. The `assetViewerUrl` helper extraction (assets.ts:421) is a prerequisite shared by `add`, `ls`, `url`, and item 3.
- **Land alongside / immediately after:** Item **2** (filename resolution) — small, reuses `readFolderConfig`, completes the share-by-name story. Independent of item 1 but they share the same docs update.
- **Item 3** (sync URL emission) depends on the `assetViewerUrl` extraction from item 1; otherwise standalone and optional.
- **Item 4** (`new --from`) is fully independent (touches `new`, not assets) — can land in parallel on its own track.
- **Item 5** (linkify, web) is fully independent of all CLI work — separate reviewer, separate package. Parallel track.
- **Item 6** (docs) must ship with each corresponding code item; the `cat`-already-works portion can land immediately on its own.

CLI items 1→2→3 form one PR-able cluster (one `asset` command group + filename fallback + sync field + version bump + docs). Items 4 and 5 are separate PRs.

## Open questions / decisions for the maintainer

1. **Command naming.** `asset add`/`asset ls`/`asset url` (parent group, parallels `share`) vs. flat top-level `upload`/`assets`/`url`. The group keeps the namespace clean and is the recommended shape; confirm before wiring.
2. **`asset add` scope.** Folder/vault only (matches per-file share-link scoping via `requireFolderAsset`, program.ts:1057-1065), or also support `--doc`? Recommend folder/vault only.
3. **`--share` default on `asset add`.** Opt-in (mint a link only with `--share`) vs. always. Recommend opt-in so default output is a single viewer URL.
4. **Relative-link target (C5).** Rich viewer route `/f/<folderId>/file/<filename>` (parity with CLI + share dialog) vs. raw asset endpoint `folderAssetUrl`. Recommend the viewer route. Also: in a folderless doc, should a relative link resolve to the per-doc `assetUrl` (image symmetry) or stay identity? Recommend identity (HTML viewer chrome only exists for folder assets).
5. **Doc share tokens authorizing linked assets.** C6's anonymous asset access already ships via *per-file* tokens. The agent's alternative ("a doc's share token authorizes the assets it links") is NOT implemented and would be a larger cross-scope change. Decide whether that convenience is wanted now or deferred — it is not required for the validated workflow.
6. **`new --from` failure semantics.** If the post-create push fails, leave the created empty doc + local drifted file and tell the user to re-run `push` (reuses existing recovery), vs. attempt to delete the just-created doc. Recommend the former. Also confirm the `ProgramDeps.stdin` injection shape for testability.
7. **`sync --json` asset URLs.** Is the additive `AssetSyncResult.url` (human output) + the new `asset url`/`asset ls --json` sufficient, or do you also want a wrapped `sync --json` object exposing asset results? The former avoids touching the stable `results`-array contract (program.ts:828).