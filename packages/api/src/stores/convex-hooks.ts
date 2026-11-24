import { newId } from '../ids'
import {
  MAX_IN_FLIGHT,
  TIMEOUT_MS,
  deliveryHeaders,
  newSecret,
  realScheduler,
} from '../webhooks'
import { run } from '../domain/convex'
import type { ConvexCall } from '../domain/convex'
import type { EventLog, EventRecord } from '../events'
import type {
  Delivery,
  Hook,
  HookPort,
  Scheduler,
  SendResult,
  Transport,
} from '../webhooks'

export class ConvexHooks implements HookPort {
  private inFlight = 0
  private running: Promise<void> | null = null
  private again = false

  private goAgain() {
    return this.again
  }
  private readonly timers = new Map<string, Set<() => void>>()

  constructor(
    private readonly call: ConvexCall,
    private readonly o: {
      events: EventLog
      transport: Transport
      scheduler?: Scheduler
      now?: () => number
      allowPrivate?: boolean
    },
  ) {}

  get allowPrivate() {
    return this.o.allowPrivate ?? false
  }

  private get now() {
    return this.o.now ?? Date.now
  }

  private q<T>(name: string, args: Record<string, unknown>) {
    return run<T>(this.call, 'query', `forge/webhooks:${name}`, args, 'system')
  }

  private m<T>(name: string, args: Record<string, unknown>) {
    return run<T>(
      this.call,
      'mutation',
      `forge/webhooks:${name}`,
      args,
      'system',
    )
  }

  list(repo: string) {
    return this.q<Array<Hook>>('list', { full: repo })
  }

  get(id: string) {
    return this.q<Hook | null>('get', { id })
  }

  async create(
    repo: string,
    _repoId: string,
    input: { url: string; events: Array<string>; description?: string },
  ) {
    const secret = newSecret()
    const hook = await this.m<Hook>('create', { full: repo, ...input, secret })
    return { hook, secret }
  }

  private async refresh(hook: Hook) {
    const fresh = await this.get(hook.id)
    if (fresh) Object.assign(hook, fresh)
  }

  async update(
    hook: Hook,
    patch: {
      url?: string
      events?: Array<string>
      description?: string
      active?: boolean
    },
  ) {
    await this.m('update', { id: hook.id, ...patch })
    await this.refresh(hook)
  }

  async remove(hook: Hook) {
    await this.m('remove', { id: hook.id })
    for (const c of this.timers.get(hook.id) ?? []) c()
    this.timers.delete(hook.id)
  }

  async rotate(hook: Hook) {
    const secret = newSecret()
    await this.m('rotate', { id: hook.id, secret })
    await this.refresh(hook)
    return secret
  }

  getDelivery(id: string) {
    return this.q<Delivery | null>('getDelivery', { id })
  }

  listDeliveries(
    hook: Hook,
    q: { state?: Delivery['state']; before: number; limit: number },
  ) {
    return this.q<Array<Delivery>>('deliveries', {
      id: hook.id,
      state: q.state,
      before: Number.isFinite(q.before) ? q.before : Number.MAX_SAFE_INTEGER,
      limit: q.limit,
    })
  }

  private async enqueue(
    hook: Hook,
    event: EventRecord,
    redeliveryOf: string | null,
    send = true,
  ) {
    const d = await this.m<Delivery>('enqueueOne', {
      id: hook.id,
      event: JSON.stringify(event),
      redeliveryOf,
    })
    if (send) await this.send()
    return d
  }

  deliver(hook: Hook, event: EventRecord) {
    return this.enqueue(hook, event, null)
  }

  ping(hook: Hook) {
    const t = this.now()
    return this.enqueue(
      hook,
      {
        object: 'event',
        id: newId('event', t),
        sequence: 0,
        type: 'webhook.ping',
        created_at: new Date(t).toISOString(),
        repo: hook.repo,
        repo_id: hook.repoId,
        actor: {
          object: 'actor',
          id: 'acc_webhooks000000000',
          handle: 'webhooks',
        },
        via: null,
        subject: { object: 'webhook', id: hook.id, number: null },
        changes: [],
        data: null,
      },
      null,
    )
  }

  redeliver(hook: Hook, d: Delivery) {
    return this.enqueue(hook, d.event, d.id)
  }

  async replay(hook: Hook, after: number, limit: number) {
    const { matchesType, parseEvent } = await import('../events')
    const { events, scannedTo } = this.o.events.since(
      after,
      limit,
      (e) => e.repoId === hook.repoId && matchesType(hook.events, e.type),
    )
    for (const e of events) await this.enqueue(hook, parseEvent(e), null, false)
    await this.send()
    return { count: events.length, last: scannedTo }
  }

  rename() {}

  dropRepo() {}

  send(call: ConvexCall = this.call): Promise<void> {
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = (async () => {
      try {
        do {
          this.again = false
          for (;;) {
            const due = await run<
              Array<{
                id: string
                hookId: string
                url: string
                secrets: Array<string>
                event: string
                at: number
              }>
            >(
              call,
              'mutation',
              'forge/webhooks:claim',
              { limit: MAX_IN_FLIGHT },
              'system',
            )
            if (!due.length) break
            await Promise.all(due.map((d) => this.attempt(call, d)))
          }
        } while (this.goAgain())
      } finally {
        this.running = null
      }
    })()
    return this.running
  }

  get busy() {
    return this.running !== null
  }

  private async attempt(
    call: ConvexCall,
    d: {
      id: string
      hookId: string
      url: string
      secrets: Array<string>
      event: string
      at: number
    },
  ) {
    const event = JSON.parse(d.event) as { id: string; type: string }
    const headers = deliveryHeaders(event, d.id, d.secrets, d.event, d.at)
    this.inFlight++
    const started = performance.now()
    let result: SendResult
    try {
      result = await this.o.transport.send({
        url: d.url,
        headers,
        body: d.event,
        timeoutMs: TIMEOUT_MS,
      })
    } catch (e) {
      result = {
        status: null,
        error:
          e instanceof Error ? e.message.slice(0, 200) : 'The send failed.',
        ms: Math.round(performance.now() - started),
      }
    } finally {
      this.inFlight--
    }
    const r = await run<{ retryAt: number | null }>(
      call,
      'mutation',
      'forge/webhooks:report',
      {
        id: d.id,
        at: d.at,
        status: result.status,
        error: result.error,
        ms: result.ms,
      },
      'system',
    )
    if (r.retryAt !== null) {
      const scheduler = this.o.scheduler ?? realScheduler
      const mine = this.timers.get(d.hookId) ?? new Set()
      this.timers.set(d.hookId, mine)
      const cancel = scheduler.after(
        Math.max(0, r.retryAt - this.now()),
        () => {
          mine.delete(cancel)
          return this.send()
        },
      )
      mine.add(cancel)
    }
  }

  async idle() {
    for (let i = 0; i < 200 && (this.running || this.inFlight > 0); i++) {
      await this.running
      await new Promise((r) => setTimeout(r, 1))
    }
  }

  dispose() {
    for (const set of this.timers.values()) for (const c of set) c()
  }
}

export const DUE_CHECK_MAX_MS = 60 * 60_000
export const DUE_RECHECK_MS = 1_000
export const DUE_RECHECK_MAX_MS = 60_000

export function dueTimer(
  send: () => Promise<void>,
  o: {
    now?: () => number
    setTimer?: (fn: () => void, ms: number) => () => void
  } = {},
) {
  const now = o.now ?? Date.now
  const setTimer =
    o.setTimer ??
    ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms)
      t.unref()
      return () => clearTimeout(t)
    })
  let due: number | null = null
  let cancel: (() => void) | undefined
  let recheck = DUE_RECHECK_MS
  const arm = (ms: number) => {
    cancel?.()
    cancel = setTimer(fire, Math.min(Math.max(ms, 0), DUE_CHECK_MAX_MS))
  }
  const fire = () => {
    const was = due
    void send()
      .catch(() => {})
      .then(() => {
        if (due === was && was !== null && was <= now()) {
          arm(recheck)
          recheck = Math.min(recheck * 2, DUE_RECHECK_MAX_MS)
        } else if (due === was)
          arm(due === null ? DUE_CHECK_MAX_MS : due - now())
      })
  }
  return {
    update(at: number | null) {
      due = at
      recheck = DUE_RECHECK_MS
      arm(at === null ? DUE_CHECK_MAX_MS : at - now())
    },
    stop() {
      cancel?.()
      cancel = undefined
    },
  }
}

export const DUE_POLL_MS = 5_000

export function followDeliveries(
  subscribe: (
    onAnswer: (at: number | null) => void,
    onError: () => void,
  ) => unknown,
  send: () => Promise<void>,
  o: Parameters<typeof dueTimer>[1] & {
    every?: (fn: () => void, ms: number) => () => void
  } = {},
) {
  const every =
    o.every ??
    ((fn: () => void, ms: number) => {
      const t = setInterval(fn, ms)
      t.unref()
      return () => clearInterval(t)
    })
  const due = dueTimer(send, o)
  const poll = () => every(() => void send().catch(() => {}), DUE_POLL_MS)
  let polling: (() => void) | undefined = poll()
  subscribe(
    (at) => {
      polling?.()
      polling = undefined
      due.update(at)
    },
    () => {
      due.stop()
      polling ??= poll()
    },
  )
  return {
    get polling() {
      return polling !== undefined
    },
    stop() {
      polling?.()
      polling = undefined
      due.stop()
    },
  }
}
