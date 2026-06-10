/**
 * Outbound email (Resend HTTP API) + the one branded template every email
 * type renders through.
 *
 * GRACEFUL DEGRADATION is a hard contract: when RESEND_API_KEY is unset the
 * helper logs the would-be email (including any links, via the text body) and
 * returns { sent: false, reason: 'email-not-configured' } — callers must
 * treat that as success for their own action (invite created, member added)
 * and may surface "email not configured" affordances in the UI instead.
 *
 * Worker-only at send time (reads `cloudflare:workers` env lazily), but the
 * module itself stays importable from node (vitest) — tests inject env +
 * fetch via the options bag.
 */

export interface EmailEnv {
  RESEND_API_KEY?: string
  EMAIL_FROM?: string
}

export interface EmailMessage {
  to: string
  subject: string
  html: string
  text: string
}

export type SendEmailResult =
  | { sent: true; id: string | null }
  | { sent: false; reason: 'email-not-configured' | 'send-failed' }

const RESEND_ENDPOINT = 'https://api.resend.com/emails'
const DEFAULT_FROM = 'Glyphdown <invites@glyphdown.com>'

export async function sendEmail(
  msg: EmailMessage,
  opts?: { env?: EmailEnv; fetchImpl?: typeof fetch },
): Promise<SendEmailResult> {
  // Lazy env read keeps `cloudflare:workers` out of the node test graph.
  const env: EmailEnv =
    opts?.env ?? ((await import('cloudflare:workers')).env as unknown as EmailEnv)
  const apiKey = env.RESEND_API_KEY
  if (!apiKey || apiKey.trim() === '') {
    console.warn(
      `[email] RESEND_API_KEY unset — NOT sending. to=${msg.to} subject="${msg.subject}"\n${msg.text}`,
    )
    return { sent: false, reason: 'email-not-configured' }
  }

  const from = env.EMAIL_FROM && env.EMAIL_FROM.trim() !== '' ? env.EMAIL_FROM : DEFAULT_FROM
  const fetchImpl = opts?.fetchImpl ?? fetch
  try {
    const res = await fetchImpl(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ from, to: [msg.to], subject: msg.subject, html: msg.html, text: msg.text }),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      console.error(`[email] Resend rejected (${res.status}) to=${msg.to}: ${detail}`)
      return { sent: false, reason: 'send-failed' }
    }
    const data = (await res.json().catch(() => null)) as { id?: unknown } | null
    return { sent: true, id: typeof data?.id === 'string' ? data.id : null }
  } catch (err) {
    console.error(`[email] send failed to=${msg.to}:`, err)
    return { sent: false, reason: 'send-failed' }
  }
}

// ---------------------------------------------------------------------------
// Template (one renderer, reused by every email type)
// ---------------------------------------------------------------------------

const ACCENT = '#2563eb' // matches --accent in styles.css (light theme)

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export interface EmailTemplateInput {
  /** Card headline, e.g. "Ada invited you to roadmap.md". Plain text — escaped. */
  heading: string
  /** Body paragraphs, plain text — escaped. */
  paragraphs: string[]
  /** Accent button. The URL is also repeated as a plain link + in the text part. */
  cta?: { label: string; url: string }
  /** Small grey line under the card (why-am-I-getting-this). Escaped. */
  footnote?: string
}

/**
 * Branded HTML + plain-text pair: wordmark text, paper card, accent button.
 * Inline styles only (email clients strip <style>).
 */
export function renderEmailTemplate(input: EmailTemplateInput): { html: string; text: string } {
  const paragraphsHtml = input.paragraphs
    .map(
      (p) =>
        `<p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:#3f3f46;">${escapeHtml(p)}</p>`,
    )
    .join('\n')

  const ctaHtml = input.cta
    ? `<div style="margin:22px 0 6px;">
  <a href="${escapeHtml(input.cta.url)}" style="display:inline-block;background:${ACCENT};color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:10px 22px;border-radius:8px;">${escapeHtml(input.cta.label)}</a>
</div>
<p style="margin:10px 0 0;font-size:12px;line-height:1.5;color:#71717a;">Or paste this link into your browser:<br/><a href="${escapeHtml(input.cta.url)}" style="color:${ACCENT};word-break:break-all;">${escapeHtml(input.cta.url)}</a></p>`
    : ''

  const footnoteHtml = input.footnote
    ? `<p style="margin:18px 0 0;font-size:12px;line-height:1.5;color:#a1a1aa;">${escapeHtml(input.footnote)}</p>`
    : ''

  const html = `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;padding:32px 16px;">
    <div style="margin-bottom:16px;">
      <span style="display:inline-block;font-size:18px;font-weight:700;letter-spacing:-0.02em;color:#18181b;">Glyph<span style="color:${ACCENT};">down</span></span>
    </div>
    <div style="background:#ffffff;border:1px solid #e4e4e7;border-radius:12px;padding:28px;">
      <h1 style="margin:0 0 14px;font-size:18px;line-height:1.4;color:#18181b;">${escapeHtml(input.heading)}</h1>
      ${paragraphsHtml}
      ${ctaHtml}
    </div>
    ${footnoteHtml}
    <p style="margin:18px 0 0;font-size:11px;color:#a1a1aa;">Glyphdown — Google Docs for markdown · glyphdown.com</p>
  </div>
</body>
</html>`

  const textParts = [
    input.heading,
    '',
    ...input.paragraphs,
    ...(input.cta ? ['', `${input.cta.label}: ${input.cta.url}`] : []),
    ...(input.footnote ? ['', input.footnote] : []),
    '',
    '— Glyphdown',
  ]
  return { html, text: textParts.join('\n') }
}

// ---------------------------------------------------------------------------
// Email types (all render through the one template)
// ---------------------------------------------------------------------------

const ROLE_PHRASE: Record<string, string> = {
  viewer: 'view it',
  commenter: 'comment on it',
  suggester: 'suggest changes',
  editor: 'edit it',
}

/**
 * What the share target is called in copy. 'vault' is a folder-target share
 * whose folder is a vault root (the caller resolves the kind — this module
 * never reads the database).
 */
export type ShareTargetNoun = 'doc' | 'folder' | 'vault'

function targetNoun(targetType: ShareTargetNoun): string {
  return targetType === 'doc' ? 'document' : targetType
}

/** Invite to a non-user: sign up via the tokenized landing page. */
export function inviteEmail(opts: {
  inviterName: string
  targetName: string
  targetType: ShareTargetNoun
  role: string
  url: string
}): Omit<EmailMessage, 'to'> {
  return {
    subject: `${opts.inviterName} invited you to "${opts.targetName}" on Glyphdown`,
    ...renderEmailTemplate({
      heading: `${opts.inviterName} invited you to collaborate`,
      paragraphs: [
        `${opts.inviterName} shared the ${targetNoun(opts.targetType)} "${opts.targetName}" with you on Glyphdown and granted you permission to ${ROLE_PHRASE[opts.role] ?? opts.role}.`,
        'Glyphdown is Google Docs for markdown — real-time editing, comments, and suggestions. Accepting takes one click with a GitHub or Google account.',
      ],
      cta: { label: 'Accept invitation', url: opts.url },
      footnote: `You received this because ${opts.inviterName} entered your email address on Glyphdown. If you weren't expecting it, you can ignore this email.`,
    }),
  }
}

/** Existing user added directly: deep link straight to the target. */
export function addedEmail(opts: {
  inviterName: string
  targetName: string
  targetType: ShareTargetNoun
  role: string
  url: string
}): Omit<EmailMessage, 'to'> {
  return {
    subject: `${opts.inviterName} shared "${opts.targetName}" with you on Glyphdown`,
    ...renderEmailTemplate({
      heading: `You've been added to "${opts.targetName}"`,
      paragraphs: [
        `${opts.inviterName} shared this ${targetNoun(opts.targetType)} with you and granted you permission to ${ROLE_PHRASE[opts.role] ?? opts.role}.`,
      ],
      cta: { label: opts.targetType === 'doc' ? 'Open document' : 'Open Glyphdown', url: opts.url },
      footnote: 'You received this because you have a Glyphdown account and someone shared a document with you.',
    }),
  }
}

/** @mention in a comment — short, with a deep link. Respects user prefs. */
export function mentionEmail(opts: {
  byName: string
  docTitle: string
  excerpt: string
  url: string
}): Omit<EmailMessage, 'to'> {
  return {
    subject: `${opts.byName} mentioned you in "${opts.docTitle}"`,
    ...renderEmailTemplate({
      heading: `${opts.byName} mentioned you in "${opts.docTitle}"`,
      paragraphs: opts.excerpt.trim() !== '' ? [`"${opts.excerpt.trim()}"`] : [],
      cta: { label: 'Open the discussion', url: opts.url },
      footnote: 'You can turn mention emails off in Settings → Preferences on Glyphdown.',
    }),
  }
}
