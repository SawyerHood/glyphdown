import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import type { DocMeta } from '@glyphdown/protocol'
import { Button } from '../ui.tsx'
import { PanelSkeleton } from '../DocSkeletons.tsx'
import { FileText, RefreshCw } from 'lucide-react'

export const backlinksKey = (docId: string) => ['doc-backlinks', docId] as const

/**
 * Backlinks come from the search lane's index (GET /api/docs/:id/backlinks).
 * That endpoint may not be deployed yet — a 404 resolves to `null` so the
 * panel can degrade to a placeholder instead of an error.
 */
async function fetchBacklinks(docId: string, share?: string): Promise<DocMeta[] | null> {
  const res = await fetch(`/api/docs/${encodeURIComponent(docId)}/backlinks`, {
    credentials: 'same-origin',
    ...(share ? { headers: { 'x-glyphdown-share': share } } : {}),
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`backlinks failed (${res.status})`)
  const data = (await res.json()) as { docs: DocMeta[] }
  return data.docs
}

/**
 * Sidebar section listing the documents that link to this one. Refetched on
 * doc switch (the editor page is keyed by docId) and via the refresh button.
 */
export default function BacklinksPanel({ docId, share }: { docId: string; share: string | undefined }) {
  const navigate = useNavigate()
  const query = useQuery({
    queryKey: backlinksKey(docId),
    queryFn: () => fetchBacklinks(docId, share),
    retry: false,
  })

  if (query.isLoading) {
    // Ghost rows (anti-flash delayed) — cached docs render instantly instead.
    return <PanelSkeleton rows={2} />
  }

  if (query.data === null) {
    // The search index isn't available on this deployment — degrade quietly.
    return <p className="px-4 py-8 text-center text-xs text-[var(--ink-faint)]">Backlinks need the search index.</p>
  }

  if (query.isError) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-8">
        <p className="m-0 text-xs text-[var(--ink-faint)]">Couldn’t load backlinks.</p>
        <Button size="sm" onClick={() => void query.refetch()}>
          Retry
        </Button>
      </div>
    )
  }

  const docs = query.data ?? []
  return (
    <div className="flex flex-col gap-1 p-3">
      <div className="mb-1 flex items-center justify-between pl-1">
        <span className="text-xs font-medium text-[var(--ink-soft)]">
          {docs.length === 0
            ? 'No documents link here yet.'
            : `${docs.length} document${docs.length === 1 ? '' : 's'} link${docs.length === 1 ? 's' : ''} here`}
        </span>
        <Button size="sm" variant="ghost" onClick={() => void query.refetch()} title="Refresh backlinks">
          <RefreshCw size={13} />
        </Button>
      </div>
      {docs.map((doc) => (
        <button
          key={doc.id}
          type="button"
          onClick={() => void navigate({ to: '/d/$docId', params: { docId: doc.id } })}
          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-[var(--ink)] transition hover:bg-[var(--paper-soft)]"
        >
          <FileText size={13} className="shrink-0 text-[var(--ink-faint)]" />
          <span className="truncate">{doc.title}</span>
        </button>
      ))}
    </div>
  )
}
