import { parse, type DefaultTreeAdapterTypes } from 'parse5'
import { QUOTE_CONTEXT, type TextQuote, similarity } from './quote.ts'

export interface NodeStep {
  tag: string
  nthOfType: number
  id?: string
  clsNorm?: string
}

export interface NodeAnchor {
  schema: 1
  path: NodeStep[]
  fingerprint: NodeFingerprint
  quote?: TextQuote
  textRange?: { start: number; end: number; unit: 'utf16' }
  domHint: number
  label: string
  status: 'anchored' | 'orphaned'
  clientResolveOnly?: true
}

export interface NodeFingerprint {
  tag: string
  id?: string
  classesRaw?: string[]
  classesNorm?: string[]
  role?: string
  ariaLabel?: string
  name?: string
  attrs?: Record<string, string>
}

export interface HtmlIndexedNode {
  index: number
  tag: string
  parentIndex: number | null
  path: NodeStep[]
  fingerprint: NodeFingerprint
  text: string
  rawAttrs: Record<string, string>
  label: string
}

export interface HtmlNodeIndex {
  nodes: HtmlIndexedNode[]
  documentText: string
}

export type NodeAnchorTarget = { domIndex: number; textRange?: NodeAnchor['textRange'] } | { path: NodeStep[]; textRange?: NodeAnchor['textRange'] }

export interface NodeAnchorScore {
  node: HtmlIndexedNode
  score: number
  parts: {
    tag: number
    id: number
    role: number
    ariaLabel: number
    name: number
    attrs: number
    classes: number
    quote: number
    path: number
    hint: number
  }
}

export interface NodeAnchorResolution {
  anchor: NodeAnchor
  node: HtmlIndexedNode | null
  reason: 'exact-path' | 'fingerprint' | 'quote-only' | 'orphaned' | 'client-resolve-only'
  score?: NodeAnchorScore
  runnerUp?: NodeAnchorScore
}

export const NODE_MIN_TEXT_CHARS = 8
export const NODE_VALIDATE = 10
export const NODE_FUZZY_ACCEPT = 10
export const NODE_AMBIGUITY_MARGIN = 2
export const NODE_WEAK_QUOTE_GUARD = 0.8

export const NODE_SCORE_WEIGHTS = {
  tag: 3,
  id: 9,
  role: 2,
  ariaLabel: 2,
  name: 1.5,
  attrs: 2,
  classes: 1,
  quote: 6,
  path: 3,
  hint: 1,
} as const

type ParseNode = DefaultTreeAdapterTypes.Node
type ParseParent = DefaultTreeAdapterTypes.ParentNode
type ParseElement = DefaultTreeAdapterTypes.Element | DefaultTreeAdapterTypes.Template

const PATH_EXCLUDED_TAGS = new Set(['html', 'head'])
const TEXT_EXCLUDED_TAGS = new Set(['script', 'style', 'noscript'])

export function parseHtmlNodeIndex(html: string): HtmlNodeIndex {
  const document = parse(html)
  const nodes: HtmlIndexedNode[] = []
  const stack: NodeStep[] = []
  const indexStack: number[] = []

  const visit = (node: ParseNode): void => {
    if (!isElement(node)) {
      for (const child of childNodesOf(node)) visit(child)
      return
    }

    const tag = normalizeTag(node.tagName)
    const includeInPath = !PATH_EXCLUDED_TAGS.has(tag)
    let pushed = false

    if (includeInPath) {
      const rawAttrs = attrsMap(node)
      const fingerprint = fingerprintFromAttrs(tag, rawAttrs)
      const step = nodeStep(tag, nthOfType(node), fingerprint)
      stack.push(step)
      pushed = true

      const index = nodes.length
      const parentIndex = indexStack.length > 0 ? (indexStack[indexStack.length - 1] ?? null) : null
      const text = normalizeHtmlText(extractVisibleText(node))
      const path = canonicalPath(stack)
      const label = labelFor(tag, fingerprint, text)
      nodes.push({ index, tag, parentIndex, path, fingerprint, text, rawAttrs, label })
      indexStack.push(index)
    }

    for (const child of childNodesOf(node)) visit(child)

    if (pushed) {
      stack.pop()
      indexStack.pop()
    }
  }

  for (const child of document.childNodes) visit(child)
  const body = findBody(document)
  return { nodes, documentText: normalizeHtmlText(extractVisibleText(body ?? document)) }
}

export function createNodeAnchor(htmlOrIndex: string | HtmlNodeIndex, target: NodeAnchorTarget): NodeAnchor | null {
  const index = ensureIndex(htmlOrIndex)
  const node = 'domIndex' in target ? index.nodes[target.domIndex] : findUniqueByPath(index, target.path)
  if (!node) return null
  const anchor = anchorForNode(index, node, target.textRange)
  if (!nodeAnchorMinimumOk(anchor)) return null
  if (!hasStrongFingerprint(anchor) && ambiguousQuoteAtCreation(index, anchor, node)) return null
  if (fingerprintAmbiguousNow(index, anchor)) return null
  return anchor
}

export function resolveNodeAnchor(htmlOrIndex: string | HtmlNodeIndex, anchor: NodeAnchor): NodeAnchorResolution {
  const index = ensureIndex(htmlOrIndex)
  if (anchor.clientResolveOnly) {
    return {
      anchor: { ...anchor, status: 'orphaned' },
      node: null,
      reason: 'client-resolve-only',
    }
  }
  if (!nodeAnchorMinimumOk(anchor)) return orphan(anchor)
  if (fingerprintAmbiguousNow(index, anchor)) return orphan(anchor)
  if (!hasStrongFingerprint(anchor) && quoteAmbiguousNow(index, anchor)) return orphan(anchor)

  const exact = pathCandidates(index, anchor.path)
  if (exact.length === 1) {
    const score = scoreNodeCandidate(anchor, exact[0]!, index)
    if (candidatePassesQuoteGuard(anchor, score.node) && score.score >= NODE_VALIDATE) {
      return {
        anchor: anchorForNode(index, score.node, anchor.textRange),
        node: score.node,
        reason: 'exact-path',
        score,
      }
    }
  }

  const fingerprint = pickUniqueBest(
    index.nodes
      .filter((node) => node.tag === anchor.fingerprint.tag)
      .filter((node) => candidatePassesQuoteGuard(anchor, node))
      .map((node) => scoreNodeCandidate(anchor, node, index)),
    NODE_FUZZY_ACCEPT,
  )
  if (fingerprint) {
    return {
      anchor: anchorForNode(index, fingerprint.best.node, anchor.textRange),
      node: fingerprint.best.node,
      reason: 'fingerprint',
      score: fingerprint.best,
      runnerUp: fingerprint.runnerUp,
    }
  }

  const quoteCandidates = quoteOnlyCandidates(index, anchor).map((node) => scoreNodeCandidate(anchor, node, index))
  const quote = pickUniqueBest(quoteCandidates, NODE_FUZZY_ACCEPT)
  if (quote) {
    return {
      anchor: anchorForNode(index, quote.best.node, anchor.textRange),
      node: quote.best.node,
      reason: 'quote-only',
      score: quote.best,
      runnerUp: quote.runnerUp,
    }
  }

  return orphan(anchor)
}

export function scoreNodeCandidate(anchor: NodeAnchor, node: HtmlIndexedNode, index: HtmlNodeIndex): NodeAnchorScore {
  const tagMatch = node.tag === anchor.fingerprint.tag ? 1 : 0
  const parts = {
    tag: NODE_SCORE_WEIGHTS.tag * tagMatch,
    id: anchor.fingerprint.id && node.fingerprint.id === anchor.fingerprint.id ? NODE_SCORE_WEIGHTS.id : 0,
    role: fieldMatch(anchor.fingerprint.role, node.fingerprint.role) * NODE_SCORE_WEIGHTS.role,
    ariaLabel: fieldMatch(anchor.fingerprint.ariaLabel, node.fingerprint.ariaLabel) * NODE_SCORE_WEIGHTS.ariaLabel,
    name: fieldMatch(anchor.fingerprint.name, node.fingerprint.name) * NODE_SCORE_WEIGHTS.name,
    attrs: attrsMatch(anchor.fingerprint.attrs, node.fingerprint.attrs) * NODE_SCORE_WEIGHTS.attrs,
    classes: classOverlap(anchor.fingerprint.classesNorm, node.fingerprint.classesNorm) * NODE_SCORE_WEIGHTS.classes,
    quote: quoteSimilarity(anchor.quote, node.text) * NODE_SCORE_WEIGHTS.quote,
    path: pathSuffixOverlap(anchor.path, node.path) * NODE_SCORE_WEIGHTS.path,
    hint: hintProximity(anchor.domHint, node.index, index.nodes.length) * NODE_SCORE_WEIGHTS.hint,
  }
  if (!tagMatch) {
    parts.id = 0
    parts.role = 0
    parts.ariaLabel = 0
    parts.name = 0
    parts.attrs = 0
    parts.classes = 0
    parts.quote = 0
    parts.path = 0
    parts.hint = 0
  }
  return {
    node,
    score:
      parts.tag +
      parts.id +
      parts.role +
      parts.ariaLabel +
      parts.name +
      parts.attrs +
      parts.classes +
      parts.quote +
      parts.path +
      parts.hint,
    parts,
  }
}

export function nodeAnchorMinimumOk(anchor: NodeAnchor): boolean {
  if (anchor.fingerprint.id) return true
  if (anchor.fingerprint.role || anchor.fingerprint.ariaLabel || anchor.fingerprint.name) return true
  if (anchor.fingerprint.attrs && Object.keys(anchor.fingerprint.attrs).length > 0) return true
  if (hasMeaningfulClass(anchor.fingerprint.classesNorm)) return true
  return (anchor.quote?.exact.trim().length ?? 0) >= NODE_MIN_TEXT_CHARS
}

export function nodeAnchorsEqual(a: NodeAnchor, b: NodeAnchor): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function normalizeHtmlText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function normalizeClassList(classAttr: string | undefined): string[] {
  if (!classAttr) return []
  const out = new Set<string>()
  for (const token of classAttr.split(/\s+/)) {
    const normalized = normalizeClassToken(token)
    if (normalized) out.add(normalized)
  }
  return [...out].sort()
}

export function normalizeClassToken(token: string): string | null {
  const trimmed = token.trim()
  if (!trimmed) return null
  const withoutModuleHash = trimmed
    .replace(/__[A-Za-z0-9_-]{5,}$/u, '')
    .replace(/_[A-Fa-f0-9]{6,}$/u, '')
  const kebab = withoutModuleHash
    .replace(/([a-z0-9])([A-Z])/gu, '$1-$2')
    .replace(/_/gu, '-')
    .toLowerCase()
  if (!/[a-z]/u.test(kebab)) return null
  if (/^[a-f0-9]{6,}$/iu.test(kebab)) return null
  return kebab
}

function ensureIndex(htmlOrIndex: string | HtmlNodeIndex): HtmlNodeIndex {
  return typeof htmlOrIndex === 'string' ? parseHtmlNodeIndex(htmlOrIndex) : htmlOrIndex
}

function anchorForNode(index: HtmlNodeIndex, node: HtmlIndexedNode, textRange?: NodeAnchor['textRange']): NodeAnchor {
  const quote = quoteForNode(index, node, textRange)
  return {
    schema: 1,
    path: node.path,
    fingerprint: node.fingerprint,
    quote,
    ...(validTextRange(textRange, node.text) ? { textRange } : {}),
    domHint: node.index,
    label: labelFor(node.tag, node.fingerprint, quote?.exact ?? node.text),
    status: 'anchored',
  }
}

function quoteForNode(index: HtmlNodeIndex, node: HtmlIndexedNode, textRange?: NodeAnchor['textRange']): TextQuote | undefined {
  const exact = validTextRange(textRange, node.text) ? node.text.slice(textRange.start, textRange.end) : node.text
  if (!exact) return undefined

  const at = locateQuote(index.documentText, exact, node.index)
  if (at === -1) return { exact, prefix: '', suffix: '' }
  return {
    exact,
    prefix: index.documentText.slice(Math.max(0, at - QUOTE_CONTEXT), at),
    suffix: index.documentText.slice(at + exact.length, at + exact.length + QUOTE_CONTEXT),
  }
}

function validTextRange(textRange: NodeAnchor['textRange'] | undefined, text: string): textRange is NonNullable<NodeAnchor['textRange']> {
  return (
    textRange !== undefined &&
    textRange.unit === 'utf16' &&
    Number.isInteger(textRange.start) &&
    Number.isInteger(textRange.end) &&
    textRange.start >= 0 &&
    textRange.end > textRange.start &&
    textRange.end <= text.length
  )
}

function ambiguousQuoteAtCreation(index: HtmlNodeIndex, anchor: NodeAnchor, target: HtmlIndexedNode): boolean {
  const candidates = quoteOnlyCandidates(index, anchor)
  const exactMatches = candidates.filter((node) => quoteSimilarity(anchor.quote, node.text) === 1)
  return exactMatches.length > 1 && exactMatches.some((node) => node.index !== target.index)
}

function quoteAmbiguousNow(index: HtmlNodeIndex, anchor: NodeAnchor): boolean {
  return quoteOnlyCandidates(index, anchor).filter((node) => quoteSimilarity(anchor.quote, node.text) === 1).length > 1
}

function fingerprintAmbiguousNow(index: HtmlNodeIndex, anchor: NodeAnchor): boolean {
  const exact = quoteOnlyCandidates(index, anchor).filter(
    (node) => quoteSimilarity(anchor.quote, node.text) === 1 && fingerprintFieldsMatch(anchor.fingerprint, node.fingerprint),
  )
  return exact.length > 1
}

function fingerprintFieldsMatch(anchor: NodeFingerprint, candidate: NodeFingerprint): boolean {
  if (anchor.id && anchor.id !== candidate.id) return false
  if (anchor.role && anchor.role !== candidate.role) return false
  if (anchor.ariaLabel && anchor.ariaLabel !== candidate.ariaLabel) return false
  if (anchor.name && anchor.name !== candidate.name) return false
  if (anchor.attrs && attrsMatch(anchor.attrs, candidate.attrs) !== 1) return false
  if (anchor.classesNorm && anchor.classesNorm.length > 0 && classOverlap(anchor.classesNorm, candidate.classesNorm) !== 1) return false
  return true
}

function candidatePassesQuoteGuard(anchor: NodeAnchor, node: HtmlIndexedNode): boolean {
  return hasStrongFingerprint(anchor) || quoteSimilarity(anchor.quote, node.text) >= NODE_WEAK_QUOTE_GUARD
}

function orphan(anchor: NodeAnchor): NodeAnchorResolution {
  return { anchor: { ...anchor, status: 'orphaned' }, node: null, reason: 'orphaned' }
}

function pickUniqueBest(scores: NodeAnchorScore[], threshold: number): { best: NodeAnchorScore; runnerUp?: NodeAnchorScore } | null {
  const sorted = scores
    .filter((score) => score.score > 0)
    .sort((a, b) => (b.score === a.score ? a.node.index - b.node.index : b.score - a.score))
  const best = sorted[0]
  if (!best || best.score < threshold) return null
  const runnerUp = sorted[1]
  if (runnerUp && best.score - runnerUp.score < NODE_AMBIGUITY_MARGIN) return null
  return { best, runnerUp }
}

function quoteOnlyCandidates(index: HtmlNodeIndex, anchor: NodeAnchor): HtmlIndexedNode[] {
  const exact = anchor.quote?.exact.trim()
  if (!exact || exact.length < NODE_MIN_TEXT_CHARS) return []
  const containing = index.nodes.filter((node) => node.tag === anchor.fingerprint.tag && quoteSimilarity(anchor.quote, node.text) >= 0.9)
  return containing.filter((node) => !containing.some((other) => other.index !== node.index && isDescendantOf(other, node.index, index)))
}

function isDescendantOf(node: HtmlIndexedNode, ancestorIndex: number, index: HtmlNodeIndex): boolean {
  let parent = node.parentIndex
  while (parent !== null) {
    if (parent === ancestorIndex) return true
    parent = index.nodes[parent]?.parentIndex ?? null
  }
  return false
}

function pathCandidates(index: HtmlNodeIndex, path: NodeStep[]): HtmlIndexedNode[] {
  return index.nodes.filter((node) => pathsMatch(path, node.path))
}

function findUniqueByPath(index: HtmlNodeIndex, path: NodeStep[]): HtmlIndexedNode | null {
  const candidates = pathCandidates(index, path)
  return candidates.length === 1 ? candidates[0]! : null
}

function pathsMatch(anchorPath: NodeStep[], candidatePath: NodeStep[]): boolean {
  if (anchorPath.length !== candidatePath.length) return false
  return anchorPath.every((step, i) => {
    const candidate = candidatePath[i]
    return (
      candidate !== undefined &&
      step.tag === candidate.tag &&
      step.nthOfType === candidate.nthOfType &&
      (step.id === undefined || step.id === candidate.id)
    )
  })
}

function pathSuffixOverlap(anchorPath: NodeStep[], candidatePath: NodeStep[]): number {
  const max = Math.max(anchorPath.length, candidatePath.length)
  if (max === 0) return 0
  let matches = 0
  for (let ai = anchorPath.length - 1, ci = candidatePath.length - 1; ai >= 0 && ci >= 0; ai--, ci--) {
    const a = anchorPath[ai]!
    const c = candidatePath[ci]!
    if (a.tag !== c.tag || a.nthOfType !== c.nthOfType) break
    matches++
  }
  return matches / max
}

function hintProximity(hint: number, candidate: number, count: number): number {
  if (count <= 1) return 1
  return Math.max(0, 1 - Math.abs(hint - candidate) / (count - 1))
}

function quoteSimilarity(quote: TextQuote | undefined, text: string): number {
  const exact = quote?.exact.trim()
  if (!exact || !text) return 0
  if (text === exact || text.includes(exact)) return 1
  return similarity(text, exact)
}

function classOverlap(a: string[] | undefined, b: string[] | undefined): number {
  if (!a || !b || a.length === 0 || b.length === 0) return 0
  const bs = new Set(b)
  let overlap = 0
  for (const cls of a) if (bs.has(cls)) overlap++
  return overlap / Math.max(a.length, b.length)
}

function attrsMatch(a: Record<string, string> | undefined, b: Record<string, string> | undefined): number {
  if (!a || Object.keys(a).length === 0 || !b) return 0
  let matches = 0
  let total = 0
  for (const [key, value] of Object.entries(a)) {
    total++
    if (b[key] === value) matches++
  }
  return total === 0 ? 0 : matches / total
}

function fieldMatch(a: string | undefined, b: string | undefined): number {
  return a && b && a === b ? 1 : 0
}

function hasStrongFingerprint(anchor: NodeAnchor): boolean {
  return Boolean(
    anchor.fingerprint.id ||
      anchor.fingerprint.role ||
      anchor.fingerprint.ariaLabel ||
      anchor.fingerprint.name ||
      (anchor.fingerprint.attrs && Object.keys(anchor.fingerprint.attrs).length > 0),
  )
}

function hasMeaningfulClass(classes: string[] | undefined): boolean {
  return Boolean(classes?.some((cls) => /[a-z]{3,}/u.test(cls) && !isCommonUtilityClass(cls)))
}

function isCommonUtilityClass(cls: string): boolean {
  return /^(?:p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|w|h|min-w|min-h|max-w|max-h|text|bg|border|rounded|shadow|flex|grid|block|inline|hidden|relative|absolute|items|justify|content|gap|space|font|leading|tracking|opacity|z)-?/u.test(
    cls,
  )
}

function locateQuote(documentText: string, exact: string, domIndex: number): number {
  if (!documentText || !exact) return -1
  const occurrences: number[] = []
  let from = 0
  while (true) {
    const at = documentText.indexOf(exact, from)
    if (at === -1) break
    occurrences.push(at)
    from = at + 1
  }
  if (occurrences.length === 0) return -1
  return occurrences[Math.min(domIndex, occurrences.length - 1)] ?? occurrences[0]!
}

function canonicalPath(stack: NodeStep[]): NodeStep[] {
  let start = -1
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i]?.id) {
      start = i
      break
    }
  }
  if (start === -1) start = stack.findIndex((step) => step.tag === 'body')
  if (start === -1) start = 0
  return stack.slice(start)
}

function nodeStep(tag: string, nthOfType: number, fingerprint: NodeFingerprint): NodeStep {
  return {
    tag,
    nthOfType,
    ...(fingerprint.id ? { id: fingerprint.id } : {}),
    ...(fingerprint.classesNorm && fingerprint.classesNorm.length > 0 ? { clsNorm: fingerprint.classesNorm.join('.') } : {}),
  }
}

function fingerprintFromAttrs(tag: string, rawAttrs: Record<string, string>): NodeFingerprint {
  const classesRaw = splitClasses(rawAttrs['class'])
  const classesNorm = normalizeClassList(rawAttrs['class'])
  const attrs = allowedFingerprintAttrs(rawAttrs)
  return {
    tag,
    ...(cleanAttr(rawAttrs.id) ? { id: cleanAttr(rawAttrs.id) } : {}),
    ...(classesRaw.length > 0 ? { classesRaw } : {}),
    ...(classesNorm.length > 0 ? { classesNorm } : {}),
    ...(cleanAttr(rawAttrs.role) ? { role: cleanAttr(rawAttrs.role)?.toLowerCase() } : {}),
    ...(cleanAttr(rawAttrs['aria-label']) ? { ariaLabel: cleanAttr(rawAttrs['aria-label']) } : {}),
    ...(cleanAttr(rawAttrs.name) ? { name: cleanAttr(rawAttrs.name) } : {}),
    ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
  }
}

function allowedFingerprintAttrs(rawAttrs: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(rawAttrs)) {
    const cleaned = cleanAttr(value)
    if (!cleaned) continue
    if (name === 'type' || name === 'alt' || name.startsWith('data-')) out[name] = cleaned
    else if (name === 'href') out.href = normalizeHref(cleaned)
  }
  return out
}

function normalizeHref(href: string): string {
  if (href.startsWith('#')) return href
  const withoutFragment = href.split('#', 1)[0] ?? href
  const withoutQuery = withoutFragment.split('?', 1)[0] ?? withoutFragment
  const absolute = withoutQuery.match(/^[a-z][a-z0-9+.-]*:\/\/([^/]+)(\/.*)?$/iu)
  if (absolute) return `${absolute[1]!.toLowerCase()}${absolute[2] ?? '/'}`
  return withoutQuery || href
}

function splitClasses(classAttr: string | undefined): string[] {
  return classAttr?.split(/\s+/).filter(Boolean) ?? []
}

function cleanAttr(value: string | undefined): string | undefined {
  const cleaned = value?.trim()
  return cleaned ? cleaned : undefined
}

function labelFor(tag: string, fingerprint: NodeFingerprint, text: string): string {
  const candidate = fingerprint.ariaLabel ?? fingerprint.name ?? fingerprint.attrs?.alt ?? text
  const snippet = normalizeHtmlText(candidate).slice(0, 48)
  if (snippet) return `${tag} "${snippet}"`
  if (fingerprint.id) return `${tag}#${fingerprint.id}`
  return tag
}

function extractVisibleText(node: ParseNode, hidden = false): string {
  if (isTextNode(node)) return hidden ? '' : node.value
  if (!isParentNode(node)) return ''

  const nextHidden = hidden || (isElement(node) && (TEXT_EXCLUDED_TAGS.has(normalizeTag(node.tagName)) || isHidden(node)))
  if (nextHidden) return ''
  return childNodesOf(node)
    .map((child) => extractVisibleText(child, nextHidden))
    .filter(Boolean)
    .join(' ')
}

function isHidden(node: ParseElement): boolean {
  const attrs = attrsMap(node)
  if ('hidden' in attrs) return true
  if (attrs['aria-hidden']?.toLowerCase() === 'true') return true
  const style = attrs.style?.toLowerCase() ?? ''
  return /(?:^|;)\s*display\s*:\s*none\s*(?:;|$)/u.test(style) || /(?:^|;)\s*visibility\s*:\s*hidden\s*(?:;|$)/u.test(style)
}

function nthOfType(node: ParseElement): number {
  const parent = node.parentNode
  if (!parent) return 1
  const tag = normalizeTag(node.tagName)
  let nth = 0
  for (const child of childNodesOf(parent)) {
    if (isElement(child) && normalizeTag(child.tagName) === tag) nth++
    if (child === node) return nth
  }
  return Math.max(1, nth)
}

function childNodesOf(node: ParseNode | ParseParent): DefaultTreeAdapterTypes.ChildNode[] {
  if (isTemplate(node)) return node.content.childNodes
  return isParentNode(node) ? node.childNodes : []
}

function attrsMap(node: ParseElement): Record<string, string> {
  const out: Record<string, string> = {}
  for (const attr of node.attrs) out[attr.name.toLowerCase()] = attr.value
  return out
}

function findBody(document: DefaultTreeAdapterTypes.Document): ParseElement | null {
  const stack: ParseNode[] = [...document.childNodes]
  while (stack.length > 0) {
    const node = stack.shift()!
    if (isElement(node) && normalizeTag(node.tagName) === 'body') return node
    stack.unshift(...childNodesOf(node))
  }
  return null
}

function normalizeTag(tag: string): string {
  return tag.toLowerCase()
}

function isElement(node: ParseNode): node is ParseElement {
  return typeof (node as { tagName?: unknown }).tagName === 'string'
}

function isTemplate(node: ParseNode | ParseParent): node is DefaultTreeAdapterTypes.Template {
  return isElement(node as ParseNode) && normalizeTag((node as ParseElement).tagName) === 'template' && 'content' in node
}

function isTextNode(node: ParseNode): node is DefaultTreeAdapterTypes.TextNode {
  return node.nodeName === '#text'
}

function isParentNode(node: ParseNode): node is ParseParent {
  return 'childNodes' in node
}
