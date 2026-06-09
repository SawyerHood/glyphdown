import { Bot, FileJson, KeyRound, ShieldCheck } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { CodeBlock, Dim, Ok, Prompt } from './CodeBlock.tsx'

function Point({ icon: Icon, title, body }: { icon: LucideIcon; title: string; body: string }) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)]">
        <Icon size={14} />
      </span>
      <span>
        <strong className="block text-sm font-semibold text-[var(--ink)]">{title}</strong>
        <span className="text-[13px] leading-6 text-[var(--ink-soft)]">{body}</span>
      </span>
    </li>
  )
}

export default function AgentsSection() {
  return (
    <section className="border-t border-[var(--line)] py-20">
      <div className="page-wrap grid items-start gap-10 lg:grid-cols-2">
        <div>
          <p className="island-kicker mb-3">Agents</p>
          <h2 className="display-title m-0 mb-4 text-3xl font-bold tracking-tight text-[var(--ink)]">
            Built for Claude Code &amp; friends
          </h2>
          <p className="m-0 mb-6 max-w-xl text-sm leading-7 text-[var(--ink-soft)]">
            Agents aren't an integration bolted on the side — they're collaborators. Humans sign in with a
            device code (<code>glyphdown login</code>); agents get their own minted keys.
          </p>
          <ul className="m-0 flex list-none flex-col gap-4 p-0">
            <Point
              icon={KeyRound}
              title="One key, one env var"
              body="Mint a key in Settings → Agents, set GLYPHDOWN_API_KEY, and every glyphdown command authenticates as that agent."
            />
            <Point
              icon={Bot}
              title="Their own identity"
              body="Agent edits, comments, and suggestions are attributed — “Claude · run by kirby” — in cursors, bylines, and history. Rate limits apply per identity."
            />
            <Point
              icon={FileJson}
              title="Machine-friendly output"
              body="--json on every read command, and push exit codes that mean something: 0 clean, 2 failed hunks to re-apply, 3 degenerate rewrite refused."
            />
            <Point
              icon={ShieldCheck}
              title="CRDT-safe merging"
              body="Pushes diff against the pulled base and merge server-side, so an agent never clobbers the edits humans made in the meantime."
            />
          </ul>
        </div>
        <CodeBlock className="lg:mt-12">
          <Dim># minted in Settings → Agents</Dim>
          {'\n'}
          <Prompt />
          export GLYPHDOWN_API_KEY=gd_sk_…{'\n\n'}
          <Dim># the agent loop</Dim>
          {'\n'}
          <Prompt />
          glyphdown pull --folder "Q3 Planning" work{'\n'}
          <Prompt />
          cd work{'\n'}
          <Dim># …edit the .md files with normal tools…</Dim>
          {'\n'}
          <Prompt />
          glyphdown push --all --suggest -m "apply review feedback"{'\n'}
          suggestion <Ok>s_91c2</Ok> created (version v18){'\n\n'}
          <Dim># stay converged with human edits</Dim>
          {'\n'}
          <Prompt />
          glyphdown sync --json
        </CodeBlock>
      </div>
    </section>
  )
}
