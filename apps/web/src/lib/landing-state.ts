/**
 * Landing a change from its page, as one state with explicit moves. What the
 * page shows is worked out from this and from what the server says (the
 * change's state, the landing operation's state) on every render, so it
 * follows a landing made anywhere, by anyone, without an effect to sync it.
 */

/** What this page has asked for. The server's answers are not kept here. */
export type LandingAsk =
  | { kind: 'idle' }
  /** The land request is on its way. */
  | { kind: 'sending' }
  /** The server took it as an operation; the page follows it. */
  | { kind: 'following'; operation: string }
  /** The server landed it at once. */
  | { kind: 'landed' }
  /** The server said no. */
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
  // A failed operation leaves the page free to try again.
  following: ['send'],
  landed: [],
}

/** The page's moves. One that does not apply from where it is changes nothing. */
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

/** Which operation the page follows: its own ask first, else the remembered one. */
export function followedOperation(ask: LandingAsk, remembered: string | null) {
  return ask.kind === 'following' ? ask.operation : remembered
}

export type LandingView = {
  phase: 'idle' | 'landing' | 'landed'
  /** The Land button does something now. */
  canLand: boolean
  /** The operation to follow, if any. */
  operation: string | null
  /** Why the last try did not land, to show. */
  message: string | null
}

/**
 * What the page shows. The change's own state wins: once it is landed it is
 * landed, whoever landed it. A followed operation that failed puts the page
 * back where it can try again, with the reason.
 */
export function landingView(input: {
  change: 'draft' | 'open' | 'landed' | 'abandoned'
  blockers: number
  ask: LandingAsk
  /**
   * The operation being followed: the one this page asked for, or one this
   * tab started before the page was drawn again (`followedOperation`).
   */
  operation: string | null
  /** That operation, as last read. */
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
