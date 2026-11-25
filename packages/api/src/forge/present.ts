// The public shape of provider links, the same from both stores.
import { ACCESS_WARNING, LFS_WARNING, labelOf } from './labels'
import type { z } from 'zod'
import type * as S from '../schemas'
import type {
  AuditRec,
  ConnectionRec,
  JobItem,
  JobRec,
  RemoteRec,
} from './store'
import type { ForgeProvider, RemoteRepo } from './types'

const iso = (t: number) => new Date(t).toISOString()

export function presentConnection(
  c: ConnectionRec,
  repos: number,
): z.infer<typeof S.ProviderConnection> {
  return {
    object: 'provider_connection',
    provider: c.provider,
    instance: c.instance,
    login: c.login,
    state: c.state,
    problem: c.problem,
    scopes: c.scopes,
    repos,
    connected_at: iso(c.created),
  }
}

export function presentProviderRepo(
  r: RemoteRepo,
  linked: string | null,
): z.infer<typeof S.ProviderRepo> {
  return {
    object: 'provider_repo',
    provider: r.provider,
    slug: r.slug,
    private: r.private,
    archived: r.archived,
    fork: r.fork,
    default_branch: r.defaultBranch,
    description: r.description,
    size_bytes: r.sizeBytes,
    can_push: r.canPush,
    linked,
  }
}

export function presentJob(j: {
  job: JobRec
  items: Array<JobItem>
}): z.infer<typeof S.ImportJob> {
  return {
    object: 'import_job',
    id: j.job.id,
    provider: j.job.provider,
    owner: j.job.owner,
    state: j.job.state,
    total: j.job.total,
    done: j.job.done,
    failed: j.job.failed,
    items: j.items.map((i) => ({
      slug: i.slug,
      state: i.state,
      repo: i.repo,
      error: i.error,
      attempts: i.attempts,
    })),
    created_at: iso(j.job.created),
    updated_at: iso(j.job.updated),
  }
}

/** What someone who can write to a linked repository should know about it. */
export function warningsOf(
  r: RemoteRec,
  forge: ForgeProvider | undefined,
): Array<string> {
  const out = [ACCESS_WARNING(labelOf(r.provider), r.fullName)]
  if (r.lfs && forge && !forge.capabilities.lfs)
    out.push(LFS_WARNING(labelOf(r.provider)))
  if (r.problem) out.push(r.problem)
  return out
}

export const providerUrl = (r: {
  provider: string
  instance: string
  fullName: string
}) => `https://${r.instance}/${r.fullName}`

export function presentLink(
  r: RemoteRec,
  o: {
    forge: ForgeProvider | undefined
    connection: ConnectionRec | null
    adoptable: boolean
  },
): z.infer<typeof S.ProviderLink> {
  return {
    object: 'provider_link',
    repo: r.repo,
    provider: r.provider,
    slug: r.fullName,
    url: providerUrl(r),
    state: r.state,
    problem: r.problem,
    warnings: warningsOf(r, o.forge),
    lfs: r.lfs,
    connection: o.connection
      ? {
          handle: o.connection.handle,
          login: o.connection.login,
          state: o.connection.state,
        }
      : null,
    adoptable: o.adoptable,
    linked_by: r.by,
    last_sync_at: r.lastSync === null ? null : iso(r.lastSync),
    last_pull_at: r.lastPull ? iso(r.lastPull) : null,
    items_imported_at: r.importedAt === null ? null : iso(r.importedAt),
  }
}

export function presentAudit(a: AuditRec): z.infer<typeof S.ProviderAudit> {
  return {
    object: 'provider_audit',
    provider: a.provider,
    action: a.action,
    repo: a.repo,
    detail: a.detail,
    at: iso(a.at),
  }
}
