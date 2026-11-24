import type { Landing } from './policy-file'

import { canMove, landingStepLifecycle } from './lifecycles'
import type { StepState } from './lifecycles'

export type { StepState } from './lifecycles'

export type LandingStepRec = {
  kind: 'land' | 'run_pipeline' | 'webhook'
  target: string
  state: StepState
  detail: string
  finished: number | null
}

export function hasAfterSteps(landing: Landing) {
  return landing.steps.some((s) => !('wait_checks' in s))
}

export function landingPlan(
  numbers: ReadonlyArray<number>,
  landing: Landing,
): Array<LandingStepRec> {
  const plan: Array<LandingStepRec> = numbers.map((n) => ({
    kind: 'land',
    target: String(n),
    state: 'pending',
    detail: '',
    finished: null,
  }))
  for (const s of landing.steps)
    if ('run_pipeline' in s)
      plan.push({
        kind: 'run_pipeline',
        target: s.run_pipeline,
        state: 'pending',
        detail: '',
        finished: null,
      })
    else if ('webhook' in s)
      plan.push({
        kind: 'webhook',
        target: s.webhook,
        state: 'pending',
        detail: '',
        finished: null,
      })
  return plan
}

export function stepName(s: LandingStepRec) {
  if (s.kind === 'land') return `Land #${s.target}`
  if (s.kind === 'run_pipeline') return `Run the ${s.target} pipeline`
  return `Call ${s.target}`
}

export function presentSteps(
  steps: ReadonlyArray<LandingStepRec>,
  iso: (t: number) => string,
) {
  return steps.map((s) => ({
    name: stepName(s),
    kind: s.kind,
    target: s.target,
    state: s.state,
    detail: s.detail,
    finished_at: s.finished === null ? null : iso(s.finished),
  }))
}

export function skipRest(steps: Array<LandingStepRec>, from: number) {
  for (const s of steps.slice(from))
    if (canMove(landingStepLifecycle, s.state, 'skipped')) {
      s.state = 'skipped'
      s.detail = 'Not run: a step before it failed.'
    }
}
