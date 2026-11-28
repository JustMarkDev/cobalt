import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import type { Actor } from './actor'

// Everything an organization's audit log can say happened. Kept short and
// stable: an export or a SIEM keys on these.
export type AuditAction =
  | 'organization.created'
  | 'organization.updated'
  | 'member.added'
  | 'member.role_changed'
  | 'member.removed'
  | 'invitation.sent'
  | 'invitation.revoked'
  | 'invitation.accepted'
  | 'team.created'
  | 'team.updated'
  | 'team.deleted'
  | 'team.member_added'
  | 'team.member_removed'
  | 'team.repo_added'
  | 'team.repo_removed'
  | 'repo.created'
  | 'repo.updated'
  | 'repo.deleted'
  | 'repo.policy_changed'
  | 'policy.rule_set'
  | 'policy.rule_removed'
  | 'plan.changed'

type Who = Pick<Actor, 'handle' | 'via'> | { handle: string; via?: null }

export async function audit(
  ctx: MutationCtx,
  org: Doc<'accounts'> | Id<'accounts'> | null | undefined,
  who: Who,
  action: AuditAction,
  target: string,
  detail?: Record<string, unknown>,
) {
  if (!org) return
  if (typeof org !== 'string' && org.kind !== 'organization') return
  const model = who.via?.model
  await ctx.db.insert('auditEvents', {
    organizationId: typeof org === 'string' ? org : org._id,
    at: Date.now(),
    actor: who.handle,
    ...(model ? { via: model } : {}),
    action,
    target,
    ...(detail ? { detail: JSON.stringify(detail) } : {}),
  })
}

// The organization that owns a repository, when the owner is one.
export async function orgOfRepo(
  ctx: Pick<MutationCtx, 'db'>,
  repo: Pick<Doc<'repos'>, 'ownerId'>,
): Promise<Doc<'accounts'> | null> {
  const owner = await ctx.db.get('accounts', repo.ownerId)
  return owner?.kind === 'organization' ? owner : null
}
