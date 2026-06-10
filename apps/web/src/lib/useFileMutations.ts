import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MAX_FOLDER_DEPTH } from '@glyphdown/protocol'
import {
  ApiError,
  createDoc,
  createFolder,
  deleteDoc as apiDeleteDoc,
  deleteFolder as apiDeleteFolder,
  listDocs,
  listFolders,
  moveFolder,
  patchDoc,
  renameFolder as apiRenameFolder,
} from './api.ts'
import { folderWithDescendants } from './fileTree.ts'
import { slugifyDocStem } from './slug.ts'
import { track } from './analytics.ts'

/**
 * The doc/folder mutations shared by the file tree (sidebar) and the home
 * file browser — one implementation so both views invalidate the same
 * ['docs'] / ['folders'] query keys and surface identical error toasts
 * ('cycle', 'too-deep', 'filename-taken').
 *
 * Move calls are guarded client-side exactly like the server would reject
 * them (same scope, non-owner, folder-into-own-subtree) so invalid drops are
 * silent no-ops with instant feedback instead of round-tripping to a 400.
 */
export interface FileMutations {
  /** Create a doc (slug filename; server auto-suffixes collisions) and navigate to it. */
  createDocIn: (name: string, folderId: string | null) => void
  createFolderIn: (name: string, parentId: string | null) => void
  renameDocTo: (id: string, name: string) => void
  renameFolderTo: (id: string, name: string) => void
  /** Move a doc into a folder. No-op when same scope, not owner, or no target (docs never leave their vault for root). */
  moveDocTo: (docId: string, folderId: string | null) => void
  /** Move a folder under a parent. No-op on same parent, non-owner, cycle, vaults (immovable), or no target. */
  moveFolderTo: (folderId: string, parentId: string | null) => void
  deleteDoc: (id: string) => void
  deleteFolder: (id: string) => void
}

export function useFileMutations(showToast: (message: string) => void): FileMutations {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  // Same shared query keys the views render from (react-query dedupes the
  // fetch) — the move guards below need roles/parent links synchronously.
  const docsQuery = useQuery({ queryKey: ['docs'], queryFn: listDocs })
  const foldersQuery = useQuery({ queryKey: ['folders'], queryFn: listFolders })

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['docs'] })
    void queryClient.invalidateQueries({ queryKey: ['folders'] })
  }
  const tooDeepMessage = `Folders can nest at most ${MAX_FOLDER_DEPTH} levels deep.`

  const createDocMut = useMutation({
    // Docs are files: the name is a slug filename (collisions auto-suffix
    // server-side; we navigate to whatever canonical name came back).
    mutationFn: (input: { name: string; folderId: string | null }) =>
      createDoc({ filename: slugifyDocStem(input.name), ...(input.folderId ? { folderId: input.folderId } : {}) }),
    onSuccess: (created) => {
      track('doc_created', { docId: created.id, source: 'file-tree' })
      invalidate()
      void navigate({ to: '/d/$docId', params: { docId: created.id } })
    },
  })
  const createFolderMut = useMutation({
    mutationFn: (input: { name: string; parentId: string | null }) => createFolder(input),
    onSuccess: () => {
      track('folder_created', {})
      invalidate()
    },
    onError: (err) => {
      showToast(err instanceof ApiError && err.code === 'too-deep' ? tooDeepMessage : 'Could not create the folder.')
    },
  })
  const renameDocMut = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => patchDoc(id, { filename: slugifyDocStem(name) }),
    onSuccess: invalidate,
    onError: (err) => {
      showToast(
        err instanceof ApiError && err.code === 'filename-taken'
          ? 'That name is already taken here.'
          : 'Could not rename the document.',
      )
    },
  })
  const renameFolderMut = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => apiRenameFolder(id, name),
    onSuccess: invalidate,
  })
  const moveDocMut = useMutation({
    mutationFn: ({ id, folderId }: { id: string; folderId: string | null }) => patchDoc(id, { folderId }),
    onSuccess: invalidate,
    onError: (err) => {
      showToast(
        err instanceof ApiError && err.code === 'filename-taken'
          ? 'A document with that name already exists there — rename it first.'
          : 'Could not move the document.',
      )
    },
  })
  const moveFolderMut = useMutation({
    mutationFn: ({ id, parentId }: { id: string; parentId: string | null }) => moveFolder(id, parentId),
    onSuccess: invalidate,
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'cycle') {
        showToast('A folder cannot be moved into itself or its own subfolder.')
      } else if (err instanceof ApiError && err.code === 'too-deep') {
        showToast(tooDeepMessage)
      } else {
        showToast('Could not move the folder.')
      }
    },
  })
  const deleteDocMut = useMutation({ mutationFn: apiDeleteDoc, onSuccess: invalidate })
  const deleteFolderMut = useMutation({ mutationFn: apiDeleteFolder, onSuccess: invalidate })

  return {
    createDocIn: (name, folderId) => createDocMut.mutate({ name, folderId }),
    createFolderIn: (name, parentId) => createFolderMut.mutate({ name, parentId }),
    renameDocTo: (id, name) => renameDocMut.mutate({ id, name }),
    renameFolderTo: (id, name) => renameFolderMut.mutate({ id, name }),
    moveDocTo: (docId, folderId) => {
      // There is no root scope anymore — every doc lives in a vault's subtree
      // (the server 400s 'bad-folder' on null), so rootless drops are no-ops.
      if (folderId === null) return
      const doc = (docsQuery.data ?? []).find((d) => d.id === docId)
      if (!doc || doc.folderId === folderId || doc.role !== 'owner') return
      moveDocMut.mutate({ id: docId, folderId })
    },
    moveFolderTo: (folderId, parentId) => {
      // No new roots (the root level holds only vaults) — the server would
      // 400 'vault-required'; reject locally like the cycle guard.
      if (parentId === null) return
      const folders = foldersQuery.data ?? []
      const folder = folders.find((f) => f.id === folderId)
      if (!folder || folder.parentId === parentId || folder.role !== 'owner') return
      // Vaults ARE the roots: they never move (server 400 'vault-immovable').
      if (folder.kind === 'vault') return
      const target = folders.find((f) => f.id === parentId)
      if (!target || target.role !== 'owner') return
      // The server would 400 'cycle' — reject locally for instant feedback.
      if (folderWithDescendants(folders, folderId).has(parentId)) return
      moveFolderMut.mutate({ id: folderId, parentId })
    },
    deleteDoc: (id) => deleteDocMut.mutate(id),
    deleteFolder: (id) => deleteFolderMut.mutate(id),
  }
}

/**
 * Transient error toast (move/create rejections): the latest message, cleared
 * after ~4s. Render is up to the caller; the timer is cleaned up on unmount.
 */
export function useTransientToast(durationMs = 4000): {
  toast: string | null
  showToast: (message: string) => void
} {
  const [toast, setToast] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showToast = useCallback(
    (message: string) => {
      setToast(message)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setToast(null), durationMs)
    },
    [durationMs],
  )
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )
  return { toast, showToast }
}
