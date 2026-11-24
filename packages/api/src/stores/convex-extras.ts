import { AsyncLocalStorage } from 'node:async_hooks'
import { RepoExtras } from '../extras'
import { run } from '../domain/convex'
import type { ConvexCall } from '../domain/convex'
import type { ExtrasPort, MirrorRec } from '../extras'

type Opened = { repo: string; x: RepoExtras; version: number; json: string }

export const extrasScope = new AsyncLocalStorage<Set<Opened>>()

export class ConvexExtras implements ExtrasPort {
  constructor(
    private readonly call: ConvexCall,
    private readonly now: () => number,
  ) {}

  async open(repo: string) {
    const scope = extrasScope.getStore()
    for (const o of scope ?? [])
      if (o.repo.toLowerCase() === repo.toLowerCase()) return o.x
    const got = await run<{ version: number; json: string | null }>(
      this.call,
      'query',
      'forge/extras:get',
      { full: repo },
      'system',
    )
    const x = got.json
      ? RepoExtras.from(this.now, JSON.parse(got.json))
      : new RepoExtras(this.now)
    scope?.add({ repo, x, version: got.version, json: JSON.stringify(x) })
    return x
  }

  async flush() {
    const scope = extrasScope.getStore()
    if (!scope) return
    for (const o of scope) {
      const json = JSON.stringify(o.x)
      if (json === o.json) continue
      await run(
        this.call,
        'mutation',
        'forge/extras:put',
        {
          full: o.repo,
          version: o.version,
          json,
          base: withoutAudit(o.json),
          added: JSON.stringify(addedAudit(o.json, json)),
        },
        'system',
      )
      o.json = json
      o.version++
    }
  }

  allMirrors() {
    return run<Array<{ repo: string; mirror: MirrorRec }>>(
      this.call,
      'query',
      'forge/extras:mirrors',
      {},
      'system',
    )
  }

  rename() {}

  drop() {}
}

export function withoutAudit(json: string) {
  const { audit: _audit, ...rest } = JSON.parse(json) as Record<string, unknown>
  return JSON.stringify(rest)
}

export function addedAudit(before: string, after: string): Array<unknown> {
  const a0 = (JSON.parse(before) as { audit?: Array<unknown> }).audit ?? []
  const a1 = (JSON.parse(after) as { audit?: Array<unknown> }).audit ?? []
  if (a0.length === 0) return a1
  const first = JSON.stringify(a0[0])
  const k = a1.findIndex((e) => JSON.stringify(e) === first)
  return k < 0 ? a1 : a1.slice(0, k)
}
