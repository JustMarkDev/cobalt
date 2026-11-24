import { apiError } from './problem'

/**
 * The platform's GitHub App, for proving that someone may push to a GitHub
 * repository before it is linked. Nothing here stores a GitHub token: a token
 * lives only inside a sealed `access` blob that the caller holds for minutes.
 */

export type GithubConfig = {
  clientId: string
  /** For the web sign-in, which trades a code for a token. The device flow needs none. */
  clientSecret?: string | null
  /** The secret that seals `access` blobs. */
  sealKey: string
  /** The app's public name in its install URL, `github.com/apps/<slug>`. */
  slug: string | null
}

export type GithubRepoRef = {
  id: number
  slug: string
  private: boolean
  defaultBranch: string
  installation: number
  /** What GitHub reports for the repository, in bytes. */
  sizeBytes: number
}

export type OauthStart = { url: string; installUrl: string | null }

export type OauthFinish = {
  access: string
  login: string
  expiresIn: number
  returnTo: string | null
}

export type DeviceStart = {
  deviceCode: string
  userCode: string
  verificationUri: string
  expiresIn: number
  interval: number
}

export type DevicePoll =
  | { status: 'pending' | 'slow_down'; interval: number }
  | { status: 'expired' | 'denied' }
  | { status: 'authorized'; access: string; login: string; expiresIn: number }

type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export const ACCESS_TTL_MS = 10 * 60_000

export function githubConfigFromEnv(
  env: Record<string, string | undefined>,
  sealKey: string | undefined,
): GithubConfig | null {
  if (!env.GITHUB_APP_CLIENT_ID || !sealKey) return null
  return {
    clientId: env.GITHUB_APP_CLIENT_ID,
    clientSecret: env.GITHUB_APP_CLIENT_SECRET ?? null,
    sealKey,
    slug: env.GITHUB_APP_SLUG ?? null,
  }
}

export interface Github {
  deviceStart: () => Promise<DeviceStart>
  devicePoll: (deviceCode: string, handle: string) => Promise<DevicePoll>
  /** The repositories this person may push to through the app. */
  repos: (access: string, handle: string) => Promise<Array<GithubRepoRef>>
  /**
   * Where to send the person to sign in on GitHub in the browser. `state`
   * binds the answer to them and to `redirectUri`, for ten minutes.
   */
  oauthStart: (
    handle: string,
    redirectUri: string,
    returnTo: string | null,
  ) => Promise<OauthStart>
  /** Trades the code GitHub sent back for a sealed `access`. */
  oauthFinish: (
    handle: string,
    code: string,
    state: string,
    redirectUri: string,
  ) => Promise<OauthFinish>
  /** Throws `forbidden` unless the person may push to `slug` through the app. */
  authorize: (
    access: string,
    handle: string,
    slug: string,
  ) => Promise<GithubRepoRef>
}

const b64 = {
  enc: (b: Uint8Array) => Buffer.from(b).toString('base64url'),
  dec: (s: string) => new Uint8Array(Buffer.from(s, 'base64url')),
}

async function sealKeyOf(secret: string) {
  const raw = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`cobalt:github-access:${secret}`),
  )
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ])
}

type Sealed = { t: string; h: string; l: string; x: number }

export async function sealAccess(
  secret: string,
  v: { token: string; handle: string; login: string },
  now: number,
  iv: Uint8Array = crypto.getRandomValues(new Uint8Array(12)),
) {
  const body: Sealed = {
    t: v.token,
    h: v.handle,
    l: v.login,
    x: now + ACCESS_TTL_MS,
  }
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      await sealKeyOf(secret),
      new TextEncoder().encode(JSON.stringify(body)),
    ),
  )
  return `cbgh_${b64.enc(iv)}.${b64.enc(ct)}`
}

export async function openAccess(
  secret: string,
  access: string,
  handle: string,
  now: number,
): Promise<{ token: string; login: string }> {
  const bad = () =>
    apiError('forbidden', 'The GitHub sign-in is not valid or has expired.', {
      hint: 'Sign in with GitHub again.',
    })
  const m = /^cbgh_([\w-]+)\.([\w-]+)$/.exec(access)
  if (!m) throw bad()
  let v: Sealed
  try {
    v = JSON.parse(
      new TextDecoder().decode(
        await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: b64.dec(m[1]) as BufferSource },
          await sealKeyOf(secret),
          b64.dec(m[2]),
        ),
      ),
    ) as Sealed
  } catch {
    throw bad()
  }
  if (v.h !== handle || v.x < now) throw bad()
  return { token: v.t, login: v.l }
}

type State = { h: string; r: string; t: string | null; x: number }

async function stateKeyOf(secret: string) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`cobalt:github-state:${secret}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

export async function signState(secret: string, s: State) {
  const body = b64.enc(new TextEncoder().encode(JSON.stringify(s)))
  const mac = new Uint8Array(
    await crypto.subtle.sign(
      'HMAC',
      await stateKeyOf(secret),
      new TextEncoder().encode(body),
    ),
  )
  return `${body}.${b64.enc(mac)}`
}

export async function openState(
  secret: string,
  state: string,
  handle: string,
  redirectUri: string,
  now: number,
): Promise<State> {
  const bad = () =>
    apiError(
      'forbidden',
      'This GitHub sign-in did not start here, or it expired.',
      {
        hint: 'Start linking GitHub again.',
      },
    )
  const [body, mac] = state.split('.')
  if (!body || !mac) throw bad()
  const ok = await crypto.subtle.verify(
    'HMAC',
    await stateKeyOf(secret),
    b64.dec(mac),
    new TextEncoder().encode(body),
  )
  if (!ok) throw bad()
  let s: State
  try {
    s = JSON.parse(new TextDecoder().decode(b64.dec(body))) as State
  } catch {
    throw bad()
  }
  if (s.h !== handle || s.r !== redirectUri || s.x < now) throw bad()
  return s
}

const API = 'https://api.github.com'
const gh = (token: string) => ({
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'cobaltforge',
})

export function createGithub(
  cfg: GithubConfig,
  o: {
    fetch?: Fetch
    now?: () => number
    /** A fixed source for the sealing nonce, for examples that must repeat. */
    nonce?: () => Uint8Array
  } = {},
): Github {
  const f: Fetch = o.fetch ?? ((u, i) => fetch(u, i))
  const now = o.now ?? Date.now

  async function form(url: string, body: Record<string, string>) {
    const res = await f(url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': 'cobaltforge',
      },
      body: new URLSearchParams(body).toString(),
    })
    if (!res.ok)
      throw apiError(
        'backend_unavailable',
        `GitHub answered ${res.status}.`,
        {},
      )
    return (await res.json()) as Record<string, unknown>
  }

  async function json<T>(token: string, path: string): Promise<T> {
    const res = await f(`${API}${path}`, { headers: gh(token) })
    if (res.status === 401)
      throw apiError('forbidden', 'GitHub no longer accepts this sign-in.', {
        hint: 'Sign in with GitHub again.',
      })
    if (!res.ok)
      throw apiError(
        'backend_unavailable',
        `GitHub answered ${res.status}.`,
        {},
      )
    return (await res.json()) as T
  }

  async function all(token: string): Promise<Array<GithubRepoRef>> {
    const out: Array<GithubRepoRef> = []
    const { installations } = await json<{
      installations: Array<{ id: number }>
    }>(token, '/user/installations?per_page=100')
    for (const inst of installations)
      for (let page = 1; page <= 10; page++) {
        const r = await json<{
          repositories: Array<{
            id: number
            full_name: string
            private: boolean
            default_branch: string
            size?: number
            permissions?: { admin?: boolean; push?: boolean }
          }>
        }>(
          token,
          `/user/installations/${inst.id}/repositories?per_page=100&page=${page}`,
        )
        for (const r1 of r.repositories)
          if (r1.permissions?.push || r1.permissions?.admin)
            out.push({
              id: r1.id,
              slug: r1.full_name,
              private: r1.private,
              defaultBranch: r1.default_branch,
              installation: inst.id,
              sizeBytes: (r1.size ?? 0) * 1024,
            })
        if (r.repositories.length < 100) break
      }
    return out
  }

  const seal = async (token: string, handle: string) => {
    const me = await json<{ login: string }>(token, '/user')
    return {
      access: await sealAccess(
        cfg.sealKey,
        { token, handle, login: me.login },
        now(),
        o.nonce?.(),
      ),
      login: me.login,
      expiresIn: ACCESS_TTL_MS / 1000,
    }
  }

  return {
    async deviceStart() {
      const d = await form('https://github.com/login/device/code', {
        client_id: cfg.clientId,
      })
      if (d.error)
        throw apiError('internal', 'GitHub sign-in is not available.', {
          hint: 'The GitHub App must have the device flow enabled.',
        })
      return {
        deviceCode: String(d.device_code),
        userCode: String(d.user_code),
        verificationUri: String(d.verification_uri),
        expiresIn: Number(d.expires_in),
        interval: Number(d.interval),
      }
    },
    async devicePoll(deviceCode, handle) {
      const d = await form('https://github.com/login/oauth/access_token', {
        client_id: cfg.clientId,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      })
      switch (d.error) {
        case undefined:
          return {
            status: 'authorized',
            ...(await seal(String(d.access_token), handle)),
          }
        case 'authorization_pending':
          return { status: 'pending', interval: Number(d.interval ?? 5) }
        case 'slow_down':
          return { status: 'slow_down', interval: Number(d.interval ?? 10) }
        case 'access_denied':
          return { status: 'denied' }
        case 'expired_token':
          return { status: 'expired' }
        default:
          throw apiError(
            'invalid_request',
            'That device code is not valid.',
            {},
          )
      }
    },
    async oauthStart(handle, redirectUri, returnTo) {
      const state = await signState(cfg.sealKey, {
        h: handle,
        r: redirectUri,
        t: returnTo,
        x: now() + ACCESS_TTL_MS,
      })
      const q = new URLSearchParams({
        client_id: cfg.clientId,
        redirect_uri: redirectUri,
        state,
      })
      return {
        url: `https://github.com/login/oauth/authorize?${q}`,
        // Installing asks for the repositories and, with "request user
        // authorization during installation" on, signs in in the same step.
        installUrl: cfg.slug
          ? `https://github.com/apps/${cfg.slug}/installations/new?${new URLSearchParams({ state })}`
          : null,
      }
    },
    async oauthFinish(handle, code, state, redirectUri) {
      const s = await openState(cfg.sealKey, state, handle, redirectUri, now())
      if (!cfg.clientSecret)
        throw apiError(
          'backend_unavailable',
          'Signing in with GitHub in the browser is not set up on this server.',
          { hint: 'The operator must set GITHUB_APP_CLIENT_SECRET.' },
        )
      // No redirect_uri: after an installation GitHub sends the code to the
      // app's first callback address, which may not be the one this page is on.
      const d = await form('https://github.com/login/oauth/access_token', {
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        code,
      })
      const token = typeof d.access_token === 'string' ? d.access_token : null
      if (d.error || !token)
        throw apiError(
          'forbidden',
          'GitHub did not accept that sign-in. It may have been used already.',
          { hint: 'Start linking GitHub again.' },
        )
      return {
        ...(await seal(token, handle)),
        returnTo: s.t,
      }
    },
    async repos(access, handle) {
      const { token } = await openAccess(cfg.sealKey, access, handle, now())
      return all(token)
    },
    async authorize(access, handle, slug) {
      const { token } = await openAccess(cfg.sealKey, access, handle, now())
      const found = (await all(token)).find(
        (r) => r.slug.toLowerCase() === slug.toLowerCase(),
      )
      if (!found)
        throw apiError(
          'forbidden',
          `You cannot push to ${slug} through the Cobalt GitHub App.`,
          {
            hint: 'Install the app on that repository, and make sure you can push to it.',
          },
        )
      return found
    },
  }
}

export function githubFromEnv(
  env: Record<string, string | undefined>,
  sealKey: string | undefined,
): Github | null {
  const cfg = githubConfigFromEnv(env, sealKey)
  return cfg ? createGithub(cfg) : null
}
