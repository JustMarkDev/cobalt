import { describe, expect, test } from 'bun:test'
import {
  followedOperation,
  idleLanding,
  landingReducer,
  landingView,
} from './landing-state'
import type { LandingEvent } from './landing-state'

const run = (...events: Array<LandingEvent>) =>
  events.reduce(landingReducer, idleLanding)

const view = (
  over: Partial<Parameters<typeof landingView>[0]> = {},
): ReturnType<typeof landingView> =>
  landingView({
    change: 'open',
    blockers: 0,
    ask: idleLanding,
    operation: null,
    op: undefined,
    ...over,
  })

describe('landing from the change page', () => {
  test('a change landed elsewhere shows landed, though this page asked nothing', () => {
    // The page used to keep the state it was first drawn with.
    expect(view({ change: 'landed' })).toMatchObject({
      phase: 'landed',
      canLand: false,
    })
  })

  test('only an open change with nothing in the way can be landed', () => {
    expect(view().canLand).toBe(true)
    expect(view({ blockers: 1 }).canLand).toBe(false)
    expect(view({ change: 'draft' }).canLand).toBe(false)
    // An abandoned change used to show a Land button that did something.
    expect(view({ change: 'abandoned' }).canLand).toBe(false)
  })

  test('sending, then landed at once', () => {
    const sending = run({ type: 'send' })
    expect(view({ ask: sending })).toMatchObject({
      phase: 'landing',
      canLand: false,
    })
    expect(view({ ask: run({ type: 'send' }, { type: 'landed' }) }).phase).toBe(
      'landed',
    )
  })

  test('a refusal says why and lets it be tried again', () => {
    const refused = run({ type: 'send' }, { type: 'refused', message: 'No.' })
    expect(view({ ask: refused })).toMatchObject({
      phase: 'idle',
      canLand: true,
      message: 'No.',
    })
    expect(landingReducer(refused, { type: 'send' }).kind).toBe('sending')
  })

  test('an operation is followed until it ends, either way', () => {
    const ask = run({ type: 'send' }, { type: 'following', operation: 'op_1' })
    const operation = followedOperation(ask, null)
    expect(operation).toBe('op_1')
    expect(view({ ask, operation, op: undefined }).phase).toBe('landing')
    expect(view({ ask, operation, op: { state: 'running' } }).phase).toBe(
      'landing',
    )
    expect(view({ ask, operation, op: { state: 'succeeded' } }).phase).toBe(
      'landed',
    )
    const failed = view({
      ask,
      operation,
      op: { state: 'failed', error: { detail: 'Checks failed.' } },
    })
    expect(failed).toMatchObject({
      phase: 'idle',
      canLand: true,
      message: 'Checks failed.',
    })
  })

  test('a page drawn again follows the landing this tab started', () => {
    expect(followedOperation(idleLanding, 'op_9')).toBe('op_9')
    expect(view({ operation: 'op_9', op: { state: 'running' } })).toMatchObject(
      { phase: 'landing', canLand: false },
    )
  })

  test('moves that do not apply change nothing', () => {
    // A late answer to a request the page is no longer waiting on.
    expect(landingReducer(idleLanding, { type: 'landed' })).toBe(idleLanding)
    const landed = run({ type: 'send' }, { type: 'landed' })
    expect(landingReducer(landed, { type: 'send' })).toBe(landed)
    const sending = run({ type: 'send' })
    expect(landingReducer(sending, { type: 'send' })).toBe(sending)
  })
})
