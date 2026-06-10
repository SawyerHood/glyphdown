import { useState, type ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'

/**
 * Code presentation primitives for the landing page. Pure CSS — no
 * highlighter dependency. `CodeBlock` is a quiet paper-soft <pre> for inline
 * snippets; `CopyCommand` is the hero's one-liner with a clipboard button.
 */

export function CodeBlock({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <pre
      className={`m-0 overflow-x-auto rounded-lg border border-[var(--line)] bg-[var(--paper-soft)] px-5 py-4 font-mono text-[13px] leading-7 text-[var(--ink)] ${className}`}
    >
      {children}
    </pre>
  )
}

/** Dim "$ " prompt prefix for shell lines inside a CodeBlock. */
export function Prompt() {
  return <span className="select-none text-[var(--ink-faint)]">$ </span>
}

/** Muted span — output lines, comments. */
export function Dim({ children }: { children: ReactNode }) {
  return <span className="text-[var(--ink-faint)]">{children}</span>
}

/** Green span — things that landed (pushed/merged/+ lines). */
export function Ok({ children }: { children: ReactNode }) {
  return <span className="text-green-600 dark:text-green-400">{children}</span>
}

export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard unavailable (permissions/insecure context) — quietly no-op.
    }
  }
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-lg border border-[var(--line)] bg-[var(--paper)] py-1 pl-4 pr-1 font-mono text-[13px] text-[var(--ink)]">
      <span className="select-none text-[var(--ink-faint)]">$&nbsp;</span>
      <span className="truncate">{command}</span>
      <button
        type="button"
        onClick={() => void copy()}
        title="Copy command"
        aria-label="Copy command"
        className="ml-1 rounded-md p-2 text-[var(--ink-faint)] transition hover:bg-[var(--paper-soft)] hover:text-[var(--ink)]"
      >
        {copied ? <Check size={14} className="text-green-600 dark:text-green-400" /> : <Copy size={14} />}
      </button>
    </span>
  )
}
