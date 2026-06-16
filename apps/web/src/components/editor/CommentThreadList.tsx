import { useEffect, useMemo, useRef, useState } from 'react'
import { CheckCircle2, CornerDownRight, Link2, MessageSquareText, RotateCcw, Unlink } from 'lucide-react'
import type { Comment } from '@glyphdown/protocol'
import type { MemberInfo } from '../../lib/api.ts'
import { renderMentions, timeAgo } from '../../lib/presence.ts'
import { useDismissable } from '../../lib/useDismissable.ts'
import { Button, EmptyState } from '../ui.tsx'
import MentionTextarea from '../MentionTextarea.tsx'

const EMOJI = ['👍', '❤️', '🎉', '👀', '😄'] as const

export interface CommentAnchorPreview {
  label?: string
  quote?: string
  orphaned?: boolean
}

export interface CommentThreadDescriptor {
  bucket: 'anchored' | 'document' | 'orphaned'
  sortKey?: number
  /** 1..N badge that lines up with the in-document marker bubble. */
  markerNumber?: number
  preview?: CommentAnchorPreview
}

export interface CommentThreadService<TPending> {
  createPending: (pending: TPending, body: string) => Promise<Comment>
  createDocument: (body: string) => Promise<Comment>
  reply: (comment: Comment, body: string) => Promise<Comment>
  toggleResolve: (comment: Comment) => Promise<Comment>
  react: (comment: Comment, emoji: string) => Promise<Comment>
  reattach?: (comment: Comment) => Promise<Comment | null | undefined>
  upsert: (comment: Comment) => void
}

export interface CommentThreadListProps<TPending> {
  comments: Comment[]
  me: { id: string } | null
  canComment: boolean
  members: MemberInfo[]
  activeCommentId: string | null
  onSelect: (comment: Comment) => void
  pending: TPending | null
  pendingPreview: (pending: TPending) => CommentAnchorPreview
  onPendingDone: () => void
  describeComment: (comment: Comment) => CommentThreadDescriptor
  service: CommentThreadService<TPending>
  report: (err: unknown) => void
  emptyHint: string
  /** Header over the anchored group (e.g. "On elements" for HTML). Omitted = no header. */
  anchoredLabel?: string
  documentLabel: string
  documentActionLabel: string
  documentPlaceholder: string
  orphanedDescription: string
  canReattach?: (comment: Comment) => boolean
  reattachTitle?: (comment: Comment) => string
}

export default function CommentThreadList<TPending>({
  comments,
  me,
  canComment,
  members,
  activeCommentId,
  onSelect,
  pending,
  pendingPreview,
  onPendingDone,
  describeComment,
  service,
  report,
  emptyHint,
  anchoredLabel,
  documentLabel,
  documentActionLabel,
  documentPlaceholder,
  orphanedDescription,
  canReattach,
  reattachTitle,
}: CommentThreadListProps<TPending>) {
  const [newBody, setNewBody] = useState('')
  const [docComposerOpen, setDocComposerOpen] = useState(false)
  const [docBody, setDocBody] = useState('')
  const [showResolved, setShowResolved] = useState(false)

  const nameFor = (id: string) => members.find((m) => m.principalId === id)?.name

  const grouped = useMemo(() => {
    const anchored: ThreadModel[] = []
    const document: ThreadModel[] = []
    const orphaned: ThreadModel[] = []
    const resolved: ThreadModel[] = []
    for (const comment of comments) {
      const descriptor = describeComment(comment)
      const model = {
        comment,
        preview: descriptor.preview,
        sortKey: descriptor.sortKey ?? Number.MAX_SAFE_INTEGER,
        markerNumber: descriptor.markerNumber,
      }
      if (comment.resolved) {
        resolved.push(model)
        continue
      }
      if (descriptor.bucket === 'document') document.push(model)
      else if (descriptor.bucket === 'orphaned') orphaned.push(model)
      else anchored.push(model)
    }
    anchored.sort(compareThreads)
    document.sort(compareThreads)
    orphaned.sort(compareThreads)
    resolved.sort(compareThreads)
    return { anchored, document, orphaned, resolved }
  }, [comments, describeComment])

  const submitPending = async () => {
    if (!pending || newBody.trim() === '') return
    try {
      const created = await service.createPending(pending, newBody.trim())
      service.upsert(created)
      setNewBody('')
      onPendingDone()
    } catch (err) {
      report(err)
    }
  }

  const submitDocLevel = async () => {
    if (docBody.trim() === '') return
    try {
      const created = await service.createDocument(docBody.trim())
      service.upsert(created)
      setDocBody('')
      setDocComposerOpen(false)
    } catch (err) {
      report(err)
    }
  }

  const actions = {
    reply: async (comment: Comment, body: string) => {
      try {
        const updated = await service.reply(comment, body)
        service.upsert(updated)
      } catch (err) {
        report(err)
      }
    },
    toggleResolve: async (comment: Comment) => {
      try {
        const updated = await service.toggleResolve(comment)
        service.upsert(updated)
      } catch (err) {
        report(err)
      }
    },
    react: async (comment: Comment, emoji: string) => {
      try {
        const updated = await service.react(comment, emoji)
        service.upsert(updated)
      } catch (err) {
        report(err)
      }
    },
    reattach:
      service.reattach === undefined
        ? undefined
        : async (comment: Comment) => {
            try {
              const updated = await service.reattach?.(comment)
              if (updated) service.upsert(updated)
            } catch (err) {
              report(err)
            }
          },
  }

  const pendingAnchor = pending ? pendingPreview(pending) : null

  return (
    <div className="flex flex-col gap-3 p-3">
      {pending && pendingAnchor ? (
        <div className="rounded-lg border border-[var(--accent)] bg-[var(--accent-soft)] p-2.5">
          <AnchorPreview preview={pendingAnchor} className="mb-2" />
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
          <MessageSquareText size={13} /> {documentActionLabel}
        </Button>
      ) : null}
      {docComposerOpen ? (
        <div className="rounded-lg border border-[var(--line)] p-2.5">
          <MentionTextarea value={docBody} onChange={setDocBody} members={members} placeholder={documentPlaceholder} autoFocus onSubmit={() => void submitDocLevel()} />
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

      {comments.length === 0 && !pending ? <EmptyState title="No comments yet" hint={emptyHint} /> : null}

      {grouped.anchored.length > 0 ? (
        <>
          {anchoredLabel ? <h3 className="island-kicker m-0 mt-2">{anchoredLabel}</h3> : null}
          {grouped.anchored.map((model) => (
            <Thread
              key={model.comment.id}
              comment={model.comment}
              me={me}
              members={members}
              nameFor={nameFor}
              active={model.comment.id === activeCommentId}
              canComment={canComment}
              onSelect={() => onSelect(model.comment)}
              actions={actions}
              preview={model.preview}
              kind="node"
              markerNumber={model.markerNumber}
            />
          ))}
        </>
      ) : null}

      {grouped.document.length > 0 ? (
        <>
          <h3 className="island-kicker m-0 mt-2">{documentLabel}</h3>
          {grouped.document.map((model) => (
            <Thread
              key={model.comment.id}
              comment={model.comment}
              me={me}
              members={members}
              nameFor={nameFor}
              active={model.comment.id === activeCommentId}
              canComment={canComment}
              onSelect={() => onSelect(model.comment)}
              actions={actions}
              preview={model.preview}
              kind="document"
            />
          ))}
        </>
      ) : null}

      {grouped.orphaned.length > 0 ? (
        <>
          <h3 className="island-kicker m-0 mt-2 flex items-center gap-1">
            <Unlink size={11} /> Orphaned
          </h3>
          <p className="m-0 -mt-1 text-[11px] text-[var(--ink-faint)]">{orphanedDescription}</p>
          {grouped.orphaned.map((model) => (
            <Thread
              key={model.comment.id}
              comment={model.comment}
              me={me}
              members={members}
              nameFor={nameFor}
              active={model.comment.id === activeCommentId}
              canComment={canComment}
              onSelect={() => onSelect(model.comment)}
              actions={actions}
              preview={model.preview}
              kind="orphaned"
              orphaned
              canReattach={
                canComment &&
                actions.reattach !== undefined &&
                (canReattach === undefined || canReattach(model.comment))
              }
              reattachTitle={reattachTitle?.(model.comment)}
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
            ? grouped.resolved.map((model) => (
                <Thread
                  key={model.comment.id}
                  comment={model.comment}
                  me={me}
                  members={members}
                  nameFor={nameFor}
                  active={model.comment.id === activeCommentId}
                  canComment={canComment}
                  onSelect={() => onSelect(model.comment)}
                  actions={actions}
                  preview={model.preview}
                  kind={model.preview?.label ? 'node' : 'document'}
                  resolved
                />
              ))
            : null}
        </>
      ) : null}
    </div>
  )
}

interface ThreadModel {
  comment: Comment
  sortKey: number
  markerNumber?: number
  preview?: CommentAnchorPreview
}

function compareThreads(a: ThreadModel, b: ThreadModel): number {
  if (a.sortKey !== b.sortKey) return a.sortKey - b.sortKey
  return a.comment.createdAt - b.comment.createdAt
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
  preview,
  kind,
  markerNumber,
  orphaned,
  resolved,
  canReattach,
  reattachTitle,
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
    reattach?: (comment: Comment) => Promise<void>
  }
  preview?: CommentAnchorPreview
  kind?: 'node' | 'document' | 'orphaned'
  markerNumber?: number
  orphaned?: boolean
  resolved?: boolean
  canReattach?: boolean
  reattachTitle?: string
}) {
  const [replyOpen, setReplyOpen] = useState(false)
  const [replyBody, setReplyBody] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)

  // Tapping highlighted text or an iframe marker activates its thread; make
  // sure that thread is visible in the panel.
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
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
      {kind !== 'document' && (markerNumber !== undefined || preview?.label) ? (
        <div className="mb-1.5 flex items-center gap-1.5">
          {markerNumber !== undefined ? <MarkerBadge n={markerNumber} /> : null}
          {preview?.label ? <ElementChip label={preview.label} orphaned={orphaned || preview.orphaned} /> : null}
        </div>
      ) : null}
      {preview?.quote ? <QuotePreview quote={preview.quote} orphaned={orphaned || preview.orphaned} /> : null}

      <div className="mb-1 flex items-center gap-2">
        <Avatar id={comment.authorId} name={comment.authorName} />
        <span className="text-xs font-semibold text-[var(--ink)]">{comment.authorName}</span>
        <span className="ml-auto text-[10px] text-[var(--ink-faint)]">{timeAgo(comment.createdAt)}</span>
      </div>
      <p className="m-0 whitespace-pre-wrap text-sm text-[var(--ink)]">
        {renderMentions(comment.body, nameFor)}
      </p>

      <Reactions comment={comment} me={me} canComment={canComment} pickerOpen={pickerOpen} setPickerOpen={setPickerOpen} onReact={(emoji) => void actions.react(comment, emoji)} />

      {comment.replies.length > 0 ? (
        <div className="mt-2 flex flex-col gap-2.5 border-l border-[var(--line)] pl-2.5">
          {comment.replies.map((reply) => (
            <div key={reply.id} className="flex gap-2">
              <Avatar id={reply.authorId} name={reply.authorName} size={18} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-xs font-semibold text-[var(--ink)]">{reply.authorName}</span>
                  <span className="text-[10px] text-[var(--ink-faint)]">{timeAgo(reply.createdAt)}</span>
                </div>
                <p className="m-0 whitespace-pre-wrap text-sm text-[var(--ink)]">{renderMentions(reply.body, nameFor)}</p>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {canComment ? (
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
          {orphaned && actions.reattach ? (
            <button
              type="button"
              disabled={!canReattach}
              onClick={() => void actions.reattach?.(comment)}
              title={reattachTitle}
              className="flex items-center gap-1 text-[11px] font-medium text-[var(--accent)] disabled:opacity-40 max-lg:-mx-1.5 max-lg:-my-1.5 max-lg:px-1.5 max-lg:py-2 max-lg:text-xs"
            >
              <Link2 size={11} /> Re-attach
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

function AnchorPreview({ preview, className = '' }: { preview: CommentAnchorPreview; className?: string }) {
  const quote = preview.quote ? truncate(preview.quote, 100) : null
  return (
    <div className={`${className} ${quote || preview.label ? 'mb-1.5' : ''}`}>
      {preview.label ? (
        <p className={`m-0 truncate border-l-2 pl-2 text-[11px] font-medium text-[var(--ink-faint)] ${preview.orphaned ? 'border-red-300 line-through' : 'border-amber-300'}`}>
          {preview.label}
        </p>
      ) : null}
      {quote ? (
        <p className={`m-0 truncate border-l-2 pl-2 text-[11px] italic text-[var(--ink-faint)] ${preview.orphaned ? 'border-red-300 line-through' : 'border-amber-300'}`}>
          “{quote}”
        </p>
      ) : null}
    </div>
  )
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}

const AVATAR_COLORS = ['#2563eb', '#0f766e', '#7c3aed', '#c2410c', '#be185d', '#0369a1', '#15803d', '#a16207']

/** Initial-in-a-circle avatar; colour is stable per principal id. */
function Avatar({ id, name, size = 22 }: { id: string; name: string; size?: number }) {
  const initial = (name.trim()[0] ?? '?').toUpperCase()
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0
  const background = AVATAR_COLORS[hash % AVATAR_COLORS.length]
  return (
    <span
      className="grid shrink-0 place-items-center rounded-full font-bold text-white"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.45), background }}
      aria-hidden
    >
      {initial}
    </span>
  )
}

/** Numbered badge that matches the in-document marker bubble. */
function MarkerBadge({ n }: { n: number }) {
  return (
    <span className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded-full bg-[var(--accent)] text-[11px] font-bold text-white">
      {n}
    </span>
  )
}

/** The element a node comment is anchored to, e.g. `button "Export CSV"`. */
function ElementChip({ label, orphaned }: { label: string; orphaned?: boolean }) {
  return (
    <span
      title={label}
      className={`truncate rounded-md px-2 py-0.5 font-mono text-[11px] font-semibold ${
        orphaned ? 'bg-amber-50 text-amber-700 line-through' : 'bg-[var(--accent-soft)] text-[var(--accent)]'
      }`}
    >
      {label}
    </span>
  )
}

function QuotePreview({ quote, orphaned }: { quote: string; orphaned?: boolean }) {
  return (
    <p
      className={`m-0 mb-1.5 truncate border-l-2 pl-2 text-[11px] italic text-[var(--ink-faint)] ${
        orphaned ? 'border-red-300 line-through' : 'border-[var(--line)]'
      }`}
    >
      “{truncate(quote, 100)}”
    </p>
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
