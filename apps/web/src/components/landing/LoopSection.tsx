import { CodeBlock, Dim, Ok, Prompt } from './CodeBlock.tsx'

/**
 * The core narrative: notes sync to disk, agents push to them, you review.
 * Snippets use the real `glyphdown` command syntax and output formats.
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
    <div className="flex flex-col">
      <p className="island-kicker m-0 mb-2">Step {n}</p>
      <h3 className="display-title m-0 mb-2 text-xl font-bold text-[var(--ink)]">{title}</h3>
      <p className="m-0 mb-4 text-sm leading-6 text-[var(--ink-soft)]">{body}</p>
      <div className="mt-auto">{children}</div>
    </div>
  )
}

export default function LoopSection() {
  return (
    <section className="border-t border-[var(--line)] py-20">
      <div className="page-wrap">
        <div className="mb-12 max-w-2xl">
          <p className="island-kicker mb-3">The loop</p>
          <h2 className="display-title m-0 text-3xl font-bold tracking-tight text-[var(--ink)]">
            Plain files in. Reviewed changes out.
          </h2>
        </div>
        <div className="grid gap-10 md:grid-cols-3 md:gap-8">
          <Step
            n="1"
            title="Sync your notes"
            body="Mirror your whole account — every folder and doc — as plain .md files on disk. glyphdown sync reconciles both ways: local edits push, browser edits pull, concurrent edits merge through the CRDT. New local files and folders become docs."
          >
            <CodeBlock>
              <Prompt />
              glyphdown clone{'\n'}
              <Prompt />
              glyphdown sync{'\n'}
              launch-plan.md <Ok>pushed</Ok>
              {'\n'}
              roadmap.md     <Ok>merged</Ok>
              {'\n'}
              ideas.md       <Ok>pulled</Ok>
            </CodeBlock>
          </Step>
          <Step
            n="2"
            title="Send in your agents"
            body="Mint an API key in Settings → Agents and hand it to Claude Code. The agent works on the same files with its own identity — every edit, comment, and suggestion is attributed to it."
          >
            <CodeBlock>
              <Prompt />
              export GLYPHDOWN_API_KEY=gd_sk_…{'\n'}
              <Prompt />
              glyphdown push launch-plan.md \{'\n'}
              {'    '}--suggest -m "tighten the intro"{'\n'}
              suggestion <Ok>s_7f3a</Ok> created
            </CodeBlock>
          </Step>
          <Step
            n="3"
            title="Review like a PR"
            body="Pushes with --suggest land as suggestion sets: insertions in green, deletions struck through. Accept or reject each one in the browser, with comments and version history keeping the trail."
          >
            <CodeBlock>
              <Prompt />
              glyphdown suggestions launch-plan{'\n'}
              s_7f3a <Dim>Claude · run by kirby</Dim>
              {'\n'}
              {'  '}
              <Ok>+ "We launch October 6…"</Ok>
              {'\n'}
              {'  '}
              <span className="text-red-600 dark:text-red-400">- "We will probably launch…"</span>
            </CodeBlock>
          </Step>
        </div>
      </div>
    </section>
  )
}
