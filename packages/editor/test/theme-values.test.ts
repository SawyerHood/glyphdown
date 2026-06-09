// @vitest-environment jsdom
//
// Pins the bb-inspired typography/color values to their concrete post-polish
// numbers and tokens. These assertions are intentionally exact (not "is set" /
// "is truthy") so a future tweak to a size, margin, or color trips the test.
//
// Two reads are used:
//  - glyphdownHighlightStyle.module.getRules(): the generated CSS for the
//    inline syntax-highlight spans (heading sizes, link/url/quote colors).
//  - getComputedStyle on a mounted view: the cascaded values the baseTheme +
//    glyphdownTheme rules resolve to on real elements (inline-code, hr,
//    headings, blockquote). jsdom resolves stylesheet cascade for computed
//    style even without layout.
import { beforeAll, describe, expect, it } from 'vitest'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { glyphdownHighlightStyle, glyphdownHighlighting, glyphdownMarkdown, glyphdownTheme, livePreview } from '../src/index.ts'

beforeAll(() => {
  // jsdom lacks the layout APIs CodeMirror's measure cycle calls (matches the
  // render-dom.test.ts patch). Computed-style cascade still works.
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

const highlightRules = (): string => {
  const module = (glyphdownHighlightStyle as unknown as { module: { getRules(): string } }).module
  return module.getRules()
}

describe('heading inline-span sizes (HighlightStyle source of truth)', () => {
  const rules = highlightRules()

  it('compresses the top: h1 is 1.6em, h2 is 1.35em', () => {
    expect(rules).toContain('font-size: 1.6em; font-weight: 700;')
    expect(rules).toContain('font-size: 1.35em; font-weight: 700;')
    // The pre-polish sizes are gone.
    expect(rules).not.toContain('font-size: 1.9em')
    expect(rules).not.toContain('font-size: 1.5em')
  })

  it('leaves h3–h6 sizes and weights untouched', () => {
    expect(rules).toContain('font-size: 1.25em; font-weight: 600;') // h3
    expect(rules).toContain('font-size: 1.08em; font-weight: 700;') // h4
    expect(rules).toContain('font-size: 0.95em; font-weight: 700; color: var(--ink-heading-muted, #5f6b7a);') // h5
    expect(rules).toContain('font-size: 0.84em; font-weight: 700; color: var(--ink-heading-muted, #5f6b7a);') // h6
  })
})

describe('token + accent consolidation (HighlightStyle colors)', () => {
  const rules = highlightRules()

  it('routes link to the accent token (light fallback unchanged)', () => {
    expect(rules).toContain('color: var(--accent, #2563eb);')
  })

  it('routes url / separator / syntax-mark grays to --ink-faint', () => {
    expect(rules).toContain('color: var(--ink-faint, #8b95a3);') // url
    expect(rules).toContain('color: var(--ink-faint, #9ca3af);') // contentSeparator
    expect(rules).toContain('color: var(--ink-faint, #9aa3af);') // processingInstruction
  })

  it('routes quote ink to --ink-block-muted', () => {
    expect(rules).toContain('color: var(--ink-block-muted, #5f6b7a);')
  })

  it('keeps no bare-hex link/gray colors in the highlight rules', () => {
    expect(rules).not.toMatch(/color: #2563eb/)
    expect(rules).not.toMatch(/color: #8b95a3/)
    expect(rules).not.toMatch(/color: #9ca3af/)
    expect(rules).not.toMatch(/color: #9aa3af/)
  })
})

describe('live-preview computed values (baseTheme cascade)', () => {
  it('inline code is 0.85em with no vertical padding (the inline-code gate)', () => {
    const view = mountView('a `code` b', 0)
    try {
      const el = view.dom.querySelector('.cm-ink-inline-code') as HTMLElement
      expect(el).toBeTruthy()
      const cs = getComputedStyle(el)
      expect(cs.fontSize).toBe('0.85em')
      expect(cs.paddingTop).toBe('0px')
      expect(cs.paddingBottom).toBe('0px')
    } finally {
      view.destroy()
    }
  })

  it('hr vertical rhythm is PADDING 1.1em (not margin) and ink routes to --ink-faint', () => {
    // The 1.1em breathing room must be PADDING, not margin: CM6's line-height
    // model excludes margin from a line block but includes padding, so a
    // vertical margin here desyncs posAtCoords/coordsAtPos and drifts the caret
    // on click (the click-position regression). Guard: padding carries it and
    // no vertical margin remains.
    const view = mountView('a\n\n---\n\nb', 0)
    try {
      const hr = view.dom.querySelector('.cm-ink-hr') as HTMLElement
      expect(hr).toBeTruthy()
      const cs = getComputedStyle(hr)
      expect(cs.paddingTop).toBe('1.1em')
      expect(cs.paddingBottom).toBe('1.1em')
      // No vertical margin authored (jsdom returns '' for an undeclared margin).
      expect(cs.marginTop).not.toMatch(/em|px/)
      expect(cs.marginBottom).not.toMatch(/em|px/)
      expect(cs.color).toContain('var(--ink-faint')
    } finally {
      view.destroy()
    }
  })

  it('blockquote line is italic with muted ink (computed), token border (rule text)', () => {
    const view = mountView('> a quote\n\nbody', 0)
    try {
      const bq = view.dom.querySelector('.cm-ink-blockquote') as HTMLElement
      expect(bq).toBeTruthy()
      const cs = getComputedStyle(bq)
      expect(cs.fontStyle).toBe('italic')
      expect(cs.color).toContain('var(--ink-block-muted')
      // jsdom won't split the `border-left` shorthand carrying a var(), so read
      // the injected stylesheet text for the token border.
      const css = Array.from(document.querySelectorAll('style'))
        .map((s) => s.textContent ?? '')
        .join('\n')
      expect(css).toContain('border-left: 3px solid var(--ink-block-border, #cbd5e1)')
    } finally {
      view.destroy()
    }
  })

  it('link / quote-mark / list-mark colors route through tokens', () => {
    const view = mountView('> q\n\n- item\n\n[x](http://e.dev)', 0)
    try {
      const link = view.dom.querySelector('.cm-ink-link') as HTMLElement
      expect(getComputedStyle(link).color).toContain('var(--accent')
    } finally {
      view.destroy()
    }
  })
})

describe('body ink softens while heading ink stays dark (reflow-safe color routing)', () => {
  it('cm-content body ink routes to --ink (soft-charcoal fallback)', () => {
    const view = mountView('plain body text', 0)
    try {
      const content = view.dom.querySelector('.cm-content') as HTMLElement
      expect(getComputedStyle(content).color).toContain('var(--ink, #33373d)')
    } finally {
      view.destroy()
    }
  })

  it('heading line carries its own (dark) --ink-heading color, not body ink', () => {
    const view = mountView('intro\n\n## Section\n\nbody', 0)
    try {
      const h = view.dom.querySelector('.cm-ink-heading') as HTMLElement
      expect(h).toBeTruthy()
      expect(getComputedStyle(h).color).toContain('var(--ink-heading, #1c2733)')
    } finally {
      view.destroy()
    }
  })
})

describe('heading reveal is reflow-stable (no vertical shift on caret entry)', () => {
  // Structural gate: the size/line-height/padding all live on the always-present
  // .cm-ink-hN line class; only the `#` markers hide/show. We assert the line
  // class AND its size-bearing computed properties are byte-identical with the
  // caret off vs on the heading — so caret reveal cannot change the box height.
  for (const [label, doc, off, on] of [
    ['h1', 'intro\n\n# Title\n\nbody', 0, 9],
    ['h2', 'intro\n\n## Section\n\nbody', 0, 9],
  ] as const) {
    it(`${label}: line class + line-height + spacing identical caret-off vs caret-on`, () => {
      const view = mountView(doc, off)
      try {
        const read = () => {
          const el = view.dom.querySelector(`.cm-ink-${label}`) as HTMLElement
          expect(el).toBeTruthy()
          const cs = getComputedStyle(el)
          return {
            cls: el.className,
            lineHeight: cs.lineHeight,
            // The rhythm space is padding (not margin) — read both axes of both
            // so a future flip back to margin (which would reintroduce click
            // drift) still trips the byte-identical compare below.
            paddingTop: cs.paddingTop,
            paddingBottom: cs.paddingBottom,
            marginTop: cs.marginTop,
            marginBottom: cs.marginBottom,
            letterSpacing: cs.letterSpacing,
          }
        }
        // Caret off the heading: marker hidden.
        const resting = read()
        expect(view.dom.textContent).not.toContain('#')
        // Caret onto the heading line: marker revealed.
        view.dispatch({ selection: EditorSelection.single(on) })
        const revealed = read()
        expect(view.dom.textContent).toContain('#')
        // Every size-bearing property is unchanged → zero reflow delta.
        expect(revealed).toEqual(resting)
      } finally {
        view.destroy()
      }
    })
  }
})

describe('line-class vertical rhythm is PADDING, not margin (click-position-drift gate)', () => {
  // Regression gate for the "click lands a line above the text, growing after
  // each heading" bug. CodeMirror 6's vertical height model measures line
  // blocks via offset geometry (offsetHeight/offsetTop), which EXCLUDES margin
  // but INCLUDES padding. A vertical margin on a `.cm-line`-level decoration
  // class desyncs the internal Y model from the painted layout, so
  // posAtCoords/coordsAtPos drift upward by the accumulated margin and clicks
  // miss. Keeping the heading + hr rhythm as PADDING keeps the model and paint
  // in lockstep. These assertions pin that: each heading carries its rhythm as
  // padding-top, and zero vertical MARGIN — flip any back to margin and the
  // drift returns.
  // jsdom reports padding as the AUTHORED em value (no layout resolution) and
  // an undeclared margin as the empty string — so we pin the em the rule sets
  // and assert no vertical margin was authored at all.
  const cases = [
    // h1 alone is the doc's first child → the :first-child clamp (0.1em) wins
    // over the base 0.4em top; that clamp is padding now too.
    ['h1', '# Title', 'cm-ink-h1', '0.1em', '0.1em'],
    ['h2', 'intro\n\n## Section\n\nbody', 'cm-ink-h2', '1.4em', '0.2em'],
    ['h3', 'intro\n\n### Section\n\nbody', 'cm-ink-h3', '1.3em', '0.1em'],
    ['h4', 'intro\n\n#### Section\n\nbody', 'cm-ink-h4', '1.2em', '0.1em'],
    ['h5', 'intro\n\n##### Section\n\nbody', 'cm-ink-h5', '1.1em', '0.1em'],
    ['h6', 'intro\n\n###### Section\n\nbody', 'cm-ink-h6', '1.1em', '0.1em'],
  ] as const

  for (const [label, doc, cls, expectedPadTop, expectedPadBottom] of cases) {
    it(`${label}: rhythm is padding (${expectedPadTop}/${expectedPadBottom}) with zero vertical margin`, () => {
      const view = mountView(doc, 0)
      try {
        const el = view.dom.querySelector(`.${cls}`) as HTMLElement
        expect(el).toBeTruthy()
        const cs = getComputedStyle(el)
        // Spacing lives in padding…
        expect(cs.paddingTop).toBe(expectedPadTop)
        expect(cs.paddingBottom).toBe(expectedPadBottom)
        // …and NOT in margin (margin would drift the caret on click). jsdom
        // returns '' for an undeclared margin; the regression would set an em.
        expect(cs.marginTop).not.toMatch(/em|px/)
        expect(cs.marginBottom).not.toMatch(/em|px/)
        // Horizontal line padding (the body column) is preserved, not zeroed by
        // a `padding` shorthand on the heading class.
        expect(cs.paddingLeft).toBe('16px')
        expect(cs.paddingRight).toBe('16px')
      } finally {
        view.destroy()
      }
    })
  }

  it('hr line carries vertical padding and zero vertical margin', () => {
    const view = mountView('a\n\n---\n\nb', 0)
    try {
      const hr = view.dom.querySelector('.cm-ink-hr') as HTMLElement
      expect(hr).toBeTruthy()
      const cs = getComputedStyle(hr)
      expect(cs.paddingTop).toBe('1.1em')
      expect(cs.paddingBottom).toBe('1.1em')
      expect(cs.marginTop).not.toMatch(/em|px/)
      expect(cs.marginBottom).not.toMatch(/em|px/)
    } finally {
      view.destroy()
    }
  })
})
