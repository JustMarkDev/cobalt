import { planLimits } from '@cobaltforge/api/plans'
import type { PaidPlanId, PlanLimits } from '@cobaltforge/api/plans'

export type { PaidPlanId, PlanId } from '@cobaltforge/api/plans'

export type Limits = PlanLimits

export type Plan = {
  id: PaidPlanId
  name: string
  monthly: number
  perSeat: boolean
  limits: Limits
  featured?: boolean
}

// A year is ten months for twelve.
export const YEARLY_MONTHS = 10

export const freeLimits = planLimits.free

export const personalPlans: Array<Plan> = [
  {
    id: 'solo',
    name: 'Pro',
    monthly: 20,
    perSeat: false,
    limits: planLimits.solo,
    featured: true,
  },
]

export const organizationPlans: Array<Plan> = [
  {
    id: 'team',
    name: 'Team',
    monthly: 25,
    perSeat: true,
    limits: planLimits.team,
    featured: true,
  },
  {
    id: 'business',
    name: 'Business',
    monthly: 70,
    perSeat: true,
    limits: planLimits.business,
  },
]

export const plans: Array<Plan> = [...personalPlans, ...organizationPlans]

export const planName = (id: PaidPlanId | 'free'): string =>
  id === 'free' ? 'Free' : (plans.find((p) => p.id === id)?.name ?? id)

// What one seat (or the one person on Pro) costs for a period.
export function price(
  plan: Plan,
  cycle: 'month' | 'year',
): { total: number; monthly: number; full: number } {
  if (cycle === 'month')
    return { total: plan.monthly, monthly: plan.monthly, full: plan.monthly }
  const total = plan.monthly * YEARLY_MONTHS
  return { total, monthly: total / 12, full: plan.monthly * 12 }
}

export function money(n: number, currency: '$' | '€'): string {
  const v = Number.isInteger(n) ? n.toLocaleString('en-US') : n.toFixed(2)
  return `${currency}${v}`
}

export function size(gb: number): string {
  return gb < 1 ? `${Math.round(gb * 1000)} MB` : `${+gb.toFixed(1)} GB`
}
