import { describe, expect, test } from 'bun:test'
import {
  DUE_CHECK_MAX_MS,
  DUE_POLL_MS,
  DUE_RECHECK_MAX_MS,
  DUE_RECHECK_MS,
  dueTimer,
  followDeliveries,
} from './convex-hooks'

/** A clock and timers that move only when told to. */
function fakeTime() {
  let t = 1_000_000
  const timers: Array<{ at: number; fn: () => void; live: boolean }> = []
  return {
    now: () => t,
    setTimer(fn: () => void, ms: number) {
      const timer = { at: t + ms, fn, live: true }
      timers.push(timer)
      return () => (timer.live = false)
    },
    /** The time the one live timer fires at, or null. */
    next() {
      const live = timers.filter((x) => x.live)
      expect(live.length).toBeLessThanOrEqual(1)
      return live.at(0)?.at ?? null
    },
    async advance(ms: number) {
      t += ms
      for (const x of timers)
        if (x.live && x.at <= t) {
          x.live = false
          x.fn()
        }
      // Let the send and what follows it settle.
      for (let i = 0; i < 5; i++) await Promise.resolve()
    },
  }
}

describe('dueTimer', () => {
  test('sends once, when the next delivery comes due', async () => {
    const time = fakeTime()
    let sends = 0
    const due = dueTimer(() => {
      sends++
      return Promise.resolve()
    }, time)
    due.update(time.now() + 30_000)
    expect(time.next()).toBe(time.now() + 30_000)
    await time.advance(29_999)
    expect(sends).toBe(0)
    await time.advance(1)
    expect(sends).toBe(1)
  })

  test('a new answer replaces the timer', async () => {
    const time = fakeTime()
    let sends = 0
    const due = dueTimer(() => {
      sends++
      return Promise.resolve()
    }, time)
    due.update(time.now() + 60_000)
    due.update(time.now() + 5_000)
    expect(time.next()).toBe(time.now() + 5_000)
    await time.advance(5_000)
    expect(sends).toBe(1)
  })

  test('nothing pending: only an hourly look', async () => {
    const time = fakeTime()
    let sends = 0
    const due = dueTimer(() => {
      sends++
      return Promise.resolve()
    }, time)
    due.update(null)
    expect(time.next()).toBe(time.now() + DUE_CHECK_MAX_MS)
    await time.advance(DUE_CHECK_MAX_MS)
    expect(sends).toBe(1)
    expect(time.next()).toBe(time.now() + DUE_CHECK_MAX_MS)
  })

  test('due but not claimable yet (clocks differ): looks again shortly', async () => {
    const time = fakeTime()
    let sends = 0
    const due = dueTimer(() => {
      sends++
      return Promise.resolve()
    }, time)
    due.update(time.now())
    await time.advance(0)
    expect(sends).toBe(1)
    expect(time.next()).toBe(time.now() + DUE_RECHECK_MS)
    // The send settled it: Convex answers with the next one.
    due.update(time.now() + 120_000)
    expect(time.next()).toBe(time.now() + 120_000)
  })

  test('a failed send is retried, and stop stops it', async () => {
    const time = fakeTime()
    let sends = 0
    const due = dueTimer(() => {
      sends++
      return Promise.reject(new Error('down'))
    }, time)
    due.update(time.now())
    await time.advance(0)
    await time.advance(DUE_RECHECK_MS)
    expect(sends).toBe(2)
    // Then it backs off: 2 s, 4 s, … up to a minute, not a call a second.
    expect(time.next()).toBe(time.now() + 2 * DUE_RECHECK_MS)
    for (let i = 0; i < 10; i++) await time.advance(DUE_RECHECK_MAX_MS)
    expect(time.next()).toBe(time.now() + DUE_RECHECK_MAX_MS)
    // A new answer starts over at a second.
    due.update(time.now())
    await time.advance(0)
    expect(time.next()).toBe(time.now() + DUE_RECHECK_MS)
    due.stop()
    expect(time.next()).toBeNull()
  })
})

describe('followDeliveries', () => {
  test('polls until the first answer and while the subscription fails', () => {
    const time = fakeTime()
    let answer: (at: number | null) => void = () => {}
    let fail: () => void = () => {}
    const intervals: Array<{ ms: number; live: boolean }> = []
    const f = followDeliveries(
      (onAnswer, onError) => {
        answer = onAnswer
        fail = onError
      },
      () => Promise.resolve(),
      {
        ...time,
        every: (_fn, ms) => {
          const i = { ms, live: true }
          intervals.push(i)
          return () => (i.live = false)
        },
      },
    )
    // Until the first answer it asks, as servers did before: a subscription
    // that never connects must not stop deliveries.
    expect(f.polling).toBe(true)
    expect(intervals.filter((i) => i.live)).toEqual([
      { ms: DUE_POLL_MS, live: true },
    ])
    answer(time.now() + 60_000)
    expect(f.polling).toBe(false)
    expect(intervals.filter((i) => i.live)).toEqual([])
    fail()
    fail()
    // One fallback, not one per error, and no due timer meanwhile.
    expect(intervals.filter((i) => i.live)).toEqual([
      { ms: DUE_POLL_MS, live: true },
    ])
    expect(time.next()).toBeNull()
    answer(time.now() + 5_000)
    expect(f.polling).toBe(false)
    expect(intervals.filter((i) => i.live)).toEqual([])
    expect(time.next()).toBe(time.now() + 5_000)
    f.stop()
    expect(time.next()).toBeNull()
  })
})
