import type { Extension } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next'
import type * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'

/**
 * The Glyphdown collab binding: yCollab over the shared Y.Text with awareness
 * cursors and a caller-owned Y.UndoManager (scoped to local origins so undo
 * stays per-user), plus the matching undo/redo keymap.
 *
 * NEVER add CodeMirror's own history() next to this — Yjs owns undo.
 * Provider wiring (y-partyserver YProvider, party 'doc-do', room docId) is
 * the app's job; pass its awareness instance here.
 */
export function glyphdownCollab(ytext: Y.Text, awareness: Awareness | null, undoManager: Y.UndoManager): Extension {
  return [keymap.of(yUndoManagerKeymap), yCollab(ytext, awareness, { undoManager })]
}
