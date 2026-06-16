# HTML Comments Plan — Validation Report (gpt-5.5 via omegacode)

## 1. Executive verdict

The plan is **sound-with-fixes overall, but with flawed sections and real blockers**. The direction is plausible: asset-side comments, a per-asset Durable Object, structural HTML anchors, and injected iframe tooling can fit Glyphdown’s architecture. However, the current plan is not implementation-ready. It under-specifies asset identity/routing, asset authorization, opaque-origin iframe security, Worker-side HTML parsing, R2/D1/DO consistency, and the degree of refactor needed to reuse existing markdown comment code. Confidence is **high** that the identified blockers must be resolved before implementation; confidence is **medium-high** that the architecture will be workable after those corrections.

## 2. Must-fix list

### Blocking

1. **§2 — Asset-id DO keying does not match current asset routes ·** The plan keys `HtmlDocDO` by asset id but current HTML viewer/raw asset APIs address assets by `folderId + filename`, and folder reads can fall back to legacy doc-scoped rows. Without resolving the exact `AssetRow` first, comments can attach to the wrong asset. · **Correction:** add an explicit Worker resolver from folder/doc scope plus filename to the same asset row used by raw streaming, including legacy fallback, then key `HtmlDocDO` by `row.id`. · **Evidence:** `apps/web/src/routes/f.$folderId_.file.$filename.tsx:15`, `apps/web/src/routes/f.$folderId_.file.$filename.tsx:23`, `apps/web/src/routes/f.$folderId_.file.$filename.tsx:71`, `apps/web/src/routes/f.$folderId_.file.$filename.tsx:126`, `apps/web/src/lib/api.ts:498`, `apps/web/src/lib/api.ts:502`, `apps/web/src/api/router.ts:684`, `apps/web/src/api/assets.ts:266`, `apps/web/src/api/assets.ts:268`.

2. **§2 — Missing routing bridge from filename routes to asset-id DO ·** Current folder asset reads use `/api/folders/:id/assets/:filename` and include legacy doc-scoped fallback resolution. A per-asset DO cannot be reached correctly until the Worker resolves the asset row first. · **Correction:** define `HtmlDocDO` comment routes that call the same asset-resolution logic as `streamAsset`, then call `getServerByName(HtmlDocDO, row.id)`. · **Evidence:** `apps/web/src/api/assets.ts:62-64`, `apps/web/src/api/assets.ts:123-131`, `apps/web/src/routes/f.$folderId_.file.$filename.tsx:15`.

3. **§2 — Existing PartyServer routing cannot be reused unchanged ·** Current `/parties/*` routing is doc-sync-oriented and authenticates a path segment as a `docId`; asset comments need folder/asset auth and share-token semantics. · **Correction:** add a separate asset comment live route or non-PartyServer channel with asset-aware auth before forwarding trusted headers. · **Evidence:** `apps/web/src/server.ts:40-49`.

4. **§4 — `FORWARDABLE` cannot simply be extended for asset comments ·** `FORWARDABLE` is only applied inside `/api/docs/:id`; folder asset routes are handled separately, and current asset handlers only match `/assets/:filename` exactly, so nested `/comments` routes would 404. · **Correction:** add explicit asset-comment routing in doc/folder asset paths, or create a real `/api/assets/:assetId` route after resolving D1 asset metadata and access. · **Evidence:** `apps/web/src/api/router.ts:53`, `apps/web/src/api/router.ts:114`, `apps/web/src/api/router.ts:236`, `apps/web/src/api/router.ts:307`, `apps/web/src/api/router.ts:669`, `apps/web/src/api/router.ts:720`, `apps/web/src/api/assets.ts:228`, `apps/web/src/api/assets.ts:266`.

5. **§7 — Historical/comment markers cannot rely on parent DOM access ·** The iframe is sandboxed with `allow-scripts` and no `allow-same-origin`; raw HTML responses also set CSP sandboxing, so parent code cannot inspect or mutate the iframe DOM for historical markers. · **Correction:** use server-side instrumentation or an injected script/postMessage protocol that works under opaque-origin sandboxing. · **Evidence:** `apps/web/src/routes/f.$folderId_.file.$filename.tsx:121`, `apps/web/src/routes/f.$folderId_.file.$filename.tsx:123`, `apps/web/src/api/assets.ts:358`, `apps/web/src/api/assets.ts:359`.

6. **§9 — First-reupload version backfill can destroy legacy bytes ·** Current overwrite writes to the existing `r2Key` before updating the row. If first-version backfill happens after overwrite, the old bytes are gone. · **Correction:** on overwrite of a legacy asset, read/copy existing bytes to the content-addressed v1 key before writing the new object. · **Evidence:** `apps/web/src/db/schema.ts:285`, `apps/web/src/api/assets.ts:62`, `apps/web/src/api/assets.ts:309`.

7. **§12 — Injected runtime security is a blocker, not a minor risk ·** If commenting mode preserves user scripts, user HTML shares the same DOM and JS global as the injected runtime and can spoof/tamper with runtime communication. If CSP is tightened to nonce only the runtime, JS-driven HTML dashboards may break. · **Correction:** explicitly choose between preserving user script execution with a hardened untrusted-message model, or disabling user scripts in commenting mode with clear product tradeoffs. · **Evidence:** `apps/web/src/routes/f.$folderId_.file.$filename.tsx:121`, `apps/web/src/routes/f.$folderId_.file.$filename.tsx:123`, `apps/web/src/api/assets.ts:358`, `apps/web/src/api/assets.ts:359`.

8. **Cross-cutting — Injected first-party runtime shares the iframe realm with user HTML ·** User scripts can forge `gd:*` messages, observe messages, and potentially see share tokens embedded in iframe URLs; opaque-origin frames make origin checks insufficient. · **Correction:** treat iframe messages as untrusted UI hints, server-validate anchors against stored bytes, do not let client resolve failures mutate persisted state, and consider blocking user scripts in comment mode or using a separated wrapper architecture. · **Evidence:** `apps/web/src/routes/f.$folderId_.file.$filename.tsx:121-126`, `apps/web/src/api/assets.ts:358-360`, `apps/web/src/lib/api.ts:494-505`.

### Major

9. **§1 — Asset resolution semantics are underspecified ·** A per-asset `HtmlDocDO` keyed by asset id must resolve `folderId + filename` to the same `AssetMeta.id` as viewer/raw reads, including legacy doc-scoped fallback rows. · **Correction:** specify one asset-resolution helper for comment endpoints and viewer bootstrapping, reusing merged asset-listing semantics. · **Evidence:** `packages/cli/src/assets.ts:188`, `packages/cli/src/assets.ts:193`, `packages/cli/src/assets.ts:197`, `packages/cli/src/assets.ts:208`, `packages/cli/src/assets.ts:211`, `packages/cli/src/assets.ts:212`, `packages/protocol/src/index.ts:380`, `packages/protocol/src/index.ts:387`.

10. **§1 — Asset comment permissions are undefined ·** Assets have no own ACL surface; docs and folders have distinct role/share-link models. · **Correction:** define permission derivation explicitly: folder-scoped assets use effective folder role/share token; doc-scoped legacy assets use owning doc role or resolved containing-folder role when exposed through fallback. · **Evidence:** `apps/web/src/db/schema.ts:201`, `apps/web/src/db/schema.ts:223`, `apps/web/src/db/schema.ts:238`, `apps/web/src/db/schema.ts:255`.

11. **§1 — Iframe runtime must account for opaque origin ·** The iframe omits `allow-same-origin`, and asset responses set CSP sandbox `allow-scripts`, so parent DOM access and same-origin assumptions are invalid. · **Correction:** require an injected in-frame runtime, parent-side validation by `event.source` plus nonce/session token, and no same-origin DOM APIs. · **Evidence:** `apps/web/src/routes/f.$folderId_.file.$filename.tsx:8`, `apps/web/src/routes/f.$folderId_.file.$filename.tsx:15`, `apps/web/src/routes/f.$folderId_.file.$filename.tsx:121`, `apps/web/src/routes/f.$folderId_.file.$filename.tsx:123`, `apps/web/src/api/assets.ts:358`, `apps/web/src/api/assets.ts:359`.

12. **§2 — Sidecar logic is not mostly anchor-type-agnostic today ·** `sidecar.ts` is tightly coupled to `Y.Text` and `@glyphdown/core` text anchors; resolving is DocDO-local `handleResolve`, not an exported sidecar `resolve`. · **Correction:** describe this as a refactor into an anchor strategy abstraction, not an existing mostly-generic extension point. · **Evidence:** `packages/sync/src/sidecar.ts:1`, `packages/sync/src/sidecar.ts:2`, `packages/sync/src/sidecar.ts:45`, `packages/sync/src/sidecar.ts:55`, `packages/sync/src/sidecar.ts:105`, `packages/sync/src/sidecar.ts:139`, `packages/sync/src/sidecar.ts:148`, `packages/sync/src/do.ts:588`.

13. **§2 — `CommentsSidebar` is not reusable as-is ·** It imports text `Anchor`/`Range`, requires `resolveRange(anchor: Anchor)`, sorts by text range, and creates comments from text ranges. · **Correction:** extract reusable thread-list UI plus separate text-anchor and node-anchor adapters, or make sidebar props polymorphic. · **Evidence:** `apps/web/src/components/editor/CommentsSidebar.tsx:5`, `apps/web/src/components/editor/CommentsSidebar.tsx:6`, `apps/web/src/components/editor/CommentsSidebar.tsx:37`, `apps/web/src/components/editor/CommentsSidebar.tsx:80`, `apps/web/src/components/editor/CommentsSidebar.tsx:94`, `apps/web/src/components/editor/CommentsSidebar.tsx:107`.

14. **§2 — Upload hook cannot call `HtmlDocDO` without new env wiring ·** `uploadAsset` is private to `assets.ts`, and current router passes only `ASSETS` into asset handlers; no `HtmlDocDO` namespace is typed or threaded into this layer. · **Correction:** add `HtmlDocDO` to env types and pass/access the namespace explicitly before claiming upload hooks can call it. · **Evidence:** `apps/web/src/api/assets.ts:205`, `apps/web/src/api/assets.ts:223`, `apps/web/src/api/assets.ts:245`, `apps/web/src/api/assets.ts:262`, `apps/web/src/api/assets.ts:283`, `apps/web/src/api/assets.ts:290`.

15. **§2 — No-Y.Doc `HtmlDocDO` cannot reuse DocDO’s YServer behavior directly ·** `DocDO` extends `YServer`, persists Yjs updates, and broadcasts through YServer custom messages. The plan says `HtmlDocDO` has no `Y.Doc` but wants low-latency multiplayer broadcast. · **Correction:** use plain PartyServer `Server` or raw DO WebSockets for comment events, or explicitly keep a `Y.Doc` and explain why. · **Evidence:** `packages/sync/src/do.ts:108`, `packages/sync/src/do.ts:116`, `packages/sync/src/do.ts:170`, `packages/sync/src/do.ts:177`.

16. **§2 — Server-side HTML runtime injection is more invasive than stated ·** `streamAsset` returns the R2 body unchanged and sets `content-length` from object size; injecting script changes bytes and invalidates raw response headers. · **Correction:** add a distinct commenting stream path that buffers or safely rewrites HTML and owns response headers separately from raw `streamAsset`. · **Evidence:** `apps/web/src/api/assets.ts:350`, `apps/web/src/api/assets.ts:352`, `apps/web/src/api/assets.ts:362`.

17. **§2 — CSP nonce design may break uploaded scripts ·** If commenting mode allows only the injected nonce-pinned script, existing author scripts would be blocked, conflicting with the current HTML viewer behavior. · **Correction:** decide whether commenting mode intentionally disables author scripts or must preserve existing script behavior under sandbox constraints. · **Evidence:** `apps/web/src/api/assets.ts:358`, `apps/web/src/api/assets.ts:359`, `apps/web/src/routes/f.$folderId_.file.$filename.tsx:121`, `apps/web/src/routes/f.$folderId_.file.$filename.tsx:123`.

18. **§2 — Opaque-origin postMessage security protocol is missing ·** The plan says postMessage works across opaque origins but does not define authentication. · **Correction:** validate `event.source` against iframe `contentWindow` and require a per-view channel nonce in all `gd:*` messages. · **Evidence:** `apps/web/src/routes/f.$folderId_.file.$filename.tsx:121`, `apps/web/src/routes/f.$folderId_.file.$filename.tsx:123`.

19. **§2 — `HtmlDocDO` cannot fetch/parse by asset id alone ·** The R2 key is stored in the D1 asset row, not derivable from asset id; current `SyncEnv` only includes DB/ASSETS for assignability and `DocDO` does not use them. · **Correction:** pass etag/content/r2Key from the Worker upload hook or let `HtmlDocDO` query D1/R2 through a documented internal API. · **Evidence:** `apps/web/src/db/schema.ts:285`, `packages/sync/src/do.ts:122`, `packages/sync/src/do.ts:124`.

20. **§3 — Node-anchor threshold semantics are unspecified ·** Existing text anchoring has two thresholds: `REANCHOR_THRESHOLD = 0.5` and `FUZZY_ACCEPT_THRESHOLD = 0.8`; the plan does not say which applies to node scoring. · **Correction:** specify separate node thresholds for path/fingerprint validation and fuzzy fallback, or explicitly reuse existing constants with rationale. · **Evidence:** `packages/core/src/quote.ts:16`.

21. **§3 — Text reattach does not generalize directly to node comments ·** Current reattach validates a `{start,end}` range against `Y.Text` and replaces `comment.anchor` with a new text anchor. · **Correction:** define HTML reattach as a new flow taking a `NodeAnchor` or selected element payload. · **Evidence:** `packages/sync/src/sidecar.ts:104`.

22. **§3 — `NodeAnchor` is weaker than Y.RelativePosition identity ·** HTML path/fingerprint anchors are deterministic lookup over rewritten blobs, not CRDT identity surviving live edits. · **Correction:** frame `NodeAnchor` as best-effort structural/fingerprint anchoring with explicit confidence and uniqueness requirements. · **Evidence:** `packages/core/src/anchor.ts:71`, `packages/core/src/anchor.ts:88`, `packages/core/src/anchor.ts:103`.

23. **§3 — Browser/server resolver parity is under-specified ·** Browser DOM can differ from a server parser on repair, whitespace, namespaces, templates, and script-mutated DOM. · **Correction:** define canonical parser, normalization rules, and fixtures comparing browser runtime resolution against Worker-side resolution. · **Evidence:** `apps/web/src/routes/f.$folderId_.file.$filename.tsx:121`, `apps/web/src/api/assets.ts:350`.

24. **§3 — Worker-compatible DOM parser is not chosen ·** There is no direct runtime HTML parser dependency in web/core packages. · **Correction:** choose an explicit Worker-safe parser, validate under workerd, and document browser differences. · **Evidence:** `packages/sync/package.json:13`, `packages/core/package.json:13`.

25. **§3 — Node scoring lacks load-bearing details ·** The plan lists score ingredients but not weights, thresholds, tie-breaking, or uniqueness margins. · **Correction:** specify formula, minimum score, ambiguity margin, and deterministic tie behavior. · **Evidence:** `packages/core/src/quote.ts:57`, `packages/core/src/quote.ts:84`.

26. **§4 — Notifications are document-specific today ·** `notifyMentions` and `notifyCommentReply` take `DocRow` and emit `docId`/`docTitle` payloads. · **Correction:** refactor around a target descriptor representing docs and assets, with asset id, filename, context, and deeplink fields. · **Evidence:** `apps/web/src/api/router.ts:1511`, `apps/web/src/api/router.ts:1515`, `apps/web/src/api/router.ts:1540`, `apps/web/src/api/router.ts:1542`, `apps/web/src/api/router.ts:1553`, `apps/web/src/api/router.ts:1556`, `apps/web/src/api/router.ts:1588`, `apps/web/src/api/router.ts:1591`, `apps/web/src/api/router.ts:1612`, `apps/web/src/api/router.ts:1614`.

27. **§4 — Proposed `TextAnchorStrategy` is too small ·** Existing creation and reattach depend on `validateRange` and `createAnchor`, not only revalidation. · **Correction:** include create-from-selection, validate existing anchor, and reattach operations in the strategy/store abstraction. · **Evidence:** `packages/sync/src/sidecar.ts:34`, `packages/sync/src/sidecar.ts:45`, `packages/sync/src/sidecar.ts:57`, `packages/sync/src/sidecar.ts:59`, `packages/sync/src/sidecar.ts:104`, `packages/sync/src/sidecar.ts:108`, `packages/sync/src/sidecar.ts:139`, `packages/sync/src/sidecar.ts:148`.

28. **§4 — `HtmlDocDO` needs explicit Worker binding/export wiring ·** Current bindings/env types include only `DocDO` and `SearchDO`. · **Correction:** add class export, app env field, wrangler binding, migration entry, and regenerated worker types as explicit tasks. · **Evidence:** `apps/web/wrangler.jsonc:27`, `apps/web/wrangler.jsonc:44`, `apps/web/wrangler.jsonc:47`, `apps/web/wrangler.jsonc:51`, `apps/web/src/server.ts:16`, `apps/web/src/server.ts:17`.

29. **§4 — Shared `CommentStore` risks mixing markdown suggestions into asset comments ·** Current revalidation handles comments and suggestions and auto-rejects orphaned suggestions; `HtmlDocDO` has no Y.Doc or suggestions. · **Correction:** split comment-only CRUD/storage from markdown-specific suggestion revalidation, or parameterize suggestion support separately. · **Evidence:** `packages/sync/src/do.ts:763`, `packages/sync/src/do.ts:764`, `packages/sync/src/sidecar.ts:146`, `packages/sync/src/sidecar.ts:147`.

30. **§4 — Sandboxed HTML cannot be treated as a normal authenticated app surface ·** Privileged API calls and live events need a parent bridge or same-origin UI surface because HTML is sandboxed. · **Correction:** define postMessage responsibilities, authentication boundary, and whether writes happen from the parent page. · **Evidence:** `apps/web/src/api/assets.ts:358`, `apps/web/src/api/assets.ts:359`.

31. **§4 — Asset update/delete lifecycle is unspecified ·** Upload overwrites R2/D1 metadata without a DO call; delete removes R2 bytes and D1 row without DO cleanup. · **Correction:** specify DO calls on overwrite for reparse/reanchor and on delete for tombstone/cleanup/access behavior. · **Evidence:** `apps/web/src/api/assets.ts:309`, `apps/web/src/api/assets.ts:319`, `apps/web/src/api/assets.ts:365`, `apps/web/src/api/assets.ts:376`.

32. **§5 — Sidebar reuse is overstated ·** `CommentsSidebar` is coupled to doc APIs, `commentsKey(docId)`, Yjs pending positions, text `Anchor -> Range`, and `{ range }` creation. · **Correction:** extract lower-level thread/sidebar UI or inject CRUD/cache/anchor adapters. · **Evidence:** `apps/web/src/components/editor/CommentsSidebar.tsx:8`, `apps/web/src/components/editor/CommentsSidebar.tsx:20`, `apps/web/src/components/editor/CommentsSidebar.tsx:22`, `apps/web/src/components/editor/CommentsSidebar.tsx:37`, `apps/web/src/components/editor/CommentsSidebar.tsx:107`, `apps/web/src/components/editor/CommentsSidebar.tsx:159`.

33. **§5 — More than quote/marker display is HTML-specific ·** Submission, optimistic cache updates, pending comments, reattach eligibility, sorting, and selection resolution are text-editor specific. · **Correction:** specify an HTML adapter for CRUD, pending node/text anchors, document-order sorting, and reattach. · **Evidence:** `apps/web/src/components/editor/CommentsSidebar.tsx:71`, `apps/web/src/components/editor/CommentsSidebar.tsx:98`, `apps/web/src/components/editor/CommentsSidebar.tsx:102`, `apps/web/src/components/editor/CommentsSidebar.tsx:156`, `apps/web/src/components/editor/CommentsSidebar.tsx:172`.

34. **§5 — `NodeAnchor.label` and HTML text-region fields do not exist ·** Current protocol only has `Comment.anchor: Anchor | null`, and `Anchor` is text/Yjs-shaped. · **Correction:** add and thread through an explicit node-anchor shape before relying on label/text-region rendering. · **Evidence:** `packages/protocol/src/index.ts:47`, `packages/protocol/src/index.ts:50`, `packages/core/src/anchor.ts:10`, `packages/core/src/anchor.ts:11-18`, `packages/core/src/quote.ts:4-7`.

35. **§5 — Mobile bottom sheet is not reusable as-is ·** It is embedded directly in `DocEditorPage` state/JSX. · **Correction:** extract a shared sheet shell or explicitly duplicate behavior in the HTML viewer. · **Evidence:** `apps/web/src/components/editor/DocEditorPage.tsx:179-181`, `apps/web/src/components/editor/DocEditorPage.tsx:1020-1022`.

36. **§5 — HTML document-order navigation is unspecified ·** Existing sidebar ordering depends on resolved text ranges; node comments have no `range.start`. · **Correction:** have iframe runtime or server provide a stable document-order key. · **Evidence:** `apps/web/src/components/editor/CommentsSidebar.tsx:98`.

37. **§6 — Asset commenter enforcement is proposed, not existing ·** No asset comment endpoints exist; current protocol/router expose doc comment routes only. · **Correction:** phrase as required new behavior and define asset comment routes/forwarding to `HtmlDocDO`. · **Evidence:** `packages/protocol/src/index.ts:86`, `packages/protocol/src/index.ts:100`, `packages/protocol/src/index.ts:380`, `packages/protocol/src/index.ts:393`, `apps/web/src/api/assets.ts:266`.

38. **§6 — Asset share links do not exist ·** `share_links.target_type` is only `doc` or `folder`; folder share-token asset reads are GET-only today. · **Correction:** say folder share links can authorize contained HTML asset comments; independent asset share links require schema/protocol changes. · **Evidence:** `apps/web/src/db/schema.ts:255`, `apps/web/src/db/schema.ts:260`, `apps/web/src/api/router.ts:681`, `apps/web/src/api/router.ts:694`, `apps/web/src/api/router.ts:793`, `apps/web/src/api/router.ts:816`.

39. **§6 — `textRange` and `clientResolveOnly` are not current fields ·** Current `Comment.anchor` is `Anchor | null`; `CreateCommentRequest` has only `body` and optional `range`. · **Correction:** specify the new protocol shape explicitly. · **Evidence:** `packages/protocol/src/index.ts:47`, `packages/protocol/src/index.ts:58`, `packages/protocol/src/index.ts:121`, `packages/protocol/src/index.ts:125`, `packages/core/src/anchor.ts:10`, `packages/core/src/anchor.ts:19`.

40. **§6 — Upload-time `revalidateHtmlAnchors` does not exist ·** Current anchor revalidation is markdown/Y.Text-specific, and no `HtmlDocDO` exists. · **Correction:** mark as proposed new implementation and define the upload hook plus DO endpoint. · **Evidence:** `packages/sync/src/sidecar.ts:139`, `packages/sync/src/sidecar.ts:143`, `apps/web/wrangler.jsonc:27`, `apps/web/wrangler.jsonc:52`.

41. **§6 — `clientResolveOnly` creates authority ambiguity ·** If an anchor only exists after browser JS runs, the server cannot revalidate it on upload. · **Correction:** define whether client-only anchors are display-only, whether clients may persist refreshed positions, and what validation `HtmlDocDO` performs. · **Evidence:** `apps/web/src/routes/f.$folderId_.file.$filename.tsx:121`, `apps/web/src/api/assets.ts:350`.

42. **§7 — Current assets are not simply overwrite-only ·** Same-name upload overwrites only with `overwrite=true`; otherwise it creates a suffixed filename. · **Correction:** say current CLI changed-asset pushes overwrite in place, while non-overwrite uploads create suffixed names. · **Evidence:** `apps/web/src/api/assets.ts:305`, `apps/web/src/api/assets.ts:309`, `apps/web/src/api/assets.ts:322`, `apps/web/src/api/assets.ts:337`.

43. **§7 — `assets.current_version_id` does not exist ·** Current `assets` metadata has no current-version pointer and `AssetMeta` exposes no version identifier. · **Correction:** add a D1 migration, schema field, protocol fields/types, and backfill behavior explicitly. · **Evidence:** `apps/web/src/db/schema.ts:277`, `apps/web/src/db/schema.ts:285`, `apps/web/src/db/schema.ts:291`, `packages/protocol/src/index.ts:395`.

44. **§7 — Nested asset version routes do not work today ·** Current asset handlers match exactly `/assets/<filename>`; nested version paths would return not-found. · **Correction:** add nested route matching in doc and folder asset handlers, or choose query-based version access. · **Evidence:** `apps/web/src/api/assets.ts:219`, `apps/web/src/api/assets.ts:228`, `apps/web/src/api/assets.ts:258`, `apps/web/src/api/assets.ts:266`.

45. **§7 — ETag/hash dedup story is imprecise ·** Existing metadata stores R2 `etag`; CLI treats single-part etags as MD5. The plan proposes SHA-256 content hashes. · **Correction:** use explicit server-computed SHA-256 `content_hash` for version identity and keep `etag` for HTTP/cache/sync change detection. · **Evidence:** `apps/web/src/api/assets.ts:314`, `apps/web/src/api/assets.ts:333`, `packages/protocol/src/index.ts:401`, `packages/cli/src/assets.ts:120`, `packages/cli/src/assets.ts:318`, `packages/cli/src/assets.ts:328`.

46. **§7 — R2 key and cross-asset dedup are internally inconsistent ·** Example key `assets/{assetId}/v/{sha256}` includes `assetId`, so identical bytes across assets still have different keys. · **Correction:** use global `asset-blobs/sha256/<hash>` for cross-asset dedup, or scope dedup/refcounting to one asset. · **Evidence:** `docs/plans/html-comments.md:424-425`.

47. **§7 — Restore semantics conflict with identical-byte dedup ·** Identical re-upload creates no new version, but restore should create a new audit row even if it points to existing bytes. · **Correction:** dedupe blob bytes, not necessarily version rows; restore should create a new version row with source metadata unless already current. · **Evidence:** `docs/plans/html-comments.md:400-407`.

48. **§7 — Diff-driven re-anchor lacks Worker/DO parser design ·** Current code has markdown revalidation over Y.Text but no HTML parser or DOM diff layer server-side. · **Correction:** name parser/diff library, runtime target, fallback behavior, and parser/browser mismatch tests. · **Evidence:** `packages/sync/src/do.ts:541`, `packages/cli/src/assets.ts:131`, `packages/cli/src/assets.ts:379`.

49. **§7 — Concurrent upload semantics are undefined ·** Versioning adds `asset_versions` and a current pointer; without transaction/current-predecessor rules, ordering and audit semantics are ambiguous. · **Correction:** use a D1 transaction for insert-version plus current pointer update and define stale-current behavior. · **Evidence:** `apps/web/src/api/assets.ts:309-319`.

50. **§8 — Shadow DOM helpers are not generally server-revalidatable ·** Runtime can inspect open shadow roots, but server/DO revalidator only has uploaded R2 bytes. · **Correction:** limit shadow-DOM helpers to runtime picking/rendering, or support only static/declarative/open shadow DOM under a parser contract. · **Evidence:** `apps/web/src/api/assets.ts:350`.

51. **§8 — Shared browser/server DOM canonicalization is missing ·** Borrowed in-page helpers do not define identical paths, class normalization, or text context across browser and Worker parser. · **Correction:** choose a Worker-compatible parser and put normalization/scoring in a pure package used by both runtime tests and DO revalidation. · **Evidence:** `packages/sync/package.json:13`, `packages/core/package.json:13`.

52. **§8 — Class normalization is overstated ·** CSS-module hash stripping does not solve Tailwind churn and can collapse distinct nodes. · **Correction:** use normalized classes as weak scoring evidence, store raw/normalized classes for diagnostics, and test collision-heavy fixtures. · **Evidence:** `docs/plans/html-comments.md:434`.

53. **§8 — DOM nearby context is not equivalent to markdown prefix/suffix ·** Markdown quote anchoring is over a single linear string; DOM needs rules for whitespace, hidden nodes, script/style exclusion, traversal, and weighting. · **Correction:** define DOM text extraction and scoring before claiming parity. · **Evidence:** `packages/core/src/quote.ts:3`, `packages/core/src/quote.ts:57`.

54. **§8 — Selector-like paths need canonical grammar ·** `tag#id`/`.class` chains are not inherently unique and lack indexing/root/SVG/template/invalid-HTML rules. · **Correction:** define `NodeAnchor.path` as a canonical grammar with deterministic construction and matching. · **Evidence:** `docs/plans/html-comments.md:434`.

55. **§9 — Version backfill is underspecified for legacy rows ·** Existing rows require `r2_key`; current overwrite mutates the same R2 key. Legacy reads must support null current version, or old bytes must be copied before overwrite. · **Correction:** specify nullable legacy `current_version_id` handling and exact first-reupload copy-to-v1 sequence. · **Evidence:** `apps/web/src/db/schema.ts:285`, `apps/web/src/api/assets.ts:62`, `apps/web/src/api/assets.ts:309`.

56. **§9 — `HtmlDocDO` requires more than wrangler migration ·** Worker exports and bindings currently include only `DocDO` and `SearchDO`. · **Correction:** add package export, Worker export, binding, env typing, and a new migration tag. · **Evidence:** `apps/web/wrangler.jsonc:27`, `apps/web/wrangler.jsonc:44`, `apps/web/src/server.ts:16`.

57. **§9 — Current `/parties` auth is doc-id based ·** `server.ts` authenticates rooms as docs; asset-scoped DOs need asset/folder role computation. · **Correction:** define separate asset DO route/auth or route discrimination before deployment. · **Evidence:** `apps/web/src/server.ts:40-49`.

58. **§10 — `CommentStore`/strategy parity tests require refactor first ·** `CommentStore`, `TextAnchorStrategy`, and `NodeAnchorStrategy` do not exist; current sidecar APIs are concrete Y.Text/text-range functions. · **Correction:** frame as post-refactor tests. · **Evidence:** `packages/sync/src/sidecar.ts:46`, `packages/sync/src/sidecar.ts:139`.

59. **§10 — Versioning tests depend on missing schema ·** `asset_versions` and `assets.current_version_id` do not exist. · **Correction:** add schema/migration tests before cascade/version behavior tests. · **Evidence:** `apps/web/src/db/schema.ts:277`, `packages/protocol/src/index.ts:395`.

60. **§10 — Node-anchor fuzzing needs a model oracle ·** Random HTML trees need stable model ids or another oracle to prove “never wrong-node.” · **Correction:** generate abstract DOM trees with model ids, render to HTML, apply model-aware edits, and assert expected model id or orphan. · **Evidence:** `packages/core/test/anchor.test.ts:18`, `packages/core/test/anchor.test.ts:52`.

61. **§10 — DOM edit categories are underspecified ·** “Benign,” “small,” and “destructive” do not determine exact tracking, re-anchor, or orphan expectations. · **Correction:** define identity-preserving, ambiguity-producing, and destructive edits with expected outcomes and thresholds. · **Evidence:** `packages/core/src/quote.ts:57`, `packages/core/src/quote.ts:84`.

62. **§10 — Shared resolver needs DOM-independent core ·** Browser runtime has DOM APIs; Worker/DO must parse and score without browser APIs. · **Correction:** put scoring over a normalized parsed-node index in `packages/core`, with adapters for iframe and DO parser. · **Evidence:** `packages/sync/package.json:13`, `packages/core/package.json:13`.

63. **§10 — Diff-driven “never worse” property is too strong ·** Structural diff heuristics can regress on duplicate subtrees, parser recovery, reordered lists, or wrapper churn. · **Correction:** make the invariant “never wrong-node”; measure orphan-rate improvements on fixtures/corpus. · **Evidence:** `docs/plans/html-comments.md:488-490`.

64. **§11 — Phase 0 “zero behavior change” is overstated ·** Current comment behavior is spread across DocDO routing, permission checks, storage ordering, reply notification headers, broadcasts, and Y.Text sidecar code. · **Correction:** treat Phase 0 as risky and add explicit regression coverage for response bodies/statuses, ordering, `HEADER_COMMENT_AUTHOR`, broadcasts, permissions, reattach, and revalidation. · **Evidence:** `docs/plans/html-comments.md:504`, `docs/plans/html-comments.md:505`, `packages/sync/src/do.ts:362`, `packages/sync/src/do.ts:380`, `packages/sync/src/do.ts:567`, `packages/sync/src/do.ts:617`, `packages/sync/src/do.ts:783`, `packages/sync/src/do.ts:799`, `packages/sync/src/do.ts:837`, `packages/sync/src/do.ts:839`, `packages/sync/src/do.ts:583`, `packages/sync/src/do.ts:585`, `packages/sync/src/sidecar.ts:45`, `packages/sync/src/sidecar.ts:59`, `packages/sync/src/sidecar.ts:104`, `packages/sync/src/sidecar.ts:108`, `packages/sync/src/sidecar.ts:139`, `packages/sync/src/sidecar.ts:149`.

65. **§11 — Asset notifications are compressed into the wrong phase ·** Existing mention/reply notification helpers are doc-shaped. · **Correction:** split asset CRUD/forwarding from asset notification design, including payload fields and viewer deep links. · **Evidence:** `docs/plans/html-comments.md:507`, `docs/plans/html-comments.md:508`, `apps/web/src/api/router.ts:311`, `apps/web/src/api/router.ts:321`, `apps/web/src/api/router.ts:1511`, `apps/web/src/api/router.ts:1517`, `apps/web/src/api/router.ts:1540`, `apps/web/src/api/router.ts:1547`, `apps/web/src/api/router.ts:1588`, `apps/web/src/api/router.ts:1593`.

66. **§11 — Versioning is only partly independent ·** Asset-history storage can land earlier, but diff-driven re-anchor depends on asset comments, node anchors, comment version provenance, and `HtmlDocDO`. · **Correction:** split asset history/versioned streaming from later comment-version integration and diff-driven reanchor. · **Evidence:** `docs/plans/html-comments.md:513`, `docs/plans/html-comments.md:515`, `docs/plans/html-comments.md:400`, `docs/plans/html-comments.md:407`, `packages/protocol/src/index.ts:47`, `packages/protocol/src/index.ts:58`, `packages/sync/src/do.ts:763`, `packages/sync/src/do.ts:777`.

67. **§11 — Phase 2 says doc-level comments plus upload re-anchor ·** Doc-level comments have no anchors to revalidate. · **Correction:** split doc-level asset comment CRUD from upload-hook/server-parser/fingerprint-cache work, which becomes useful only once node anchors exist. · **Evidence:** `docs/plans/html-comments.md:507-515`.

68. **§12 — First-class docs do not give asset share links/history for free ·** Share links target only docs/folders, and markdown history stores text plus Yjs state vector, not R2-backed HTML bytes. · **Correction:** say first-class docs may reuse more ACL/history surfaces, but HTML history and asset migration still need design. · **Evidence:** `docs/plans/html-comments.md:534`, `docs/plans/html-comments.md:535`, `apps/web/src/db/schema.ts:255`, `apps/web/src/db/schema.ts:260`, `packages/sync/src/do.ts:179`, `packages/sync/src/do.ts:182`, `packages/sync/src/do.ts:691`.

69. **§12 — Shared sidecar core is a non-trivial refactor ·** Current helpers are strongly Y.Text/text-anchor-specific. · **Correction:** treat shared comment core as substantial refactor work, not a light generalization. · **Evidence:** `packages/sync/src/sidecar.ts:46`, `packages/sync/src/sidecar.ts:59`, `packages/sync/src/sidecar.ts:105`, `packages/sync/src/sidecar.ts:108`, `packages/sync/src/sidecar.ts:139`, `packages/sync/src/sidecar.ts:148`, `packages/sync/src/do.ts:567`, `packages/sync/src/do.ts:612`.

70. **§12 — Asset comment live routing/auth risk is missing ·** Current live routing is doc-centric and authenticates `docId`; asset comments need asset/folder access and probably a new party namespace or transport. · **Correction:** add explicit risk and decide REST-only, poll-based, or new PartyServer route. · **Evidence:** `apps/web/src/server.ts:40-49`, `apps/web/src/api/router.ts:1671-1691`.

71. **§12 — Worker-side DOM parsing is more severe for JS-rendered HTML ·** Server parsing sees static R2 bytes; browser runtime may see nodes created or moved by scripts. · **Correction:** define behavior for runtime-only nodes: no server guarantee, static-only anchors, or persisted runtime structure with validation. · **Evidence:** `apps/web/src/api/assets.ts:350`, `apps/web/src/routes/f.$folderId_.file.$filename.tsx:121`.

72. **§12 — HTML history/versioning is undercalibrated ·** Existing versions are markdown/Yjs-specific; asset sync has no R2 blob history or merge semantics. · **Correction:** split versioning into a separate substantial workstream with explicit storage, pruning, and restore semantics. · **Evidence:** `packages/sync/src/do.ts:179`, `packages/sync/src/do.ts:182`, `packages/sync/src/do.ts:691`, `packages/cli/src/assets.ts:131`, `packages/cli/src/assets.ts:379`.

## 3. Per-section table

| Section | Verdict | Blocking | Major | Key issue |
|---|---:|---:|---:|---|
| §1 — Problem & current state | sound-with-fixes | 0 | 3 | Asset identity, permissions, and opaque-origin iframe implications need to be stated precisely. |
| §2 — Architecture overview | flawed | 2 | 7 | The architecture misses the folder/filename-to-asset-id bridge and overstates reuse of DocDO/sidecar/sidebar infrastructure. |
| §3 — Stable node identifiers | sound-with-fixes | 0 | 7 | `NodeAnchor` needs explicit thresholds, scoring, parser parity, and reattach semantics. |
| §4 — Data model & API changes | flawed | 1 | 7 | Asset comment routing, notification payloads, strategy interface, DO wiring, and lifecycle behavior are underdesigned. |
| §5 — UI / UX | sound-with-fixes | 0 | 7 | `CommentsSidebar` is not reusable almost verbatim; HTML comments need adapters, node protocol fields, and document-order keys. |
| §6 — Edge cases | sound-with-fixes | 0 | 8 | Several proposed HTML fields/endpoints are described as if they exist, and iframe/client-only authority is unresolved. |
| §7 — HTML document versioning | sound-with-fixes | 1 | 9 | Version storage, route matching, hash semantics, restore audit semantics, and iframe marker rendering need redesign. |
| §8 — Useful ideas from agentation | sound-with-fixes | 0 | 6 | External DOM-helper ideas need canonical browser/server semantics and cannot be treated as server-revalidatable as-is. |
| §9 — Migration / backfill | sound-with-fixes | 1 | 3 | First-reupload backfill can lose bytes; DO wiring and asset auth routing are incomplete. |
| §10 — Testing plan | sound-with-fixes | 0 | 8 | Tests depend on missing abstractions and need a model oracle, parser contract, auth matrix, and migration coverage. |
| §11 — Rollout | sound-with-fixes | 0 | 7 | The rollout compresses risky refactors, notifications, versioning, and node reanchor dependencies. |
| §12 — Risks & open questions | sound-with-fixes | 1 | 6 | Runtime injection security, postMessage auth, asset live routing, dynamic DOM, and versioning risk are understated. |

## 4. Cross-cutting concerns

### Contradictions

1. **Asset id vs filename-addressed asset surface ·** The plan keys `HtmlDocDO` by asset id, but implemented public asset routes are folder/doc scope plus filename, with folder reads able to fall back to legacy doc-scoped rows. These are not equivalent unless the Worker resolves the exact `AssetRow` first and keys the DO by that row id. · **Evidence:** `docs/plans/html-comments.md:63`, `docs/plans/html-comments.md:225-227`, `apps/web/src/api/assets.ts:62-64`, `apps/web/src/api/assets.ts:123-131`, `apps/web/src/routes/f.$folderId_.file.$filename.tsx:15`.

2. **HTML comments in DO vs versions in D1/R2 ·** The plan puts comments/provenance in `HtmlDocDO` but asset versions in D1/R2. Current architecture keeps sidecar bodies and markdown history in the DocDO, with D1 limited to cross-document metadata. That creates cross-store invariants like `comment.versionId` referencing D1 version rows without transaction/reconciliation design. · **Evidence:** `docs/plans/html-comments.md:63-66`, `docs/plans/html-comments.md:348-360`, `SPEC.md:56-58`, `packages/sync/src/do.ts:177-182`.

3. **Server/browser parity vs client-only dynamic anchors ·** The plan requires server-side re-anchoring to match browser runtime resolution, but also allows dynamic/script-rendered anchors that only exist in the browser and are marked `clientResolveOnly`. · **Evidence:** `docs/plans/html-comments.md:192-196`, `docs/plans/html-comments.md:307-311`, `docs/plans/html-comments.md:488-490`.

4. **Versioning as re-anchor enabler vs late rollout ·** Versioning is described as materially improving and enabling diff-driven comment re-anchoring, but rollout places versioning after `HtmlDocDO`, API, and node-level UI. Either early phases ship with lower-quality fingerprint-only anchoring, or versioning must move earlier. · **Evidence:** `docs/plans/html-comments.md:333-334`, `docs/plans/html-comments.md:400-403`, `docs/plans/html-comments.md:507-515`.

5. **Sidebar reuse claim vs current component coupling ·** The plan says `CommentsSidebar` can be reused almost verbatim, but current code is coupled to markdown text anchors, Y.RelativePosition pending state, docId APIs, text selection resolution, and text-range reattach. · **Evidence:** `docs/plans/html-comments.md:260-264`, `apps/web/src/components/editor/CommentsSidebar.tsx:22-44`, `apps/web/src/components/editor/CommentsSidebar.tsx:80-107`, `apps/web/src/components/editor/CommentsSidebar.tsx:156-164`.

### Ranked feasibility risks

1. **Blocking — Injected runtime trust boundary ·** First-party runtime runs in the same sandboxed iframe JS realm as user-authored HTML. User scripts can forge `gd:*` messages, observe messages, and see share tokens embedded in iframe URLs; opaque origin makes origin checks insufficient. · **Mitigation:** treat iframe messages as untrusted UI hints, server-validate anchors against stored bytes before create/reattach, avoid client resolve failures mutating persisted status, and consider blocking user scripts in comment mode or using a separated wrapper. · **Evidence:** `apps/web/src/routes/f.$folderId_.file.$filename.tsx:121-126`, `apps/web/src/api/assets.ts:358-360`, `apps/web/src/lib/api.ts:494-505`.

2. **Major — `HtmlDocDO` routing and auth ·** Current forwarding is doc-only through `FORWARDABLE` and `forwardToDoc`; folder asset reads are separate and can be anonymous via share links. · **Mitigation:** specify exact REST/WS paths, `AssetRow` resolution, share-token transport, and trusted principal/role headers forwarded to `HtmlDocDO`. · **Evidence:** `apps/web/src/api/router.ts:53-66`, `apps/web/src/api/router.ts:296-298`, `apps/web/src/api/router.ts:684-694`, `apps/web/src/api/router.ts:1671-1691`, `apps/web/src/server.ts:40-49`.

3. **Major — R2/D1/DO consistency ·** Upload currently writes R2 then D1; the plan adds a post-write DO parse/reanchor hook. Failures can leave R2/D1 current while `HtmlDocDO` has stale etag/index/comment state. · **Mitigation:** make reconciliation idempotent, store current etag/version in D1, have `HtmlDocDO` compare cached etag on reads/writes, and add retry/reconcile paths. · **Evidence:** `apps/web/src/api/assets.ts:309-319`, `apps/web/src/api/assets.ts:323-338`, `packages/sync/src/do.ts:122-124`.

4. **Major — Large HTML indexing limits ·** Parsing/indexing 10 MB HTML in Worker/DO can exceed CPU, memory, or SQLite row limits. · **Mitigation:** define max parsed bytes, max node count, max captured text/attrs/classes, chunked index storage, and fallback when indexing is skipped. · **Evidence:** `packages/protocol/src/index.ts:413`, `apps/web/src/api/assets.ts:299-302`, `packages/sync/src/do.ts:51-52`.

5. **Major — Notifications are doc-shaped ·** Mention/reply hooks run in doc forwarding and write `docId`/`docTitle` payloads. Asset comments need `folderId`, `filename`, `assetId`, and viewer deeplinks. · **Mitigation:** introduce a generic `CommentTarget` descriptor. · **Evidence:** `apps/web/src/api/router.ts:311-323`, `apps/web/src/api/router.ts:1511-1547`, `apps/web/src/api/router.ts:1588-1619`.

6. **Major — Live access revocation for asset sockets ·** Existing recheck fanout only calls DocDOs for docs in a folder subtree; `HtmlDocDO` connections would remain live after folder member/share revocation unless a parallel asset fanout exists. · **Mitigation:** add asset-DO recheck/admin calls over folder asset rows and legacy fallback rows, or avoid long-lived sockets until lifecycle support exists. · **Evidence:** `apps/web/src/api/router.ts:533-538`, `apps/web/src/api/router.ts:652-660`, `apps/web/src/api/router.ts:1718-1764`.

7. **Major — Commenting variant changes bytes/headers ·** `streamAsset` forwards raw R2 body with content-length, ETag, and cache-control; same raw URL is used for iframe/open/download. · **Mitigation:** use a distinct commenting endpoint or query variant with separate ETag/content-length/cache-control, keeping raw/open/download pristine. · **Evidence:** `apps/web/src/api/assets.ts:352-362`, `apps/web/src/routes/f.$folderId_.file.$filename.tsx:101-124`.

### Missing concerns

- Asset delete/recreate and Durable Object garbage collection semantics: `deleteAsset` removes R2 bytes and D1 metadata, but a per-asset DO would not cascade automatically; recreating the same filename creates a new asset id. · **Evidence:** `apps/web/src/api/assets.ts:365-376`, `apps/web/src/api/assets.ts:326-338`.

- Asset version GC/refcounting: the plan says content-addressed R2 objects are GC’d by refcount but does not specify a `content_objects`/refcount table or transaction model. · **Evidence:** `docs/plans/html-comments.md:424-425`, `apps/web/src/db/schema.ts:277-297`.

- Open/orphaned comments referencing pruned versions: the plan stores authored-against `versionId` and offers view original version, but also allows pruning old versions. It does not say whether versions referenced by unresolved comments are pinned. · **Evidence:** `docs/plans/html-comments.md:359-360`, `docs/plans/html-comments.md:404-407`, `docs/plans/html-comments.md:411-413`.

- Folder-scoped member autocomplete for asset comments: existing `CommentsSidebar` expects doc members, but folder assets need folder members plus inherited grants/owner, and legacy doc-scoped assets may need different scope handling. · **Evidence:** `apps/web/src/components/editor/CommentsSidebar.tsx:36`, `apps/web/src/lib/api.ts:247-274`.

- Anchor/comment abuse limits: `NodeAnchor` can carry path, attrs, classes, quotes, and context; current comment JSON is stored wholesale in DO SQLite. The plan lacks limits for anchor JSON size, body size, path depth, attribute/class counts, replies per thread, and comments per asset. · **Evidence:** `packages/sync/src/do.ts:794-798`.

- Asset rename/move semantics: assets are currently keyed by normalized filename in a scope, with no rename route. The plan does not define whether comments follow future asset renames/moves or only immutable asset ids.

- Backfill behavior for existing HTML assets before first upload: lazy DO creation and optional versioning backfill leave unclear whether first comment has a `versionId` or whether first re-upload can diff against original bytes.

## 5. Confirmed correct

- Markdown docs are first-class D1 docs with filename, owner/folder metadata, membership ACLs, and share links. · **Evidence:** `apps/web/src/db/schema.ts:178`, `apps/web/src/db/schema.ts:201`, `apps/web/src/db/schema.ts:223`, `apps/web/src/db/schema.ts:238`, `apps/web/src/db/schema.ts:255`.

- Markdown content lives in a per-document `DocDO` as a Y.Text named `content`. · **Evidence:** `packages/sync/src/do.ts:108`, `packages/sync/src/do.ts:116`, `packages/sync/src/do.ts:126`.

- `DocDO` owns comment storage and comment REST routes, with comments stored in DO SQLite. · **Evidence:** `packages/sync/src/do.ts:170`, `packages/sync/src/do.ts:177`, `packages/sync/src/do.ts:362`, `packages/sync/src/do.ts:370`, `packages/sync/src/do.ts:783`, `packages/sync/src/do.ts:794`.

- The Worker forwards doc comment routes to `DocDO`. · **Evidence:** `apps/web/src/api/router.ts:53`, `apps/web/src/api/router.ts:57`, `apps/web/src/api/router.ts:59`, `apps/web/src/api/router.ts:1671`, `apps/web/src/api/router.ts:1680`.

- HTML files are currently assets: bytes in R2, metadata in D1 `assets`. · **Evidence:** `apps/web/src/api/assets.ts:15`, `apps/web/src/api/assets.ts:16`, `apps/web/src/db/schema.ts:277`, `apps/web/src/db/schema.ts:285`, `apps/web/src/db/schema.ts:286`.

- Asset R2 keys are scope-based, e.g. `folder/{folderId}/{filename}` or `doc/{docId}/{filename}`. · **Evidence:** `apps/web/src/api/assets.ts:40`, `apps/web/src/api/assets.ts:47`, `apps/web/src/api/assets.ts:62`, `apps/web/src/api/assets.ts:63`.

- The current HTML viewer renders folder HTML assets in an iframe with `sandbox="allow-scripts"` and intentionally omits `allow-same-origin`. · **Evidence:** `apps/web/src/routes/f.$folderId_.file.$filename.tsx:8`, `apps/web/src/routes/f.$folderId_.file.$filename.tsx:12`, `apps/web/src/routes/f.$folderId_.file.$filename.tsx:121`, `apps/web/src/routes/f.$folderId_.file.$filename.tsx:123`.

- HTML asset responses get CSP `sandbox allow-scripts`. · **Evidence:** `apps/web/src/api/assets.ts:358`, `apps/web/src/api/assets.ts:359`.

- `anchor: null` already means doc-level comment in protocol and UI grouping. · **Evidence:** `packages/protocol/src/index.ts:47`, `packages/protocol/src/index.ts:49`, `packages/protocol/src/index.ts:50`, `packages/protocol/src/index.ts:121`, `packages/protocol/src/index.ts:123`, `packages/sync/src/sidecar.ts:45`, `packages/sync/src/sidecar.ts:55`, `apps/web/src/components/editor/CommentsSidebar.tsx:90`, `apps/web/src/components/editor/CommentsSidebar.tsx:240`.

- Current text anchors use `TextQuote` with `exact`, `prefix`, and `suffix`, relative positions, and fuzzy reanchoring. · **Evidence:** `packages/core/src/anchor.ts:10`, `packages/core/src/anchor.ts:71`, `packages/core/src/anchor.ts:88`, `packages/core/src/anchor.ts:103`, `packages/core/src/quote.ts:3`, `packages/core/src/quote.ts:57`.

- Adding a second SQLite-backed Durable Object class is feasible in this stack, but requires explicit binding/export/migration work. · **Evidence:** `apps/web/wrangler.jsonc:27`, `apps/web/wrangler.jsonc:32`, `apps/web/wrangler.jsonc:39`, `apps/web/wrangler.jsonc:44`, `apps/web/wrangler.jsonc:47`, `apps/web/wrangler.jsonc:51`, `apps/web/src/server.ts:16`, `apps/web/src/server.ts:17`.

- Markdown history is `DocDO`-owned, while asset sync currently does not merge and local wins on both-changed conflicts. · **Evidence:** `packages/sync/src/do.ts:179`, `packages/sync/src/do.ts:396`, `packages/sync/src/do.ts:412`, `packages/sync/src/do.ts:541`, `packages/cli/src/assets.ts:131`, `packages/cli/src/assets.ts:379`.

- The repo already uses fast-check/Vitest for pure core property tests, so node-anchor property tests fit the testing style once a correct oracle/parser contract exists. · **Evidence:** `SPEC.md:280`, `SPEC.md:282`, `packages/core/test/anchor.test.ts:1`, `packages/core/test/merge.test.ts:24`, `packages/core/test/suggestions.test.ts:21`, `packages/core/test/snapshot.test.ts:7`.

## 6. Recommended edits to the plan doc

1. **Make asset identity/routing the first architectural contract.** Define the canonical asset resolver for folder/doc scope plus filename, including legacy doc-scoped fallback, and state that all comment endpoints resolve an `AssetRow` before addressing `HtmlDocDO` by `row.id`.

2. **Add an explicit asset authorization model.** Specify folder-scoped assets, doc-scoped legacy assets, folder share-token reads/comments, commenter/editor gates, revocation behavior, and whether asset-specific share links exist or are deferred.

3. **Rewrite the iframe security model.** Treat all iframe messages as untrusted. Require `event.source` validation, per-view capability tokens or `MessageChannel`, strict schemas, server-side anchor validation, and a product decision on whether commenting mode preserves or blocks user-authored scripts.

4. **Separate raw asset serving from commenting-mode serving.** Keep raw/open/download URLs byte-clean with existing R2 headers. Add a distinct commenting endpoint or query variant with its own CSP, ETag/content-length/cache policy, and injection failure behavior.

5. **Reframe `CommentsSidebar` reuse.** Replace “reuse almost verbatim” with an adapter/refactor plan: presentational thread list, injected CRUD/cache service, pending-anchor model, quote/label renderer, document-order sorting, and text-vs-node reattach behavior.

6. **Define the protocol shape before UI/API details.** Add `NodeAnchor` or a discriminated anchor union, schema version/discriminant, node path grammar, text-region offset units, `clientResolveOnly` semantics if retained, and invariants for mixed text/node anchors.

7. **Choose a Worker-safe HTML parser and canonicalization contract.** Specify parser dependency, normalized node index, whitespace/entity/class/attribute rules, script/style/hidden-node handling, parser/browser parity tests, and dynamic DOM policy.

8. **Specify node scoring and orphan rules.** Include path/fingerprint weights, thresholds, ambiguity margin, tie-breaking, uniqueness requirements, and “never wrong-node” behavior.

9. **Split comment storage from markdown suggestion logic.** Plan the `CommentStore` refactor as risky, with regression tests for markdown comment response bodies, statuses, ordering, broadcasts, headers, permissions, reattach, and post-rewrite revalidation.

10. **Add `HtmlDocDO` wiring checklist.** Include `packages/sync` export, Worker export, env typing, wrangler binding, `new_sqlite_classes` migration tag, forwarding helper, and generated type updates.

11. **Design live update transport separately.** Decide REST-only, polling, plain PartyServer `Server`, raw DO WebSockets, or YServer with a Y.Doc; include auth, share-token transport, and revocation fanout.

12. **Make R2/D1/DO reconciliation idempotent.** Store etag/version state, have `HtmlDocDO` compare cached state on reads/writes, and add retry/reconcile paths rather than relying only on upload-time hooks.

13. **Rework asset versioning as its own workstream.** Add D1 schema/protocol migrations, initial backfill, first-reupload byte preservation, current-pointer transaction rules, hash-vs-etag semantics, restore audit rows, retention/GC, and CLI compatibility.

14. **Split rollout phases.** Ship doc-level asset comment CRUD separately from node anchors, upload-time reanchor, notifications, versioning, and diff-driven reanchor. Move or defer version-dependent reanchor claims accordingly.

15. **Expand tests around the actual risks.** Add route/auth matrices, opaque-origin postMessage tests, byte-clean raw export tests, parser/browser parity tests, model-oracle node-anchor property tests, migration/backfill tests, asset delete/recreate lifecycle tests, and CLI/API compatibility tests.