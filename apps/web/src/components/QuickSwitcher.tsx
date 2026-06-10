import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { FileText, Search } from 'lucide-react'
import type { SearchResult } from '@glyphdown/protocol'
import { listDocs, listFolders, searchDocs } from '../lib/api.ts'
import { track } from '../lib/analytics.ts'
import { rankDocs } from '../lib/fuzzy.ts'
import { getRecentDocIds, recordRecentDoc } from '../lib/recents.ts'
import { useActiveVault } from '../lib/useActiveVault.ts'
import { docVaultId } from '../lib/vaults.ts'

/**
 * Cmd/Ctrl+K quick switcher (mounted once in __root.tsx): instant fuzzy
 * title matching over the cached docs list (recency-boosted via the
 * localStorage visited list), plus a debounced full-text section from
 * GET /api/search with «»-highlighted snippets. Arrow keys + Enter navigate,
 * Esc / backdrop click closes.
 *
 * SCOPED TO THE ACTIVE VAULT (vaults plan §4): each doc's vault is computed
 * client-side from the folders list (folderId → parent chain → vault root)
 * and both sections filter to it. Docs whose vault is not derivable (e.g. a
 * doc shared directly out of someone else's vault) stay visible in every
 * scope — hiding them everywhere would lose them entirely. Server-side
 * search stays vault-agnostic; the Worker filter is a planned fast-follow.
 */

const SEARCH_DEBOUNCE_MS = 250

export default function QuickSwitcher() {
  const [open, setOpen] = useState(false)
  const pathname = useRouterState({ select: (s) => s.location.pathname })

  // Record visited docs for the recency boost. Watching the URL here keeps
  // the feature self-contained (no editor-page changes).
  useEffect(() => {
    const match = pathname.match(/^\/d\/([^/]+)/)
    if (match) recordRecentDoc(decodeURIComponent(match[1]!))
  }, [pathname])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && !e.altKey && !e.shiftKey) {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const close = useCallback(() => setOpen(false), [])
  if (!open) return null
  return <SwitcherPanel onClose={close} />
}

interface Item {
  key: string
  docId: string
  title: string
  positions: number[]
  snippet?: string
}

function SwitcherPanel({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate()
  const panelRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [selected, setSelected] = useState(0)
  const recents = useMemo(() => getRecentDocIds(), [])

  const docsQuery = useQuery({ queryKey: ['docs'], queryFn: listDocs })
  const foldersQuery = useQuery({ queryKey: ['folders'], queryFn: listFolders })
  const activeVault = useActiveVault()

  // The active vault's docs (plus vault-less strays, which would otherwise be
  // unreachable from any scope). No filtering until both lists have loaded.
  const scopedDocs = useMemo(() => {
    const docs = docsQuery.data ?? []
    const folders = foldersQuery.data
    if (activeVault === null || folders === undefined) return docs
    return docs.filter((d) => {
      const vaultId = docVaultId(d, folders)
      return vaultId === null || vaultId === activeVault.id
    })
  }, [docsQuery.data, foldersQuery.data, activeVault])

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [query])

  const searchQuery = useQuery({
    queryKey: ['search', debounced],
    queryFn: () => searchDocs(debounced),
    enabled: debounced.length > 0,
    staleTime: 10_000,
  })

  // search_performed analytics: one event per executed (debounced) search —
  // result COUNT only, never the query text. Deduped per query string so
  // re-renders with cached data don't re-fire.
  const lastTrackedSearch = useRef<string | null>(null)
  useEffect(() => {
    if (debounced.length === 0 || searchQuery.data === undefined) return
    if (lastTrackedSearch.current === debounced) return
    lastTrackedSearch.current = debounced
    track('search_performed', { resultCount: searchQuery.data.length })
  }, [debounced, searchQuery.data])

  const titleHits = useMemo(() => rankDocs(query.trim(), scopedDocs, recents), [query, scopedDocs, recents])
  const fullText: SearchResult[] = useMemo(() => {
    if (debounced.length === 0 || !searchQuery.data) return []
    const inTitles = new Set(titleHits.map((h) => h.doc.id))
    // Full-text results scope to the vault too: keep a hit only when it maps
    // to a doc the scoped list contains.
    const inScope = new Set(scopedDocs.map((d) => d.id))
    return searchQuery.data.filter((r) => inScope.has(r.docId) && !inTitles.has(r.docId))
  }, [debounced, searchQuery.data, titleHits, scopedDocs])

  const items: Item[] = useMemo(
    () => [
      ...titleHits.map((h) => ({ key: `t:${h.doc.id}`, docId: h.doc.id, title: h.doc.title, positions: h.positions })),
      ...fullText.map((r) => ({ key: `s:${r.docId}`, docId: r.docId, title: r.title, positions: [], snippet: r.snippet })),
    ],
    [titleHits, fullText],
  )

  // Clamp/reset the selection when the result set changes.
  useEffect(() => {
    setSelected((s) => Math.min(s, Math.max(items.length - 1, 0)))
  }, [items.length])
  useEffect(() => {
    setSelected(0)
  }, [query])
  useEffect(() => {
    listRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const go = (docId: string) => {
    recordRecentDoc(docId)
    onClose()
    void navigate({ to: '/d/$docId', params: { docId } })
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected((s) => Math.min(s + 1, Math.max(items.length - 1, 0)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected((s) => Math.max(s - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = items[selected]
      if (item) go(item.docId)
    }
  }

  const sectionLabel = (text: string) => (
    <div className="px-3 pb-1 pt-2.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--ink-faint)]">
      {text}
    </div>
  )

  const row = (item: Item, index: number) => (
    <button
      key={item.key}
      type="button"
      data-selected={index === selected}
      onMouseEnter={() => setSelected(index)}
      onClick={() => go(item.docId)}
      className={`flex w-full items-start gap-2.5 px-3 py-2 text-left transition ${
        index === selected ? 'bg-[var(--accent-soft)]' : ''
      }`}
    >
      <FileText size={15} className="mt-0.5 shrink-0 text-[var(--ink-faint)]" />
      <span className="min-w-0">
        <span className="block truncate text-sm text-[var(--ink)]">
          <TitleLabel title={item.title} positions={item.positions} />
        </span>
        {item.snippet !== undefined ? (
          <span className="mt-0.5 block truncate text-xs text-[var(--ink-soft)]">
            <Snippet text={item.snippet} />
          </span>
        ) : null}
      </span>
    </button>
  )

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center bg-black/40 px-4 pt-[12vh]"
      onMouseDown={(e) => {
        if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose()
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Quick switcher"
        className="w-full max-w-lg overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--paper)] shadow-xl"
      >
        <div className="flex items-center gap-2.5 border-b border-[var(--line)] px-3.5 py-3">
          <Search size={16} className="shrink-0 text-[var(--ink-faint)]" />
          <input
            type="text"
            value={query}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={activeVault ? `Jump to a doc or search in ${activeVault.name}…` : 'Jump to a doc or search…'}
            aria-label="Search documents"
            className="w-full bg-transparent text-sm text-[var(--ink)] outline-none placeholder:text-[var(--ink-faint)]"
          />
          <kbd className="shrink-0 rounded border border-[var(--line)] bg-[var(--paper-soft)] px-1.5 py-0.5 text-[10px] text-[var(--ink-faint)]">
            esc
          </kbd>
        </div>

        <div ref={listRef} className="max-h-[50vh] overflow-y-auto pb-1.5">
          {items.length === 0 ? (
            <p className="m-0 px-3 py-6 text-center text-sm text-[var(--ink-soft)]">
              {docsQuery.isLoading || searchQuery.isFetching ? 'Searching…' : 'No matches'}
            </p>
          ) : (
            <>
              {titleHits.length > 0 ? sectionLabel(query.trim() === '' ? 'Recent & all docs' : 'Documents') : null}
              {items.slice(0, titleHits.length).map((item, i) => row(item, i))}
              {fullText.length > 0 ? sectionLabel('Full text') : null}
              {items.slice(titleHits.length).map((item, i) => row(item, titleHits.length + i))}
              {debounced.length > 0 && searchQuery.isFetching ? (
                <p className="m-0 px-3 py-1.5 text-xs text-[var(--ink-faint)]">Searching full text…</p>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** Title with the fuzzy-matched characters emphasized. */
function TitleLabel({ title, positions }: { title: string; positions: number[] }) {
  if (positions.length === 0) return <>{title}</>
  const matched = new Set(positions)
  return (
    <>
      {[...title].map((ch, i) =>
        matched.has(i) ? (
          <span key={i} className="font-semibold text-[var(--accent)]">
            {ch}
          </span>
        ) : (
          <span key={i}>{ch}</span>
        ),
      )}
    </>
  )
}

/** Render a search snippet, turning «hit» markers into highlights. */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/«([^»]*)»/)
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded-sm bg-[var(--accent-soft)] px-0.5 font-medium text-[var(--accent)]">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  )
}
