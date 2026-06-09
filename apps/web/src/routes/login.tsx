import { createFileRoute, redirect } from '@tanstack/react-router'
import { PenLine } from 'lucide-react'
import { authClient } from '../lib/auth-client.ts'
import { getServerSession } from '../lib/session.ts'

/** Same-origin path only — anything else falls back to home. */
function safeNext(next: unknown): string {
  return typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') ? next : '/'
}

export const Route = createFileRoute('/login')({
  validateSearch: (search: Record<string, unknown>): { next?: string } =>
    typeof search['next'] === 'string' ? { next: search['next'] } : {},
  beforeLoad: async ({ search }) => {
    const session = await getServerSession()
    if (session) throw redirect({ href: safeNext(search.next) })
  },
  component: LoginPage,
})

function LoginPage() {
  const { next } = Route.useSearch()
  const signIn = (provider: 'github' | 'google') => {
    void authClient.signIn.social({ provider, callbackURL: safeNext(next) })
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--bg-base)] px-4">
      <section className="island-shell rise-in w-full max-w-md px-8 py-12 text-center">
        <span className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--accent)] text-white">
          <PenLine size={20} />
        </span>
        <h1 className="display-title m-0 mb-2 text-3xl font-bold tracking-tight text-[var(--ink)]">Glyphdown</h1>
        <p className="m-0 mb-8 text-sm text-[var(--ink-soft)]">
          Google Docs for markdown — real-time editing, comments, suggestions, and agents as collaborators.
        </p>
        <div className="flex flex-col gap-3">
          <button
            type="button"
            onClick={() => signIn('github')}
            className="rounded-lg border border-[var(--line)] bg-[var(--paper)] px-5 py-2.5 text-sm font-semibold text-[var(--ink)] transition hover:bg-[var(--paper-soft)]"
          >
            Continue with GitHub
          </button>
          <button
            type="button"
            onClick={() => signIn('google')}
            className="rounded-lg border border-transparent bg-[var(--accent)] px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-[var(--accent-deep)]"
          >
            Continue with Google
          </button>
        </div>
      </section>
    </main>
  )
}
