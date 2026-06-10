import { FolderTree, GitPullRequest, History, MessageSquare, PenLine, Users } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import MdKicker from './MdKicker.tsx'

const FEATURES: Array<{ icon: LucideIcon; title: string; body: string }> = [
  {
    icon: PenLine,
    title: 'Live-preview editor',
    body: 'Obsidian-style live preview on CodeMirror. The document is plain markdown text — formatting renders in place and syntax reveals at your cursor.',
  },
  {
    icon: Users,
    title: 'Real-time multiplayer',
    body: 'CRDT-backed editing with live cursors and presence. Concurrent edits merge; connection blips buffer and resync.',
  },
  {
    icon: MessageSquare,
    title: 'Comments & mentions',
    body: 'Range-anchored threads with @mentions, reactions, and resolve. Anchors survive edits — orphaned comments are kept, never dropped.',
  },
  {
    icon: GitPullRequest,
    title: 'Suggestion mode',
    body: 'Propose changes instead of making them — insertions in green, deletions struck through — then accept or reject each one.',
  },
  {
    icon: FolderTree,
    title: 'Folders, sharing & roles',
    body: 'Share a doc or a whole folder by invite or link, with view / comment / suggest / edit roles enforced server-side.',
  },
  {
    icon: History,
    title: 'Version history',
    body: 'Automatic snapshots plus named versions. Diff any version against the current text and restore it.',
  },
]

export default function FeatureGrid() {
  return (
    <section className="border-t border-[var(--line)] py-20">
      <div className="page-wrap">
        <div className="reveal-up mb-12 max-w-2xl">
          <MdKicker className="mb-3">Everything a doc needs</MdKicker>
          <h2 className="display-title m-0 text-3xl font-bold tracking-tight text-[var(--ink)]">
            The Google Docs parts, on plain markdown
          </h2>
        </div>
        <div className="reveal-up grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(({ icon: Icon, title, body }) => (
            <div key={title} className="island-shell feature-card p-5">
              <h3 className="m-0 mb-2 flex items-center gap-2.5 text-[15px] font-semibold text-[var(--ink)]">
                <Icon size={16} className="shrink-0 text-[var(--accent)]" aria-hidden="true" />
                {title}
              </h3>
              <p className="m-0 text-[13px] leading-6 text-[var(--ink-soft)]">{body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
