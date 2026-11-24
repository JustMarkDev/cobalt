import { GB, planLimits } from '../plans'
import { apiError } from '../problem'
import {
  INBOX_MAX,
  dashboardNeeds,
  needsFrom,
  presentInbox,
  queuedWithoutRunner,
  stepsWaitingOn,
} from '../inbox'
import type { NeedsFacts } from '../inbox'
import type { Principal } from '../auth'
import type { EventRecord } from '../events'
import type { GitCommit } from '../git'
import type { RepoRec, Viewer } from './records'
import { DomainImports } from './imports'
import { statusReport } from './status-report'

const DAY = 86_400_000
const STORAGE_LIMIT = planLimits.free.storageGb * GB
const WEEKS = 26

function buckets(n: number, now: number, times: Iterable<number>) {
  const out = Array.from({ length: n }, () => 0)
  const end = Math.floor(now / DAY)
  for (const t of times) {
    const k = n - 1 - (end - Math.floor(t / DAY))
    if (k >= 0 && k < n) out[k]++
  }
  return out
}

const sum = (xs: Array<number>) => xs.reduce((a, b) => a + b, 0)

export abstract class DomainInsights extends DomainImports {
  readonly downloadTimes = new Map<string, Array<number>>()

  override async downloadAsset(
    owner: string,
    name: string,
    tag: string,
    asset: string,
    p: Viewer,
  ) {
    const out = await super.downloadAsset(owner, name, tag, asset, p)
    const full = this.resolve(owner, name, p)
    const key = `${full.owner}/${full.name}`
    this.downloadTimes.set(key, [
      ...(this.downloadTimes.get(key) ?? []),
      this.now(),
    ])
    return out
  }

  protected override onRepoMoved(from: string, to: string) {
    super.onRepoMoved(from, to)
    const times = this.downloadTimes.get(from)
    if (times) {
      this.downloadTimes.delete(from)
      this.downloadTimes.set(to, times)
    }
  }

  seedDownloads(full: string, times: Array<number>) {
    this.downloadTimes.set(full, times)
  }

  private async history(r: RepoRec, limit: number): Promise<Array<GitCommit>> {
    try {
      return await this.svc.git.commits(`${r.owner}/${r.name}`, limit)
    } catch {
      return []
    }
  }

  private downloadsOf(repos: Array<RepoRec>, now: number) {
    const total = repos.reduce(
      (n, r) =>
        n +
        (r.releases ?? []).reduce(
          (m, x) => m + x.assets.reduce((k, a) => k + a.downloads, 0),
          0,
        ),
      0,
    )
    const times = repos.flatMap(
      (r) => this.downloadTimes.get(`${r.owner}/${r.name}`) ?? [],
    )
    const days = buckets(60, now, times)
    const last = sum(days.slice(30))
    const before = sum(days.slice(0, 30))
    return {
      total,
      daily: days.slice(30),
      change: before ? Math.round(((last - before) / before) * 100) : null,
    }
  }

  async repoInsights(owner: string, name: string, p: Viewer) {
    const r = this.resolve(owner, name, p)
    const now = this.now()
    const commits = await this.history(r, 1000)
    const weeks = Array.from({ length: WEEKS }, () => 0)
    const people = new Set<string>()
    for (const c of commits) {
      const w = Math.floor((now - Date.parse(c.date)) / (7 * DAY))
      if (w >= 0 && w < WEEKS) weeks[WEEKS - 1 - w]++
      people.add(c.author.email.toLowerCase())
    }
    const changes = [...r.changes.values()]
    const issues = [...r.issues.values()]
    const models = new Map<string | null, number>()
    for (const c of changes)
      for (const ps of c.patchSets) {
        const m = ps.via?.model ?? null
        models.set(m, (models.get(m) ?? 0) + 1)
      }
    const byModel = [...models]
      .map(([model, count]) => ({ model, count }))
      .sort(
        (a, b) =>
          b.count - a.count || String(a.model).localeCompare(String(b.model)),
      )
    return {
      object: 'repo_insights' as const,
      repo: `${r.owner}/${r.name}`,
      commits: {
        total: commits.length,
        by_week: weeks,
        by_model: byModel,
      },
      contributors: people.size,
      downloads: this.downloadsOf([r], now),
      stars: { total: r.stars, today: this.presentRepo(r).stars_today },
      issues: {
        open: issues.filter((i) => i.state === 'open').length,
        closed: issues.filter((i) => i.state === 'closed').length,
      },
      changes: {
        open: changes.filter((c) => c.state === 'open' || c.state === 'draft')
          .length,
        landed: changes.filter((c) => c.state === 'landed').length,
        abandoned: changes.filter((c) => c.state === 'abandoned').length,
      },
    }
  }

  async insightsVersion(owner: string, name: string, p: Viewer) {
    const r = this.resolve(owner, name, p)
    const d = this.downloadTimes.get(`${r.owner}/${r.name}`)?.length ?? 0
    return `${r.id}.ins${r.rev}.${r.changeRev}.${r.issueRev}.${d}.${Math.floor(this.now() / DAY)}.${this.accessRevision}`
  }

  protected needsFacts(
    p: Principal,
    owned: Array<RepoRec>,
    all: boolean,
  ): NeedsFacts {
    const me = p.handle
    const full = (r: RepoRec) => `${r.owner}/${r.name}`
    const f: NeedsFacts = {
      mirrors: [],
      mainFailures: [],
      toReview: [],
      assigned: [],
    }
    for (const r of owned) {
      if (!this.canRead(r, p)) continue
      this.settleTimers(r)
      for (const m of this.memExtras.for(full(r)).mirrors)
        if (m.state === 'failing')
          f.mirrors.push({
            repo: full(r),
            host: m.host,
            detail: m.detail ?? null,
            lastSync: m.lastSync,
          })
      const main = (r.pipelines ?? []).find(
        (x) =>
          x.branch === 'main' &&
          x.status !== 'queued' &&
          x.status !== 'running' &&
          x.status !== 'waiting',
      )
      if (main?.status === 'failure')
        f.mainFailures.push({
          repo: full(r),
          number: main.number,
          workflow: main.workflow,
          title: main.title,
          started: main.started,
        })
    }
    for (const r of this.repos.values())
      if (this.canWrite(r, p))
        for (const c of r.changes.values())
          if (
            c.state === 'open' &&
            c.author.handle !== me &&
            !c.reviews.some((x) => x.actor.handle === me && x.carries) &&
            this.seesChange(r, c, p)
          )
            f.toReview.push({
              repo: full(r),
              number: c.number,
              title: c.title,
              author: c.author.handle,
              updated: c.updated,
            })
    for (const r of this.repos.values())
      if (this.canRead(r, p))
        for (const i of r.issues.values())
          if (i.state === 'open' && i.assignees?.some((a) => a.handle === me))
            f.assigned.push({
              repo: full(r),
              number: i.number,
              title: i.title,
              updated: i.updated,
            })
    if (!all) return f
    f.blocked = []
    f.checksFailing = []
    f.waiting = []
    f.noRunner = []
    for (const r of this.repos.values()) {
      if (!this.canRead(r, p)) continue
      for (const c of r.changes.values()) {
        if (c.state !== 'open' || c.author.handle !== me) continue
        const reqs = this.evaluate(r, c)
        if (this.policyState(reqs) === 'blocked')
          f.blocked.push({
            repo: full(r),
            number: c.number,
            title: c.title,
            updated: c.updated,
            blocking: this.unmet(reqs),
          })
        const checks = this.checksFor(c)
        if (checks.state === 'fail')
          f.checksFailing.push({
            repo: full(r),
            number: c.number,
            title: c.title,
            updated: c.updated,
            failed: checks.failed,
          })
      }
      this.settleTimers(r)
      const runners = [...this.runners.values()]
      for (const run of r.pipelines ?? []) {
        if (run.status === 'waiting' || run.status === 'running')
          f.waiting.push(...stepsWaitingOn(full(r), run, me))
        if (
          (run.status === 'queued' || run.status === 'running') &&
          run.actor === me
        ) {
          const stuck = queuedWithoutRunner(r, run, runners)
          if (stuck) f.noRunner.push(stuck)
        }
      }
    }
    f.mentions = (this.inboxes.get(me) ?? [])
      .filter(
        (x) =>
          x.kind === 'mention' &&
          x.unread &&
          (!x.repo ||
            !x.repo.includes('/') ||
            (this.repos.get(x.repo) &&
              this.canRead(this.repos.get(x.repo)!, p))),
      )
      .map((x) => ({
        id: x.id,
        title: x.title,
        repo: x.repo,
        path: x.path,
        created: x.created,
      }))
    return f
  }

  async inbox(p: Viewer, limit: number) {
    if (!p) throw apiError('unauthenticated', 'Sign in to see your inbox.')
    const owners = new Set(
      [...this.accounts.values()]
        .filter((a) => this.isMember(a.handle, p.handle))
        .map((a) => a.handle),
    )
    const owned = [...this.repos.values()].filter((r) => owners.has(r.owner))
    return presentInbox(
      needsFrom(this.needsFacts(p, owned, true)),
      Math.min(limit, INBOX_MAX),
    )
  }

  async dashboard(p: Viewer, as?: string) {
    if (!p) throw apiError('unauthenticated', 'Sign in to see your dashboard.')
    const now = this.now()
    const me = p.handle
    const account = as ?? p.actingAs
    if (account !== me && !this.isMember(account, me))
      throw apiError('not_found', `No account ${account}.`)
    const owned = [...this.repos.values()].filter((r) => r.owner === account)
    const full = (r: RepoRec) => `${r.owner}/${r.name}`
    const path = (r: RepoRec, tail = '') => `/${r.owner}/${r.name}${tail}`
    const ago = (t: number) => new Date(t).toISOString()

    const needs = dashboardNeeds(needsFrom(this.needsFacts(p, owned, false)))

    const progress: Array<{
      kind: 'agent' | 'change'
      title: string
      repo: string
      status: string
      detail: string
      path: string
    }> = []
    for (const r of owned) {
      for (const c of r.changes.values())
        if (
          (c.state === 'open' || c.state === 'draft') &&
          c.patchSets.at(-1)?.via?.model
        )
          progress.push({
            kind: 'agent',
            title: c.title,
            repo: `${full(r)} · #${c.number}`,
            status: c.state === 'draft' ? 'Draft' : 'Waiting on review',
            detail: `${c.author.handle} via ${c.patchSets.at(-1)!.via!.tool ?? 'a tool'} · ${c.patchSets.at(-1)!.via!.model}, patch set ${c.patchSets.length}`,
            path: path(r, `/changes?n=${c.number}`),
          })
      for (const x of r.pipelines ?? [])
        if (x.status === 'running' || x.status === 'queued')
          progress.push({
            kind: 'change',
            title: x.title,
            repo: `${full(r)} · ${x.workflow} #${x.number}`,
            status: x.status === 'running' ? 'Running' : 'Queued',
            detail: `${x.branch} by ${x.actor}`,
            path: path(r, `/pipelines?n=${x.number}`),
          })
    }

    const activity = owned
      .flatMap((r) => this.events.repoEvents(r.id).slice(-30))
      .map((x) => JSON.parse(x.json) as EventRecord)
      .filter((e) => e.actor.handle !== me)
      .sort((a, b) => b.sequence - a.sequence)
      .slice(0, 30)
      .map((e) => ({
        who: e.actor.handle,
        via: e.via ?? null,
        type: e.type,
        repo: e.repo,
        subject: e.subject.number,
        at: e.created_at,
      }))

    const mirrors = new Map<
      string,
      { host: string; state: 'synced' | 'stopped'; repos: number }
    >()
    for (const r of owned)
      for (const m of this.memExtras.for(full(r)).mirrors) {
        const have = mirrors.get(m.host) ?? {
          host: m.host,
          state: 'synced' as const,
          repos: 0,
        }
        mirrors.set(m.host, {
          host: m.host,
          state: m.state === 'failing' ? 'stopped' : have.state,
          repos: have.repos + 1,
        })
      }

    const commitTimes: Array<number> = []
    for (const r of owned)
      for (const c of await this.history(r, 300))
        if (c.author.email.toLowerCase() === `${me}@users.cobaltforge.dev`)
          commitTimes.push(Date.parse(c.date))
    const reviewTimes: Array<number> = []
    const openedTimes: Array<number> = []
    for (const r of this.repos.values())
      for (const c of r.changes.values()) {
        for (const x of c.reviews)
          if (x.actor.handle === me) reviewTimes.push(x.created)
        if (c.author.handle === me) openedTimes.push(c.created)
      }
    const daily = [commitTimes, reviewTimes, openedTimes].map((t) =>
      buckets(56, now, t),
    )
    const total = (k: number) => sum(daily[k].slice(28))
    const before = sum(daily.flatMap((d) => d.slice(0, 28)))
    const all = total(0) + total(1) + total(2)

    return {
      object: 'dashboard' as const,
      account,
      empty: owned.length === 0,
      needs_you: needs.slice(0, 20),
      in_progress: progress.slice(0, 20),
      activity,
      repos: owned
        .sort((a, b) => b.updated - a.updated)
        .map((r) => {
          const main = (r.pipelines ?? []).find(
            (x) =>
              x.branch === 'main' &&
              x.status !== 'queued' &&
              x.status !== 'running' &&
              x.status !== 'waiting',
          )
          const shown = this.presentRepo(r)
          return {
            repo: full(r),
            checks:
              main?.status === 'failure'
                ? ('failing' as const)
                : ('passing' as const),
            open_changes: shown.open_changes,
            open_issues: shown.open_issues,
            updated_at: ago(r.updated),
          }
        }),
      mirrors: [...mirrors.values()],
      storage: {
        used_bytes: owned.reduce(
          (n, r) =>
            n +
            (r.releases ?? []).reduce(
              (m, x) => m + x.assets.reduce((k, a) => k + a.size, 0),
              0,
            ),
          0,
        ),
        limit_bytes: STORAGE_LIMIT,
        unlimited: false,
      },
      imported: owned.filter((r) => r.upstream).length,
      downloads: this.downloadsOf(owned, now),
      contributions: {
        daily: daily[0]
          .slice(28)
          .map((n, i) => n + daily[1][28 + i] + daily[2][28 + i]),
        total: all,
        change: before ? Math.round(((all - before) / before) * 100) : null,
        commits: total(0),
        reviews: total(1),
        changes: total(2),
      },
      stars: {
        total: owned.reduce((n, r) => n + r.stars, 0),
        today: owned.reduce((n, r) => n + this.presentRepo(r).stars_today, 0),
      },
    }
  }

  async status() {
    const mirrors: Array<{
      repo: string
      host: string
      state: string
      paused?: boolean
    }> = []
    let waiting = 0
    let oldest = Infinity
    let changes = 0
    let issues = 0
    for (const r of this.repos.values()) {
      const repo = `${r.owner}/${r.name}`
      for (const m of this.memExtras.for(repo).mirrors)
        mirrors.push({ repo, host: m.host, state: m.state, paused: m.paused })
      for (const x of r.pipelines ?? [])
        for (const j of x.jobs)
          if (j.status === 'queued') {
            waiting++
            oldest = Math.min(oldest, x.started)
          }
      changes += r.changes.size
      issues += r.issues.size
    }
    return statusReport({
      now: this.now(),
      health: this.svc.health,
      mirrors,
      waiting,
      oldest: waiting ? oldest : null,
      counts: {
        accounts: this.accounts.size,
        repositories: this.repos.size,
        changes,
        issues,
      },
    })
  }
}
