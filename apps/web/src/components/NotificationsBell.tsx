import { useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell } from 'lucide-react'
import { listNotifications, markNotificationsRead, type NotificationItem } from '../lib/api.ts'
import { timeAgo } from '../lib/presence.ts'
import { useDismissable } from '../lib/useDismissable.ts'

function notificationText(n: NotificationItem): { text: string; docId: string | null } {
  const p = n.payload ?? {}
  const byName = typeof p['byName'] === 'string' ? (p['byName'] as string) : 'Someone'
  const title = typeof p['docTitle'] === 'string' ? (p['docTitle'] as string) : typeof p['title'] === 'string' ? (p['title'] as string) : 'a document'
  const docId = typeof p['docId'] === 'string' ? (p['docId'] as string) : null
  switch (n.type) {
    case 'mention':
      return { text: `${byName} mentioned you in “${title}”`, docId }
    case 'doc-shared':
      return { text: `${byName} shared “${title}” with you`, docId }
    case 'folder-shared': {
      // Vault shares (folder targets whose folder is a vault root) say "vault".
      const noun = p['kind'] === 'vault' ? 'vault' : 'folder'
      return { text: `${byName} shared the ${noun} “${title}” with you`, docId: null }
    }
    case 'comment-reply':
      return { text: `${byName} replied to your comment in “${title}”`, docId }
    case 'suggestion':
      return { text: `${byName} suggested changes to “${title}”`, docId }
    case 'invite-accepted': {
      const invitedEmail = typeof p['invitedEmail'] === 'string' ? (p['invitedEmail'] as string) : null
      const byEmail = typeof p['byEmail'] === 'string' ? (p['byEmail'] as string) : null
      const via = invitedEmail && byEmail && invitedEmail !== byEmail ? ` (invite sent to ${invitedEmail})` : ''
      return { text: `${byName} accepted your invite to “${title}”${via}`, docId }
    }
    default:
      return { text: `${byName}: ${n.type}`, docId }
  }
}

/** Header bell: polls the D1-backed inbox (SPEC §9 — 30s interval + focus). */
export default function NotificationsBell() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const queryClient = useQueryClient()

  const { data: notifications = [] } = useQuery({
    queryKey: ['notifications'],
    queryFn: listNotifications,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  })
  const unread = notifications.filter((n) => n.readAt === null)

  const markRead = useMutation({
    mutationFn: (ids?: string[]) => markNotificationsRead(ids),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  })

  useDismissable(open, ref, () => setOpen(false))

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="relative rounded-md p-2 text-[var(--ink-soft)] transition hover:bg-[var(--paper-soft)] hover:text-[var(--ink)]"
        aria-label={`Notifications${unread.length > 0 ? ` (${unread.length} unread)` : ''}`}
      >
        <Bell size={16} />
        {unread.length > 0 ? (
          <span className="absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--accent)] px-1 text-[10px] font-bold text-white">
            {unread.length > 9 ? '9+' : unread.length}
          </span>
        ) : null}
      </button>

      {open ? (
        // Below sm the fixed 320px panel would stick out past the left
        // viewport edge (unscrollable). The header's backdrop-blur makes it
        // the containing block for `fixed`, so inset-x-4/top-14 pin the
        // panel just under the sticky header, inside the viewport.
        <div className="fixed inset-x-4 top-14 z-50 rounded-lg border border-[var(--line)] bg-[var(--paper)] shadow-lg sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-1 sm:w-80">
          <div className="flex items-center justify-between border-b border-[var(--line)] px-3 py-2">
            <span className="text-xs font-semibold text-[var(--ink)]">Notifications</span>
            {unread.length > 0 ? (
              <button
                type="button"
                onClick={() => markRead.mutate(undefined)}
                className="text-xs text-[var(--accent)] hover:underline"
              >
                Mark all read
              </button>
            ) : null}
          </div>
          <div className="max-h-80 overflow-y-auto">
            {notifications.length === 0 ? (
              <p className="m-0 px-3 py-6 text-center text-xs text-[var(--ink-faint)]">No notifications yet.</p>
            ) : (
              notifications.slice(0, 30).map((n) => {
                const { text, docId } = notificationText(n)
                const inner = (
                  <>
                    <span className={n.readAt === null ? 'font-medium text-[var(--ink)]' : 'text-[var(--ink-soft)]'}>
                      {text}
                    </span>
                    <span className="mt-0.5 block text-[11px] text-[var(--ink-faint)]">{timeAgo(n.createdAt)}</span>
                  </>
                )
                const className = 'block border-b border-[var(--line)] px-3 py-2 text-xs last:border-b-0 hover:bg-[var(--paper-soft)]'
                return docId ? (
                  <Link
                    key={n.id}
                    to="/d/$docId"
                    params={{ docId }}
                    className={className}
                    onClick={() => {
                      if (n.readAt === null) markRead.mutate([n.id])
                      setOpen(false)
                    }}
                  >
                    {inner}
                  </Link>
                ) : (
                  <div
                    key={n.id}
                    className={className}
                    onClick={() => {
                      if (n.readAt === null) markRead.mutate([n.id])
                    }}
                  >
                    {inner}
                  </div>
                )
              })
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}
