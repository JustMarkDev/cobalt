export type LandingAsk =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'following'; operation: string }
  | { kind: 'landed' }
  | { kind: 'refused'; message: string }

export type LandingEvent =
  | { type: 'send' }
  | { type: 'refused'; message: string }
  | { type: 'following'; operation: string }
  | { type: 'landed' }

const allowed: Record<LandingAsk['kind'], Array<LandingEvent['type']>> = {
  idle: ['send'],
  refused: ['send'],
  sending: ['refused', 'following', 'landed'],
  following: ['send'],
  landed: [],
}

export function landingReducer(s: LandingAsk, e: LandingEvent): LandingAsk {
  if (!allowed[s.kind].includes(e.type)) return s
  switch (e.type) {
    case 'send':
      return { kind: 'sending' }
    case 'refused':
      return { kind: 'refused', message: e.message }
    case 'following':
      return { kind: 'following', operation: e.operation }
    case 'landed':
      return { kind: 'landed' }
  }
}

export const idleLanding: LandingAsk = { kind: 'idle' }

export function followedOperation(ask: LandingAsk, remembered: string | null) {
  return ask.kind === 'following' ? ask.operation : remembered
}

export type LandingView = {
  phase: 'idle' | 'landing' | 'landed'
  canLand: boolean
  operation: string | null
  message: string | null
}

export function landingView(input: {
  change: 'draft' | 'open' | 'landed' | 'abandoned'
  blockers: number
  ask: LandingAsk
  operation: string | null
  op: { state: string; error?: { detail?: string } | null } | null | undefined
}): LandingView {
  const { change, ask, op, operation } = input
  const opState = operation ? op?.state : undefined
  const phase: LandingView['phase'] =
    change === 'landed' || ask.kind === 'landed' || opState === 'succeeded'
      ? 'landed'
      : ask.kind === 'sending' ||
          (operation !== null && opState !== 'failed' && opState !== 'canceled')
        ? 'landing'
        : 'idle'
  const message =
    ask.kind === 'refused'
      ? ask.message
      : opState === 'failed'
        ? (op?.error?.detail ?? 'The landing failed.')
        : null
  return {
    phase,
    canLand: phase === 'idle' && change === 'open' && input.blockers === 0,
    operation,
    message,
  }
}
