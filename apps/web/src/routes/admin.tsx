import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Bug, FileText, Lightbulb, MessageSquarePlus, ShieldCheck, Users } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { ApiError, getAdminFeedback, getAdminStats } from '../lib/api.ts'
import { timeAgo } from '../lib/presence.ts'
import { Badge, EmptyState, Spinner } from '../components/ui.tsx'

export const Route = createFileRoute('/admin')({ component: AdminPage })

function AdminPage() {
  const stats = useQuery({
    queryKey: ['admin-stats'],
    queryFn: getAdminStats,
    // Non-admins get a hard 404 from the API — retrying won't change that.
    retry: false,
    refetchInterval: 60_000,
  })

  return (
    <main className="page-wrap py-8">
      <h1 className="display-title m-0 mb-1 flex items-center gap-2 text-2xl font-bold text-[var(--ink)]">
        <ShieldCheck size={22} /> Admin
      </h1>
      <p className="m-0 mb-8 text-sm text-[var(--ink-soft)]">Site-wide usage at a glance.</p>

      {stats.isLoading ? (
        <Spinner />
      ) : stats.isError ? (
        <EmptyState
          title={statusOf(stats.error) === 401 ? 'Sign in to continue' : 'Nothing to see here'}
          hint={statusOf(stats.error) === 401 ? 'This page requires an account.' : 'This page is for site admins.'}
        />
      ) : stats.data ? (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <StatCard icon={Users} label="Users signed up" value={stats.data.users} />
            <StatCard
              icon={FileText}
              label="Documents created"
              value={stats.data.docs.created}
              hint={`${stats.data.docs.active} active, ${stats.data.docs.created - stats.data.docs.active} in trash`}
            />
          </div>
          <FeedbackSection />
        </>
      ) : null}
    </main>
  )
}

function FeedbackSection() {
  // Only mounted once the stats query proved the caller is an admin.
  const { data: items = [], isLoading } = useQuery({
    queryKey: ['admin-feedback'],
    queryFn: getAdminFeedback,
    retry: false,
    refetchInterval: 60_000,
  })

  return (
    <section className="mt-10">
      <h2 className="m-0 mb-3 flex items-center gap-2 text-base font-semibold text-[var(--ink)]">
        <MessageSquarePlus size={16} /> Feedback
        {items.length > 0 ? <Badge tone="blue">{items.length}</Badge> : null}
      </h2>
      {isLoading ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState title="No feedback yet" hint="Feature requests and bug reports from the header dialog land here." />
      ) : (
        <ul className="island-shell m-0 list-none divide-y divide-[var(--line)] overflow-hidden p-0">
          {items.map((f) => (
            <li key={f.id} className="px-4 py-3">
              <div className="flex items-center gap-2 text-xs text-[var(--ink-faint)]">
                {f.type === 'bug' ? (
                  <Badge tone="red">
                    <Bug size={11} /> bug
                  </Badge>
                ) : (
                  <Badge tone="blue">
                    <Lightbulb size={11} /> feature
                  </Badge>
                )}
                <span className="truncate font-medium text-[var(--ink-soft)]">
                  {f.user.name}
                  {f.user.email ? ` (${f.user.email})` : ''}
                  {f.filedByAgent ? ' · via agent' : ''}
                </span>
                {f.page ? <code className="truncate">{f.page}</code> : null}
                <span className="ml-auto whitespace-nowrap">{timeAgo(f.createdAt)}</span>
              </div>
              <p className="m-0 mt-1.5 whitespace-pre-wrap text-sm leading-6 text-[var(--ink)]">{f.body}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function StatCard({ icon: Icon, label, value, hint }: { icon: LucideIcon; label: string; value: number; hint?: string }) {
  return (
    <section className="island-shell flex flex-col gap-1 p-5">
      <span className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-[var(--ink-soft)]">
        <Icon size={14} /> {label}
      </span>
      <span className="text-4xl font-bold tabular-nums text-[var(--ink)]">{value.toLocaleString()}</span>
      {hint ? <span className="text-xs text-[var(--ink-faint)]">{hint}</span> : null}
    </section>
  )
}

function statusOf(err: unknown): number | null {
  return err instanceof ApiError ? err.status : null
}
