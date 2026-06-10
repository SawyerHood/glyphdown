import { Link } from '@tanstack/react-router'
import { CopyCommand } from './CodeBlock.tsx'
import HeroVisual from './HeroVisual.tsx'
import MdKicker from './MdKicker.tsx'

/** Oversized markdown punctuation drifting behind the hero — pure decoration. */
function GlyphField() {
  return (
    <div aria-hidden="true" className="absolute inset-0 hidden overflow-hidden lg:block">
      <span className="land-glyph left-[6%] top-[8%] text-[11rem]">#</span>
      <span className="land-glyph right-[7%] top-[14%] text-[9rem]">*</span>
      <span className="land-glyph left-[13%] top-[58%] text-[8rem]">&gt;</span>
      <span className="land-glyph right-[14%] top-[60%] font-mono text-[5rem] font-bold tracking-tight">```</span>
    </div>
  )
}

export default function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div aria-hidden="true" className="land-atmosphere absolute inset-0" />
      <GlyphField />
      <div className="page-wrap relative pb-20 pt-16 sm:pt-24">
        <div className="mx-auto max-w-3xl text-center">
          <MdKicker className="rise-in mb-5 [animation-delay:40ms]">Google Docs for markdown</MdKicker>
          <h1 className="display-title rise-in m-0 text-[2.75rem] font-bold leading-[1.06] tracking-tight text-[var(--ink-heading)] [animation-delay:110ms] sm:text-[4.25rem]">
            Sync your notes.
            <br />
            Send in your <em className="text-[var(--accent)]">agents</em>
            <span className="text-[var(--ink-faint)]">.</span>
            <span aria-hidden="true" className="hero-caret" />
          </h1>
          <p className="rise-in mx-auto mb-0 mt-6 max-w-2xl text-base leading-7 text-[var(--ink-soft)] [animation-delay:190ms]">
            Your docs mirror to disk as plain <code>.md</code> files. You write in any editor, collaborators type
            live in the browser, and AI agents push changes under their own identity — as reviewable suggestions
            if you want. Every edit merges through a CRDT. Nothing clobbers.
          </p>
          <div className="rise-in mt-9 flex flex-wrap items-center justify-center gap-3 [animation-delay:270ms]">
            {/* Color lives on the inner span: the global `a {color}` rule is
                un-layered and would beat a text-white utility on the anchor. */}
            <Link
              to="/login"
              className="rounded-lg border border-transparent bg-[var(--accent)] px-6 py-3 no-underline shadow-[0_8px_24px_-10px_var(--accent)] transition hover:bg-[var(--accent-deep)]"
            >
              <span className="text-sm font-semibold text-white">Continue with GitHub</span>
            </Link>
            {/* A fresh user needs the CLI on their PATH before anything else;
                the clone/sync loop is demoed in The Loop below. */}
            <CopyCommand command="npm i -g glyphdown" />
          </div>
        </div>
        <div className="rise-in mt-16 [animation-delay:380ms] sm:mt-20">
          <HeroVisual />
        </div>
      </div>
    </section>
  )
}
