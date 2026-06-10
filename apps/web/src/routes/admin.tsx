import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { FileText, ShieldCheck, Users } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { ApiError, getAdminStats } from '../lib/api.ts'
import { EmptyState, Spinner } from '../components/ui.tsx'

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
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <StatCard icon={Users} label="Users signed up" value={stats.data.users} />
          <StatCard
            icon={FileText}
            label="Documents created"
            value={stats.data.docs.created}
            hint={`${stats.data.docs.active} active, ${stats.data.docs.created - stats.data.docs.active} in trash`}
          />
        </div>
      ) : null}
    </main>
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
