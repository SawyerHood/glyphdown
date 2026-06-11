import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from 'react'
import { Link, useRouterState } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ChevronDown,
  ChevronRight,
  Download,
  FileCode2,
  FilePlus,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Image as ImageIcon,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react'
import { assetKindForContentType, MAX_FOLDER_DEPTH, roleAtLeast, type AssetMeta, type DocMeta } from '@glyphdown/protocol'
import {
  ApiError,
  deleteFolderAsset,
  folderAssetUrl,
  listDocs,
  listFolderAssets,
  listFolders,
  type FolderInfo,
} from '../lib/api.ts'
import { buildFileTree, folderWithDescendants, formatBytes, sortAssets, type TreeFolderNode } from '../lib/fileTree.ts'
import { liveSlug, slugifyDocStem } from '../lib/slug.ts'
import { loadCollapsedFolders, saveCollapsedFolders } from '../lib/fileTreePanel.ts'
import { useActiveVault } from '../lib/useActiveVault.ts'
import { useDismissable } from '../lib/useDismissable.ts'
import { useFileMutations, useTransientToast } from '../lib/useFileMutations.ts'
import { ConfirmDialog, Dialog } from './ui.tsx'
import VaultSwitcher from './VaultSwitcher.tsx'

/**
 * Obsidian-style file tree: one tree where every doc always exists — folders
 * (alphabetical, expandable, nested via parentId) first, then root-level
 * docs. Lives inside the slide-out panel (FileTreeShell); shares the ['docs']
 * / ['folders'] query keys with the dashboard so both views stay in sync.
 *
 * Drag-and-drop (owners only): docs move between folders (PATCH doc
 * folderId); folders move under other folders (PATCH folder parentId). The
 * ROOT level holds only vaults now, so nothing drops there and vaults
 * themselves never drag (they are immovable roots); the header "new" buttons
 * create in the ACTIVE vault. Dropping a folder into itself or its own
 * subtree is rejected client-side (instant no-drop cursor) — the server
 * enforces the same rule plus the depth cap and reports 'cycle'/'too-deep',
 * surfaced as a toast. Hovering a collapsed folder mid-drag auto-expands it
 * after a short delay.
 */

export const DOC_DRAG_MIME = 'application/x-glyphdown-doc'
export const FOLDER_DRAG_MIME = 'application/x-glyphdown-folder'
/** Horizontal indent per nesting level. */
const INDENT_PX = 14
/** Hovering a collapsed folder this long mid-drag expands it. */
const AUTO_EXPAND_DELAY_MS = 600
/** Width reserved for the expand chevron, so doc icons align with folder icons. */
const CHEVRON_PX = 13

const rowIndent = (depth: number): CSSProperties => ({ paddingLeft: 6 + depth * INDENT_PX })

type Creating = { kind: 'doc'; folderId: string | null } | { kind: 'folder'; parentId: string | null }
type Renaming = { kind: 'doc'; doc: DocMeta } | { kind: 'folder'; folder: FolderInfo }
type Deleting = { kind: 'doc'; id: string; name: string } | { kind: 'folder'; id: string; name: string }
/** Asset open in the lightbox viewer (folder carries the caller's role for the delete gate). */
export type ViewingAsset = { folder: FolderInfo; asset: AssetMeta }
/** Set at folder-drag start: the dragged id plus its descendants (invalid drop targets). */
type FolderDrag = { id: string; invalid: ReadonlySet<string> }

/** Everything the recursive rows need; threaded down instead of N props per level. */
interface TreeCtx {
  currentDocId: string | null
  collapsed: Record<string, boolean>
  creating: Creating | null
  renaming: Renaming | null
  dragOverId: string | 'root' | null
  draggingFolder: FolderDrag | null
  toggleFolder: (id: string) => void
  expandFolder: (id: string) => void
  setCreating: (c: Creating | null) => void
  setRenaming: (r: Renaming | null) => void
  requestDelete: (d: Deleting) => void
  openAsset: (folder: FolderInfo, asset: AssetMeta) => void
  createDocIn: (name: string, folderId: string | null) => void
  createFolderIn: (name: string, parentId: string | null) => void
  renameDocTo: (doc: DocMeta, name: string) => void
  renameFolderTo: (folder: FolderInfo, name: string) => void
  setDragOver: (id: string | 'root' | null) => void
  moveDoc: (docId: string, folderId: string | null) => void
  moveFolderTo: (folderId: string, parentId: string | null) => void
  startFolderDrag: (e: DragEvent, folder: FolderInfo) => void
  endFolderDrag: () => void
  hasDocDrag: (e: DragEvent) => boolean
  hasFolderDrag: (e: DragEvent) => boolean
}

export default function FileTree({ onClose }: { onClose: () => void }) {
  const docsQuery = useQuery({ queryKey: ['docs'], queryFn: listDocs })
  const foldersQuery = useQuery({ queryKey: ['folders'], queryFn: listFolders })

  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const docMatch = /^\/d\/([^/]+)/.exec(pathname)
  const currentDocId = docMatch?.[1] ? decodeURIComponent(docMatch[1]) : null

  // Expanded state, persisted per folder (stored as the collapsed set so new
  // folders default to expanded). Hydrated after mount — SSR has no storage.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  useEffect(() => {
    setCollapsed(loadCollapsedFolders())
  }, [])
  const toggleFolder = (id: string) => {
    setCollapsed((prev) => {
      const next = { ...prev }
      if (next[id]) delete next[id]
      else next[id] = true
      saveCollapsedFolders(next)
      return next
    })
  }
  const expandFolder = (id: string) => {
    setCollapsed((prev) => {
      if (!prev[id]) return prev
      const next = { ...prev }
      delete next[id]
      saveCollapsedFolders(next)
      return next
    })
  }

  const [creating, setCreating] = useState<Creating | null>(null)
  const [renaming, setRenaming] = useState<Renaming | null>(null)
  const [deleting, setDeleting] = useState<Deleting | null>(null)
  const [viewingAsset, setViewingAsset] = useState<ViewingAsset | null>(null)
  const [dragOver, setDragOver] = useState<string | 'root' | null>(null)
  const [draggingFolder, setDraggingFolder] = useState<FolderDrag | null>(null)

  // Transient error toast (move/create rejections like 'cycle' / 'too-deep')
  // + the shared doc/folder mutations (also used by the home file browser).
  const { toast, showToast } = useTransientToast()
  const mutations = useFileMutations(showToast)

  const docs = docsQuery.data ?? []
  const folders = foldersQuery.data ?? []
  const tree = buildFileTree(docs, folders)
  const folderNodes = tree.filter((n): n is TreeFolderNode => n.kind === 'folder')
  const rootDocs = tree.flatMap((n) => (n.kind === 'doc' ? [n.doc] : []))

  // The header "new" buttons create in the ACTIVE vault (the root level holds
  // only vaults — nothing can be created there). Null only when the account
  // has no vault yet: doc creation still works (the server homes it into a
  // freshly minted default vault), folder creation needs a vault first.
  const activeVaultId = useActiveVault()?.id ?? null

  const hasDocDrag = (e: DragEvent) => e.dataTransfer.types.includes(DOC_DRAG_MIME)
  const hasFolderDrag = (e: DragEvent) => e.dataTransfer.types.includes(FOLDER_DRAG_MIME)

  const ctx: TreeCtx = {
    currentDocId,
    collapsed,
    creating,
    renaming,
    dragOverId: dragOver,
    draggingFolder,
    toggleFolder,
    expandFolder,
    setCreating,
    setRenaming,
    requestDelete: setDeleting,
    openAsset: (folder, asset) => setViewingAsset({ folder, asset }),
    createDocIn: (name, folderId) => {
      mutations.createDocIn(name, folderId)
      setCreating(null)
    },
    createFolderIn: (name, parentId) => {
      mutations.createFolderIn(name, parentId)
      setCreating(null)
    },
    renameDocTo: (doc, name) => {
      mutations.renameDocTo(doc.id, name)
      setRenaming(null)
    },
    renameFolderTo: (folder, name) => {
      mutations.renameFolderTo(folder.id, name)
      setRenaming(null)
    },
    setDragOver,
    moveDoc: mutations.moveDocTo,
    moveFolderTo: mutations.moveFolderTo,
    startFolderDrag: (e, folder) => {
      e.dataTransfer.setData(FOLDER_DRAG_MIME, folder.id)
      e.dataTransfer.effectAllowed = 'move'
      setDraggingFolder({ id: folder.id, invalid: folderWithDescendants(folders, folder.id) })
    },
    endFolderDrag: () => {
      setDraggingFolder(null)
      setDragOver(null)
    },
    hasDocDrag,
    hasFolderDrag,
  }

  const signedOut =
    (docsQuery.error instanceof ApiError && docsQuery.error.status === 401) ||
    (foldersQuery.error instanceof ApiError && foldersQuery.error.status === 401)

  return (
    <div className="relative flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center gap-0.5 border-b border-[var(--line)] px-3">
        <span className="island-kicker">Files</span>
        <div className="ml-auto flex items-center gap-0.5">
          <TreeIconButton
            label="New document"
            onClick={() => {
              if (activeVaultId !== null) expandFolder(activeVaultId)
              setCreating({ kind: 'doc', folderId: activeVaultId })
            }}
          >
            <FilePlus2 size={14} />
          </TreeIconButton>
          {activeVaultId !== null ? (
            <TreeIconButton
              label="New folder"
              onClick={() => {
                expandFolder(activeVaultId)
                setCreating({ kind: 'folder', parentId: activeVaultId })
              }}
            >
              <FolderPlus size={14} />
            </TreeIconButton>
          ) : null}
          <TreeIconButton label="Close panel (⌘\)" onClick={onClose}>
            <PanelLeft size={14} />
          </TreeIconButton>
        </div>
      </div>

      {/* No root drop zone anymore: the root level holds only vaults, so
          "move to root" is not a thing — drops land on folder/vault rows. */}
      <div className="min-h-0 flex-1 overflow-y-auto py-1.5">
        {docsQuery.isLoading || foldersQuery.isLoading ? (
          <TreeSkeleton />
        ) : signedOut ? (
          <p className="m-0 px-3 py-2 text-xs text-[var(--ink-faint)]">Sign in to browse your documents.</p>
        ) : docsQuery.isError || foldersQuery.isError ? (
          <p className="m-0 px-3 py-2 text-xs text-[var(--ink-faint)]">Could not load your documents.</p>
        ) : (
          <>
            {creating?.kind === 'folder' && creating.parentId === null ? (
              <TreeRow depth={0}>
                <ChevronSpacer />
                <Folder size={14} className="shrink-0 text-[var(--ink-faint)]" />
                <InlineNameInput
                  placeholder="Folder name"
                  onCommit={(name) => ctx.createFolderIn(name, null)}
                  onCancel={() => setCreating(null)}
                />
              </TreeRow>
            ) : null}

            {folderNodes.map((node) => (
              <FolderItem key={node.folder.id} node={node} depth={0} ctx={ctx} />
            ))}

            {creating?.kind === 'doc' && creating.folderId === null ? (
              <TreeRow depth={0}>
                <ChevronSpacer />
                <FileText size={14} className="shrink-0 text-[var(--ink-faint)]" />
                <InlineNameInput
                  placeholder="file-name"
                  slug
                  onCommit={(title) => ctx.createDocIn(title, null)}
                  onCancel={() => setCreating(null)}
                />
              </TreeRow>
            ) : null}

            {rootDocs.map((doc) =>
              renaming?.kind === 'doc' && renaming.doc.id === doc.id ? (
                <TreeRow key={doc.id} depth={0}>
                  <ChevronSpacer />
                  <FileText size={14} className="shrink-0 text-[var(--ink-faint)]" />
                  <InlineNameInput
                    initial={doc.title}
                    placeholder="file-name"
                    slug
                    onCommit={(title) => ctx.renameDocTo(doc, title)}
                    onCancel={() => setRenaming(null)}
                  />
                </TreeRow>
              ) : (
                <DocRow key={doc.id} doc={doc} depth={0} ctx={ctx} />
              ),
            )}

            {docs.length === 0 && folders.length === 0 && creating === null ? (
              <div className="px-3 py-4 text-center">
                <p className="m-0 mb-2 text-xs text-[var(--ink-faint)]">No documents yet.</p>
                <button
                  type="button"
                  onClick={() => setCreating({ kind: 'doc', folderId: null })}
                  className="inline-flex items-center gap-1 rounded-md border border-[var(--line)] bg-[var(--paper)] px-2 py-1 text-xs font-medium text-[var(--ink)] hover:bg-[var(--paper-soft)]"
                >
                  <Plus size={12} /> New document
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>

      {/* Pinned footer: the vault switcher (dropdown opens upward). The tree
          above lists EVERY vault as a root; this controls the ACTIVE vault
          (Cmd+K scoping, the `/` redirect, where new docs land) without
          navigating away from the open doc. */}
      <VaultSwitcher variant="sidebar" />

      {toast ? (
        <div
          role="status"
          className="pointer-events-none absolute bottom-14 left-1/2 z-10 max-w-[90%] -translate-x-1/2 rounded-md bg-[var(--ink)] px-2.5 py-1.5 text-center text-xs text-[var(--paper)] shadow-lg"
        >
          {toast}
        </div>
      ) : null}

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (!deleting) return
          if (deleting.kind === 'doc') mutations.deleteDoc(deleting.id)
          else mutations.deleteFolder(deleting.id)
        }}
        title={deleting?.kind === 'folder' ? 'Delete folder' : 'Delete document'}
        body={
          deleting?.kind === 'folder'
            ? `Delete the folder “${deleting.name}”? Everything inside it is kept — its subfolders and documents move up one level.`
            : `Delete “${deleting?.name ?? ''}”? It will no longer be accessible.`
        }
        confirmLabel="Delete"
        danger
      />

      {viewingAsset ? <AssetLightbox viewing={viewingAsset} onClose={() => setViewingAsset(null)} /> : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** One folder and (when expanded) its subtree — recursive. */
function FolderItem({ node, depth, ctx }: { node: TreeFolderNode; depth: number; ctx: TreeCtx }) {
  const { folder } = node
  const isOwner = folder.role === 'owner'
  // Vaults are immovable roots: they never drag, and they leave the tree only
  // through the dedicated vault-delete flow (vault switcher), not the ⋯ menu.
  const isVault = folder.kind === 'vault'
  const expanded = !ctx.collapsed[folder.id]
  const renamingThis = ctx.renaming?.kind === 'folder' && ctx.renaming.folder.id === folder.id
  const dragOver = ctx.dragOverId === folder.id
  const creatingDocHere = ctx.creating?.kind === 'doc' && ctx.creating.folderId === folder.id
  const creatingFolderHere = ctx.creating?.kind === 'folder' && ctx.creating.parentId === folder.id

  // Folder image assets, listed after the docs. Lazy: fetched only once the
  // folder is expanded; ~30s staleness is fine (editor uploads invalidate
  // ['folder-assets', id] directly). Zero assets render nothing at all.
  const assetsQuery = useQuery({
    queryKey: ['folder-assets', folder.id],
    queryFn: () => listFolderAssets(folder.id),
    enabled: expanded,
    staleTime: 30_000,
  })
  const folderAssets = sortAssets(assetsQuery.data ?? []).filter((asset) => assetKindForContentType(asset.contentType) !== null)

  // Auto-expand while a drag hovers this (collapsed) folder.
  const expandTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearExpandTimer = () => {
    if (expandTimer.current) {
      clearTimeout(expandTimer.current)
      expandTimer.current = null
    }
  }
  useEffect(() => clearExpandTimer, [])

  return (
    <div>
      {renamingThis ? (
        <TreeRow depth={depth}>
          <ChevronSpacer />
          <Folder size={14} className="shrink-0 text-[var(--ink-faint)]" />
          <InlineNameInput
            initial={folder.name}
            placeholder="Folder name"
            onCommit={(name) => ctx.renameFolderTo(folder, name)}
            onCancel={() => ctx.setRenaming(null)}
          />
        </TreeRow>
      ) : (
        <div
          className={`group flex items-center gap-1 rounded-md py-1 pr-1.5 ${
            dragOver ? 'bg-[var(--accent-soft)] outline outline-1 outline-[var(--accent)]' : 'hover:bg-[var(--paper-soft)]'
          }`}
          style={rowIndent(depth)}
          draggable={isOwner && !isVault}
          onDragStart={(e) => {
            if (!isOwner || isVault) return
            e.stopPropagation()
            ctx.startFolderDrag(e, folder)
          }}
          onDragEnd={() => {
            clearExpandTimer()
            ctx.endFolderDrag()
          }}
          onDragOver={(e) => {
            if (ctx.hasFolderDrag(e) && ctx.draggingFolder?.invalid.has(folder.id)) {
              // Dropping a folder into itself or its own subtree: swallow the
              // event (no preventDefault) so the root container does not claim
              // it — the browser shows the no-drop cursor.
              e.stopPropagation()
              return
            }
            const folderDrop = ctx.hasFolderDrag(e) && ctx.draggingFolder !== null
            if ((!ctx.hasDocDrag(e) && !folderDrop) || !isOwner) return
            e.preventDefault()
            e.stopPropagation()
            e.dataTransfer.dropEffect = 'move'
            ctx.setDragOver(folder.id)
            if (!expanded && expandTimer.current === null) {
              expandTimer.current = setTimeout(() => {
                expandTimer.current = null
                ctx.expandFolder(folder.id)
              }, AUTO_EXPAND_DELAY_MS)
            }
          }}
          onDragLeave={(e) => {
            // dragleave also fires when moving between this row's children.
            if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
            clearExpandTimer()
            if (ctx.dragOverId === folder.id) ctx.setDragOver(null)
          }}
          onDrop={(e) => {
            clearExpandTimer()
            ctx.setDragOver(null)
            if (!isOwner) return
            const droppedFolderId = e.dataTransfer.getData(FOLDER_DRAG_MIME)
            if (droppedFolderId) {
              e.preventDefault()
              e.stopPropagation()
              ctx.moveFolderTo(droppedFolderId, folder.id)
              return
            }
            const docId = e.dataTransfer.getData(DOC_DRAG_MIME)
            if (!docId) return
            e.preventDefault()
            e.stopPropagation()
            ctx.moveDoc(docId, folder.id)
          }}
        >
          <button
            type="button"
            onClick={() => ctx.toggleFolder(folder.id)}
            title={folder.name}
            aria-expanded={expanded}
            className="flex min-w-0 flex-1 items-center gap-1 rounded text-left text-[13px] font-medium text-[var(--ink)]"
          >
            {expanded ? (
              <ChevronDown size={CHEVRON_PX} className="shrink-0 text-[var(--ink-faint)]" />
            ) : (
              <ChevronRight size={CHEVRON_PX} className="shrink-0 text-[var(--ink-faint)]" />
            )}
            {expanded ? (
              <FolderOpen size={14} className="shrink-0 text-[var(--ink-soft)]" />
            ) : (
              <Folder size={14} className="shrink-0 text-[var(--ink-soft)]" />
            )}
            <span className="truncate">{folder.name}</span>
          </button>
          {isOwner ? (
            // Revealed on hover and on keyboard focus (group-focus-within); the
            // buttons stay in the layout (opacity, not display) so the row width
            // never jumps, and they remain tabbable while invisible — focusing
            // one reveals it. Touch devices have no hover, so coarse pointers
            // see the actions permanently (pointer-coarse).
            <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100">
              <TreeIconButton
                label="New doc"
                onClick={() => {
                  ctx.expandFolder(folder.id)
                  ctx.setCreating({ kind: 'doc', folderId: folder.id })
                }}
              >
                <FilePlus size={13} />
              </TreeIconButton>
              {/* depth is the folder's real depth - 1 for owners (they see
                  their whole ancestor chain), so a child would sit at depth+2. */}
              {depth + 2 <= MAX_FOLDER_DEPTH ? (
                <TreeIconButton
                  label="New subfolder"
                  onClick={() => {
                    ctx.expandFolder(folder.id)
                    ctx.setCreating({ kind: 'folder', parentId: folder.id })
                  }}
                >
                  <FolderPlus size={13} />
                </TreeIconButton>
              ) : null}
              <RowMenu
                items={[
                  {
                    label: 'Rename',
                    icon: <Pencil size={13} />,
                    onSelect: () => ctx.setRenaming({ kind: 'folder', folder }),
                  },
                  ...(isVault
                    ? [] // vault delete = the typed-confirmation flow in the vault switcher
                    : [
                        {
                          label: 'Delete',
                          icon: <Trash2 size={13} />,
                          onSelect: () => ctx.requestDelete({ kind: 'folder', id: folder.id, name: folder.name }),
                          danger: true,
                        },
                      ]),
                ]}
              />
            </span>
          ) : null}
        </div>
      )}

      {expanded ? (
        <div>
          {creatingFolderHere ? (
            <TreeRow depth={depth + 1}>
              <ChevronSpacer />
              <Folder size={14} className="shrink-0 text-[var(--ink-faint)]" />
              <InlineNameInput
                placeholder="Folder name"
                onCommit={(name) => ctx.createFolderIn(name, folder.id)}
                onCancel={() => ctx.setCreating(null)}
              />
            </TreeRow>
          ) : null}

          {node.children.map((child) => (
            <FolderItem key={child.folder.id} node={child} depth={depth + 1} ctx={ctx} />
          ))}

          {creatingDocHere ? (
            <TreeRow depth={depth + 1}>
              <ChevronSpacer />
              <FileText size={14} className="shrink-0 text-[var(--ink-faint)]" />
              <InlineNameInput
                placeholder="file-name"
                slug
                onCommit={(title) => ctx.createDocIn(title, folder.id)}
                onCancel={() => ctx.setCreating(null)}
              />
            </TreeRow>
          ) : null}

          {node.docs.map((doc) =>
            ctx.renaming?.kind === 'doc' && ctx.renaming.doc.id === doc.id ? (
              <TreeRow key={doc.id} depth={depth + 1}>
                <ChevronSpacer />
                <FileText size={14} className="shrink-0 text-[var(--ink-faint)]" />
                <InlineNameInput
                  initial={doc.title}
                  placeholder="file-name"
                  slug
                  onCommit={(title) => ctx.renameDocTo(doc, title)}
                  onCancel={() => ctx.setRenaming(null)}
                />
              </TreeRow>
            ) : (
              <DocRow key={doc.id} doc={doc} depth={depth + 1} ctx={ctx} />
            ),
          )}

          {folderAssets.map((asset) => (
            <AssetRow key={asset.id} folder={folder} asset={asset} depth={depth + 1} ctx={ctx} />
          ))}

          {node.children.length === 0 && node.docs.length === 0 && folderAssets.length === 0 && !creatingDocHere && !creatingFolderHere ? (
            <p
              className="m-0 py-0.5 pr-2 text-[11px] italic text-[var(--ink-faint)]"
              style={{ paddingLeft: 6 + (depth + 1) * INDENT_PX + CHEVRON_PX + 4 }}
            >
              Empty
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function DocRow({ doc, depth, ctx }: { doc: DocMeta; depth: number; ctx: TreeCtx }) {
  const isOwner = doc.role === 'owner'
  const active = doc.id === ctx.currentDocId
  return (
    <div
      className={`group flex items-center gap-1 rounded-md py-1 pr-1.5 ${
        active ? 'bg-[var(--accent-soft)]' : 'hover:bg-[var(--paper-soft)]'
      }`}
      style={rowIndent(depth)}
      draggable={isOwner}
      onDragStart={(e) => {
        if (!isOwner) return
        e.stopPropagation()
        e.dataTransfer.setData(DOC_DRAG_MIME, doc.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
    >
      <ChevronSpacer />
      <Link
        to="/d/$docId"
        params={{ docId: doc.id }}
        title={doc.title}
        className={`flex min-w-0 flex-1 items-center gap-1.5 text-[13px] no-underline ${
          active ? 'font-semibold text-[var(--accent)]' : 'text-[var(--ink)] hover:text-[var(--accent)]'
        }`}
      >
        <FileText size={14} className={`shrink-0 ${active ? 'text-[var(--accent)]' : 'text-[var(--ink-faint)]'}`} />
        <span className="truncate">{doc.title}</span>
      </Link>
      {isOwner ? (
        <span className="flex shrink-0 items-center opacity-0 transition group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100">
          <RowMenu
            items={[
              { label: 'Rename', icon: <Pencil size={13} />, onSelect: () => ctx.setRenaming({ kind: 'doc', doc }) },
              {
                label: 'Delete',
                icon: <Trash2 size={13} />,
                onSelect: () => ctx.requestDelete({ kind: 'doc', id: doc.id, name: doc.title }),
                danger: true,
              },
            ]}
          />
        </span>
      ) : null}
    </div>
  )
}

/** A folder asset as a leaf row — images open the lightbox; HTML opens the sandboxed viewer. */
function AssetRow({
  folder,
  asset,
  depth,
  ctx,
}: {
  folder: FolderInfo
  asset: AssetMeta
  depth: number
  ctx: TreeCtx
}) {
  const kind = assetKindForContentType(asset.contentType)
  if (kind === 'html') {
    return (
      <div className="flex items-center gap-1 rounded-md pr-1.5 hover:bg-[var(--paper-soft)]" style={rowIndent(depth)}>
        <ChevronSpacer />
        <Link
          to="/f/$folderId/file/$filename"
          params={{ folderId: folder.id, filename: asset.filename }}
          title={asset.filename}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded py-1 text-xs font-medium text-[var(--ink-soft)] no-underline hover:text-[var(--accent)]"
        >
          <FileCode2 size={13} className="shrink-0 text-[var(--ink-faint)]" />
          <span className="truncate">{asset.filename}</span>
        </Link>
      </div>
    )
  }

  if (kind !== 'image') return null
  return (
    <div className="flex items-center gap-1 rounded-md pr-1.5 hover:bg-[var(--paper-soft)]" style={rowIndent(depth)}>
      <ChevronSpacer />
      <button
        type="button"
        onClick={() => ctx.openAsset(folder, asset)}
        title={asset.filename}
        className="flex min-w-0 flex-1 items-center gap-1.5 rounded py-1 text-left text-xs text-[var(--ink-soft)] hover:text-[var(--ink)]"
      >
        <ImageIcon size={13} className="shrink-0 text-[var(--ink-faint)]" />
        <span className="truncate">{asset.filename}</span>
      </button>
    </div>
  )
}

/** Checkerboard backdrop so transparent regions of the image read as such. */
const CHECKERBOARD: CSSProperties = {
  backgroundImage:
    'linear-gradient(45deg, var(--paper-soft) 25%, transparent 25%), linear-gradient(-45deg, var(--paper-soft) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, var(--paper-soft) 75%), linear-gradient(-45deg, transparent 75%, var(--paper-soft) 75%)',
  backgroundSize: '16px 16px',
  backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0',
}

/**
 * Lightbox viewer for a folder asset: the image centered on a checkerboard,
 * a filename/size/type caption, a Download anchor, and — for folder editors+
 * — a delete affordance (confirm-gated; deletion is the folder-scoped DELETE
 * mirroring the doc-scoped one). Esc/backdrop/X dismissal comes from Dialog;
 * while the delete confirm is open, those dismiss only the confirm.
 */
export function AssetLightbox({ viewing, onClose }: { viewing: ViewingAsset; onClose: () => void }) {
  const { folder, asset } = viewing
  const queryClient = useQueryClient()
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  // Same-origin cookies authenticate the <img>/<a> requests in the browser.
  const url = folderAssetUrl(folder.id, asset.filename)

  const deleteMut = useMutation({
    mutationFn: () => deleteFolderAsset(folder.id, asset.filename),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['folder-assets', folder.id] })
      onClose()
    },
  })

  return (
    <>
      <Dialog
        open
        onClose={() => {
          // The confirm layers above this dialog; Esc/backdrop there must not
          // also dismiss the lightbox underneath.
          if (!confirmingDelete) onClose()
        }}
        title={asset.filename}
        center
        panelClassName="max-w-[88vw]"
      >
        <div className="flex items-center justify-center overflow-hidden rounded-md border border-[var(--line)]" style={CHECKERBOARD}>
          <img
            src={url}
            alt={asset.filename}
            className="block object-contain"
            style={{ maxWidth: '80vw', maxHeight: 'min(80vh, calc(100vh - 220px))' }}
          />
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <p className="m-0 min-w-0 truncate text-xs text-[var(--ink-soft)]">
            {asset.filename} · {formatBytes(asset.size)} · {asset.contentType}
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            {roleAtLeast(folder.role, 'editor') ? (
              <button
                type="button"
                onClick={() => setConfirmingDelete(true)}
                disabled={deleteMut.isPending}
                title="Delete image"
                aria-label="Delete image"
                className="rounded-md border border-transparent p-1.5 text-[var(--ink-soft)] transition hover:bg-red-50 hover:text-red-600 disabled:opacity-50 dark:hover:bg-red-950 dark:hover:text-red-400"
              >
                <Trash2 size={14} />
              </button>
            ) : null}
            <a
              href={url}
              download={asset.filename}
              className="inline-flex items-center gap-1.5 rounded-md border border-[var(--line)] bg-[var(--paper)] px-2 py-1 text-xs font-medium text-[var(--ink)] no-underline transition hover:bg-[var(--paper-soft)]"
            >
              <Download size={13} />
              Download
            </a>
          </div>
        </div>
      </Dialog>
      <ConfirmDialog
        open={confirmingDelete}
        onClose={() => setConfirmingDelete(false)}
        onConfirm={() => deleteMut.mutate()}
        title="Delete image"
        body={`Delete “${asset.filename}”? Documents that embed it will show a broken image.`}
        confirmLabel="Delete"
        danger
      />
    </>
  )
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

/** Keeps doc/file icons aligned with folder icons (which sit after a chevron). */
function ChevronSpacer() {
  return <span aria-hidden className="shrink-0" style={{ width: CHEVRON_PX }} />
}

function TreeRow({ depth, children }: { depth: number; children: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 py-1 pr-1.5" style={rowIndent(depth)}>
      {children}
    </div>
  )
}

function TreeIconButton({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="rounded p-1 text-[var(--ink-soft)] transition hover:bg-[var(--paper-soft)] hover:text-[var(--ink)]"
    >
      {children}
    </button>
  )
}

export function InlineNameInput({
  initial = '',
  placeholder,
  slug = false,
  onCommit,
  onCancel,
}: {
  initial?: string
  placeholder: string
  /** Doc names are slug filename stems: live-normalize as the user types. */
  slug?: boolean
  onCommit: (name: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(initial)
  const doneRef = useRef(false)
  const commit = () => {
    if (doneRef.current) return
    doneRef.current = true
    const trimmed = slug ? slugifyDocStem(value) : value.trim()
    const wasEmpty = slug ? value.trim() === '' : false
    if (trimmed !== '' && !wasEmpty && trimmed !== initial) onCommit(trimmed)
    else onCancel()
  }
  const cancel = () => {
    if (doneRef.current) return
    doneRef.current = true
    onCancel()
  }
  return (
    <input
      autoFocus
      value={value}
      placeholder={placeholder}
      onChange={(e) => setValue(slug ? liveSlug(e.target.value) : e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') cancel()
      }}
      className="min-w-0 flex-1 rounded border border-[var(--accent)] bg-[var(--paper)] px-1 py-0.5 text-[13px] text-[var(--ink)] outline-none placeholder:text-[var(--ink-faint)]"
    />
  )
}

export function RowMenu({
  items,
}: {
  items: ReadonlyArray<{ label: string; icon: ReactNode; onSelect: () => void; danger?: boolean }>
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  useDismissable(open, ref, () => setOpen(false))

  return (
    <span ref={ref} className="relative">
      <button
        type="button"
        title="More actions"
        aria-label="More actions"
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setOpen((v) => !v)
        }}
        className={`rounded p-1 text-[var(--ink-soft)] transition hover:bg-[var(--paper-soft)] hover:text-[var(--ink)] ${
          open ? 'bg-[var(--paper-soft)] text-[var(--ink)]' : ''
        }`}
      >
        <MoreHorizontal size={13} />
      </button>
      {open ? (
        <div className="absolute right-0 top-full z-50 mt-0.5 w-36 rounded-lg border border-[var(--line)] bg-[var(--paper)] p-1 shadow-lg">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setOpen(false)
                item.onSelect()
              }}
              className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs ${
                item.danger
                  ? 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950'
                  : 'text-[var(--ink)] hover:bg-[var(--paper-soft)]'
              }`}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </span>
  )
}

function TreeSkeleton() {
  return (
    <div className="animate-pulse space-y-2 px-3 py-2" aria-hidden>
      {[8, 6, 7, 5, 8, 6].map((w, i) => (
        <div key={i} className={`h-3.5 rounded bg-[var(--paper-soft)] ${i % 3 === 0 ? '' : 'ml-5'}`} style={{ width: `${w}rem` }} />
      ))}
    </div>
  )
}
