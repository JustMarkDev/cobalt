import { apiError } from './problem'

/**
 * The platform's GitHub App, for proving that someone may push to a GitHub
 * repository before it is linked. Nothing here stores a GitHub token: a token
 * lives only inside a sealed `access` blob that the caller holds for minutes.
 */

export type GithubConfig = {
  clientId: string
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
    sealKey,
    slug: env.GITHUB_APP_SLUG ?? null,
  }
}

export interface Github {
  deviceStart: () => Promise<DeviceStart>
  devicePoll: (deviceCode: string, handle: string) => Promise<DevicePoll>
  /** The repositories this person may push to through the app. */
  repos: (access: string, handle: string) => Promise<Array<GithubRepoRef>>
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
  return `ghs_${b64.enc(iv)}.${b64.enc(ct)}`
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
  const m = /^ghs_([\w-]+)\.([\w-]+)$/.exec(access)
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
