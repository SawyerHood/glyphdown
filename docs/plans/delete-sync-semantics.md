# Delete Sync Semantics Implementation Plan

## Context

Today `glyphdown sync` deliberately does not propagate document deletes:

- A tracked doc whose local markdown file is missing is fetched again from the server and reported as `local missing - re-pulled`.
- A tracked doc that is gone or inaccessible on the server is reported as `remote gone`, while the local file and its tracking metadata stay in place.
- Mirror sync warns when the old behavior probably came from a local rename: old tracked file missing plus new untracked markdown file in the same directory.

That behavior prevents accidental server-side data loss, but it makes intentional delete workflows awkward. It also leaves users with stale local files after a remote delete and makes "delete by removing the file and sync" do the opposite of what many users expect.

This plan keeps delete operations explicit and reversible while making sync converge instead of resurrecting or orphaning files.

## Current Behavior Inventory

The relevant implementation points are:

- `packages/cli/src/sync.ts`
  - `SyncAction` currently includes `remote-gone` and `repulled`.
  - `reconcileTracked` calls `api.getContent(docId, 'working')`; a 404 becomes `remote-gone`.
  - If `readFileSync(ws.path)` fails, `reconcileTracked` writes the fetched remote text back to the local path, calls `recordBase`, and returns `repulled`.
  - `syncExitCode` treats `remote-gone` and `repulled` as non-fatal.
- `packages/cli/src/mirror.ts`
  - Recursive sync delegates per-doc behavior to `syncTracked`.
  - The file header documents "No delete propagation in either direction."
  - `warnLikelyLocalRename` detects the current re-pull plus create pattern and warns that the user probably used bare `mv`.
- `packages/cli/src/workspace.ts`
  - Per-doc metadata is only `.glyphdown/<docId>/meta.json` plus `base.md`.
  - `DocWorkspaceMeta` stores `docId`, `serverUrl`, `baseHash`, `pulledAt`, `file`, and optional `versionId`.
  - There is no tombstone, local archive, or delete intent state.
- `packages/cli/src/api.ts`
  - The CLI API client exposes `getDoc`, `getContent`, `push`, `renameDoc`, etc.
  - It does not expose `deleteDoc` or `restoreDoc`, even though the web API has those routes.
- Installed CLI behavior confirms there is no first-class delete command today: `glyphdown --help` lists `login`, `logout`, `install-skill`, `guide`, `list`, `vaults`, `cat`, `new`, `mv`, `clone`, `pull`, `push`, `sync`, `comments`, `comment`, `suggestions`, `snapshot`, and `help`, but no `rm` or `delete`.
- `apps/web/src/api/router.ts`
  - `DELETE /api/docs/:id` already soft-deletes a doc for owners and calls the DocDO admin delete hook.
  - `POST /api/docs/:id/restore` restores a trashed doc for owners.
  - Deleted docs are hidden behind the normal 404/no-existence-leak behavior.
- Manual API testing confirms the remote delete route can already be used with auth: `DELETE /api/docs/cda62dfb-8b60-4d17-8f65-994e45256438` returned `{"ok":true}`. If the caller also removes the local markdown file and the matching `.glyphdown/<docId>/` active metadata, a later `glyphdown sync /Users/sawyerhood/glyphdown-crunch-hermes --json` no longer re-pulls that doc because `listMetas` no longer sees it as tracked.
- `packages/sync/src/do.ts`
  - `GET /content` computes and returns `x-glyphdown-base-hash` for the current working text.
  - `/admin/doc-deleted` broadcasts `{t:'doc-deleted'}` and closes live connections.
  - There is no conditional delete/preflight endpoint that checks a content hash before deleting.
- Documentation currently states the v1 contract in `SPEC.md`, `packages/cli/README.md`, and `docs/agent-guide.md`: deletes never propagate.
- Tests lock in the current contract in `packages/cli/test/sync.test.ts`, `packages/cli/test/mirror.test.ts`, `packages/cli/test/filenames.test.ts`, and `packages/cli/test/assets.test.ts`.

## Goals

1. Make intentional document deletes possible from the CLI and from sync workspaces.
2. Do not let accidental `rm`, checkout churn, or access loss silently delete a server doc.
3. Do not delete a remote doc that changed after the local base unless the user explicitly forces that delete.
4. Converge local workspaces when docs are deleted remotely: stale files should not remain as tracked live docs forever.
5. Preserve local content that might contain unsynced work by moving it to a local archive before removing it from the active workspace.
6. Keep the existing push merge semantics and exit-code contract intact: delete conflicts should not be represented as empty-file pushes.

## Non-goals

- Do not implement folder or vault delete propagation from local directory removal in the first pass.
- Do not implement asset delete propagation in the first document-delete pass. Asset behavior should remain as-is until it gets a parallel design, because assets use different state (`assets.json`) and have no merge semantics.
- Do not try to infer local renames as server renames. `glyphdown mv` remains the supported rename path.
- Do not expose deleted docs in normal `glyphdown list`; restored docs should re-enter list naturally after restore.

## Product Semantics

### Delete Means "Trash The Document"

A document delete from CLI sync should call the server's doc delete route. It must not be modeled as pushing an empty markdown document. Server-side delete keeps the existing product semantics:

- owner-only;
- soft-delete into the server trash;
- live clients receive the doc-deleted event and are disconnected;
- doc filename is released for live docs;
- restore remains possible through the existing restore route while trash retention allows it.

### Explicit Single-doc Delete: `glyphdown rm`

Add a command, with `delete` as a discoverability alias:

```sh
glyphdown rm <file> [--force] [--json]
glyphdown delete <file> [--force] [--json]
```

Recommended behavior:

- Resolve `<file>` through existing workspace metadata, like `glyphdown mv`.
- Fetch current remote working content and compare its hash to `meta.baseHash`.
- If the remote hash differs from the local base, refuse unless `--force` is passed. Message: `remote changed since your base - re-sync or use --force to delete anyway`.
- If the local file exists, move it to a local archive before deleting server state. Do not leave it in place as an untracked `.md` file, because the next folder sync would recreate it as a new server doc.
- Call the existing server delete API.
- Once conditional delete support exists, pass a content precondition when not forced.
- Remove `.glyphdown/<docId>/meta.json` and `base.md` after the server delete succeeds.
- Write a tombstone entry for audit/recovery.
- Print the doc id and a restore hint. JSON should include `{docId, file, action:"deleted", archivedPath?}`.

`glyphdown rm` / `glyphdown delete` is an explicit confirmation. It should not prompt interactively by default; agents need commands that do not hang.

This wrapper is the immediate product fix: it automates the manual sequence that works today (remote `DELETE`, remove/retire the local file, remove active tracking metadata) so users do not have to edit `.glyphdown/` by hand.

### Sync Local Delete: Missing Tracked File

When a tracked file is missing locally, `glyphdown sync` should stop automatically re-pulling it. Treat the missing file as a possible delete intent.

Default behavior:

- If the remote doc still exists and the remote hash equals `meta.baseHash`, return `delete-pending`.
- If the remote doc still exists and the remote hash differs from `meta.baseHash`, return `delete-conflict`.
- Do not write the file back to disk unless the user asked for restore behavior.
- Exit non-zero for `delete-pending` and `delete-conflict` so agents notice that sync did not converge.

Confirmed behavior:

```sh
glyphdown sync --apply-deletes
```

- For safe local deletes where `remoteHash == meta.baseHash`, call server delete with a content precondition.
- Remove local metadata and write a tombstone.
- Report `deleted`.
- Exit 0 if all other work also succeeded.

Forced behavior:

```sh
glyphdown sync --apply-deletes --force-deletes
```

- Allows deleting a remote doc even when it changed since the local base.
- This must be separate from existing `--force`, which means "force a large push merge". Reusing `--force` for doc deletes would make dangerous automation too easy.
- Only owners can delete; editor/suggester/commenter keys should report `delete-forbidden`.

Restore behavior:

```sh
glyphdown sync --restore-missing
```

- Keeps the old re-pull behavior as an explicit recovery action.
- If a tracked file is missing and the remote doc exists, re-download it and advance base.
- Mutually exclusive with `--apply-deletes`.

### Sync Remote Delete: Server Doc Gone Or Inaccessible

A 404 from `getContent` means "not accessible from this key." It may be a real server delete, a revoked grant, a vault delete, or a missing doc id. The CLI cannot always distinguish those cases without leaking existence.

Recommended behavior:

- If the local file is missing, remove tracking metadata and write a tombstone. Report `forgotten`.
- If the local file exists and is unchanged from `base.md`, move it to the local delete archive or remove it, remove tracking metadata, and report `remote-deleted`.
- If the local file exists and differs from `base.md`, move it to the local conflict archive, remove tracking metadata, write a tombstone with `localChanged: true`, report `remote-gone-local-saved`, and exit 1.

This is safer than leaving the changed file active in the workspace, because an untracked markdown file in a folder workspace becomes a new server doc on the next sync. Moving it under `.glyphdown/` prevents accidental recreation while preserving the content.

### Same Filename Reused Remotely

Because soft-deleted docs release their filename, this can happen:

1. local workspace tracks doc A as `plan.md`;
2. doc A is deleted on the server;
3. a new doc B is created on the server as `plan.md`;
4. sync runs.

Expected behavior:

- Process the tracked tombstone for doc A first.
- Archive/remove the old local `plan.md` and remove doc A metadata.
- Then materialize doc B as `plan.md` with its own `.glyphdown/<docB>/` state.
- Report both actions in JSON, ordered as observed.

### Local Rename Suspicion

The current warning should become a blocking conflict before any server mutations happen.

Pattern:

- a tracked doc file is missing;
- an untracked `.md` file appears in the same directory in the same sync run;
- especially if the untracked file hash equals the missing doc's base hash or is highly similar.

Expected behavior:

- Report `rename-suspected`.
- Do not delete the old server doc.
- Do not create the new server doc in the same run.
- Tell the user to restore the old file and use `glyphdown mv`, or run `glyphdown rm` plus `glyphdown new` if a delete/create was intentional.

This avoids turning a hand rename into a server delete plus a new doc with a different id.

## CLI UX

### New Actions

Extend `SyncAction` with:

- `delete-pending`: local file missing, remote unchanged, delete not confirmed.
- `deleted`: local delete propagated to server trash.
- `delete-conflict`: local file missing but remote changed from base.
- `delete-forbidden`: delete requested but caller is not owner.
- `remote-deleted`: remote gone and local clean copy removed/archived.
- `remote-gone-local-saved`: remote gone/inaccessible, local had unsynced changes saved to archive.
- `forgotten`: both local file and remote doc are gone/inaccessible; metadata removed.
- `rename-suspected`: sync blocked a likely hand rename.

Human output should avoid implying certain server deletion when the server only returned a no-leak 404. Use "remote gone" in user-facing text, but use precise action names for machine parsing.

### Flags

Add to `glyphdown sync`:

- `--apply-deletes`: propagate safe missing-file deletes to the server.
- `--force-deletes`: with `--apply-deletes`, delete even when the remote changed since local base.
- `--restore-missing`: explicitly re-pull missing tracked files. Mutually exclusive with `--apply-deletes`.
- Optional alias after docs settle: `--delete` as an alias for `--apply-deletes`.

Do not make `--json` change delete behavior. It should only change output format.

### Exit Codes

Keep existing meanings:

- `0`: clean convergence, including confirmed deletes.
- `2`: failed hunks from push merge.
- `3`: degenerate push skipped.
- `1`: delete pending, delete conflict, forbidden delete, rename-suspected, server/API failures, or any mixed failure.

Do not assign a new exit code for deletes unless the overall CLI exit code contract is revised everywhere. The docs currently teach agents to handle `0/1/2/3`; keep that stable.

## Safety And Confirmation

### Confirmation Model

Use command/flag confirmation, not interactive prompts:

- `glyphdown rm` / `glyphdown delete` confirms one doc delete.
- `glyphdown sync --apply-deletes` confirms batch safe deletes.
- `glyphdown sync --apply-deletes --force-deletes` confirms batch deletes that may discard remote edits.
- `glyphdown sync --restore-missing` confirms re-pulling missing files.

This keeps sync usable for AI agents, CI, and non-TTY shells.

### Server-side Preconditions

Client-side `GET /content` plus `DELETE /api/docs/:id` has a race: the remote doc can change between the GET and DELETE.

Add conditional delete support before enabling sync delete propagation:

- CLI sends the last observed working-text hash when deleting safely.
- The server checks the current DocDO working hash immediately before soft-delete.
- If the hash differs, return `409 {error:"content-changed", currentBaseHash}` and do not delete.
- `--force-deletes` skips this precondition.

Implementation options:

1. Add an owner-only DocDO admin endpoint such as `POST /admin/prepare-delete` with `{baseHash?}`.
   - When `baseHash` is present, compare it to the current working text hash.
   - On match, set a short-lived delete-prepared flag that rejects pushes/content writes, then return ok.
   - Worker updates D1 `deleted_at`, then calls existing `/admin/doc-deleted`.
   - If the D1 update fails, call a best-effort cancel endpoint or let the prepare lease expire.
2. Simpler fallback for v1: add `POST /admin/delete-preflight` that only compares the hash, then keep the existing D1 update plus `/admin/doc-deleted` order.
   - Easier to ship, but does not fully close the race.

Prefer option 1 if this becomes the default sync behavior.

### Local Archive

Add a small local archive under the bookkeeping directory:

```text
.glyphdown/trash/
  docs/
    2026-06-13T120102Z-docId-filename.md
  conflicts/
    2026-06-13T120102Z-docId-filename.md
```

Rules:

- Anything sync removes from the active workspace because of delete handling is moved here first.
- Archive paths are included in human output and JSON.
- Files under `.glyphdown/` are already ignored by sync tree walking.
- Add a cleanup command later only if this directory grows in practice; do not silently purge in the first implementation.

## Server/API Work

Immediate wrapper work:

- Add `deleteDoc(docId, opts?)` to `packages/cli/src/api.ts`.
- Expose a first-class CLI wrapper around the existing remote delete API: `glyphdown rm <file>` with `glyphdown delete <file>` as an alias.
- Remove active local tracking metadata after successful remote delete so later sync runs do not re-pull the deleted doc.
- Extend fake server support in `packages/cli/test/fake-server.ts` for `DELETE /api/docs/:id`.

Required before sync propagates local deletes:

- Add `restoreDoc(docId)` to `packages/cli/src/api.ts` if `glyphdown restore` ships in the same change.
- Update `packages/protocol/src/index.ts` public API comments to include `DELETE /api/docs/:id`, because the route exists but is not documented there today.
- Add conditional delete support to `apps/web/src/api/router.ts` and `packages/sync/src/do.ts` as described above.
- Extend fake server support in `packages/cli/test/fake-server.ts` for `POST /api/docs/:id/restore` if restore ships.

Optional but useful:

- Return `{ok:true, deletedAt}` from `DELETE /api/docs/:id` while accepting old clients that only expect `{ok:true}`.
- Include a `restoreUntil` timestamp if/when the trash retention window is encoded in API responses.
- Add an analytics event such as `cli_doc_deleted` separate from `cli_push`.

No D1 schema migration is required for the initial version. A future audit trail could add `deleted_by_principal_id`, but the existing soft-delete timestamp is sufficient for sync semantics.

## Metadata Changes

Add helper functions in `packages/cli/src/workspace.ts`:

- `removeDocState(dir, docId)`: removes `.glyphdown/<docId>/meta.json` and `base.md` after a finalized delete or remote-gone prune.
- `archiveDocFile(dir, meta, kind)`: moves the local file into `.glyphdown/trash/docs` or `.glyphdown/trash/conflicts`.
- `writeTombstone(dir, tombstone)`: records finalized delete state.

Add `.glyphdown/tombstones.json` per directory:

```json
{
  "version": 1,
  "docs": {
    "doc_123": {
      "docId": "doc_123",
      "file": "plan.md",
      "serverUrl": "https://glyphdown.com",
      "baseHash": "abc123",
      "versionId": "v1",
      "origin": "local-delete|remote-gone|rm-command",
      "recordedAt": 1781390000000,
      "archivedPath": ".glyphdown/trash/docs/2026-06-13T120102Z-doc_123-plan.md",
      "localChanged": false
    }
  }
}
```

Keep `DocWorkspaceMeta` backward-compatible. Optional new fields are fine, but the active tracking decision should still be based on the presence of `.glyphdown/<docId>/meta.json`. After a delete is finalized, remove active metadata so older clients do not resurrect the doc from stale meta.

Legacy `.ink/` workspaces should use `.ink/tombstones.json` and `.ink/trash/` because `workspaceRoot(dir)` already selects the active bookkeeping root.

## Implementation Steps

1. Ship the first-class CLI delete wrapper on the existing API.
   - Add `Api.deleteDoc(docId)` backed by `DELETE /api/docs/:id`.
   - Add `glyphdown rm <file>` and alias `glyphdown delete <file>`.
   - Resolve tracked files through `findWorkspace`.
   - Archive/remove the local markdown file, remove `.glyphdown/<docId>/` active metadata, and write a tombstone only after the server delete succeeds.
   - Add fake-server support and CLI tests proving the deleted doc is not re-pulled on the next sync because its active metadata is gone.

2. Add server conditional delete support for safer non-force deletes and sync-driven delete propagation.
   - Document `DELETE /api/docs/:id` in protocol comments.
   - Add DocDO hash-check/prepared-delete admin endpoint.
   - Teach Worker delete route to honor the precondition header/body for CLI requests.
   - Add router/DO tests for hash match, hash mismatch, forced delete, non-owner delete, and live client teardown.

3. Extend CLI API methods for preconditioned deletes.
   - `deleteDoc(docId, {baseHash?, force?})`, keeping the no-options form working against today's server.
   - `restoreDoc(docId)` if adding restore.
   - Map 409 `content-changed` to a clear `CliError`.

4. Add workspace delete helpers.
   - Local archive movement.
   - Tombstone read/write.
   - Active doc state removal.
   - Unit tests for old `.glyphdown` and legacy `.ink` roots.

5. Harden `glyphdown rm` once preconditions exist.
   - Compare local hash, base hash, and remote hash.
   - Refuse remote-changed deletes unless `--force`.
   - Send content preconditions for non-force deletes.
   - Keep JSON and human output stable.

6. Refactor sync delete decisions.
   - Extract a pure `decideTrackedDocDelete` helper to keep the matrix testable.
   - Replace the missing-local re-pull branch in `reconcileTracked`.
   - Replace the remote-gone branch with prune/archive behavior.
   - Preserve `--restore-missing` as an explicit call path for the old behavior.

7. Update recursive mirror sync.
   - Detect likely hand-renames before creating untracked docs or applying local deletes.
   - Ensure tracked remote-gone pruning runs before new server doc discovery, so filename reuse works.
   - Prefix new action paths the same way existing mirror results do.

8. Update docs and generated skill content.
   - `SPEC.md` section 8.
   - `packages/cli/README.md`.
   - `docs/agent-guide.md`.
   - `skills/glyphdown/SKILL.md` and regenerated `packages/cli/src/skill-content.gen.ts` if that is still generated from the skill.

9. Run validation.
   - `pnpm --filter glyphdown test`.
   - `pnpm --filter glyphdown typecheck`.
   - `pnpm --filter web test` for API/DO delete precondition tests.
   - `pnpm -r typecheck`, `pnpm -r test`, and `pnpm --filter web build` before landing the full implementation.

## Conflict Matrix

| Case | Default sync | With `--apply-deletes` | With `--apply-deletes --force-deletes` |
|---|---|---|---|
| Local tracked file missing, remote unchanged | `delete-pending`, exit 1 | server soft-delete, remove local state, `deleted` | same |
| Local tracked file missing, remote changed | `delete-conflict`, exit 1 | `delete-conflict`, exit 1 | server soft-delete, remove local state, `deleted` |
| Local tracked file missing, remote already gone | remove stale state, `forgotten` | same | same |
| Remote gone, local clean | archive/remove local, remove state, `remote-deleted` | same | same |
| Remote gone, local changed | archive to conflicts, remove state, `remote-gone-local-saved`, exit 1 | same | same |
| Missing tracked file plus untracked `.md` same dir | `rename-suspected`, exit 1; no create/delete | same | same |
| Delete requested by non-owner | `delete-forbidden`, exit 1 | same | same |
| Local file exists but empty | normal local edit/push path | normal local edit/push path | normal local edit/push path |

## Backwards Compatibility

- Server support is additive. Older CLIs keep their current behavior against the updated server.
- New CLIs should fail safe if the server lacks conditional delete support. For `sync --apply-deletes`, do not fall back to unconditional delete on an older server.
- `glyphdown rm --force` can use the unconditional delete route because the user explicitly chose a destructive single-doc action.
- `glyphdown rm` without precondition support can still ship as an explicit wrapper over today's delete route, but `sync --apply-deletes` should fail safe until conditional delete is available.
- Existing workspaces need no migration. Tombstones appear only after the new CLI finalizes a delete.
- Removing active per-doc metadata after a finalized delete prevents old CLIs from re-pulling that doc in the same workspace.
- `sync --json` consumers must tolerate new action strings. The field shape should remain `{docId, file, action, failedHunks?, message?}` with optional `archivedPath`.

## Rollout

1. Ship CLI explicit delete support first.
   - Add `glyphdown rm` / `glyphdown delete` over the existing remote delete API plus local tracking cleanup.
   - Archive/remove the local file and remove `.glyphdown/<docId>/` active metadata after successful remote delete.
   - Verify a deleted doc is not re-pulled on the next sync.

2. Ship server conditional delete support.
   - No sync default changes yet.
   - Verify web delete/restore still works.

3. Ship sync delete options.
   - Add `sync --apply-deletes` and `sync --restore-missing`.
   - Keep old missing-file default for one release if a softer rollout is desired, but emit a warning that automatic re-pull will change.

4. Flip sync default for missing local tracked files.
   - Missing tracked files become `delete-pending` instead of `repulled`.
   - Remote-gone clean files are pruned/archived instead of left tracked.
   - Update `SPEC.md`, README, agent guide, and skill content in the same release.

5. Watch support signals.
   - Count `delete-pending`, `delete-conflict`, `deleted`, and `remote-gone-local-saved` actions via CLI analytics if available.
   - Revisit asset delete propagation only after document delete semantics are stable.

## Open Product Questions

1. Should `glyphdown sync --apply-deletes` be aliased to `glyphdown sync --delete`, or is the longer flag worth the clarity?
2. Should clean remote-gone local files be archived by default or simply removed? Archiving is safer, removal is quieter.
3. Should `glyphdown restore <docId>` ship with `glyphdown rm`, or is web UI restore enough for the first pass?
4. How long should local tombstones remain? The initial recommendation is "forever until manually cleaned" because the files are small.
