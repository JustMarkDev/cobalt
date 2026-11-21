import { isPlanId } from './plans'
import type { PaidPlanId } from './plans'

/**
 * What a Polar subscription webhook means for an account. Pure, so it is
 * tested without Polar: the HTTP route (`convex/http.ts`) verifies the
 * signature, calls this, and stores the answer (`plans:setSubscription`).
 *
 * The checkout puts two things in the subscription's metadata, which Polar
 * hands back on every event: `account` (the address that pays) and `plan`
 * (`solo`, `team` or `business`; the product's own metadata works too).
 */
export type SubscriptionChange = {
  handle: string
  plan: PaidPlanId
  status: 'active' | 'lapsed'
  seats?: number
  periodEnd?: number
  /** The provider's subscription id, to find it in their dashboard. */
  providerRef: string
  /** When the event happened, so an old one never undoes a newer one. */
  at: number
}

type Json = Record<string, unknown>
const obj = (x: unknown): Json =>
  typeof x === 'object' && x !== null ? (x as Json) : {}
const str = (x: unknown): string | undefined =>
  typeof x === 'string' && x !== '' ? x : undefined
const time = (x: unknown): number | undefined => {
  const t = typeof x === 'string' ? Date.parse(x) : Number.NaN
  return Number.isNaN(t) ? undefined : t
}

/** Statuses in which the customer has what they paid for. A failed payment is `past_due`: Polar retries, so access holds until it gives up. */
const HAS = new Set(['active', 'trialing', 'past_due'])

/** `null` for an event that is not about a subscription, or names no account or plan. */
export function subscriptionChange(event: unknown): SubscriptionChange | null {
  const e = obj(event)
  const type = str(e.type)
  if (!type?.startsWith('subscription.')) return null
  const d = obj(e.data)
  const meta = obj(d.metadata)
  const productMeta = obj(obj(d.product).metadata)
  const handle = str(meta.account) ?? str(obj(d.customer).external_id)
  const plan = str(meta.plan) ?? str(productMeta.plan)
  const ref = str(d.id)
  if (!handle || !plan || !isPlanId(plan) || plan === 'free' || !ref)
    return null
  const status = str(d.status) ?? ''
  const ended = type === 'subscription.revoked' || str(d.ended_at) !== undefined
  const seats = typeof d.seats === 'number' ? d.seats : undefined
  return {
    handle,
    plan,
    // A subscription cancelled "at the end of the period" is still `active`
    // until then; Polar sends `revoked` when it really ends.
    status: !ended && HAS.has(status) ? 'active' : 'lapsed',
    ...(seats === undefined ? {} : { seats }),
    ...(time(d.current_period_end) === undefined
      ? {}
      : { periodEnd: time(d.current_period_end) }),
    providerRef: ref,
    at: time(e.timestamp) ?? time(d.modified_at) ?? 0,
  }
}

/**
 * Standard Webhooks (what Polar signs with): headers `webhook-id`,
 * `webhook-timestamp` and `webhook-signature` (`v1,<base64>` , several may be
 * listed), an HMAC-SHA256 of `<id>.<timestamp>.<body>` with the secret. Five
 * minutes either way. Returns what is wrong, or null.
 */
export async function verifyStandardWebhook(
  body: string,
  headers: {
    id: string | null
    timestamp: string | null
    signature: string | null
  },
  secret: string | undefined,
  nowMs: number,
): Promise<string | null> {
  if (!secret) return 'This deployment has no webhook secret.'
  if (!headers.id || !headers.timestamp || !headers.signature)
    return 'The signature headers are missing.'
  const ts = Number.parseInt(headers.timestamp, 10)
  if (Number.isNaN(ts)) return 'The timestamp is not valid.'
  if (Math.abs(Math.floor(nowMs / 1000) - ts) > 300)
    return 'The webhook is too old or from the future.'
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = new Uint8Array(
    await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(`${headers.id}.${headers.timestamp}.${body}`),
    ),
  )
  let bin = ''
  for (const b of mac) bin += String.fromCharCode(b)
  const want = btoa(bin)
  for (const part of headers.signature.split(' ')) {
    const [version, sig] = part.split(',', 2)
    if (version !== 'v1' || !sig) continue
    // Compared in full, so the answer does not leak how much matched.
    let diff = want.length ^ sig.length
    for (let i = 0; i < Math.max(want.length, sig.length); i++)
      diff |= (want.charCodeAt(i) || 0) ^ (sig.charCodeAt(i) || 0)
    if (diff === 0) return null
  }
  return 'The signature does not match.'
}
