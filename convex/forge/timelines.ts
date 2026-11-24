import { v } from 'convex/values'
import { query } from '../_generated/server'
import { actorOf } from '../lib/actor'
import { resolve } from '../lib/access'
import { out } from '../lib/errors'
import { repoUrl, urls } from '../lib/present'
import { issueOf } from '../lib/issues'
import { hydrate, loadChange } from '../lib/changes'
import { changeEntries, timelineEntry } from '@cobaltforge/api/timeline'
import type { TimelineEntry } from '@cobaltforge/api/timeline'
import { presentComment, presentIssueEvidence } from './issues'
import type { ActorRef } from '../lib/events'
import type { QueryCtx } from '../_generated/server'

export const get = query({
  args: {
    owner: v.string(),
    name: v.string(),
    kind: v.union(v.literal('change'), v.literal('issue')),
    ref: v.string(),
    at: v.number(),
  },
  returns: v.string(),
  handler: async (ctx, a) => {
    const p = await actorOf(ctx)
    const repo = await resolve(ctx, a.owner, a.name, p)
    const entries: Array<TimelineEntry> = []
    const entry = (...e: Parameters<typeof timelineEntry>) =>
      entries.push(timelineEntry(...e))
    const states = async (subject: string) => {
      let from: string | null = null
      for (const s of await ctx.db
        .query('stateChanges')
        .withIndex('by_repoId_and_subject_and_at', (q) =>
          q.eq('repoId', repo._id).eq('subject', subject),
        )
        .take(200)) {
        if (s.to === from) continue
        entry(
          'state_change',
          s.eventId,
          s.at,
          s.actor,
          s.via ?? null,
          from ? `${from} to ${s.to}` : `opened as ${s.to}`,
          { object: 'state_change', from, to: s.to },
        )
        from = s.to
      }
      return from
    }
    if (a.kind === 'change') {
      const { rec: c } = await loadChange(ctx, repo, a.ref, p)
      const agents = new Map<string, ActorRef>()
      for (const f of c.findings)
        if (!agents.has(f.by)) agents.set(f.by, await agentOf(ctx, f.by))
      entries.push(
        ...changeEntries(c, {
          repoUrl: repoUrl(repo),
          apiUrl: urls().api,
          findingActor: (by) => agents.get(by) ?? null,
          upload: (e) =>
            e.upload ?? {
              id: e.uploadId,
              contentType: 'application/octet-stream',
              size: 0,
              sha256: '',
            },
        }),
      )
      if ((await states(`change:${c.number}`)) === null)
        entry(
          'state_change',
          `${c.id}:opened`,
          c.created,
          c.author,
          null,
          `opened as ${c.state}`,
          {
            object: 'state_change',
            from: null,
            to: c.state,
          },
        )
    } else {
      const n = Number(a.ref)
      const i = await issueOf(ctx, repo, n)
      for (const x of await ctx.db
        .query('issueComments')
        .withIndex('by_issueId', (q) => q.eq('issueId', i._id))
        .take(1000))
        entry(
          'comment',
          x.publicId,
          x.created,
          x.author,
          null,
          x.body.split('\n')[0],
          presentComment(i, x),
        )
      for (const e of await ctx.db
        .query('issueEvidence')
        .withIndex('by_issueId', (q) => q.eq('issueId', i._id))
        .take(200))
        entry(
          'evidence',
          e.publicId,
          e.created,
          e.by,
          null,
          `${e.kind}: ${e.caption}`,
          presentIssueEvidence(i, e),
        )
      for (const ref of await ctx.db
        .query('issueRefs')
        .withIndex('by_repoId_and_issue', (q) =>
          q.eq('repoId', repo._id).eq('issue', n),
        )
        .take(200)) {
        const doc = await ctx.db.get('changes', ref.changeId)
        if (!doc) continue
        const { rec: c } = await hydrate(ctx, doc)
        entry(
          'reference',
          c.id,
          c.created,
          c.author,
          c.patchSets[0]?.via ?? null,
          `#${c.number} ${ref.closes ? 'fixes' : 'refers to'} this: ${c.title}`,
          {
            object: 'reference',
            change: c.number,
            title: c.title,
            state: c.state,
            closes: ref.closes,
            url: `${urls().api}/repos/${repo.owner}/${repo.name}/changes/${c.number}`,
          },
        )
      }
      if ((await states(`issue:${n}`)) === null)
        entry(
          'state_change',
          `${i.publicId}:opened`,
          i.created,
          i.author,
          null,
          `opened as ${i.state}`,
          {
            object: 'state_change',
            from: null,
            to: i.state,
          },
        )
    }
    return out(
      entries.sort(
        (x, y) => Date.parse(x.created_at) - Date.parse(y.created_at),
      ),
    )
  },
})

async function agentOf(ctx: QueryCtx, handle: string): Promise<ActorRef> {
  const account = await ctx.db
    .query('accounts')
    .withIndex('by_handle', (q) => q.eq('handle', handle))
    .unique()
  if (account) return { id: account.publicId, handle }
  const own = await ctx.db
    .query('actors')
    .withIndex('by_key', (q) => q.eq('key', handle))
    .unique()
  return { id: own?.publicId ?? 'acc_unknown', handle }
}
