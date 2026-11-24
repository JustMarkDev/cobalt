import { CbError, exit } from './output'
import { gitContext } from './repo'
import { resolve } from './config'
import { str } from './args'
import type { Ctx } from './output'
import type { Parsed } from './args'

export type Account = {
  handle: string
  name: string
  kind: 'person' | 'organization'
  role: 'owner' | 'admin' | 'member' | null
}

export type From = 'flag' | 'env' | 'repo' | 'config' | 'default'
export type Active = Account & { from: From }

export async function accounts(ctx: Ctx): Promise<Array<Account>> {
  const r = await ctx.api().once('/accounts')
  return r.json.data as Array<Account>
}

export async function whoami(ctx: Ctx): Promise<{
  login: string
  device: string
  scopes: Array<string>
}> {
  const r = await ctx.api().once('/auth/principal')
  return r.json
}

export async function findAccount(
  ctx: Ctx,
  handle: string,
): Promise<Account | undefined> {
  return (await accounts(ctx)).find((a) => a.handle === handle)
}

export async function personal(ctx: Ctx): Promise<Account> {
  const [{ login }, all] = await Promise.all([whoami(ctx), accounts(ctx)])
  const own = all.find((a) => a.handle === login)
  if (!own) throw new Error('The login has no account of its own.')
  return own
}

export function accountNotFound(handle: string): CbError {
  return new CbError(
    'account_not_found',
    `You cannot act as ${handle}.`,
    'cb account list shows the accounts you can act as. Ask an owner to invite you to an organization.',
    exit.notFound,
  )
}

async function named(ctx: Ctx, handle: string, from: From): Promise<Active> {
  const a = await findAccount(ctx, handle)
  if (!a) throw accountNotFound(handle)
  return { ...a, from }
}

export async function activeAccount(
  ctx: Ctx,
  flags: Parsed['flags'],
): Promise<Active> {
  const flag = str(flags, 'account')
  if (flag) return named(ctx, flag, 'flag')
  const env = process.env.CB_ACCOUNT
  if (env) return named(ctx, env, 'env')
  const slug = str(flags, 'repo') ?? process.env.CB_REPO ?? gitContext().slug
  const owner = slug?.split('/').at(0)
  if (owner && (await findAccount(ctx, owner))) return named(ctx, owner, 'repo')
  const saved = resolve('account').value
  if (saved) return named(ctx, saved, 'config')
  return { ...(await personal(ctx)), from: 'default' }
}
