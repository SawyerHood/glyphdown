import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, Link2, Trash2 } from 'lucide-react'
import type { Role } from '@glyphdown/protocol'
import {
  assetShareUrl,
  createAssetShareLink,
  listAssetShareLinks,
  revokeAssetShareLink,
} from '../lib/api.ts'
import { track } from '../lib/analytics.ts'
import { Badge, Button, Dialog, Select, Spinner } from './ui.tsx'

const GRANTABLE: ReadonlyArray<{ value: Role; label: string }> = [
  { value: 'viewer', label: 'can view' },
  { value: 'commenter', label: 'can comment' },
]

/**
 * Owner-only sharing UI for a single HTML FILE (asset) — the doc/vault share
 * flow scoped one level down. A link here exposes ONLY this file: the recipient
 * opening the copied URL sees just this HTML (view/comment per the link role),
 * never the rest of the folder. Anonymous visitors are capped at view; comment
 * access requires sign-in (attribution, SPEC §4) — so only view/comment are
 * offered (suggest/edit don't apply to a static HTML asset).
 */
export default function AssetShareDialog({
  folderId,
  filename,
  open,
  onClose,
}: {
  folderId: string
  filename: string
  open: boolean
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [linkRole, setLinkRole] = useState<Role>('viewer')
  const [copiedToken, setCopiedToken] = useState<string | null>(null)

  const linksQuery = useQuery({
    queryKey: ['asset-share-links', folderId, filename],
    queryFn: () => listAssetShareLinks(folderId, filename),
    enabled: open,
    retry: false,
  })

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: ['asset-share-links', folderId, filename] })

  const copyLink = async (token: string) => {
    try {
      await navigator.clipboard.writeText(assetShareUrl(folderId, filename, token))
      setCopiedToken(token)
      setTimeout(() => setCopiedToken(null), 2000)
    } catch {
      // clipboard unavailable — the URL is still visible in the row
    }
  }

  const createLink = useMutation({
    mutationFn: () => createAssetShareLink(folderId, filename, linkRole),
    onSuccess: (link) => {
      track('asset_shared', { folderId, role: link.role, via: 'share-link' })
      invalidate()
      void copyLink(link.token)
    },
  })
  const revokeLink = useMutation({
    mutationFn: (token: string) => revokeAssetShareLink(folderId, filename, token),
    onSuccess: invalidate,
  })

  const links = linksQuery.data ?? []

  return (
    <Dialog open={open} onClose={onClose} title={`Share “${filename}”`} wide>
      <p className="m-0 mb-5 text-xs text-[var(--ink-soft)]">
        People you share with see <strong>only this file</strong> — not the rest of the folder.
      </p>

      <section>
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
        ) : links.length === 0 ? (
          <p className="m-0 text-xs text-[var(--ink-faint)]">No active links.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {links.map((link) => (
              <li key={link.token} className="flex items-center gap-2 rounded-md border border-[var(--line)] px-2 py-1.5">
                <Badge tone="blue">{link.role}</Badge>
                <code className="min-w-0 flex-1 truncate text-[11px] text-[var(--ink-soft)]">
                  {assetShareUrl(folderId, filename, link.token)}
                </code>
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
          Visitors who aren&rsquo;t signed in can only view. Commenting needs an account.
        </p>
      </section>
    </Dialog>
  )
}
