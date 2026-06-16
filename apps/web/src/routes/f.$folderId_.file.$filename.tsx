import { Link, createFileRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Download, ExternalLink, FileCode2, FolderX, MessageSquare, MessageSquarePlus, X } from 'lucide-react'
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
import { Spinner } from '../components/ui.tsx'
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
  folderName,
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
  const markerNumbers = useMemo(() => {
    const map = new Map<string, number>()
    comments
      .filter(
        (c) =>
          !c.resolved &&
          c.anchorKind === 'node' &&
          c.nodeAnchor !== undefined &&
          c.nodeAnchor.status !== 'orphaned' &&
          markerResolutions[c.id]?.status !== 'orphaned',
      )
      .map((c) => ({ id: c.id, key: markerResolutions[c.id]?.domHint ?? c.nodeAnchor!.domHint, createdAt: c.createdAt }))
      .sort((a, b) => a.key - b.key || a.createdAt - b.createdAt)
      .forEach((c, i) => map.set(c.id, i + 1))
    return map
  }, [comments, markerResolutions])

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
    (anchor: NodeAnchor) => {
      setPicking(false)
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
      setSidebarOpen(true)
    },
    [canComment, filename, folderId, reattachTarget, report, share, upsertComment],
  )

  useEffect(() => {
    setFrameReady(false)
    setPendingAnchor(null)
    setReattachTarget(null)
    setMarkerResolutions({})
    setPicking(false)
  }, [viewQuery.data?.html])

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
        handlePickedAnchor(event.data.anchor)
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
    postToFrame({ t: 'gd:set-mode', mode: picking ? 'pick' : 'browse' })
  }, [frameReady, picking, postToFrame])

  useEffect(() => {
    if (!frameReady) return
    postToFrame({ t: 'gd:set-markers', markers: markerPayload })
  }, [frameReady, markerPayload, postToFrame])

  // On desktop the comments panel is part of the layout (like the mockup); on
  // mobile it stays a bottom sheet you open on demand.
  useEffect(() => {
    if (!isMobile) setSidebarOpen(true)
  }, [isMobile])

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
        sortKey: runtime?.domHint ?? comment.nodeAnchor.domHint,
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
      pending={pendingAnchor}
      pendingPreview={pendingPreview}
      onPendingDone={() => setPendingAnchor(null)}
      describeComment={describeComment}
      service={service}
      report={report}
      emptyHint={canComment ? 'Pick an element in the HTML file to add an anchored comment.' : 'Sign in with comment access to join the discussion.'}
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
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-[var(--line)] bg-[var(--paper)] px-3 sm:px-4">
        {share !== undefined ? (
          <Link
            to="/f/$folderId"
            params={{ folderId }}
            search={{ share }}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium text-[var(--ink-soft)] no-underline hover:bg-[var(--paper-soft)] hover:text-[var(--ink)]"
          >
            <ArrowLeft size={15} /> Folder
          </Link>
        ) : (
          <Link
            to="/"
            search={{ folder: folderId }}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium text-[var(--ink-soft)] no-underline hover:bg-[var(--paper-soft)] hover:text-[var(--ink)]"
          >
            <ArrowLeft size={15} /> Folder
          </Link>
        )}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <FileCode2 size={16} className="shrink-0 text-[var(--ink-faint)]" />
          <div className="min-w-0 flex-1">
            <p className="m-0 truncate text-sm font-semibold text-[var(--ink)]">{filename}</p>
            <p className="m-0 truncate text-[11px] text-[var(--ink-faint)]">
              {reattachTarget
                ? `Re-attaching ${labelForComment(reattachTarget)}`
                : pendingAnchor
                  ? `Selected ${pendingAnchor.label}`
                  : folderName}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            title="Comments"
            className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium transition ${
              sidebarOpen
                ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--ink)]'
                : 'border-[var(--line)] bg-[var(--paper)] text-[var(--ink)] hover:bg-[var(--paper-soft)]'
            }`}
            onClick={() => setSidebarOpen((value) => !value)}
          >
            <MessageSquare size={13} />
            {openComments > 0 ? <span className="text-[11px] font-semibold">{openComments}</span> : null}
          </button>
          {canComment ? (
            <button
              type="button"
              title={picking ? 'Cancel pick' : 'Pick an element to comment on'}
              className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium transition ${
                picking
                  ? 'border-[var(--accent)] bg-[var(--accent)] text-white'
                  : 'border-[var(--line)] bg-[var(--paper)] text-[var(--ink)] hover:bg-[var(--paper-soft)]'
              }`}
              onClick={() => {
                setPicking((value) => {
                  if (value) setReattachTarget(null)
                  return !value
                })
              }}
              disabled={!frameReady}
            >
              <MessageSquarePlus size={13} />
              <span className="hidden sm:inline">{picking ? pickingLabel : 'Comment'}</span>
            </button>
          ) : null}
          <a
            href={rawUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--line)] bg-[var(--paper)] px-2 py-1 text-xs font-medium text-[var(--ink)] no-underline transition hover:bg-[var(--paper-soft)]"
          >
            <ExternalLink size={13} />
            <span className="hidden sm:inline">Open raw</span>
            <span className="sm:hidden">Raw</span>
          </a>
          <a
            href={rawUrl}
            download={filename}
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--line)] bg-[var(--paper)] px-2 py-1 text-xs font-medium text-[var(--ink)] no-underline transition hover:bg-[var(--paper-soft)]"
          >
            <Download size={13} />
            <span className="hidden sm:inline">Download</span>
          </a>
        </div>
      </header>
      {error ? <div className="bg-red-600 px-4 py-1.5 text-center text-xs font-medium text-white">{error}</div> : null}
      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1 bg-white">
          {viewQuery.isLoading ? (
            <div className="grid h-full min-h-0 place-items-center bg-white">
              <Spinner label="Loading HTML file..." />
            </div>
          ) : viewQuery.isError || !viewQuery.data ? (
            <div className="grid h-full min-h-0 place-items-center bg-white px-4 text-center">
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
                <p className="m-0 flex-1 text-sm font-medium text-[var(--ink)]">
                  Comments{openComments > 0 ? ` (${openComments})` : ''}
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

function labelForComment(comment: Comment): string {
  return comment.nodeAnchor?.label ?? comment.body.slice(0, 40)
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
