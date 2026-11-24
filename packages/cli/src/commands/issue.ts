import { showTimeline } from '../timeline'
import { showPresence } from '../presence'
import { resolveRepo } from '../repo'
import { CbError, exit, print, table } from '../output'
import { has, str } from '../args'
import type { Command } from './types'

export const issue: Command = async (
  { rest: [sub = 'list', ...rest], flags },
  ctx,
) => {
  const repo = resolveRepo(str(flags, 'repo'))
  const api = ctx.api()
  if (sub === 'list') {
    const state = str(flags, 'state') ?? 'open'
    const rows = (
      await api.get(`${repo.path}/issues`, { query: { state, limit: 200 } })
    ).json.data as Array<{ number: number; state: string; title: string }>
    print(ctx, rows, () =>
      table(
        rows.map((i) => [`#${i.number}`, i.state, i.title]),
        ['ISSUE', 'STATE', 'TITLE'],
      ),
    )
    return
  }
  if (sub === 'create') {
    const title = str(flags, 'title') ?? rest.join(' ')
    if (!title)
      throw new CbError(
        'missing_argument',
        'issue create needs a title.',
        'Example: cb issue create "Crash on empty repo" --label bug',
        exit.usage,
      )
    const labels = str(flags, 'label')?.split(',')
    const dry = has(flags, 'dry-run')
    const r = await api.post(`${repo.path}/issues`, {
      body: { title, ...(labels ? { labels } : {}) },
      dryRun: dry,
    })
    const created = r.headers.get('cb-outcome') !== 'unchanged'
    print(ctx, { ...r.json, created, dryRun: dry }, () =>
      created
        ? `${dry ? 'would create' : 'created'} #${r.json.number}`
        : `#${r.json.number} already open`,
    )
    return
  }
  const n = (rest.at(0) ?? '').replace('#', '')
  if (!/^\d+$/.test(n))
    throw new CbError(
      'issue_not_found',
      `No issue ${rest.at(0) ?? ''}.`,
      'cb issue list --state all shows every issue.',
      exit.notFound,
    )
  if (sub === 'view') {
    const found = (await api.get(`${repo.path}/issues/${n}`)).json
    print(ctx, found, () => `#${found.number} ${found.state}  ${found.title}`)
    return
  }
  if (sub === 'presence') {
    await showPresence(ctx, `${repo.path}/issues/${n}/presence`, n, {
      here: has(flags, 'here'),
      path: str(flags, 'path'),
      leave: has(flags, 'leave'),
    })
    return
  }
  if (sub === 'timeline') {
    await showTimeline(ctx, `${repo.path}/issues/${n}/timeline`, String(n))
    return
  }
  if (sub === 'close') {
    const dry = has(flags, 'dry-run')
    const found = (
      await api.patch(`${repo.path}/issues/${n}`, {
        body: { state: 'closed' },
        dryRun: dry,
      })
    ).json
    print(
      ctx,
      { ...found, dryRun: dry },
      () => `${dry ? 'would close' : 'closed'} #${found.number}`,
    )
    return
  }
  throw new CbError(
    'unknown_command',
    `issue ${sub} is not a command.`,
    'cb issue --help lists them.',
    exit.usage,
  )
}
