import { useMemo, useState } from 'react'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Clock, RotateCcw, Tag } from 'lucide-react'
import { roleAtLeast, type VersionMeta } from '@glyphdown/protocol'
import { getDoc, getDocContent, getVersionText, listVersions, restoreVersion } from '../lib/api.ts'
import { diffStats, diffText } from '../lib/diff.ts'
import { timeAgo } from '../lib/presence.ts'
import { Badge, Button, ConfirmDialog, EmptyState, Spinner } from '../components/ui.tsx'

export const Route = createFileRoute('/d/$docId/history')({
  validateSearch: (search: Record<string, unknown>): { share?: string } =>
    typeof search['share'] === 'string' ? { share: search['share'] } : {},
  component: HistoryPage,
})

function HistoryPage() {
  const { docId } = Route.useParams()
  const { share } = Route.useSearch()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const docQuery = useQuery({ queryKey: ['doc', docId], queryFn: () => getDoc(docId, share) })
  const versionsQuery = useQuery({
    queryKey: ['doc-versions', docId],
    queryFn: () => listVersions(docId, share),
  })
  const currentQuery = useQuery({
    queryKey: ['doc-content', docId],
    queryFn: () => getDocContent(docId, share),
    staleTime: 0,
  })

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<'diff' | 'view'>('diff')
  const [confirmRestore, setConfirmRestore] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const versions = versionsQuery.data ?? []
  const selected = versions.find((v) => v.id === selectedId) ?? versions[0] ?? null

  const versionTextQuery = useQuery({
    queryKey: ['doc-version-text', docId, selected?.id],
    queryFn: () => getVersionText(docId, selected!.id, share),
    enabled: selected !== null,
  })

  const canRestore = docQuery.data ? roleAtLeast(docQuery.data.role, 'editor') : false

  const doRestore = async () => {
    if (!selected) return
    setRestoring(true)
    try {
      await restoreVersion(docId, selected.id)
      await queryClient.invalidateQueries({ queryKey: ['doc-versions', docId] })
      await queryClient.invalidateQueries({ queryKey: ['doc-content', docId] })
      void navigate({ to: '/d/$docId', params: { docId }, search: share ? { share } : {} })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Restore failed')
      setTimeout(() => setError(null), 4000)
    } finally {
      setRestoring(false)
    }
  }

  return (
    <div className="flex h-screen flex-col bg-[var(--bg-base)]">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-[var(--line)] bg-[var(--paper)] px-3">
        <Link
          to="/d/$docId"
          params={{ docId }}
          search={share ? { share } : {}}
          className="flex items-center gap-1.5 text-sm font-medium text-[var(--ink-soft)] no-underline hover:text-[var(--ink)]"
        >
          <ArrowLeft size={15} /> Back to editor
        </Link>
        <span className="text-sm font-semibold text-[var(--ink)]">
          {docQuery.data?.title ?? 'Document'} — history
        </span>
        {error ? <span className="text-xs font-medium text-red-600">{error}</span> : null}
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Version list */}
        <aside className="w-72 shrink-0 overflow-y-auto border-r border-[var(--line)] bg-[var(--paper)]">
          {versionsQuery.isLoading ? (
            <Spinner />
          ) : versions.length === 0 ? (
            <div className="p-3">
              <EmptyState title="No versions yet" hint="Versions are captured automatically as the doc is edited." />
            </div>
          ) : (
            <ul className="m-0 list-none divide-y divide-[var(--line)] p-0">
              {versions.map((version) => (
                <li key={version.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(version.id)}
                    className={`block w-full px-3 py-2.5 text-left transition hover:bg-[var(--paper-soft)] ${
                      selected?.id === version.id ? 'bg-[var(--accent-soft)]' : ''
                    }`}
                  >
                    <div className="flex items-center gap-1.5">
                      <VersionBadge version={version} />
                      <span className="ml-auto text-[11px] text-[var(--ink-faint)]">{timeAgo(version.createdAt)}</span>
                    </div>
                    {version.name ? (
                      <p className="m-0 mt-1 truncate text-sm font-medium text-[var(--ink)]">{version.name}</p>
                    ) : null}
                    <p className="m-0 mt-0.5 text-[11px] text-[var(--ink-faint)]">
                      {new Date(version.createdAt).toLocaleString()} · {formatBytes(version.sizeBytes)}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        {/* Version body */}
        <main className="min-w-0 flex-1 overflow-y-auto">
          {selected === null ? null : (
            <div className="mx-auto max-w-3xl px-6 py-6">
              <div className="mb-4 flex flex-wrap items-center gap-2">
                <h2 className="m-0 flex items-center gap-2 text-base font-semibold text-[var(--ink)]">
                  <Clock size={15} />
                  {selected.name ?? `Version from ${new Date(selected.createdAt).toLocaleString()}`}
                </h2>
                <VersionBadge version={selected} />
                <div className="ml-auto flex items-center gap-2">
                  <div className="flex overflow-hidden rounded-md border border-[var(--line)] text-xs font-medium">
                    <button
                      type="button"
                      onClick={() => setViewMode('diff')}
                      className={`px-2.5 py-1 ${viewMode === 'diff' ? 'bg-[var(--accent)] text-white' : 'bg-[var(--paper)] text-[var(--ink-soft)]'}`}
                    >
                      Diff vs current
                    </button>
                    <button
                      type="button"
                      onClick={() => setViewMode('view')}
                      className={`px-2.5 py-1 ${viewMode === 'view' ? 'bg-[var(--accent)] text-white' : 'bg-[var(--paper)] text-[var(--ink-soft)]'}`}
                    >
                      View
                    </button>
                  </div>
                  {canRestore ? (
                    <Button variant="primary" size="sm" disabled={restoring} onClick={() => setConfirmRestore(true)}>
                      <RotateCcw size={13} /> Restore
                    </Button>
                  ) : null}
                </div>
              </div>

              {versionTextQuery.isLoading || currentQuery.isLoading ? (
                <Spinner label="Loading version…" />
              ) : viewMode === 'view' ? (
                <pre className="island-shell m-0 overflow-x-auto whitespace-pre-wrap p-5 font-serif text-[15px] leading-relaxed text-[var(--ink)]">
                  {versionTextQuery.data ?? ''}
                </pre>
              ) : (
                <DiffView oldText={versionTextQuery.data ?? ''} newText={currentQuery.data ?? ''} />
              )}
            </div>
          )}
        </main>
      </div>

      <ConfirmDialog
        open={confirmRestore}
        onClose={() => setConfirmRestore(false)}
        onConfirm={() => void doRestore()}
        title="Restore this version"
        body="The document will be replaced with this version's text. Restoring is itself an edit — the current state is kept as a restore point, so nothing is lost."
        confirmLabel="Restore"
      />
    </div>
  )
}

function VersionBadge({ version }: { version: VersionMeta }) {
  if (version.kind === 'named') {
    return (
      <Badge tone="blue">
        <Tag size={9} className="mr-0.5" /> named
      </Badge>
    )
  }
  if (version.kind === 'restore-point') return <Badge tone="amber">restore point</Badge>
  return <Badge>auto</Badge>
}

function DiffView({ oldText, newText }: { oldText: string; newText: string }) {
  const spans = useMemo(() => diffText(oldText, newText), [oldText, newText])
  const stats = useMemo(() => diffStats(spans), [spans])
  const unchanged = spans.length === 1 && spans[0]?.kind === 'equal'

  return (
    <div>
      <p className="m-0 mb-2 text-xs text-[var(--ink-soft)]">
        {unchanged ? (
          'This version matches the current document.'
        ) : (
          <>
            <span className="font-medium text-green-700">+{stats.added}</span>{' '}
            <span className="font-medium text-red-700">−{stats.removed}</span> characters vs this version (green =
            added since, red = removed since)
          </>
        )}
      </p>
      <pre className="ink-diff island-shell m-0 overflow-x-auto whitespace-pre-wrap p-5 font-serif text-[15px] leading-relaxed text-[var(--ink)]">
        {spans.map((span, i) =>
          span.kind === 'equal' ? (
            <span key={i}>{span.text}</span>
          ) : span.kind === 'insert' ? (
            <ins key={i}>{span.text}</ins>
          ) : (
            <del key={i}>{span.text}</del>
          ),
        )}
      </pre>
    </div>
  )
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}
