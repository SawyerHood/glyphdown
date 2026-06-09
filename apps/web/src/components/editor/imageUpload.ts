import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { uploadAsset } from '../../lib/api.ts'

/**
 * Paste/drop image upload (app-side extension: it needs the API client, so it
 * lives here rather than in @glyphdown/editor). On pasting or dropping image
 * files the bytes POST to /api/docs/:docId/assets and the markdown
 * `![<basename>](<filename>)` lands at the cursor/drop point.
 *
 * Edit mode inserts a transient `![Uploading name…](uploading-<nonce>)`
 * placeholder while the upload is in flight, then swaps it for the final
 * markdown (or removes it on failure — the error surfaces via onError).
 * Suggest-mode sessions upload FIRST and then insert the final markdown in
 * one transaction, so the insertion flows through the normal suggest-mode
 * path as a single insert suggestion instead of placeholder churn.
 *
 * Only mounted for editor+ roles: viewers/commenters can't upload, and
 * suggester-role uploads are refused by the server (SPEC §4 — upload is a
 * direct write to shared folder storage, not a suggestion).
 */
export interface ImageUploadOptions {
  docId: string
  share: string | undefined
  /** True while the editor session is in suggest mode. */
  isSuggestMode: () => boolean
  /** Error affordance (the page's transient error banner). */
  onError: (err: unknown) => void
  /** Called after each successful upload (the sidebar invalidates its folder-assets query here). */
  onUploaded?: () => void
}

export function imageUpload(opts: ImageUploadOptions): Extension {
  return EditorView.domEventHandlers({
    paste: (event, view) => {
      const files = imageFiles(event.clipboardData?.files)
      if (files.length === 0) return false
      event.preventDefault()
      const sel = view.state.selection.main
      void uploadAll(view, files, { from: sel.from, to: sel.to }, opts)
      return true
    },
    drop: (event, view) => {
      const files = imageFiles(event.dataTransfer?.files)
      if (files.length === 0) return false
      event.preventDefault()
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head
      void uploadAll(view, files, { from: pos, to: pos }, opts)
      return true
    },
  })
}

function imageFiles(list: FileList | null | undefined): File[] {
  return list ? [...list].filter((f) => f.type.startsWith('image/')) : []
}

const EXT_BY_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
}

function fallbackName(file: File): string {
  if (file.name && file.name.trim() !== '') return file.name
  return `pasted-image.${EXT_BY_TYPE[file.type] ?? 'png'}`
}

function markdownFor(path: string, sourceName: string): string {
  const base = sourceName.split(/[/\\]/).pop() ?? sourceName
  const dot = base.lastIndexOf('.')
  const alt = (dot > 0 ? base.slice(0, dot) : base).replace(/[[\]]/g, '')
  return `![${alt}](${path})`
}

async function uploadAll(
  view: EditorView,
  files: File[],
  at: { from: number; to: number },
  opts: ImageUploadOptions,
): Promise<void> {
  let target: { from: number; to: number } | null = at
  for (const file of files) {
    // Sequential: each insertion moves the cursor; later files follow it.
    await uploadOne(view, file, target, opts)
    target = null
  }
}

async function uploadOne(
  view: EditorView,
  file: File,
  at: { from: number; to: number } | null,
  opts: ImageUploadOptions,
): Promise<void> {
  const name = fallbackName(file)

  if (opts.isSuggestMode()) {
    // Upload first; the single final insertion rides the suggest-mode path.
    try {
      const result = await uploadAsset(opts.docId, name, file, { share: opts.share })
      opts.onUploaded?.()
      const sel = view.state.selection.main
      const from = Math.min(at?.from ?? sel.from, view.state.doc.length)
      const to = Math.min(at?.to ?? sel.to, view.state.doc.length)
      dispatchSafely(view, {
        changes: { from, to, insert: markdownFor(result.path, name) },
        userEvent: 'input.paste',
      })
    } catch (err) {
      opts.onError(err)
    }
    return
  }

  const nonce = Math.random().toString(36).slice(2, 10)
  const placeholder = `![Uploading ${name}…](uploading-${nonce})`
  const sel = view.state.selection.main
  const from = Math.min(at?.from ?? sel.from, view.state.doc.length)
  const to = Math.min(at?.to ?? sel.to, view.state.doc.length)
  dispatchSafely(view, {
    changes: { from, to, insert: placeholder },
    selection: { anchor: from + placeholder.length },
    userEvent: 'input.paste',
  })

  try {
    const result = await uploadAsset(opts.docId, name, file, { share: opts.share })
    opts.onUploaded?.()
    replacePlaceholder(view, placeholder, markdownFor(result.path, name))
  } catch (err) {
    replacePlaceholder(view, placeholder, '')
    opts.onError(err)
  }
}

/**
 * Swap the in-flight placeholder for its final markdown (or nothing). Found
 * by exact text — concurrent edits move it, deleting it cancels the swap.
 */
function replacePlaceholder(view: EditorView, placeholder: string, replacement: string): void {
  const idx = view.state.doc.toString().indexOf(placeholder)
  if (idx < 0) return
  dispatchSafely(view, {
    changes: { from: idx, to: idx + placeholder.length, insert: replacement },
    userEvent: 'input',
  })
}

function dispatchSafely(view: EditorView, spec: Parameters<EditorView['dispatch']>[0]): void {
  try {
    view.dispatch(spec)
  } catch {
    // View torn down mid-upload (navigation) — nothing to update.
  }
}
