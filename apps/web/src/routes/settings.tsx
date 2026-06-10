import { useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bot, Check, Copy, KeyRound, Mail, Plus } from 'lucide-react'
import {
  getPrefs,
  listAgents,
  listNotifications,
  markNotificationsRead,
  mintAgent,
  revokeAgent,
  setPrefs,
  type MintedAgent,
} from '../lib/api.ts'
import { timeAgo } from '../lib/presence.ts'
import { resetNux } from '../lib/nux.ts'
import { useSession } from '../lib/session.ts'
import { Badge, Button, ConfirmDialog, Dialog, EmptyState, Input, Spinner } from '../components/ui.tsx'

export const Route = createFileRoute('/settings')({ component: SettingsPage })

function SettingsPage() {
  const { data: session } = useSession()
  return (
    <main className="page-wrap py-8">
      <h1 className="display-title m-0 mb-1 text-2xl font-bold text-[var(--ink)]">Settings</h1>
      <p className="m-0 mb-8 text-sm text-[var(--ink-soft)]">
        {session?.user ? `Signed in as ${session.user.name} (${session.user.email})` : ''}
      </p>
      <AgentsSection />
      <PreferencesSection />
      <NotificationsSection />
    </main>
  )
}

function PreferencesSection() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { data: session } = useSession()
  const prefsQuery = useQuery({ queryKey: ['prefs'], queryFn: getPrefs })
  const save = useMutation({
    mutationFn: setPrefs,
    onSuccess: (next) => queryClient.setQueryData(['prefs'], next),
  })
  const enabled = prefsQuery.data?.emailNotifications ?? true

  return (
    <section className="mb-10">
      <h2 className="m-0 mb-3 flex items-center gap-2 text-base font-semibold text-[var(--ink)]">
        <Mail size={16} /> Preferences
      </h2>
      <div className="island-shell divide-y divide-[var(--line)] overflow-hidden">
        <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5">
          <input
            type="checkbox"
            checked={enabled}
            disabled={prefsQuery.isLoading || save.isPending}
            onChange={(e) => save.mutate({ emailNotifications: e.target.checked })}
            className="h-4 w-4 accent-[var(--accent)]"
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium text-[var(--ink)]">Email me when I'm mentioned</span>
            <span className="block text-xs text-[var(--ink-soft)]">
              Mention notifications by email. Invitations to documents are always delivered.
            </span>
          </span>
        </label>
        <div className="flex items-center gap-3 px-3 py-2.5">
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-[var(--ink)]">Welcome guide</span>
            <span className="block text-xs text-[var(--ink-soft)]">
              The first-run walkthrough: install the CLI, teach your agent the skill, put it to work.
            </span>
          </span>
          <Button
            size="sm"
            disabled={!session?.user}
            onClick={() => {
              if (!session?.user) return
              resetNux(session.user.id)
              void navigate({ to: '/' })
            }}
          >
            Show again
          </Button>
        </div>
      </div>
    </section>
  )
}

function AgentsSection() {
  const queryClient = useQueryClient()
  const agentsQuery = useQuery({ queryKey: ['agents'], queryFn: listAgents })
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [minted, setMinted] = useState<MintedAgent | null>(null)
  const [revoking, setRevoking] = useState<{ id: string; name: string } | null>(null)
  const [copied, setCopied] = useState(false)

  const mint = useMutation({
    mutationFn: mintAgent,
    onSuccess: (agent) => {
      setMinted(agent)
      setNaming(false)
      setName('')
      void queryClient.invalidateQueries({ queryKey: ['agents'] })
    },
  })
  const revoke = useMutation({
    mutationFn: revokeAgent,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agents'] }),
  })

  const agents = agentsQuery.data ?? []

  return (
    <section className="mb-10">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="m-0 flex items-center gap-2 text-base font-semibold text-[var(--ink)]">
          <Bot size={16} /> Agents
        </h2>
        <div className="ml-auto">
          <Button variant="primary" size="sm" onClick={() => setNaming(true)}>
            <Plus size={13} /> New agent key
          </Button>
        </div>
      </div>
      <p className="m-0 mb-3 text-xs text-[var(--ink-soft)]">
        Agents act with your access but their edits, comments, and suggestions are attributed to the agent
        identity. Use the key with the <code>glyphdown</code> CLI via <code>GLYPHDOWN_API_KEY</code>. New keys mint
        as <code>gd_sk_…</code>; keys minted before the rename (<code>ink_sk_…</code>) keep working.
      </p>

      {agentsQuery.isLoading ? (
        <Spinner />
      ) : agents.length === 0 ? (
        <EmptyState title="No agents yet" hint="Mint a key for Claude Code or any other tool." />
      ) : (
        <ul className="island-shell m-0 list-none divide-y divide-[var(--line)] overflow-hidden p-0">
          {agents.map((agent) => (
            <li key={agent.id} className="flex items-center gap-3 px-3 py-2.5">
              <KeyRound size={14} className="shrink-0 text-[var(--ink-faint)]" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--ink)]">{agent.name}</span>
              {agent.revokedAt !== null ? <Badge tone="red">revoked</Badge> : <Badge tone="green">active</Badge>}
              <span className="hidden text-xs text-[var(--ink-faint)] sm:inline">created {timeAgo(agent.createdAt)}</span>
              {agent.revokedAt === null ? (
                <Button size="sm" onClick={() => setRevoking({ id: agent.id, name: agent.name })}>
                  Revoke
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <Dialog open={naming} onClose={() => setNaming(false)} title="New agent key">
        <Input
          value={name}
          onChange={setName}
          autoFocus
          placeholder="Agent name (e.g. Claude Code)"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && name.trim() !== '') mint.mutate(name.trim())
          }}
        />
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={() => setNaming(false)}>Cancel</Button>
          <Button variant="primary" disabled={name.trim() === '' || mint.isPending} onClick={() => mint.mutate(name.trim())}>
            Mint key
          </Button>
        </div>
      </Dialog>

      <Dialog
        open={minted !== null}
        onClose={() => {
          setMinted(null)
          setCopied(false)
        }}
        title={`API key for ${minted?.name ?? ''}`}
      >
        <p className="m-0 mb-3 text-sm text-[var(--ink-soft)]">
          Copy this key now — it is shown <strong>only once</strong>. Only a hash is stored.
        </p>
        <div className="flex items-center gap-2">
          <code className="block min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-md border border-[var(--line)] bg-[var(--paper-soft)] px-2 py-2 text-xs">
            {minted?.key}
          </code>
          <Button
            onClick={() => {
              if (minted) {
                void navigator.clipboard.writeText(minted.key)
                setCopied(true)
              }
            }}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      </Dialog>

      <ConfirmDialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        onConfirm={() => {
          if (revoking) revoke.mutate(revoking.id)
        }}
        title="Revoke agent key"
        body={`Revoke “${revoking?.name ?? ''}”? The key stops working on the next request.`}
        confirmLabel="Revoke"
        danger
      />
    </section>
  )
}

function NotificationsSection() {
  const queryClient = useQueryClient()
  const { data: notifications = [], isLoading } = useQuery({
    queryKey: ['notifications'],
    queryFn: listNotifications,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  })
  const markRead = useMutation({
    mutationFn: () => markNotificationsRead(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  })
  const unread = notifications.filter((n) => n.readAt === null).length

  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <h2 className="m-0 text-base font-semibold text-[var(--ink)]">Notifications</h2>
        {unread > 0 ? <Badge tone="blue">{unread} unread</Badge> : null}
        {unread > 0 ? (
          <div className="ml-auto">
            <Button size="sm" onClick={() => markRead.mutate()}>
              Mark all read
            </Button>
          </div>
        ) : null}
      </div>
      {isLoading ? (
        <Spinner />
      ) : notifications.length === 0 ? (
        <EmptyState title="Inbox zero" hint="Mentions, replies, and shares land here." />
      ) : (
        <ul className="island-shell m-0 list-none divide-y divide-[var(--line)] overflow-hidden p-0">
          {notifications.map((n) => (
            <li key={n.id} className="flex items-center gap-3 px-3 py-2.5 text-sm">
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${n.readAt === null ? 'bg-[var(--accent)]' : 'bg-transparent'}`} />
              <span className={`min-w-0 flex-1 ${n.readAt === null ? 'font-medium text-[var(--ink)]' : 'text-[var(--ink-soft)]'}`}>
                {describeNotification(n.type, n.payload)}
              </span>
              <span className="whitespace-nowrap text-xs text-[var(--ink-faint)]">{timeAgo(n.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function describeNotification(type: string, payload: Record<string, unknown> | null): string {
  const p = payload ?? {}
  const byName = typeof p['byName'] === 'string' ? (p['byName'] as string) : 'Someone'
  const title =
    typeof p['docTitle'] === 'string'
      ? (p['docTitle'] as string)
      : typeof p['title'] === 'string'
        ? (p['title'] as string)
        : 'a document'
  switch (type) {
    case 'mention':
      return `${byName} mentioned you in “${title}”`
    case 'doc-shared':
      return `${byName} shared “${title}” with you`
    case 'folder-shared':
      // Vault shares (folder targets whose folder is a vault root) say "vault".
      return `${byName} shared the ${p['kind'] === 'vault' ? 'vault' : 'folder'} “${title}” with you`
    case 'comment-reply':
      return `${byName} replied to your comment in “${title}”`
    case 'invite-accepted': {
      const invitedEmail = typeof p['invitedEmail'] === 'string' ? (p['invitedEmail'] as string) : null
      const byEmail = typeof p['byEmail'] === 'string' ? (p['byEmail'] as string) : null
      // Token possession is authority — surface a mismatch between the
      // invited address and the account that accepted.
      const via = invitedEmail && byEmail && invitedEmail !== byEmail ? ` (invite sent to ${invitedEmail})` : ''
      return `${byName} accepted your invite to “${title}”${via}`
    }
    default:
      return `${byName}: ${type}`
  }
}
