import { env } from '../_generated/server'

type MailSink = (m: { to: string; subject: string; text: string }) => unknown

/**
 * Send one email: through Resend when the deployment has RESEND_API_KEY and
 * MAIL_FROM, to the deployment's log otherwise. Only actions can call it.
 */
export async function sendMail(to: string, subject: string, text: string) {
  // Tests running the functions in-process catch mail here instead.
  const sink = (globalThis as { __sxMailSink?: MailSink }).__sxMailSink
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
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ from, to: [to], subject, text }),
  })
  if (!res.ok)
    throw new Error(
      `Resend refused the message: ${res.status} ${await res.text()}`,
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
