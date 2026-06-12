import { useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type * as Y from 'yjs'
import { CheckCircle2, CornerDownRight, Link2, MessageSquareText, RotateCcw, Unlink } from 'lucide-react'
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
import { renderMentions, timeAgo } from '../../lib/presence.ts'
import { useDismissable } from '../../lib/useDismissable.ts'
import { Button, EmptyState } from '../ui.tsx'
import MentionTextarea from '../MentionTextarea.tsx'
import { commentsKey } from './DocEditorPage.tsx'

export interface PendingComment {
  startRel: Y.RelativePosition
  endRel: Y.RelativePosition
  quote: string
}

const EMOJI = ['👍', '❤️', '🎉', '👀', '😄'] as const

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
  const [newBody, setNewBody] = useState('')
  const [docComposerOpen, setDocComposerOpen] = useState(false)
  const [docBody, setDocBody] = useState('')
  const [showResolved, setShowResolved] = useState(false)

  const nameFor = (id: string) => members.find((m) => m.principalId === id)?.name

  const upsert = (comment: Comment) =>
    queryClient.setQueryData<Comment[]>(commentsKey(docId), (old) => {
      const next = [...(old ?? [])]
      const idx = next.findIndex((c) => c.id === comment.id)
      if (idx >= 0) next[idx] = comment
      else next.push(comment)
      return next
    })

  const grouped = useMemo(() => {
    const anchored: Array<{ comment: Comment; range: Range }> = []
    const docLevel: Comment[] = []
    const orphaned: Comment[] = []
    const resolved: Comment[] = []
    for (const comment of comments) {
      if (comment.resolved) {
        resolved.push(comment)
        continue
      }
      if (comment.anchor === null) {
        docLevel.push(comment)
        continue
      }
      const range = comment.anchor.status === 'anchored' ? resolveRange(comment.anchor) : null
      if (range && range.end > range.start) anchored.push({ comment, range })
      else orphaned.push(comment)
    }
    anchored.sort((a, b) => a.range.start - b.range.start)
    return { anchored, docLevel, orphaned, resolved }
  }, [comments, resolveRange])

  const submitPending = async () => {
    if (!pending || newBody.trim() === '') return
    const range = resolvePending(pending)
    try {
      if (!range) throw new Error('The selected text no longer exists — select again.')
      const created = await createComment(docId, { body: newBody.trim(), range }, share)
      track('comment_created', { docId, kind: 'anchored' })
      upsert(created)
      setNewBody('')
      onPendingDone()
    } catch (err) {
      report(err)
    }
  }

  const submitDocLevel = async () => {
    if (docBody.trim() === '') return
    try {
      const created = await createComment(docId, { body: docBody.trim() }, share)
      track('comment_created', { docId, kind: 'doc-level' })
      upsert(created)
      setDocBody('')
      setDocComposerOpen(false)
    } catch (err) {
      report(err)
    }
  }

  const actions = {
    reply: async (comment: Comment, body: string) => {
      try {
        const reply = await replyToComment(docId, comment.id, body, share)
        track('comment_created', { docId, kind: 'reply' })
        upsert({ ...comment, replies: [...comment.replies, reply] })
      } catch (err) {
        report(err)
      }
    },
    toggleResolve: async (comment: Comment) => {
      try {
        const { resolved } = await setCommentResolved(docId, comment.id, !comment.resolved, share)
        upsert({ ...comment, resolved })
      } catch (err) {
        report(err)
      }
    },
    react: async (comment: Comment, emoji: string) => {
      try {
        const updated = await toggleCommentReaction(docId, comment.id, emoji, share)
        upsert(updated)
      } catch (err) {
        report(err)
      }
    },
    reattach: async (comment: Comment) => {
      if (!currentSelection || currentSelection.to - currentSelection.from < 8) return
      try {
        const updated = await reattachComment(
          docId,
          comment.id,
          { start: currentSelection.from, end: currentSelection.to },
          share,
        )
        upsert(updated)
      } catch (err) {
        report(err)
      }
    },
  }

  const canReattach = currentSelection !== null && currentSelection.to - currentSelection.from >= 8

  return (
    <div className="flex flex-col gap-3 p-3">
      {pending ? (
        <div className="rounded-lg border border-[var(--accent)] bg-[var(--accent-soft)] p-2.5">
          <p className="m-0 mb-2 border-l-2 border-[var(--accent)] pl-2 text-xs italic text-[var(--ink-soft)]">
            “{pending.quote.length > 80 ? `${pending.quote.slice(0, 80)}…` : pending.quote}”
          </p>
          <MentionTextarea value={newBody} onChange={setNewBody} members={members} placeholder="Comment… use @ to mention" autoFocus onSubmit={() => void submitPending()} />
          <div className="mt-2 flex justify-end gap-2">
            <Button
              size="sm"
              onClick={() => {
                setNewBody('')
                onPendingDone()
              }}
            >
              Cancel
            </Button>
            <Button size="sm" variant="primary" disabled={newBody.trim() === ''} onClick={() => void submitPending()}>
              Comment
            </Button>
          </div>
        </div>
      ) : null}

      {canComment && !docComposerOpen ? (
        <Button size="sm" variant="ghost" onClick={() => setDocComposerOpen(true)} className="self-start">
          <MessageSquareText size={13} /> Comment on the document
        </Button>
      ) : null}
      {docComposerOpen ? (
        <div className="rounded-lg border border-[var(--line)] p-2.5">
          <MentionTextarea value={docBody} onChange={setDocBody} members={members} placeholder="Comment on the whole document…" autoFocus onSubmit={() => void submitDocLevel()} />
          <div className="mt-2 flex justify-end gap-2">
            <Button size="sm" onClick={() => setDocComposerOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" disabled={docBody.trim() === ''} onClick={() => void submitDocLevel()}>
              Comment
            </Button>
          </div>
        </div>
      ) : null}

      {comments.length === 0 && !pending ? (
        <EmptyState
          title="No comments yet"
          hint={canComment ? 'Select at least 8 characters of text to add an anchored comment.' : 'Sign in with comment access to join the discussion.'}
        />
      ) : null}

      {grouped.anchored.map(({ comment }) => (
        <Thread
          key={comment.id}
          comment={comment}
          me={me}
          members={members}
          nameFor={nameFor}
          active={comment.id === activeCommentId}
          canComment={canComment}
          onSelect={() => onSelect(comment)}
          actions={actions}
          quote={comment.anchor?.quote.exact ?? ''}
        />
      ))}

      {grouped.docLevel.length > 0 ? (
        <>
          <h3 className="island-kicker m-0 mt-2">Document</h3>
          {grouped.docLevel.map((comment) => (
            <Thread
              key={comment.id}
              comment={comment}
              me={me}
              members={members}
              nameFor={nameFor}
              active={comment.id === activeCommentId}
              canComment={canComment}
              onSelect={() => onSelect(comment)}
              actions={actions}
            />
          ))}
        </>
      ) : null}

      {grouped.orphaned.length > 0 ? (
        <>
          <h3 className="island-kicker m-0 mt-2 flex items-center gap-1">
            <Unlink size={11} /> Orphaned
          </h3>
          <p className="m-0 -mt-1 text-[11px] text-[var(--ink-faint)]">
            The text these comments were anchored to was removed or rewritten.
          </p>
          {grouped.orphaned.map((comment) => (
            <Thread
              key={comment.id}
              comment={comment}
              me={me}
              members={members}
              nameFor={nameFor}
              active={comment.id === activeCommentId}
              canComment={canComment}
              onSelect={() => onSelect(comment)}
              actions={actions}
              quote={comment.anchor?.quote.exact ?? ''}
              orphaned
              canReattach={canComment && canReattach}
            />
          ))}
        </>
      ) : null}

      {grouped.resolved.length > 0 ? (
        <>
          <button
            type="button"
            onClick={() => setShowResolved((v) => !v)}
            className="island-kicker mt-2 flex items-center gap-1 self-start"
          >
            <CheckCircle2 size={11} /> Resolved ({grouped.resolved.length}) {showResolved ? '▾' : '▸'}
          </button>
          {showResolved
            ? grouped.resolved.map((comment) => (
                <Thread
                  key={comment.id}
                  comment={comment}
                  me={me}
                  members={members}
                  nameFor={nameFor}
                  active={comment.id === activeCommentId}
                  canComment={canComment}
                  onSelect={() => onSelect(comment)}
                  actions={actions}
                  quote={comment.anchor?.quote.exact ?? ''}
                  resolved
                />
              ))
            : null}
        </>
      ) : null}
    </div>
  )
}

function Thread({
  comment,
  me,
  members,
  nameFor,
  active,
  canComment,
  onSelect,
  actions,
  quote,
  orphaned,
  resolved,
  canReattach,
}: {
  comment: Comment
  me: { id: string } | null
  members: MemberInfo[]
  nameFor: (id: string) => string | undefined
  active: boolean
  canComment: boolean
  onSelect: () => void
  actions: {
    reply: (comment: Comment, body: string) => Promise<void>
    toggleResolve: (comment: Comment) => Promise<void>
    react: (comment: Comment, emoji: string) => Promise<void>
    reattach: (comment: Comment) => Promise<void>
  }
  quote?: string
  orphaned?: boolean
  resolved?: boolean
  canReattach?: boolean
}) {
  const [replyOpen, setReplyOpen] = useState(false)
  const [replyBody, setReplyBody] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)

  // Tapping highlighted text activates its thread; make sure that thread is
  // actually visible in the panel (it matters most in the mobile sheet, where
  // only a few cards fit).
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // Optional call: jsdom has no scrollIntoView.
    if (active) rootRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [active])

  const submitReply = async () => {
    if (replyBody.trim() === '') return
    await actions.reply(comment, replyBody.trim())
    setReplyBody('')
    setReplyOpen(false)
  }

  return (
    <div
      ref={rootRef}
      className={`rounded-lg border p-2.5 transition ${
        active ? 'border-[var(--accent)] shadow-sm' : 'border-[var(--line)]'
      } ${resolved ? 'opacity-70' : ''}`}
      onClick={onSelect}
    >
      {quote ? (
        <p className={`m-0 mb-1.5 truncate border-l-2 pl-2 text-[11px] italic text-[var(--ink-faint)] ${orphaned ? 'border-red-300 line-through' : 'border-amber-300'}`}>
          “{quote}”
        </p>
      ) : null}

      <div className="mb-1 flex items-baseline gap-2">
        <span className="text-xs font-semibold text-[var(--ink)]">{comment.authorName}</span>
        <span className="text-[10px] text-[var(--ink-faint)]">{timeAgo(comment.createdAt)}</span>
      </div>
      <p className="m-0 whitespace-pre-wrap text-sm text-[var(--ink)]">
        {renderMentions(comment.body, nameFor)}
      </p>

      <Reactions comment={comment} me={me} canComment={canComment} pickerOpen={pickerOpen} setPickerOpen={setPickerOpen} onReact={(emoji) => void actions.react(comment, emoji)} />

      {comment.replies.length > 0 ? (
        <div className="mt-2 flex flex-col gap-2 border-l border-[var(--line)] pl-2.5">
          {comment.replies.map((reply) => (
            <div key={reply.id}>
              <div className="flex items-baseline gap-2">
                <span className="text-xs font-semibold text-[var(--ink)]">{reply.authorName}</span>
                <span className="text-[10px] text-[var(--ink-faint)]">{timeAgo(reply.createdAt)}</span>
              </div>
              <p className="m-0 whitespace-pre-wrap text-sm text-[var(--ink)]">{renderMentions(reply.body, nameFor)}</p>
            </div>
          ))}
        </div>
      ) : null}

      {canComment ? (
        // Touch widths: the [11px] text links get taller/wider hit areas
        // (negative margins keep the card's visual rhythm).
        <div className="mt-2 flex items-center gap-2 max-lg:gap-3" onClick={(e) => e.stopPropagation()}>
          {!replyOpen ? (
            <button type="button" onClick={() => setReplyOpen(true)} className="flex items-center gap-1 text-[11px] font-medium text-[var(--ink-faint)] hover:text-[var(--ink)] max-lg:-mx-1.5 max-lg:-my-1.5 max-lg:px-1.5 max-lg:py-2 max-lg:text-xs">
              <CornerDownRight size={11} /> Reply
            </button>
          ) : null}
          <button type="button" onClick={() => void actions.toggleResolve(comment)} className="flex items-center gap-1 text-[11px] font-medium text-[var(--ink-faint)] hover:text-[var(--ink)] max-lg:-mx-1.5 max-lg:-my-1.5 max-lg:px-1.5 max-lg:py-2 max-lg:text-xs">
            {comment.resolved ? (
              <>
                <RotateCcw size={11} /> Reopen
              </>
            ) : (
              <>
                <CheckCircle2 size={11} /> Resolve
              </>
            )}
          </button>
          {orphaned ? (
            <button
              type="button"
              disabled={!canReattach}
              onClick={() => void actions.reattach(comment)}
              title={canReattach ? 'Re-attach to the current selection' : 'Select at least 8 characters in the document first'}
              className="flex items-center gap-1 text-[11px] font-medium text-[var(--accent)] disabled:opacity-40 max-lg:-mx-1.5 max-lg:-my-1.5 max-lg:px-1.5 max-lg:py-2 max-lg:text-xs"
            >
              <Link2 size={11} /> Re-attach to selection
            </button>
          ) : null}
        </div>
      ) : null}

      {replyOpen ? (
        <div className="mt-2" onClick={(e) => e.stopPropagation()}>
          <MentionTextarea value={replyBody} onChange={setReplyBody} members={members} placeholder="Reply… use @ to mention" autoFocus onSubmit={() => void submitReply()} />
          <div className="mt-1.5 flex justify-end gap-2">
            <Button size="sm" onClick={() => setReplyOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" disabled={replyBody.trim() === ''} onClick={() => void submitReply()}>
              Reply
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function Reactions({
  comment,
  me,
  canComment,
  pickerOpen,
  setPickerOpen,
  onReact,
}: {
  comment: Comment
  me: { id: string } | null
  canComment: boolean
  pickerOpen: boolean
  setPickerOpen: (open: boolean) => void
  onReact: (emoji: string) => void
}) {
  const pickerRef = useRef<HTMLDivElement>(null)
  useDismissable(pickerOpen, pickerRef, () => setPickerOpen(false))

  const entries = Object.entries(comment.reactions).filter(([, ids]) => ids.length > 0)
  if (entries.length === 0 && !canComment) return null
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1" onClick={(e) => e.stopPropagation()}>
      {entries.map(([emoji, ids]) => (
        <button
          key={emoji}
          type="button"
          disabled={!canComment}
          onClick={() => onReact(emoji)}
          className={`rounded-full border px-1.5 py-0.5 text-[11px] max-lg:px-2.5 max-lg:py-1.5 max-lg:text-xs ${
            me && ids.includes(me.id)
              ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
              : 'border-[var(--line)] bg-[var(--paper-soft)]'
          }`}
          title={`${ids.length}`}
        >
          {emoji} {ids.length}
        </button>
      ))}
      {canComment ? (
        <div className="relative" ref={pickerRef}>
          <button
            type="button"
            onClick={() => setPickerOpen(!pickerOpen)}
            className="rounded-full border border-dashed border-[var(--line)] px-1.5 py-0.5 text-[11px] text-[var(--ink-faint)] hover:text-[var(--ink)] max-lg:px-2.5 max-lg:py-1.5 max-lg:text-xs"
            title="Add reaction"
          >
            +🙂
          </button>
          {pickerOpen ? (
            <div className="absolute left-0 top-full z-20 mt-1 flex gap-1 rounded-md border border-[var(--line)] bg-[var(--paper)] p-1 shadow-md">
              {EMOJI.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  className="rounded px-1 py-0.5 text-sm hover:bg-[var(--paper-soft)] max-lg:px-2 max-lg:py-1.5 max-lg:text-base"
                  onClick={() => {
                    onReact(emoji)
                    setPickerOpen(false)
                  }}
                >
                  {emoji}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
