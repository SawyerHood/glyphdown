import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import * as Y from 'yjs'
import YProvider from 'y-partyserver/provider'
import { Compartment, EditorSelection, EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { defaultKeymap } from '@codemirror/commands'
import {
  createSuggestMode,
  dispatchDocAnnotations,
  docAnnotations,
  imageResolver,
  glyphdownCollab,
  glyphdownHighlighting,
  glyphdownMarkdown,
  glyphdownTheme,
  livePreview,
  markdownAutoClose,
  markdownTab,
  refreshWikiLinksEffect,
  wikiLinkContext,
  wikiLinks,
  type SuggestMode,
  type WikiLinkDoc,
} from '@glyphdown/editor'
import { resolveAnchor, type Anchor, type Range } from '@glyphdown/core'
import {
  roleAtLeast,
  type ClientMessage,
  type Comment,
  type DocEvent,
  type DocMeta,
  type Principal,
  type Role,
  type VersionMeta,
} from '@glyphdown/protocol'
import {
  ApiError,
  assetUrl,
  createDoc,
  createNamedVersion,
  fetchMe,
  getDoc,
  listComments,
  listDocs,
  listFolders,
  listMembers,
  listSuggestions,
  patchDoc,
  type SuggestionWithMeta,
} from '../../lib/api.ts'
import { docVaultId, vaultIdForFolder } from '../../lib/vaults.ts'
import { imageUpload } from './imageUpload.ts'
import { track } from '../../lib/analytics.ts'
import { presenceColor } from '../../lib/presence.ts'
import { liveSlug, slugifyDocStem, wikiSlug } from '../../lib/slug.ts'
import { readWithLegacyMigration } from '../../lib/localStorage.ts'
import { useLoadingFade } from '../../lib/useLoadingFade.ts'
import { useIsMobile } from '../../lib/useMediaQuery.ts'
import { DocumentSkeleton, PanelSkeleton } from '../DocSkeletons.tsx'
import { Badge, Button, Dialog, Input } from '../ui.tsx'
import {
  Eye,
  FileCode2,
  History,
  MessageSquare,
  MessageSquarePlus,
  PenLine,
  Pencil,
  Share2,
  Tag,
  X,
} from 'lucide-react'
import CommentsSidebar, { type PendingComment } from './CommentsSidebar.tsx'
import SuggestionsPanel from './SuggestionsPanel.tsx'
import ShareDialog from './ShareDialog.tsx'
import EditorHeader, { BrandSquare } from './EditorHeader.tsx'
import BacklinksPanel from './BacklinksPanel.tsx'

export const commentsKey = (docId: string) => ['doc-comments', docId] as const
export const suggestionsKey = (docId: string) => ['doc-suggestions', docId] as const
export const versionsKey = (docId: string) => ['doc-versions', docId] as const

export type Mode = 'edit' | 'suggest'
type ConnStatus = 'connecting' | 'connected' | 'disconnected'

interface Peer {
  clientId: number
  name: string
  color: string
  isAgent: boolean
}

interface EditorHandles {
  ydoc: Y.Doc
  ytext: Y.Text
  provider: YProvider
  view: EditorView
  suggestMode: SuggestMode
  suggestComp: Compartment
  previewComp: Compartment
}

function upsertById<T extends { id: string }>(list: T[] | undefined, item: T): T[] {
  const next = [...(list ?? [])]
  const idx = next.findIndex((x) => x.id === item.id)
  if (idx >= 0) next[idx] = item
  else next.push(item)
  return next
}

function applyDocEvent(queryClient: QueryClient, docId: string, event: DocEvent): void {
  switch (event.t) {
    case 'comment':
      queryClient.setQueryData<Comment[]>(commentsKey(docId), (old) => upsertById(old, event.comment))
      break
    case 'comment-removed':
      queryClient.setQueryData<Comment[]>(commentsKey(docId), (old) => (old ?? []).filter((c) => c.id !== event.id))
      break
    case 'suggestion':
      queryClient.setQueryData<SuggestionWithMeta[]>(suggestionsKey(docId), (old) =>
        upsertById(old, event.suggestion as SuggestionWithMeta),
      )
      break
    case 'suggestion-status':
      queryClient.setQueryData<SuggestionWithMeta[]>(suggestionsKey(docId), (old) =>
        (old ?? []).map((s) =>
          s.id === event.id
            ? { ...s, status: event.status, ...(event.outdatedParts !== undefined ? { outdatedParts: event.outdatedParts } : {}) }
            : s,
        ),
      )
      break
    case 'version':
      queryClient.setQueryData<VersionMeta[]>(versionsKey(docId), (old) => {
        const next = (old ?? []).filter((v) => v.id !== event.version.id)
        return [event.version, ...next]
      })
      break
    case 'doc-deleted':
      // handled by the page via its own listener
      break
  }
}

/**
 * The whole editor page. Deliberately NOT remounted per doc: the chrome
 * (toolbar frame, sidebar shell) persists across doc switches and only the
 * doc-specific machinery (Y.Doc, provider, CodeMirror view) is torn down and
 * rebuilt when `docId` changes. While the new doc's provider syncs, the
 * document column shows a skeleton that crossfades into the editor — no
 * spinners anywhere in the switch path.
 */
export function DocEditorPage({ docId, share }: { docId: string; share: string | undefined }) {
  const meQuery = useQuery({ queryKey: ['me'], queryFn: fetchMe, staleTime: 60_000 })
  const docQuery = useQuery({ queryKey: ['doc', docId], queryFn: () => getDoc(docId, share) })

  const queryClient = useQueryClient()
  const navigate = useNavigate()

  // `meta` is null while the doc-meta query for THIS doc is in flight (first
  // visit only — revisits hit the TanStack cache and render instantly).
  const meta: DocMeta | null = docQuery.data ?? null
  const me: Principal | null = meQuery.data ?? null
  const meResolved = !meQuery.isLoading
  const role: Role = meta?.role ?? 'viewer'
  const canComment = meta !== null && me !== null && roleAtLeast(role, 'commenter')
  const canSuggest = meta !== null && me !== null && roleAtLeast(role, 'suggester')
  const canEdit = meta !== null && roleAtLeast(role, 'editor')
  const isOwner = meta !== null && role === 'owner'

  const meId = me?.id ?? 'anonymous'
  const meName = me?.name ?? 'Anonymous'
  const meIsAgent = me?.type === 'agent'

  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<EditorHandles | null>(null)

  // <lg: the comments/suggestions panel becomes a bottom sheet and comment
  // affordances trade hover/coordinate positioning for fixed touch targets.
  const isMobile = useIsMobile()
  // Ref mirror for stable callbacks (revealRange) that only need the value
  // at call time.
  const isMobileRef = useRef(isMobile)
  isMobileRef.current = isMobile

  const [ready, setReady] = useState(false)
  // Which doc the live provider has completed its first sync for. Derived
  // comparison (`syncedDocId === docId`) means a doc switch flips the column
  // back to "loading" on the very same render — no stale-content frame.
  const [syncedDocId, setSyncedDocId] = useState<string | null>(null)
  const [status, setStatus] = useState<ConnStatus>('connecting')
  const [offlineSince, setOfflineSince] = useState<number | null>(null)
  const [showOfflineBanner, setShowOfflineBanner] = useState(false)
  const [deleted, setDeleted] = useState(false)
  const [peers, setPeers] = useState<Peer[]>([])
  // Per-doc; the editor-creation effect computes the real initial value
  // (role + localStorage) when it builds the view.
  const [mode, setModeState] = useState<Mode>('edit')
  // Mirrors `mode` for the mount-once editor extensions (paste/drop upload
  // checks it at upload time, not mount time).
  const modeRef = useRef(mode)
  const [sourceView, setSourceView] = useState(false)
  const [selection, setSelection] = useState<{ from: number; to: number; head: number } | null>(null)
  const [bubble, setBubble] = useState<{ left: number; top: number } | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarTab, setSidebarTab] = useState<'comments' | 'suggestions' | 'links'>('comments')
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null)
  const [activeSuggestionId, setActiveSuggestionId] = useState<string | null>(null)
  const [pendingComment, setPendingComment] = useState<PendingComment | null>(null)
  const [shareOpen, setShareOpen] = useState(false)
  const [namingVersion, setNamingVersion] = useState(false)
  const [versionName, setVersionName] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [error, setError] = useState<string | null>(null)

  // suggestion_created analytics dedupe: suggest mode re-emits the same
  // record id on every flush while the author keeps typing — count each
  // suggestion once. Cleared on doc switch.
  const trackedSuggestionIds = useRef<Set<string>>(new Set())

  // Doc switch: clear doc-scoped UI state. The chrome itself (sidebar
  // open/tab, this component) persists — that is the point.
  useEffect(() => {
    trackedSuggestionIds.current = new Set()
    setStatus('connecting')
    setOfflineSince(null)
    setDeleted(false)
    setPeers([])
    setModeState('edit')
    modeRef.current = 'edit'
    setSourceView(false)
    setSelection(null)
    setBubble(null)
    setActiveCommentId(null)
    setActiveSuggestionId(null)
    setPendingComment(null)
    setShareOpen(false)
    setNamingVersion(false)
    setVersionName('')
    setError(null)
  }, [docId])

  // The displayed name follows the doc; an in-progress rename is abandoned
  // when the doc (or its title, e.g. renamed elsewhere) changes.
  const metaTitle = meta?.title
  useEffect(() => {
    setTitleDraft(metaTitle ?? '')
    setRenaming(false)
  }, [docId, metaTitle])

  const report = useCallback((err: unknown) => {
    const message = err instanceof Error ? err.message : 'Something went wrong'
    setError(message)
    setTimeout(() => setError(null), 4000)
  }, [])

  const commentsQuery = useQuery({
    queryKey: commentsKey(docId),
    queryFn: () => listComments(docId, share),
    staleTime: Infinity,
  })
  const suggestionsQuery = useQuery({
    queryKey: suggestionsKey(docId),
    queryFn: () => listSuggestions(docId, share),
    staleTime: Infinity,
  })
  const membersQuery = useQuery({
    queryKey: ['doc-members', docId],
    queryFn: () => listMembers(docId, share),
    staleTime: 60_000,
  })
  const members = membersQuery.data ?? []

  // Docs the caller can access — wiki-link resolution + completion candidates.
  // Anonymous share-link visitors can't list docs; their links stay unresolved.
  const docsQuery = useQuery({
    queryKey: ['docs'],
    queryFn: listDocs,
    staleTime: 30_000,
    enabled: me !== null,
    retry: false,
  })
  // Folders too: [[wiki links]] resolve IN-VAULT (vaults plan §4) — each
  // doc's vault derives from its folder chain, so the candidate set below
  // filters to this doc's vault. Same ['folders'] key as the rest of the app.
  const foldersQuery = useQuery({
    queryKey: ['folders'],
    queryFn: listFolders,
    staleTime: 30_000,
    enabled: me !== null,
    retry: false,
  })
  // Read through a ref so the mount-once editor facet sees fresh data.
  // Entries carry the filename STEM as `title` — names ARE slugs now.
  const wikiDocsRef = useRef<WikiLinkDoc[]>([])

  // -------------------------------------------------------------------------
  // Anchor resolution against the live Y.Doc
  // -------------------------------------------------------------------------

  const resolveRange = useCallback((anchor: Anchor): Range | null => {
    const h = editorRef.current
    if (!h) return null
    try {
      return resolveAnchor(h.ytext, anchor)
    } catch {
      return null
    }
  }, [])

  const refreshAnnotations = useCallback(() => {
    const h = editorRef.current
    if (!h) return
    const comments = queryClient.getQueryData<Comment[]>(commentsKey(docId)) ?? []
    const suggestions = queryClient.getQueryData<SuggestionWithMeta[]>(suggestionsKey(docId)) ?? []
    dispatchDocAnnotations(h.view, {
      comments: comments.flatMap((comment) => {
        if (comment.resolved || !comment.anchor || comment.anchor.status === 'orphaned') return []
        const range = resolveAnchor(h.ytext, comment.anchor)
        return range && range.end > range.start ? [{ comment, range }] : []
      }),
      suggestions: suggestions
        .filter((s) => s.status === 'open')
        .map((suggestion) => ({
          suggestion,
          parts: suggestion.parts.flatMap((part) => {
            const range = resolveAnchor(h.ytext, part.anchor)
            return range && range.end > range.start ? [{ kind: part.kind, range }] : []
          }),
        })),
    })
  }, [docId, queryClient])

  // -------------------------------------------------------------------------
  // Provider + editor setup — once per doc (torn down/rebuilt on docId or
  // identity/role change). Waits for doc meta + session: role gates the
  // extension set, and both are cached so revisits start instantly.
  // -------------------------------------------------------------------------

  const metaReady = meta !== null

  useEffect(() => {
    const parent = containerRef.current
    if (!parent || !metaReady || !meResolved) return

    // Initial mode for THIS doc (legacy inkroom:mode:* migrated on read).
    const initialMode: Mode =
      !canSuggest
        ? 'edit'
        : role === 'suggester' || !canEdit
          ? 'suggest'
          : typeof localStorage !== 'undefined' &&
              readWithLegacyMigration(`glyphdown:mode:${docId}`, `inkroom:mode:${docId}`) === 'suggest'
            ? 'suggest'
            : 'edit'
    modeRef.current = initialMode
    setModeState(initialMode)

    const ydoc = new Y.Doc()
    const ytext = ydoc.getText('content')
    // partyserver kebab-cases the binding name DocDO to the URL namespace
    // "doc-d-o" (camelCaseToKebabCase), so that is the party segment
    // routePartykitRequest actually matches in server.ts.
    const provider = new YProvider(window.location.origin, docId, ydoc, {
      party: 'doc-d-o',
      ...(share ? { params: { share } } : {}),
    })
    const undoManager = new Y.UndoManager(ytext)

    const { color, light } = presenceColor(meId === 'anonymous' ? `anon-${ydoc.clientID}` : meId)
    const localUser = { name: meName, color, colorLight: light, isAgent: meIsAgent }
    provider.awareness.setLocalStateField('user', localUser)

    const suggestComp = new Compartment()
    const previewComp = new Compartment()

    const suggestMode = createSuggestMode({
      ytext,
      authorId: meId,
      newId: () => crypto.randomUUID(),
      onSuggestion: (records) => {
        for (const record of records) {
          const full: SuggestionWithMeta = { ...record, authorName: meName }
          queryClient.setQueryData<SuggestionWithMeta[]>(suggestionsKey(docId), (old) => upsertById(old, full))
          provider.sendMessage(JSON.stringify({ t: 'suggestion-upsert', suggestion: full } satisfies ClientMessage))
          if (!trackedSuggestionIds.current.has(record.id)) {
            trackedSuggestionIds.current.add(record.id)
            track('suggestion_created', { docId })
          }
        }
        refreshAnnotations()
      },
    })

    const clickHandler = (event: MouseEvent): boolean => {
      const target = event.target as HTMLElement | null
      if (!target) return false
      const link = target.closest('.cm-ink-link')
      if (link) {
        const href = link.getAttribute('data-href')
        if (href) {
          window.open(href, '_blank', 'noopener,noreferrer')
          return true
        }
      }
      const commentEl = target.closest('[data-comment-id]')
      if (commentEl) {
        setActiveCommentId(commentEl.getAttribute('data-comment-id'))
        setSidebarTab('comments')
        setSidebarOpen(true)
        return false
      }
      const suggestionEl = target.closest('[data-suggestion-id]')
      if (suggestionEl) {
        setActiveSuggestionId(suggestionEl.getAttribute('data-suggestion-id'))
        setSidebarTab('suggestions')
        setSidebarOpen(true)
        return false
      }
      return false
    }

    const view = new EditorView({
      state: EditorState.create({
        doc: ytext.toString(),
        extensions: [
          markdownAutoClose(), // before defaultKeymap so its Backspace pair-delete wins
          markdownTab(), // markdown-aware Tab: list indent/outdent, indent-unit insertion in prose
          keymap.of(defaultKeymap), // no history()/historyKeymap — Yjs owns undo
          EditorView.lineWrapping,
          glyphdownMarkdown(),
          glyphdownHighlighting(),
          previewComp.of([livePreview(), wikiLinks()]),
          // Relative image srcs (`name.png`) resolve to the doc's asset
          // routes; share-link sessions carry the token as a query param.
          imageResolver.of((src) => assetUrl(docId, src, share)),
          // [[name]] links resolve against filename STEMS: both sides are
          // slugified for comparison, so canonical [[the-garden]] AND legacy
          // [[The Garden]] targets hit the doc named the-garden.md. The docs
          // list rides a ref — this extension list is mount-once. Unresolved
          // targets create-then-open for signed-in users (the server slugs
          // the written target into the new doc's filename).
          wikiLinkContext.of({
            resolve: (target) => {
              const key = wikiSlug(target)
              if (key === '') return null
              const hit = wikiDocsRef.current.find((d) => wikiSlug(d.title) === key)
              return hit ? { docId: hit.docId } : null
            },
            list: () => wikiDocsRef.current,
            open: (id) => void navigate({ to: '/d/$docId', params: { docId: id } }),
            ...(me
              ? {
                  create: async (target: string) => {
                    try {
                      const created = await createDoc({ filename: slugifyDocStem(target) })
                      track('doc_created', { docId: created.id, source: 'wiki-link' })
                      void queryClient.invalidateQueries({ queryKey: ['docs'] })
                      return { docId: created.id }
                    } catch (err) {
                      report(err)
                      throw err
                    }
                  },
                }
              : {}),
          }),
          glyphdownTheme,
          glyphdownCollab(ytext, provider.awareness, undoManager),
          docAnnotations(),
          canSuggest
            ? suggestComp.of(initialMode === 'suggest' ? suggestMode.extension : [])
            : [EditorState.readOnly.of(true), EditorView.editable.of(false)],
          // Paste/drop image upload is editor+ only (server enforces too);
          // editors in suggest mode upload first, then the markdown insert
          // rides the normal suggest-mode path.
          canEdit
            ? imageUpload({
                docId,
                share,
                isSuggestMode: () => modeRef.current === 'suggest',
                onError: report,
                onUploaded: () => {
                  // Keep the sidebar's folder asset list fresh. Mount-once
                  // closure: read folderId from the live doc query (the doc
                  // may have moved folders since mount).
                  const folderId = queryClient.getQueryData<DocMeta>(['doc', docId])?.folderId ?? null
                  if (folderId) void queryClient.invalidateQueries({ queryKey: ['folder-assets', folderId] })
                },
              })
            : [],
          EditorView.updateListener.of((update) => {
            if (update.selectionSet || update.docChanged) {
              const main = update.state.selection.main
              setSelection(main.empty ? null : { from: main.from, to: main.to, head: main.head })
            }
          }),
          EditorView.domEventHandlers({ click: clickHandler }),
        ],
      }),
      parent,
    })

    editorRef.current = { ydoc, ytext, provider, view, suggestMode, suggestComp, previewComp }

    // --- connection status + DocEvents --------------------------------------
    const onStatus = ({ status: next }: { status: string }) => {
      const s: ConnStatus = next === 'connected' ? 'connected' : next === 'connecting' ? 'connecting' : 'disconnected'
      setStatus(s)
      setOfflineSince((prev) => (s === 'connected' ? null : (prev ?? Date.now())))
    }
    const onSynced = () => {
      // First sync for this doc: fade the editor in over the skeleton.
      setSyncedDocId(docId)
      refreshAnnotations()
    }
    const onCustomMessage = (raw: string) => {
      let event: DocEvent
      try {
        event = JSON.parse(raw) as DocEvent
      } catch {
        return
      }
      if (event.t === 'doc-deleted') {
        setDeleted(true)
        provider.disconnect()
        return
      }
      applyDocEvent(queryClient, docId, event)
      refreshAnnotations()
    }
    provider.on('status', onStatus)
    provider.on('synced', onSynced)
    provider.on('custom-message', onCustomMessage)

    // --- presence ------------------------------------------------------------
    const updatePeers = () => {
      const list: Peer[] = []
      provider.awareness.getStates().forEach((state: Record<string, unknown> | null, clientId: number) => {
        if (clientId === ydoc.clientID) return
        const user = (state as { user?: { name?: string; color?: string; isAgent?: boolean } } | null)?.user
        if (user?.name) {
          list.push({ clientId, name: user.name, color: user.color ?? '#888', isAgent: user.isAgent === true })
        }
      })
      setPeers(list)
    }
    provider.awareness.on('change', updatePeers)
    updatePeers()

    // Ghost-cursor mitigation (SPEC §3.2): null awareness when hidden/unloading.
    const onVisibility = () => {
      if (document.hidden) provider.awareness.setLocalState(null)
      else provider.awareness.setLocalStateField('user', localUser)
    }
    const onUnload = () => provider.awareness.setLocalState(null)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('beforeunload', onUnload)

    setReady(true)

    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('beforeunload', onUnload)
      provider.awareness.off('change', updatePeers)
      provider.off('status', onStatus)
      provider.off('synced', onSynced)
      provider.off('custom-message', onCustomMessage)
      // Tear the live machinery down defensively, each step isolated. A throw
      // from one destroy (e.g. a CodeMirror plugin) must NOT skip the rest —
      // above all, the y-partyserver provider MUST be destroyed: an
      // undestroyed provider keeps `shouldConnect` true and so keeps its
      // WebSocket reconnect timer + Yjs/awareness subscriptions running. On a
      // doc→home route exit (the whole page unmounts) those orphaned providers
      // have nothing left to clean them up and pile up across navigations.
      try {
        view.destroy()
      } catch (err) {
        console.error('editor view teardown failed', err)
      }
      try {
        provider.destroy()
      } catch (err) {
        console.error('provider teardown failed', err)
      }
      try {
        ydoc.destroy()
      } catch (err) {
        console.error('ydoc teardown failed', err)
      }
      editorRef.current = null
      setReady(false)
      // This doc's sync died with its provider; a rebuild (e.g. role change)
      // shows the skeleton again until the new provider syncs.
      setSyncedDocId((current) => (current === docId ? null : current))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per doc/identity/role; closures read live data via refs and the query cache
  }, [docId, share, metaReady, meResolved, role, canSuggest, canEdit, meId, meName, meIsAgent])

  // SPEC §11: banner after 10 s offline.
  useEffect(() => {
    if (offlineSince === null) {
      setShowOfflineBanner(false)
      return
    }
    const tick = () => setShowOfflineBanner(Date.now() - offlineSince > 10_000)
    tick()
    const timer = setInterval(tick, 1_000)
    return () => clearInterval(timer)
  }, [offlineSince])

  // Re-resolve anchors whenever sidecar data lands or changes.
  useEffect(() => {
    if (ready) refreshAnnotations()
  }, [ready, commentsQuery.data, suggestionsQuery.data, refreshAnnotations])

  // Keep wiki-link resolution in sync with the docs list and recompute chips.
  // Candidates are SCOPED TO THIS DOC'S VAULT (vaults plan §4): a [[target]]
  // resolves to the same-named doc in the linking doc's vault; a doc that
  // only exists in another vault stays an unresolved (create-on-click) link,
  // mirroring Obsidian. Docs with no derivable vault — direct shares out of
  // someone else's tree — stay candidates everywhere (the quick switcher's
  // rule), and a doc that itself has no derivable vault keeps the full list.
  const metaFolderId = meta?.folderId ?? null
  useEffect(() => {
    const docs = docsQuery.data ?? []
    const folders = foldersQuery.data
    const vaultId =
      metaFolderId !== null && folders !== undefined ? vaultIdForFolder(folders, metaFolderId) : null
    const inScope =
      vaultId === null
        ? docs
        : docs.filter((d) => {
            const v = docVaultId(d, folders!)
            return v === null || v === vaultId
          })
    wikiDocsRef.current = inScope.map((d) => ({ docId: d.id, title: d.title }))
    if (ready) editorRef.current?.view.dispatch({ effects: refreshWikiLinksEffect.of(null) })
  }, [ready, docsQuery.data, foldersQuery.data, metaFolderId])

  // Floating "Add comment" bubble next to the selection (pointer devices
  // only — on mobile a fixed bottom pill stands in, clear of the native
  // selection callout and its drag handles).
  useEffect(() => {
    const h = editorRef.current
    if (!h || isMobile || !selection || selection.to - selection.from < 8 || !canComment) {
      setBubble(null)
      return
    }
    const coords = h.view.coordsAtPos(selection.head)
    const box = containerRef.current?.getBoundingClientRect()
    if (!coords || !box) {
      setBubble(null)
      return
    }
    setBubble({
      left: Math.min(Math.max(coords.left - box.left, 8), box.width - 150),
      top: Math.min(Math.max(coords.bottom - box.top + 8, 8), box.height - 40),
    })
  }, [selection, canComment, isMobile])

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  const setMode = (next: Mode) => {
    const h = editorRef.current
    if (!h || !canSuggest) return
    if (role === 'suggester' && next === 'edit') return
    if (!canEdit && next === 'edit') return
    h.view.dispatch({ effects: h.suggestComp.reconfigure(next === 'suggest' ? h.suggestMode.extension : []) })
    if (next === 'edit') h.suggestMode.flush()
    try {
      localStorage.setItem(`glyphdown:mode:${docId}`, next)
    } catch {
      // private mode etc.
    }
    modeRef.current = next
    setModeState(next)
  }

  const toggleSource = () => {
    const h = editorRef.current
    if (!h) return
    const next = !sourceView
    h.view.dispatch({ effects: h.previewComp.reconfigure(next ? [] : [livePreview(), wikiLinks()]) })
    setSourceView(next)
  }

  const revealRange = useCallback((range: Range, flashSelector?: string) => {
    const h = editorRef.current
    if (!h) return
    const docLength = h.view.state.doc.length
    const start = Math.min(range.start, docLength)
    h.view.dispatch({
      selection: EditorSelection.cursor(start),
      // Mobile: the bottom sheet covers the lower part of the editor, so pin
      // the target near the top where it stays visible. Desktop keeps the
      // minimal "nearest" scroll.
      effects: EditorView.scrollIntoView(
        start,
        isMobileRef.current ? { y: 'start', yMargin: 88 } : { y: 'nearest' },
      ),
    })
    // Focusing the editor on a touch device pops the keyboard over the very
    // comment the user just tapped — only refocus with a hardware pointer.
    if (!isMobileRef.current) h.view.focus()
    if (flashSelector) {
      requestAnimationFrame(() => {
        h.view.scrollDOM.querySelectorAll(flashSelector).forEach((el) => {
          el.classList.add('ink-flash')
          setTimeout(() => el.classList.remove('ink-flash'), 1300)
        })
      })
    }
  }, [])

  const startComment = () => {
    const h = editorRef.current
    if (!h || !selection) return
    const text = h.ytext.toString()
    setPendingComment({
      startRel: Y.createRelativePositionFromTypeIndex(h.ytext, selection.from, 0),
      endRel: Y.createRelativePositionFromTypeIndex(h.ytext, selection.to, -1),
      quote: text.slice(selection.from, Math.min(selection.to, selection.from + 120)),
    })
    setSidebarTab('comments')
    setSidebarOpen(true)
    setBubble(null)
  }

  const resolvePending = useCallback((pending: PendingComment): { start: number; end: number } | null => {
    const h = editorRef.current
    if (!h) return null
    const start = Y.createAbsolutePositionFromRelativePosition(pending.startRel, h.ydoc, false)
    const end = Y.createAbsolutePositionFromRelativePosition(pending.endRel, h.ydoc, false)
    if (!start || !end || start.type !== h.ytext || end.type !== h.ytext || end.index <= start.index) return null
    return { start: start.index, end: end.index }
  }, [])

  const nameVersion = async () => {
    try {
      const version = await createNamedVersion(docId, versionName.trim())
      track('version_named', { docId })
      queryClient.setQueryData<VersionMeta[]>(versionsKey(docId), (old) => [
        version,
        ...(old ?? []).filter((v) => v.id !== version.id),
      ])
      setNamingVersion(false)
      setVersionName('')
    } catch (err) {
      report(err)
    }
  }

  // Rename = changing the doc's filename stem (the displayed name). The
  // input live-slugs as you type; the server 409s `filename-taken` on a
  // collision in the doc's scope — surfaced inline, nothing is suffixed.
  const saveTitle = async () => {
    if (meta === null) return
    const trimmed = titleDraft.trim()
    setRenaming(false)
    if (trimmed === '' || slugifyDocStem(trimmed) === meta.title) {
      setTitleDraft(meta.title)
      return
    }
    try {
      const updated = await patchDoc(docId, { filename: slugifyDocStem(trimmed) })
      queryClient.setQueryData(['doc', docId], updated)
      setTitleDraft(updated.title)
      void queryClient.invalidateQueries({ queryKey: ['docs'] })
    } catch (err) {
      setTitleDraft(meta.title)
      if (err instanceof ApiError && err.code === 'filename-taken') {
        report(new Error('That name is already taken here — pick another.'))
      } else {
        report(err)
      }
    }
  }

  const comments = commentsQuery.data ?? []
  const suggestions = suggestionsQuery.data ?? []
  const openComments = comments.filter((c) => !c.resolved).length
  const openSuggestions = suggestions.filter((s) => s.status === 'open' && s.parts.length > 0).length

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  // Skeleton → editor crossfade for the document column. 'loading' covers
  // everything before the provider's first sync for THIS doc (meta fetch,
  // websocket connect, Yjs sync); skeleton bars only become visible if that
  // takes >80ms (CSS .skeleton-appear), so fast switches never flash.
  const docSynced = syncedDocId === docId
  const fadePhase = useLoadingFade(!docSynced)

  // doc_opened analytics: the first Yjs sync is the moment the doc is truly
  // open (meta + websocket + content all landed). Re-syncs after reconnects
  // don't re-fire (docSynced stays true); each real doc switch does.
  useEffect(() => {
    if (docSynced) track('doc_opened', { docId, role })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per doc open; role is stable by sync time
  }, [docId, docSynced])

  return (
    <div className="flex h-dvh flex-col bg-[var(--bg-base)]">
      {/* Toolbar */}
      <EditorHeader
        brand={
          <Link to="/" className="no-underline" title="All documents">
            <BrandSquare>
              <PenLine size={13} />
            </BrandSquare>
          </Link>
        }
        title={
          meta === null ? (
            // First visit, meta still in flight: a quiet title-width bar keeps
            // the toolbar frame stable (nothing on error — the column says it).
            docQuery.isError ? null : <div aria-hidden className="skeleton-appear skeleton-bar h-3.5 w-36" />
          ) : renaming ? (
            <input
              value={titleDraft}
              autoFocus
              onChange={(e) => setTitleDraft(liveSlug(e.target.value))}
              onBlur={() => void saveTitle()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void saveTitle()
                if (e.key === 'Escape') {
                  setTitleDraft(meta.title)
                  setRenaming(false)
                }
              }}
              className="min-w-0 max-w-72 rounded border border-[var(--line)] bg-[var(--paper)] px-1.5 py-0.5 text-sm font-semibold text-[var(--ink)] outline-none focus:border-[var(--accent)]"
            />
          ) : (
            <button
              type="button"
              className="group flex min-w-0 items-center gap-1.5 truncate text-sm font-semibold text-[var(--ink)]"
              onClick={() => isOwner && setRenaming(true)}
              title={isOwner ? 'Rename' : meta.title}
            >
              <span className="truncate">{meta.title}</span>
              {isOwner ? <Pencil size={11} className="shrink-0 opacity-0 transition group-hover:opacity-60" /> : null}
            </button>
          )
        }
        badges={
          <>
            {meta !== null && !canEdit ? <Badge tone="blue">{role}</Badge> : null}
            <ConnectionPill status={status} established={docSynced} />
          </>
        }
      >
        <PresenceStack peers={peers} />

        {meta === null ? null : canSuggest && canEdit ? (
          <div className="flex overflow-hidden rounded-md border border-[var(--line)] text-xs font-medium">
            <button
              type="button"
              onClick={() => setMode('edit')}
              className={`px-2.5 py-1 ${mode === 'edit' ? 'bg-[var(--accent)] text-white' : 'bg-[var(--paper)] text-[var(--ink-soft)] hover:bg-[var(--paper-soft)]'}`}
            >
              Edit
            </button>
            <button
              type="button"
              onClick={() => setMode('suggest')}
              className={`px-2.5 py-1 ${mode === 'suggest' ? 'bg-green-600 text-white' : 'bg-[var(--paper)] text-[var(--ink-soft)] hover:bg-[var(--paper-soft)]'}`}
            >
              Suggest
            </button>
          </div>
        ) : canSuggest ? (
          <Badge tone="green">suggesting</Badge>
        ) : (
          <span className="flex items-center gap-1 text-xs text-[var(--ink-faint)]">
            <Eye size={12} /> read-only
          </span>
        )}

        {/* Secondary tools step back on phone widths so the comment toggle
            (and Share) never overflow the toolbar. */}
        <Button size="sm" variant="ghost" onClick={toggleSource} title={sourceView ? 'Live preview' : 'Raw source'} className={`max-sm:hidden ${sourceView ? 'text-[var(--accent)]' : ''}`}>
          <FileCode2 size={15} />
        </Button>

        {canEdit ? (
          <Button size="sm" variant="ghost" onClick={() => setNamingVersion(true)} title="Name this version" className="max-sm:hidden">
            <Tag size={15} />
          </Button>
        ) : null}

        <Link
          to="/d/$docId/history"
          params={{ docId }}
          search={share ? { share } : {}}
          className="rounded-md p-1.5 text-[var(--ink-soft)] transition hover:bg-[var(--paper-soft)] hover:text-[var(--ink)] max-sm:hidden"
          title="Version history"
        >
          <History size={15} />
        </Link>

        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setSidebarOpen((v) => !v)
          }}
          title="Comments & suggestions"
          className={`max-lg:px-3 max-lg:py-2 ${sidebarOpen ? 'text-[var(--accent)]' : ''}`}
        >
          <MessageSquare size={15} />
          {openComments + openSuggestions > 0 ? (
            <span className="text-[11px] font-semibold">{openComments + openSuggestions}</span>
          ) : null}
        </Button>

        {isOwner ? (
          <Button size="sm" variant="primary" onClick={() => setShareOpen(true)} title="Share">
            <Share2 size={13} /> <span className="hidden sm:inline">Share</span>
          </Button>
        ) : null}
      </EditorHeader>

      {/* Banners */}
      {deleted ? (
        <div className="bg-red-600 px-4 py-2 text-center text-sm font-medium text-white">
          This document was deleted by its owner.{' '}
          <button type="button" className="underline" onClick={() => void navigate({ to: '/' })}>
            Back to documents
          </button>
        </div>
      ) : showOfflineBanner ? (
        <div className="bg-amber-500 px-4 py-1.5 text-center text-xs font-medium text-white">
          Connection lost — reconnecting… Your edits are kept locally and will sync when you are back online.
        </div>
      ) : null}
      {error ? (
        <div className="bg-red-600 px-4 py-1.5 text-center text-xs font-medium text-white">{error}</div>
      ) : null}

      {/* Main */}
      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1 bg-[var(--paper)]">
          {docQuery.isError ? (
            <div className="flex h-full flex-col items-center justify-center gap-3">
              <p className="m-0 text-sm text-[var(--ink-soft)]">
                This document does not exist or you do not have access to it.
              </p>
              <Link to="/" className="text-sm text-[var(--accent)]">
                Back to documents
              </Link>
            </div>
          ) : (
            <>
              <div
                ref={containerRef}
                className={`ink-editor doc-fade h-full ${fadePhase === 'loading' ? 'opacity-0' : 'opacity-100'}`}
              />
              {/* Skeleton overlay: solid paper from frame one (hides the
                  empty pre-sync editor), ghost document after 80ms, fades
                  out over the synced editor. */}
              {fadePhase !== 'done' ? (
                <div
                  className={`doc-fade absolute inset-0 z-10 ${
                    fadePhase === 'fading' ? 'doc-skeleton-frozen pointer-events-none opacity-0' : 'opacity-100'
                  }`}
                >
                  <DocumentSkeleton />
                </div>
              ) : null}
            </>
          )}
          {bubble ? (
            <button
              type="button"
              onPointerDown={(e) => {
                // pointerdown (not click): act before the editor blurs and
                // the selection-driven bubble unmounts under the pointer.
                e.preventDefault()
                startComment()
              }}
              className="absolute z-30 flex items-center gap-1.5 rounded-md border border-[var(--line)] bg-[var(--paper)] px-2.5 py-1.5 text-xs font-medium text-[var(--ink)] shadow-md hover:bg-[var(--paper-soft)]"
              style={{ left: bubble.left, top: bubble.top }}
            >
              <MessageSquarePlus size={13} /> Add comment
            </button>
          ) : null}
          {/* Mobile stand-in for the bubble: a fixed pill at the bottom of the
              viewport — discoverable, thumb-reachable, and clear of the native
              text-selection callout. pointerdown so it fires before the tap
              collapses the selection. */}
          {isMobile && !sidebarOpen && canComment && selection && selection.to - selection.from >= 8 ? (
            <button
              type="button"
              onPointerDown={(e) => {
                e.preventDefault()
                startComment()
              }}
              className="fixed bottom-[calc(1.25rem+env(safe-area-inset-bottom))] left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-full border border-[var(--line)] bg-[var(--paper)] px-5 py-3 text-sm font-medium text-[var(--ink)] shadow-lg"
            >
              <MessageSquarePlus size={16} /> Comment
            </button>
          ) : null}
        </div>

        {sidebarOpen ? (
          <>
            {/* Mobile scrim: the panel overlays as a bottom sheet; tapping
                outside dismisses it. Desktop (lg+) keeps the side-by-side
                column and never renders this. */}
            <div
              className="fixed inset-0 z-[65] bg-black/40 lg:hidden"
              onClick={() => setSidebarOpen(false)}
              aria-hidden
            />
            <aside
              aria-label="Comments and suggestions"
              className="fixed inset-x-0 bottom-0 z-[70] flex h-[70dvh] flex-col rounded-t-2xl border-t border-[var(--line)] bg-[var(--paper)] pb-[env(safe-area-inset-bottom)] shadow-2xl lg:static lg:z-auto lg:h-auto lg:w-[22rem] lg:shrink-0 lg:rounded-none lg:border-l lg:border-t-0 lg:pb-0 lg:shadow-none"
            >
              <div className="flex items-center justify-center pt-2 lg:hidden" aria-hidden>
                <span className="h-1 w-9 rounded-full bg-[var(--line)]" />
              </div>
              <div className="flex shrink-0 items-stretch border-b border-[var(--line)] text-sm font-medium">
                <button
                  type="button"
                  onClick={() => setSidebarTab('comments')}
                  className={`flex-1 px-3 py-2 max-lg:py-3 ${sidebarTab === 'comments' ? 'border-b-2 border-[var(--accent)] text-[var(--ink)]' : 'text-[var(--ink-faint)]'}`}
                >
                  Comments{openComments > 0 ? ` (${openComments})` : ''}
                </button>
                <button
                  type="button"
                  onClick={() => setSidebarTab('suggestions')}
                  className={`flex-1 px-3 py-2 max-lg:py-3 ${sidebarTab === 'suggestions' ? 'border-b-2 border-[var(--accent)] text-[var(--ink)]' : 'text-[var(--ink-faint)]'}`}
                >
                  Suggestions{openSuggestions > 0 ? ` (${openSuggestions})` : ''}
                </button>
                <button
                  type="button"
                  onClick={() => setSidebarTab('links')}
                  className={`flex-1 px-3 py-2 max-lg:py-3 ${sidebarTab === 'links' ? 'border-b-2 border-[var(--accent)] text-[var(--ink)]' : 'text-[var(--ink-faint)]'}`}
                >
                  Links
                </button>
                <button
                  type="button"
                  onClick={() => setSidebarOpen(false)}
                  aria-label="Close panel"
                  className="px-3 text-[var(--ink-soft)] lg:hidden"
                >
                  <X size={18} />
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
              {sidebarTab === 'links' ? (
                <BacklinksPanel docId={docId} share={share} />
              ) : sidebarTab === 'comments' ? (
                commentsQuery.isLoading ? (
                  // First load for this doc only — cached docs render rows
                  // instantly (staleTime: Infinity + live DocEvent patches).
                  <PanelSkeleton rows={3} />
                ) : (
                <CommentsSidebar
                  docId={docId}
                  share={share}
                  me={me}
                  canComment={canComment}
                  comments={comments}
                  members={members}
                  resolveRange={resolveRange}
                  activeCommentId={activeCommentId}
                  onSelect={(comment) => {
                    setActiveCommentId(comment.id)
                    if (comment.anchor) {
                      const range = resolveRange(comment.anchor)
                      if (range) revealRange(range, `[data-comment-id="${comment.id}"]`)
                    }
                  }}
                  pending={pendingComment}
                  resolvePending={resolvePending}
                  onPendingDone={() => setPendingComment(null)}
                  currentSelection={selection}
                  report={report}
                />
                )
              ) : suggestionsQuery.isLoading ? (
                <PanelSkeleton rows={3} />
              ) : (
                <SuggestionsPanel
                  docId={docId}
                  share={share}
                  me={me}
                  role={role}
                  mode={mode}
                  suggestions={suggestions}
                  members={members}
                  activeSuggestionId={activeSuggestionId}
                  onSelect={(suggestion) => {
                    setActiveSuggestionId(suggestion.id)
                    for (const part of suggestion.parts) {
                      const range = resolveRange(part.anchor)
                      if (range) {
                        revealRange(range, `[data-suggestion-id="${suggestion.id}"]`)
                        break
                      }
                    }
                  }}
                  onAfterReview={refreshAnnotations}
                  report={report}
                />
              )}
              </div>
            </aside>
          </>
        ) : null}
      </div>

      {/* Dialogs */}
      {isOwner ? (
        <ShareDialog open={shareOpen} onClose={() => setShareOpen(false)} docId={docId} members={members} report={report} />
      ) : null}

      <Dialog open={namingVersion} onClose={() => setNamingVersion(false)} title="Name this version">
        <Input
          value={versionName}
          onChange={setVersionName}
          autoFocus
          placeholder="e.g. Draft sent to review"
          onKeyDown={(e) => {
            if (e.key === 'Enter') void nameVersion()
          }}
        />
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={() => setNamingVersion(false)}>Cancel</Button>
          <Button variant="primary" onClick={() => void nameVersion()}>
            Save version
          </Button>
        </div>
      </Dialog>
    </div>
  )
}

function ConnectionPill({ status, established }: { status: ConnStatus; established: boolean }) {
  // Silence is the success signal: render nothing while healthy. The pill sits
  // just before an `ml-auto` spacer, so its absence doesn't shift the toolbar.
  // Initial connects are covered by the document skeleton (`established` is
  // false until the first sync) — the pill only reports RE-connects, so it no
  // longer flashes amber on every doc switch.
  if (status === 'connected' || !established) return null
  const styles: Record<Exclude<ConnStatus, 'connected'>, { dot: string; label: string }> = {
    connecting: { dot: 'bg-amber-500 animate-pulse', label: 'Connecting…' },
    disconnected: { dot: 'bg-amber-500 animate-pulse', label: 'Reconnecting…' },
  }
  const s = styles[status]
  return (
    <span className="fade-in flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--line)] px-2 py-0.5 text-[11px] text-[var(--ink-soft)]">
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  )
}

function PresenceStack({ peers }: { peers: Peer[] }) {
  if (peers.length === 0) return null
  const shown = peers.slice(0, 5)
  return (
    <div className="mr-1 flex items-center -space-x-1.5">
      {shown.map((peer) => (
        <span
          key={peer.clientId}
          title={peer.isAgent ? `${peer.name} (agent)` : peer.name}
          className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-[var(--paper)] text-[9px] font-bold text-white"
          style={{ backgroundColor: peer.color }}
        >
          {peer.isAgent ? '🤖' : peer.name.slice(0, 1).toUpperCase()}
        </span>
      ))}
      {peers.length > shown.length ? (
        <span className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-[var(--paper)] bg-[var(--ink-faint)] text-[9px] font-bold text-white">
          +{peers.length - shown.length}
        </span>
      ) : null}
    </div>
  )
}
