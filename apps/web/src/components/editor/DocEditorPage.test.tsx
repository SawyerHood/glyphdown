// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

/**
 * Regression test for the doc→home navigation hang (fix/home-navigation-hang).
 *
 * The seamless-doc-switching restructure (commit 57a4f44) made DocEditorPage
 * persistent and drove provider rebuilds from a real dependency array. The
 * doc→home transition fully UNMOUNTS the page — a path the doc→doc lane never
 * exercised. This test mounts the page, lets the provider sync, then unmounts
 * it (the "navigate to home" case) and asserts the effect work is BOUNDED:
 *
 *  - the provider (the per-doc machinery the suspect effect builds) is created
 *    a bounded number of times — an effect/render loop would rebuild it
 *    unboundedly (and React would throw "Maximum update depth exceeded");
 *  - teardown is balanced: every provider/editor created is destroyed on
 *    unmount, so the route exit completes (no leaked Yjs/WebSocket machinery).
 */

// Shared, mutable counters + mock classes. Hoisted so the vi.mock factories
// (which are themselves hoisted above the imports) can close over them.
const h = vi.hoisted(() => {
  const counters = { providerCreated: 0, providerDestroyed: 0, viewCreated: 0, viewDestroyed: 0 }
  const flags = { throwOnViewDestroy: false }
  let lastProvider: FakeProvider | null = null

  class FakeAwareness {
    on() {}
    off() {}
    getStates() {
      return new Map()
    }
    setLocalStateField() {}
    setLocalState() {}
  }
  class FakeProvider {
    awareness = new FakeAwareness()
    private handlers = new Map<string, Set<(...a: unknown[]) => void>>()
    constructor() {
      counters.providerCreated += 1
      lastProvider = this
    }
    on(event: string, cb: (...a: unknown[]) => void) {
      if (!this.handlers.has(event)) this.handlers.set(event, new Set())
      this.handlers.get(event)!.add(cb)
    }
    off(event: string, cb: (...a: unknown[]) => void) {
      this.handlers.get(event)?.delete(cb)
    }
    emit(event: string, ...args: unknown[]) {
      for (const cb of this.handlers.get(event) ?? []) cb(...args)
    }
    sendMessage() {}
    disconnect() {}
    destroy() {
      counters.providerDestroyed += 1
    }
  }

  class EditorView {
    state = { doc: { length: 0 }, selection: { main: { empty: true, from: 0, to: 0, head: 0 } } }
    scrollDOM = document.createElement('div')
    constructor(opts: { parent?: HTMLElement }) {
      counters.viewCreated += 1
      opts.parent?.appendChild(document.createElement('div'))
    }
    dispatch() {}
    focus() {}
    coordsAtPos() {
      return null
    }
    destroy() {
      counters.viewDestroyed += 1
      if (flags.throwOnViewDestroy) throw new Error('simulated CodeMirror plugin teardown error')
    }
    static lineWrapping = []
    static editable = { of: () => [] }
    static updateListener = { of: () => [] }
    static domEventHandlers = () => []
  }

  return { counters, flags, FakeProvider, EditorView, getLastProvider: () => lastProvider }
})

vi.mock('y-partyserver/provider', () => ({ default: h.FakeProvider }))
vi.mock('@codemirror/view', () => ({ EditorView: h.EditorView, keymap: { of: () => [] } }))
vi.mock('@codemirror/state', () => {
  class Compartment {
    of() {
      return []
    }
    reconfigure() {
      return {}
    }
  }
  return {
    Compartment,
    EditorSelection: { cursor: () => ({}) },
    EditorState: { create: () => ({}), readOnly: { of: () => [] } },
  }
})
vi.mock('@codemirror/commands', () => ({ defaultKeymap: [] }))

// Editor package: all extensions collapse to no-ops.
vi.mock('@glyphdown/editor', () => ({
  createSuggestMode: () => ({ extension: [], flush: () => {} }),
  dispatchDocAnnotations: () => {},
  docAnnotations: () => [],
  imageResolver: { of: () => [] },
  glyphdownCollab: () => [],
  glyphdownHighlighting: () => [],
  glyphdownMarkdown: () => [],
  glyphdownTheme: [],
  livePreview: () => [],
  markdownAutoClose: () => [],
  markdownTab: () => [],
  refreshWikiLinksEffect: { of: () => ({}) },
  wikiLinkContext: { of: () => [] },
  wikiLinks: () => [],
}))
vi.mock('@glyphdown/core', () => ({ resolveAnchor: () => null }))
vi.mock('./imageUpload.ts', () => ({ imageUpload: () => [] }))

// Sub-panels (only render with the sidebar open; stubbed regardless).
vi.mock('./CommentsSidebar.tsx', () => ({ default: () => null }))
vi.mock('./SuggestionsPanel.tsx', () => ({ default: () => null }))
vi.mock('./ShareDialog.tsx', () => ({ default: () => null }))
vi.mock('./BacklinksPanel.tsx', () => ({ default: () => null }))

// Router: no real navigation in a unit test.
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => () => {},
  Link: ({ children }: { children?: ReactNode }) => createElement('a', null, children),
}))

// Api: resolve immediately so the queries settle and the suspect effect runs.
const DOC_META = {
  id: 'doc-1',
  title: 'test-doc',
  filename: 'test-doc.md',
  folderId: null,
  ownerUserId: 'user-1',
  role: 'owner' as const,
  createdAt: 0,
  updatedAt: 0,
}
const ME = { id: 'user-1', name: 'Test User', type: 'user' as const }
vi.mock('../../lib/api.ts', () => ({
  ApiError: class ApiError extends Error {
    code?: string
    status?: number
  },
  fetchMe: () => Promise.resolve(ME),
  getDoc: () => Promise.resolve(DOC_META),
  listComments: () => Promise.resolve([]),
  listSuggestions: () => Promise.resolve([]),
  listMembers: () => Promise.resolve([]),
  listDocs: () => Promise.resolve([]),
  assetUrl: () => '',
  createDoc: () => Promise.resolve(DOC_META),
  createNamedVersion: () => Promise.resolve({}),
  patchDoc: () => Promise.resolve(DOC_META),
}))

// Imported after the mocks are registered.
import { DocEditorPage } from './DocEditorPage.tsx'

// One QueryClient per test, created OUTSIDE render so re-renders don't reset it.
let client: QueryClient
function Wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children)
}

const settle = () => waitFor(() => expect(h.counters.providerCreated).toBeGreaterThanOrEqual(1))

describe('DocEditorPage mount → home-like unmount (no infinite loop)', () => {
  beforeEach(() => {
    h.counters.providerCreated = 0
    h.counters.providerDestroyed = 0
    h.counters.viewCreated = 0
    h.counters.viewDestroyed = 0
    h.flags.throwOnViewDestroy = false
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  })
  afterEach(() => {
    client.clear()
    vi.clearAllMocks()
  })

  it('builds the per-doc provider exactly once and tears it all down on unmount (doc→home)', async () => {
    const view = render(
      createElement(Wrapper, null, createElement(DocEditorPage, { docId: 'doc-1', share: undefined })),
    )
    await settle()

    // The suspect effect builds the per-doc machinery once. A render/effect
    // loop would rebuild it unboundedly (and React would have thrown
    // "Maximum update depth exceeded" before we got here).
    expect(h.counters.providerCreated).toBe(1)
    expect(h.counters.viewCreated).toBe(1)

    // First sync (skeleton → editor crossfade) must not trigger a rebuild.
    await act(async () => {
      h.getLastProvider()?.emit('synced')
      await Promise.resolve()
    })
    expect(h.counters.providerCreated).toBe(1)

    // Navigate to home: the persistent route unmounts entirely. Teardown must
    // complete — every provider/view created is destroyed (no leaked Yjs /
    // WebSocket / CodeMirror machinery surviving the route exit).
    act(() => {
      view.unmount()
    })
    expect(h.counters.providerDestroyed).toBe(1)
    expect(h.counters.viewDestroyed).toBe(1)
  })

  it('rebuilds once per doc on a doc→doc switch, with balanced teardown', async () => {
    const view = render(
      createElement(Wrapper, null, createElement(DocEditorPage, { docId: 'doc-1', share: undefined })),
    )
    await settle()
    expect(h.counters.providerCreated).toBe(1)

    // doc→doc: the persistent component keeps mounting; only the per-doc
    // machinery rebuilds. Old provider torn down, new one built — exactly one
    // each, no accumulation.
    await act(async () => {
      view.rerender(
        createElement(Wrapper, null, createElement(DocEditorPage, { docId: 'doc-2', share: undefined })),
      )
      await Promise.resolve()
    })
    await waitFor(() => expect(h.counters.providerCreated).toBe(2))
    expect(h.counters.providerDestroyed).toBe(1) // doc-1's provider gone

    // Now doc→home.
    act(() => {
      view.unmount()
    })
    expect(h.counters.providerDestroyed).toBe(2)
    expect(h.counters.viewDestroyed).toBe(h.counters.viewCreated)
  })

  it('destroys the provider on route exit even if view teardown throws (no orphaned reconnect loop)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.flags.throwOnViewDestroy = true

    const view = render(
      createElement(Wrapper, null, createElement(DocEditorPage, { docId: 'doc-1', share: undefined })),
    )
    await settle()
    expect(h.counters.providerCreated).toBe(1)

    // doc→home unmount: view.destroy() throws, but the provider (the thing
    // that holds the live WebSocket + reconnect timer) MUST still be torn
    // down — otherwise it is orphaned and keeps reconnecting forever.
    act(() => {
      view.unmount()
    })
    expect(h.counters.viewDestroyed).toBe(1) // attempted (and threw)
    expect(h.counters.providerDestroyed).toBe(1) // still destroyed despite the throw

    errorSpy.mockRestore()
  })
})
