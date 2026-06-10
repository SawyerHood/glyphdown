/**
 * The hero mock: a terminal running `glyphdown sync` / `glyphdown push --suggest` next to
 * the same doc in the browser with the agent's suggestion awaiting review.
 * Pure styled divs — decorative, so the whole thing is aria-hidden.
 */

/** Terminal text colors are fixed (a terminal stays dark in light mode). */
const T = {
  shell: '#11161d',
  chrome: '#1b222b',
  text: '#dbe3ea',
  dim: '#76828e',
  green: '#4ade80',
}

function TermLine({ children, color = T.text }: { children: React.ReactNode; color?: string }) {
  return (
    <div className="whitespace-pre" style={{ color }}>
      {children}
    </div>
  )
}

function Terminal() {
  return (
    <div
      className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-[var(--line)] shadow-lg"
      style={{ backgroundColor: T.shell }}
    >
      <div
        className="flex items-center gap-1.5 border-b px-3.5 py-2.5"
        style={{ backgroundColor: T.chrome, borderColor: 'rgba(255,255,255,0.06)' }}
      >
        <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
        <span className="ml-2 font-mono text-[11px]" style={{ color: T.dim }}>
          ~/notes
        </span>
      </div>
      <div className="overflow-x-auto px-4 py-3.5 font-mono text-[12px] leading-[1.7]">
        <TermLine>
          <span style={{ color: T.dim }}>$ </span>glyphdown sync
        </TermLine>
        <TermLine>
          launch-plan.md <span style={{ color: T.green }}>pushed</span>
        </TermLine>
        <TermLine>
          roadmap.md     <span style={{ color: T.green }}>merged</span>
        </TermLine>
        <TermLine>
          ideas.md       <span style={{ color: T.green }}>pulled</span>
        </TermLine>
        <TermLine color={T.dim}>1 pushed, 1 merged, 1 pulled</TermLine>
        <div className="h-3" />
        <TermLine color={T.dim}># your agent, pushing with its own key:</TermLine>
        <TermLine>
          <span style={{ color: T.dim }}>$ </span>glyphdown push launch-plan.md --suggest \
        </TermLine>
        <TermLine>{'    '}-m "tighten the launch intro"</TermLine>
        <TermLine>
          suggestion <span style={{ color: T.green }}>s_7f3a</span> created (version v42)
        </TermLine>
        <TermLine color={T.dim}>base unchanged — re-pull after review</TermLine>
      </div>
    </div>
  )
}

function DocMock() {
  return (
    <div className="island-shell flex min-w-0 flex-col overflow-hidden shadow-lg">
      <div className="flex items-center gap-2 border-b border-[var(--line)] px-4 py-2.5">
        <span className="display-title text-sm font-bold text-[var(--ink)]">Launch Plan</span>
        <span className="ml-auto flex -space-x-1.5">
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#2563eb] text-[9px] font-bold text-white ring-2 ring-[var(--paper)]">
            K
          </span>
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#7c3aed] text-[9px] font-bold text-white ring-2 ring-[var(--paper)]">
            C
          </span>
        </span>
      </div>
      <div className="px-5 py-4 text-[13px] leading-6 text-[var(--ink)]">
        <p className="display-title m-0 mb-2 text-base font-bold">Why now</p>
        <p className="m-0">
          The editor and the CLI have shipped.{' '}
          <span className="rounded-sm bg-red-500/15 text-[var(--ink-faint)] line-through decoration-red-500/60">
            We will probably launch at some point next quarter.
          </span>{' '}
          <span className="rounded-sm bg-green-500/20">We launch October 6, with a two-week open beta.</span>{' '}
          Docs and pricing follow in the same window.
        </p>
        <div className="mt-4 rounded-lg border border-[var(--line)] bg-[var(--paper-soft)] p-3">
          <div className="flex items-center gap-2">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#7c3aed] text-[9px] font-bold text-white">
              C
            </span>
            <span className="min-w-0 truncate text-xs text-[var(--ink)]">
              <strong>Claude</strong> <span className="text-[var(--ink-faint)]">· run by kirby</span> suggested
              changes
            </span>
          </div>
          <p className="m-0 mt-1.5 pl-7 text-xs italic text-[var(--ink-soft)]">“tighten the launch intro”</p>
          <div className="mt-2 flex gap-1.5 pl-7">
            <span className="rounded-md bg-[var(--accent)] px-2.5 py-1 text-[11px] font-semibold text-white">
              Accept
            </span>
            <span className="rounded-md border border-[var(--line)] bg-[var(--paper)] px-2.5 py-1 text-[11px] font-semibold text-[var(--ink-soft)]">
              Reject
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function HeroVisual() {
  return (
    <div aria-hidden="true" className="relative grid items-start gap-5 lg:grid-cols-2 lg:gap-8">
      <Terminal />
      {/* The suggestion's journey: terminal push → doc review (lg+ only). */}
      <span className="absolute left-1/2 top-24 z-10 hidden h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full border border-[var(--line)] bg-[var(--paper)] text-[var(--accent)] shadow-md lg:flex">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M2.5 8h10M9 4.5 13 8l-4 3.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <DocMock />
    </div>
  )
}
