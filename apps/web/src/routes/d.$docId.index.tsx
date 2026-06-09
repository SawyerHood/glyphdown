import { useEffect, useState, type ComponentType } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { EditorShellSkeleton } from '../components/DocSkeletons.tsx'

export const Route = createFileRoute('/d/$docId/')({
  validateSearch: (search: Record<string, unknown>): { share?: string } =>
    typeof search['share'] === 'string' ? { share: search['share'] } : {},
  component: DocRoute,
})

type EditorProps = { docId: string; share: string | undefined }

/**
 * The editor stack (CodeMirror, Yjs, the y-partyserver provider) is browser
 * only — load it client-side so SSR never touches it and the worker bundle
 * stays lean.
 *
 * Module-level cache: the dynamic import happens once per session. Leaving a
 * doc and coming back (or remounting the route for any reason) reuses the
 * loaded component synchronously — no loading shell, no flash.
 */
let LoadedEditor: ComponentType<EditorProps> | null = null

function DocRoute() {
  const { docId } = Route.useParams()
  const { share } = Route.useSearch()
  const [Editor, setEditor] = useState<ComponentType<EditorProps> | null>(() => LoadedEditor)

  useEffect(() => {
    if (LoadedEditor) return
    let cancelled = false
    void import('../components/editor/DocEditorPage.tsx').then((m) => {
      LoadedEditor = m.DocEditorPage
      if (!cancelled) setEditor(() => m.DocEditorPage)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // True cold loads only (SSR shell + the first-ever dynamic import): the
  // same skeleton frame the editor itself uses while a doc syncs, so the
  // whole load path speaks one visual language. Never shown on doc switches.
  if (!Editor) return <EditorShellSkeleton />

  // Deliberately NOT keyed by docId: DocEditorPage persists across doc
  // switches so the chrome (toolbar frame, sidebar shell) never unmounts —
  // it resets its doc-scoped state internally when docId changes.
  return <Editor docId={docId} share={share} />
}
