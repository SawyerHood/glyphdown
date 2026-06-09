import { EditorSelection, EditorState, type Extension } from '@codemirror/state'
import type { Decoration, DecorationSet } from '@codemirror/view'
import { glyphdownMarkdown, livePreview, livePreviewField } from '../src/index.ts'

export function previewState(doc: string, anchor = 0, head = anchor): EditorState {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.single(anchor, head),
    extensions: [glyphdownMarkdown(), livePreview()],
  })
  // Force one recompute so the field reflects the fully parsed tree even if
  // the initial parse budget was exhausted at create time.
  return state.update({ selection: EditorSelection.single(anchor, head) }).state
}

export interface DecoEntry {
  from: number
  to: number
  deco: Decoration
}

export function listDecorations(set: DecorationSet): DecoEntry[] {
  const out: DecoEntry[] = []
  const it = set.iter()
  while (it.value) {
    out.push({ from: it.from, to: it.to, deco: it.value })
    it.next()
  }
  return out
}

export function previewDecorations(state: EditorState): DecoEntry[] {
  return listDecorations(state.field(livePreviewField))
}

export function hiddenRanges(state: EditorState): { from: number; to: number }[] {
  return previewDecorations(state)
    .filter((d) => d.deco.spec['glyphdown'] === 'hide')
    .map(({ from, to }) => ({ from, to }))
}

export function decorationsWithClass(state: EditorState, cls: string): DecoEntry[] {
  return previewDecorations(state).filter((d) => {
    const c: unknown = d.deco.spec['class'] ?? d.deco.spec['attributes']?.class
    return typeof c === 'string' && c.split(' ').includes(cls)
  })
}

export function decorationsTagged(state: EditorState, tag: string): DecoEntry[] {
  return previewDecorations(state).filter((d) => d.deco.spec['glyphdown'] === tag)
}

export type { Extension }
