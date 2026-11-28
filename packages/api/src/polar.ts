import { isPlanId } from './plans'
import type { PaidPlanId } from './plans'

export type SubscriptionChange = {
  handle: string
  plan: PaidPlanId
  status: 'active' | 'lapsed'
  seats?: number
  periodEnd?: number
  providerRef: string
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

const HAS = new Set(['active', 'trialing', 'past_due'])

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
    status: !ended && HAS.has(status) ? 'active' : 'lapsed',
    ...(seats === undefined ? {} : { seats }),
    ...(time(d.current_period_end) === undefined
      ? {}
      : { periodEnd: time(d.current_period_end) }),
    providerRef: ref,
    at: time(e.timestamp) ?? time(d.modified_at) ?? 0,
  }
}

function signingKeys(secret: string): Array<Uint8Array<ArrayBuffer>> {
  const keys: Array<Uint8Array<ArrayBuffer>> = []
  const encoded = secret.startsWith('whsec_') ? secret.slice(6) : secret
  try {
    const bin = atob(encoded)
    keys.push(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
  } catch {}
  keys.push(new TextEncoder().encode(secret))
  return keys
}

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
  const message = new TextEncoder().encode(
    `${headers.id}.${headers.timestamp}.${body}`,
  )
  const sent = headers.signature
    .split(' ')
    .map((part) => part.split(',', 2))
    .filter(([version, sig]) => version === 'v1' && sig)
    .map(([, sig]) => sig)
  let ok = false
  for (const raw of signingKeys(secret)) {
    const key = await crypto.subtle.importKey(
      'raw',
      raw,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, message))
    let bin = ''
    for (const b of mac) bin += String.fromCharCode(b)
    const want = btoa(bin)
    for (const sig of sent) {
      let diff = want.length ^ sig.length
      for (let i = 0; i < Math.max(want.length, sig.length); i++)
        diff |= (want.charCodeAt(i) || 0) ^ (sig.charCodeAt(i) || 0)
      if (diff === 0) ok = true
    }
  }
  return ok ? null : 'The signature does not match.'
}

export const polarProducts: Record<
  PaidPlanId,
  { month: string; year: string }
> = {
  solo: {
    month: '547cfbcd-f154-4bca-9733-238a2b98bbe2',
    year: '6f9ec21f-f79c-4d39-ae7c-a545aea7310c',
  },
  team: {
    month: 'f7efe543-12aa-4a72-8338-e9264fa5762d',
    year: '8ffab6ad-9379-4480-abed-4cfaa9f1a86f',
  },
  business: {
    month: '994cba1f-480e-4f9c-9cc1-6f52c77c5685',
    year: '31e5dd1b-5120-4d58-8139-37b321101261',
  },
}

export { perSeat } from './plans'
