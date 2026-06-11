import { Link, createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Download, ExternalLink, FileCode2, FolderX } from 'lucide-react'
import { assetKindForContentType, type AssetMeta } from '@glyphdown/protocol'
import { ApiError, folderAssetUrl, getFolderListing } from '../lib/api.ts'
import { Spinner } from '../components/ui.tsx'

/**
 * Standalone folder HTML asset viewer. The CLI prints this exact URL shape:
 * /f/:folderId/file/:filename. The iframe intentionally omits
 * allow-same-origin so user-authored HTML runs in an opaque origin while the
 * raw asset response still carries the server CSP sandbox.
 */

export const Route = createFileRoute('/f/$folderId/file/$filename')({
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

  return <HtmlAssetViewerChrome folderId={folderId} filename={asset.filename} folderName={folder.name} share={share} asset={asset} />
}

export function HtmlAssetViewerChrome({
  folderId,
  filename,
  folderName,
  share,
  asset,
}: {
  folderId: string
  filename: string
  folderName?: string | undefined
  share?: string | undefined
  asset?: AssetMeta | undefined
}) {
  const rawUrl = folderAssetUrl(folderId, filename, share)
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
          <div className="min-w-0">
            <p className="m-0 truncate text-sm font-semibold text-[var(--ink)]">{filename}</p>
            {folderName ? <p className="m-0 truncate text-[11px] text-[var(--ink-faint)]">{folderName}</p> : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
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
      <iframe
        title={filename}
        sandbox="allow-scripts"
        src={rawUrl}
        className="min-h-0 flex-1 border-0 bg-white"
        data-asset-id={asset?.id}
      />
    </div>
  )
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
