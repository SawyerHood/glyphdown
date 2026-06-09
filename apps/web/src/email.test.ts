import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  addedEmail,
  escapeHtml,
  inviteEmail,
  mentionEmail,
  renderEmailTemplate,
  sendEmail,
} from './email.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('sendEmail degradation (no RESEND_API_KEY)', () => {
  it('returns sent:false email-not-configured and never fetches', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchImpl = vi.fn()
    const result = await sendEmail(
      { to: 'a@b.co', subject: 'Hi', html: '<p>x</p>', text: 'open https://x.test/invite/tok123' },
      { env: {}, fetchImpl: fetchImpl as unknown as typeof fetch },
    )
    expect(result).toEqual({ sent: false, reason: 'email-not-configured' })
    expect(fetchImpl).not.toHaveBeenCalled()
    // The would-be email (including the invite URL via the text body) is logged.
    expect(warn).toHaveBeenCalledTimes(1)
    const logged = warn.mock.calls[0]!.join(' ')
    expect(logged).toContain('a@b.co')
    expect(logged).toContain('https://x.test/invite/tok123')
  })

  it('treats a blank key as unconfigured', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await sendEmail(
      { to: 'a@b.co', subject: 's', html: 'h', text: 't' },
      { env: { RESEND_API_KEY: '  ' } },
    )
    expect(result).toEqual({ sent: false, reason: 'email-not-configured' })
  })
})

describe('sendEmail via Resend', () => {
  const env = { RESEND_API_KEY: 'rk_test', EMAIL_FROM: 'Glyphdown <invites@glyphdown.com>' }

  it('POSTs the right payload to api.resend.com with the bearer key', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: 'email_1' }), { status: 200 }))
    const result = await sendEmail(
      { to: 'dest@example.com', subject: 'Subj', html: '<p>h</p>', text: 'body' },
      { env, fetchImpl: fetchImpl as unknown as typeof fetch },
    )
    expect(result).toEqual({ sent: true, id: 'email_1' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.resend.com/emails')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer rk_test')
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body).toEqual({
      from: 'Glyphdown <invites@glyphdown.com>',
      to: ['dest@example.com'],
      subject: 'Subj',
      html: '<p>h</p>',
      text: 'body',
    })
  })

  it('falls back to the default from address when EMAIL_FROM is unset', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }))
    await sendEmail(
      { to: 'x@y.z', subject: 's', html: 'h', text: 't' },
      { env: { RESEND_API_KEY: 'rk' }, fetchImpl: fetchImpl as unknown as typeof fetch },
    )
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect((JSON.parse(init.body as string) as { from: string }).from).toBe('Glyphdown <invites@glyphdown.com>')
  })

  it('maps a non-2xx response to sent:false send-failed (never throws)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 422 }))
    const result = await sendEmail(
      { to: 'x@y.z', subject: 's', html: 'h', text: 't' },
      { env, fetchImpl: fetchImpl as unknown as typeof fetch },
    )
    expect(result).toEqual({ sent: false, reason: 'send-failed' })
  })

  it('maps a network error to sent:false send-failed (never throws)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET')
    })
    const result = await sendEmail(
      { to: 'x@y.z', subject: 's', html: 'h', text: 't' },
      { env, fetchImpl: fetchImpl as unknown as typeof fetch },
    )
    expect(result).toEqual({ sent: false, reason: 'send-failed' })
  })
})

describe('renderEmailTemplate', () => {
  it('renders the wordmark, heading, paragraphs, CTA, and footnote (snapshot-ish)', () => {
    const { html, text } = renderEmailTemplate({
      heading: 'Ada invited you to collaborate',
      paragraphs: ['Line one.', 'Line two.'],
      cta: { label: 'Accept invitation', url: 'https://glyphdown.com/invite/abc123' },
      footnote: 'You can ignore this email.',
    })
    // Wordmark + card structure (inline styles only).
    expect(html).toContain('Glyph<span style="color:#2563eb;">down</span>')
    expect(html).toContain('Ada invited you to collaborate')
    expect(html).toContain('Line one.')
    expect(html).toContain('Line two.')
    expect(html).toContain('href="https://glyphdown.com/invite/abc123"')
    expect(html).toContain('Accept invitation')
    expect(html).toContain('You can ignore this email.')
    expect(html).not.toContain('<style')

    // Plain-text fallback carries the same content incl. the raw URL.
    expect(text).toContain('Ada invited you to collaborate')
    expect(text).toContain('Accept invitation: https://glyphdown.com/invite/abc123')
    expect(text).toContain('You can ignore this email.')
  })

  it('escapes HTML in user-controlled fields', () => {
    const { html } = renderEmailTemplate({
      heading: '<script>alert(1)</script> & "co"',
      paragraphs: ["O'Brien <b>shared</b>"],
    })
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;co&quot;')
    expect(html).toContain('O&#39;Brien &lt;b&gt;shared&lt;/b&gt;')
  })

  it('escapeHtml covers the five specials', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;')
  })
})

describe('email types (all reuse the one template)', () => {
  it('inviteEmail carries inviter, target, role phrase, and the landing URL', () => {
    const msg = inviteEmail({
      inviterName: 'Ada',
      targetName: 'roadmap',
      targetType: 'doc',
      role: 'editor',
      url: 'https://glyphdown.com/invite/tok',
    })
    expect(msg.subject).toBe('Ada invited you to "roadmap" on Glyphdown')
    expect(msg.html).toContain('https://glyphdown.com/invite/tok')
    expect(msg.html).toContain('edit it')
    expect(msg.text).toContain('https://glyphdown.com/invite/tok')
  })

  it('addedEmail deep-links straight to the doc', () => {
    const msg = addedEmail({
      inviterName: 'Ada',
      targetName: 'roadmap',
      targetType: 'doc',
      role: 'viewer',
      url: 'https://glyphdown.com/d/doc-1',
    })
    expect(msg.subject).toContain('shared "roadmap" with you')
    expect(msg.html).toContain('https://glyphdown.com/d/doc-1')
    expect(msg.html).toContain('Open document')
  })

  it('mentionEmail is short with a deep link and the excerpt', () => {
    const msg = mentionEmail({
      byName: 'Grace',
      docTitle: 'specs',
      excerpt: 'what do you think @[u1]?',
      url: 'https://glyphdown.com/d/doc-9',
    })
    expect(msg.subject).toBe('Grace mentioned you in "specs"')
    expect(msg.html).toContain('https://glyphdown.com/d/doc-9')
    expect(msg.text).toContain('what do you think')
  })
})
