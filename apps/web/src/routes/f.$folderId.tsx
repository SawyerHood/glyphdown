import { Link, createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, FileText, Folder, FolderRoot, FolderX, PenLine } from 'lucide-react'
import type { DocMeta, FolderMeta } from '@glyphdown/protocol'
import { ApiError, fetchMe, getFolderListing } from '../lib/api.ts'
import { breadcrumbChain, folderListing } from '../lib/browse.ts'
import { timeAgo } from '../lib/presence.ts'
import { Spinner } from '../components/ui.tsx'

/**
 * Folder/vault share-link landing page (/f/:folderId?share=<token>) — the
 * folder counterpart of /d/:docId?share=…: anyone holding a folder or vault
 * share link lands here and browses the shared subtree (subfolders + docs)
 * read-only, navigating into docs with the token carried along (the doc route
 * already grants through folder links via the ancestor chain). Anonymous
 * visitors are viewer-capped exactly like doc links; signed-in visitors get
 * max(their own grants, the link role) — the same URL works for both, and for
 * members visiting without any token at all.
 *
 * Sub-navigation rides the `folder` search param while the path keeps the
 * LINK's root folder, so the copied URL stays stable. The single /listing
 * response carries the whole subtree — navigating within it is instant and
 * can never escape the token's scope (the server never returns anything
 * outside it).
 */

export const Route = createFileRoute('/f/$folderId')({
  validateSearch: (search: Record<string, unknown>): { share?: string; folder?: string } => ({
    ...(typeof search['share'] === 'string' && search['share'] !== '' ? { share: search['share'] } : {}),
    ...(typeof search['folder'] === 'string' && search['folder'] !== '' ? { folder: search['folder'] } : {}),
  }),
  component: FolderSharePage,
})

function FolderSharePage() {
  const { folderId } = Route.useParams()
  const { share, folder } = Route.useSearch()

  const listingQuery = useQuery({
    queryKey: ['folder-listing', folderId, share ?? null],
    queryFn: () => getFolderListing(folderId, share),
    retry: false,
    staleTime: 30_000,
  })

  const data = listingQuery.data
  // All subtree folders, the share root included — enough to render any
  // level of the subtree without another request.
  const all = data ? [data.folder, ...data.folders] : []
  const currentId = folder ?? folderId
  const current = all.find((f) => f.id === currentId) ?? null

  return (
    <div className="min-h-screen bg-[var(--bg-base)]">
      <LandingHeader root={data?.folder ?? null} />
      <main className="page-wrap py-8">
        {listingQuery.isLoading ? (
          <div className="py-16 text-center">
            <Spinner label="Opening the shared folder…" />
          </div>
        ) : listingQuery.isError || !data ? (
          <LinkDeadCard error={listingQuery.error} folderId={folderId} share={share} />
        ) : current === null ? (
          <NotInSubtree rootId={folderId} share={share} />
        ) : (
          <SubtreeBrowser root={data.folder} current={current} all={all} docs={data.docs} share={share} />
        )}
      </main>
    </div>
  )
}

/**
 * Minimal chrome — this page renders for visitors with no session at all.
 * Identity comes from /api/me, not the route context: the root guard skips
 * the session fetch whenever `?share=` is present, so signed-in visitors
 * opening a share link would otherwise look anonymous here.
 */
function LandingHeader({ root }: { root: FolderMeta | null }) {
  const meQuery = useQuery({ queryKey: ['me'], queryFn: fetchMe, staleTime: 60_000, retry: false })
  const session = meQuery.data ?? null
  return (
    <header className="sticky top-0 z-50 border-b border-[var(--line)] bg-[var(--header-bg)] backdrop-blur-md">
      <nav className="page-wrap flex items-center gap-3 py-2.5">
        <Link to="/" className="flex items-center gap-2 text-[var(--ink)] no-underline">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--accent)] text-white">
            <PenLine size={15} />
          </span>
          <span className="display-title text-base font-bold tracking-tight">Glyphdown</span>
        </Link>
        {root ? (
          <span className="flex min-w-0 items-center gap-1.5 text-sm text-[var(--ink-soft)]">
            <ChevronRight size={13} className="shrink-0 text-[var(--ink-faint)]" />
            <span className="truncate">
              Shared {root.kind === 'vault' ? 'vault' : 'folder'} · you can {ROLE_VERB[root.role] ?? root.role}
            </span>
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-3 text-sm font-medium">
          {session ? (
            <Link to="/" className="nav-link">
              Open my docs
            </Link>
          ) : (
            <Link to="/login" className="nav-link">
              Sign in
            </Link>
          )}
        </div>
      </nav>
    </header>
  )
}

const ROLE_VERB: Record<string, string> = {
  viewer: 'view',
  commenter: 'comment',
  suggester: 'suggest',
  editor: 'edit',
  owner: 'do anything — you own this',
}

/**
 * The browsable listing: breadcrumbs (rooted at the SHARE root — ancestors
 * above it are invisible by design), then subfolders and docs of the current
 * level, FileBrowser-styled but read-only.
 */
function SubtreeBrowser({
  root,
  current,
  all,
  docs,
  share,
}: {
  root: FolderMeta
  current: FolderMeta
  all: FolderMeta[]
  docs: DocMeta[]
  share: string | undefined
}) {
  const chain = breadcrumbChain(all, current.id)
  const listing = folderListing(docs, all, current.id) ?? { folders: [], docs: [] }
  const docSearch = share !== undefined ? { share } : {}

  return (
    <>
      <div className="mb-5 flex flex-wrap items-center gap-1 text-sm">
        {chain.map((crumb, i) => (
          <span key={crumb.id} className="flex items-center gap-1">
            {i > 0 ? <ChevronRight size={13} className="text-[var(--ink-faint)]" /> : null}
            {i === chain.length - 1 ? (
              <span className="flex items-center gap-1.5 font-semibold text-[var(--ink)]">
                {crumb.kind === 'vault' ? <FolderRoot size={14} className="text-[var(--accent)]" /> : <Folder size={14} />}
                {crumb.name}
              </span>
            ) : (
              <Link
                to="/f/$folderId"
                params={{ folderId: root.id }}
                search={{ ...docSearch, ...(crumb.id !== root.id ? { folder: crumb.id } : {}) }}
                className="flex items-center gap-1.5 font-medium text-[var(--ink-soft)] no-underline hover:text-[var(--accent)]"
              >
                {crumb.kind === 'vault' ? <FolderRoot size={14} className="text-[var(--accent)]" /> : <Folder size={14} />}
                {crumb.name}
              </Link>
            )}
          </span>
        ))}
      </div>

      {listing.folders.length === 0 && listing.docs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--line)] px-4 py-10 text-center">
          <p className="m-0 text-sm font-medium text-[var(--ink-soft)]">
            {current.kind === 'vault' ? 'This vault is empty.' : 'This folder is empty.'}
          </p>
        </div>
      ) : (
        <ul className="island-shell m-0 list-none divide-y divide-[var(--line)] p-0">
          {listing.folders.map((sub) => (
            <li key={sub.id} className={`${ROW_CLASS} hover:bg-[var(--paper-soft)]`}>
              <Link
                to="/f/$folderId"
                params={{ folderId: root.id }}
                search={{ ...docSearch, folder: sub.id }}
                title={sub.name}
                className="flex min-w-0 flex-1 items-center gap-3 py-2.5 text-sm font-medium text-[var(--ink)] no-underline hover:text-[var(--accent)]"
              >
                <Folder size={16} className="shrink-0 text-[var(--ink-soft)]" />
                <span className="truncate">{sub.name}</span>
              </Link>
            </li>
          ))}
          {listing.docs.map((doc) => (
            <li key={doc.id} className={`${ROW_CLASS} hover:bg-[var(--paper-soft)]`}>
              <Link
                to="/d/$docId"
                params={{ docId: doc.id }}
                search={docSearch}
                title={doc.title}
                className="flex min-w-0 flex-1 items-center gap-3 py-2.5 text-sm font-medium text-[var(--ink)] no-underline hover:text-[var(--accent)]"
              >
                <FileText size={16} className="shrink-0 text-[var(--ink-faint)]" />
                <span className="truncate">{doc.title}</span>
              </Link>
              <span className="hidden w-20 shrink-0 whitespace-nowrap text-right text-xs text-[var(--ink-faint)] sm:inline">
                {timeAgo(doc.updatedAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

const ROW_CLASS = 'group flex min-h-[42px] items-center gap-3 px-3 first:rounded-t-[11px] last:rounded-b-[11px]'

/** Revoked/invalid token, or no access at all — the doc-link dead-end, folder-flavored. */
function LinkDeadCard({ error, folderId, share }: { error: unknown; folderId: string; share: string | undefined }) {
  // 401 = anonymous without a token (or a comment+ link, which anonymous
  // visitors can't ride): signing in may well grant access.
  const needsSignIn = error instanceof ApiError && error.status === 401
  const next = `/f/${encodeURIComponent(folderId)}${share ? `?share=${encodeURIComponent(share)}` : ''}`
  return (
    <section className="island-shell rise-in mx-auto w-full max-w-md px-8 py-12 text-center">
      <span className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--paper-soft)] text-[var(--ink-faint)]">
        <FolderX size={20} />
      </span>
      <h1 className="display-title m-0 mb-2 text-2xl font-bold tracking-tight text-[var(--ink)]">
        {needsSignIn ? 'Sign in to view this' : 'This link doesn’t work'}
      </h1>
      <p className="m-0 mb-6 text-sm text-[var(--ink-soft)]">
        {needsSignIn
          ? 'This shared folder needs a signed-in account (or the link grants more than viewing, which requires one).'
          : 'The folder doesn’t exist, the link was revoked, or you don’t have access to it. Ask the person who shared it for a new link.'}
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

/** `?folder=` points outside the shared subtree (stale or hand-edited URL). */
function NotInSubtree({ rootId, share }: { rootId: string; share: string | undefined }) {
  return (
    <div className="rounded-lg border border-dashed border-[var(--line)] px-4 py-10 text-center">
      <p className="m-0 text-sm font-medium text-[var(--ink-soft)]">That folder isn’t part of this shared link.</p>
      <Link
        to="/f/$folderId"
        params={{ folderId: rootId }}
        search={share !== undefined ? { share } : {}}
        className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 py-1.5 text-sm font-medium text-[var(--ink)] no-underline transition hover:bg-[var(--paper-soft)]"
      >
        Back to the shared folder
      </Link>
    </div>
  )
}
