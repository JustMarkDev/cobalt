import { Effect } from 'effect'
import { z } from 'zod'
import { INBOX_MAX } from '../inbox'
import { Domain, defineOp } from '../registry'
import * as S from '../schemas'

/**
 * The inbox answers "what needs me", not "what happened": a queue worked out
 * from the state of things, so a review that lands or a build that goes green
 * leaves it by itself. `notifications.list` stays the activity feed.
 */
export const listInbox = defineOp({
  id: 'inbox.list',
  summary: 'What needs you now',
  description:
    'Stopped mirrors, failing builds, your blocked changes, reviews waiting on you, pipeline steps waiting on you, runs no runner can take, issues assigned to you and unread mentions, in the repositories you can read. Most costly first, then newest. A queue is short by design: not paged, at most 100.',
  tags: ['notifications'],
  method: 'GET',
  path: '/inbox',
  auth: 'required',
  pool: 'read',
  safety: 'read',
  idempotent: true,
  query: z.strictObject({
    limit: z.coerce.number().int().min(1).max(INBOX_MAX).default(50),
  }),
  response: S.Inbox,
  errors: [],
  handler: (ctx) =>
    Effect.gen(function* () {
      const { run } = yield* Domain
      return yield* run((d) => d.inbox(ctx.principal, ctx.query.limit))
    }),
})

export const inboxOps = [listInbox]
