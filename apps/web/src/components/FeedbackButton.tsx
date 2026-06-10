import { useState } from 'react'
import { useRouterState } from '@tanstack/react-router'
import { useMutation } from '@tanstack/react-query'
import { Bug, Check, Lightbulb, MessageSquarePlus } from 'lucide-react'
import { submitFeedback, type FeedbackType } from '../lib/api.ts'
import { Button, Dialog } from './ui.tsx'

/**
 * Header affordance for "request a feature / report a bug" — a tiny dialog
 * posting to /api/feedback (read by the owner on /admin and via the CLI).
 * The submit button flips to a transient thank-you instead of a toast layer.
 */
export default function FeedbackButton() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const [open, setOpen] = useState(false)
  const [type, setType] = useState<FeedbackType>('feature')
  const [body, setBody] = useState('')
  const [sent, setSent] = useState(false)

  const send = useMutation({
    mutationFn: submitFeedback,
    onSuccess: () => {
      setSent(true)
      setBody('')
      window.setTimeout(() => {
        setSent(false)
        setOpen(false)
      }, 1200)
    },
  })

  const close = () => {
    setOpen(false)
    setSent(false)
    send.reset()
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Request a feature / report a bug"
        aria-label="Request a feature or report a bug"
        className="rounded-md p-2 text-[var(--ink-soft)] transition hover:bg-[var(--paper-soft)] hover:text-[var(--ink)]"
      >
        <MessageSquarePlus size={16} />
      </button>

      <Dialog open={open} onClose={close} title="Feedback">
        <div className="mb-3 flex gap-1.5" role="radiogroup" aria-label="Feedback type">
          <TypeChip
            active={type === 'feature'}
            onClick={() => setType('feature')}
            icon={<Lightbulb size={13} />}
            label="Feature request"
          />
          <TypeChip active={type === 'bug'} onClick={() => setType('bug')} icon={<Bug size={13} />} label="Bug report" />
        </div>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          autoFocus
          rows={4}
          maxLength={4000}
          placeholder={type === 'feature' ? 'What should Glyphdown do?' : 'What broke? What did you expect?'}
          className="w-full resize-y rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)] outline-none placeholder:text-[var(--ink-faint)] focus:border-[var(--accent)]"
        />
        {send.isError ? (
          <p className="m-0 mt-2 text-xs text-red-600 dark:text-red-400">Couldn't send — try again.</p>
        ) : null}
        <div className="mt-3 flex items-center justify-end gap-2">
          <Button onClick={close}>Cancel</Button>
          <Button
            variant="primary"
            disabled={body.trim() === '' || send.isPending || sent}
            onClick={() => send.mutate({ type, body: body.trim(), page: pathname })}
          >
            {sent ? (
              <>
                <Check size={14} /> Thanks!
              </>
            ) : (
              'Send'
            )}
          </Button>
        </div>
      </Dialog>
    </>
  )
}

function TypeChip({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${
        active
          ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
          : 'border-[var(--line)] bg-[var(--paper)] text-[var(--ink-soft)] hover:bg-[var(--paper-soft)]'
      }`}
    >
      {icon}
      {label}
    </button>
  )
}
