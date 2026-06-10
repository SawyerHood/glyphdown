import { CodeBlock, Dim, Ok, Prompt } from './CodeBlock.tsx'
import MdKicker from './MdKicker.tsx'

/**
 * The real onboarding loop: sign in once, hand your agent the skill, then ask
 * in plain English — the agent drives the CLI and you review in the browser.
 * Steps stack vertically off a dashed rail so each snippet gets a full
 * column's width (command output matches the real CLI / Claude Code).
 */

function Step({
  n,
  title,
  body,
  children,
}: {
  n: string
  title: string
  body: string
  children: React.ReactNode
}) {
  return (
    <div className="reveal-up relative grid gap-5 pl-14 md:grid-cols-[5fr_6fr] md:gap-10">
      {/* z-10 + paper background so the chip masks the rail running behind it. */}
      <span className="absolute left-0 top-0 z-10 flex h-9 w-9 items-center justify-center rounded-full border border-[var(--line)] bg-[var(--paper)] font-mono text-[13px] font-semibold text-[var(--accent)]">
        {n}
      </span>
      <div>
        <h3 className="display-title m-0 mb-2 text-xl font-bold text-[var(--ink)]">{title}</h3>
        <p className="m-0 text-sm leading-6 text-[var(--ink-soft)]">{body}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

export default function LoopSection() {
  return (
    <section className="border-t border-[var(--line)] py-20">
      <div className="page-wrap">
        <div className="reveal-up mb-14 max-w-2xl">
          <MdKicker className="mb-3">The loop</MdKicker>
          <h2 className="display-title m-0 text-3xl font-bold tracking-tight text-[var(--ink)]">
            Plain files in. Reviewed changes out.
          </h2>
        </div>
        <div className="relative flex flex-col gap-14">
          {/* The rail: a dashed line threading the step chips. */}
          <div
            aria-hidden="true"
            className="absolute bottom-8 left-[17px] top-5 border-l border-dashed border-[var(--line)]"
          />
          <Step
            n="01"
            title="Sign in"
            body="Install the CLI and glyphdown login prints a device code — approve it in the browser and the session is saved. No tokens to paste; agents get their own minted identities in the next step."
          >
            <CodeBlock>
              <Prompt />
              npm i -g glyphdown{'\n'}
              <Prompt />
              glyphdown login{'\n'}
              <Dim>To sign in, visit:</Dim>
              {'\n'}
              {'  '}glyphdown.com/device{'\n'}
              <Dim>and enter the code:</Dim> GLYF-K3QP{'\n'}
              <Ok>signed in</Ok> <Dim>— session saved</Dim>
            </CodeBlock>
          </Step>
          <Step
            n="02"
            title="Hand your agent the skill"
            body="One command drops the glyphdown skill into Claude Code, Codex, and any agent reading ~/.agents/skills. It teaches the whole workflow — clone, sync, push, suggest, comment — and the etiquette: suggest instead of edit when it matters, never clobber concurrent human work."
          >
            <CodeBlock>
              <Prompt />
              glyphdown install-skill{'\n'}
              <Ok>installed skill</Ok> <Dim>→ ~/.claude/skills/glyphdown</Dim>
              {'\n'}
              <Ok>installed skill</Ok> <Dim>→ ~/.codex/skills/glyphdown</Dim>
              {'\n'}
              <Ok>installed skill</Ok> <Dim>→ ~/.agents/skills/glyphdown</Dim>
            </CodeBlock>
          </Step>
          <Step
            n="03"
            title="Then just ask"
            body="Prompt in plain English. The agent clones your workspace, edits the .md files, and pushes back through the CRDT — as reviewable suggestions when it matters. Accept or reject in the browser; comments and version history keep the trail."
          >
            <CodeBlock>
              <Dim>&gt;</Dim> sync my notes and tighten up the launch plan{'\n\n'}
              <Dim>⏺</Dim> glyphdown sync{'\n'}
              {'  '}launch-plan.md <Ok>pulled</Ok> <Dim>· 12 docs up to date</Dim>
              {'\n'}
              <Dim>⏺</Dim> glyphdown push launch-plan.md --suggest \{'\n'}
              {'      '}-m "tighten the launch intro"{'\n'}
              {'  '}suggestion <Ok>s_7f3a</Ok> created{'\n\n'}
              <Dim>review in the browser — accept or reject each change</Dim>
            </CodeBlock>
          </Step>
        </div>
      </div>
    </section>
  )
}
