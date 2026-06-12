// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type * as Y from 'yjs'
import type { Comment } from '@glyphdown/protocol'

/**
 * The full comment write path the mobile sheet depends on: pending composer
 * (quote preview → type → submit) and the doc-level composer. These are the
 * same components on desktop and mobile — the page only changes how the panel
 * is presented — so this covers "write and submit" for both.
 */

const api = vi.hoisted(() => ({
  createComment: vi.fn(),
  reattachComment: vi.fn(),
  replyToComment: vi.fn(),
  setCommentResolved: vi.fn(),
  toggleCommentReaction: vi.fn(),
}))
vi.mock('../../lib/api.ts', () => api)
vi.mock('../../lib/analytics.ts', () => ({ track: () => {} }))

import CommentsSidebar, { type PendingComment } from './CommentsSidebar.tsx'

const PENDING: PendingComment = {
  startRel: {} as Y.RelativePosition,
  endRel: {} as Y.RelativePosition,
  quote: 'the selected passage',
}

const CREATED: Comment = {
  id: 'c-1',
  anchor: null,
  authorId: 'user-1',
  authorName: 'Test User',
  body: 'Looks great',
  createdAt: Date.now(),
  resolved: false,
  reactions: {},
  replies: [],
}

let client: QueryClient
function Wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children)
}

function renderSidebar(overrides: Partial<Parameters<typeof CommentsSidebar>[0]> = {}) {
  return render(
    createElement(
      Wrapper,
      null,
      createElement(CommentsSidebar, {
        docId: 'doc-1',
        share: undefined,
        me: { id: 'user-1' },
        canComment: true,
        comments: [],
        members: [],
        resolveRange: () => null,
        activeCommentId: null,
        onSelect: () => {},
        pending: null,
        resolvePending: () => ({ start: 0, end: 20 }),
        onPendingDone: () => {},
        currentSelection: null,
        report: () => {},
        ...overrides,
      }),
    ),
  )
}

describe('CommentsSidebar composers', () => {
  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    api.createComment.mockResolvedValue(CREATED)
  })
  afterEach(() => {
    cleanup() // no vitest globals — testing-library's auto-cleanup never registers
    client.clear()
    vi.clearAllMocks()
  })

  it('submits a pending anchored comment: quote shown, button gated on text, range sent', async () => {
    const onPendingDone = vi.fn()
    renderSidebar({ pending: PENDING, onPendingDone })

    // The selection quote is previewed so the author knows what they anchor to.
    expect(screen.getByText(/the selected passage/)).toBeTruthy()

    const submit = screen.getByRole('button', { name: 'Comment' }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)

    fireEvent.change(screen.getByPlaceholderText('Comment… use @ to mention'), {
      target: { value: 'Looks great' },
    })
    expect(submit.disabled).toBe(false)
    fireEvent.click(submit)

    await waitFor(() => expect(onPendingDone).toHaveBeenCalledTimes(1))
    expect(api.createComment).toHaveBeenCalledWith(
      'doc-1',
      { body: 'Looks great', range: { start: 0, end: 20 } },
      undefined,
    )
  })

  it('reports instead of submitting when the anchored text no longer exists', async () => {
    const report = vi.fn()
    const onPendingDone = vi.fn()
    renderSidebar({ pending: PENDING, resolvePending: () => null, report, onPendingDone })

    fireEvent.change(screen.getByPlaceholderText('Comment… use @ to mention'), {
      target: { value: 'Too late' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }))

    await waitFor(() => expect(report).toHaveBeenCalledTimes(1))
    expect(api.createComment).not.toHaveBeenCalled()
    expect(onPendingDone).not.toHaveBeenCalled()
  })

  it('submits a doc-level comment without any text selection', async () => {
    renderSidebar()

    // No selection needed — the doc-level composer is the always-available
    // entry point (the one a phone user can reach without fiddly selection).
    fireEvent.click(screen.getByRole('button', { name: /Comment on the document/ }))
    fireEvent.change(screen.getByPlaceholderText('Comment on the whole document…'), {
      target: { value: 'Ship it' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }))

    await waitFor(() =>
      expect(api.createComment).toHaveBeenCalledWith('doc-1', { body: 'Ship it' }, undefined),
    )
  })
})
