import { useCallback, useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type * as Y from 'yjs'
import type { Comment } from '@glyphdown/protocol'
import type { Anchor, Range } from '@glyphdown/core'
import {
  createComment,
  reattachComment,
  replyToComment,
  setCommentResolved,
  toggleCommentReaction,
  type MemberInfo,
} from '../../lib/api.ts'
import { track } from '../../lib/analytics.ts'
import CommentThreadList, {
  type CommentAnchorPreview,
  type CommentThreadDescriptor,
  type CommentThreadService,
} from './CommentThreadList.tsx'
import { commentsKey } from './DocEditorPage.tsx'

export interface PendingComment {
  startRel: Y.RelativePosition
  endRel: Y.RelativePosition
  quote: string
}

interface Props {
  docId: string
  share: string | undefined
  me: { id: string } | null
  canComment: boolean
  comments: Comment[]
  members: MemberInfo[]
  resolveRange: (anchor: Anchor) => Range | null
  activeCommentId: string | null
  onSelect: (comment: Comment) => void
  pending: PendingComment | null
  resolvePending: (pending: PendingComment) => { start: number; end: number } | null
  onPendingDone: () => void
  currentSelection: { from: number; to: number } | null
  report: (err: unknown) => void
}

export default function CommentsSidebar({
  docId,
  share,
  me,
  canComment,
  comments,
  members,
  resolveRange,
  activeCommentId,
  onSelect,
  pending,
  resolvePending,
  onPendingDone,
  currentSelection,
  report,
}: Props) {
  const queryClient = useQueryClient()

  const upsert = useCallback(
    (comment: Comment) =>
      queryClient.setQueryData<Comment[]>(commentsKey(docId), (old) => {
        const next = [...(old ?? [])]
        const idx = next.findIndex((c) => c.id === comment.id)
        if (idx >= 0) next[idx] = comment
        else next.push(comment)
        return next
      }),
    [docId, queryClient],
  )

  const service = useMemo<CommentThreadService<PendingComment>>(
    () => ({
      upsert,
      createPending: async (pendingComment, body) => {
        const range = resolvePending(pendingComment)
        if (!range) throw new Error('The selected text no longer exists — select again.')
        const created = await createComment(docId, { body, range }, share)
        track('comment_created', { docId, kind: 'anchored' })
        return created
      },
      createDocument: async (body) => {
        const created = await createComment(docId, { body }, share)
        track('comment_created', { docId, kind: 'doc-level' })
        return created
      },
      reply: async (comment, body) => {
        const reply = await replyToComment(docId, comment.id, body, share)
        track('comment_created', { docId, kind: 'reply' })
        return { ...comment, replies: [...comment.replies, reply] }
      },
      toggleResolve: async (comment) => {
        const { resolved } = await setCommentResolved(docId, comment.id, !comment.resolved, share)
        return { ...comment, resolved }
      },
      react: (comment, emoji) => toggleCommentReaction(docId, comment.id, emoji, share),
      reattach: async (comment) => {
        if (!currentSelection || currentSelection.to - currentSelection.from < 8) return null
        return reattachComment(
          docId,
          comment.id,
          { start: currentSelection.from, end: currentSelection.to },
          share,
        )
      },
    }),
    [currentSelection, docId, resolvePending, share, upsert],
  )

  const describeComment = useCallback(
    (comment: Comment): CommentThreadDescriptor => {
      if (comment.anchor === null) return { bucket: 'document' }
      const quote = comment.anchor.quote.exact
      const preview: CommentAnchorPreview = { quote }
      const range = comment.anchor.status === 'anchored' ? resolveRange(comment.anchor) : null
      if (range && range.end > range.start) return { bucket: 'anchored', sortKey: range.start, preview }
      return { bucket: 'orphaned', preview: { ...preview, orphaned: true } }
    },
    [resolveRange],
  )

  const pendingPreview = useCallback((pendingComment: PendingComment): CommentAnchorPreview => ({ quote: pendingComment.quote }), [])
  const canReattach = currentSelection !== null && currentSelection.to - currentSelection.from >= 8

  return (
    <CommentThreadList
      comments={comments}
      me={me}
      canComment={canComment}
      members={members}
      activeCommentId={activeCommentId}
      onSelect={onSelect}
      pending={pending}
      pendingPreview={pendingPreview}
      onPendingDone={onPendingDone}
      describeComment={describeComment}
      service={service}
      report={report}
      emptyHint={canComment ? 'Select at least 8 characters of text to add an anchored comment.' : 'Sign in with comment access to join the discussion.'}
      documentLabel="Document"
      documentActionLabel="Comment on the document"
      documentPlaceholder="Comment on the whole document…"
      orphanedDescription="The text these comments were anchored to was removed or rewritten."
      canReattach={() => canComment && canReattach}
      reattachTitle={() => (canReattach ? 'Re-attach to the current selection' : 'Select at least 8 characters in the document first')}
    />
  )
}
