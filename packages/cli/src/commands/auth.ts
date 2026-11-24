import { platform } from 'node:os'
import { CbError, exit, print } from '../output'
import { activeAccount, whoami } from '../account'
import { readConfig, resolve, writeConfig } from '../config'
import {
  clearCredentials,
  readCredentials,
  writeCredentials,
} from '../credentials'
import type { Ctx } from '../output'
import type { Parsed } from '../args'
import type { Command } from './types'

export const auth: Command = async ({ rest: [sub = 'status'], flags }, ctx) => {
  const apiConfig = resolve('api')
  const network = apiConfig.from !== 'default'
  const saved = network
    ? readCredentials(apiConfig.value.replace(/\/$/, ''))
    : null
  const token = process.env.CB_TOKEN ?? saved?.access_token
  if (sub === 'status') {
    const authenticated = !!token
    let account: string | null = null
    let login: string | null = null
    let scopes: Array<string> | null = null
    if (authenticated) {
      account = (await activeAccount(ctx, flags)).handle
      if (network) {
        const who = await whoami(ctx)
        login = who.login
        scopes = who.scopes
      }
    }
    const data = {
      host: network ? apiConfig.value : resolve('host').value,
      authenticated,
      via: process.env.CB_TOKEN ? 'CB_TOKEN' : saved ? 'credentials' : null,
      account,
      login,
      scopes,
    }
    print(ctx, data, () =>
      authenticated
        ? `signed in to ${data.host} with ${data.via}`
        : `not signed in to ${data.host}`,
    )
    return authenticated ? exit.ok : exit.auth
  }
  if (sub === 'login') return signIn(ctx, flags)
  if (sub === 'logout') {
    const api = resolve('api').value
    const c = api ? readCredentials(api.replace(/\/$/, '')) : null
    if (c) {
      await fetch(`${api.replace(/\/$/, '')}/oauth/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: c.refresh_token }),
      }).catch(() => undefined)
      clearCredentials()
    }
    print(ctx, { signedOut: !!c }, () =>
      c ? 'signed out' : 'you were not signed in',
    )
    return
  }
  throw new CbError(
    'unknown_command',
    `auth ${sub} is not a command.`,
    'cb auth --help lists them.',
    exit.usage,
  )
}

export async function signIn(
  ctx: Ctx,
  flags: Parsed['flags'],
  io: { fetch: typeof fetch; sleep: (ms: number) => Promise<void> } = {
    fetch,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  },
) {
  const given = resolve('api').value.replace(/\/$/, '')
  const api = given || `${resolve('host').value.replace(/\/$/, '')}/api/v1`
  const form = (data: Record<string, string>) => ({
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(data),
  })
  const post = async (path: string, init: RequestInit) => {
    const res = await io.fetch(`${api}${path}`, init)
    return {
      status: res.status,
      json: (await res.json().catch(() => ({}))) as Record<string, any>,
    }
  }
  const registered = await post('/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'cb command line',
      redirect_uris: ['http://127.0.0.1/callback'],
    }),
  })
  if (registered.status !== 201)
    throw new CbError(
      'login_failed',
      `Could not register this tool: ${registered.json.error_description ?? registered.status}`,
      'Try again later.',
      exit.error,
    )
  const clientId = String(registered.json.client_id)
  const scope =
    typeof flags.scope === 'string'
      ? flags.scope
      : 'repo:read repo:write issues:read issues:write issues:comment pulls:read pulls:write pulls:comment pulls:merge secrets:schema secrets:write secrets:decrypt'
  const device =
    typeof flags.device === 'string'
      ? flags.device
      : ((
          {
            darwin: 'Mac',
            win32: 'Windows PC',
            linux: 'Linux machine',
          } as Record<string, string>
        )[platform()] ?? 'Computer')
  const started = await post(
    '/oauth/device_authorization',
    form({ client_id: clientId, scope, device_name: device }),
  )
  if (started.status !== 200)
    throw new CbError(
      'login_failed',
      String(started.json.error_description ?? 'The server refused.'),
      'Check --scope.',
      exit.error,
    )
  const d = started.json
  ctx.err(
    `Open ${d.verification_uri_complete}\nand check the code is ${d.user_code}`,
  )
  let interval = Number(d.interval) * 1000
  const deadline = Date.now() + Number(d.expires_in) * 1000
  while (Date.now() < deadline) {
    await io.sleep(interval)
    const t = await post(
      '/oauth/token',
      form({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: String(d.device_code),
        client_id: clientId,
      }),
    )
    if (t.status === 200) {
      writeCredentials({
        api,
        client_id: clientId,
        access_token: String(t.json.access_token),
        refresh_token: String(t.json.refresh_token),
        expires_at: Date.now() + Number(t.json.expires_in) * 1000,
        scope: String(t.json.scope),
      })
      if (!given) writeConfig({ ...readConfig(), api })
      print(
        ctx,
        { signedIn: true, api, scope: t.json.scope },
        () => `signed in to ${api}`,
      )
      return
    }
    if (t.json.error === 'authorization_pending') continue
    if (t.json.error === 'slow_down') {
      interval += 5000
      continue
    }
    throw new CbError(
      'login_failed',
      t.json.error === 'access_denied'
        ? 'The request was denied.'
        : t.json.error === 'expired_token'
          ? 'The code expired.'
          : String(t.json.error_description ?? t.json.error),
      'Run cb auth login again.',
      exit.error,
    )
  }
  throw new CbError(
    'login_failed',
    'The code expired before it was approved.',
    'Run cb auth login again.',
    exit.error,
  )
}
