# Glyphdown Kitchen Sink

A living typography specimen. This document exercises **every** rendered element so the live-preview editor can be tuned against real prose, not lorem ipsum. The opening paragraph runs long on purpose: it needs to *wrap* several times to reveal how body line-height and measure feel when reading a genuine block of text rather than a one-liner.

Typography is the craft of arranging type to make written language ==legible, readable, and appealing== when displayed. Good defaults matter because most documents are never restyled. A second paragraph here checks the spacing *between* paragraphs against the spacing between lines within one — the classic vertical-rhythm tell.

## Headings and Hierarchy

The section heading above should sit closer to the text it introduces than to the paragraph it follows. Below, the smaller heading levels are stress-tested back to back so their differentiation by weight, color, and caps — not size alone — is obvious.

### Third-level heading with some trailing prose

Third level introduces a subsection. It carries real sentences so the leading reads naturally and the heading's bottom-margin can be judged against body copy that immediately follows it.

#### Fourth-level heading

At the fourth level, size has nearly run out as a signal. Weight, a touch of color, or letter-spacing must carry the hierarchy. The body text here confirms the heading still reads as a heading.

##### Fifth-level heading

Fifth level is typically near body size. It should still feel structurally above the paragraph beneath it.

###### Sixth-level heading

Sixth level is the quietest — often uppercased, tracked-out, and muted, like a small label. This sentence trails it to test that contrast.

## Inline Formatting

A single paragraph can mix **bold weight**, *italic emphasis*, ***bold italic***, ~~strikethrough~~, ==highlighted spans==, and `inline code` mid-sentence without throwing off the line rhythm. Inline code like `const x = 42` and `editor.dispatch()` must not inflate the line box. Links come in flavors: an [inline link](https://example.com/typography), a [[Wiki Link]], a [[Second Note|aliased wikilink]], and a bare autolink https://glyphdown.com/docs/typography that the editor chips.

A code-dense sentence: call `computeDecorations(state)`, then `Decoration.replace({ widget })`, and finally `view.dispatch({ changes })` — three chips in a row should each stay tight to the baseline.

## Lists

Unordered nesting three levels deep:

- Top-level item with enough text to wrap once or twice so the hanging indent of the continuation line can be checked against the marker column.
  - Second level continues the thought and also wraps to a second visual line for the same reason.
    - Third level is the deepest bullet; its marker should align consistently with the indents above it.
  - Back to second level.
- Another top-level item.

Ordered list with two-digit numbers (alignment of `9.` vs `10.` matters):

8. Eighth step in a longer procedure.
9. Ninth step, still single digit.
10. Tenth step — now two digits; the numbers should stay right-coherent.
11. Eleventh step closes it out.

Task list, checked / unchecked / nested:

- [x] Draft the kitchen-sink document
- [ ] Tune the heading scale
  - [x] Pick a modular ratio
  - [ ] Verify dark-mode contrast
- [ ] Ship to production

## Blockquotes

> A multi-line blockquote sets a quieter voice apart from the body.
> It continues across lines and should float as a block with its own
> left rule and breathing room.
>
> > A nested blockquote sits one level deeper, with a second rule.

## Callouts

> [!note] A note callout
> Callouts float as tinted blocks. The body text wraps and keeps the
> left accent rule and comfortable padding.

> [!warning] Heed this warning
> Warnings carry an amber accent. This one has a body to test multi-line
> padding and the icon's optical alignment against the title.

> [!tip]

## Code Block

```ts
import { EditorView } from '@codemirror/view'

interface ScaleStep {
  level: number
  size: string
  weight: number
}

function modularScale(base: number, ratio: number, steps: number): number[] {
  const out: number[] = []
  for (let i = 0; i < steps; i++) {
    out.push(Math.round(base * ratio ** i * 1000) / 1000)
  }
  return out
}

const headings = modularScale(1, 1.25, 6)
console.log('heading sizes (em):', headings)
```

## Horizontal Rules

The rule below should have generous margin above and below so it reads as a section break, not a cramped line.

---

## Math

Inline math like $E = mc^2$ flows within the sentence, while a display block stands alone and centered:

$$
\int_{-\infty}^{\infty} e^{-x^2}\,dx = \sqrt{\pi}
$$

## Image

A small inline data-URI image renders below:

![gradient swatch|96](data:image/png;base64,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)

## Footnotes and Comments

Typography rewards restraint.[^scale] A second reference[^rhythm] points elsewhere.

%%This is an editorial comment that should render faded and never affect the surrounding rhythm.%%

## Table (context only — not iterated)

| Element   | Line-height | Notes                       |
| --------- | ----------- | --------------------------- |
| Body      | 1.65        | comfortable reading measure |
| Heading   | 1.25        | tighter, denser             |
| Code      | 1.5         | monospace block             |

## Overflow

A pathologically long URL that must not blow out the measure: https://example.com/this/is/an/extremely/long/path/segment/that/keeps/going/and/going/until/it/would/overflow/the/reading/column/if/wrapping/were/not/handled?query=parameter&another=value&third=yet-another-value

[^scale]: The modular scale ratio used here is 1.25 (major third).
[^rhythm]: Vertical rhythm aligns elements to a consistent baseline grid.
