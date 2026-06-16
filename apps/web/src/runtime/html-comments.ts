import type { NodeAnchor } from '@glyphdown/protocol'

export type HtmlCommentsFrameMessage =
  | { t: 'gd:ready'; version: 1; nonce: string }
  | { t: 'gd:select'; version: 1; nonce: string; anchor: NodeAnchor }
  | {
      t: 'gd:markers-resolved'
      version: 1
      nonce: string
      markers: Array<{ id: string; status: 'anchored' | 'orphaned'; domHint?: number; label?: string }>
    }
  | { t: 'gd:marker-click'; version: 1; nonce: string; id: string }

export type HtmlCommentsParentMessage =
  | { t: 'gd:set-mode'; version: 1; nonce: string; mode: 'browse' | 'pick' }
  | { t: 'gd:set-markers'; version: 1; nonce: string; markers: Array<{ id: string; anchor: NodeAnchor; number?: number }> }
  | { t: 'gd:focus-marker'; version: 1; nonce: string; id: string }

// Bounds on untrusted iframe → parent messages. The injected runtime shares the
// iframe JS realm with author scripts (plan §2.4), so EVERY field is validated and
// length-bounded here before the parent treats it as typed data. This is schema
// filtering, not authentication — the server stays the sole authority.
const MAX_STR = 1024
const MAX_PATH_STEPS = 256
const MAX_MARKERS = 5000

export function isHtmlCommentsFrameMessage(value: unknown, nonce: string): value is HtmlCommentsFrameMessage {
  if (!isEnvelope(value, nonce)) return false
  switch (value['t']) {
    case 'gd:ready':
      return true
    case 'gd:select':
      return isNodeAnchorShape(value['anchor'])
    case 'gd:markers-resolved':
      return isBoundedArray(value['markers'], MAX_MARKERS, isMarkerResolution)
    case 'gd:marker-click':
      return isBoundedString(value['id'])
    default:
      return false
  }
}

export function isHtmlCommentsParentMessage(value: unknown, nonce: string): value is HtmlCommentsParentMessage {
  if (!isEnvelope(value, nonce)) return false
  switch (value['t']) {
    case 'gd:set-mode':
      return value['mode'] === 'browse' || value['mode'] === 'pick'
    case 'gd:set-markers':
      return isBoundedArray(value['markers'], MAX_MARKERS, isMarkerInput)
    case 'gd:focus-marker':
      return isBoundedString(value['id'])
    default:
      return false
  }
}

function isEnvelope(value: unknown, nonce: string): value is Record<string, unknown> {
  return isRecord(value) && value['version'] === 1 && value['nonce'] === nonce && typeof value['t'] === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isBoundedString(value: unknown, max = MAX_STR): value is string {
  return typeof value === 'string' && value.length <= max
}

function isBoundedArray<T>(value: unknown, max: number, item: (v: unknown) => v is T): value is T[] {
  return Array.isArray(value) && value.length <= max && value.every(item)
}

function isMarkerResolution(
  value: unknown,
): value is { id: string; status: 'anchored' | 'orphaned'; domHint?: number; label?: string } {
  if (!isRecord(value) || !isBoundedString(value['id'])) return false
  if (value['status'] !== 'anchored' && value['status'] !== 'orphaned') return false
  if (value['domHint'] !== undefined && typeof value['domHint'] !== 'number') return false
  if (value['label'] !== undefined && !isBoundedString(value['label'])) return false
  return true
}

function isMarkerInput(value: unknown): value is { id: string; anchor: NodeAnchor } {
  return isRecord(value) && isBoundedString(value['id']) && isNodeAnchorShape(value['anchor'])
}

function isNodeAnchorShape(value: unknown): value is NodeAnchor {
  if (!isRecord(value) || value['schema'] !== 1) return false
  if (!isBoundedArray(value['path'], MAX_PATH_STEPS, isNodeStepShape)) return false
  const fp = value['fingerprint']
  if (!isRecord(fp) || !isBoundedString(fp['tag'], 64)) return false
  if (typeof value['domHint'] !== 'number') return false
  if (!isBoundedString(value['label'])) return false
  if (value['status'] !== 'anchored' && value['status'] !== 'orphaned') return false
  const quote = value['quote']
  if (quote !== undefined) {
    if (
      !isRecord(quote) ||
      !isBoundedString(quote['exact'], 4096) ||
      !isBoundedString(quote['prefix'], 256) ||
      !isBoundedString(quote['suffix'], 256)
    ) {
      return false
    }
  }
  return true
}

function isNodeStepShape(value: unknown): value is { tag: string; nthOfType: number } {
  return isRecord(value) && isBoundedString(value['tag'], 64) && typeof value['nthOfType'] === 'number'
}

export function installHtmlCommentsRuntime(nonce: string): void {
  const globalKey = '__glyphdownHtmlCommentsRuntime'
  const win = window as Window & { [globalKey]?: true }
  if (win[globalKey]) return
  win[globalKey] = true

  type RuntimeAnchor = {
    schema: 1
    path: Array<{ tag: string; nthOfType: number; id?: string; clsNorm?: string }>
    fingerprint: {
      tag: string
      id?: string
      classesRaw?: string[]
      classesNorm?: string[]
      role?: string
      ariaLabel?: string
      name?: string
      attrs?: Record<string, string>
    }
    quote?: { exact: string; prefix: string; suffix: string }
    domHint: number
    label: string
    status: 'anchored' | 'orphaned'
  }
  type Marker = { id: string; anchor: RuntimeAnchor; element: Element | null; button: HTMLButtonElement }

  const markerClass = 'gd-html-comment-marker'
  const hoverClass = 'gd-html-comment-hover'
  const focusClass = 'gd-html-comment-focus'
  const anchoredClass = 'gd-html-comment-anchored'
  const hostClass = 'gd-html-comments-host'
  const markers = new Map<string, Marker>()
  let pickMode = false
  let hover: Element | null = null
  let host: HTMLDivElement | null = null
  let shadow: ShadowRoot | null = null
  let markerLayer: HTMLDivElement | null = null

  function post(message: Omit<Record<string, unknown>, 'nonce' | 'version'>): void {
    window.parent.postMessage({ ...message, version: 1, nonce }, '*')
  }

  function ready(fn: () => void): void {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true })
    else fn()
  }

  // Only the highlight outlines live in the page (light DOM) — they decorate the
  // AUTHOR's own elements, so shadow-scoped styles could not reach them.
  function installStyles(): void {
    if (document.getElementById('gd-html-comments-style')) return
    const style = document.createElement('style')
    style.id = 'gd-html-comments-style'
    style.textContent = `
      .${hoverClass} { outline: 2px solid #2563eb !important; outline-offset: 2px !important; cursor: crosshair !important; }
      .${focusClass} { outline: 3px solid #0f766e !important; outline-offset: 3px !important; }
      .${anchoredClass} { box-shadow: inset 0 0 0 2px rgba(37, 99, 235, 0.42) !important; }
    `
    document.head.appendChild(style)
  }

  // The marker bubbles live inside a Shadow DOM on a style-neutralized host so the
  // page's CSS (global `button`/`*` rules, inherited fonts, a transformed
  // ancestor) can't warp or mis-position them. `all: initial` walls off
  // inheritance; the host carries no transform/filter/contain, so the markers'
  // `position: fixed` stays relative to the viewport.
  function ensureShadow(): ShadowRoot {
    if (host?.isConnected && shadow && markerLayer?.isConnected) return shadow
    host = document.createElement('div')
    host.className = hostClass
    host.setAttribute(
      'style',
      'all: initial !important; position: fixed !important; inset: 0 !important; z-index: 2147483647 !important; pointer-events: none !important; transform: none !important; filter: none !important; contain: none !important;',
    )
    shadow = host.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = `
      .layer { position: fixed; inset: 0; pointer-events: none; }
      .${markerClass} {
        position: fixed; box-sizing: border-box; width: 21px; height: 21px; padding: 0; margin: 0;
        display: grid; place-items: center; line-height: 1; color: #fff;
        font: 700 11px/1 ui-sans-serif, system-ui, -apple-system, sans-serif;
        border: 2px solid #fff; border-radius: 999px; background: #2563eb;
        box-shadow: 0 2px 8px rgba(15, 23, 42, 0.24); cursor: pointer; pointer-events: auto;
        transform: translate(-50%, -50%);
      }
      .${markerClass}:focus-visible { outline: 2px solid #0f766e; outline-offset: 2px; }
    `
    shadow.appendChild(style)
    markerLayer = document.createElement('div')
    markerLayer.className = 'layer'
    shadow.appendChild(markerLayer)
    document.documentElement.appendChild(host)
    return shadow
  }

  function ensureMarkerLayer(): HTMLDivElement {
    ensureShadow()
    return markerLayer!
  }

  function setHover(next: Element | null): void {
    if (hover === next) return
    hover?.classList.remove(hoverClass)
    hover = next
    hover?.classList.add(hoverClass)
  }

  function commentableElement(value: EventTarget | null): Element | null {
    let element = value instanceof Element ? value : null
    while (element && !isCommentable(element)) element = element.parentElement
    return element
  }

  function isCommentable(element: Element): boolean {
    const tag = element.tagName.toLowerCase()
    if (tag === 'html' || tag === 'head' || tag === 'body' || tag === 'script' || tag === 'style' || tag === 'noscript') {
      return false
    }
    // Marker bubbles live in a shadow root; a click on one retargets to the host.
    if (element.closest(`.${hostClass}`)) return false
    return true
  }

  function onMouseMove(event: MouseEvent): void {
    if (!pickMode) {
      setHover(null)
      return
    }
    setHover(commentableElement(event.target))
  }

  function onClick(event: MouseEvent): void {
    if (!pickMode) return
    const element = commentableElement(event.target)
    if (!element) return
    event.preventDefault()
    event.stopPropagation()
    const anchor = createAnchor(element)
    if (anchor) post({ t: 'gd:select', anchor })
  }

  function allIndexedElements(): Element[] {
    return Array.from(document.querySelectorAll('*')).filter((el) => {
      const tag = el.tagName.toLowerCase()
      return tag !== 'html' && tag !== 'head'
    })
  }

  function createAnchor(element: Element): RuntimeAnchor | null {
    const tag = element.tagName.toLowerCase()
    const indexed = allIndexedElements()
    const domHint = Math.max(0, indexed.indexOf(element))
    const fingerprint = fingerprintFor(element)
    const text = normalizeHtmlText(visibleText(element))
    const quote = quoteFor(text)
    const label = labelFor(tag, fingerprint, quote?.exact ?? text)
    return {
      schema: 1,
      path: canonicalPath(element),
      fingerprint,
      ...(quote ? { quote } : {}),
      domHint,
      label,
      status: 'anchored',
    }
  }

  function quoteFor(exact: string): RuntimeAnchor['quote'] | undefined {
    if (!exact) return undefined
    const docText = normalizeHtmlText(visibleText(document.body))
    const at = docText.indexOf(exact)
    return {
      exact,
      prefix: at === -1 ? '' : docText.slice(Math.max(0, at - 32), at),
      suffix: at === -1 ? '' : docText.slice(at + exact.length, at + exact.length + 32),
    }
  }

  function canonicalPath(element: Element): RuntimeAnchor['path'] {
    const stack: RuntimeAnchor['path'] = []
    for (let current: Element | null = element; current; current = current.parentElement) {
      const tag = current.tagName.toLowerCase()
      if (tag !== 'html' && tag !== 'head') stack.unshift(nodeStep(current))
    }
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

  function nodeStep(element: Element): RuntimeAnchor['path'][number] {
    const tag = element.tagName.toLowerCase()
    const fingerprint = fingerprintFor(element)
    return {
      tag,
      nthOfType: nthOfType(element),
      ...(fingerprint.id ? { id: fingerprint.id } : {}),
      ...(fingerprint.classesNorm && fingerprint.classesNorm.length > 0 ? { clsNorm: fingerprint.classesNorm.join('.') } : {}),
    }
  }

  function nthOfType(element: Element): number {
    const parent = element.parentElement
    if (!parent) return 1
    const tag = element.tagName.toLowerCase()
    let nth = 0
    for (const child of Array.from(parent.children)) {
      if (child.tagName.toLowerCase() === tag) nth++
      if (child === element) return nth
    }
    return Math.max(1, nth)
  }

  function fingerprintFor(element: Element): RuntimeAnchor['fingerprint'] {
    const tag = element.tagName.toLowerCase()
    const classesRaw = splitClasses(element.getAttribute('class'))
    const classesNorm = normalizeClassList(element.getAttribute('class') ?? '')
    const attrs = allowedAttrs(element)
    const id = cleanAttr(element.getAttribute('id'))
    const role = cleanAttr(element.getAttribute('role'))?.toLowerCase()
    const ariaLabel = cleanAttr(element.getAttribute('aria-label'))
    const name = cleanAttr(element.getAttribute('name'))
    return {
      tag,
      ...(id ? { id } : {}),
      ...(classesRaw.length > 0 ? { classesRaw } : {}),
      ...(classesNorm.length > 0 ? { classesNorm } : {}),
      ...(role ? { role } : {}),
      ...(ariaLabel ? { ariaLabel } : {}),
      ...(name ? { name } : {}),
      ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
    }
  }

  function allowedAttrs(element: Element): Record<string, string> {
    const out: Record<string, string> = {}
    for (const attr of Array.from(element.attributes)) {
      const name = attr.name.toLowerCase()
      const value = cleanAttr(attr.value)
      if (!value) continue
      if (name === 'type' || name === 'alt' || name.startsWith('data-')) out[name] = value
      else if (name === 'href') out.href = normalizeHref(value)
    }
    return out
  }

  function resolve(anchor: RuntimeAnchor): Element | null {
    const pathHit = pathCandidates(anchor.path)
    if (pathHit.length === 1) return pathHit[0]!
    if (anchor.fingerprint.id) {
      const byId = document.getElementById(anchor.fingerprint.id)
      if (byId && byId.tagName.toLowerCase() === anchor.fingerprint.tag) return byId
    }
    const quote = anchor.quote?.exact.trim()
    if (!quote) return null
    const candidates = allIndexedElements().filter(
      (element) => element.tagName.toLowerCase() === anchor.fingerprint.tag && normalizeHtmlText(visibleText(element)).includes(quote),
    )
    return candidates.length === 1 ? candidates[0]! : null
  }

  function pathCandidates(path: RuntimeAnchor['path']): Element[] {
    return allIndexedElements().filter((element) => pathsMatch(path, canonicalPath(element)))
  }

  function pathsMatch(anchorPath: RuntimeAnchor['path'], candidatePath: RuntimeAnchor['path']): boolean {
    if (anchorPath.length !== candidatePath.length) return false
    return anchorPath.every((step, i) => {
      const candidate = candidatePath[i]
      return (
        candidate !== undefined &&
        candidate.tag === step.tag &&
        candidate.nthOfType === step.nthOfType &&
        (step.id === undefined || step.id === candidate.id)
      )
    })
  }

  function setMarkers(next: Array<{ id: string; anchor: RuntimeAnchor; number?: number }>): void {
    for (const marker of markers.values()) {
      marker.element?.classList.remove(anchoredClass)
      marker.button.remove()
    }
    markers.clear()
    const layer = ensureMarkerLayer()
    const resolved: Array<{ id: string; status: 'anchored' | 'orphaned'; domHint?: number; label?: string }> = []
    for (const input of next) {
      const element = resolve(input.anchor)
      if (!element) {
        resolved.push({ id: input.id, status: 'orphaned', label: input.anchor.label })
        continue
      }
      element.classList.add(anchoredClass)
      const button = document.createElement('button')
      button.type = 'button'
      button.className = markerClass
      if (typeof input.number === 'number') button.textContent = String(input.number)
      button.setAttribute('aria-label', `Comment ${input.number ?? ''} on ${input.anchor.label}`)
      button.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        post({ t: 'gd:marker-click', id: input.id })
      })
      layer.appendChild(button)
      markers.set(input.id, { id: input.id, anchor: input.anchor, element, button })
      resolved.push({ id: input.id, status: 'anchored', domHint: input.anchor.domHint, label: input.anchor.label })
    }
    positionMarkers()
    post({ t: 'gd:markers-resolved', markers: resolved })
  }

  function positionMarkers(): void {
    for (const marker of markers.values()) {
      if (!marker.element?.isConnected) {
        marker.button.hidden = true
        continue
      }
      const rect = marker.element.getBoundingClientRect()
      marker.button.hidden = rect.width === 0 && rect.height === 0
      marker.button.style.left = `${Math.max(10, rect.right)}px`
      marker.button.style.top = `${Math.max(10, rect.top)}px`
    }
  }

  function focusMarker(id: string): void {
    const marker = markers.get(id)
    if (!marker?.element) return
    marker.element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' })
    marker.element.classList.add(focusClass)
    window.setTimeout(() => marker.element?.classList.remove(focusClass), 1600)
  }

  function onMessage(event: MessageEvent): void {
    const data = event.data
    if (!data || typeof data !== 'object' || data.version !== 1 || data.nonce !== nonce) return
    if (data.t === 'gd:set-mode') {
      pickMode = data.mode === 'pick'
      if (!pickMode) setHover(null)
    } else if (data.t === 'gd:set-markers' && Array.isArray(data.markers)) {
      setMarkers(data.markers)
    } else if (data.t === 'gd:focus-marker' && typeof data.id === 'string') {
      focusMarker(data.id)
    }
  }

  function normalizeHtmlText(text: string): string {
    return text.replace(/\s+/g, ' ').trim()
  }

  function visibleText(root: Node | null, hidden = false): string {
    if (!root) return ''
    if (root.nodeType === Node.TEXT_NODE) return hidden ? '' : root.textContent ?? ''
    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return ''
    const element = root instanceof Element ? root : null
    const tag = element?.tagName.toLowerCase()
    const nextHidden =
      hidden ||
      tag === 'script' ||
      tag === 'style' ||
      tag === 'noscript' ||
      element?.hasAttribute('hidden') === true ||
      element?.getAttribute('aria-hidden')?.toLowerCase() === 'true' ||
      /(?:^|;)\s*display\s*:\s*none\s*(?:;|$)/i.test(element?.getAttribute('style') ?? '') ||
      /(?:^|;)\s*visibility\s*:\s*hidden\s*(?:;|$)/i.test(element?.getAttribute('style') ?? '')
    return Array.from(root.childNodes)
      .map((child) => visibleText(child, nextHidden))
      .filter(Boolean)
      .join(' ')
  }

  function splitClasses(classAttr: string | null): string[] {
    return classAttr?.split(/\s+/).filter(Boolean) ?? []
  }

  function normalizeClassList(classAttr: string): string[] {
    const out = new Set<string>()
    for (const token of classAttr.split(/\s+/)) {
      const normalized = normalizeClassToken(token)
      if (normalized) out.add(normalized)
    }
    return Array.from(out).sort()
  }

  function normalizeClassToken(token: string): string | null {
    const trimmed = token.trim()
    if (!trimmed) return null
    const withoutModuleHash = trimmed.replace(/__[A-Za-z0-9_-]{5,}$/u, '').replace(/_[A-Fa-f0-9]{6,}$/u, '')
    const kebab = withoutModuleHash
      .replace(/([a-z0-9])([A-Z])/gu, '$1-$2')
      .replace(/_/gu, '-')
      .toLowerCase()
    if (!/[a-z]/u.test(kebab)) return null
    if (/^[a-f0-9]{6,}$/iu.test(kebab)) return null
    return kebab
  }

  function cleanAttr(value: string | null): string | undefined {
    const cleaned = value?.trim()
    return cleaned ? cleaned : undefined
  }

  function normalizeHref(href: string): string {
    if (href.startsWith('#')) return href
    const withoutFragment = href.split('#', 1)[0] ?? href
    const withoutQuery = withoutFragment.split('?', 1)[0] ?? withoutFragment
    const absolute = withoutQuery.match(/^[a-z][a-z0-9+.-]*:\/\/([^/]+)(\/.*)?$/iu)
    if (absolute) return `${absolute[1]!.toLowerCase()}${absolute[2] ?? '/'}`
    return withoutQuery || href
  }

  function labelFor(tag: string, fingerprint: RuntimeAnchor['fingerprint'], text: string): string {
    const attrs = fingerprint.attrs
    const candidate = fingerprint.ariaLabel ?? fingerprint.name ?? attrs?.alt ?? text
    const snippet = normalizeHtmlText(candidate).slice(0, 48)
    if (snippet) return `${tag} "${snippet}"`
    if (fingerprint.id) return `${tag}#${fingerprint.id}`
    return tag
  }

  ready(() => {
    installStyles()
    document.addEventListener('mousemove', onMouseMove, true)
    document.addEventListener('click', onClick, true)
    window.addEventListener('message', onMessage)
    window.addEventListener('scroll', positionMarkers, { passive: true })
    window.addEventListener('resize', positionMarkers)
    post({ t: 'gd:ready' })
  })
}
