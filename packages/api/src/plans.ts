/**
 * What an account may do, decided by its plan. The one place the numbers and
 * the rules live: the pricing page, Convex and the tests all read this file.
 *
 *   free      every account, forever, with no card. Public repositories.
 *   solo ...  paid. Private repositories.
 *
 * An account's effective plan is the best of three things: its paid
 * subscription, a grant (a plan given to one account by hand, always with an
 * end date) and the free plan. Nothing here reads a clock: pass `now`.
 */

export type PaidPlanId = 'solo' | 'team' | 'business'
export type PlanId = 'free' | PaidPlanId

/** Worst first. A higher index is a better plan. */
export const planOrder: ReadonlyArray<PlanId> = [
  'free',
  'solo',
  'team',
  'business',
]

export type PlanLimits = {
  /** Git storage included, per seat. */
  storageGb: number
  /** Data transferred out (clones, fetches, mirror pushes), per seat per month. */
  transferGb: number
  /** Data pushed in, per seat per month. */
  pushGb: number
}

/** Mirrors have no limit on any plan: what they cost is storage and transfer. */
export const planLimits: Record<PlanId, PlanLimits> = {
  free: { storageGb: 0.25, transferGb: 1, pushGb: 0.25 },
  solo: { storageGb: 4, transferGb: 20, pushGb: 4 },
  team: { storageGb: 8, transferGb: 32, pushGb: 8 },
  business: { storageGb: 20, transferGb: 80, pushGb: 20 },
}

export const isPlanId = (x: unknown): x is PlanId =>
  typeof x === 'string' && (planOrder as ReadonlyArray<string>).includes(x)

/** Private repositories, and agent access to secrets, need a paid plan. */
export const allowsPrivate = (plan: PlanId): boolean => plan !== 'free'

const DAY = 86_400_000

/** After asking to delete an account, how long it can still be taken back. */
export const DELETION_GRACE_MS = 30 * DAY

/** After a subscription ends, how long history stays readable and cloneable. */
export const LAPSED_KEEP_MS = 90 * DAY

/** A grant may not run longer than this: it is a loan, not a plan. */
export const GRANT_MAX_MS = 366 * DAY

export type Subscription = {
  plan: PaidPlanId
  status: 'active' | 'lapsed'
  /** When it stopped being active, if it did. */
  lapsedAt?: number | null
}

export type Grant = {
  plan: PaidPlanId
  expires: number
  revoked?: number | null
}

export type Effective = {
  plan: PlanId
  /** Where the plan comes from. */
  source: 'subscription' | 'grant' | 'free'
  /** When a grant ends, if the plan is one. */
  until: number | null
  /**
   * Set when a subscription ended and nothing better replaced it: the moment
   * it ended, so the 90 days of kept history can be counted from it.
   */
  lapsedAt: number | null
}

export const grantIsLive = (g: Grant, now: number): boolean =>
  !g.revoked && g.expires > now

/** The best plan an account has at `now`. */
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
  }
  const rank = (p: PlanId) => planOrder.indexOf(p)
  if (subscription?.status === 'active')
    best = {
      plan: subscription.plan,
      source: 'subscription',
      until: null,
      lapsedAt: null,
    }
  for (const g of grants) {
    if (!grantIsLive(g, now)) continue
    // A subscription wins a tie: it is the one that lasts.
    if (rank(g.plan) > rank(best.plan))
      best = { plan: g.plan, source: 'grant', until: g.expires, lapsedAt: null }
  }
  return best
}

/** A gigabyte, the way plans count them: decimal, so 0.25 is 250 MB. */
export const GB = 1_000_000_000

/** What an account has used: stored now, moved this month. */
export type Usage = {
  storageBytes: number
  transferBytes: number
  pushBytes: number
}

export type Quota = 'storage' | 'transfer' | 'push'

/**
 * Which limit an account is past, if any. Only Free is held to its limits
 * (new pushes pause, nothing is deleted); a paid plan keeps working and is
 * billed for the excess after the month.
 */
export function overQuota(plan: PlanId, usage: Usage): Quota | null {
  if (plan !== 'free') return null
  const l = planLimits.free
  if (usage.storageBytes > l.storageGb * GB) return 'storage'
  if (usage.transferBytes > l.transferGb * GB) return 'transfer'
  if (usage.pushBytes > l.pushGb * GB) return 'push'
  return null
}

/**
 * The state an account's repositories are in, given its plan and whether it
 * asked to be deleted. `writable` is false for a private repository on the
 * free plan (it was paid for once, and now it only reads) and for everything
 * of an account waiting to be deleted.
 */
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
