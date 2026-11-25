import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sh } from '../lib'
import type { Subprocess } from 'bun'

export const USER = 'probe'
export const PASSWORD = 'probe-Passw0rd!'
const PORT = 3300
export const LOCAL = `http://127.0.0.1:${PORT}`
export const ACCESS_TOKEN_TTL = 120

export type Forgejo = {
  url: string
  host: string
  dir: string
  basic: string
  api: <T = any>(
    method: string,
    path: string,
    body?: unknown,
    auth?: string,
  ) => Promise<{ status: number; body: T }>
  stop: () => void
}

let running: Forgejo | undefined

async function waitFor(check: () => Promise<boolean> | boolean, ms: number) {
  const t = Date.now()
  while (Date.now() - t < ms) {
    try {
      if (await check()) return true
    } catch {}
    await Bun.sleep(500)
  }
  return false
}

export async function forgejo(): Promise<Forgejo> {
  if (running) return running
  for (const bin of ['forgejo', 'cloudflared'])
    if (!sh(['which', bin]).ok) throw new Error(`${bin} is not installed`)
  const dir = mkdtempSync(join(tmpdir(), 'cobalt-probe-forgejo-'))
  const procs: Array<Subprocess> = []
  const stop = () => {
    for (const p of procs) p.kill()
    rmSync(dir, { recursive: true, force: true })
    running = undefined
  }
  try {
    let log = ''
    const tunnel = Bun.spawn(
      ['cloudflared', 'tunnel', '--no-autoupdate', '--url', LOCAL],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    procs.push(tunnel)
    void (async () => {
      const dec = new TextDecoder()
      for await (const chunk of tunnel.stderr) log += dec.decode(chunk)
    })()
    let url = ''
    await waitFor(() => {
      url = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(log)?.[0] ?? ''
      return Boolean(url)
    }, 60_000)
    if (!url) throw new Error('cloudflared gave no tunnel URL')
    const host = new URL(url).host
    const secret = (k: string) => sh(['forgejo', 'generate', 'secret', k]).out
    const ini = join(dir, 'app.ini')
    writeFileSync(
      ini,
      `APP_NAME = cobalt-probe
RUN_MODE = prod
WORK_PATH = ${dir}
[database]
DB_TYPE = sqlite3
PATH = ${dir}/forgejo.db
[server]
HTTP_ADDR = 127.0.0.1
HTTP_PORT = ${PORT}
ROOT_URL = ${url}/
DOMAIN = ${host}
DISABLE_SSH = true
OFFLINE_MODE = true
LFS_START_SERVER = false
[security]
INSTALL_LOCK = true
SECRET_KEY = ${secret('SECRET_KEY')}
INTERNAL_TOKEN = ${secret('INTERNAL_TOKEN')}
[oauth2]
ENABLED = true
JWT_SECRET = ${secret('JWT_SECRET')}
ACCESS_TOKEN_EXPIRATION_TIME = ${ACCESS_TOKEN_TTL}
[service]
DISABLE_REGISTRATION = true
[webhook]
ALLOWED_HOST_LIST = loopback
DELIVER_TIMEOUT = 10
[repository]
ROOT = ${dir}/repos
DEFAULT_BRANCH = main
[log]
LEVEL = Warn
`,
    )
    const base = ['--config', ini, '--work-path', dir]
    const m = sh(['forgejo', 'migrate', ...base])
    if (!m.ok) throw new Error(`forgejo migrate: ${m.out}`)
    const u = sh([
      'forgejo',
      'admin',
      'user',
      'create',
      ...base,
      '--username',
      USER,
      '--password',
      PASSWORD,
      '--email',
      'probe@example.invalid',
      '--admin',
      '--must-change-password=false',
    ])
    if (!u.ok) throw new Error(`forgejo admin user create: ${u.out}`)
    procs.push(
      Bun.spawn(['forgejo', 'web', ...base], {
        stdout: 'ignore',
        stderr: 'ignore',
      }),
    )
    const basic = `Basic ${btoa(`${USER}:${PASSWORD}`)}`
    const api: Forgejo['api'] = async (method, path, body, auth = basic) => {
      const r = await fetch(`${LOCAL}/api/v1${path}`, {
        method,
        headers: { authorization: auth, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const text = await r.text()
      let parsed: unknown = text
      try {
        parsed = JSON.parse(text)
      } catch {}
      return { status: r.status, body: parsed as never }
    }
    const up = await waitFor(
      async () => (await fetch(`${url}/api/v1/version`)).ok,
      90_000,
    )
    if (!up) throw new Error('Forgejo is not reachable through the tunnel')
    running = { url, host, dir, basic, api, stop }
    return running
  } catch (e) {
    stop()
    throw e
  }
}

export function stopForgejo() {
  running?.stop()
}

export async function pat(
  f: Forgejo,
  scopes = ['write:repository', 'write:user'],
) {
  const r = await f.api<{ sha1: string }>('POST', `/users/${USER}/tokens`, {
    name: `probe-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    scopes,
  })
  if (r.status !== 201)
    throw new Error(`token: ${r.status} ${JSON.stringify(r.body)}`)
  return r.body.sha1
}

export async function createRepo(f: Forgejo, name: string, owner?: string) {
  const r = await f.api(
    'POST',
    owner ? `/orgs/${owner}/repos` : '/user/repos',
    { name, private: true, auto_init: true, default_branch: 'main' },
  )
  if (r.status !== 201)
    throw new Error(`repo: ${r.status} ${JSON.stringify(r.body)}`)
}

export async function head(
  f: Forgejo,
  repo: string,
  branch = 'main',
  owner = USER,
) {
  const r = await f.api<{ commit: { id: string } }>(
    'GET',
    `/repos/${owner}/${repo}/branches/${branch}`,
  )
  return r.status === 200 ? r.body.commit.id : undefined
}

export async function commit(
  f: Forgejo,
  repo: string,
  path: string,
  text: string,
  owner = USER,
) {
  const existing = await f.api<{ sha: string }>(
    'GET',
    `/repos/${owner}/${repo}/contents/${path}?ref=main`,
  )
  const r = await f.api<{ commit: { sha: string } }>(
    existing.status === 200 ? 'PUT' : 'POST',
    `/repos/${owner}/${repo}/contents/${path}`,
    {
      message: `probe: ${path} on Forgejo`,
      content: Buffer.from(text).toString('base64'),
      branch: 'main',
      ...(existing.status === 200 ? { sha: existing.body.sha } : {}),
    },
  )
  if (r.status >= 300)
    throw new Error(`commit: ${r.status} ${JSON.stringify(r.body)}`)
  return r.body.commit.sha
}

export function gitForgejo(cwd: string, args: Array<string>) {
  return sh(['git', ...args], {
    cwd,
    env: {
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'cobalt-probe',
      GIT_AUTHOR_EMAIL: 'probe@cobaltforge.dev',
      GIT_COMMITTER_NAME: 'cobalt-probe',
      GIT_COMMITTER_EMAIL: 'probe@cobaltforge.dev',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraHeader',
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${btoa(`${USER}:${PASSWORD}`)}`,
    },
  })
}

export function cloneUrl(repo: string, owner = USER) {
  return `${LOCAL}/${owner}/${repo}.git`
}
