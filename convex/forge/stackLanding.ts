import { v } from 'convex/values'
import { ConvexError } from 'convex/values'
import { errorCatalog } from '@cobaltforge/api/problem'
import { newId } from '@cobaltforge/api/ids'
import { skipRest } from '@cobaltforge/api/landing'
import { internal } from '../_generated/api'
import { internalMutation } from '../_generated/server'
import { emit } from '../lib/events'
import { actorOut } from '../lib/present'
import { findChange, hydrate, viewFor } from '../lib/changes'
import { checkLandable, doLand } from './changes'
import { startWorkflow } from './pipelines'
import { enqueue } from './webhooks'
import { actorRef } from '../schema'
import type { LandingStepRec } from '@cobaltforge/api/landing'
import {
  canMove,
  isTerminal,
  landingStepLifecycle,
  operationLifecycle,
} from '@cobaltforge/api/lifecycles'
import type { StepState } from '@cobaltforge/api/lifecycles'
import type { Actor } from '../lib/actor'
import type { ActorRef } from '../lib/events'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'

const stepArgs = {
  operation: v.id('operations'),
  repo: v.id('repos'),
  // `[number, tree]` pairs: the tree each change must still be at.
  trees: v.array(v.array(v.string())),
  i: v.number(),
  // Who asked, as they were checked when they asked.
  as: v.object({
    handle: v.string(),
    actingAs: v.string(),
    via: v.object({
      machine: v.union(v.null(), v.string()),
      tool: v.union(v.null(), v.string()),
      model: v.union(v.null(), v.string()),
    }),
    scopes: v.array(v.string()),
    repos: v.union(v.null(), v.array(v.string())),
  }),
  by: actorRef,
}

/**
 * The landing engine: one step of an operation's plan per transaction. Each
 * change lands in its own step (a single change is a stack of one), then the
 * policy file's landing steps run. A step that fails stops the operation with
 * the reason and the rest are skipped; what landed stays landed. Each step's
 * outcome is kept on the operation.
 *
 * The operation and its steps move only as `lifecycles.ts` allows. A step's
 * own work runs as a nested transaction (`doStep`): when it fails, every
 * write it made rolls back, and only the failure is kept.
 */
export const step = internalMutation({
  args: stepArgs,
  returns: v.null(),
  handler: async (ctx, a) => {
    const op = await ctx.db.get('operations', a.operation)
    const repo = await ctx.db.get('repos', a.repo)
    if (!op || !repo) return null
    // Already over (or this step already ran): nothing more to do.
    if (isTerminal(operationLifecycle, op.state)) return null
    const steps = JSON.parse(op.steps ?? '[]') as Array<LandingStepRec>
    if (a.i < steps.length && steps[a.i].state !== 'pending') return null
    const finished = async (
      state: 'succeeded' | 'failed',
      fields: Partial<typeof op>,
    ) => {
      if (!canMove(operationLifecycle, op.state, state)) return
      await ctx.db.patch('operations', op._id, {
        ...fields,
        state,
        steps: JSON.stringify(steps),
        finished: Date.now(),
      })
      await emit(
        ctx,
        repo,
        'operation.finished',
        a.by,
        { object: 'operation', id: op.publicId, number: null },
        ['state'],
        null,
      )
    }
    if (a.i >= steps.length) {
      await finished('succeeded', { result: op.pending ?? null })
      return null
    }
    const s = steps[a.i]
    const move = (to: StepState) => {
      if (!canMove(landingStepLifecycle, s.state, to))
        throw new Error(`A landing step cannot go from ${s.state} to ${to}.`)
      s.state = to
    }
    move('running')
    let detail: string
    try {
      detail = await ctx.runMutation(internal.forge.stackLanding.doStep, a)
    } catch (e) {
      const data = (e instanceof ConvexError ? e.data : null) as {
        code?: string
        detail?: string
        more?: string
      } | null
      const more = data?.more
        ? (JSON.parse(data.more) as Record<string, unknown>)
        : {}
      const code = (
        data?.code && data.code in errorCatalog ? data.code : 'internal'
      ) as keyof typeof errorCatalog
      const entry = errorCatalog[code]
      move('failed')
      s.finished = Date.now()
      s.detail = data?.detail ?? 'Unexpected failure.'
      skipRest(steps, a.i + 1)
      await finished('failed', {
        error: JSON.stringify({
          type: `https://cobaltforge.dev/docs/api/errors#${code}`,
          title: entry.title,
          status: entry.status,
          code,
          detail: data?.detail ?? 'Unexpected failure.',
          hint: (more.hint as string | undefined) ?? entry.hint,
          retryable: (more.retryable as boolean | undefined) ?? entry.retryable,
          exit_code: entry.exit,
          ...(more.errors ? { errors: more.errors } : {}),
          ...(more.extra as Record<string, unknown> | undefined),
        }),
      })
      return null
    }
    move('succeeded')
    s.detail = detail
    s.finished = Date.now()
    await ctx.db.patch('operations', op._id, {
      ...(op.state === 'queued' &&
      canMove(operationLifecycle, op.state, 'running')
        ? { state: 'running' as const }
        : {}),
      done: a.i + 1,
      steps: JSON.stringify(steps),
    })
    await ctx.scheduler.runAfter(0, internal.forge.stackLanding.step, {
      ...a,
      i: a.i + 1,
    })
    return null
  },
})

/** One step's work. It throws to refuse, and then none of its writes are kept. */
export const doStep = internalMutation({
  args: stepArgs,
  returns: v.string(),
  handler: async (ctx, a) => {
    const op = (await ctx.db.get('operations', a.operation))!
    const repo = (await ctx.db.get('repos', a.repo))!
    const s = (JSON.parse(op.steps ?? '[]') as Array<LandingStepRec>)[a.i]
    const p: Actor = {
      ...a.as,
      scopes: new Set(a.as.scopes),
      session: false,
      tokenId: null,
      system: false,
    }
    const trees = Object.fromEntries(a.trees) as Record<string, string>
    if (s.kind === 'land') {
      const doc = await findChange(ctx, repo, s.target)
      if (!doc)
        throw new ConvexError({
          code: 'not_found',
          detail: `No change #${s.target}.`,
        })
      const l = await hydrate(ctx, doc)
      const view = await viewFor(ctx, repo, p, Date.now(), [l.rec])
      checkLandable(view, l.rec, p, trees[s.target])
      await doLand(ctx, repo, l, a.by)
      return `Landed as ${l.rec.patchSets[l.rec.patchSets.length - 1].sha.slice(0, 7)}.`
    }
    if (s.kind === 'run_pipeline') {
      const r = await startWorkflow(ctx, repo, s.target, p.handle)
      return `Started ${s.target} run #${r.number}.`
    }
    return await callWebhook(ctx, repo, s.target, a.by)
  },
})

/**
 * A `webhook` step: one delivery to the repository's webhook at that URL, so
 * it is signed with its secret and retried like any other.
 */
async function callWebhook(
  ctx: MutationCtx,
  repo: Doc<'repos'>,
  url: string,
  by: ActorRef,
) {
  const hook = (
    await ctx.db
      .query('webhooks')
      .withIndex('by_repoId', (q) => q.eq('repoId', repo._id))
      .take(100)
  ).find((h) => h.url === url)
  if (!hook)
    throw new ConvexError({
      code: 'invalid_state',
      detail: `No webhook for ${url} on ${repo.owner}/${repo.name}.`,
      more: JSON.stringify({
        hint: 'Add it with POST /repos/{owner}/{repo}/webhooks, then land again.',
      }),
    })
  const at = Date.now()
  const event = {
    object: 'event',
    id: newId('event', at),
    sequence: 0,
    type: 'change.landed',
    created_at: new Date(at).toISOString(),
    repo: `${repo.owner}/${repo.name}`,
    repo_id: repo.publicId,
    actor: actorOut(by),
    subject: { object: 'repo', id: repo.publicId, number: null },
    changes: ['landing.step'],
    data: null,
  }
  const id = await enqueue(ctx, hook, JSON.stringify(event), null)
  return `Queued delivery ${id} to ${hook.publicId}.`
}
