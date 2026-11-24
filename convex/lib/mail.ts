import { env } from '../_generated/server'

type MailSink = (m: { to: string; subject: string; text: string }) => unknown

/**
 * Resend did not take the message. `retryable` says whether trying again can
 * help: a busy or failing Resend (429, 5xx) or no answer at all, yes; a
 * message it refused for what it holds (4xx), no.
 */
export class MailError extends Error {
  readonly retryable: boolean
  constructor(message: string, retryable: boolean) {
    super(message)
    this.name = 'MailError'
    this.retryable = retryable
  }
}

/**
 * Send one email: through Resend when the deployment has RESEND_API_KEY and
 * MAIL_FROM, to the deployment's log otherwise. Only actions can call it.
 *
 * `idempotencyKey` makes a second call with the same key a no-op at Resend, so
 * a retry after an answer that was lost does not send the message twice.
 */
export async function sendMail(
  to: string,
  subject: string,
  text: string,
  opts: { idempotencyKey?: string } = {},
) {
  // Tests running the functions in-process catch mail here instead.
  const sink = (globalThis as { __cbMailSink?: MailSink }).__cbMailSink
  if (sink) {
    await sink({ to, subject, text })
    return
  }
  const key = env.RESEND_API_KEY
  const from = env.MAIL_FROM
  if (!key || !from) {
    // On a machine of your own the link in the log is how you sign up. On a
    // deployment people reach, the log would hold every reset link: anyone
    // who can read it could take over the account. Say only what is missing.
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
      body: JSON.stringify({ from, to: [to], subject, text }),
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

/** Whether the web app runs on this machine (or no address is set yet). */
function local(site: string | undefined) {
  if (!site) return true
  try {
    const host = new URL(site).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
  } catch {
    return false
  }
}
