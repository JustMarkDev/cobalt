import { activeAccount } from '../account'
import { has, str } from '../args'
import { CbError, exit, print, table } from '../output'
import { githubAccess } from '../github'
import { resolve } from '../config'
import type { Command } from './types'

const hosts = ['github', 'gitlab', 'codeberg', 'gitea'] as const
type Host = (typeof hosts)[number]

const domains: Record<string, Host> = {
  'github.com': 'github',
  'gitlab.com': 'gitlab',
  'codeberg.org': 'codeberg',
  'gitea.com': 'gitea',
}

type Imported = {
  repo: string
  host: string
  slug: string
  state: string
  created_at: string
  warnings: Array<string>
}

type Connection = {
  provider: string
  login: string
  state: 'ok' | 'needs_reconnect'
  repos: number
}

type Job = {
  id: string
  state: 'running' | 'done' | 'cancelled'
  total: number
  done: number
  failed: number
  items: Array<{
    slug: string
    state: string
    repo: string | null
    error: string | null
  }>
}

const names: Record<string, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  codeberg: 'Codeberg',
}

async function needConnection(
  ctx: Parameters<Command>[1],
  host: 'gitlab' | 'codeberg',
) {
  const conns = (await ctx.api().get('/providers')).json
    .data as Array<Connection>
  const c = conns.find((x) => x.provider === host)
  if (c?.state === 'ok') return c
  const site = resolve('host').value.replace(/\/$/, '')
  throw new CbError(
    'not_connected',
    c
      ? `${names[host]} refused the stored token of ${c.login}: connect it again.`
      : `Connect ${names[host]} first. It is done once, in the browser.`,
    `Open ${site}/settings/accounts and choose Connect next to ${names[host]}, then run this again.`,
    exit.needsHuman,
  )
}

export function source(
  rest: Array<string>,
): { host: Host; slug: string } | null {
  const [a, b] = rest
  if (a && b && (hosts as ReadonlyArray<string>).includes(a))
    return { host: a as Host, slug: b.replace(/\.git$/, '') }
  if (!a) return null
  const m =
    /^(?:https?:\/\/|git@)?(?:www\.)?([a-z0-9.-]+)[/:]([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(
      a,
    )
  const host = m ? domains[m[1]] : undefined
  return m && host ? { host, slug: `${m[2]}/${m[3]}` } : null
}

export const importCommand: Command = async ({ rest, flags }, ctx) => {
  const api = ctx.api()
  if (rest[0] === 'connections') {
    const rows = (await api.get('/providers')).json.data as Array<Connection>
    print(ctx, rows, () =>
      rows.length
        ? table(
            rows.map((c) => [
              names[c.provider] ?? c.provider,
              c.login,
              c.state === 'ok' ? 'connected' : 'needs reconnecting',
              String(c.repos),
            ]),
            ['PROVIDER', 'LOGIN', 'STATE', 'REPOS'],
          )
        : 'no provider connected',
    )
    return
  }
  if (rest[0] === 'batch') {
    const host = rest[1] as Host | undefined
    const slugs = rest.slice(2)
    if (
      !host ||
      !['github', 'gitlab', 'codeberg'].includes(host) ||
      !slugs.length
    )
      throw new CbError(
        'missing_argument',
        'import batch needs a provider and the repositories to bring in.',
        'Example: cb import batch gitlab dana/notes dana/zine',
        exit.usage,
      )
    if (host !== 'github')
      await needConnection(ctx, host as 'gitlab' | 'codeberg')
    const as = str(flags, 'as')
    const started = await api.post('/imports/batch', {
      body: {
        provider: host,
        slugs,
        owner: as ?? (await activeAccount(ctx, flags)).handle,
        ...(flags.private === true ? { visibility: 'private' } : {}),
        ...(host === 'github'
          ? { github_access: await githubAccess(ctx, api, flags) }
          : {}),
      },
    })
    let job = started.json as Job
    const until = Date.now() + 10 * 60_000
    while (
      !has(flags, 'no-wait') &&
      job.state === 'running' &&
      Date.now() < until
    ) {
      await new Promise((r) => setTimeout(r, 2000))
      job = (await api.get(`/imports/jobs/${job.id}`)).json as Job
    }
    print(ctx, job, () =>
      [
        `${job.done + job.failed} of ${job.total} done${job.failed ? `, ${job.failed} failed` : ''}${job.state === 'running' ? ' so far: cb import job ' + job.id : ''}`,
        table(
          job.items.map((i) => [i.slug, i.state, i.repo ?? i.error ?? '']),
          ['FROM', 'STATE', 'REPO'],
        ),
      ].join('\n'),
    )
    if (job.failed) process.exitCode = exit.error
    return
  }
  if (rest[0] === 'job' && rest[1]) {
    const job = (await api.get(`/imports/jobs/${rest[1]}`)).json as Job
    print(ctx, job, () =>
      table(
        job.items.map((i) => [i.slug, i.state, i.repo ?? i.error ?? '']),
        ['FROM', 'STATE', 'REPO'],
      ),
    )
    return
  }
  if (rest[0] === 'list') {
    const rows = (await api.get('/imports')).json.data as Array<Imported>
    print(ctx, rows, () =>
      rows.length
        ? table(
            rows.map((i) => [i.repo, `${i.host}:${i.slug}`, i.state]),
            ['REPO', 'FROM', 'STATE'],
          )
        : 'nothing imported yet',
    )
    return
  }
  const from = source(rest)
  if (!from)
    throw new CbError(
      'missing_argument',
      rest.length
        ? `${rest.join(' ')} is not a repository cb can import. It takes GitHub, GitLab and Codeberg repositories.`
        : 'import needs the repository to bring in.',
      'Example: cb import github dana/notes, or cb import https://gitlab.com/dana/notes',
      exit.usage,
    )
  if (from.host === 'gitea')
    throw new CbError(
      'missing_argument',
      'Importing from a self-hosted Gitea is not supported yet.',
      'Example: cb import github dana/notes, or cb import codeberg dana/notes',
      exit.usage,
    )
  if (from.host !== 'github') await needConnection(ctx, from.host)
  const as = str(flags, 'as')
  const [owner, name] = as?.includes('/')
    ? (as.split('/') as [string, string])
    : [(await activeAccount(ctx, flags)).handle, as]
  const dry = has(flags, 'dry-run')
  const r = await api.post('/imports', {
    body: {
      host: from.host,
      slug: from.slug,
      owner,
      ...(name ? { name } : {}),
      visibility: flags.private === true ? 'private' : 'public',
      ...(from.host === 'github'
        ? { github_access: await githubAccess(ctx, api, flags) }
        : {}),
    },
    dryRun: dry,
  })
  const created = r.headers.get('cb-outcome') === 'created'
  const full = r.json.full_name as string
  print(ctx, { ...r.json, slug: full, created, dryRun: dry }, () =>
    created
      ? `${dry ? 'would import' : 'imported'} ${from.host}:${from.slug} as ${full}. It stays in sync with ${names[from.host]} both ways until you cb mirror remove it. Anyone who can write to ${full} can push there through cobalt; ${names[from.host]}'s branch rules still apply.`
      : `${full} is already imported`,
  )
}
