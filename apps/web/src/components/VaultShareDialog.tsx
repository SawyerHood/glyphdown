import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, Link2, Trash2, UserPlus } from 'lucide-react'
import type { Role } from '@glyphdown/protocol'
import {
  ApiError,
  addFolderMember,
  createFolderInvite,
  createFolderShareLink,
  listFolderInvites,
  listFolderMembers,
  listFolderShareLinks,
  removeFolderMember,
  revokeFolderShareLink,
  revokeInvite,
  type FolderInfo,
  type InviteResult,
  type MemberInfo,
} from '../lib/api.ts'
import { track } from '../lib/analytics.ts'
import { Badge, Button, Dialog, Input, Select, Spinner } from './ui.tsx'

const GRANTABLE: ReadonlyArray<{ value: Role; label: string }> = [
  { value: 'viewer', label: 'can view' },
  { value: 'commenter', label: 'can comment' },
  { value: 'suggester', label: 'can suggest' },
  { value: 'editor', label: 'can edit' },
]

/**
 * Owner-only sharing UI for a VAULT — the doc ShareDialog's flow on the
 * vault's folder root (a grant there covers every doc in the vault): share
 * links (copying the /f/:folderId landing URL — anyone with the link browses
 * the whole vault at the link's role, anonymous capped at viewer), invites
 * by email, and member role editing.
 */
export default function VaultShareDialog({
  vault,
  open,
  onClose,
}: {
  vault: FolderInfo
  open: boolean
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [linkRole, setLinkRole] = useState<Role>('viewer')
  const [copiedToken, setCopiedToken] = useState<string | null>(null)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<Role>('editor')
  const [inviteResult, setInviteResult] = useState<InviteResult | null>(null)
  const [inviteUrlCopied, setInviteUrlCopied] = useState(false)

  const membersQuery = useQuery({
    queryKey: ['folder-members', vault.id],
    queryFn: () => listFolderMembers(vault.id),
    enabled: open,
  })
  const linksQuery = useQuery({
    queryKey: ['folder-share-links', vault.id],
    queryFn: () => listFolderShareLinks(vault.id),
    enabled: open,
    retry: false,
  })
  // Pending email invites (owner-only endpoint — this dialog is owner-only).
  const invitesQuery = useQuery({
    queryKey: ['folder-invites', vault.id],
    queryFn: () => listFolderInvites(vault.id),
    enabled: open,
    retry: false,
  })

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['folder-members', vault.id] })
    void queryClient.invalidateQueries({ queryKey: ['folder-invites', vault.id] })
    void queryClient.invalidateQueries({ queryKey: ['folder-share-links', vault.id] })
  }

  // The copyable URL is the landing page: anyone with it (signed in or not)
  // browses the vault's subtree there and opens docs with the token along.
  const shareUrl = (token: string) => `${window.location.origin}/f/${vault.id}?share=${token}`
  const copyLink = async (token: string) => {
    try {
      await navigator.clipboard.writeText(shareUrl(token))
      setCopiedToken(token)
      setTimeout(() => setCopiedToken(null), 2000)
    } catch {
      // clipboard unavailable — the URL is still visible in the row
    }
  }
  const createLink = useMutation({
    mutationFn: () => createFolderShareLink(vault.id, linkRole),
    onSuccess: (link) => {
      track('vault_shared', { role: link.role, via: 'share-link' })
      invalidate()
      void copyLink(link.token)
    },
  })
  const revokeLink = useMutation({
    mutationFn: (token: string) => revokeFolderShareLink(vault.id, token),
    onSuccess: invalidate,
  })

  // Invite by email — works for non-users too (they get an email + landing link).
  const invite = useMutation({
    mutationFn: () => createFolderInvite(vault.id, { email: inviteEmail.trim(), role: inviteRole }),
    onSuccess: (result) => {
      track('invite_sent', { targetType: 'folder', role: result.role, status: result.status })
      setInviteEmail('')
      setInviteResult(result)
      setInviteUrlCopied(false)
      invalidate()
    },
    onError: () => setInviteResult(null),
  })
  const revokePending = useMutation({ mutationFn: (token: string) => revokeInvite(token), onSuccess: invalidate })
  const changeRole = useMutation({
    mutationFn: ({ member, role }: { member: MemberInfo; role: Role }) =>
      addFolderMember(
        vault.id,
        member.principalType === 'agent' ? { agentId: member.principalId, role } : { email: member.email ?? '', role },
      ),
    onSuccess: invalidate,
  })
  const remove = useMutation({
    mutationFn: (principalId: string) => removeFolderMember(vault.id, principalId),
    onSuccess: invalidate,
  })

  const copyInviteUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url)
      setInviteUrlCopied(true)
      setTimeout(() => setInviteUrlCopied(false), 2000)
    } catch {
      // clipboard unavailable
    }
  }

  const inviteErrorText = (err: unknown): string => {
    if (err instanceof ApiError) {
      if (err.status === 429) return 'Invite limit reached (20/hour) — try again later.'
      if (err.code === 'already-owner') return 'That email belongs to the vault owner.'
      if (err.code === 'bad-email') return 'That does not look like an email address.'
    }
    return 'Invite failed.'
  }

  const members = membersQuery.data ?? []
  const pendingInvites = invitesQuery.data ?? []

  return (
    <Dialog open={open} onClose={onClose} title={`Share vault “${vault.name}”`} wide>
      <p className="m-0 mb-5 text-xs text-[var(--ink-soft)]">
        People you share this vault with get access to <strong>every document inside it</strong>, including new ones.
      </p>

      {/* Share links — copy the /f/:folderId landing URL */}
      <section className="mb-5">
        <h3 className="island-kicker m-0 mb-2 flex items-center gap-1">
          <Link2 size={11} /> Share links
        </h3>
        <div className="mb-2 flex items-center gap-2">
          <span className="text-sm text-[var(--ink-soft)]">Anyone with the link</span>
          <Select value={linkRole} onChange={setLinkRole} options={GRANTABLE} />
          <Button variant="primary" size="sm" disabled={createLink.isPending} onClick={() => createLink.mutate()}>
            Create link
          </Button>
        </div>
        {linksQuery.isLoading ? (
          <Spinner />
        ) : (linksQuery.data ?? []).length === 0 ? (
          <p className="m-0 text-xs text-[var(--ink-faint)]">No active links.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {(linksQuery.data ?? []).map((link) => (
              <li key={link.token} className="flex items-center gap-2 rounded-md border border-[var(--line)] px-2 py-1.5">
                <Badge tone="blue">{link.role}</Badge>
                <code className="min-w-0 flex-1 truncate text-[11px] text-[var(--ink-soft)]">{shareUrl(link.token)}</code>
                <Button size="sm" variant="ghost" onClick={() => void copyLink(link.token)} title="Copy URL">
                  {copiedToken === link.token ? <Check size={13} /> : <Copy size={13} />}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => revokeLink.mutate(link.token)} title="Revoke link">
                  <Trash2 size={13} />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <p className="m-0 mt-1 text-[11px] text-[var(--ink-faint)]">
          Links open a browsable view of the whole vault. Visitors who aren&rsquo;t signed in can only view.
        </p>
      </section>

      {/* Invite */}
      <section className="mb-5">
        <h3 className="island-kicker m-0 mb-2 flex items-center gap-1">
          <UserPlus size={11} /> Invite people
        </h3>
        <div className="flex items-center gap-2">
          {/* min-w-0 lets the email input give way (flex inputs keep a
              ~170px automatic minimum otherwise) so the role select and the
              Invite button stay on-screen inside narrow dialogs. */}
          <Input
            className="min-w-0"
            value={inviteEmail}
            onChange={(v) => {
              setInviteEmail(v)
              if (inviteResult) setInviteResult(null)
            }}
            placeholder="email@example.com"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && inviteEmail.trim() !== '') invite.mutate()
            }}
          />
          <Select className="shrink-0" value={inviteRole} onChange={setInviteRole} options={GRANTABLE} />
          <Button className="shrink-0" variant="primary" size="sm" disabled={inviteEmail.trim() === '' || invite.isPending} onClick={() => invite.mutate()}>
            Invite
          </Button>
        </div>
        <p className="m-0 mt-1 text-[11px] text-[var(--ink-faint)]">
          No account needed — people without one get an email invitation and sign up on the way in.
        </p>
        {invite.isError ? <p className="m-0 mt-1 text-xs text-red-600">{inviteErrorText(invite.error)}</p> : null}
        {inviteResult ? (
          inviteResult.status === 'added' ? (
            <p className="m-0 mt-1 text-xs text-green-700 dark:text-green-500">
              {inviteResult.email} already has an account — added with access immediately
              {inviteResult.emailSent ? ' and notified by email.' : '.'}
            </p>
          ) : inviteResult.emailSent ? (
            <p className="m-0 mt-1 text-xs text-green-700 dark:text-green-500">
              Invitation sent to {inviteResult.email}.
            </p>
          ) : (
            <div className="mt-1 flex items-center gap-2">
              <p className="m-0 text-xs text-amber-700 dark:text-amber-500">
                Invite created, but email isn't configured — share the link yourself:
              </p>
              {inviteResult.url ? (
                <Button size="sm" onClick={() => void copyInviteUrl(inviteResult.url!)}>
                  {inviteUrlCopied ? <Check size={13} /> : <Copy size={13} />}
                  {inviteUrlCopied ? 'Copied' : 'Copy invite link'}
                </Button>
              ) : null}
            </div>
          )
        ) : null}
      </section>

      {/* Members */}
      <section>
        <h3 className="island-kicker m-0 mb-2">People with access</h3>
        {membersQuery.isLoading ? (
          <Spinner />
        ) : (
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {members.map((member) => (
              <li key={member.principalId} className="flex items-center gap-2 rounded-md border border-[var(--line)] px-2 py-1.5">
                <div className="min-w-0 flex-1">
                  <p className="m-0 truncate text-sm font-medium text-[var(--ink)]">
                    {member.name}
                    {member.principalType === 'agent' ? <span className="ml-1 text-xs text-[var(--ink-faint)]">agent</span> : null}
                  </p>
                  {member.email ? <p className="m-0 truncate text-[11px] text-[var(--ink-faint)]">{member.email}</p> : null}
                </div>
                {member.role === 'owner' ? (
                  <Badge>owner</Badge>
                ) : (
                  <>
                    <Select
                      value={member.role}
                      onChange={(role) => changeRole.mutate({ member, role })}
                      options={GRANTABLE}
                    />
                    <Button size="sm" variant="ghost" onClick={() => remove.mutate(member.principalId)} title="Remove access">
                      <Trash2 size={13} />
                    </Button>
                  </>
                )}
              </li>
            ))}
            {/* Pending email invites: dimmed, revocable, become members on accept. */}
            {pendingInvites.map((pending) => (
              <li
                key={pending.token}
                className="flex items-center gap-2 rounded-md border border-dashed border-[var(--line)] px-2 py-1.5 opacity-70"
              >
                <div className="min-w-0 flex-1">
                  <p className="m-0 truncate text-sm font-medium text-[var(--ink-soft)]">{pending.email}</p>
                  <p className="m-0 truncate text-[11px] text-[var(--ink-faint)]">can {pending.role === 'viewer' ? 'view' : pending.role === 'commenter' ? 'comment' : pending.role === 'suggester' ? 'suggest' : 'edit'} once accepted</p>
                </div>
                <Badge tone="blue">invited</Badge>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => revokePending.mutate(pending.token)}
                  title="Revoke invitation"
                >
                  <Trash2 size={13} />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </Dialog>
  )
}
