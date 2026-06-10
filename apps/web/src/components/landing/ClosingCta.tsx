import { Link } from '@tanstack/react-router'
import { CopyCommand } from './CodeBlock.tsx'
import MdKicker from './MdKicker.tsx'

/**
 * Final conversion band: the page previously just trailed off after the
 * agents section. Mirrors the hero's CTA pair so the bottom of the page can
 * close the loop without scrolling back up.
 */
export default function ClosingCta() {
  return (
    <section className="relative overflow-hidden border-t border-[var(--line)]">
      <div aria-hidden="true" className="land-atmosphere absolute inset-0 rotate-180" />
      <div className="page-wrap relative py-24 text-center">
        <div className="reveal-up">
          <MdKicker className="mb-4">Get started</MdKicker>
          <h2 className="display-title m-0 text-3xl font-bold tracking-tight text-[var(--ink-heading)] sm:text-4xl">
            Your notes are already markdown.
            <br />
            Give them a <em className="text-[var(--accent)]">doc</em>
            <span className="text-[var(--ink-faint)]">.</span>
          </h2>
          <p className="mx-auto mb-0 mt-4 max-w-xl text-sm leading-7 text-[var(--ink-soft)]">
            Sign in, <code>glyphdown clone</code>, and your whole workspace is on disk — ready for you and your
            agents.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link
              to="/login"
              className="rounded-lg border border-transparent bg-[var(--accent)] px-6 py-3 no-underline shadow-[0_8px_24px_-10px_var(--accent)] transition hover:bg-[var(--accent-deep)]"
            >
              <span className="text-sm font-semibold text-white">Continue with GitHub</span>
            </Link>
            <CopyCommand command="npm i -g glyphdown" />
          </div>
        </div>
      </div>
    </section>
  )
}
