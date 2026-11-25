import { ConvexError } from 'convex/values'
import { httpRouter } from 'convex/server'
import { internal } from './_generated/api'
import { env, httpAction } from './_generated/server'
import { authComponent, createAuth } from './auth'
import {
  subscriptionChange,
  verifyStandardWebhook,
} from '@cobaltforge/api/polar'
import { verifyPierre } from './lib/pierre'

const http = httpRouter()

authComponent.registerRoutes(http, createAuth)

http.route({
  path: '/hooks/code-storage',
  method: 'POST',
  handler: httpAction(async (ctx, req) => {
    const body = await req.text()
    const problem = await verifyPierre(
      body,
      req.headers.get('x-pierre-signature'),
      env.CODE_STORAGE_WEBHOOK_SECRET,
      Date.now(),
    )
    if (problem) return new Response(problem, { status: 401 })
    const kind = req.headers.get('x-pierre-event')
    if (kind !== 'push' && !kind?.startsWith('repo.sync.'))
      return new Response('ignored', { status: 202 })
    let e: unknown
    try {
      e = JSON.parse(body)
    } catch {
      return new Response('The body is not JSON.', { status: 400 })
    }
    if (kind !== 'push') {
      const s = e as {
        repository?: { repo_name?: unknown }
        started_at?: unknown
        completed_at?: unknown
        error?: unknown
      }
      const event = kind.slice('repo.sync.'.length)
      if (
        typeof s.repository?.repo_name !== 'string' ||
        (event !== 'started' && event !== 'succeeded' && event !== 'failed')
      )
        return new Response('ignored', { status: 202 })
      const stamp = Date.parse(
        String(event === 'started' ? s.started_at : s.completed_at),
      )
      const result = await ctx.runMutation(
        internal.forge.upstreams.recordSync,
        {
          storeId: s.repository.repo_name,
          event,
          at: Number.isNaN(stamp) ? Date.now() : stamp,
          ...(typeof s.error === 'string' ? { error: s.error } : {}),
        },
      )
      return new Response(result, { status: 200 })
    }
    const p = e as {
      repository?: { repo_name?: unknown; id?: unknown }
      ref?: unknown
      before?: unknown
      after?: unknown
      pushed_at?: unknown
      head_commit?: { message?: unknown }
    }
    const storeId =
      typeof p.repository?.repo_name === 'string'
        ? p.repository.repo_name
        : p.repository?.id
    if (
      typeof storeId !== 'string' ||
      typeof p.ref !== 'string' ||
      typeof p.before !== 'string' ||
      typeof p.after !== 'string'
    )
      return new Response('Not a push event.', { status: 400 })
    const at =
      typeof p.pushed_at === 'string' ? Date.parse(p.pushed_at) : Date.now()
    const result = await ctx.runMutation(internal.forge.pushes.recordPush, {
      storeId,
      ref: p.ref,
      before: p.before,
      after: p.after,
      pushedAt: Number.isNaN(at) ? Date.now() : at,
      ...(typeof p.head_commit?.message === 'string'
        ? { message: p.head_commit.message.slice(0, 65536) }
        : {}),
    })
    return new Response(result, { status: 200 })
  }),
})

http.route({
  path: '/hooks/polar',
  method: 'POST',
  handler: httpAction(async (ctx, req) => {
    const body = await req.text()
    const problem = await verifyStandardWebhook(
      body,
      {
        id: req.headers.get('webhook-id'),
        timestamp: req.headers.get('webhook-timestamp'),
        signature: req.headers.get('webhook-signature'),
      },
      env.POLAR_WEBHOOK_SECRET,
      Date.now(),
    )
    if (problem) return new Response(problem, { status: 401 })
    let e: unknown
    try {
      e = JSON.parse(body)
    } catch {
      return new Response('The body is not JSON.', { status: 400 })
    }
    const change = subscriptionChange(e)
    if (!change) return new Response('ignored', { status: 202 })
    try {
      await ctx.runMutation(internal.plans.setSubscription, {
        handle: change.handle,
        plan: change.plan,
        status: change.status,
        ...(change.seats === undefined ? {} : { seats: change.seats }),
        ...(change.periodEnd === undefined
          ? {}
          : { periodEnd: change.periodEnd }),
        provider: 'polar',
        providerRef: change.providerRef,
        at: change.at,
      })
    } catch (err) {
      if (err instanceof ConvexError)
        return new Response('unknown_account', { status: 202 })
      throw err
    }
    return new Response('ok', { status: 200 })
  }),
})

export default http
