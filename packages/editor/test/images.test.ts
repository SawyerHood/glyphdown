// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { EditorSelection, EditorState } from '@codemirror/state'
import type { WidgetType } from '@codemirror/view'
import { imageResolver, glyphdownMarkdown, livePreview, parseImageSize, resolveImageSrc } from '../src/index.ts'
import { decorationsTagged } from './helpers.ts'

const assetResolver = (src: string) => `/api/docs/doc-1/assets/${encodeURIComponent(src)}`

function stateWithResolver(doc: string, anchor = 0): EditorState {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.single(anchor),
    extensions: [glyphdownMarkdown(), livePreview(), imageResolver.of(assetResolver)],
  })
  return state.update({ selection: EditorSelection.single(anchor) }).state
}

interface ImageWidgetLike extends WidgetType {
  alt: string
  src: string
  original: string
  block: boolean
  width: number | null
  height: number | null
}

function imageWidget(state: EditorState): ImageWidgetLike {
  const widgets = decorationsTagged(state, 'image')
  expect(widgets).toHaveLength(1)
  return widgets[0]!.deco.spec['widget'] as ImageWidgetLike
}

function blockWidgets(state: EditorState) {
  return decorationsTagged(state, 'image-block')
}

describe('resolveImageSrc', () => {
  const resolve = (s: string) => `R(${s})`

  it('routes relative srcs through the resolver', () => {
    expect(resolveImageSrc('pic.png', resolve)).toBe('R(pic.png)')
    expect(resolveImageSrc('sub-dir-name.png', resolve)).toBe('R(sub-dir-name.png)')
  })

  it('passes absolute http(s) and data URLs through untouched', () => {
    expect(resolveImageSrc('https://x.dev/a.png', resolve)).toBe('https://x.dev/a.png')
    expect(resolveImageSrc('http://x.dev/a.png', resolve)).toBe('http://x.dev/a.png')
    expect(resolveImageSrc('data:image/png;base64,AAAA', resolve)).toBe('data:image/png;base64,AAAA')
    expect(resolveImageSrc('blob:https://x.dev/123', resolve)).toBe('blob:https://x.dev/123')
  })

  it('passes root-relative paths and empty srcs through untouched', () => {
    expect(resolveImageSrc('/static/a.png', resolve)).toBe('/static/a.png')
    expect(resolveImageSrc('', resolve)).toBe('')
  })
})

describe('imageResolver facet through the live-preview field', () => {
  it('resolves a relative src into the widget', () => {
    const state = stateWithResolver('intro\n\n![alt text](diagram.png)\n\nafter', 0)
    const widget = imageWidget(state)
    expect(widget.src).toBe('/api/docs/doc-1/assets/diagram.png')
    expect(widget.original).toBe('diagram.png')
    expect(widget.alt).toBe('alt text')
  })

  it('leaves absolute srcs untouched', () => {
    const state = stateWithResolver('intro\n\n![a](https://x.dev/p.png)\n\nafter', 0)
    expect(imageWidget(state).src).toBe('https://x.dev/p.png')
  })

  it('defaults to the identity resolver without the facet', () => {
    const state = EditorState.create({
      doc: 'intro\n\n![a](pic.png)\n\nafter',
      selection: EditorSelection.single(0),
      extensions: [glyphdownMarkdown(), livePreview()],
    }).update({ selection: EditorSelection.single(0) }).state
    expect(imageWidget(state).src).toBe('pic.png')
  })
})

describe('image widget rendering (jsdom)', () => {
  it('renders an <img> with lazy loading, alt text, and the resolved src', () => {
    const state = stateWithResolver('intro\n\n![alt text](diagram.png)\n\nafter', 0)
    const dom = imageWidget(state).toDOM(null as never)
    const img = dom.querySelector('img')!
    expect(img).toBeTruthy()
    expect(img.getAttribute('src')).toBe('/api/docs/doc-1/assets/diagram.png')
    expect(img.getAttribute('alt')).toBe('alt text')
    expect(img.getAttribute('loading')).toBe('lazy')
    expect(img.className).toBe('cm-ink-image-img')
  })

  it('swaps to a subtle placeholder showing the filename when the image breaks', () => {
    const state = stateWithResolver('intro\n\n![alt](missing.png)\n\nafter', 0)
    const dom = imageWidget(state).toDOM(null as never)
    const img = dom.querySelector('img')!
    img.dispatchEvent(new Event('error'))
    expect(dom.querySelector('img')).toBeNull()
    const fallback = dom.querySelector('.cm-ink-image-placeholder')!
    expect(fallback).toBeTruthy()
    expect(fallback.textContent).toContain('missing.png')
  })

  it('renders the placeholder directly when no URL is written yet', () => {
    const state = stateWithResolver('intro\n\n![alt]()\n\nafter', 0)
    const dom = imageWidget(state).toDOM(null as never)
    expect(dom.querySelector('img')).toBeNull()
    expect(dom.querySelector('.cm-ink-image-placeholder')!.textContent).toContain('alt')
  })
})

describe('Obsidian-style reveal (cursor on the image line)', () => {
  // 'intro\n\n![alt](pic.png)\n\nafter' — image node spans 7..22, line end 22.
  const DOC = 'intro\n\n![alt](pic.png)\n\nafter'

  it('cursor outside the line: inline render, syntax hidden, no block widget', () => {
    const state = stateWithResolver(DOC, 0)
    const inline = decorationsTagged(state, 'image')
    expect(inline).toHaveLength(1)
    expect(inline[0]).toMatchObject({ from: 7, to: 22 }) // replace covers the whole syntax
    expect(blockWidgets(state)).toHaveLength(0)
  })

  it('cursor on the line: raw text stays visible and a block widget hangs below', () => {
    const state = stateWithResolver(DOC, 10)
    expect(decorationsTagged(state, 'image')).toHaveLength(0) // no replace → raw syntax visible
    const blocks = blockWidgets(state)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ from: 22, to: 22 }) // anchored at the line end
    const spec = blocks[0]!.deco.spec
    expect(spec['block']).toBe(true)
    expect(spec['side']).toBe(1) // after the line → caret position stays stable
    const widget = spec['widget'] as ImageWidgetLike
    expect(widget.block).toBe(true)
    expect(widget.src).toBe('/api/docs/doc-1/assets/pic.png')
    expect(widget.alt).toBe('alt')
    expect(widget.original).toBe('pic.png')
  })

  it('two images on one line: one block widget each, in document order', () => {
    // line 3 spans 5..36; both widgets anchor at the line end (36).
    const state = stateWithResolver('pre\n\n![a](one.png) and ![b](two.png)\n\npost', 6)
    expect(decorationsTagged(state, 'image')).toHaveLength(0)
    const blocks = blockWidgets(state)
    expect(blocks).toHaveLength(2)
    expect(blocks.map((b) => b.from)).toEqual([36, 36])
    expect(blocks.map((b) => (b.deco.spec['widget'] as ImageWidgetLike).src)).toEqual([
      '/api/docs/doc-1/assets/one.png',
      '/api/docs/doc-1/assets/two.png',
    ])
  })

  it('moving the cursor away restores inline mode', () => {
    const revealed = stateWithResolver(DOC, 10)
    expect(blockWidgets(revealed)).toHaveLength(1)
    const away = revealed.update({ selection: EditorSelection.single(0) }).state
    expect(blockWidgets(away)).toHaveLength(0)
    const inline = decorationsTagged(away, 'image')
    expect(inline).toHaveLength(1)
    expect((inline[0]!.deco.spec['widget'] as ImageWidgetLike).src).toBe('/api/docs/doc-1/assets/pic.png')
  })

  it('block widget renders the same <img> path: block wrapper, lazy, resolved src', () => {
    const state = stateWithResolver(DOC, 10)
    const widget = blockWidgets(state)[0]!.deco.spec['widget'] as ImageWidgetLike
    const dom = widget.toDOM(null as never)
    expect(dom.tagName).toBe('DIV')
    expect(dom.className).toBe('cm-ink-image cm-ink-image-block')
    const img = dom.querySelector('img')!
    expect(img.getAttribute('src')).toBe('/api/docs/doc-1/assets/pic.png')
    expect(img.getAttribute('alt')).toBe('alt')
    expect(img.getAttribute('loading')).toBe('lazy')
    expect(img.className).toBe('cm-ink-image-img')
  })

  it('block widget swaps to the broken-image placeholder on error', () => {
    const state = stateWithResolver('intro\n\n![alt](missing.png)\n\nafter', 10)
    const widget = blockWidgets(state)[0]!.deco.spec['widget'] as ImageWidgetLike
    const dom = widget.toDOM(null as never)
    dom.querySelector('img')!.dispatchEvent(new Event('error'))
    expect(dom.querySelector('img')).toBeNull()
    expect(dom.querySelector('.cm-ink-image-placeholder')!.textContent).toContain('missing.png')
  })
})

describe('parseImageSize (Obsidian alt-text pipe syntax)', () => {
  it('parses a width-only suffix', () => {
    expect(parseImageSize('alt|300')).toEqual({ alt: 'alt', width: 300, height: null })
  })

  it('parses width x height', () => {
    expect(parseImageSize('alt|300x200')).toEqual({ alt: 'alt', width: 300, height: 200 })
  })

  it('uses the segment after the LAST pipe (alt may contain pipes)', () => {
    expect(parseImageSize('a|b|250')).toEqual({ alt: 'a|b', width: 250, height: null })
  })

  it('handles an empty alt with a size', () => {
    expect(parseImageSize('|120')).toEqual({ alt: '', width: 120, height: null })
  })

  it('leaves non-size suffixes alone', () => {
    expect(parseImageSize('alt|wide')).toEqual({ alt: 'alt|wide', width: null, height: null })
    expect(parseImageSize('alt|300x')).toEqual({ alt: 'alt|300x', width: null, height: null })
    expect(parseImageSize('alt|0')).toEqual({ alt: 'alt|0', width: null, height: null })
    expect(parseImageSize('plain alt')).toEqual({ alt: 'plain alt', width: null, height: null })
  })
})

describe('image sizing through the widget', () => {
  it('inline mode: |300 sets the width and strips the suffix from the alt', () => {
    const state = stateWithResolver('intro\n\n![diagram|300](diagram.png)\n\nafter', 0)
    const widget = imageWidget(state)
    expect(widget.alt).toBe('diagram')
    expect(widget.width).toBe(300)
    expect(widget.height).toBeNull()
    const dom = widget.toDOM(null as never)
    const img = dom.querySelector('img')!
    expect(img.getAttribute('width')).toBe('300')
    expect(img.hasAttribute('height')).toBe(false)
    expect(img.getAttribute('alt')).toBe('diagram')
  })

  it('inline mode: |300x200 sets width and height', () => {
    const state = stateWithResolver('intro\n\n![diagram|300x200](diagram.png)\n\nafter', 0)
    const widget = imageWidget(state)
    expect(widget.width).toBe(300)
    expect(widget.height).toBe(200)
    const img = widget.toDOM(null as never).querySelector('img')!
    expect(img.getAttribute('width')).toBe('300')
    expect(img.getAttribute('height')).toBe('200')
  })

  it('cursor-reveal block mode carries the same size', () => {
    const state = stateWithResolver('intro\n\n![diagram|300](diagram.png)\n\nafter', 10)
    const blocks = blockWidgets(state)
    expect(blocks).toHaveLength(1)
    const widget = blocks[0]!.deco.spec['widget'] as ImageWidgetLike
    expect(widget.block).toBe(true)
    expect(widget.alt).toBe('diagram')
    expect(widget.width).toBe(300)
    const img = widget.toDOM(null as never).querySelector('img')!
    expect(img.getAttribute('width')).toBe('300')
  })

  it('strips the size suffix from the no-URL placeholder label too', () => {
    const state = stateWithResolver('intro\n\n![pic|300]()\n\nafter', 0)
    const dom = imageWidget(state).toDOM(null as never)
    const placeholder = dom.querySelector('.cm-ink-image-placeholder')!
    expect(placeholder.textContent).toContain('pic')
    expect(placeholder.textContent).not.toContain('300')
  })

  it('unsized images keep width/height unset', () => {
    const state = stateWithResolver('intro\n\n![alt](pic.png)\n\nafter', 0)
    const widget = imageWidget(state)
    expect(widget.width).toBeNull()
    expect(widget.height).toBeNull()
    const img = widget.toDOM(null as never).querySelector('img')!
    expect(img.hasAttribute('width')).toBe(false)
    expect(img.hasAttribute('height')).toBe(false)
  })
})
