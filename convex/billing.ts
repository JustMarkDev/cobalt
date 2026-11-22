import { v } from 'convex/values'
import { perSeat, polarProducts } from '@source-code/api/polar'
import { internal } from './_generated/api'
import { action, env, internalQuery } from './_generated/server'
import { signedIn } from './lib/actor'
import { fail } from './lib/errors'
import { accountByHandle, roleIn } from './lib/access'
import type { ActionCtx } from './_generated/server'

/**
 * Paying for a plan, with Polar. The browser asks here for an address on
 * Polar's site, and Polar calls back (`http.ts`, `/hooks/polar`) when the
 * subscription changes. Nothing about a card passes through this deployment.
 *
 * The access token (`POLAR_ACCESS_TOKEN`) lives only in this deployment's
 * environment: it is read here, on the server, and never sent to a page.
 */

const POLAR = 'https://api.polar.sh/v1'

const paid = v.union(
  v.literal('solo'),
  v.literal('team'),
  v.literal('business'),
)

/**
 * Who is paying: the signed-in person for their own account, or an owner for
 * an organization. Read from the sign-in, never from an argument.
 */
export const payerOf = internalQuery({
  args: { account: v.optional(v.string()) },
  returns: v.object({
    id: v.string(),
    handle: v.string(),
    members: v.number(),
    subscribed: v.boolean(),
    // The signed-in person's own, so the checkout does not ask for it again.
    email: v.union(v.string(), v.null()),
    name: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, { account: handle }) => {
    const p = await signedIn(ctx)
    if (!p.session)
      fail(
        'forbidden',
        'A plan is changed from the signed-in site, not with a token.',
      )
    const account = await accountByHandle(ctx, handle ?? p.handle)
    if (!account) fail('not_found', `No account ${handle ?? p.handle}.`)
    if (account.kind === 'person') {
      if (account.handle !== p.handle)
        fail('forbidden', 'Only its owner can change this plan.')
    } else if ((await roleIn(ctx, account, p.handle)) !== 'owner') {
      fail('forbidden', 'Only an owner can change the plan of an organization.')
    }
    if (account.purgeAt !== undefined)
      fail('conflict', 'This account is waiting to be deleted.')
    const sub = await ctx.db
      .query('subscriptions')
      .withIndex('by_accountId', (q) => q.eq('accountId', account._id))
      .unique()
    const members =
      account.kind === 'organization'
        ? (
            await ctx.db
              .query('memberships')
              .withIndex('by_organizationId_and_personId', (q) =>
                q.eq('organizationId', account._id),
              )
              .take(1000)
          ).length
        : 1
    const who = await ctx.auth.getUserIdentity()
    return {
      id: account._id,
      handle: account.handle,
      members,
      subscribed: sub?.status === 'active',
      email: who?.email ?? null,
      name: who?.name ?? null,
    }
  },
})

function token(): string {
  const t = env.POLAR_ACCESS_TOKEN
  if (!t) fail('unavailable', 'Paying is not set up yet.')
  return t
}

function site(): string {
  const s = env.SITE_URL
  if (!s) fail('unavailable', 'Paying is not set up yet.')
  return s.replace(/\/$/, '')
}

/**
 * Polar's answer, or null when it refused the request (a 4xx), after logging
 * which fields it did not like (never their values: they can be an email).
 * An outage or a server error is not a refusal: that one ends the call.
 */
async function polar(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${POLAR}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token()}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  }).catch((e: unknown) => {
    console.error('[billing] Polar is not reachable', e)
    return null
  })
  if (res?.ok) return await res.json()
  if (res && res.status >= 400 && res.status < 500) {
    const why = (await res.json().catch(() => null)) as {
      detail?: Array<{ loc?: Array<unknown>; type?: string }>
    } | null
    const fields = Array.isArray(why?.detail)
      ? why.detail.map((d) => `${String(d.loc?.at(-1))}: ${d.type}`).join(', ')
      : ''
    console.error(`[billing] Polar refused ${path} (${res.status}) ${fields}`)
    return null
  }
  console.error(
    `[billing] Polar answered ${res?.status ?? 'nothing'} on ${path}`,
  )
  fail('unavailable', 'Payments are not available right now. Try again soon.')
}

const payer = (ctx: ActionCtx, account: string | undefined) =>
  ctx.runQuery(
    internal.billing.payerOf,
    account === undefined ? {} : { account },
  )

/**
 * An address on Polar where the person pays for a plan. The plan and the
 * paying account ride in the checkout's metadata, which Polar hands back on
 * every subscription event.
 *
 * `currency` is a hint from the browser (euros in Europe): Polar's own guess
 * would come from this server's address, not the customer's.
 */
export const checkout = action({
  args: {
    plan: paid,
    cycle: v.union(v.literal('month'), v.literal('year')),
    seats: v.optional(v.number()),
    currency: v.optional(v.union(v.literal('eur'), v.literal('usd'))),
    account: v.optional(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, a) => {
    const who = await payer(ctx, a.account)
    if (who.subscribed)
      fail(
        'conflict',
        'This account already has a plan. Change it from billing.',
      )
    const seats = perSeat(a.plan)
      ? Math.min(10_000, Math.max(1, Math.floor(a.seats ?? who.members)))
      : undefined
    const session = {
      products: [polarProducts[a.plan][a.cycle]],
      metadata: { account: who.handle, plan: a.plan },
      external_customer_id: who.id,
      allow_trial: false,
      ...(seats === undefined ? {} : { seats }),
      ...(a.currency === undefined ? {} : { currency: a.currency }),
      success_url: `${site()}/settings/plan?billing=done`,
      return_url: `${site()}/pricing`,
    }
    // The person's email and name save typing. Polar checks that the email's
    // domain takes mail, and refuses one that does not: then the checkout
    // asks for it instead of failing.
    const prefill = {
      ...(who.email === null ? {} : { customer_email: who.email }),
      ...(who.name === null ? {} : { customer_name: who.name }),
    }
    const made = ((await polar('/checkouts/', { ...session, ...prefill })) ??
      (await polar('/checkouts/', session)) ??
      {}) as { url?: unknown }
    if (typeof made.url !== 'string')
      fail(
        'unavailable',
        'Payments are not available right now. Try again soon.',
      )
    return made.url
  },
})

/** An address on Polar where the person manages the subscription: card, invoices, cancel. */
export const portal = action({
  args: { account: v.optional(v.string()) },
  returns: v.string(),
  handler: async (ctx, a) => {
    const who = await payer(ctx, a.account)
    if (!who.subscribed)
      fail('not_found', 'This account has no plan to manage.')
    const made = (await polar('/customer-sessions/', {
      external_customer_id: who.id,
      return_url: `${site()}/settings/plan`,
    })) as { customer_portal_url?: unknown } | null
    if (typeof made?.customer_portal_url !== 'string')
      fail(
        'unavailable',
        'Payments are not available right now. Try again soon.',
      )
    return made.customer_portal_url
  },
})
