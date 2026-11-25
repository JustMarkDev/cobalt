import { str } from './args'
import { CbError, exit } from './output'
import type { ApiClient } from './client'
import type { Ctx } from './output'
import type { Parsed } from './args'

type Status = {
  status: 'pending' | 'slow_down' | 'authorized' | 'expired' | 'denied'
  interval: number | null
  access: string | null
  login: string | null
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export async function githubAccess(
  ctx: Ctx,
  api: ApiClient,
  flags: Parsed['flags'],
  wait: (ms: number) => Promise<void> = sleep,
): Promise<string> {
  const given = str(flags, 'github-access') ?? process.env.CB_GITHUB_ACCESS
  if (given) return given
  const d = (await api.post('/github/device')).json as {
    device_code: string
    user_code: string
    verification_uri: string
    expires_in: number
    interval: number
  }
  ctx.err(
    `Open ${d.verification_uri} and enter the code ${d.user_code} to sign in with GitHub.`,
  )
  let interval = d.interval * 1000
  const deadline = Date.now() + d.expires_in * 1000
  for (;;) {
    const s = (
      await api.post('/github/device/poll', {
        body: { device_code: d.device_code },
      })
    ).json as Status
    if (s.status === 'authorized' && s.access) {
      ctx.err(`Signed in to GitHub as ${s.login}.`)
      return s.access
    }
    if (s.status === 'denied' || s.status === 'expired')
      throw new CbError(
        'github_sign_in_failed',
        s.status === 'denied'
          ? 'GitHub sign-in was denied.'
          : 'The GitHub code expired.',
        'Run the command again.',
        exit.error,
      )
    if (s.status === 'slow_down') interval += 5000
    if (Date.now() + interval > deadline)
      throw new CbError(
        'github_sign_in_failed',
        'The GitHub code expired before it was approved.',
        'Run the command again.',
        exit.error,
      )
    await wait(interval)
  }
}
