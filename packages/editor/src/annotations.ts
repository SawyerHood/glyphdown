import { type Extension, type Range as RangeValue, StateEffect, StateField } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view'
import type { Range } from '@glyphdown/core'
import type { Comment, SuggestionRecord } from '@glyphdown/protocol'

// ---------------------------------------------------------------------------
// Payload: protocol records with their anchors resolved OUTSIDE the editor.
// The app resolves anchors via core's resolveAnchor/validateOrReanchor against
// the Y.Doc and dispatches the result here whenever sidecar state changes.
// ---------------------------------------------------------------------------

export interface ResolvedComment {
  comment: Comment
  range: Range
}

export interface ResolvedSuggestionPart {
  kind: 'insert' | 'delete'
  range: Range
}

export interface ResolvedSuggestion {
  suggestion: SuggestionRecord
  parts: ResolvedSuggestionPart[]
}

export interface DocAnnotations {
  comments: ResolvedComment[]
  suggestions: ResolvedSuggestion[]
}

function mapRange(range: Range, mapping: { mapPos(pos: number, assoc?: number): number }): Range {
  return { start: mapping.mapPos(range.start, 1), end: mapping.mapPos(range.end, -1) }
}

/** Replace the rendered comment/suggestion ranges. */
export const setDocAnnotationsEffect = StateEffect.define<DocAnnotations>({
  map: (value, mapping) => ({
    comments: value.comments.map((c) => ({ ...c, range: mapRange(c.range, mapping) })),
    suggestions: value.suggestions.map((s) => ({
      ...s,
      parts: s.parts.map((p) => ({ ...p, range: mapRange(p.range, mapping) })),
    })),
  }),
})

/** Convenience helper: dispatch a fresh resolved set into the view. */
export function dispatchDocAnnotations(view: EditorView, annotations: DocAnnotations): void {
  view.dispatch({ effects: setDocAnnotationsEffect.of(annotations) })
}

function buildDecorations(annotations: DocAnnotations): DecorationSet {
  const decos: RangeValue<Decoration>[] = []
  for (const { comment, range } of annotations.comments) {
    if (range.end <= range.start) continue
    decos.push(
      Decoration.mark({
        class: 'cm-ink-comment',
        attributes: { 'data-comment-id': comment.id },
      }).range(range.start, range.end),
    )
  }
  for (const { suggestion, parts } of annotations.suggestions) {
    for (const part of parts) {
      if (part.range.end <= part.range.start) continue
      decos.push(
        Decoration.mark({
          class: part.kind === 'insert' ? 'cm-ink-suggest-insert' : 'cm-ink-suggest-delete',
          attributes: { 'data-suggestion-id': suggestion.id },
        }).range(part.range.start, part.range.end),
      )
    }
  }
  return Decoration.set(decos, true)
}

/**
 * Comment + suggestion range rendering. Between effect dispatches the set is
 * mapped through document changes so highlights track live edits until the
 * app re-resolves anchors and dispatches a fresh set.
 */
export const docAnnotationsField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes)
    for (const effect of tr.effects) {
      if (effect.is(setDocAnnotationsEffect)) value = buildDecorations(effect.value)
    }
    return value
  },
  provide: (f) => EditorView.decorations.from(f),
})

const annotationsBaseTheme = EditorView.baseTheme({
  '.cm-ink-comment': {
    backgroundColor: 'rgba(250, 204, 21, 0.30)',
    cursor: 'pointer',
  },
  '.cm-ink-suggest-insert': {
    backgroundColor: 'rgba(34, 197, 94, 0.14)',
    color: '#15803d',
  },
  '.cm-ink-suggest-delete': {
    backgroundColor: 'rgba(239, 68, 68, 0.10)',
    color: '#b91c1c',
    textDecoration: 'line-through',
  },
})

/** Comment + suggestion rendering extension (field + default styling). */
export function docAnnotations(): Extension {
  return [docAnnotationsField, annotationsBaseTheme]
}
