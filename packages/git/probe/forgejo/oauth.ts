import { LOCAL, PASSWORD, USER } from './env'
import type { Forgejo } from './env'

const REDIRECT = 'http://127.0.0.1:9/callback'

export type Tokens = {
  access_token: string
  refresh_token: string
  expires_in: number
}

class Browser {
  jar = new Map<string, string>()
  async go(path: string, init: RequestInit = {}) {
    const r = await fetch(path.startsWith('http') ? path : `${LOCAL}${path}`, {
      ...init,
      redirect: 'manual',
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '),
      },
    })
    for (const c of r.headers.getSetCookie()) {
      const [kv] = c.split(';')
      const i = kv.indexOf('=')
      this.jar.set(kv.slice(0, i), kv.slice(i + 1))
    }
    return r
  }
  form(path: string, fields: Record<string, string>) {
    return this.go(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    })
  }
}

const csrfOf = (html: string) =>
  /name="_csrf" value="([^"]+)"/.exec(html)?.[1] ??
  /csrfToken: '([^']+)'/.exec(html)?.[1] ??
  ''

export async function oauthApp(f: Forgejo) {
  const r = await f.api<{ client_id: string; client_secret: string }>(
    'POST',
    '/user/applications/oauth2',
    {
      name: `probe-${Date.now()}`,
      redirect_uris: [REDIRECT],
      confidential_client: true,
    },
  )
  if (r.status !== 201)
    throw new Error(`oauth app: ${r.status} ${JSON.stringify(r.body)}`)
  return r.body
}

export async function authorize(app: {
  client_id: string
  client_secret: string
}) {
  const b = new Browser()
  const login = await (await b.go('/user/login')).text()
  const l = await b.form('/user/login', {
    _csrf: csrfOf(login),
    user_name: USER,
    password: PASSWORD,
  })
  if (l.status !== 303 && l.status !== 302)
    throw new Error(`login: HTTP ${l.status}`)
  const q = new URLSearchParams({
    client_id: app.client_id,
    redirect_uri: REDIRECT,
    response_type: 'code',
    state: 'probe',
  })
  let r = await b.go(`/login/oauth/authorize?${q}`)
  if (r.status === 200) {
    const page = await r.text()
    const field = (n: string) =>
      new RegExp(`name="${n}" value="([^"]*)"`).exec(page)?.[1] ?? ''
    r = await b.form('/login/oauth/grant', {
      _csrf: csrfOf(page),
      client_id: field('client_id') || app.client_id,
      state: field('state') || 'probe',
      scope: field('scope'),
      nonce: field('nonce'),
      redirect_uri: field('redirect_uri') || REDIRECT,
      granted: 'true',
    })
  }
  const location = r.headers.get('location') ?? ''
  const code = new URL(location, LOCAL).searchParams.get('code')
  if (!code)
    throw new Error(
      `no code: HTTP ${r.status} location=${location.split('?')[0]}`,
    )
  return token(app, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
  })
}

export async function refresh(
  app: { client_id: string; client_secret: string },
  refreshToken: string,
) {
  return token(app, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  })
}

async function token(
  app: { client_id: string; client_secret: string },
  fields: Record<string, string>,
) {
  const r = await fetch(`${LOCAL}/login/oauth/access_token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: new URLSearchParams({
      client_id: app.client_id,
      client_secret: app.client_secret,
      ...fields,
    }).toString(),
  })
  const body = (await r.json().catch(() => ({}))) as Tokens & {
    error?: string
    error_description?: string
  }
  if (!r.ok || !body.access_token)
    return {
      ok: false as const,
      error:
        `HTTP ${r.status} ${body.error ?? ''} ${body.error_description ?? ''}`.trim(),
    }
  return { ok: true as const, tokens: body }
}
