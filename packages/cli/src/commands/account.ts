import { CbError, exit, print, table } from '../output'
import { readConfig, writeConfig } from '../config'
import {
  accountNotFound,
  accounts,
  activeAccount,
  findAccount,
  personal,
  whoami,
} from '../account'
import type { Command } from './types'

export const account: Command = async (
  { rest: [sub = 'current', ...rest], flags },
  ctx,
) => {
  if (sub === 'list') {
    const active = await activeAccount(ctx, flags)
    const rows = (await accounts(ctx)).map((a) => ({
      handle: a.handle,
      name: a.name,
      kind: a.kind,
      role: a.role,
      active: a.handle === active.handle,
    }))
    print(ctx, rows, () =>
      table(
        rows.map((r) => [
          r.active ? '*' : '',
          r.handle,
          r.kind,
          String(r.role),
          r.name,
        ]),
        ['', 'ACCOUNT', 'KIND', 'ROLE', 'NAME'],
      ),
    )
    return
  }
  if (sub === 'current') {
    const a = await activeAccount(ctx, flags)
    const login = (await whoami(ctx)).login
    const data = {
      handle: a.handle,
      name: a.name,
      kind: a.kind,
      role: a.role,
      from: a.from,
      login,
    }
    print(
      ctx,
      data,
      () =>
        `${a.handle}  ${a.kind}, ${a.role}  (from ${a.from})\nsigned in as ${login}`,
    )
    return
  }
  if (sub === 'switch') {
    const handle = rest.at(0)
    if (!handle)
      throw new CbError(
        'missing_argument',
        'account switch needs a handle.',
        'Example: cb account switch northwind. cb account list shows yours.',
        exit.usage,
      )
    const target = await findAccount(ctx, handle)
    if (!target) throw accountNotFound(handle)
    const previous = readConfig().account || (await personal(ctx)).handle
    const savedAccount = readConfig().account
    const dry = flags['dry-run'] === true
    const switched = previous !== target.handle
    if (switched && flags['dry-run'] !== true)
      writeConfig({ ...readConfig(), account: target.handle })
    const overriddenBy =
      process.env.CB_ACCOUNT && process.env.CB_ACCOUNT !== target.handle
        ? 'CB_ACCOUNT'
        : null
    const data = {
      handle: target.handle,
      name: target.name,
      kind: target.kind,
      role: target.role,
      switched,
      previous,
      overriddenBy,
      dryRun: dry,
    }
    print(ctx, data, () =>
      overriddenBy
        ? `${savedAccount === target.handle ? 'already saved' : !switched ? 'already acting' : dry ? 'would save' : 'saved'} ${target.handle}, but CB_ACCOUNT is set in this shell and wins`
        : switched
          ? `${dry ? 'would act' : 'now acting'} as ${target.handle}`
          : `already acting as ${target.handle}`,
    )
    return
  }
  throw new CbError(
    'unknown_command',
    `account ${sub} is not a command.`,
    'cb account --help lists them.',
    exit.usage,
  )
}
