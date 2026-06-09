import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { Check, MonitorSmartphone, X } from 'lucide-react'
import { authClient } from '../lib/auth-client.ts'
import { Button, Input } from '../components/ui.tsx'

/**
 * Device-authorization verification page (RFC 8628 §3.3) for `glyphdown login`.
 *
 * The CLI prints a user code and this URL; a signed-in user enters the code
 * (pre-filled via ?user_code=…), which claims it for their account (the GET
 * /device call), then explicitly approves or denies. The root route guard
 * already redirects signed-out visitors to /login.
 */

interface DeviceSearch {
  user_code?: string
}

export const Route = createFileRoute('/device')({
  validateSearch: (search: Record<string, unknown>): DeviceSearch => {
    const code = search['user_code']
    return typeof code === 'string' && code.length > 0 ? { user_code: code } : {}
  },
  component: DevicePage,
})

type Phase = 'enter' | 'confirm' | 'approved' | 'denied'

/** Server stores codes dash-less and uppercase; accept sloppy paste input. */
function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]/g, '')
}

function DevicePage() {
  const { user_code } = Route.useSearch()
  const [code, setCode] = useState(user_code ?? '')
  const [phase, setPhase] = useState<Phase>('enter')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const check = async () => {
    const cleaned = normalizeCode(code)
    if (!cleaned) {
      setError('Enter the code shown in your terminal.')
      return
    }
    setBusy(true)
    setError(null)
    // GET /device also claims the pending code for the signed-in user —
    // required before /device/approve will accept it.
    const { data, error: err } = await authClient.device({ query: { user_code: cleaned } })
    setBusy(false)
    if (err) {
      setError(err.error_description ?? 'That code is not valid.')
      return
    }
    if (data.status === 'approved') setPhase('approved')
    else if (data.status === 'denied') setPhase('denied')
    else setPhase('confirm')
  }

  const decide = async (approve: boolean) => {
    const cleaned = normalizeCode(code)
    setBusy(true)
    setError(null)
    const { error: err } = approve
      ? await authClient.device.approve({ userCode: cleaned })
      : await authClient.device.deny({ userCode: cleaned })
    setBusy(false)
    if (err) {
      setError(err.error_description ?? 'Something went wrong — try again.')
      return
    }
    setPhase(approve ? 'approved' : 'denied')
  }

  return (
    <main className="flex justify-center px-4 py-16">
      <section className="island-shell rise-in w-full max-w-md px-8 py-10 text-center">
        <span className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--accent)] text-white">
          <MonitorSmartphone size={20} />
        </span>
        <h1 className="display-title m-0 mb-2 text-2xl font-bold tracking-tight text-[var(--ink)]">
          Device sign-in
        </h1>

        {phase === 'enter' && (
          <>
            <p className="m-0 mb-6 text-sm text-[var(--ink-soft)]">
              Enter the code shown by <code>glyphdown login</code> to connect that terminal to your account.
            </p>
            <div className="mx-auto mb-3 max-w-[16rem]">
              <Input
                value={code}
                onChange={setCode}
                placeholder="XXXXXXXX"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void check()
                }}
                className="text-center font-mono text-base tracking-[0.3em] uppercase"
              />
            </div>
            <Button variant="primary" onClick={() => void check()} disabled={busy} className="mx-auto">
              Continue
            </Button>
          </>
        )}

        {phase === 'confirm' && (
          <>
            <p className="m-0 mb-2 text-sm text-[var(--ink-soft)]">A device is asking to sign in as you.</p>
            <p className="m-0 mb-6 font-mono text-lg font-semibold tracking-[0.3em] text-[var(--ink)]">
              {normalizeCode(code)}
            </p>
            <p className="m-0 mb-6 text-xs text-[var(--ink-soft)]">
              Only approve if this code matches the one in your terminal. The device gets full access to
              your Glyphdown account.
            </p>
            <div className="flex justify-center gap-3">
              <Button variant="primary" onClick={() => void decide(true)} disabled={busy}>
                <Check size={14} /> Approve
              </Button>
              <Button onClick={() => void decide(false)} disabled={busy}>
                <X size={14} /> Deny
              </Button>
            </div>
          </>
        )}

        {phase === 'approved' && (
          <>
            <p className="m-0 mb-2 text-sm font-semibold text-green-600">Device approved</p>
            <p className="m-0 text-sm text-[var(--ink-soft)]">
              You're signed in on that device — return to your terminal. You can close this tab.
            </p>
          </>
        )}

        {phase === 'denied' && (
          <>
            <p className="m-0 mb-2 text-sm font-semibold text-red-600">Request denied</p>
            <p className="m-0 text-sm text-[var(--ink-soft)]">
              The device was not signed in. If this wasn't you, no action is needed.
            </p>
          </>
        )}

        {error && <p className="m-0 mt-4 text-sm text-red-600">{error}</p>}
      </section>
    </main>
  )
}
