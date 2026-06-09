import { describe, expect, it } from 'vitest'
import { Compartment, EditorSelection, EditorState, type Extension } from '@codemirror/state'
import { glyphdownMarkdown, livePreview, mathField, wikiLinkField } from '../src/index.ts'
import {
  decorationsTagged,
  decorationsWithClass,
  hiddenRanges,
  listDecorations,
  previewState,
  type DecoEntry,
} from './helpers.ts'

// ---------------------------------------------------------------------------
// Read-only mode (viewer role / anonymous share-link visitors) never reveals
// raw markdown: the selection may sit anywhere — click, drag-select,
// select-all — and the document stays fully rendered. The single choke point
// is live-preview's touchesSelection (touchesLine delegates to it; wikilink
// and math import the same gate), which returns false whenever
// state.readOnly is true. Each surface below pairs a read-only no-reveal
// assertion with an editable control proving the reveal still works.
// ---------------------------------------------------------------------------

function readOnlyState(doc: string, anchor = 0, head = anchor): EditorState {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.single(anchor, head),
    extensions: [glyphdownMarkdown(), livePreview(), wikiLinkField, EditorState.readOnly.of(true)],
  })
  // Force one recompute so the fields reflect the fully parsed tree (the
  // previewState pattern in helpers.ts).
  return state.update({ selection: EditorSelection.single(anchor, head) }).state
}

function wikiDecorations(state: EditorState): DecoEntry[] {
  return listDecorations(state.field(wikiLinkField))
}

function mathDecorations(state: EditorState): DecoEntry[] {
  return listDecorations(state.field(mathField))
}

describe('read-only: inline formatting never reveals', () => {
  it('keeps bold delimiters hidden with the cursor inside the node', () => {
    const doc = 'intro\n\n**bold** here'
    const ro = readOnlyState(doc, 10) // inside **bold**
    expect(hiddenRanges(ro)).toContainEqual({ from: 7, to: 9 })
    expect(hiddenRanges(ro)).toContainEqual({ from: 13, to: 15 })
    // Editable control: the same cursor reveals.
    const editable = previewState(doc, 10)
    expect(hiddenRanges(editable).filter((r) => r.from >= 7 && r.to <= 15)).toHaveLength(0)
  })

  it('keeps italic, strike, highlight, and inline-code marks hidden under a full overlap selection', () => {
    const doc = 'a *it* ~~gone~~ ==hi== `code` b'
    const ro = readOnlyState(doc, 0, doc.length) // select-all
    const hidden = hiddenRanges(ro)
    expect(hidden).toContainEqual({ from: 2, to: 3 }) // *
    expect(hidden).toContainEqual({ from: 7, to: 9 }) // ~~
    expect(hidden).toContainEqual({ from: 16, to: 18 }) // ==
    expect(hidden).toContainEqual({ from: 23, to: 24 }) // `
    // Editable control: select-all reveals everything.
    expect(hiddenRanges(previewState(doc, 0, doc.length))).toHaveLength(0)
  })
})

describe('read-only: headings never reveal', () => {
  it('keeps the # marker hidden with the cursor on the heading line', () => {
    const doc = '# Title\n\nbody'
    const ro = readOnlyState(doc, 3) // on the heading line
    expect(hiddenRanges(ro)).toContainEqual({ from: 0, to: 2 })
    // Editable control.
    expect(hiddenRanges(previewState(doc, 3))).toHaveLength(0)
  })
})

describe('read-only: links never reveal', () => {
  it('keeps the link chip with the cursor inside the syntax', () => {
    const doc = 'see [text](https://x.dev) end'
    const ro = readOnlyState(doc, 7) // inside the label
    expect(hiddenRanges(ro)).toContainEqual({ from: 4, to: 5 })
    expect(hiddenRanges(ro)).toContainEqual({ from: 9, to: 25 })
    expect(decorationsWithClass(ro, 'cm-ink-link')).toHaveLength(1)
    // Editable control: cursor inside reveals the full syntax.
    expect(decorationsWithClass(previewState(doc, 7), 'cm-ink-link')).toHaveLength(0)
  })

  it('keeps the autolink chip active with the cursor inside it', () => {
    const ro = readOnlyState('visit https://x.dev now', 10)
    const chips = decorationsTagged(ro, 'autolink')
    expect(chips).toHaveLength(1)
    expect(chips[0]!.deco.spec['attributes']['data-href']).toBe('https://x.dev')
  })

  it('keeps the wikilink chip with the cursor inside the brackets', () => {
    const doc = 'open [[Project Plan]] today'
    const ro = readOnlyState(doc, 10) // inside [[...]]
    const decos = wikiDecorations(ro)
    expect(decos.filter((d) => d.deco.spec['glyphdown'] === 'hide')).toHaveLength(2)
    expect(decos.filter((d) => d.deco.spec['glyphdown'] === 'wikilink')).toHaveLength(1)
    // Editable control: cursor inside reveals (no decorations at all).
    const editable = EditorState.create({
      doc,
      selection: EditorSelection.single(10),
      extensions: [glyphdownMarkdown(), livePreview(), wikiLinkField],
    }).update({ selection: EditorSelection.single(10) }).state
    expect(wikiDecorations(editable)).toHaveLength(0)
  })
})

describe('read-only: images stay inline-rendered', () => {
  const doc = 'pic\n\n![alt](a.png)\n\ntail'

  it('keeps the inline widget with the cursor on the image line (never the raw+block reveal)', () => {
    const ro = readOnlyState(doc, 8) // on the image line
    expect(decorationsTagged(ro, 'image')).toHaveLength(1)
    expect(decorationsTagged(ro, 'image-block')).toHaveLength(0)
  })

  it('editable control: the cursor on the line flips to raw source + block widget', () => {
    const editable = previewState(doc, 8)
    expect(decorationsTagged(editable, 'image')).toHaveLength(0)
    expect(decorationsTagged(editable, 'image-block')).toHaveLength(1)
  })
})

describe('read-only: blocks never reveal', () => {
  it('keeps the hr divider widget with the cursor on the rule line', () => {
    const doc = 'a\n\n---\n\nb'
    const ro = readOnlyState(doc, 4) // on the --- line
    expect(decorationsTagged(ro, 'hr')).toHaveLength(1)
    // Editable control: raw `---`, gray-styled.
    const editable = previewState(doc, 4)
    expect(decorationsTagged(editable, 'hr')).toHaveLength(0)
    expect(decorationsWithClass(editable, 'cm-ink-hr-mark')).toHaveLength(1)
  })

  it('keeps quote marks hidden with the cursor inside a blockquote', () => {
    const doc = 'before\n\n> quoted text'
    const ro = readOnlyState(doc, 12) // inside the quote line
    expect(hiddenRanges(ro)).toContainEqual({ from: 8, to: 10 }) // `> `
    // Editable control: the `>` shows, styled.
    expect(decorationsWithClass(previewState(doc, 12), 'cm-ink-quote-mark')).toHaveLength(1)
  })

  it('keeps the callout header widget with the cursor inside the callout', () => {
    const doc = 'before\n\n> [!note] Heads up\n> body text'
    const ro = readOnlyState(doc, 14) // inside the callout header
    expect(decorationsTagged(ro, 'callout-header')).toHaveLength(1)
    // Editable control: the raw blockquote syntax comes back.
    expect(decorationsTagged(previewState(doc, 14), 'callout-header')).toHaveLength(0)
  })

  it('keeps the footnote ref chip with the cursor inside the ref', () => {
    const doc = 'fact[^1] stated\n\n[^1]: the source'
    const ro = readOnlyState(doc, 6) // inside [^1]
    expect(decorationsTagged(ro, 'footnote-ref')).toHaveLength(1)
    expect(decorationsTagged(previewState(doc, 6), 'footnote-ref')).toHaveLength(0)
  })

  it('keeps task checkboxes and bullet glyphs with the cursor on their lines', () => {
    const doc = '- [ ] task here\n- bullet here'
    const onTask = readOnlyState(doc, 8)
    expect(decorationsTagged(onTask, 'checkbox')).toHaveLength(1)
    const onBullet = readOnlyState(doc, 20)
    expect(decorationsTagged(onBullet, 'bullet')).toHaveLength(1)
    // Editable controls: the caret line reveals its raw marker.
    expect(decorationsTagged(previewState(doc, 8), 'checkbox')).toHaveLength(0)
    expect(decorationsTagged(previewState(doc, 20), 'bullet')).toHaveLength(0)
  })
})

describe('read-only: tables stay rendered', () => {
  const doc = 'before\n\n| Name | N |\n| --- | --- |\n| ada | 36 |\n\nafter'
  const inTable = doc.indexOf('ada')

  it('keeps the table widget with the selection inside the table source', () => {
    const ro = readOnlyState(doc, inTable)
    expect(decorationsTagged(ro, 'table')).toHaveLength(1)
    expect(decorationsWithClass(ro, 'cm-ink-table')).toHaveLength(0)
    // Editable control: the raw monospace source flips in.
    const editable = previewState(doc, inTable)
    expect(decorationsTagged(editable, 'table')).toHaveLength(0)
    expect(decorationsWithClass(editable, 'cm-ink-table')).toHaveLength(3)
  })

  it('keeps the table widget under a drag-selection spanning the whole table', () => {
    const ro = readOnlyState(doc, 0, doc.length)
    expect(decorationsTagged(ro, 'table')).toHaveLength(1)
  })
})

describe('read-only: math never reveals', () => {
  it('keeps the inline math widget with the cursor inside the TeX', () => {
    const doc = 'a $x^2$ b'
    const ro = readOnlyState(doc, 4)
    expect(mathDecorations(ro).filter((d) => d.deco.spec['glyphdown'] === 'math')).toHaveLength(1)
    // Editable control: tinted raw source.
    const editable = previewState(doc, 4)
    expect(mathDecorations(editable).filter((d) => d.deco.spec['glyphdown'] === 'math')).toHaveLength(0)
    expect(
      mathDecorations(editable).filter((d) => d.deco.spec['class'] === 'cm-ink-math-src'),
    ).toHaveLength(1)
  })

  it('keeps the block math widget with the cursor inside the block', () => {
    const doc = 'text\n\n$$\nE=mc^2\n$$\n\ntail'
    const inside = doc.indexOf('E=mc^2') + 2
    const ro = readOnlyState(doc, inside)
    expect(mathDecorations(ro).filter((d) => d.deco.spec['glyphdown'] === 'math-block')).toHaveLength(1)
    const editable = previewState(doc, inside)
    expect(mathDecorations(editable).filter((d) => d.deco.spec['glyphdown'] === 'math-block')).toHaveLength(0)
  })
})

describe('read-only: selection movement is rendering-inert', () => {
  it('drag-select and select-all leave the decorations identical to a resting cursor', () => {
    const doc = '# T\n\n**b** *i* [l](https://x.dev) `c`\n\n- [ ] task\n\n> quote'
    const resting = readOnlyState(doc, 0)
    const restingHidden = hiddenRanges(resting)
    expect(restingHidden.length).toBeGreaterThan(0)
    // Drag across the formatted paragraph.
    const drag = readOnlyState(doc, 6, 30)
    expect(hiddenRanges(drag)).toEqual(restingHidden)
    // Select-all.
    const all = readOnlyState(doc, 0, doc.length)
    expect(hiddenRanges(all)).toEqual(restingHidden)
  })
})

describe('read-only: runtime compartment flips', () => {
  function compartmentState(doc: string, pos: number): { comp: Compartment; state: EditorState } {
    const comp = new Compartment()
    const extensions: Extension = [
      glyphdownMarkdown(),
      livePreview(),
      wikiLinkField,
      comp.of(EditorState.readOnly.of(true)),
    ]
    const state = EditorState.create({ doc, selection: EditorSelection.single(pos), extensions })
      // Force one recompute so the fields reflect the fully parsed tree.
      .update({ selection: EditorSelection.single(pos) }).state
    return { comp, state }
  }

  it('reconfiguring readOnly off reveals at the unchanged cursor; back on re-hides (live preview)', () => {
    const doc = 'intro\n\n**bold** here'
    const { comp, state } = compartmentState(doc, 10) // cursor inside **bold**
    expect(hiddenRanges(state)).toContainEqual({ from: 7, to: 9 })
    // Flip to editable WITHOUT any doc/selection change: the reveal must
    // recompute off tr.reconfigured alone.
    const editable = state.update({ effects: comp.reconfigure(EditorState.readOnly.of(false)) }).state
    expect(hiddenRanges(editable).filter((r) => r.from >= 7 && r.to <= 15)).toHaveLength(0)
    // And back: the viewer rendering returns.
    const back = editable.update({ effects: comp.reconfigure(EditorState.readOnly.of(true)) }).state
    expect(hiddenRanges(back)).toContainEqual({ from: 7, to: 9 })
  })

  it('the wikilink field follows the same flip', () => {
    const { comp, state } = compartmentState('open [[Project Plan]] now', 10)
    expect(wikiDecorations(state).filter((d) => d.deco.spec['glyphdown'] === 'wikilink')).toHaveLength(1)
    const editable = state.update({ effects: comp.reconfigure(EditorState.readOnly.of(false)) }).state
    expect(wikiDecorations(editable)).toHaveLength(0)
    const back = editable.update({ effects: comp.reconfigure(EditorState.readOnly.of(true)) }).state
    expect(wikiDecorations(back).filter((d) => d.deco.spec['glyphdown'] === 'wikilink')).toHaveLength(1)
  })

  it('the math field follows the same flip', () => {
    const { comp, state } = compartmentState('a $x^2$ b', 4)
    expect(mathDecorations(state).filter((d) => d.deco.spec['glyphdown'] === 'math')).toHaveLength(1)
    const editable = state.update({ effects: comp.reconfigure(EditorState.readOnly.of(false)) }).state
    expect(mathDecorations(editable).filter((d) => d.deco.spec['glyphdown'] === 'math')).toHaveLength(0)
    const back = editable.update({ effects: comp.reconfigure(EditorState.readOnly.of(true)) }).state
    expect(mathDecorations(back).filter((d) => d.deco.spec['glyphdown'] === 'math')).toHaveLength(1)
  })
})
