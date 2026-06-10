import { useEffect, useState } from 'react'
import { Bot, Sparkles } from 'lucide-react'
import { dismissNux, isNuxDismissed } from '../lib/nux.ts'
import { CopyCommand } from './landing/CodeBlock.tsx'
import { Button, Dialog } from './ui.tsx'

/**
 * First-run welcome (NUX): shown once per user per browser, on the home file
 * browser after sign-in. Walks the same loop the landing page sells — CLI,
 * skill, then talk to your agent. "Show the welcome guide again" in Settings
 * resets it (lib/nux.ts).
 */
export default function WelcomeNux({ userId }: { userId: string }) {
  const [open, setOpen] = useState(false)

  // localStorage is unavailable during SSR — decide after mount.
  useEffect(() => {
    if (!isNuxDismissed(userId)) setOpen(true)
  }, [userId])

  const close = () => {
    dismissNux(userId)
    setOpen(false)
  }

  return (
    <Dialog open={open} onClose={close} title="Welcome to Glyphdown">
      <p className="m-0 mb-5 text-sm leading-6 text-[var(--ink-soft)]">
        Docs you create here mirror to disk as plain <code>.md</code> files — for you <em>and</em> your agents.
        Three steps to the full loop:
      </p>

      <Step n="1" title="Install the CLI and sign in">
        <div className="flex flex-wrap gap-2">
          <CopyCommand command="npm i -g glyphdown" />
          <CopyCommand command="glyphdown login" />
        </div>
      </Step>

      <Step n="2" title="Teach your agent the skill">
        <CopyCommand command="glyphdown install-skill" />
        <p className="m-0 mt-1.5 text-xs leading-5 text-[var(--ink-faint)]">
          Drops the glyphdown skill into Claude Code, Codex, and any agent reading <code>~/.agents/skills</code>.
        </p>
      </Step>

      <Step n="3" title="Then just talk to it">
        <p className="m-0 flex items-start gap-2 text-sm leading-6 text-[var(--ink-soft)]">
          <Bot size={15} className="mt-1 shrink-0 text-[var(--accent)]" aria-hidden="true" />
          <span>
            Share any doc link with your agent, or simply ask it to{' '}
            <em className="text-[var(--ink)]">“upload a markdown file to glyphdown”</em> or{' '}
            <em className="text-[var(--ink)]">“sync my notes”</em>. Its edits, comments, and suggestions land
            here under its own identity.
          </span>
        </p>
      </Step>

      <div className="mt-5 flex items-center justify-between gap-2">
        <p className="m-0 flex items-center gap-1.5 text-xs text-[var(--ink-faint)]">
          <Sparkles size={12} aria-hidden="true" /> Replay anytime from Settings.
        </p>
        <Button variant="primary" onClick={close}>
          Got it
        </Button>
      </div>
    </Dialog>
  )
}

function Step({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4 flex gap-3">
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-[var(--line)] bg-[var(--paper)] font-mono text-[11px] font-semibold text-[var(--accent)]">
        {n}
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="m-0 mb-2 text-sm font-semibold text-[var(--ink)]">{title}</h3>
        {children}
      </div>
    </div>
  )
}
