import { EditorSelection, EditorState, type Extension, type Text, Transaction } from '@codemirror/state'
import { EditorView, ViewPlugin } from '@codemirror/view'
import * as Y from 'yjs'
import { SuggestSession, normalizeEol, type Suggestion } from '@glyphdown/core'

/**
 * Default Yjs transaction origin for suggest-mode edits. Distinct from the
 * yCollab sync origin so the binding's observer echoes session mutations back
 * into the view. Add it to the app's Y.UndoManager trackedOrigins if local
 * undo of suggest-mode typing is desired.
 */
export const suggestModeOrigin = 'glyphdown:suggest-mode'

export interface SuggestModeConfig {
  ytext: Y.Text
  authorId: string
  newId: () => string
  /**
   * Called after every routed edit with the suggestions the edit touched
   * (`session.touched()`) — upsert these into persistence by id.
   */
  onSuggestion: (records: Suggestion[]) => void
  /** Coalescing clock + window, forwarded to SuggestSession. */
  now?: () => number
  coalesceMs?: number
  /** Yjs transaction origin (defaults to suggestModeOrigin). */
  origin?: unknown
  /**
   * Deferred-task scheduler. Defaults to queueMicrotask; injectable so tests
   * can drain the queue deterministically.
   */
  schedule?: (fn: () => void) => void
}

export interface SuggestMode {
  /** Put this in a Compartment and reconfigure to toggle suggest mode. */
  extension: Extension
  session: SuggestSession
  /** End the coalescing window: the next edit starts a new suggestion. */
  flush: () => void
}

interface CapturedEdit {
  /** Y relative position of the change start (assoc right). */
  from: Y.RelativePosition
  /** Y relative position of the change end (assoc left). */
  to: Y.RelativePosition
  insert: string
  userEvent: string | undefined
}

function docEqualsText(doc: Text, text: string): boolean {
  return doc.length === text.length && doc.toString() === text
}

function resolveRel(ytext: Y.Text, rel: Y.RelativePosition): number | null {
  const doc = ytext.doc
  if (!doc) return null
  const abs = Y.createAbsolutePositionFromRelativePosition(rel, doc, false)
  if (!abs || abs.type !== ytext) return null
  return abs.index
}

class SuggestController {
  readonly session: SuggestSession
  view: EditorView | null = null
  private queue: CapturedEdit[] = []
  private scheduled = false
  private readonly schedule: (fn: () => void) => void

  constructor(private readonly cfg: SuggestModeConfig) {
    this.session = new SuggestSession(cfg.ytext, cfg.authorId, {
      newId: cfg.newId,
      ...(cfg.now ? { now: cfg.now } : {}),
      ...(cfg.coalesceMs !== undefined ? { coalesceMs: cfg.coalesceMs } : {}),
      origin: cfg.origin ?? suggestModeOrigin,
    })
    this.schedule = cfg.schedule ?? ((fn) => queueMicrotask(fn))
  }

  /**
   * Capture a user transaction's changes as Y relative positions. Positions
   * are resolved at apply time so edits queued behind one another (or behind
   * a remote update) land at the right spots.
   */
  capture(tr: Transaction): void {
    const ytext = this.cfg.ytext
    const userEvent = tr.annotation(Transaction.userEvent)
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      this.queue.push({
        from: Y.createRelativePositionFromTypeIndex(ytext, fromA, 0),
        to: Y.createRelativePositionFromTypeIndex(ytext, toA, -1),
        insert: normalizeEol(inserted.toString()),
        userEvent,
      })
    })
    if (!this.scheduled && this.queue.length > 0) {
      this.scheduled = true
      this.schedule(() => {
        this.scheduled = false
        this.process()
      })
    }
  }

  /** Drain the queue through the SuggestSession, then place the cursor. */
  process(): void {
    const ytext = this.cfg.ytext
    let cursor: number | null = null

    while (this.queue.length > 0) {
      const edit = this.queue.shift()!
      const from = resolveRel(ytext, edit.from)
      let to = resolveRel(ytext, edit.to)
      if (from === null || to === null) continue
      if (to < from) to = from

      if (to > from) {
        // Deletion: own pending insertions are removed for real, original
        // text is only marked — so the cursor must be moved explicitly.
        this.session.delete(from, to)
        this.emit()
        const toNow = resolveRel(ytext, edit.to)
        cursor = edit.userEvent === 'delete.forward' ? (toNow ?? from) : from
      }
      if (edit.insert.length > 0) {
        this.session.insert(from, edit.insert)
        this.emit()
        cursor = from + edit.insert.length
      }
    }

    const view = this.view
    if (view && cursor !== null) {
      const pos = Math.max(0, Math.min(cursor, view.state.doc.length))
      view.dispatch({ selection: EditorSelection.cursor(pos), scrollIntoView: true, userEvent: 'select' })
    }
  }

  private emit(): void {
    this.cfg.onSuggestion(this.session.touched())
  }
}

/**
 * Suggest mode: intercepts local document edits and routes them through
 * core's SuggestSession instead of letting them apply directly. The session
 * mutates the same Y.Text the yCollab binding is attached to, so the binding
 * echoes the effective change (insertions appear; marked deletions don't)
 * back into the editor and out to other clients.
 *
 * Mechanics: a transactionFilter cancels any doc-changing transaction whose
 * start doc still matches the Y.Text (i.e. a local edit, not a sync echo),
 * captures the intended changes as Y relative positions, and replays them
 * through the session on the next microtask — dispatching from inside a
 * filter is illegal, and the deferral keeps the yCollab echo dispatch safe.
 */
export function createSuggestMode(config: SuggestModeConfig): SuggestMode {
  const ctrl = new SuggestController(config)

  const filter = EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged) return tr
    // A transaction produced by the Y.Text observer (sync echo, remote edit,
    // or our own session output) starts from a doc that no longer matches
    // ytext — let it through. A genuine local edit starts from a doc equal
    // to ytext — intercept it.
    if (!docEqualsText(tr.startState.doc, config.ytext.toString())) return tr
    ctrl.capture(tr)
    return []
  })

  const viewBinding = ViewPlugin.define((view) => {
    ctrl.view = view
    return {
      destroy() {
        if (ctrl.view === view) ctrl.view = null
        ctrl.session.flush()
      },
    }
  })

  return {
    extension: [filter, viewBinding],
    session: ctrl.session,
    flush: () => ctrl.session.flush(),
  }
}
