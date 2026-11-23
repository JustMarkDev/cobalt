import { activeAccount } from '../account'
import { has, str } from '../args'
import { SxError, exit, print, table } from '../output'
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

/**
 * Where a repository comes from: `github owner/name`, or its address on that
 * host (`https://github.com/owner/name`, with or without `.git`).
 */
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
    throw new SxError(
      'missing_argument',
      rest.length
        ? `${rest.join(' ')} is not a repository sx can import. It takes GitHub, GitLab, Codeberg and Gitea.`
        : 'import needs the repository to bring in.',
      'Example: sx import github dana/notes, or sx import https://gitlab.com/dana/notes',
      exit.usage,
    )
  // --as owner/name places it; a bare --as name keeps the account you act as.
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
    },
    dryRun: dry,
  })
  const created = r.headers.get('sx-outcome') === 'created'
  const full = r.json.full_name as string
  print(ctx, { ...r.json, slug: full, created, dryRun: dry }, () =>
    created
      ? `${dry ? 'would import' : 'imported'} ${from.host}:${from.slug} as ${full}. It keeps pulling from there until you sx mirror remove it.`
      : `${full} is already imported`,
  )
}
