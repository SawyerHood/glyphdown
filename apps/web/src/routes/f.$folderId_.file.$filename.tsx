import { Link, createFileRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Download, ExternalLink, FileCode2, FolderX, MessageSquare, MessageSquarePlus, X } from 'lucide-react'
import { assetKindForContentType, roleAtLeast, type AssetMeta, type Comment, type NodeAnchor, type Principal, type Role } from '@glyphdown/protocol'
import {
  ApiError,
  createFolderAssetComment,
  fetchMe,
  fetchFolderAssetCommentingView,
  folderAssetUrl,
  getFolderListing,
  listFolderAssetComments,
  listFolderMembers,
  reattachFolderAssetComment,
  replyToFolderAssetComment,
  setFolderAssetCommentResolved,
  toggleFolderAssetCommentReaction,
  type MemberInfo,
} from '../lib/api.ts'
import {
  isHtmlCommentsFrameMessage,
  type HtmlCommentsParentMessage,
} from '../runtime/html-comments.ts'
import { track } from '../lib/analytics.ts'
import { useIsMobile } from '../lib/useMediaQuery.ts'
import { Badge, Button, Spinner } from '../components/ui.tsx'
import MentionTextarea from '../components/MentionTextarea.tsx'
import EditorHeader, { BrandSquare } from '../components/editor/EditorHeader.tsx'
import CommentThreadList, {
  type CommentAnchorPreview,
  type CommentThreadDescriptor,
  type CommentThreadService,
} from '../components/editor/CommentThreadList.tsx'

type HtmlCommentsParentCommand =
  | { t: 'gd:set-mode'; mode: 'browse' | 'pick' }
  | { t: 'gd:set-markers'; markers: Array<{ id: string; anchor: NodeAnchor; number?: number }> }
  | { t: 'gd:focus-marker'; id: string }

type MarkerResolution = { status: 'anchored' | 'orphaned'; domHint?: number; label?: string }
type PickedRect = { top: number; left: number; bottom: number; right: number; width: number; height: number }

const folderAssetCommentsKey = (folderId: string, filename: string, share?: string) =>
  ['folder-asset-comments', folderId, filename, share ?? null] as const

function upsertById<T extends { id: string }>(list: T[] | undefined, item: T): T[] {
  const next = [...(list ?? [])]
  const idx = next.findIndex((x) => x.id === item.id)
  if (idx >= 0) next[idx] = item
  else next.push(item)
  return next
}

/**
 * Standalone folder HTML asset viewer. The CLI prints this exact URL shape:
 * /f/:folderId/file/:filename. The iframe intentionally omits
 * allow-same-origin so user-authored HTML runs in an opaque origin while the
 * raw asset response still carries the server CSP sandbox.
 */

export const Route = createFileRoute('/f/$folderId_/file/$filename')({
  validateSearch: (search: Record<string, unknown>): { share?: string } => ({
    ...(typeof search['share'] === 'string' && search['share'] !== '' ? { share: search['share'] } : {}),
  }),
  component: FolderHtmlAssetViewer,
})

function FolderHtmlAssetViewer() {
  const { folderId, filename } = Route.useParams()
  const { share } = Route.useSearch()

  const listingQuery = useQuery({
    queryKey: ['folder-listing', folderId, share ?? null],
    queryFn: () => getFolderListing(folderId, share),
    retry: false,
    staleTime: 30_000,
  })

  const folder = listingQuery.data?.folder ?? null
  const asset =
    folder?.assets.find((a) => a.filename === filename && assetKindForContentType(a.contentType) === 'html') ?? null

  if (listingQuery.isLoading) {
    return (
      <div className="min-h-screen bg-[var(--bg-base)]">
        <div className="py-16 text-center">
          <Spinner label="Opening HTML file..." />
        </div>
      </div>
    )
  }

  if (listingQuery.isError || !folder) {
    return <HtmlAssetErrorCard error={listingQuery.error} folderId={folderId} filename={filename} share={share} />
  }

  if (!asset) {
    return <HtmlAssetNotFound folderId={folderId} filename={filename} share={share} />
  }

  return (
    <HtmlAssetViewerChrome
      folderId={folderId}
      filename={asset.filename}
      folderName={folder.name}
      folderRole={folder.role}
      share={share}
      asset={asset}
    />
  )
}

export function HtmlAssetViewerChrome({
  folderId,
  filename,
  folderRole = 'viewer',
  share,
  asset,
}: {
  folderId: string
  filename: string
  folderName?: string | undefined
  folderRole?: Role | undefined
  share?: string | undefined
  asset?: AssetMeta | undefined
}) {
  const rawUrl = folderAssetUrl(folderId, filename, share)
  const queryClient = useQueryClient()
  const isMobile = useIsMobile()
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const [frameReady, setFrameReady] = useState(false)
  const [picking, setPicking] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null)
  const [pendingAnchor, setPendingAnchor] = useState<NodeAnchor | null>(null)
  const [pendingRect, setPendingRect] = useState<PickedRect | null>(null)
  const [reattachTarget, setReattachTarget] = useState<Comment | null>(null)
  const [markerResolutions, setMarkerResolutions] = useState<Record<string, MarkerResolution>>({})
  const [error, setError] = useState<string | null>(null)

  const meQuery = useQuery({ queryKey: ['me'], queryFn: fetchMe, staleTime: 60_000, retry: false })
  const me: Principal | null = meQuery.data ?? null
  const canComment = me !== null && roleAtLeast(folderRole, 'commenter')

  const viewQuery = useQuery({
    queryKey: ['folder-asset-commenting-view', folderId, filename, share ?? null],
    queryFn: () => fetchFolderAssetCommentingView(folderId, filename, share),
    retry: false,
    staleTime: 30_000,
  })

  const commentsQuery = useQuery({
    queryKey: folderAssetCommentsKey(folderId, filename, share),
    queryFn: () => listFolderAssetComments(folderId, filename, share),
    enabled: viewQuery.isSuccess,
    retry: false,
    refetchInterval: 5_000,
  })
  const comments = commentsQuery.data ?? []

  const membersQuery = useQuery({
    queryKey: ['folder-members', folderId, share ?? null],
    queryFn: () => listFolderMembers(folderId, share),
    enabled: me !== null,
    retry: false,
    staleTime: 60_000,
  })
  const members: MemberInfo[] = membersQuery.data ?? []

  const report = useCallback((err: unknown) => {
    const message = err instanceof Error ? err.message : 'Something went wrong'
    setError(message)
    setTimeout(() => setError(null), 4000)
  }, [])

  const upsertComment = useCallback(
    (comment: Comment) =>
      queryClient.setQueryData<Comment[]>(folderAssetCommentsKey(folderId, filename, share), (old) => upsertById(old, comment)),
    [filename, folderId, queryClient, share],
  )

  // Stable 1..N numbering for open, resolvable node comments — shared by the
  // in-iframe marker bubbles and the sidebar thread badges so they line up.
  // Number by the STORED domHint only (not the runtime round-trip), so this stays
  // stable across gd:markers-resolved updates — otherwise markerPayload would
  // change on every resolution, re-post set-markers, and loop the marker layer.
  const markerNumbers = useMemo(() => {
    const map = new Map<string, number>()
    comments
      .filter((c) => !c.resolved && c.anchorKind === 'node' && c.nodeAnchor !== undefined && c.nodeAnchor.status !== 'orphaned')
      .map((c) => ({ id: c.id, key: c.nodeAnchor!.domHint, createdAt: c.createdAt }))
      .sort((a, b) => a.key - b.key || a.createdAt - b.createdAt)
      .forEach((c, i) => map.set(c.id, i + 1))
    return map
  }, [comments])

  const markerPayload = useMemo(
    () =>
      comments
        .filter((comment) => !comment.resolved && comment.anchorKind === 'node' && comment.nodeAnchor !== undefined)
        .map((comment) => ({ id: comment.id, anchor: comment.nodeAnchor!, number: markerNumbers.get(comment.id) })),
    [comments, markerNumbers],
  )

  const postToFrame = useCallback(
    (message: HtmlCommentsParentCommand) => {
      const nonce = viewQuery.data?.nonce
      const target = iframeRef.current?.contentWindow
      if (!nonce || !target) return
      target.postMessage({ ...message, version: 1, nonce } as HtmlCommentsParentMessage, '*')
    },
    [viewQuery.data?.nonce],
  )

  const handlePickedAnchor = useCallback(
    (anchor: NodeAnchor, rect?: PickedRect) => {
      if (!canComment) return
      if (reattachTarget) {
        void (async () => {
          try {
            const updated = await reattachFolderAssetComment(
              folderId,
              filename,
              reattachTarget.id,
              { nodeAnchor: anchor },
              share,
            )
            upsertComment(updated)
            setActiveCommentId(updated.id)
            setReattachTarget(null)
            setSidebarOpen(true)
          } catch (err) {
            report(err)
          }
        })()
        return
      }
      setPendingAnchor(anchor)
      // Desktop: anchor an inline composer to the picked element. Mobile: fall
      // back to the bottom-sheet composer.
      if (isMobile) {
        setPendingRect(null)
        setSidebarOpen(true)
      } else {
        setPendingRect(rect ?? null)
      }
    },
    [canComment, filename, folderId, isMobile, reattachTarget, report, share, upsertComment],
  )

  useEffect(() => {
    setFrameReady(false)
    setPendingAnchor(null)
    setPendingRect(null)
    setReattachTarget(null)
    setMarkerResolutions({})
    setPicking(false)
  }, [viewQuery.data?.html])

  const clearPending = useCallback(() => {
    setPendingAnchor(null)
    setPendingRect(null)
  }, [])

  const submitInlineComment = useCallback(
    async (body: string) => {
      if (!pendingAnchor) return
      try {
        const created = await createFolderAssetComment(folderId, filename, { body, nodeAnchor: pendingAnchor }, share)
        track('comment_created', { docId: asset?.id ?? folderId, kind: 'anchored' })
        upsertComment(created)
        setActiveCommentId(created.id)
        clearPending()
        setSidebarOpen(true)
      } catch (err) {
        report(err)
      }
    },
    [asset?.id, clearPending, filename, folderId, pendingAnchor, report, share, upsertComment],
  )

  useEffect(() => {
    const iframe = iframeRef.current
    const nonce = viewQuery.data?.nonce
    if (!iframe || !nonce) return

    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframe.contentWindow) return
      if (!isHtmlCommentsFrameMessage(event.data, nonce)) return
      if (event.data.t === 'gd:ready') {
        setFrameReady(true)
      } else if (event.data.t === 'gd:select') {
        handlePickedAnchor(event.data.anchor, event.data.rect)
      } else if (event.data.t === 'gd:markers-resolved') {
        const next: Record<string, MarkerResolution> = {}
        for (const marker of event.data.markers) {
          next[marker.id] = {
            status: marker.status,
            ...(marker.domHint !== undefined ? { domHint: marker.domHint } : {}),
            ...(marker.label !== undefined ? { label: marker.label } : {}),
          }
        }
        setMarkerResolutions(next)
      } else if (event.data.t === 'gd:marker-click') {
        setActiveCommentId(event.data.id)
        setPendingAnchor(null)
        setReattachTarget(null)
        setPicking(false)
        setSidebarOpen(true)
        postToFrame({ t: 'gd:focus-marker', id: event.data.id })
      }
    }

    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [handlePickedAnchor, postToFrame, viewQuery.data?.nonce])

  useEffect(() => {
    if (!frameReady) return
    // Comment mode = the panel is open. Suspend element-picking while a composer
    // is open (pendingAnchor) so a stray click can't drop the in-progress comment.
    postToFrame({ t: 'gd:set-mode', mode: picking && !pendingAnchor ? 'pick' : 'browse' })
  }, [frameReady, picking, pendingAnchor, postToFrame])

  useEffect(() => {
    if (!frameReady) return
    postToFrame({ t: 'gd:set-markers', markers: markerPayload })
  }, [frameReady, markerPayload, postToFrame])

  // Single control: opening the comments panel enters comment mode, closing it
  // returns to browsing (and drops any in-progress pick/compose).
  const toggleComments = useCallback(() => {
    setSidebarOpen((open) => {
      const next = !open
      setPicking(next)
      if (!next) {
        clearPending()
        setReattachTarget(null)
      }
      return next
    })
  }, [clearPending])

  const pendingPreview = useCallback((anchor: NodeAnchor): CommentAnchorPreview => previewForNodeAnchor(anchor), [])
  const analyticsTargetId = asset?.id ?? folderId

  const describeComment = useCallback(
    (comment: Comment): CommentThreadDescriptor => {
      if (comment.anchorKind !== 'node' || comment.nodeAnchor === undefined) return { bucket: 'document' }
      const runtime = markerResolutions[comment.id]
      const orphaned = comment.nodeAnchor.status === 'orphaned' || runtime?.status === 'orphaned'
      const preview = previewForNodeAnchor(comment.nodeAnchor, runtime, orphaned)
      if (orphaned) return { bucket: 'orphaned', preview }
      return {
        bucket: 'anchored',
        sortKey: comment.nodeAnchor.domHint,
        markerNumber: markerNumbers.get(comment.id),
        preview,
      }
    },
    [markerResolutions, markerNumbers],
  )

  const service = useMemo<CommentThreadService<NodeAnchor>>(
    () => ({
      upsert: upsertComment,
      createPending: async (anchor, body) => {
        const created = await createFolderAssetComment(folderId, filename, { body, nodeAnchor: anchor }, share)
        track('comment_created', { docId: analyticsTargetId, kind: 'anchored' })
        return created
      },
      createDocument: async (body) => {
        const created = await createFolderAssetComment(folderId, filename, { body }, share)
        track('comment_created', { docId: analyticsTargetId, kind: 'doc-level' })
        return created
      },
      reply: async (comment, body) => {
        const reply = await replyToFolderAssetComment(folderId, filename, comment.id, body, share)
        track('comment_created', { docId: analyticsTargetId, kind: 'reply' })
        return { ...comment, replies: [...comment.replies, reply] }
      },
      toggleResolve: async (comment) => {
        const { resolved } = await setFolderAssetCommentResolved(folderId, filename, comment.id, !comment.resolved, share)
        return { ...comment, resolved }
      },
      react: (comment, emoji) => toggleFolderAssetCommentReaction(folderId, filename, comment.id, emoji, share),
      reattach: async (comment) => {
        setReattachTarget(comment)
        setPendingAnchor(null)
        setPicking(true)
        if (isMobile) setSidebarOpen(false)
        return null
      },
    }),
    [analyticsTargetId, filename, folderId, isMobile, share, upsertComment],
  )

  const selectThread = useCallback(
    (comment: Comment) => {
      setActiveCommentId(comment.id)
      setPendingAnchor(null)
      if (comment.anchorKind === 'node') postToFrame({ t: 'gd:focus-marker', id: comment.id })
    },
    [postToFrame],
  )

  const openComments = comments.filter((comment) => !comment.resolved).length
  const pickingLabel = reattachTarget ? 'Pick a new element' : 'Pick an element'
  const sidebar = (
    <CommentThreadList
      comments={comments}
      me={me}
      canComment={canComment}
      members={members}
      activeCommentId={activeCommentId}
      onSelect={selectThread}
      pending={isMobile ? pendingAnchor : null}
      pendingPreview={pendingPreview}
      onPendingDone={clearPending}
      describeComment={describeComment}
      service={service}
      report={report}
      emptyHint={canComment ? 'Pick an element in the HTML file to add an anchored comment.' : 'Sign in with comment access to join the discussion.'}
      anchoredLabel="On elements"
      documentLabel="File"
      documentActionLabel="Comment on the HTML file"
      documentPlaceholder="Comment on the whole HTML file…"
      orphanedDescription="The elements these comments were anchored to were removed or changed."
      canReattach={() => frameReady}
      reattachTitle={() => (frameReady ? 'Pick a new element in the HTML file' : 'Wait for the HTML file to load')}
    />
  )

  return (
    <div className="flex min-h-screen flex-col bg-[var(--bg-base)]">
      <EditorHeader
        brand={
          share !== undefined ? (
            <Link to="/f/$folderId" params={{ folderId }} search={{ share }} className="no-underline" title="Back to folder">
              <BrandSquare>
                <FileCode2 size={13} />
              </BrandSquare>
            </Link>
          ) : (
            <Link to="/" search={{ folder: folderId }} className="no-underline" title="Back to folder">
              <BrandSquare>
                <FileCode2 size={13} />
              </BrandSquare>
            </Link>
          )
        }
        title={<span className="min-w-0 truncate text-sm font-semibold text-[var(--ink)]">{filename}</span>}
        badges={
          reattachTarget ? (
            <Badge tone="blue">Re-attaching…</Badge>
          ) : pendingAnchor ? (
            <Badge tone="blue">Selected</Badge>
          ) : null
        }
      >
        <a
          href={rawUrl}
          target="_blank"
          rel="noreferrer"
          title="Open raw"
          className="rounded-md p-1.5 text-[var(--ink-soft)] no-underline transition hover:bg-[var(--paper-soft)] hover:text-[var(--ink)] max-sm:hidden"
        >
          <ExternalLink size={15} />
        </a>
        <a
          href={rawUrl}
          download={filename}
          title="Download"
          className="rounded-md p-1.5 text-[var(--ink-soft)] no-underline transition hover:bg-[var(--paper-soft)] hover:text-[var(--ink)] max-sm:hidden"
        >
          <Download size={15} />
        </a>
        <Button
          size="sm"
          variant="ghost"
          onClick={toggleComments}
          title="Comments"
          className={`max-lg:px-3 max-lg:py-2 ${sidebarOpen ? 'text-[var(--accent)]' : ''}`}
        >
          <MessageSquare size={15} />
          {openComments > 0 ? <span className="text-[11px] font-semibold">{openComments}</span> : null}
        </Button>
      </EditorHeader>
      {error ? <div className="bg-red-600 px-4 py-1.5 text-center text-xs font-medium text-white">{error}</div> : null}
      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1 overflow-hidden bg-[var(--bg-base)] p-3 sm:p-5">
          <div className="mx-auto flex h-full w-full max-w-4xl overflow-hidden rounded-xl border border-[var(--line)] bg-white shadow-sm">
            {viewQuery.isLoading ? (
              <div className="grid h-full min-h-0 w-full place-items-center bg-white">
                <Spinner label="Loading HTML file..." />
              </div>
            ) : viewQuery.isError || !viewQuery.data ? (
              <div className="grid h-full min-h-0 w-full place-items-center bg-white px-4 text-center">
                <p className="m-0 text-sm font-medium text-[var(--ink-soft)]">This HTML file could not be opened.</p>
              </div>
            ) : (
              <iframe
                ref={iframeRef}
                title={filename}
                sandbox="allow-scripts"
                srcDoc={viewQuery.data.html}
                className="h-full min-h-0 w-full border-0 bg-white"
                data-asset-id={asset?.id}
              />
            )}
          </div>
          {isMobile && picking && !sidebarOpen ? (
            <button
              type="button"
              onClick={() => {
                setPicking(false)
                setReattachTarget(null)
              }}
              className="fixed bottom-[calc(1.25rem+env(safe-area-inset-bottom))] left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-full border border-[var(--line)] bg-[var(--paper)] px-5 py-3 text-sm font-medium text-[var(--ink)] shadow-lg"
            >
              <MessageSquarePlus size={16} /> {pickingLabel}
            </button>
          ) : null}
          {!isMobile && pendingAnchor && pendingRect ? (
            <InlineComposer
              rect={pendingRect}
              iframe={iframeRef.current}
              label={pendingAnchor.label}
              members={members}
              onSubmit={submitInlineComment}
              onCancel={clearPending}
            />
          ) : null}
        </div>

        {sidebarOpen ? (
          <>
            <div
              className="fixed inset-0 z-[65] bg-black/40 lg:hidden"
              onClick={() => setSidebarOpen(false)}
              aria-hidden
            />
            <aside
              aria-label="HTML file comments"
              className="fixed inset-x-0 bottom-0 z-[70] flex h-[70dvh] flex-col rounded-t-2xl border-t border-[var(--line)] bg-[var(--paper)] pb-[env(safe-area-inset-bottom)] shadow-2xl lg:static lg:z-auto lg:h-auto lg:w-[22rem] lg:shrink-0 lg:rounded-none lg:border-l lg:border-t-0 lg:pb-0 lg:shadow-none"
            >
              <div className="flex items-center justify-center pt-2 lg:hidden" aria-hidden>
                <span className="h-1 w-9 rounded-full bg-[var(--line)]" />
              </div>
              <div className="flex shrink-0 items-center border-b border-[var(--line)] px-3 py-2">
                <p className="m-0 flex flex-1 items-center gap-2 text-sm font-semibold text-[var(--ink)]">
                  Comments
                  {openComments > 0 ? (
                    <span className="rounded-full bg-[var(--paper-soft)] px-2 py-0.5 text-[11px] font-bold text-[var(--ink-soft)]">
                      {openComments}
                    </span>
                  ) : null}
                </p>
                <button
                  type="button"
                  onClick={() => setSidebarOpen(false)}
                  aria-label="Close comments"
                  className="rounded-md p-1 text-[var(--ink-soft)] hover:bg-[var(--paper-soft)] hover:text-[var(--ink)] lg:hidden"
                >
                  <X size={18} />
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {commentsQuery.isLoading ? (
                  <div className="py-8 text-center">
                    <Spinner label="Loading comments..." />
                  </div>
                ) : (
                  sidebar
                )}
              </div>
            </aside>
          </>
        ) : null}
      </div>
    </div>
  )
}

/** Compose-in-place popover anchored to a picked element, over the iframe (desktop). */
function InlineComposer({
  rect,
  iframe,
  label,
  members,
  onSubmit,
  onCancel,
}: {
  rect: PickedRect
  iframe: HTMLIFrameElement | null
  label: string
  members: MemberInfo[]
  onSubmit: (body: string) => void
  onCancel: () => void
}) {
  const [body, setBody] = useState('')
  const POP_W = 320
  const base = iframe?.getBoundingClientRect() ?? { top: 0, left: 0 }
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800
  const left = Math.max(12, Math.min(base.left + rect.left, vw - POP_W - 12))
  let top = base.top + rect.bottom + 8
  if (top > vh - 210) top = Math.max(12, base.top + rect.top - 210)
  const submit = () => {
    if (body.trim()) onSubmit(body.trim())
  }
  return (
    <div
      className="fixed z-[80] w-80 rounded-xl border border-[var(--line)] bg-[var(--paper)] p-3 shadow-xl"
      style={{ top, left }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel()
      }}
    >
      <div className="mb-2 inline-flex max-w-full items-center gap-1.5 rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[11px] font-semibold text-[var(--accent)]">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent)]" />
        <span className="truncate font-mono">{label}</span>
      </div>
      <MentionTextarea
        value={body}
        onChange={setBody}
        members={members}
        placeholder="Comment… use @ to mention"
        autoFocus
        onSubmit={submit}
      />
      <div className="mt-2 flex justify-end gap-2">
        <Button size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" disabled={body.trim() === ''} onClick={submit}>
          Comment
        </Button>
      </div>
    </div>
  )
}

function previewForNodeAnchor(
  anchor: NodeAnchor,
  runtime?: MarkerResolution,
  orphaned = anchor.status === 'orphaned',
): CommentAnchorPreview {
  return {
    ...(runtime?.label ?? anchor.label ? { label: runtime?.label ?? anchor.label } : {}),
    ...(anchor.quote?.exact ? { quote: anchor.quote.exact } : {}),
    ...(orphaned ? { orphaned: true } : {}),
  }
}

function HtmlAssetErrorCard({
  error,
  folderId,
  filename,
  share,
}: {
  error: unknown
  folderId: string
  filename: string
  share: string | undefined
}) {
  const needsSignIn = error instanceof ApiError && error.status === 401
  const next = `/f/${encodeURIComponent(folderId)}/file/${encodeURIComponent(filename)}${share ? `?share=${encodeURIComponent(share)}` : ''}`
  return (
    <section className="island-shell rise-in mx-auto mt-16 w-full max-w-md px-8 py-12 text-center">
      <span className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--paper-soft)] text-[var(--ink-faint)]">
        <FolderX size={20} />
      </span>
      <h1 className="display-title m-0 mb-2 text-2xl font-bold tracking-tight text-[var(--ink)]">
        {needsSignIn ? 'Sign in to view this' : 'This file is not available'}
      </h1>
      <p className="m-0 mb-6 text-sm text-[var(--ink-soft)]">
        {needsSignIn
          ? 'This folder file needs a signed-in account, or a valid share link.'
          : 'The folder does not exist, the link was revoked, or you do not have access to it.'}
      </p>
      {needsSignIn ? (
        <Link to="/login" search={{ next }} className="text-sm font-semibold text-[var(--accent)] hover:underline">
          Sign in
        </Link>
      ) : (
        <Link to="/" className="text-sm font-semibold text-[var(--accent)] hover:underline">
          Go to Glyphdown
        </Link>
      )}
    </section>
  )
}

function HtmlAssetNotFound({
  folderId,
  filename,
  share,
}: {
  folderId: string
  filename: string
  share: string | undefined
}) {
  return (
    <div className="min-h-screen bg-[var(--bg-base)] px-4 py-16">
      <div className="mx-auto max-w-md rounded-lg border border-dashed border-[var(--line)] px-4 py-10 text-center">
        <p className="m-0 text-sm font-medium text-[var(--ink-soft)]">That HTML file is not in this folder.</p>
        <p className="m-0 mt-1 text-xs text-[var(--ink-faint)]">{filename}</p>
        {share !== undefined ? (
          <Link
            to="/f/$folderId"
            params={{ folderId }}
            search={{ share }}
            className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 py-1.5 text-sm font-medium text-[var(--ink)] no-underline transition hover:bg-[var(--paper-soft)]"
          >
            Back to folder
          </Link>
        ) : (
          <Link
            to="/"
            search={{ folder: folderId }}
            className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 py-1.5 text-sm font-medium text-[var(--ink)] no-underline transition hover:bg-[var(--paper-soft)]"
          >
            Back to folder
          </Link>
        )}
      </div>
    </div>
  )
}
