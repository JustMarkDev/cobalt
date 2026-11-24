import { accounts, activeAccount } from '../account'
import { gitContext, resolveRepo } from '../repo'
import { CbError, exit, print, table } from '../output'
import { has, str } from '../args'
import { resolve } from '../config'
import type { Command } from './types'

type ApiRepo = {
  full_name: string
  visibility: string
  stars: number
  description: string
}
const withSlug = <T extends { full_name: string }>(r: T) => ({
  ...r,
  slug: r.full_name,
})

export const repo: Command = async (
  { rest: [sub = 'view', ...rest], flags },
  ctx,
) => {
  const api = () => ctx.api()
  if (sub === 'list') {
    const owners = has(flags, 'all')
      ? (await accounts(ctx)).map((a) => a.handle)
      : [(await activeAccount(ctx, flags)).handle]
    const lists = await Promise.all(
      owners.map((owner) =>
        api().get('/repos', { query: { owner, limit: 200 } }),
      ),
    )
    const shown = lists
      .flatMap((l) => l.json.data as Array<ApiRepo & { full_name: string }>)
      .map(withSlug)
    print(ctx, shown, () =>
      table(
        shown.map((r) => [r.slug, r.visibility, String(r.stars)]),
        ['REPO', 'VISIBILITY', 'STARS'],
      ),
    )
    return
  }
  if (sub === 'create') {
    const given = rest.at(0)
    if (!given)
      throw new CbError(
        'missing_argument',
        'repo create needs a name.',
        'Example: cb repo create notes (as the account you are acting as), or cb repo create dana/notes',
        exit.usage,
      )
    const [owner, name] = given.includes('/')
      ? (given.split('/') as [string, string])
      : [(await activeAccount(ctx, flags)).handle, given]
    const dry = has(flags, 'dry-run')
    const r = await api().post('/repos', {
      body: {
        name,
        owner,
        visibility: flags.private === true ? 'private' : 'public',
        ...(str(flags, 'description')
          ? { description: str(flags, 'description') }
          : {}),
      },
      dryRun: dry,
    })
    const created = r.headers.get('cb-outcome') === 'created'
    print(ctx, { ...withSlug(r.json), created, dryRun: dry }, () =>
      created
        ? `${dry ? 'would create' : 'created'} ${r.json.full_name}`
        : `${r.json.full_name} already exists`,
    )
    return
  }
  if (sub === 'clone') {
    const slug = rest.at(0)
    if (!slug)
      throw new CbError(
        'missing_argument',
        'repo clone needs owner/name.',
        'Example: cb repo clone dana/gitfs',
        exit.usage,
      )
    const url = `${resolve('host').value.replace(/\/$/, '')}/${slug}.git`
    print(ctx, { slug, url }, () => `git clone ${url}`)
    return
  }
  if (sub === 'view') {
    const r = resolveRepo(str(flags, 'repo'))
    const got = (await api().get(r.path)).json as ApiRepo & {
      full_name: string
    }
    print(
      ctx,
      { ...withSlug(got), branch: gitContext().branch ?? null },
      () =>
        `${got.full_name}  ${got.visibility}  ${got.stars} stars\n${got.description}`,
    )
    return
  }
  throw new CbError(
    'unknown_command',
    `repo ${sub} is not a command.`,
    'cb repo --help lists them.',
    exit.usage,
  )
}
