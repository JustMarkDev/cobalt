import { activeAccount } from '../account'
import { has, str } from '../args'
import { CbError, exit, print, table } from '../output'
import { githubAccess } from '../github'
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
        ? `${rest.join(' ')} is not a repository cb can import. It takes GitHub repositories.`
        : 'import needs the repository to bring in.',
      'Example: cb import github dana/notes, or cb import https://gitlab.com/dana/notes',
      exit.usage,
    )
  if (from.host !== 'github')
    throw new CbError(
      'missing_argument',
      `Importing from ${from.host} is not supported: only GitHub repositories can be linked.`,
      'Example: cb import github dana/notes',
      exit.usage,
    )
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
      github_access: await githubAccess(ctx, api, flags),
    },
    dryRun: dry,
  })
  const created = r.headers.get('cb-outcome') === 'created'
  const full = r.json.full_name as string
  print(ctx, { ...r.json, slug: full, created, dryRun: dry }, () =>
    created
      ? `${dry ? 'would import' : 'imported'} ${from.host}:${from.slug} as ${full}. It stays in sync with GitHub both ways until you cb mirror remove it.`
      : `${full} is already imported`,
  )
}
