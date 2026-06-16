import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  createNodeAnchor,
  normalizeClassList,
  parseHtmlNodeIndex,
  resolveNodeAnchor,
  type HtmlIndexedNode,
  type HtmlNodeIndex,
} from '../src/index.ts'
import { wordArb } from './helpers.ts'

interface ModelNode {
  id: string
  tag: 'p' | 'button' | 'h2'
  text: string
  className: string
}

const tagArb = fc.constantFrom<ModelNode['tag']>('p', 'button', 'h2')
const modelArb = fc
  .array(
    fc.record({
      tag: tagArb,
      words: fc.array(wordArb, { minLength: 3, maxLength: 6 }),
    }),
    { minLength: 3, maxLength: 8 },
  )
  .map((nodes) =>
    nodes.map((node, i): ModelNode => {
      const semantic = i % 2 === 0 ? 'Content_block__a1B2c' : 'Content_block__z9Y8x'
      return {
        id: `m${i}`,
        tag: node.tag,
        text: `node ${i} ${node.words.join(' ')}`,
        className: `${semantic} px-4`,
      }
    }),
  )

describe('HTML node index normalization', () => {
  it('normalizes entities, whitespace, and non-rendered text', () => {
    const index = parseHtmlNodeIndex('<main><p>A&nbsp;B &amp; C</p><script>wrong()</script><p hidden>hidden</p></main>')
    expect(index.documentText).toBe('A B & C')
    expect(index.nodes.find((node) => node.tag === 'p')?.text).toBe('A B & C')
  })

  it('uses body or nearest id ancestor as the canonical path root', () => {
    const index = parseHtmlNodeIndex('<body><main><section id="stable"><div><button>Save changes</button></div></section></main></body>')
    const button = index.nodes.find((node) => node.tag === 'button')
    expect(button?.path.map((step) => step.tag)).toEqual(['section', 'div', 'button'])
    expect(button?.path[0]).toMatchObject({ tag: 'section', id: 'stable' })
  })

  it('follows parser recovery for invalid HTML', () => {
    const index = parseHtmlNodeIndex('<main><p>One<p>Two</main>')
    const paragraphs = index.nodes.filter((node) => node.tag === 'p')
    expect(paragraphs.map((node) => node.path.at(-1)?.nthOfType)).toEqual([1, 2])
    expect(paragraphs.map((node) => node.text)).toEqual(['One', 'Two'])
  })
})

describe('class normalization', () => {
  it('strips CSS-module hashes while keeping utility classes as weak evidence', () => {
    expect(normalizeClassList('Card_title__3F9aK Button_primary_abcdef px-4 hover:bg-blue-500')).toEqual([
      'button-primary',
      'card-title',
      'hover:bg-blue-500',
      'px-4',
    ])
  })

  it('reanchors across CSS-module hash churn', () => {
    const before = parseHtmlNodeIndex('<button class="Button_primary__a1B2c">Save changes now</button>')
    const button = before.nodes.find((node) => node.tag === 'button')
    expect(button).toBeDefined()
    const anchor = createNodeAnchor(before, { domIndex: button!.index })
    expect(anchor).not.toBeNull()

    const after = parseHtmlNodeIndex('<button class="Button_primary__z9Y8x">Save changes now</button>')
    const resolved = resolveNodeAnchor(after, anchor!)
    expect(resolved.node?.tag).toBe('button')
    expect(resolved.anchor.status).toBe('anchored')
  })

  it('orphans instead of picking arbitrarily when normalized classes and quotes collide', () => {
    const index = parseHtmlNodeIndex(`
      <button class="Button_primary__a1B2c">Save changes now</button>
      <button class="Button_primary__z9Y8x">Save changes now</button>
    `)
    const first = index.nodes.find((node) => node.tag === 'button')
    expect(first).toBeDefined()
    expect(createNodeAnchor(index, { domIndex: first!.index })).toBeNull()
  })
})

describe('node anchor model oracle', () => {
  it('resolves to the expected model id or orphans, never to a wrong model id (property)', () => {
    fc.assert(
      fc.property(modelArb, fc.nat(), fc.constantFrom('move', 'remove', 'duplicate', 'class-churn', 'sibling-edit'), (model, pick, edit) => {
        const target = model[pick % model.length]!
        const before = parseHtmlNodeIndex(renderModel(model))
        const targetNode = findByModelId(before, target.id)
        expect(targetNode).not.toBeNull()
        const anchor = createNodeAnchor(before, { domIndex: targetNode!.index })
        expect(anchor).not.toBeNull()

        const edited = editModel(model, target.id, edit)
        const after = parseHtmlNodeIndex(renderModel(edited))
        const resolved = resolveNodeAnchor(after, anchor!)
        const resolvedModelId = resolved.node ? modelIdOf(resolved.node) : null

        if (edit === 'remove') {
          expect(resolvedModelId).toBeNull()
          expect(resolved.anchor.status).toBe('orphaned')
        } else if (edit === 'duplicate') {
          expect(resolvedModelId === null || resolvedModelId === target.id).toBe(true)
        } else {
          expect(resolvedModelId).toBe(target.id)
          expect(resolved.anchor.status).toBe('anchored')
        }
      }),
      { numRuns: 100 },
    )
  })
})

function editModel(model: ModelNode[], targetId: string, edit: 'move' | 'remove' | 'duplicate' | 'class-churn' | 'sibling-edit'): ModelNode[] {
  const copy = model.map((node) => ({ ...node }))
  const targetIndex = copy.findIndex((node) => node.id === targetId)
  if (targetIndex === -1) return copy

  if (edit === 'remove') return copy.filter((node) => node.id !== targetId)

  if (edit === 'move') {
    const [target] = copy.splice(targetIndex, 1)
    copy.push(target!)
    return copy
  }

  if (edit === 'duplicate') {
    copy.splice(targetIndex, 0, { ...copy[targetIndex]!, id: `copy-${targetId}` })
    return copy
  }

  if (edit === 'class-churn') {
    copy[targetIndex] = { ...copy[targetIndex]!, className: 'Content_block__q8W7e px-4' }
    return copy
  }

  const sibling = copy.find((node) => node.id !== targetId)
  if (sibling) sibling.text = `${sibling.text} revised`
  return copy
}

function renderModel(model: ModelNode[]): string {
  return `<body><main>${model.map(renderNode).join('')}</main></body>`
}

function renderNode(node: ModelNode): string {
  return `<${node.tag} gd-model-id="${escapeAttr(node.id)}" class="${escapeAttr(node.className)}">${escapeHtml(node.text)}</${node.tag}>`
}

function findByModelId(index: HtmlNodeIndex, id: string): HtmlIndexedNode | null {
  return index.nodes.find((node) => modelIdOf(node) === id) ?? null
}

function modelIdOf(node: HtmlIndexedNode): string | null {
  return node.rawAttrs['gd-model-id'] ?? null
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/"/g, '&quot;')
}
