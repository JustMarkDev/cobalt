export type PaidPlanId = 'solo' | 'team' | 'business'
export type PlanId = 'free' | PaidPlanId

export const planOrder: ReadonlyArray<PlanId> = [
  'free',
  'solo',
  'team',
  'business',
]

export type PlanLimits = {
  storageGb: number
  transferGb: number
  pushGb: number
}

export const planLimits: Record<PlanId, PlanLimits> = {
  free: { storageGb: 0.25, transferGb: 1, pushGb: 0.25 },
  solo: { storageGb: 4, transferGb: 20, pushGb: 4 },
  team: { storageGb: 8, transferGb: 32, pushGb: 8 },
  business: { storageGb: 20, transferGb: 80, pushGb: 20 },
}

export const isPlanId = (x: unknown): x is PlanId =>
  typeof x === 'string' && (planOrder as ReadonlyArray<string>).includes(x)

export const allowsPrivate = (plan: PlanId): boolean => plan !== 'free'

const DAY = 86_400_000

export const DELETION_GRACE_MS = 30 * DAY

export const LAPSED_KEEP_MS = 90 * DAY

export const GRANT_MAX_MS = 366 * DAY

export type Subscription = {
  plan: PaidPlanId
  status: 'active' | 'lapsed'
  lapsedAt?: number | null
}

export type Grant = {
  plan: PaidPlanId
  /** Absent for a standing grant: the operator's own account, which has no limits. */
  expires?: number | null
  revoked?: number | null
}

export type Effective = {
  plan: PlanId
  source: 'subscription' | 'grant' | 'free'
  until: number | null
  lapsedAt: number | null
  /** A standing grant: no storage, transfer or push limits apply. */
  unlimited: boolean
}

export const grantIsLive = (g: Grant, now: number): boolean =>
  !g.revoked && (g.expires == null || g.expires > now)

export function effectivePlan(
  subscription: Subscription | null,
  grants: ReadonlyArray<Grant>,
  now: number,
): Effective {
  let best: Effective = {
    plan: 'free',
    source: 'free',
    until: null,
    lapsedAt:
      subscription?.status === 'lapsed' ? (subscription.lapsedAt ?? now) : null,
    unlimited: false,
  }
  const rank = (p: PlanId) => planOrder.indexOf(p)
  if (subscription?.status === 'active')
    best = {
      plan: subscription.plan,
      source: 'subscription',
      until: null,
      lapsedAt: null,
      unlimited: false,
    }
  for (const g of grants) {
    if (!grantIsLive(g, now)) continue
    if (g.expires == null)
      return {
        plan: 'business',
        source: 'grant',
        until: null,
        lapsedAt: null,
        unlimited: true,
      }
    if (rank(g.plan) > rank(best.plan))
      best = {
        plan: g.plan,
        source: 'grant',
        until: g.expires,
        lapsedAt: null,
        unlimited: false,
      }
  }
  return best
}

export const GB = 1_000_000_000

export type Usage = {
  storageBytes: number
  transferBytes: number
  pushBytes: number
}

export type Quota = 'storage' | 'transfer' | 'push'

export function overQuota(plan: PlanId, usage: Usage): Quota | null {
  if (plan !== 'free') return null
  const l = planLimits.free
  if (usage.storageBytes > l.storageGb * GB) return 'storage'
  if (usage.transferBytes > l.transferGb * GB) return 'transfer'
  if (usage.pushBytes > l.pushGb * GB) return 'push'
  return null
}

export function repoState(
  plan: PlanId,
  visibility: 'public' | 'private',
  pendingDeletion: boolean,
  quota: Quota | null = null,
):
  | { writable: true }
  | { writable: false; why: 'plan' | 'deletion' | 'quota' } {
  if (pendingDeletion) return { writable: false, why: 'deletion' }
  if (visibility === 'private' && !allowsPrivate(plan))
    return { writable: false, why: 'plan' }
  if (quota) return { writable: false, why: 'quota' }
  return { writable: true }
}
