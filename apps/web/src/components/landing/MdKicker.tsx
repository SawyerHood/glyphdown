/**
 * Landing section kicker styled as a markdown heading — the page's running
 * motif. The `##` marks are decorative (and lowercase reads as source, not
 * shouting), so screen readers get only the label text.
 */
export default function MdKicker({ children, className = '' }: { children: string; className?: string }) {
  return (
    <p className={`md-kicker m-0 ${className}`}>
      <span aria-hidden="true" className="select-none font-semibold text-[var(--accent)]">
        ##{' '}
      </span>
      {children.toLowerCase()}
    </p>
  )
}
