import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

/** Tiny hand-rolled primitives — no component library (SPEC §9 / task). */

export function Button({
  children,
  onClick,
  type = 'button',
  variant = 'default',
  size = 'md',
  disabled,
  title,
  className = '',
}: {
  children: ReactNode
  onClick?: () => void
  type?: 'button' | 'submit'
  variant?: 'default' | 'primary' | 'danger' | 'ghost'
  size?: 'sm' | 'md'
  disabled?: boolean
  title?: string
  className?: string
}) {
  const variants: Record<string, string> = {
    default: 'border border-[var(--line)] bg-[var(--paper)] text-[var(--ink)] hover:bg-[var(--paper-soft)]',
    primary: 'border border-transparent bg-[var(--accent)] text-white hover:bg-[var(--accent-deep)]',
    danger: 'border border-transparent bg-red-600 text-white hover:bg-red-700',
    ghost: 'border border-transparent text-[var(--ink-soft)] hover:bg-[var(--paper-soft)] hover:text-[var(--ink)]',
  }
  const sizes = { sm: 'px-2 py-1 text-xs', md: 'px-3 py-1.5 text-sm' }
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`inline-flex items-center gap-1.5 rounded-md font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${variants[variant]} ${sizes[size]} ${className}`}
    >
      {children}
    </button>
  )
}

export function Input({
  value,
  onChange,
  placeholder,
  type = 'text',
  autoFocus,
  onKeyDown,
  className = '',
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  type?: string
  autoFocus?: boolean
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void
  className?: string
}) {
  return (
    <input
      type={type}
      value={value}
      autoFocus={autoFocus}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      className={`w-full rounded-md border border-[var(--line)] bg-[var(--paper)] px-2.5 py-1.5 text-sm text-[var(--ink)] outline-none placeholder:text-[var(--ink-faint)] focus:border-[var(--accent)] ${className}`}
    />
  )
}

export function Select<T extends string>({
  value,
  onChange,
  options,
  className = '',
  disabled,
}: {
  value: T
  onChange: (value: T) => void
  options: ReadonlyArray<{ value: T; label: string }>
  className?: string
  disabled?: boolean
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as T)}
      className={`rounded-md border border-[var(--line)] bg-[var(--paper)] px-2 py-1.5 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)] disabled:opacity-50 ${className}`}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode
  tone?: 'neutral' | 'green' | 'red' | 'amber' | 'blue'
}) {
  const tones = {
    neutral: 'bg-[var(--paper-soft)] text-[var(--ink-soft)] border-[var(--line)]',
    green: 'bg-green-50 text-green-700 border-green-200 dark:bg-green-950 dark:text-green-300 dark:border-green-900',
    red: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-300 dark:border-red-900',
    amber: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-900',
    blue: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950 dark:text-blue-300 dark:border-blue-900',
  }
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${tones[tone]}`}>
      {children}
    </span>
  )
}

export function Dialog({
  open,
  onClose,
  title,
  children,
  wide,
  center,
  panelClassName,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  wide?: boolean
  /** Vertically center the panel (lightbox-style) instead of the 12vh top offset. */
  center?: boolean
  /** Replaces the default width classes (`w-full max-w-md`/`max-w-2xl`) — content-sized panels. */
  panelClassName?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Portaled to <body>: ancestors with a transform (e.g. the slide-out file
  // tree panel) would otherwise become the containing block for `fixed` and
  // trap the overlay inside themselves. Open only ever happens client-side.
  if (!open || typeof document === 'undefined') return null
  return createPortal(
    <div
      className={`fixed inset-0 z-[100] flex justify-center bg-black/40 px-4 ${center ? 'items-center py-4' : 'items-start pt-[12vh]'}`}
      onMouseDown={(e) => {
        if (ref.current && !ref.current.contains(e.target as Node)) onClose()
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        className={`${panelClassName ?? `w-full ${wide ? 'max-w-2xl' : 'max-w-md'}`} rounded-xl border border-[var(--line)] bg-[var(--paper)] shadow-xl`}
      >
        <div className="flex items-center justify-between border-b border-[var(--line)] px-4 py-3">
          <h2 className="m-0 text-sm font-semibold text-[var(--ink)]">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-[var(--ink-soft)] hover:bg-[var(--paper-soft)] hover:text-[var(--ink)]"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>
        <div className="px-4 py-4">{children}</div>
      </div>
    </div>,
    document.body,
  )
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  body,
  confirmLabel = 'Confirm',
  danger,
}: {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  title: string
  body: string
  confirmLabel?: string
  danger?: boolean
}) {
  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <p className="m-0 mb-4 text-sm text-[var(--ink-soft)]">{body}</p>
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant={danger ? 'danger' : 'primary'}
          onClick={() => {
            onConfirm()
            onClose()
          }}
        >
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  )
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-8 text-sm text-[var(--ink-soft)]">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--line)] border-t-[var(--accent)]" />
      {label ?? 'Loading…'}
    </div>
  )
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-dashed border-[var(--line)] px-4 py-8 text-center">
      <p className="m-0 text-sm font-medium text-[var(--ink-soft)]">{title}</p>
      {hint ? <p className="m-0 mt-1 text-xs text-[var(--ink-faint)]">{hint}</p> : null}
    </div>
  )
}
