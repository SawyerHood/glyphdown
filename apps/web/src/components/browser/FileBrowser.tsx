import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Clock3, FileCode2, FilePlus2, FileText, Folder, FolderPlus, Image as ImageIcon, Pencil, Trash2, Upload } from 'lucide-react'
import {
  assetKindForContentType,
  IMAGE_FILE_EXTENSIONS,
  MAX_ASSET_BYTES,
  MAX_FOLDER_DEPTH,
  roleAtLeast,
  type AssetMeta,
  type DocMeta,
} from '@glyphdown/protocol'
import {
  ApiError,
  createDoc,
  listDocs,
  listFolderAssets,
  listFolders,
  pushDocContent,
  uploadFolderAsset,
  type FolderInfo,
} from '../../lib/api.ts'
import { breadcrumbChain, folderListing, recentDocs } from '../../lib/browse.ts'
import { docVaultId } from '../../lib/vaults.ts'
import { folderWithDescendants, sortAssets } from '../../lib/fileTree.ts'
import { timeAgo } from '../../lib/presence.ts'
import { getRecentDocIds } from '../../lib/recents.ts'
import { useFileMutations, useTransientToast } from '../../lib/useFileMutations.ts'
import {
  AssetLightbox,
  DOC_DRAG_MIME,
  FOLDER_DRAG_MIME,
  InlineNameInput,
  RowMenu,
  type ViewingAsset,
} from '../FileTree.tsx'
import { Badge, Button, ConfirmDialog, EmptyState } from '../ui.tsx'
import Breadcrumbs from './Breadcrumbs.tsx'

/**
 * Drive-style file browser — the signed-in home page, ROOTED AT A VAULT
 * (routes/index.tsx resolves the active vault and redirects bare `/` to
 * `/?folder=<vaultId>`; the vault is the breadcrumb root). Shows ONE folder's
 * contents at a time: subfolders first, then docs, then the folder's image
 * assets, each group alphabetical. Single click opens (folder → ?folder=id,
 * doc → /d/$docId, asset → lightbox); the ⋯ menu carries rename/delete for
 * owners. folderId === null only for accounts with no vault yet (the legacy
 * root view with its first-doc empty state).
 *
 * "New doc" / "New folder" create in the CURRENT folder via an inline name
 * row (doc names live-slugify as you type) — nested folders are made by
 * navigating in
 * and creating, like any file manager. Drag rows onto folder rows or
 * breadcrumb segments to move them (shared guarded mutations with the file
 * tree: cycle/desc drops are rejected client-side, server errors toast).
 *
 * Shares the ['docs'] / ['folders'] / ['folder-assets', id] query keys with
 * the sidebar file tree so both views stay in sync.
 */

type Creating = 'doc' | 'folder'
type Renaming = { kind: 'doc'; doc: DocMeta } | { kind: 'folder'; folder: FolderInfo }
type Deleting = { kind: 'doc' | 'folder'; id: string; name: string }
/** Set at folder-drag start: the dragged id plus its descendants (invalid drop targets). */
type FolderDrag = { id: string; invalid: ReadonlySet<string> }

/** Everything the row components need; threaded down instead of N props per row. */
interface BrowseCtx {
  renaming: Renaming | null
  dragOverId: string | 'root' | null
  draggingFolder: FolderDrag | null
  setRenaming: (r: Renaming | null) => void
  requestDelete: (d: Deleting) => void
  openAsset: (asset: AssetMeta) => void
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

export default function FileBrowser({ folderId }: { folderId: string | null }) {
  const queryClient = useQueryClient()
  const docsQuery = useQuery({ queryKey: ['docs'], queryFn: listDocs })
  const foldersQuery = useQuery({ queryKey: ['folders'], queryFn: listFolders })

  const { toast, showToast } = useTransientToast()
  const mutations = useFileMutations(showToast)
  const htmlUploadInputRef = useRef<HTMLInputElement>(null)
  const fileDragDepthRef = useRef(0)

  const [creating, setCreating] = useState<Creating | null>(null)
  const [renaming, setRenaming] = useState<Renaming | null>(null)
  const [deleting, setDeleting] = useState<Deleting | null>(null)
  const [viewingAsset, setViewingAsset] = useState<ViewingAsset | null>(null)
  const [dragOver, setDragOver] = useState<string | 'root' | null>(null)
  const [draggingFolder, setDraggingFolder] = useState<FolderDrag | null>(null)
  const [fileDragOver, setFileDragOver] = useState(false)
  const [fileDropBusy, setFileDropBusy] = useState(false)

  // Navigating to another folder closes any in-progress inline edit.
  useEffect(() => {
    setCreating(null)
    setRenaming(null)
  }, [folderId])

  const loading = docsQuery.isLoading || foldersQuery.isLoading
  const docs = docsQuery.data ?? []
  const folders = foldersQuery.data ?? []
  const currentFolder = folderId === null ? null : (folders.find((f) => f.id === folderId) ?? null)
  // A ?folder= id we cannot see (deleted, revoked, mistyped) — not-found state.
  const notFound = !loading && folderId !== null && currentFolder === null
  const chain = currentFolder === null ? [] : breadcrumbChain(folders, currentFolder.id)
  const listing = folderListing(docs, folders, currentFolder?.id ?? null) ?? { folders: [], docs: [] }

  // Image assets live in folder namespaces only — the root has none. Same
  // query key as the file tree so editor uploads invalidate both views.
  const assetsQuery = useQuery({
    queryKey: ['folder-assets', currentFolder?.id],
    queryFn: () => listFolderAssets(currentFolder!.id),
    enabled: currentFolder !== null,
    staleTime: 30_000,
  })
  const assets = currentFolder === null ? [] : sortAssets(assetsQuery.data ?? [])
  const visibleAssets = assets.filter((asset) => assetKindForContentType(asset.contentType) !== null)

  const uploadHtmlMut = useMutation({
    mutationFn: async (input: { folderId: string; files: File[] }) => {
      return uploadHtmlAssets(input.folderId, input.files)
    },
    onSuccess: (uploaded, input) => {
      void queryClient.invalidateQueries({ queryKey: ['folder-assets', input.folderId] })
      showToast(uploaded.length === 1 ? `Uploaded ${uploaded[0]!.asset.filename}.` : `Uploaded ${uploaded.length} HTML files.`)
    },
    onError: (err) => showToast(htmlUploadErrorMessage(err)),
  })

  // Create gates mirror the tree: root is always yours; folders owner-only.
  // chain.length is the current folder's depth, so a child sits at +1.
  const isOwnerHere = currentFolder === null || currentFolder.role === 'owner'
  const canCreateFolder = isOwnerHere && chain.length + 1 <= MAX_FOLDER_DEPTH
  const canUploadHtml = currentFolder !== null && roleAtLeast(currentFolder.role, 'editor')
  const canUploadAssets = canUploadHtml

  const uploadHtmlFiles = (files: FileList | null) => {
    if (currentFolder === null || !files) return
    const htmlFiles = [...files].filter(isHtmlFile)
    if (htmlFiles.length === 0) {
      showToast('Choose a .html or .htm file.')
      return
    }
    uploadHtmlMut.mutate({ folderId: currentFolder.id, files: htmlFiles })
  }

  const hasDocDrag = (e: DragEvent) => e.dataTransfer.types.includes(DOC_DRAG_MIME)
  const hasFolderDrag = (e: DragEvent) => e.dataTransfer.types.includes(FOLDER_DRAG_MIME)
  const hasAnyDrag = (e: DragEvent) => hasDocDrag(e) || (hasFolderDrag(e) && draggingFolder !== null)

  /** Shared drop handler: move whatever was dragged into `parentId` (a breadcrumb folder, vault root included). */
  const dropTo = (e: DragEvent, parentId: string | null) => {
    const droppedFolderId = e.dataTransfer.getData(FOLDER_DRAG_MIME)
    if (droppedFolderId) {
      e.preventDefault()
      mutations.moveFolderTo(droppedFolderId, parentId)
      return
    }
    const docId = e.dataTransfer.getData(DOC_DRAG_MIME)
    if (!docId) return
    e.preventDefault()
    mutations.moveDocTo(docId, parentId)
  }

  const resetFileDrag = () => {
    fileDragDepthRef.current = 0
    setFileDragOver(false)
  }

  const handleFileDrop = async (files: FileList) => {
    if (fileDropBusy) return
    if (currentFolder === null) {
      // We still intercepted the drop (so the browser doesn't just open the
      // file), but assets are folder-scoped — point the user at a folder.
      showToast('Open a folder to upload files here.')
      return
    }
    setFileDropBusy(true)
    const result: DropImportResult = {
      images: 0,
      html: 0,
      docs: 0,
      unsupported: 0,
      tooLarge: 0,
      forbiddenAssets: 0,
      forbiddenDocs: 0,
      failed: 0,
    }

    for (const file of files) {
      const kind = droppedFileKind(file)
      if (kind === null) {
        result.unsupported += 1
        continue
      }
      if (file.size > MAX_ASSET_BYTES) {
        result.tooLarge += 1
        continue
      }
      try {
        if (kind === 'markdown') {
          if (!isOwnerHere) {
            result.forbiddenDocs += 1
            continue
          }
          const created = await createDoc({ filename: markdownDocStem(file), folderId: currentFolder.id })
          await pushDocContent(created.id, await file.text())
          result.docs += 1
          continue
        }
        if (!canUploadAssets) {
          result.forbiddenAssets += 1
          continue
        }
        if (kind === 'html') {
          await uploadHtmlAssets(currentFolder.id, [file])
          result.html += 1
        } else {
          await uploadFolderAsset(currentFolder.id, file.name || 'image', fileWithImageType(file))
          result.images += 1
        }
      } catch {
        result.failed += 1
      }
    }

    if (result.images > 0 || result.html > 0) {
      void queryClient.invalidateQueries({ queryKey: ['folder-assets', currentFolder.id] })
    }
    if (result.docs > 0) {
      void queryClient.invalidateQueries({ queryKey: ['docs'] })
    }
    showToast(dropImportToast(result))
    setFileDropBusy(false)
  }

  // Page-wide drop target: the listeners live on `window` (not the list) so
  // files can be dropped ANYWHERE on the page. Refs feed the handlers the
  // latest folder / busy state without re-binding mid-drag, and the depth
  // counter survives the dragenter/dragleave storms child elements emit.
  const currentFolderRef = useRef(currentFolder)
  currentFolderRef.current = currentFolder
  const fileDropBusyRef = useRef(fileDropBusy)
  fileDropBusyRef.current = fileDropBusy
  const handleFileDropRef = useRef(handleFileDrop)
  handleFileDropRef.current = handleFileDrop

  useEffect(() => {
    // Any OS file drag (not an internal doc/folder reorder). We intercept these
    // ANYWHERE on the browser page — including the vault root where there is no
    // current folder — so the browser never hijacks the drop and opens the file
    // in a new tab; handleFileDrop then uploads (in a folder) or guides the user.
    const osFiles = (dt: DataTransfer | null) =>
      dt !== null &&
      dt.types.includes('Files') &&
      !dt.types.includes(DOC_DRAG_MIME) &&
      !dt.types.includes(FOLDER_DRAG_MIME)

    const onEnter = (e: WindowEventMap['dragenter']) => {
      if (!osFiles(e.dataTransfer)) return
      e.preventDefault()
      fileDragDepthRef.current += 1
      setFileDragOver(true)
    }
    const onOver = (e: WindowEventMap['dragover']) => {
      if (!osFiles(e.dataTransfer)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = fileDropBusyRef.current ? 'none' : 'copy'
    }
    const onLeave = (e: WindowEventMap['dragleave']) => {
      if (!osFiles(e.dataTransfer)) return
      fileDragDepthRef.current = Math.max(0, fileDragDepthRef.current - 1)
      if (fileDragDepthRef.current === 0) setFileDragOver(false)
    }
    const onDrop = (e: WindowEventMap['drop']) => {
      if (!osFiles(e.dataTransfer)) return
      e.preventDefault()
      resetFileDrag()
      void handleFileDropRef.current(e.dataTransfer!.files)
    }
    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragover', onOver)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  const ctx: BrowseCtx = {
    renaming,
    dragOverId: dragOver,
    draggingFolder,
    setRenaming,
    requestDelete: setDeleting,
    openAsset: (asset) => {
      if (currentFolder) setViewingAsset({ folder: currentFolder, asset })
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

  const isEmpty = listing.folders.length === 0 && listing.docs.length === 0 && visibleAssets.length === 0

  return (
    <main className="page-wrap py-8">
      {fileDragOver && currentFolder ? (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-[var(--accent-soft)]/80 backdrop-blur-[1px]">
          <div className="rounded-xl border-2 border-dashed border-[var(--accent)] bg-[var(--paper)] px-6 py-4 text-sm font-medium text-[var(--ink)] shadow-xl">
            Drop files to add to {currentFolder.name}
          </div>
        </div>
      ) : null}
      <div className="mb-5 flex flex-wrap items-center gap-2">
        {loading ? (
          <div aria-hidden className="skeleton-appear skeleton-bar h-7 w-44 rounded-md" />
        ) : (
          <Breadcrumbs
            chain={chain}
            dragOverId={dragOver}
            hasDrag={hasAnyDrag}
            setDragOver={setDragOver}
            onDropTo={dropTo}
          />
        )}
        {!loading && !notFound ? (
          <div className="ml-auto flex shrink-0 gap-2">
            {canCreateFolder ? (
              <Button
                onClick={() => {
                  setRenaming(null)
                  setCreating('folder')
                }}
              >
                <FolderPlus size={14} /> New folder
              </Button>
            ) : null}
            {canUploadHtml ? (
              <>
                <input
                  ref={htmlUploadInputRef}
                  type="file"
                  accept=".html,.htm,text/html"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    uploadHtmlFiles(e.currentTarget.files)
                    e.currentTarget.value = ''
                  }}
                />
                <Button onClick={() => htmlUploadInputRef.current?.click()} disabled={uploadHtmlMut.isPending}>
                  <Upload size={14} /> {uploadHtmlMut.isPending ? 'Uploading...' : 'Upload HTML'}
                </Button>
              </>
            ) : null}
            {isOwnerHere ? (
              <Button
                variant="primary"
                onClick={() => {
                  setRenaming(null)
                  setCreating('doc')
                }}
              >
                <FilePlus2 size={14} /> New doc
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Recent chips at the top of the ACTIVE VAULT, scoped to its docs. */}
      {currentFolder?.kind === 'vault' && !loading ? (
        <RecentStrip docs={docs.filter((d) => docVaultId(d, folders) === currentFolder.id)} />
      ) : null}

      {loading ? (
        <BrowserSkeleton />
      ) : notFound ? (
        <div className="rounded-lg border border-dashed border-[var(--line)] px-4 py-10 text-center">
          <p className="m-0 text-sm font-medium text-[var(--ink-soft)]">
            This folder doesn&rsquo;t exist or you don&rsquo;t have access to it.
          </p>
          <Link
            to="/"
            className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 py-1.5 text-sm font-medium text-[var(--ink)] no-underline transition hover:bg-[var(--paper-soft)]"
          >
            Back to Home
          </Link>
        </div>
      ) : isEmpty && creating === null ? (
        folderId === null ? (
          <EmptyState title="No documents yet" hint="Create your first markdown doc — or pull one with the ink CLI." />
        ) : (
          <div className="rounded-lg border border-dashed border-[var(--line)] px-4 py-10 text-center">
            <p className="m-0 text-sm font-medium text-[var(--ink-soft)]">
              {currentFolder?.kind === 'vault' ? 'This vault is empty' : 'This folder is empty'}
            </p>
            {isOwnerHere ? (
              <div className="mt-3 flex justify-center gap-2">
                {canCreateFolder ? (
                  <Button size="sm" onClick={() => setCreating('folder')}>
                    <FolderPlus size={13} /> New folder
                  </Button>
                ) : null}
                <Button size="sm" variant="primary" onClick={() => setCreating('doc')}>
                  <FilePlus2 size={13} /> New doc
                </Button>
              </div>
            ) : null}
          </div>
        )
      ) : (
        <ul className="island-shell m-0 list-none divide-y divide-[var(--line)] p-0">
          {creating === 'folder' ? (
            <CreateRow
              kind="folder"
              onCommit={(name) => {
                mutations.createFolderIn(name, currentFolder?.id ?? null)
                setCreating(null)
              }}
              onCancel={() => setCreating(null)}
            />
          ) : null}

          {listing.folders.map((folder) => (
            <FolderRow key={folder.id} folder={folder} ctx={ctx} />
          ))}

          {creating === 'doc' ? (
            <CreateRow
              kind="doc"
              onCommit={(name) => {
                mutations.createDocIn(name, currentFolder?.id ?? null)
                setCreating(null)
              }}
              onCancel={() => setCreating(null)}
            />
          ) : null}

          {listing.docs.map((doc) => (
            <DocRow key={doc.id} doc={doc} ctx={ctx} />
          ))}

          {currentFolder
            ? visibleAssets.map((asset) => <AssetRow key={asset.id} folderId={currentFolder.id} asset={asset} ctx={ctx} />)
            : null}
        </ul>
      )}

      {toast ? (
        <div
          role="status"
          className="pointer-events-none fixed bottom-6 left-1/2 z-50 max-w-[90vw] -translate-x-1/2 rounded-md bg-[var(--ink)] px-3 py-1.5 text-center text-xs text-[var(--paper)] shadow-lg"
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
    </main>
  )
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** Row chrome shared by every list entry (the shell has no overflow-hidden, so edge rows round themselves). */
const ROW_CLASS = 'group flex min-h-[42px] items-center gap-3 px-3 first:rounded-t-[11px] last:rounded-b-[11px]'

function FolderRow({ folder, ctx }: { folder: FolderInfo; ctx: BrowseCtx }) {
  const isOwner = folder.role === 'owner'
  const dragOver = ctx.dragOverId === folder.id

  if (ctx.renaming?.kind === 'folder' && ctx.renaming.folder.id === folder.id) {
    return (
      <li className={`${ROW_CLASS} py-2`}>
        <Folder size={16} className="shrink-0 text-[var(--ink-soft)]" />
        <InlineNameInput
          initial={folder.name}
          placeholder="Folder name"
          onCommit={(name) => ctx.renameFolderTo(folder, name)}
          onCancel={() => ctx.setRenaming(null)}
        />
      </li>
    )
  }

  return (
    <li
      className={`${ROW_CLASS} ${
        dragOver
          ? 'bg-[var(--accent-soft)] outline outline-1 -outline-offset-1 outline-[var(--accent)]'
          : 'hover:bg-[var(--paper-soft)]'
      }`}
      draggable={isOwner}
      onDragStart={(e) => {
        if (!isOwner) return
        ctx.startFolderDrag(e, folder)
      }}
      onDragEnd={ctx.endFolderDrag}
      onDragOver={(e) => {
        if (ctx.hasFolderDrag(e) && ctx.draggingFolder?.invalid.has(folder.id)) {
          // A folder into itself or its own subtree: swallow the event (no
          // preventDefault) so the browser shows the no-drop cursor.
          e.stopPropagation()
          return
        }
        const folderDrop = ctx.hasFolderDrag(e) && ctx.draggingFolder !== null
        if ((!ctx.hasDocDrag(e) && !folderDrop) || !isOwner) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        ctx.setDragOver(folder.id)
      }}
      onDragLeave={(e) => {
        // dragleave also fires when moving between this row's children.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
        if (ctx.dragOverId === folder.id) ctx.setDragOver(null)
      }}
      onDrop={(e) => {
        ctx.setDragOver(null)
        if (!isOwner) return
        const droppedFolderId = e.dataTransfer.getData(FOLDER_DRAG_MIME)
        if (droppedFolderId) {
          e.preventDefault()
          ctx.moveFolderTo(droppedFolderId, folder.id)
          return
        }
        const docId = e.dataTransfer.getData(DOC_DRAG_MIME)
        if (!docId) return
        e.preventDefault()
        ctx.moveDoc(docId, folder.id)
      }}
    >
      <Link
        to="/"
        search={{ folder: folder.id }}
        title={folder.name}
        className="flex min-w-0 flex-1 items-center gap-3 py-2.5 text-sm font-medium text-[var(--ink)] no-underline hover:text-[var(--accent)]"
      >
        <Folder size={16} className="shrink-0 text-[var(--ink-soft)]" />
        <span className="truncate">{folder.name}</span>
      </Link>
      {!isOwner ? <Badge>{folder.role}</Badge> : null}
      <UpdatedCell />
      {isOwner ? (
        <RowActions
          onRename={() => ctx.setRenaming({ kind: 'folder', folder })}
          onDelete={() => ctx.requestDelete({ kind: 'folder', id: folder.id, name: folder.name })}
        />
      ) : null}
    </li>
  )
}

function DocRow({ doc, ctx }: { doc: DocMeta; ctx: BrowseCtx }) {
  const isOwner = doc.role === 'owner'

  if (ctx.renaming?.kind === 'doc' && ctx.renaming.doc.id === doc.id) {
    return (
      <li className={`${ROW_CLASS} py-2`}>
        <FileText size={16} className="shrink-0 text-[var(--ink-faint)]" />
        <InlineNameInput
          initial={doc.title}
          placeholder="file-name"
          slug
          onCommit={(name) => ctx.renameDocTo(doc, name)}
          onCancel={() => ctx.setRenaming(null)}
        />
      </li>
    )
  }

  return (
    <li
      className={`${ROW_CLASS} hover:bg-[var(--paper-soft)]`}
      draggable={isOwner}
      onDragStart={(e) => {
        if (!isOwner) return
        e.dataTransfer.setData(DOC_DRAG_MIME, doc.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
    >
      <Link
        to="/d/$docId"
        params={{ docId: doc.id }}
        title={doc.title}
        className="flex min-w-0 flex-1 items-center gap-3 py-2.5 text-sm font-medium text-[var(--ink)] no-underline hover:text-[var(--accent)]"
      >
        <FileText size={16} className="shrink-0 text-[var(--ink-faint)]" />
        <span className="truncate">{doc.title}</span>
      </Link>
      {!isOwner ? <Badge tone="blue">{doc.role}</Badge> : null}
      <UpdatedCell>{timeAgo(doc.updatedAt)}</UpdatedCell>
      {isOwner ? (
        <RowActions
          onRename={() => ctx.setRenaming({ kind: 'doc', doc })}
          onDelete={() => ctx.requestDelete({ kind: 'doc', id: doc.id, name: doc.title })}
        />
      ) : null}
    </li>
  )
}

/** Folder asset row — images open the lightbox; standalone HTML opens the sandboxed viewer. */
function AssetRow({ folderId, asset, ctx }: { folderId: string; asset: AssetMeta; ctx: BrowseCtx }) {
  const kind = assetKindForContentType(asset.contentType)
  if (kind === 'html') {
    return (
      <li className={`${ROW_CLASS} hover:bg-[var(--paper-soft)]`}>
        <Link
          to="/f/$folderId/file/$filename"
          params={{ folderId, filename: asset.filename }}
          title={asset.filename}
          className="flex min-w-0 flex-1 items-center gap-3 py-2.5 text-sm font-medium text-[var(--ink)] no-underline hover:text-[var(--accent)]"
        >
          <FileCode2 size={16} className="shrink-0 text-[var(--ink-faint)]" />
          <span className="truncate">{asset.filename}</span>
        </Link>
        <UpdatedCell />
      </li>
    )
  }

  if (kind !== 'image') return null
  return (
    <li className={`${ROW_CLASS} hover:bg-[var(--paper-soft)]`}>
      <button
        type="button"
        onClick={() => ctx.openAsset(asset)}
        title={asset.filename}
        className="flex min-w-0 flex-1 items-center gap-3 py-2.5 text-left text-sm text-[var(--ink-soft)] hover:text-[var(--ink)]"
      >
        <ImageIcon size={16} className="shrink-0 text-[var(--ink-faint)]" />
        <span className="truncate">{asset.filename}</span>
      </button>
      <UpdatedCell />
    </li>
  )
}

function isHtmlFile(file: File): boolean {
  const name = file.name.toLowerCase()
  return file.type === 'text/html' || name.endsWith('.html') || name.endsWith('.htm')
}

type DroppedFileKind = 'image' | 'html' | 'markdown'
type DropImportResult = {
  images: number
  html: number
  docs: number
  unsupported: number
  tooLarge: number
  forbiddenAssets: number
  forbiddenDocs: number
  failed: number
}

function droppedFileKind(file: File): DroppedFileKind | null {
  if (isMarkdownFile(file)) return 'markdown'
  if (isHtmlFile(file)) return 'html'
  if (isImageFile(file)) return 'image'
  return null
}

function isMarkdownFile(file: File): boolean {
  return file.type === 'text/markdown' || file.name.toLowerCase().endsWith('.md')
}

function isImageFile(file: File): boolean {
  if (file.type.startsWith('image/')) return true
  const ext = fileExtension(file.name)
  return ext !== null && IMAGE_FILE_EXTENSIONS.includes(ext as (typeof IMAGE_FILE_EXTENSIONS)[number])
}

function fileExtension(name: string): string | null {
  const i = name.lastIndexOf('.')
  if (i < 0 || i === name.length - 1) return null
  return name.slice(i + 1).toLowerCase()
}

function markdownDocStem(file: File): string {
  const fallback = 'untitled'
  const name = file.name.trim() || fallback
  return name.toLowerCase().endsWith('.md') ? name.slice(0, -3) || fallback : name
}

async function uploadHtmlAssets(folderId: string, files: readonly File[]) {
  const uploaded = []
  for (const file of files) {
    const blob = file.type === 'text/html' ? file : file.slice(0, file.size, 'text/html')
    uploaded.push(await uploadFolderAsset(folderId, file.name || 'page.html', blob))
  }
  return uploaded
}

function fileWithImageType(file: File): Blob {
  if (file.type.startsWith('image/')) return file
  const contentType = imageContentTypeForExtension(fileExtension(file.name))
  return contentType ? file.slice(0, file.size, contentType) : file
}

function imageContentTypeForExtension(ext: string | null): string | null {
  switch (ext) {
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'gif':
      return 'image/gif'
    case 'webp':
      return 'image/webp'
    case 'svg':
      return 'image/svg+xml'
    case 'avif':
      return 'image/avif'
    default:
      return null
  }
}

function dropImportToast(result: DropImportResult): string {
  const parts = [
    countPart(result.images, 'image', 'images', 'Uploaded'),
    countPart(result.html, 'HTML file', 'HTML files', 'Uploaded'),
    countPart(result.docs, 'doc', 'docs', 'Imported'),
    countPart(result.tooLarge, 'oversize file', 'oversize files', 'skipped'),
    countPart(result.unsupported, 'unsupported file', 'unsupported files', 'skipped'),
    countPart(result.forbiddenAssets + result.forbiddenDocs, 'file without permission', 'files without permission', 'skipped'),
    countPart(result.failed, 'file that failed', 'files that failed', 'skipped'),
  ].filter((part) => part !== null)
  return parts.length > 0 ? parts.join(' · ') : 'No files were dropped.'
}

function countPart(count: number, singular: string, plural: string, verb: string): string | null {
  if (count === 0) return null
  return `${verb} ${count} ${count === 1 ? singular : plural}`
}

function htmlUploadErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'too-large') return 'HTML files must be 10 MB or smaller.'
    if (err.code === 'forbidden') return 'You need editor access to upload HTML here.'
    if (err.code === 'unsupported-content-type') return 'Choose a .html or .htm file.'
  }
  return 'Could not upload the HTML file.'
}

/** Inline create row (the tree's pattern, browser-sized): commit on Enter/blur, Esc cancels. */
function CreateRow({
  kind,
  onCommit,
  onCancel,
}: {
  kind: 'doc' | 'folder'
  onCommit: (name: string) => void
  onCancel: () => void
}) {
  return (
    <li className={`${ROW_CLASS} py-2`}>
      {kind === 'folder' ? (
        <Folder size={16} className="shrink-0 text-[var(--ink-soft)]" />
      ) : (
        <FileText size={16} className="shrink-0 text-[var(--ink-faint)]" />
      )}
      <InlineNameInput
        placeholder={kind === 'folder' ? 'Folder name' : 'file-name'}
        slug={kind === 'doc'}
        onCommit={onCommit}
        onCancel={onCancel}
      />
    </li>
  )
}

/** Right-aligned "updated" column; collapses on narrow screens. Empty for folders/assets (no timestamp). */
function UpdatedCell({ children }: { children?: ReactNode }) {
  return (
    <span className="hidden w-20 shrink-0 whitespace-nowrap text-right text-xs text-[var(--ink-faint)] sm:inline">
      {children}
    </span>
  )
}

/** ⋯ menu, revealed on hover/focus (always visible on touch) — same pattern as the tree rows. */
function RowActions({ onRename, onDelete }: { onRename: () => void; onDelete: () => void }) {
  return (
    <span className="flex shrink-0 items-center opacity-0 transition group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100">
      <RowMenu
        items={[
          { label: 'Rename', icon: <Pencil size={13} />, onSelect: onRename },
          { label: 'Delete', icon: <Trash2 size={13} />, onSelect: onDelete, danger: true },
        ]}
      />
    </span>
  )
}

// ---------------------------------------------------------------------------
// Root extras & loading
// ---------------------------------------------------------------------------

/**
 * One row of chips for the docs visited most recently (quick-switcher's
 * localStorage list) — root only. Hydrated after mount: SSR has no storage,
 * and reading it during render would mismatch hydration.
 */
function RecentStrip({ docs }: { docs: readonly DocMeta[] }) {
  const [recentIds, setRecentIds] = useState<string[]>([])
  useEffect(() => {
    setRecentIds(getRecentDocIds())
  }, [])

  const items = recentDocs(docs, recentIds)
  if (items.length === 0) return null

  return (
    <div className="mb-5 flex items-center gap-2 overflow-x-auto pb-0.5">
      <span className="island-kicker flex shrink-0 items-center gap-1">
        <Clock3 size={11} /> Recent
      </span>
      {items.map((doc) => (
        <Link
          key={doc.id}
          to="/d/$docId"
          params={{ docId: doc.id }}
          title={doc.title}
          className="flex max-w-48 shrink-0 items-center gap-1.5 rounded-full border border-[var(--line)] bg-[var(--paper)] px-2.5 py-1 text-xs font-medium text-[var(--ink)] no-underline transition hover:border-[var(--accent)] hover:text-[var(--accent)]"
        >
          <FileText size={12} className="shrink-0 text-[var(--ink-faint)]" />
          <span className="truncate">{doc.title}</span>
        </Link>
      ))}
    </div>
  )
}

/** Ghost rows while the docs/folders queries load (same anti-flash conventions as PanelSkeleton). */
function BrowserSkeleton() {
  return (
    <div aria-hidden className="skeleton-appear island-shell divide-y divide-[var(--line)]">
      {[13, 9, 11, 7, 12, 8].map((w, i) => (
        <div key={i} className="flex min-h-[42px] items-center gap-3 px-3">
          <div className="skeleton-bar h-4 w-4 rounded" />
          <div className="skeleton-bar h-3.5" style={{ width: `${w}rem` }} />
          <div className="skeleton-bar ml-auto hidden h-3 w-14 sm:block" />
        </div>
      ))}
    </div>
  )
}
