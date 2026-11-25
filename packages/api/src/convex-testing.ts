import { setSystemTime } from 'bun:test'
import { convexTest } from 'convex-test'
import { makeFunctionReference } from 'convex/server'
import schema from '../../../convex/schema'
import { load } from '../../../convex/seed'
import { ConvexProviderStore } from './forge/convex-store'
import { ConvexDomain, claimsOf } from './domain/convex'
import { exportWorld } from './seed-export'
import { ConvexOAuthState, ConvexTokens } from './stores/convex-tokens'
import { ConvexEventFeed } from './stores/convex-events'
import { SearchIndex } from './search'
import { ConvexExtras } from './stores/convex-extras'
import { ConvexUploads } from './stores/convex-uploads'
import { ConvexHooks } from './stores/convex-hooks'
import { MemoryBlobStore, UploadSigner } from './uploads'
import type { ConvexCall } from './domain/convex'
import type { DomainFactory } from './index'

const dir = new URL('../../../convex/', import.meta.url).pathname
const modules: Record<string, () => Promise<never>> = {}
for (const f of new Bun.Glob('**/*.{ts,js}').scanSync(dir))
  if (!f.endsWith('.d.ts') && !f.includes('.test.'))
    modules[`./${f}`] = () => import(`${dir}${f}`) as Promise<never>

function component(entry: string) {
  const root = `${entry.slice(0, entry.lastIndexOf('/dist/'))}/dist/component/`
  const mods: Record<string, () => Promise<never>> = {}
  for (const f of new Bun.Glob('**/*.js').scanSync(root))
    mods[`./component/${f}`] = () => import(`${root}${f}`) as Promise<never>
  const own = require(`${root}schema.js`) as { default: never }
  return { schema: own.default, modules: mods }
}
const presence = component(require.resolve('@convex-dev/presence'))
const batchWorker = component(
  require.resolve('@convex-dev/batch-worker', {
    paths: [require.resolve('@convex-dev/presence')],
  }),
)

type Fn = (ref: unknown, args: unknown) => Promise<unknown>

let lock: Promise<unknown> = Promise.resolve()
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = lock.then(fn)
  lock = next.catch(() => {})
  return next
}

export const convexFactory: DomainFactory = ({
  memory,
  auth: sample,
  urls,
  now,
  events,
  hooks: hookOptions,
}) => {
  process.env.SITE_URL = urls.html
  process.env.API_URL = urls.api
  process.env.API_JWT_ISSUER = 'https://convex.test'
  const t = convexTest(schema, modules)
  t.registerComponent('presence', presence.schema, presence.modules)
  t.registerComponent(
    'presence/batchWorker',
    batchWorker.schema,
    batchWorker.modules,
  )
  const ready = exclusive(async () => {
    await memory.svc.secrets
    const world = exportWorld(memory, sample)
    setSystemTime(new Date(now()))
    try {
      await t.run(async (ctx) => {
        await load(ctx, world)
      })
    } finally {
      setSystemTime()
    }
  })
  const g = globalThis as { __cbMailSink?: unknown }
  g.__cbMailSink = (m: { to: string; subject: string; text: string }) =>
    memory.svc.mail.send(m)
  let following = false
  const callNow: ConvexCall = async (kind, name, args, who) => {
    setSystemTime(new Date(now()))
    try {
      const as = who === null ? t : t.withIdentity(claimsOf(who))
      const fn = (as as unknown as Record<string, Fn>)[kind]
      const ref = makeFunctionReference(name as never)
      const result = await fn(ref, args)
      if (kind !== 'query') {
        await settle()
        if (!following) {
          following = true
          try {
            await feed.pull()
            if (!svc.hooks.busy) await svc.hooks.send(callNow)
          } finally {
            following = false
          }
        }
      }
      return result
    } finally {
      setSystemTime()
    }
  }
  const locked: ConvexCall = (kind, name, args, who) =>
    exclusive(() => callNow(kind, name, args, who))
  const settle = async () => {
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 0))
      await t.finishInProgressScheduledFunctions()
      const at = Date.now()
      const pending = await t.run(async (ctx) =>
        (await ctx.db.system.query('_scheduled_functions').collect()).some(
          (j) =>
            j.state.kind === 'inProgress' ||
            (j.state.kind === 'pending' && j.scheduledTime <= at),
        ),
      )
      if (!pending) return
    }
  }
  const call: ConvexCall = async (kind, name, args, who) => {
    await indexed
    return await locked(kind, name, args, who)
  }
  ;(memory.svc.hooks as { dispose?: () => void }).dispose?.()
  const auth = new ConvexTokens(call)
  const svc = {
    ...memory.svc,
    auth,
    extras: new ConvexExtras(call, now),
    uploads: new ConvexUploads(
      call,
      new MemoryBlobStore(),
      new UploadSigner(),
      now,
    ),
    hooks: new ConvexHooks(call, {
      events,
      now,
      transport: hookOptions.transport,
      scheduler: hookOptions.scheduler,
      allowPrivate: hookOptions.allowPrivate,
    }),
    providers:
      memory.svc.providers?.with({ store: new ConvexProviderStore(call) }) ??
      null,
  }
  // Stores of linked repositories come from the same fake as the provider
  // links, so an import provisions where the link then writes credentials.
  const stores = svc.providers?.deps.git
  if (stores) {
    svc.git.provision = (id, o) => stores.provision(id, o)
  }
  const d = new ConvexDomain(urls, call, events, svc, now)
  svc.providers?.attach(d.providerHost())
  svc.search = new SearchIndex(() => d.searchDocs(), events)
  const indexed = ready.then(async () => {
    await d.refreshSearch(locked)
    svc.search.ensure()
  })
  const feed = new ConvexEventFeed(callNow, events, (rev) => {
    d.accessRevision = rev
  })
  const asPerson = async (
    kind: 'query' | 'mutation',
    ref: unknown,
    args: unknown,
    handle: string | null,
  ) => {
    await indexed
    return await exclusive(async () => {
      setSystemTime(new Date(now()))
      try {
        let as: typeof t = t
        if (handle) {
          const authId = `auth_${handle}`
          await t.run(async (ctx) => {
            const a = await ctx.db
              .query('accounts')
              .withIndex('by_handle', (q) => q.eq('handle', handle))
              .unique()
            if (a && !a.authId)
              await ctx.db.patch('accounts', a._id, { authId })
          })
          as = t.withIdentity({ subject: authId }) as typeof t
        }
        const fn = (as as unknown as Record<string, Fn>)[kind]
        const result = await fn(ref, args)
        if (kind === 'mutation') {
          await settle()
          await feed.pull()
        }
        return result
      } finally {
        setSystemTime()
      }
    })
  }
  return Object.assign(d, {
    oauthState: new ConvexOAuthState(call),
    asPerson,
  })
}
