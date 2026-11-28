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

// Team and Business are sold by the seat: their limits are for one seat, and
// an organization has them times its seats, shared by every member.
export const planLimits: Record<PlanId, PlanLimits> = {
  free: { storageGb: 0.1, transferGb: 0.5, pushGb: 0.1 },
  solo: { storageGb: 3, transferGb: 50, pushGb: 10 },
  team: { storageGb: 3, transferGb: 50, pushGb: 10 },
  business: { storageGb: 10, transferGb: 100, pushGb: 30 },
}

export const planNames: Record<PlanId, string> = {
  free: 'Free',
  solo: 'Pro',
  team: 'Team',
  business: 'Business',
}

export const perSeat = (plan: PlanId): boolean =>
  plan === 'team' || plan === 'business'

export function limitsFor(plan: PlanId, seats = 1): PlanLimits {
  const l = planLimits[plan]
  const n = perSeat(plan) ? Math.max(1, Math.floor(seats)) : 1
  return {
    storageGb: l.storageGb * n,
    transferGb: l.transferGb * n,
    pushGb: l.pushGb * n,
  }
}

export const isPlanId = (x: unknown): x is PlanId =>
  typeof x === 'string' && (planOrder as ReadonlyArray<string>).includes(x)

export type AccountKind = 'person' | 'organization'

// A person may keep private repositories on Free, inside its allowance. An
// organization needs Team or Business for them.
export const allowsPrivate = (plan: PlanId, kind: AccountKind): boolean =>
  kind === 'person' || plan !== 'free'

export const hasBusiness = (plan: PlanId): boolean => plan === 'business'

export const AUDIT_KEEP_MS = 366 * 86_400_000

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
  expires?: number | null
  revoked?: number | null
}

export type Effective = {
  plan: PlanId
  source: 'subscription' | 'grant' | 'free'
  until: number | null
  lapsedAt: number | null
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
  kind: AccountKind,
  quota: Quota | null = null,
):
  | { writable: true }
  | { writable: false; why: 'plan' | 'deletion' | 'quota' } {
  if (pendingDeletion) return { writable: false, why: 'deletion' }
  if (visibility === 'private' && !allowsPrivate(plan, kind))
    return { writable: false, why: 'plan' }
  if (quota) return { writable: false, why: 'quota' }
  return { writable: true }
}
