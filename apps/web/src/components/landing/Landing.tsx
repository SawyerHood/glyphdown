import { Link } from '@tanstack/react-router'
import { PenLine } from 'lucide-react'
import ThemeToggle from '../ThemeToggle.tsx'
import Hero from './Hero.tsx'
import LoopSection from './LoopSection.tsx'
import FeatureGrid from './FeatureGrid.tsx'
import ClosingCta from './ClosingCta.tsx'

/**
 * The public landing page — rendered at `/` for signed-out visitors, without
 * the app Header/FileTree chrome (see __root.tsx). Everything here must be
 * SSR-clean: no window/document access during render.
 */

// The repo now lives at the renamed `glyphdown` slug (GitHub redirects the
// old slugs there).
const GITHUB_URL = 'https://github.com/SawyerHood/glyphdown'

function GitHubMark({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" width={size} height={size}>
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8z"
      />
    </svg>
  )
}

function Wordmark() {
  return (
    <span className="flex items-center gap-2 text-[var(--ink)]">
      <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--accent)] text-white">
        <PenLine size={15} />
      </span>
      <span className="display-title text-base font-bold tracking-tight">Glyphdown</span>
    </span>
  )
}

function LandingNav() {
  return (
    <header className="sticky top-0 z-50 border-b border-[var(--line)] bg-[var(--header-bg)] backdrop-blur-md">
      <nav className="page-wrap flex items-center gap-3 py-2.5">
        <Wordmark />
        {/* Anchor text/icon colors live on inner spans: the global un-layered
            `a {color}` rule beats color utilities placed on the anchor. */}
        <div className="ml-auto flex items-center gap-1">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            aria-label="Glyphdown on GitHub"
            className="group rounded-md p-2 transition hover:bg-[var(--paper-soft)]"
          >
            <span className="flex text-[var(--ink-soft)] transition group-hover:text-[var(--ink)]">
              <GitHubMark />
            </span>
          </a>
          <ThemeToggle />
          <Link
            to="/login"
            className="ml-2 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-4 py-1.5 no-underline transition hover:bg-[var(--paper-soft)]"
          >
            <span className="text-sm font-semibold text-[var(--ink)]">Sign in</span>
          </Link>
        </div>
      </nav>
    </header>
  )
}

function LandingFooter() {
  return (
    <footer className="border-t border-[var(--line)] py-10">
      <div className="page-wrap flex flex-col items-center justify-between gap-4 sm:flex-row">
        <Wordmark />
        <p className="island-kicker m-0">Self-hosted on Cloudflare Workers</p>
        <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="group no-underline">
          <span className="flex items-center gap-1.5 text-sm font-medium text-[var(--ink-soft)] transition group-hover:text-[var(--ink)]">
            <GitHubMark size={15} /> GitHub
          </span>
        </a>
      </div>
    </footer>
  )
}

export default function Landing() {
  return (
    <div className="min-h-screen bg-[var(--bg-base)]">
      <LandingNav />
      <main>
        <Hero />
        <LoopSection />
        <FeatureGrid />
        <ClosingCta />
      </main>
      <LandingFooter />
    </div>
  )
}
