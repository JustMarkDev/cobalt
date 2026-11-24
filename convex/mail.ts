import { v } from 'convex/values'
import { internal } from './_generated/api'
import {
  internalAction,
  internalMutation,
  internalQuery,
} from './_generated/server'
import { MailError, sendMail } from './lib/mail'
import type { MutationCtx } from './_generated/server'

/** Failed sends before the message is given up on. */
const MAX_ATTEMPTS = 6
/** Wait before the next try, after the first, second, ... failure. */
const BACKOFF_MS = [
  10 * 1000,
  60 * 1000,
  5 * 60 * 1000,
  30 * 60 * 1000,
  2 * 60 * 60 * 1000,
]
/** A reset or confirmation link is stale by now; so is anything left behind. */
const KEEP_MS = 24 * 60 * 60 * 1000

/**
 * Mail a write sends. It is queued in the same transaction as the write, so
 * it goes out only if the write committed, and sent right after by `deliver`.
 */
export async function queueMail(
  ctx: MutationCtx,
  m: { to: string; subject: string; text: string },
) {
  const id = await ctx.db.insert('outbox', {
    ...m,
    created: Date.now(),
    attempts: 0,
  })
  await ctx.scheduler.runAfter(0, internal.mail.deliver, { id })
}

/** The message to send, left in place: it goes only once Resend took it. */
export const read = internalQuery({
  args: { id: v.id('outbox') },
  returns: v.union(
    v.null(),
    v.object({ to: v.string(), subject: v.string(), text: v.string() }),
  ),
  handler: async (ctx, { id }) => {
    const m = await ctx.db.get('outbox', id)
    return m && { to: m.to, subject: m.subject, text: m.text }
  },
})

/**
 * The outcome of one send. Sent: the message is dropped. Failed: it is tried
 * again after a wait, unless the failure cannot get better or the attempts
 * ran out, and then it is dropped too. One transaction, so a message is never
 * left without a try scheduled, nor tried again after it went.
 */
export const settle = internalMutation({
  args: {
    id: v.id('outbox'),
    // Set when the send failed.
    error: v.optional(v.string()),
    retry: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, { id, error, retry }) => {
    const m = await ctx.db.get('outbox', id)
    if (!m) return null
    if (error === undefined) {
      await ctx.db.delete('outbox', id)
      return null
    }
    const attempts = (m.attempts ?? 0) + 1
    if (retry === false || attempts >= MAX_ATTEMPTS) {
      // Not the address or the text: they are in the row, not in the log.
      console.error(`[mail] gave up on ${id} after ${attempts}: ${error}`)
      await ctx.db.delete('outbox', id)
      return null
    }
    await ctx.db.patch('outbox', id, { attempts })
    await ctx.scheduler.runAfter(
      BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)],
      internal.mail.deliver,
      { id },
    )
    return null
  },
})

export const deliver = internalAction({
  args: { id: v.id('outbox') },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    const m = await ctx.runQuery(internal.mail.read, { id })
    if (!m) return null
    try {
      // The row's id is the key: a try after a lost answer cannot send twice.
      await sendMail(m.to, m.subject, m.text, {
        idempotencyKey: `outbox/${id}`,
      })
    } catch (e) {
      await ctx.runMutation(internal.mail.settle, {
        id,
        error: (e instanceof Error ? e.message : String(e)).slice(0, 300),
        retry: e instanceof MailError ? e.retryable : true,
      })
      return null
    }
    await ctx.runMutation(internal.mail.settle, { id })
    return null
  },
})

/** Drops what a crash between two tries left behind. */
export const sweep = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const old = await ctx.db
      .query('outbox')
      .withIndex('by_created', (q) => q.lt('created', Date.now() - KEEP_MS))
      .take(500)
    for (const m of old) await ctx.db.delete('outbox', m._id)
    return null
  },
})
