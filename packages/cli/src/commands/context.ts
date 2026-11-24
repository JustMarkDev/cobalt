import { activeAccount } from '../account'
import { gitContext, resolveRepo } from '../repo'
import { print } from '../output'
import { str } from '../args'
import type { Command } from './types'

export const context: Command = async ({ flags }, ctx) => {
  const repo = resolveRepo(str(flags, 'repo'))
  const git = gitContext()
  const api = ctx.api()
  const [acting, c] = await Promise.all([
    activeAccount(ctx, flags),
    api.get(`${repo.path}/context`),
  ])
  const data = {
    account: { handle: acting.handle, kind: acting.kind, role: acting.role },
    repo: repo.slug,
    defaultBranch: c.json.repo.default_branch,
    branch: git.branch ?? null,
    openChanges: c.json.changes.map(
      (x: { number: number; title: string; blocking: Array<string> }) => ({
        number: x.number,
        title: x.title,
        blockers: x.blocking,
      }),
    ),
    openIssues: c.json.issues.map((i: { number: number; title: string }) => ({
      number: i.number,
      title: i.title,
    })),
    rules: {
      declinedModels: c.json.repo.declined_models ?? [],
      autoLand: c.json.repo.auto_land ?? false,
      vouched: c.json.repo.vouched ?? [],
      declare:
        'Set CB_MODEL to the model you are; every write keeps it on its receipt.',
    },
    envSchema: c.json.env.map((v: { name: string; kind: string }) => ({
      name: v.name,
      kind: v.kind,
    })),
    envAccess: {
      values: 'never returned here',
      run: 'cb env run --env development -- <command>',
      who: "the repository's team, through the login of the machine you run on",
      production:
        'waits until the person confirms this login on a signed-in page; cb says where',
    },
    cursor: c.json.cursor,
    note: 'Secret values are never included. Run commands through cb env run so values reach the process but never you.',
  }
  print(ctx, data, () => JSON.stringify(data, null, 2))
}
