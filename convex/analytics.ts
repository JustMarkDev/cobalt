import { v } from 'convex/values'
import { internal } from './_generated/api'
import {
  env,
  internalAction,
  internalMutation,
  internalQuery,
} from './_generated/server'

/**
 * Sends queued product events (`lib/stats.ts`, `track`) to PostHog, one batch
 * a minute. Events are anonymous to PostHog (no person profiles), which is
 * the cheapest kind; the actor's handle is the distinct id, so events can
 * still be grouped by who did them.
 *
 * A batch that fails stays queued and goes with the next one. Events a week
 * old are dropped, so a long outage cannot grow the queue without end.
 */
const BATCH = 500

export const waiting = internalQuery({
  args: {},
  returns: v.array(
    v.object({
      id: v.id('analyticsOutbox'),
      event: v.string(),
      who: v.string(),
      at: v.number(),
      props: v.string(),
    }),
  ),
  handler: async (ctx) =>
    (await ctx.db.query('analyticsOutbox').take(BATCH)).map((e) => ({
      id: e._id,
      event: e.event,
      who: e.who,
      at: e.at,
      props: e.props,
    })),
})

export const sent = internalMutation({
  args: { ids: v.array(v.id('analyticsOutbox')) },
  returns: v.null(),
  handler: async (ctx, { ids }) => {
    for (const id of ids)
      if (await ctx.db.get('analyticsOutbox', id))
        await ctx.db.delete('analyticsOutbox', id)
    return null
  },
})

/** Drops events a week old: PostHog was unreachable for too long. */
export const trim = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const cutoff = Date.now() - 7 * 86_400_000
    for (const e of await ctx.db.query('analyticsOutbox').take(BATCH)) {
      if (e.at >= cutoff) break
      await ctx.db.delete('analyticsOutbox', e._id)
    }
    return null
  },
})

export const send = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const key = env.POSTHOG_KEY
    if (!key) return null
    const host = (env.POSTHOG_HOST ?? 'https://us.i.posthog.com').replace(
      /\/$/,
      '',
    )
    // A few batches a minute at most; the rest waits for the next minute.
    for (let i = 0; i < 4; i++) {
      const batch = await ctx.runQuery(internal.analytics.waiting, {})
      if (batch.length === 0) return null
      const res = await fetch(`${host}/batch/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          api_key: key,
          batch: await Promise.all(
            batch.map(async (e) => ({
              event: e.event,
              distinct_id: e.who,
              timestamp: new Date(e.at).toISOString(),
              // Dedupes a batch sent twice after a crash between send and delete.
              uuid: await uuidOf(e.id),
              properties: {
                ...(JSON.parse(e.props) as Record<string, unknown>),
                $process_person_profile: false,
                $lib: 'cobalt-convex',
              },
            })),
          ),
        }),
      }).catch((e: unknown) => ({ ok: false, status: String(e) }))
      if (!res.ok) {
        console.error(`[analytics] PostHog answered ${res.status}`)
        await ctx.runMutation(internal.analytics.trim, {})
        return null
      }
      await ctx.runMutation(internal.analytics.sent, {
        ids: batch.map((e) => e.id),
      })
      if (batch.length < BATCH) return null
    }
    return null
  },
})

/** A stable UUID-shaped id from a document id, for PostHog's dedupe. */
async function uuidOf(id: string) {
  const d = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id)),
  )
  const h = Array.from(d.subarray(0, 16), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
}
