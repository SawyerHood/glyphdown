import { Link } from '@tanstack/react-router'
import { CopyCommand } from './CodeBlock.tsx'
import HeroVisual from './HeroVisual.tsx'

export default function Hero() {
  return (
    <section className="page-wrap pb-20 pt-16 sm:pt-24">
      <div className="rise-in mx-auto max-w-3xl text-center">
        <p className="island-kicker mb-4">Google Docs for markdown</p>
        <h1 className="display-title m-0 text-4xl font-bold leading-tight tracking-tight text-[var(--ink)] sm:text-5xl">
          Sync your notes.
          <br />
          Send in your agents.
        </h1>
        <p className="mx-auto mb-0 mt-5 max-w-2xl text-base leading-7 text-[var(--ink-soft)]">
          Your docs mirror to disk as plain <code>.md</code> files. You write in any editor, collaborators type
          live in the browser, and AI agents push changes under their own identity — as reviewable suggestions
          if you want. Every edit merges through a CRDT. Nothing clobbers.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          {/* Color lives on the inner span: the global `a {color}` rule is
              un-layered and would beat a text-white utility on the anchor. */}
          <Link
            to="/login"
            className="rounded-lg border border-transparent bg-[var(--accent)] px-5 py-2.5 no-underline transition hover:bg-[var(--accent-deep)]"
          >
            <span className="text-sm font-semibold text-white">Continue with GitHub</span>
          </Link>
          {/* Lead with the install command — a fresh user needs the CLI on
              their PATH before `glyphdown clone` works. */}
          <CopyCommand command='npm i -g glyphdown' />
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-center gap-3">
          <CopyCommand command='glyphdown clone' />
        </div>
      </div>
      <div className="mt-14 sm:mt-16">
        <HeroVisual />
      </div>
    </section>
  )
}
