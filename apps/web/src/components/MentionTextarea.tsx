import { useRef, useState } from 'react'
import type { MemberInfo } from '../lib/api.ts'

interface MentionState {
  query: string
  /** Offset of the '@' that started the mention. */
  at: number
  selected: number
}

/**
 * Textarea with @mention autocomplete over doc members. Mentions are stored
 * as `@[principalId]` in the body (SPEC §6.2); rendering maps them back to
 * names via lib/presence.renderMentions.
 */
export default function MentionTextarea({
  value,
  onChange,
  members,
  placeholder,
  autoFocus,
  onSubmit,
}: {
  value: string
  onChange: (value: string) => void
  members: MemberInfo[]
  placeholder?: string
  autoFocus?: boolean
  /** Cmd/Ctrl+Enter */
  onSubmit?: () => void
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [mention, setMention] = useState<MentionState | null>(null)

  const matches = mention
    ? members
        .filter(
          (m) =>
            m.name.toLowerCase().includes(mention.query.toLowerCase()) ||
            (m.email ?? '').toLowerCase().startsWith(mention.query.toLowerCase()),
        )
        .slice(0, 5)
    : []

  const detectMention = (text: string, caret: number) => {
    const before = text.slice(0, caret)
    const match = before.match(/(^|\s)@([\w.-]*)$/)
    if (match) {
      setMention({ query: match[2] ?? '', at: caret - (match[2]?.length ?? 0) - 1, selected: 0 })
    } else {
      setMention(null)
    }
  }

  const pick = (member: MemberInfo) => {
    if (!mention) return
    const caret = ref.current?.selectionStart ?? value.length
    const inserted = `@[${member.principalId}] `
    const next = value.slice(0, mention.at) + inserted + value.slice(caret)
    onChange(next)
    setMention(null)
    requestAnimationFrame(() => {
      const pos = mention.at + inserted.length
      ref.current?.setSelectionRange(pos, pos)
      ref.current?.focus()
    })
  }

  return (
    <div className="relative">
      <textarea
        ref={ref}
        value={value}
        autoFocus={autoFocus}
        placeholder={placeholder}
        rows={3}
        onChange={(e) => {
          onChange(e.target.value)
          detectMention(e.target.value, e.target.selectionStart)
        }}
        onKeyDown={(e) => {
          if (mention && matches.length > 0) {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setMention({ ...mention, selected: (mention.selected + 1) % matches.length })
              return
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault()
              setMention({ ...mention, selected: (mention.selected - 1 + matches.length) % matches.length })
              return
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault()
              pick(matches[mention.selected]!)
              return
            }
            if (e.key === 'Escape') {
              setMention(null)
              return
            }
          }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            onSubmit?.()
          }
        }}
        onBlur={() => setTimeout(() => setMention(null), 150)}
        className="w-full resize-y rounded-md border border-[var(--line)] bg-[var(--paper)] px-2.5 py-2 text-sm text-[var(--ink)] outline-none placeholder:text-[var(--ink-faint)] focus:border-[var(--accent)]"
      />
      {mention && matches.length > 0 ? (
        <ul className="absolute left-0 top-full z-30 m-0 w-64 list-none rounded-md border border-[var(--line)] bg-[var(--paper)] p-1 shadow-lg">
          {matches.map((m, i) => (
            <li key={m.principalId}>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault()
                  pick(m)
                }}
                className={`flex w-full items-baseline gap-2 rounded px-2 py-1 text-left text-sm ${
                  i === mention.selected ? 'bg-[var(--accent-soft)] text-[var(--ink)]' : 'text-[var(--ink)]'
                }`}
              >
                <span className="font-medium">{m.name}</span>
                {m.principalType === 'agent' ? (
                  <span className="text-xs text-[var(--ink-faint)]">agent</span>
                ) : (
                  <span className="truncate text-xs text-[var(--ink-faint)]">{m.email}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
