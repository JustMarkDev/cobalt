import {
  canMove,
  uploadLifecycle,
  uploadMoveRefusal,
} from '@cobaltforge/api/lifecycles'
import { v } from 'convex/values'
import { newId } from '@cobaltforge/api/ids'
import { query } from '../_generated/server'
import { mutation } from '../lib/functions'
import { system } from '../lib/actor'
import { fail, out } from '../lib/errors'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'

const TTL = 3_600_000
const purpose = v.union(
  v.literal('evidence'),
  v.literal('release'),
  v.literal('transcript'),
)

const rec = (u: Doc<'uploads'>) => ({
  id: u.publicId,
  owner: u.owner,
  filename: u.filename,
  contentType: u.contentType,
  size: u.size,
  purpose: u.purpose,
  state: u.state,
  sha256: u.sha256,
  expires: u.expires,
  created: u.created,
  attachedTo: u.attachedTo,
  attachedRepoId: u.attachedRepoId,
})

const byId = (ctx: QueryCtx, id: string) =>
  ctx.db
    .query('uploads')
    .withIndex('by_publicId', (q) => q.eq('publicId', id))
    .unique()

export const create = mutation({
  args: {
    owner: v.string(),
    filename: v.string(),
    contentType: v.string(),
    size: v.number(),
    purpose,
  },
  returns: v.string(),
  handler: async (ctx, a) => {
    await system(ctx)
    const t = Date.now()
    const id = await ctx.db.insert('uploads', {
      publicId: newId('upload', t),
      owner: a.owner,
      filename: a.filename.replace(/[^\w.\- ]+/g, '_').slice(0, 200),
      contentType: a.contentType,
      size: a.size,
      purpose: a.purpose,
      state: 'pending',
      sha256: null,
      expires: t + TTL,
      created: t,
      attachedTo: null,
      attachedRepoId: null,
    })
    return out(rec((await ctx.db.get('uploads', id))!))
  },
})

export const get = query({
  args: { id: v.string() },
  returns: v.string(),
  handler: async (ctx, { id }) => {
    await system(ctx)
    const u = await byId(ctx, id)
    return out(u ? rec(u) : null)
  },
})

export const save = mutation({
  args: {
    id: v.string(),
    state: v.union(v.literal('pending'), v.literal('uploaded')),
    sha256: v.union(v.null(), v.string()),
    attachedTo: v.union(v.null(), v.string()),
    attachedRepoId: v.union(v.null(), v.string()),
  },
  returns: v.string(),
  handler: async (ctx, { id, ...fields }) => {
    await system(ctx)
    const u = await byId(ctx, id)
    if (!u) return out(null)
    const refusal = uploadMoveRefusal(u, fields)
    if (refusal) fail('invalid_state', refusal)
    await ctx.db.patch('uploads', u._id, fields)
    return out(null)
  },
})

export const receive = mutation({
  args: { id: v.string(), sha256: v.string() },
  returns: v.string(),
  handler: async (ctx, a) => {
    await system(ctx)
    const u = await byId(ctx, a.id)
    if (!u) return out('This upload no longer exists.')
    const refusal =
      u.state === 'uploaded'
        ? 'This upload already has its file.'
        : uploadMoveRefusal(u, { ...u, state: 'uploaded', sha256: a.sha256 })
    if (refusal) return out(refusal)
    await ctx.db.patch('uploads', u._id, {
      state: 'uploaded',
      sha256: a.sha256,
    })
    return out(null)
  },
})

export const unreceive = mutation({
  args: { id: v.string(), sha256: v.string() },
  returns: v.string(),
  handler: async (ctx, a) => {
    await system(ctx)
    const u = await byId(ctx, a.id)
    if (
      u &&
      canMove(uploadLifecycle, u.state, 'pending') &&
      u.sha256 === a.sha256 &&
      !u.attachedTo
    )
      await ctx.db.patch('uploads', u._id, { state: 'pending', sha256: null })
    return out(null)
  },
})

export const remove = mutation({
  args: { id: v.string() },
  returns: v.string(),
  handler: async (ctx, { id }) => {
    await system(ctx)
    const u = await byId(ctx, id)
    if (u) await ctx.db.delete('uploads', u._id)
    return out(null)
  },
})

export const countPending = query({
  args: { owner: v.string(), at: v.number() },
  returns: v.string(),
  handler: async (ctx, a) => {
    await system(ctx)
    const pending = await ctx.db
      .query('uploads')
      .withIndex('by_owner_and_state', (q) =>
        q.eq('owner', a.owner).eq('state', 'pending'),
      )
      .take(1000)
    return out(pending.filter((u) => u.expires > a.at).length)
  },
})

export const dropRepo = mutation({
  args: { repoId: v.string() },
  returns: v.string(),
  handler: async (ctx, { repoId }) => {
    await system(ctx)
    const gone = []
    for (const u of await ctx.db
      .query('uploads')
      .withIndex('by_attachedRepoId', (q) => q.eq('attachedRepoId', repoId))
      .take(5000)) {
      gone.push(u.publicId)
      await ctx.db.delete('uploads', u._id)
    }
    return out(gone)
  },
})

export const sweep = mutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    await system(ctx)
    const t = Date.now()
    for (const u of await ctx.db
      .query('uploads')
      .withIndex('by_state_and_expires', (q) =>
        q.eq('state', 'pending').lte('expires', t),
      )
      .take(500))
      await ctx.db.delete('uploads', u._id)
    const gone = []
    for (const u of await ctx.db
      .query('uploads')
      .withIndex('by_state_and_expires', (q) =>
        q.eq('state', 'uploaded').lte('expires', t - 86_400_000),
      )
      .take(500))
      if (u.attachedTo === null) {
        gone.push(u.publicId)
        await ctx.db.delete('uploads', u._id)
      }
    return out(gone)
  },
})
