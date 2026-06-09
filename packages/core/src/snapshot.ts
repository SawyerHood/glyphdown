import type * as Y from 'yjs'
import { cleanupSemantic, makeDiff } from '@sanity/diff-match-patch'
import { applyDiffsToYText } from './merge.ts'

/**
 * Restore the document to `text` with minimal CRDT ops (a restore is itself an
 * edit — history is preserved, and unchanged regions keep their identity so
 * anchors on them survive).
 */
export function restoreText(ytext: Y.Text, text: string, origin?: unknown): void {
  const current = ytext.toString()
  if (current === text) return
  applyDiffsToYText(ytext, cleanupSemantic(makeDiff(current, text)), origin)
}
