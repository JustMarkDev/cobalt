/**
 * What we charge. Public: the pricing page reads this.
 * The costs and margins behind these numbers live in `internal/pricing-model.ts`,
 * and a test fails if a price here stops covering them.
 */

import { planLimits } from '@cobaltforge/api/plans'
import type { PaidPlanId, PlanLimits } from '@cobaltforge/api/plans'

export type { PaidPlanId, PlanId } from '@cobaltforge/api/plans'

/** The numbers are in `@cobaltforge/api/plans`, where the code that enforces them reads them. */
export type Limits = PlanLimits

export type Plan = {
  id: PaidPlanId
  name: string
  blurb: string
  /** USD per seat per month, billed monthly. */
  monthly: number
  perSeat: boolean
  limits: Limits
  features: Array<string>
  lead?: string
  featured?: boolean
}

/** Yearly billing is 10 months for 12, then rounded down to a whole dollar a month. */
export const YEARLY_MONTHS = 10

/** Beyond a plan, billed in arrears at published rates. */
export const overage = { storagePerGbMonth: 3.5, transferPerGb: 0.3 }

/**
 * The plan every account starts on, forever and without a card. Public
 * repositories only: a private repository, or agent access to secrets, needs a
 * paid plan. There is no trial of a paid plan: you pay, and the withdrawal
 * period the law gives you applies.
 */
export type FreePlan = Omit<Plan, 'id' | 'monthly' | 'perSeat' | 'featured'> & {
  id: 'free'
  monthly: 0
}

export const freePlan: FreePlan = {
  id: 'free',
  name: 'Free',
  blurb: 'For open source, and for trying it out.',
  monthly: 0,
  limits: planLimits.free,
  lead: 'Includes',
  features: [
    'Public repositories, with no card',
    'Import history from the hosts you use',
    'Unlimited mirrors',
    'The CLI, the MCP server and the agent skill',
  ],
}

export const plans: Array<Plan> = [
  {
    id: 'solo',
    name: 'Solo',
    blurb: 'For your own projects and your own history.',
    monthly: 15,
    perSeat: false,
    lead: 'Includes',
    limits: planLimits.solo,
    features: [
      'Public and private repositories',
      'Import history from the hosts you use',
      'Unlimited mirrors, so a copy lives elsewhere too',
      'Changes, policies and secrets in git',
      'The CLI, the MCP server and the agent skill',
      'Agent access to development secrets, with grants',
    ],
  },
  {
    id: 'team',
    name: 'Team',
    blurb: 'For groups that review each other’s work.',
    monthly: 25,
    perSeat: true,
    limits: planLimits.team,
    lead: 'Everything in Solo, plus',
    features: [
      'Teams as approvers, and approver classes for agents',
      'Shared policies across repositories',
      'Secrets recipients managed for the whole team',
      'Storage and transfer pooled across seats',
      'Two years of audit log',
      'Priority support',
    ],
    featured: true,
  },
  {
    id: 'business',
    name: 'Business',
    blurb: 'For larger codebases and heavier agent use.',
    monthly: 50,
    perSeat: true,
    limits: planLimits.business,
    lead: 'Everything in Team, plus',
    features: [
      'Sync alerts for every mirror',
      'Policy dry runs and expiring exceptions',
      'Spend caps and token history for agents',
      'Five years of audit log',
      'Support with a named contact',
    ],
  },
]

/** Price per seat per month on a given billing cycle. Always a whole number, rounded down. */
export function perMonth(plan: Plan, cycle: 'month' | 'year'): number {
  return cycle === 'year'
    ? Math.floor((plan.monthly * YEARLY_MONTHS) / 12)
    : plan.monthly
}

/** What a yearly customer is charged once a year. */
export const perYear = (plan: Plan): number => perMonth(plan, 'year') * 12
