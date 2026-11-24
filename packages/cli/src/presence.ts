import { randomUUID } from 'node:crypto'
import { print, table } from './output'
import type { Ctx } from './output'

type Viewer = {
  actor: { handle: string }
  path: string | null
  seen_at: string
}

const session = process.env.CB_SESSION ?? `cb-${randomUUID().slice(0, 13)}`

export async function showPresence(
  ctx: Ctx,
  path: string,
  id: string,
  say: { here: boolean; path?: string; leave: boolean },
) {
  const api = ctx.api()
  const p =
    say.here || say.path !== undefined || say.leave
      ? (
          await api.put(path, {
            body: { session, path: say.path ?? null, leave: say.leave },
          })
        ).json
      : (await api.get(path)).json
  const viewers = p.viewers as Array<Viewer>
  print(ctx, { ...p, id }, () =>
    viewers.length
      ? table(
          viewers.map((v) => [
            v.actor.handle,
            v.path ?? '-',
            v.seen_at.slice(11, 19),
          ]),
          ['WHO', 'FILE', 'LAST SEEN'],
        )
      : 'nobody is looking',
  )
}

export async function heartbeat(ctx: Ctx, path: string) {
  try {
    await ctx.api().put(path, { body: { session, path: null, leave: false } })
  } catch {}
}
