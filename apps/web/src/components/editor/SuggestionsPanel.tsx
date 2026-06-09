import { useQueryClient } from '@tanstack/react-query'
import { Check, X } from 'lucide-react'
import { roleAtLeast, type Role } from '@glyphdown/protocol'
import {
  acceptSuggestionApi,
  rejectSuggestionApi,
  type MemberInfo,
  type SuggestionWithMeta,
} from '../../lib/api.ts'
import { track } from '../../lib/analytics.ts'
import { timeAgo } from '../../lib/presence.ts'
import { Badge, Button, EmptyState } from '../ui.tsx'
import { suggestionsKey } from './DocEditorPage.tsx'

interface Props {
  docId: string
  share: string | undefined
  me: { id: string } | null
  role: Role
  suggestions: SuggestionWithMeta[]
  members: MemberInfo[]
  activeSuggestionId: string | null
  onSelect: (suggestion: SuggestionWithMeta) => void
  /** Re-resolve anchors after an accept/reject mutated the text. */
  onAfterReview: () => void
  report: (err: unknown) => void
}

export default function SuggestionsPanel({
  docId,
  share,
  me,
  role,
  suggestions,
  activeSuggestionId,
  onSelect,
  onAfterReview,
  report,
}: Props) {
  const queryClient = useQueryClient()
  const canReview = roleAtLeast(role, 'editor')

  const setStatus = (id: string, status: SuggestionWithMeta['status'], outdatedParts?: number) =>
    queryClient.setQueryData<SuggestionWithMeta[]>(suggestionsKey(docId), (old) =>
      (old ?? []).map((s) =>
        s.id === id ? { ...s, status, ...(outdatedParts !== undefined ? { outdatedParts } : {}) } : s,
      ),
    )

  const accept = async (id: string) => {
    try {
      const result = await acceptSuggestionApi(docId, id)
      track('suggestion_accepted', { docId })
      setStatus(id, 'accepted', result.outdatedParts)
      onAfterReview()
    } catch (err) {
      report(err)
    }
  }

  const reject = async (suggestion: SuggestionWithMeta) => {
    try {
      await rejectSuggestionApi(docId, suggestion.id, share)
      track('suggestion_rejected', { docId, withdrawn: !canReview })
      setStatus(suggestion.id, canReview ? 'rejected' : 'withdrawn')
      onAfterReview()
    } catch (err) {
      report(err)
    }
  }

  const visible = suggestions.filter((s) => s.status !== 'open' || s.parts.length > 0)
  const open = visible.filter((s) => s.status === 'open').sort((a, b) => b.createdAt - a.createdAt)
  const reviewed = visible.filter((s) => s.status !== 'open').sort((a, b) => b.createdAt - a.createdAt)

  if (visible.length === 0) {
    return (
      <div className="p-3">
        <EmptyState
          title="No suggestions"
          hint="Switch to Suggest mode (or push with ink --suggest) to propose changes for review."
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3 p-3">
      {open.map((suggestion) => (
        <SuggestionCard
          key={suggestion.id}
          suggestion={suggestion}
          active={suggestion.id === activeSuggestionId}
          canReview={canReview}
          isOwn={me !== null && suggestion.authorId === me.id}
          canWithdraw={me !== null && suggestion.authorId === me.id && roleAtLeast(role, 'suggester')}
          onSelect={() => onSelect(suggestion)}
          onAccept={() => void accept(suggestion.id)}
          onReject={() => void reject(suggestion)}
        />
      ))}
      {reviewed.length > 0 ? (
        <>
          <h3 className="island-kicker m-0 mt-1">Reviewed</h3>
          {reviewed.slice(0, 20).map((suggestion) => (
            <SuggestionCard
              key={suggestion.id}
              suggestion={suggestion}
              active={suggestion.id === activeSuggestionId}
              canReview={false}
              isOwn={me !== null && suggestion.authorId === me.id}
              canWithdraw={false}
              onSelect={() => onSelect(suggestion)}
              onAccept={() => {}}
              onReject={() => {}}
            />
          ))}
        </>
      ) : null}
    </div>
  )
}

function SuggestionCard({
  suggestion,
  active,
  canReview,
  isOwn,
  canWithdraw,
  onSelect,
  onAccept,
  onReject,
}: {
  suggestion: SuggestionWithMeta
  active: boolean
  canReview: boolean
  isOwn: boolean
  canWithdraw: boolean
  onSelect: () => void
  onAccept: () => void
  onReject: () => void
}) {
  const inserts = suggestion.parts.filter((p) => p.kind === 'insert')
  const deletes = suggestion.parts.filter((p) => p.kind === 'delete')
  const orphanedParts = suggestion.parts.filter((p) => p.anchor.status === 'orphaned').length
  const outdated = (suggestion.outdatedParts ?? 0) > 0 || orphanedParts > 0

  return (
    <div
      className={`rounded-lg border p-2.5 transition ${active ? 'border-[var(--accent)] shadow-sm' : 'border-[var(--line)]'} ${
        suggestion.status !== 'open' ? 'opacity-70' : ''
      }`}
      onClick={onSelect}
    >
      <div className="mb-1 flex flex-wrap items-center gap-1.5">
        <span className="text-xs font-semibold text-[var(--ink)]">
          {suggestion.authorName}
          {isOwn ? ' (you)' : ''}
        </span>
        <span className="text-[10px] text-[var(--ink-faint)]">{timeAgo(suggestion.createdAt)}</span>
        {suggestion.status !== 'open' ? (
          <Badge tone={suggestion.status === 'accepted' ? 'green' : suggestion.status === 'rejected' ? 'red' : 'neutral'}>
            {suggestion.status}
          </Badge>
        ) : null}
        {outdated ? <Badge tone="amber">outdated</Badge> : null}
      </div>

      {suggestion.note ? <p className="m-0 mb-1.5 text-sm italic text-[var(--ink-soft)]">{suggestion.note}</p> : null}

      <div className="flex flex-col gap-1 text-xs">
        {inserts.slice(0, 3).map((part, i) => (
          <p key={`i${i}`} className="m-0 truncate rounded bg-green-50 px-1.5 py-0.5 text-green-800 dark:bg-green-950 dark:text-green-300">
            + {part.anchor.quote.exact || '(empty)'}
          </p>
        ))}
        {deletes.slice(0, 3).map((part, i) => (
          <p key={`d${i}`} className="m-0 truncate rounded bg-red-50 px-1.5 py-0.5 text-red-800 line-through dark:bg-red-950 dark:text-red-300">
            − {part.anchor.quote.exact || '(empty)'}
          </p>
        ))}
        {suggestion.parts.length > 6 ? (
          <p className="m-0 text-[11px] text-[var(--ink-faint)]">…and {suggestion.parts.length - 6} more changes</p>
        ) : null}
      </div>

      {suggestion.status === 'open' && (canReview || canWithdraw) ? (
        <div className="mt-2 flex gap-2" onClick={(e) => e.stopPropagation()}>
          {canReview ? (
            <>
              <Button size="sm" variant="primary" onClick={onAccept}>
                <Check size={12} /> Accept
              </Button>
              <Button size="sm" onClick={onReject}>
                <X size={12} /> Reject
              </Button>
            </>
          ) : canWithdraw ? (
            <Button size="sm" onClick={onReject}>
              <X size={12} /> Withdraw
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
