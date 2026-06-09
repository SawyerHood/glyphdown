// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView, type WidgetType } from '@codemirror/view'
import {
  CALLOUT_ALIASES,
  CALLOUT_COLORS,
  CALLOUT_ICONS,
  canonicalCalloutType,
  fallbackCalloutTitle,
  glyphdownHighlighting,
  glyphdownMarkdown,
  glyphdownTheme,
  livePreview,
} from '../src/index.ts'
import { decorationsTagged, decorationsWithClass, hiddenRanges, previewState } from './helpers.ts'

beforeAll(() => {
  // jsdom lacks layout APIs CodeMirror's measure cycle expects (the
  // render-dom.test.ts patches).
  Range.prototype.getClientRects = function () {
    return { length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] } as unknown as DOMRectList
  }
  Range.prototype.getBoundingClientRect = () =>
    ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
  if (typeof globalThis.requestAnimationFrame !== 'function') {
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
      setTimeout(() => cb(Date.now()), 0)) as typeof requestAnimationFrame
  }
})

function mountView(doc: string, anchor = 0): EditorView {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  return new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.single(anchor),
      extensions: [glyphdownMarkdown(), glyphdownHighlighting(), glyphdownTheme, livePreview()],
    }),
    parent,
  })
}

describe('callout type mapping', () => {
  it('maps every Obsidian alias to its canonical type', () => {
    expect(canonicalCalloutType('note')).toBe('note')
    expect(canonicalCalloutType('abstract')).toBe('abstract')
    expect(canonicalCalloutType('summary')).toBe('abstract')
    expect(canonicalCalloutType('tldr')).toBe('abstract')
    expect(canonicalCalloutType('info')).toBe('info')
    expect(canonicalCalloutType('todo')).toBe('todo')
    expect(canonicalCalloutType('tip')).toBe('tip')
    expect(canonicalCalloutType('hint')).toBe('tip')
    expect(canonicalCalloutType('important')).toBe('tip')
    expect(canonicalCalloutType('success')).toBe('success')
    expect(canonicalCalloutType('check')).toBe('success')
    expect(canonicalCalloutType('done')).toBe('success')
    expect(canonicalCalloutType('question')).toBe('question')
    expect(canonicalCalloutType('help')).toBe('question')
    expect(canonicalCalloutType('faq')).toBe('question')
    expect(canonicalCalloutType('warning')).toBe('warning')
    expect(canonicalCalloutType('caution')).toBe('warning')
    expect(canonicalCalloutType('attention')).toBe('warning')
    expect(canonicalCalloutType('failure')).toBe('failure')
    expect(canonicalCalloutType('fail')).toBe('failure')
    expect(canonicalCalloutType('missing')).toBe('failure')
    expect(canonicalCalloutType('danger')).toBe('danger')
    expect(canonicalCalloutType('error')).toBe('danger')
    expect(canonicalCalloutType('bug')).toBe('bug')
    expect(canonicalCalloutType('example')).toBe('example')
    expect(canonicalCalloutType('quote')).toBe('quote')
    expect(canonicalCalloutType('cite')).toBe('quote')
  })

  it('is case-insensitive and falls back to note for unknown types', () => {
    expect(canonicalCalloutType('WARNING')).toBe('warning')
    expect(canonicalCalloutType('Note')).toBe('note')
    expect(canonicalCalloutType('whatever')).toBe('note')
  })

  it('every canonical type has an icon and a color', () => {
    for (const canonical of new Set(Object.values(CALLOUT_ALIASES))) {
      expect(CALLOUT_ICONS[canonical], canonical).toMatch(/^<svg /)
      expect(CALLOUT_COLORS[canonical], canonical).toMatch(/^#/)
    }
  })

  it('capitalizes the written type as the fallback title', () => {
    expect(fallbackCalloutTitle('note')).toBe('Note')
    expect(fallbackCalloutTitle('FAQ')).toBe('Faq')
    expect(fallbackCalloutTitle('tip')).toBe('Tip')
  })
})

describe('callout rendering (caret outside)', () => {
  it('hides the marker, marks the title, and tints every blockquote line', () => {
    const doc = '> [!note] Custom Title\n> body line\n\npara'
    const state = previewState(doc, doc.length)
    // The `[!note] ` marker (incl. its trailing space) becomes the header widget.
    const headers = decorationsTagged(state, 'callout-header')
    expect(headers).toHaveLength(1)
    expect(headers[0]).toMatchObject({ from: 2, to: 10 })
    // The written title carries the type-colored mark.
    const titles = decorationsWithClass(state, 'cm-ink-callout-title')
    expect(titles).toHaveLength(1)
    expect(titles[0]).toMatchObject({ from: 10, to: 22 })
    // Every line of the blockquote is tinted with the per-type class…
    const lines = decorationsWithClass(state, 'cm-ink-callout-note')
    expect(lines.map((l) => l.from)).toEqual([0, 23])
    // …instead of the generic blockquote styling.
    expect(decorationsWithClass(state, 'cm-ink-blockquote')).toHaveLength(0)
    // The quote marks still hide (caret is outside every line).
    expect(hiddenRanges(state)).toContainEqual({ from: 0, to: 2 })
  })

  it('falls back to the capitalized type when no title is written', () => {
    const doc = '> [!tip]\n> body\n\npara'
    const state = previewState(doc, doc.length)
    const headers = decorationsTagged(state, 'callout-header')
    expect(headers).toHaveLength(1)
    expect(headers[0]).toMatchObject({ from: 2, to: 8 }) // the whole `[!tip]`
    const widget = headers[0]!.deco.spec['widget'] as { canonical: string; fallbackTitle: string | null }
    expect(widget.canonical).toBe('tip')
    expect(widget.fallbackTitle).toBe('Tip')
    expect(decorationsWithClass(state, 'cm-ink-callout-title')).toHaveLength(0)
  })

  it('keeps the written title out of the widget when one exists', () => {
    const doc = '> [!tip] Pro move\n\npara'
    const state = previewState(doc, doc.length)
    const widget = decorationsTagged(state, 'callout-header')[0]!.deco.spec['widget'] as {
      fallbackTitle: string | null
    }
    expect(widget.fallbackTitle).toBeNull()
  })

  it('applies the canonical line class for aliases', () => {
    const doc = '> [!hint] Aliased\n\npara'
    const state = previewState(doc, doc.length)
    expect(decorationsWithClass(state, 'cm-ink-callout-tip')).toHaveLength(1)
    expect(decorationsWithClass(state, 'cm-ink-callout-hint')).toHaveLength(0)
  })

  it('styles unknown types as note, titled with the written type', () => {
    const doc = '> [!custom]\n\npara'
    const state = previewState(doc, doc.length)
    expect(decorationsWithClass(state, 'cm-ink-callout-note')).toHaveLength(1)
    const widget = decorationsTagged(state, 'callout-header')[0]!.deco.spec['widget'] as {
      canonical: string
      fallbackTitle: string | null
    }
    expect(widget.canonical).toBe('note')
    expect(widget.fallbackTitle).toBe('Custom')
  })

  it('renders [!type]- and [!type]+ fold markers the same as [!type] (flat v1)', () => {
    for (const fold of ['-', '+']) {
      const doc = `> [!note]${fold} Folded\n> body\n\npara`
      const state = previewState(doc, doc.length)
      const headers = decorationsTagged(state, 'callout-header')
      expect(headers, fold).toHaveLength(1)
      // Marker, fold char, and the space all fold into the widget.
      expect(headers[0], fold).toMatchObject({ from: 2, to: 11 })
      const titles = decorationsWithClass(state, 'cm-ink-callout-title')
      expect(titles, fold).toHaveLength(1)
      expect(titles[0], fold).toMatchObject({ from: 11, to: 17 })
    }
  })

  it('does not treat a blockquote with [!type] mid-text as a callout', () => {
    const doc = '> see [!note] inline\n\npara'
    const state = previewState(doc, doc.length)
    expect(decorationsTagged(state, 'callout-header')).toHaveLength(0)
    expect(decorationsWithClass(state, 'cm-ink-blockquote')).toHaveLength(1)
  })

  it('does not treat [!type]text (no separating space) as a callout', () => {
    const doc = '> [!note]text\n\npara'
    const state = previewState(doc, doc.length)
    expect(decorationsTagged(state, 'callout-header')).toHaveLength(0)
    expect(decorationsWithClass(state, 'cm-ink-blockquote')).toHaveLength(1)
  })

  it('still renders the body inline formatting inside a callout', () => {
    const doc = '> [!note] T\n> has **bold** text\n\npara'
    const state = previewState(doc, doc.length)
    const boldStart = doc.indexOf('**')
    expect(hiddenRanges(state)).toContainEqual({ from: boldStart, to: boldStart + 2 })
  })
})

describe('callout reveal (caret inside)', () => {
  it('shows the raw syntax with standard blockquote styling', () => {
    const doc = '> [!warning] Heads up\n> body\n\npara'
    const state = previewState(doc, 4) // caret inside the marker
    expect(decorationsTagged(state, 'callout-header')).toHaveLength(0)
    expect(decorationsWithClass(state, 'cm-ink-callout-warning')).toHaveLength(0)
    expect(decorationsWithClass(state, 'cm-ink-callout-title')).toHaveLength(0)
    expect(decorationsWithClass(state, 'cm-ink-blockquote')).toHaveLength(2)
  })

  it('reveals when the caret is on any line of the callout, not just the header', () => {
    const doc = '> [!warning] Heads up\n> body\n\npara'
    const state = previewState(doc, 25) // caret inside "body"
    expect(decorationsTagged(state, 'callout-header')).toHaveLength(0)
    expect(decorationsWithClass(state, 'cm-ink-blockquote')).toHaveLength(2)
  })

  it('round-trips between rendered and raw as the selection moves', () => {
    const doc = '> [!info] Title\n\npara'
    const rendered = previewState(doc, doc.length)
    expect(decorationsTagged(rendered, 'callout-header')).toHaveLength(1)
    const revealed = rendered.update({ selection: EditorSelection.single(3) }).state
    expect(decorationsTagged(revealed, 'callout-header')).toHaveLength(0)
    const back = revealed.update({ selection: EditorSelection.single(doc.length) }).state
    expect(decorationsTagged(back, 'callout-header')).toHaveLength(1)
  })
})

describe('callout widget DOM (jsdom)', () => {
  it('renders the icon and the fallback title', () => {
    const state = previewState('> [!danger]\n\npara', 15)
    const widget = decorationsTagged(state, 'callout-header')[0]!.deco.spec['widget'] as WidgetType
    const dom = widget.toDOM(null as never)
    expect(dom.className).toBe('cm-ink-callout-header')
    const icon = dom.querySelector('.cm-ink-callout-icon svg')
    expect(icon).toBeTruthy()
    expect(dom.querySelector('.cm-ink-callout-title')!.textContent).toBe('Danger')
    // ignoreEvent false → a click places the caret (revealing the syntax).
    expect(widget.ignoreEvent(new MouseEvent('mousedown'))).toBe(false)
  })

  it('renders per-type icons', () => {
    const dangerState = previewState('> [!danger]\n\npara', 15)
    const noteState = previewState('> [!note]\n\npara', 13)
    const danger = (
      decorationsTagged(dangerState, 'callout-header')[0]!.deco.spec['widget'] as WidgetType
    ).toDOM(null as never)
    const note = (decorationsTagged(noteState, 'callout-header')[0]!.deco.spec['widget'] as WidgetType).toDOM(
      null as never,
    )
    expect(danger.querySelector('.cm-ink-callout-icon')!.innerHTML).not.toBe(
      note.querySelector('.cm-ink-callout-icon')!.innerHTML,
    )
  })

  it('mounted view: title row renders, raw marker text is gone, caret entry reveals it', () => {
    const doc = '> [!success] Shipped\n> details\n\npara'
    const view = mountView(doc, doc.length)
    try {
      expect(view.dom.querySelectorAll('.cm-ink-callout-header')).toHaveLength(1)
      expect(view.dom.textContent).not.toContain('[!success]')
      expect(view.dom.textContent).toContain('Shipped')
      view.dispatch({ selection: EditorSelection.single(3) })
      expect(view.dom.querySelectorAll('.cm-ink-callout-header')).toHaveLength(0)
      expect(view.dom.textContent).toContain('[!success]')
    } finally {
      view.destroy()
    }
  })
})
