import { env } from '../_generated/server'

type MailSink = (m: { to: string; subject: string; text: string }) => unknown

export class MailError extends Error {
  readonly retryable: boolean
  constructor(message: string, retryable: boolean) {
    super(message)
    this.name = 'MailError'
    this.retryable = retryable
  }
}

export async function sendMail(
  to: string,
  subject: string,
  text: string,
  opts: {
    idempotencyKey?: string
    html?: string
    /** `team` for mail people may answer; auth mail stays on the no-reply sender. */
    sender?: 'team'
  } = {},
) {
  const sink = (globalThis as { __cbMailSink?: MailSink }).__cbMailSink
  if (sink) {
    await sink({ to, subject, text })
    return
  }
  const key = env.RESEND_API_KEY
  const from =
    opts.sender === 'team'
      ? (env.MAIL_FROM_TEAM ?? env.MAIL_FROM)
      : env.MAIL_FROM
  if (!key || !from) {
    if (local(env.SITE_URL)) console.log(`[mail] to ${to}: ${subject}\n${text}`)
    else
      console.error(
        `[mail] not sent ("${subject}"): set RESEND_API_KEY and MAIL_FROM on this deployment`,
      )
    return
  }
  let res: Response
  try {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        ...(opts.idempotencyKey
          ? { 'idempotency-key': opts.idempotencyKey }
          : {}),
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject,
        text,
        ...(opts.html ? { html: opts.html } : {}),
      }),
    })
  } catch (e) {
    throw new MailError(`Resend did not answer: ${String(e)}`, true)
  }
  if (!res.ok)
    throw new MailError(
      `Resend refused the message: ${res.status} ${await res.text()}`,
      res.status === 429 || res.status >= 500,
    )
}

function local(site: string | undefined) {
  if (!site) return true
  try {
    const host = new URL(site).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
  } catch {
    return false
  }
}
