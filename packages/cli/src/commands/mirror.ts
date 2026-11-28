import { resolveRepo } from '../repo'
import { CbError, exit, print, table } from '../output'
import { has, str } from '../args'
import { githubAccess } from '../github'
import type { Command } from './types'

type Mirror = {
  id: string
  host: string
  slug: string
  direction: string
  state: string
  last_sync_at: string
}

export const mirror: Command = async (
  { rest: [sub = 'list', ...rest], flags },
  ctx,
) => {
  const repo = resolveRepo(str(flags, 'repo'))
  const api = ctx.api()
  const dry = has(flags, 'dry-run')
  if (sub === 'list') {
    const rows = (await api.get(`${repo.path}/mirrors`)).json
      .data as Array<Mirror>
    print(ctx, rows, () =>
      table(
        rows.map((m) => [m.id, m.host, m.slug, m.direction, m.state]),
        ['ID', 'HOST', 'REPO', 'DIRECTION', 'STATE'],
      ),
    )
    return
  }
  if (sub === 'add') {
    const [host, slug] = rest
    if (!host || !slug)
      throw new CbError(
        'missing_argument',
        'mirror add needs a host and owner/name.',
        'Example: cb mirror add github you/name',
        exit.usage,
      )
    const github = host === 'github'
    const r = await api.post(`${repo.path}/mirrors`, {
      body: {
        host,
        slug,
        direction: str(flags, 'direction') ?? (github ? 'two-way' : 'push'),
        ...(github && !dry
          ? { github_access: await githubAccess(ctx, api, flags) }
          : {}),
      },
      dryRun: dry,
    })
    const created = r.headers.get('cb-outcome') === 'created'
    print(ctx, { ...r.json, created, dryRun: dry }, () =>
      created
        ? `${dry ? 'would link' : 'linking'} ${host}:${slug}${github && !dry ? ': sending the history there in the background (cb mirror list says how it went)' : ''}`
        : `already mirrored ${host}:${slug}`,
    )
    return
  }
  const id = rest.at(0)
  if (!id)
    throw new CbError(
      'mirror_not_found',
      `mirror ${sub} needs an id.`,
      'cb mirror list shows ids.',
      exit.notFound,
    )
  if (sub === 'sync') {
    const m = (
      await api.post(`${repo.path}/mirrors/${id}/sync`, { dryRun: dry })
    ).json as Mirror
    print(
      ctx,
      { ...m, dryRun: dry },
      () => `${dry ? 'would sync' : 'synced'} ${m.host}:${m.slug}`,
    )
    return
  }
  if (sub === 'remove') {
    await api.del(`${repo.path}/mirrors/${id}`, { dryRun: dry })
    print(
      ctx,
      { removed: id, dryRun: dry },
      () =>
        `${dry ? 'would remove' : 'removed'} ${id}. History here is untouched.`,
    )
    return
  }
  throw new CbError(
    'unknown_command',
    `mirror ${sub} is not a command.`,
    'cb mirror --help lists them.',
    exit.usage,
  )
}
