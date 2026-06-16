import type { ReactNode } from 'react'

/**
 * The accent brand/nav square that leads both the markdown editor and the HTML
 * asset viewer headers. Wrap it in the page's own (typed) Link.
 */
export function BrandSquare({ children }: { children: ReactNode }) {
  return (
    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--accent)] text-white">
      {children}
    </span>
  )
}

/**
 * Shared workspace header shell: a fixed-height bar with a leading brand/nav
 * slot, a title, optional trailing badges, and a right-aligned action cluster.
 * Both the markdown editor (`DocEditorPage`) and the HTML asset viewer render
 * through this so the two stay visually in lockstep — page-specific controls
 * (mode toggle, version, open-raw, …) go in `children`.
 */
export default function EditorHeader({
  brand,
  title,
  badges,
  children,
}: {
  brand: ReactNode
  title?: ReactNode
  badges?: ReactNode
  children?: ReactNode
}) {
  return (
    <header className="z-40 flex h-12 shrink-0 items-center gap-2 border-b border-[var(--line)] bg-[var(--paper)] px-3">
      {brand}
      {title}
      {badges}
      <div className="ml-auto flex items-center gap-1 sm:gap-1.5">{children}</div>
    </header>
  )
}
