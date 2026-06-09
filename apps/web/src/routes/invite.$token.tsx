import { useState } from 'react'
import { Link, createFileRoute, useNavigate, useRouterState } from '@tanstack/react-router'
import { useMutation, useQuery } from '@tanstack/react-query'
import { FileText, Folder, MailOpen, MailX } from 'lucide-react'
import { ApiError, acceptInvite, getInvite } from '../lib/api.ts'
import { track } from '../lib/analytics.ts'
import { Button, Spinner } from '../components/ui.tsx'

/**
 * Invite landing page (/invite/:token) — reachable signed OUT (allowlisted in
 * __root.tsx): recipients without an account see who invited them and what
 * they're getting, then ride the existing /login?next= flow through GitHub/
 * Google OAuth and land back here to accept. Signed-in visitors accept in one
 * click and are dropped into the doc (folder invites land on the dashboard).
 */

export const Route = createFileRoute('/invite/$token')({ component: InvitePage })

const ROLE_LABEL: Record<string, string> = {
  viewer: 'view',
  commenter: 'comment',
  suggester: 'suggest',
  editor: 'edit',
}

function InvitePage() {
  const { token } = Route.useParams()
  const navigate = useNavigate()
  const session = useRouterState({ select: (s) => s.matches[0]?.context.session ?? null })
  const [acceptError, setAcceptError] = useState<string | null>(null)

  const inviteQuery = useQuery({
    queryKey: ['invite', token],
    queryFn: () => getInvite(token),
    retry: false,
  })

  const accept = useMutation({
    mutationFn: () => acceptInvite(token),
    onSuccess: (result) => {
      track('invite_accepted', { targetType: result.targetType, role: result.role })
      if (result.targetType === 'doc') {
        void navigate({ to: '/d/$docId', params: { docId: result.targetId } })
      } else {
        void navigate({ to: '/' })
      }
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 410) {
        setAcceptError('This invitation has already been used by someone else.')
      } else if (err instanceof ApiError && err.status === 404) {
        setAcceptError('This invitation is no longer valid.')
      } else {
        setAcceptError('Something went wrong accepting the invite — try again.')
      }
    },
  })

  const invite = inviteQuery.data

  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--bg-base)] px-4">
      <section className="island-shell rise-in w-full max-w-md px-8 py-12 text-center">
        {inviteQuery.isLoading ? (
          <Spinner label="Looking up your invitation…" />
        ) : inviteQuery.isError || !invite ? (
          <>
            <span className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--paper-soft)] text-[var(--ink-faint)]">
              <MailX size={20} />
            </span>
            <h1 className="display-title m-0 mb-2 text-2xl font-bold tracking-tight text-[var(--ink)]">
              Invitation not found
            </h1>
            <p className="m-0 mb-6 text-sm text-[var(--ink-soft)]">
              This invite link is invalid or has been revoked. Ask the person who shared it to send a new one.
            </p>
            <Link to="/" className="text-sm font-semibold text-[var(--accent)] hover:underline">
              Go to Glyphdown
            </Link>
          </>
        ) : invite.accepted ? (
          <>
            <span className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--accent)] text-white">
              <MailOpen size={20} />
            </span>
            <h1 className="display-title m-0 mb-2 text-2xl font-bold tracking-tight text-[var(--ink)]">
              Already accepted
            </h1>
            <p className="m-0 mb-6 text-sm text-[var(--ink-soft)]">
              This invitation to “{invite.targetName}” has already been used.
            </p>
            <Link to="/" className="text-sm font-semibold text-[var(--accent)] hover:underline">
              Open Glyphdown
            </Link>
          </>
        ) : (
          <>
            <span className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--accent)] text-white">
              {invite.targetType === 'doc' ? <FileText size={20} /> : <Folder size={20} />}
            </span>
            <h1 className="display-title m-0 mb-2 text-2xl font-bold tracking-tight text-[var(--ink)]">
              You're invited
            </h1>
            <p className="m-0 mb-1 text-sm text-[var(--ink-soft)]">
              <strong className="text-[var(--ink)]">{invite.inviterName}</strong> invited you to the{' '}
              {invite.targetType === 'doc' ? 'document' : 'folder'}
            </p>
            <p className="m-0 mb-1 text-lg font-semibold text-[var(--ink)]">“{invite.targetName}”</p>
            <p className="m-0 mb-8 text-sm text-[var(--ink-soft)]">
              with permission to <strong className="text-[var(--ink)]">{ROLE_LABEL[invite.role] ?? invite.role}</strong>.
            </p>

            {session ? (
              <div className="flex flex-col items-center gap-3">
                <Button variant="primary" disabled={accept.isPending} onClick={() => accept.mutate()}>
                  Accept invitation
                </Button>
                {acceptError ? <p className="m-0 text-sm text-red-600">{acceptError}</p> : null}
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3">
                {/* A <button>, not a Link: the global anchor color rule would
                    paint Link text accent-on-accent. Routes through the
                    existing /login?next= flow so OAuth lands back here. */}
                <button
                  type="button"
                  onClick={() => void navigate({ to: '/login', search: { next: `/invite/${token}` } })}
                  className="rounded-lg border border-transparent bg-[var(--accent)] px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-[var(--accent-deep)]"
                >
                  Continue with GitHub
                </button>
                <p className="m-0 text-xs text-[var(--ink-faint)]">
                  Sign in or create a free account, then you'll land right back here.
                </p>
              </div>
            )}
          </>
        )}
      </section>
    </main>
  )
}
