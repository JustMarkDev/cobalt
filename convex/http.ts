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

// Sign-in's own endpoints (`/api/auth/*`). The web app forwards to them.
authComponent.registerRoutes(http, createAuth)

// code.storage tells us about pushes. Checked, then recorded once.
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
    if (req.headers.get('x-pierre-event') !== 'push')
      return new Response('ignored', { status: 202 })
    let e: unknown
    try {
      e = JSON.parse(body)
    } catch {
      return new Response('The body is not JSON.', { status: 400 })
    }
    const p = e as {
      repository?: { id?: unknown }
      ref?: unknown
      before?: unknown
      after?: unknown
      pushed_at?: unknown
      head_commit?: { message?: unknown }
    }
    if (
      typeof p.repository?.id !== 'string' ||
      typeof p.ref !== 'string' ||
      typeof p.before !== 'string' ||
      typeof p.after !== 'string'
    )
      return new Response('Not a push event.', { status: 400 })
    const at =
      typeof p.pushed_at === 'string' ? Date.parse(p.pushed_at) : Date.now()
    const result = await ctx.runMutation(internal.forge.pushes.recordPush, {
      storeId: p.repository.id,
      ref: p.ref,
      before: p.before,
      after: p.after,
      pushedAt: Number.isNaN(at) ? Date.now() : at,
      // The head commit's message, when the store sends it: its trailers
      // declare the model (`Assisted-by:`, a vendor `Co-Authored-By:`). Without
      // it nothing is declared, so a declined model cannot be turned away.
      ...(typeof p.head_commit?.message === 'string'
        ? { message: p.head_commit.message.slice(0, 65536) }
        : {}),
    })
    return new Response(result, { status: 200 })
  }),
})

// Polar tells us a subscription began, changed or ended. Checked, then written
// as the account's plan. Events that name no account or plan are acknowledged
// and ignored, so Polar does not retry them for ever.
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
      // No such account (a typo in the checkout's metadata): a retry cannot fix
      // it. Anything else is ours to fix, and Polar should retry.
      if (err instanceof ConvexError)
        return new Response('unknown_account', { status: 202 })
      throw err
    }
    return new Response('ok', { status: 200 })
  }),
})

export default http
