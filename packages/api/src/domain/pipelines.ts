import { newId } from '../ids'
import { apiError } from '../problem'
import {
  WAIT_DEFAULT_MS,
  WAIT_MAX_MS,
  canMove,
  cancelPipeline,
  expireWait,
  jobWait,
  pipelineLifecycle,
  reportStep,
  requeueJob,
  resumeStep,
  settlePipeline,
  waitStep,
} from '../lifecycles'
import { runnerScopes } from '../auth'
import {
  LEASE_MS,
  MAX_CONCURRENCY,
  MAX_LABELS,
  MAX_RUNNERS,
  holds,
  labelShape,
  labelsMatch,
  mayServe,
  normalizeLabels,
  runnerStatus,
  waitingForLabels,
} from '../runners'
import { runsOnOf } from '../workflow'
import { applyRunsOn } from '../runs-on'
import type { PipelineWait } from '../lifecycles'
import type { CursorPosition } from '../cursor'
import type {
  ResumeBody,
  RunnerBody,
  RunnerReportBody,
  RunnerWaitBody,
  WaitBody,
} from './port'
import type {
  PipelineRunRec,
  PipelineStatus,
  RepoRec,
  RunnerRec,
  Viewer,
} from './records'
import type { Principal } from '../auth'
import { DomainReleases } from './releases'

type Job = PipelineRunRec['jobs'][number]
type Line = {
  text: string
  level?: Job['steps'][number]['lines'][number]['level']
}

const iso = (t: number) => new Date(t).toISOString()
const RUNNER_TTL_MS = 365 * 86_400_000

/**
 * Pipeline runs: a workflow run on a runner, its jobs, their steps and the log
 * each step wrote. Starting a run queues its jobs; a runner claims the oldest
 * queued job it may take, reads the workflow file at the run's commit, and
 * reports each step's status and log lines back, which finishes the job and
 * then the run. A step may wait on a person or an outside agent, and resumes
 * with how it ended.
 *
 * Runners are registered here too: an identity, labels, the repositories it
 * may serve and a token it alone holds. A job goes to a runner whose labels
 * cover its `runs-on`; a runner that stops answering loses its job back to
 * the queue when its lease runs out.
 */
export abstract class DomainPipelines extends DomainReleases {
  readonly runners = new Map<string, RunnerRec>()

  seedPipelineRun(repo: RepoRec, r: PipelineRunRec) {
    repo.pipelines = [...(repo.pipelines ?? []), r].sort(
      (a, b) => b.started - a.started,
    )
  }

  private runOf(repo: RepoRec, n: number) {
    const r = repo.pipelines?.find((x) => x.number === n)
    if (!r)
      throw apiError(
        'not_found',
        `No pipeline run ${n} in ${repo.owner}/${repo.name}.`,
      )
    return r
  }

  private runnersOf(account: string) {
    return [...this.runners.values()].filter(
      (r) => r.account.toLowerCase() === account.toLowerCase(),
    )
  }

  protected presentPipelineRun(
    repo: RepoRec,
    r: PipelineRunRec,
    detail: boolean,
  ) {
    const base = `${this.repoUrl(repo)}/pipelines/${r.number}`
    const runners = detail ? this.runnersOf(repo.owner) : []
    const presentWait = (w: PipelineWait | null | undefined) =>
      w
        ? {
            kind: w.kind,
            reason: w.reason,
            target: w.target,
            expires_at: iso(w.expires),
          }
        : null
    return {
      object: 'pipeline_run' as const,
      id: r.id,
      number: r.number,
      url: base,
      html_url: `${this.urls.html}/${repo.owner}/${repo.name}/pipelines?n=${r.number}`,
      workflow: r.workflow,
      file: r.file,
      title: r.title,
      branch: r.branch,
      sha: r.sha,
      status: r.status,
      trigger: r.trigger,
      actor: r.actor,
      started_at: iso(r.started),
      finished_at: r.finished === null ? null : iso(r.finished),
      duration_ms: r.finished === null ? null : r.finished - r.started,
      jobs: detail
        ? r.jobs.map((j, ji) => ({
            name: j.name,
            runner: j.runner,
            status: j.status,
            duration_ms: j.duration,
            runs_on: [...(j.runsOn ?? [])],
            runner_id: j.runnerId ?? null,
            lease_expires_at: j.lease ? iso(j.lease) : null,
            waiting_for_labels:
              j.status === 'queued'
                ? waitingForLabels(
                    j.runsOn ?? [],
                    runners,
                    repo.owner,
                    repo.name,
                  )
                : null,
            wait: presentWait(jobWait(j)),
            steps: j.steps.map((s, si) => ({
              name: s.name,
              status: s.status,
              duration_ms: s.duration,
              lines: s.lines.length,
              log_url: `${base}/jobs/${ji + 1}/steps/${si + 1}/log`,
              wait: presentWait(s.wait),
            })),
          }))
        : null,
      runs_on_pending: !!r.runsOnPending,
      annotations: r.annotations,
      version: r.version,
    }
  }

  /** Runs a trigger started whose labels are not read yet. */
  async pendingRunsOn() {
    const out: Array<{
      owner: string
      name: string
      number: number
      file: string
      sha: string
    }> = []
    for (const repo of this.repos.values())
      for (const r of repo.pipelines ?? [])
        if (r.runsOnPending)
          out.push({
            owner: repo.owner,
            name: repo.name,
            number: r.number,
            file: r.file,
            sha: r.sha,
          })
    return out
  }

  /** The labels a run's workflow file says, now read; null when it could not be. */
  async setRunsOn(
    owner: string,
    name: string,
    n: number,
    read: {
      jobs: Record<string, Array<string>>
      warnings: Array<string>
    } | null,
  ) {
    const repo =
      this.repos.get(`${owner}/${name}`) ??
      this.byLower(`${owner}/${name}`.toLowerCase())
    const r = repo?.pipelines?.find((x) => x.number === n)
    if (!r?.runsOnPending) return
    applyRunsOn(r, read)
    r.version++
  }

  /**
   * Waits that ran out fail their run; jobs whose runner stopped answering
   * go back to the queue. Convex does both on a schedule; here they are
   * settled whenever runs are looked at.
   */
  protected settleTimers(repo: RepoRec) {
    const now = this.now()
    for (const r of repo.pipelines ?? []) {
      if (r.status !== 'running' && r.status !== 'waiting') continue
      for (const [ji, j] of r.jobs.entries()) {
        for (const [si, s] of j.steps.entries())
          if (s.status === 'waiting' && s.wait && s.wait.expires <= now) {
            const why = s.wait.reason
            if (expireWait(r, ji + 1, si + 1, s.wait.expires, now)) {
              r.annotations.push({
                level: 'error',
                text: `Nobody resumed ${s.name} before its wait ran out: ${why}`,
                job: j.name,
                step: s.name,
              })
              r.version++
            }
          }
        if (j.status === 'running' && j.lease && j.lease <= now) {
          const who = j.runner
          if (requeueJob(r, ji + 1)) {
            j.runner = ''
            j.runnerId = null
            j.lease = null
            r.annotations.push({
              level: 'warn',
              text: `Runner ${who} stopped answering, so the job went back to the queue.`,
              job: j.name,
              step: '',
            })
            r.version++
          }
        }
      }
    }
  }

  /** Settle every repository's timers. A runner claim does this first. */
  sweepPipelineTimers() {
    for (const repo of this.repos.values()) this.settleTimers(repo)
  }

  async listPipelineRuns(
    owner: string,
    name: string,
    p: Viewer,
    q: {
      status?: PipelineStatus
      workflow?: string
      after: CursorPosition | null
      limit: number
    },
  ) {
    const repo = this.resolve(owner, name, p)
    this.settleTimers(repo)
    const all = (repo.pipelines ?? []).filter(
      (r) =>
        (!q.status || r.status === q.status) &&
        (!q.workflow || r.workflow === q.workflow),
    )
    let start = 0
    if (q.after) {
      const k = all.findIndex((r) => r.id === q.after!.id)
      start = k >= 0 ? k + 1 : all.length
    }
    const items = all.slice(start, start + q.limit)
    const last = items.at(-1)
    return {
      items: items.map((r) => this.presentPipelineRun(repo, r, false)),
      next:
        start + q.limit < all.length && last
          ? { key: start + q.limit, id: last.id }
          : null,
    }
  }

  async pipelinesVersion(owner: string, name: string, p: Viewer) {
    const repo = this.resolve(owner, name, p)
    this.settleTimers(repo)
    const v = (repo.pipelines ?? []).reduce((n, r) => n + r.version, 0)
    return `${repo.id}.p${repo.pipelines?.length ?? 0}.${v}.${this.runnerRev}.${this.accessRevision}`
  }

  /** Bumped by every runner write, so a run's "waiting for a runner" is not cached past it. */
  protected runnerRev = 0

  async getPipelineRun(owner: string, name: string, n: number, p: Viewer) {
    const repo = this.resolve(owner, name, p)
    this.settleTimers(repo)
    return this.presentPipelineRun(repo, this.runOf(repo, n), true)
  }

  async getPipelineLog(
    owner: string,
    name: string,
    n: number,
    job: number,
    step: number,
    p: Viewer,
  ) {
    const repo = this.resolve(owner, name, p)
    const r = this.runOf(repo, n)
    const j = r.jobs[job - 1] as (typeof r.jobs)[number] | undefined
    const s = j?.steps[step - 1]
    if (!j || !s)
      throw apiError('not_found', `Run ${n} has no job ${job} step ${step}.`)
    return {
      object: 'pipeline_log' as const,
      run: r.number,
      job: j.name,
      step: s.name,
      status: s.status,
      lines: s.lines.map((l) => ({ text: l.t, level: l.level })),
    }
  }

  /** Run a workflow again on the same commit. It is queued for a runner, asking for the same labels. */
  async rerunPipeline(
    owner: string,
    name: string,
    n: number,
    p: Viewer,
    dry: boolean,
  ) {
    const repo = this.resolve(owner, name, p, 'write')
    const from = this.runOf(repo, n)
    const r = this.queuedFrom(repo, from, p!.handle)
    r.branch = from.branch
    r.sha = from.sha
    r.title = from.title
    if (!dry) this.seedPipelineRun(repo, r)
    return this.presentPipelineRun(repo, r, true)
  }

  /** Labels by job from the workflow file at `ref`, when the file is there. */
  protected async readRunsOn(repo: RepoRec, file: string, ref: string) {
    let bytes: Uint8Array | null = null
    try {
      bytes = await this.svc.git.blob(`${repo.owner}/${repo.name}`, file, ref)
    } catch {
      bytes = null
    }
    return bytes ? runsOnOf(new TextDecoder().decode(bytes)) : null
  }

  /** Start a workflow on the newest commit of a branch, from its last run's jobs. */
  async startPipeline(
    owner: string,
    name: string,
    p: Viewer,
    body: { workflow: string; branch?: string },
    dry: boolean,
  ) {
    const repo = this.resolve(owner, name, p, 'write')
    const last = (repo.pipelines ?? []).find(
      (r) => r.workflow === body.workflow,
    )
    if (!last)
      throw apiError(
        'not_found',
        `No workflow ${body.workflow} in ${repo.owner}/${repo.name}.`,
        { hint: 'GET the pipelines list to see which workflows have run.' },
      )
    const branch = body.branch ?? repo.defaultBranch
    let sha = last.sha
    try {
      sha =
        (await this.svc.git.commits(`${repo.owner}/${repo.name}`, 1))[0]?.sha ??
        sha
    } catch {
      // No history in the store: start it on the commit it last ran on.
    }
    const r = this.queuedFrom(repo, last, p!.handle)
    r.branch = branch
    r.sha = sha
    r.title = `${body.workflow} on ${branch}`
    const read = await this.readRunsOn(repo, r.file, branch)
    if (read) {
      for (const j of r.jobs) j.runsOn = read.jobs.get(j.name) ?? []
      for (const w of read.warnings)
        r.annotations.push({ level: 'warn', text: w, job: '', step: '' })
    }
    if (!dry) this.seedPipelineRun(repo, r)
    return this.presentPipelineRun(repo, r, true)
  }

  /**
   * A run an event started (a trigger): no person asked, so no principal.
   * It takes its labels from the workflow's last run, and says they may be
   * stale. Throws `not_found` when the workflow never ran.
   */
  startPipelineForEvent(
    repo: RepoRec,
    workflow: string,
    at: { branch: string; sha: string; actor: string },
  ) {
    const last = (repo.pipelines ?? []).find((r) => r.workflow === workflow)
    if (!last)
      throw apiError(
        'not_found',
        `No workflow ${workflow} in ${repo.owner}/${repo.name}: it has never run, so there are no jobs to start.`,
      )
    const r = this.queuedFrom(repo, last, at.actor)
    r.trigger = 'event'
    r.branch = at.branch
    r.sha = at.sha
    r.title = `${workflow} on ${at.branch}`
    // Its labels are read from the workflow file at this commit before any
    // runner may take it (`settleRunsOn`); until then the last run's stand in.
    r.runsOnPending = true
    r.runsOnFrom = last.number
    this.seedPipelineRun(repo, r)
    return r
  }

  private queuedFrom(repo: RepoRec, from: PipelineRunRec, actor: string) {
    const at = this.now()
    const number =
      Math.max(0, ...(repo.pipelines ?? []).map((r) => r.number)) + 1
    const r: PipelineRunRec = {
      ...from,
      id: newId('pipeline', at),
      number,
      status: 'queued',
      trigger: 'manual',
      actor,
      started: at,
      finished: null,
      annotations: [],
      jobs: from.jobs.map((j) => ({
        ...j,
        status: 'queued',
        runner: '',
        runnerId: null,
        lease: null,
        runsOn: [...(j.runsOn ?? [])],
        duration: 0,
        steps: j.steps.map((s) => ({
          ...s,
          status: 'queued',
          duration: 0,
          lines: [],
          wait: null,
        })),
      })),
      version: 1,
    }
    return r
  }

  private claimed(repo: RepoRec, r: PipelineRunRec, ji: number) {
    const j = r.jobs[ji]
    return {
      object: 'pipeline_job' as const,
      run: r.number,
      job: ji + 1,
      name: j.name,
      workflow: r.workflow,
      file: r.file,
      branch: r.branch,
      sha: r.sha,
      steps: j.steps.map((s, si) => ({ number: si + 1, name: s.name })),
      url: `${this.repoUrl(repo)}/pipelines/${r.number}/jobs/${ji + 1}`,
      runs_on: [...(j.runsOn ?? [])],
      runner_id: j.runnerId ?? null,
      lease_expires_at: j.lease ? iso(j.lease) : null,
    }
  }

  /**
   * A runner asks for work by name: the oldest queued job in the repository
   * that asks for no labels, now running on it. Null when there is nothing to
   * do. A job with `runs-on` waits for a registered runner with those labels.
   */
  async claimPipelineJob(
    owner: string,
    name: string,
    p: Viewer,
    body: { runner: string },
  ) {
    const repo = this.resolve(owner, name, p, 'write')
    this.settleTimers(repo)
    const queued = [...(repo.pipelines ?? [])]
      .filter(
        (r) =>
          (r.status === 'queued' || r.status === 'running') && !r.runsOnPending,
      )
      .sort((a, b) => a.started - b.started)
    for (const r of queued) {
      const ji = r.jobs.findIndex(
        (j) => j.status === 'queued' && !j.runsOn?.length,
      )
      if (ji < 0) continue
      const j = r.jobs[ji]
      j.status = 'running'
      j.runner = body.runner
      if (r.status === 'queued') r.status = 'running'
      r.version++
      return this.claimed(repo, r, ji)
    }
    return null
  }

  /** The report itself, once the caller may make it. */
  private applyReport(
    repo: RepoRec,
    r: PipelineRunRec,
    job: number,
    step: number,
    body: {
      status: 'running' | 'success' | 'failure' | 'skipped'
      lines?: Array<Line>
      duration_ms?: number
    },
  ) {
    const j = r.jobs.at(job - 1)
    const s = j?.steps.at(step - 1)
    if (!j || !s || job < 1 || step < 1)
      throw apiError(
        'not_found',
        `Run ${r.number} has no job ${job} step ${step}.`,
      )
    const moved = reportStep(r, job, step, body.status)
    if ('refusal' in moved) throw apiError('invalid_state', moved.refusal)
    // The same report again (a runner's retry) changes nothing.
    if (moved.repeated) return this.presentPipelineRun(repo, r, true)
    if (body.duration_ms !== undefined) s.duration = body.duration_ms
    for (const l of body.lines ?? [])
      s.lines.push({ t: l.text, level: l.level ?? null })
    if (s.lines.length > 5000) s.lines.splice(0, s.lines.length - 5000)
    if (body.status === 'failure') {
      const last = [...(body.lines ?? [])]
        .reverse()
        .find((l) => l.level === 'error')
      r.annotations.push({
        level: 'error',
        text: last?.text ?? `${s.name} failed`,
        job: j.name,
        step: s.name,
      })
    }
    // A report is a sign of life: the lease runs from now.
    if (j.runnerId && j.status === 'running') j.lease = this.now() + LEASE_MS
    if (j.runnerId && j.status !== 'running') j.lease = null
    settlePipeline(r, this.now())
    if (pipelineDoneJob(j)) j.lease = null
    r.version++
    return this.presentPipelineRun(repo, r, true)
  }

  /** A runner says how a step went, with the lines it wrote. */
  async reportPipelineStep(
    owner: string,
    name: string,
    n: number,
    job: number,
    step: number,
    p: Viewer,
    body: {
      status: 'running' | 'success' | 'failure' | 'skipped'
      lines?: Array<Line>
      duration_ms?: number
    },
  ) {
    const repo = this.resolve(owner, name, p, 'write')
    this.settleTimers(repo)
    return this.applyReport(repo, this.runOf(repo, n), job, step, body)
  }

  async cancelPipeline(
    owner: string,
    name: string,
    n: number,
    p: Viewer,
    dry: boolean,
  ) {
    const repo = this.resolve(owner, name, p, 'write')
    this.settleTimers(repo)
    const r = this.runOf(repo, n)
    if (!canMove(pipelineLifecycle, r.status, 'canceled'))
      throw apiError('invalid_state', `Run ${n} has already finished.`)
    if (dry)
      return this.presentPipelineRun(repo, { ...r, status: 'canceled' }, true)
    cancelPipeline(r, this.now())
    for (const j of r.jobs) j.lease = null
    r.version++
    return this.presentPipelineRun(repo, r, true)
  }

  // ---- waiting ---------------------------------------------------------------

  /** When a wait ends: `expires_at` if given, else in 7 days; never past 30. */
  protected waitUntil(body: WaitBody) {
    const now = this.now()
    if (body.expires_at === undefined) return now + WAIT_DEFAULT_MS
    const t = Date.parse(body.expires_at)
    if (!Number.isFinite(t) || t <= now || t > now + WAIT_MAX_MS)
      throw apiError(
        'invalid_request',
        'A wait ends in the future, at most 30 days from now.',
        {
          errors: [
            {
              pointer: '/body/expires_at',
              code: 'out_of_range',
              message: 'An RFC 3339 time after now and within 30 days.',
            },
          ],
        },
      )
    return t
  }

  async waitPipelineStep(
    owner: string,
    name: string,
    n: number,
    job: number,
    step: number,
    p: Viewer,
    body: WaitBody,
    dry: boolean,
  ) {
    const repo = this.resolve(owner, name, p, 'write')
    this.settleTimers(repo)
    const live = this.runOf(repo, n)
    const r: PipelineRunRec = dry ? structuredClone(live) : live
    this.applyWait(repo, r, job, step, body, p!.handle, dry)
    return this.presentPipelineRun(repo, r, true)
  }

  /** Pauses a running step and tells whom it waits on. Shared with a runner's own wait. */
  private applyWait(
    repo: RepoRec,
    r: PipelineRunRec,
    job: number,
    step: number,
    body: WaitBody,
    by: string,
    dry: boolean,
  ) {
    const wait: PipelineWait = {
      kind: body.kind,
      reason: body.reason,
      target: body.target ?? null,
      expires: this.waitUntil(body),
    }
    const refused = waitStep(r, job, step, wait)
    if (refused) throw apiError('invalid_state', refused.refusal)
    r.jobs[job - 1].lease = null
    if (!dry) {
      r.version++
      this.toldOfWait(repo, r, job, wait, by)
    }
  }

  /** The runner pauses a step of a job it holds. */
  async runnerWait(p: Viewer, body: RunnerWaitBody) {
    const runner = this.runnerOf(p)
    const [o, n] = body.repo.split('/')
    const repo = this.resolve(o, n, p)
    if (!mayServe(runner, repo.owner, repo.name))
      throw apiError('not_found', `No repository ${body.repo}.`)
    this.settleTimers(repo)
    const r = this.runOf(repo, body.run)
    const j = r.jobs.at(body.job - 1)
    if (!j || body.job < 1)
      throw apiError('not_found', `Run ${body.run} has no job ${body.job}.`)
    if (j.runnerId !== runner.id)
      throw apiError(
        'forbidden',
        `Job ${body.job} of run ${body.run} is not this runner's.`,
        {
          hint: 'A runner pauses only the jobs it claimed. Its lease may have run out.',
        },
      )
    runner.lastSeen = this.now()
    this.applyWait(repo, r, body.job, body.step, body, p!.handle, false)
    return this.presentPipelineRun(repo, r, true)
  }

  /** Someone the step waits on is told: the target, or whoever started the run. */
  private toldOfWait(
    repo: RepoRec,
    r: PipelineRunRec,
    job: number,
    wait: PipelineWait,
    by: string,
  ) {
    if (wait.kind === 'agent') return
    const who = wait.target ?? r.actor
    if (!wait.target && who === by) return
    const full = `${repo.owner}/${repo.name}`
    this.notify(who, {
      kind: 'handoff',
      title: `${r.workflow} #${r.number} waits on you: ${wait.reason}`,
      repo: full,
      path: `/${full}/pipelines?n=${r.number}&job=${job}`,
    })
  }

  async resumePipelineStep(
    owner: string,
    name: string,
    n: number,
    job: number,
    step: number,
    p: Viewer,
    body: ResumeBody,
    dry: boolean,
  ) {
    const repo = this.resolve(owner, name, p, 'write')
    this.settleTimers(repo)
    const live = this.runOf(repo, n)
    const r: PipelineRunRec = dry ? structuredClone(live) : live
    const s = r.jobs.at(job - 1)?.steps.at(step - 1)
    const refused = resumeStep(r, job, step, body.status, this.now())
    if (refused) throw apiError('invalid_state', refused.refusal)
    const j = r.jobs[job - 1]
    if (s) {
      for (const l of body.lines ?? [])
        s.lines.push({ t: l.text, level: l.level ?? null })
      if (body.summary)
        s.lines.push({
          t: `Resumed by ${p!.handle}: ${body.summary}`,
          level: body.status === 'failure' ? 'error' : 'ok',
        })
      if (s.lines.length > 5000) s.lines.splice(0, s.lines.length - 5000)
      if (body.status === 'failure')
        r.annotations.push({
          level: 'error',
          text: body.summary ?? `${s.name} failed while it waited`,
          job: j.name,
          step: s.name,
        })
    }
    // The runner that holds the job carries on from here.
    if (j.runnerId && j.status === 'running') j.lease = this.now() + LEASE_MS
    if (!dry) r.version++
    return this.presentPipelineRun(repo, r, true)
  }

  // ---- runners ---------------------------------------------------------------

  /** Whether `p` may manage runners of `account`: their own, or an organization they own or administer. */
  private manages(account: string, p: Principal) {
    const acct = this.accounts.get(account)
    if (!acct) return false
    if (acct.kind === 'person') return account === p.handle
    const role = acct.members.get(p.handle)
    return role === 'owner' || role === 'admin'
  }

  private runnerFor(p: Viewer, id: string, manage = true) {
    const r = this.runners.get(id)
    if (!p || !r) throw apiError('not_found', `No runner ${id}.`)
    const acct = this.accounts.get(r.account)
    const member = r.account === p.handle || !!acct?.members.has(p.handle)
    if (!member || p.runnerId) throw apiError('not_found', `No runner ${id}.`)
    if (manage && !this.manages(r.account, p))
      throw apiError(
        'forbidden',
        `Only an owner or admin of ${r.account} can change its runners.`,
      )
    return r
  }

  private heldBy(runnerId: string) {
    const out: Array<{ repo: RepoRec; r: PipelineRunRec; ji: number }> = []
    for (const repo of this.repos.values())
      for (const r of repo.pipelines ?? []) {
        if (r.status !== 'running' && r.status !== 'waiting') continue
        for (const [ji, j] of r.jobs.entries())
          if (j.runnerId === runnerId && holds(j.status))
            out.push({ repo, r, ji })
      }
    return out
  }

  protected presentRunner(r: RunnerRec, secret: string | null = null) {
    const current = this.heldBy(r.id).length
    return {
      object: 'runner' as const,
      id: r.id,
      name: r.name,
      account: r.account,
      kind: r.kind,
      provider: r.provider,
      labels: [...r.labels],
      repos: r.repos ? [...r.repos] : null,
      concurrency: r.concurrency,
      status: runnerStatus(r, current, this.now()),
      current_jobs: current,
      last_seen_at: r.lastSeen === null ? null : iso(r.lastSeen),
      created_at: iso(r.created),
      created_by: r.createdBy,
      secret,
      url: `${this.urls.api}/runners/${r.id}`,
      html_url: `${this.urls.html}/settings?section=runners&runner=${r.id}`,
    }
  }

  /** Labels and repositories as a runner keeps them, or a refusal that points at the field. */
  private async checkRunnerFields(
    account: string,
    p: Principal,
    body: {
      labels?: Array<string>
      repos?: Array<string> | null
      concurrency?: number
    },
  ) {
    const labels = body.labels ? normalizeLabels(body.labels) : undefined
    const bad = labels?.find((l) => !labelShape.test(l))
    if (labels && (bad !== undefined || labels.length > MAX_LABELS))
      throw apiError(
        'invalid_request',
        'A label is lowercase letters, digits and . _ : + -, up to 50 of them.',
        {
          errors: [
            {
              pointer: '/body/labels',
              code: 'invalid_label',
              message: bad
                ? `Not a label: ${bad}`
                : `At most ${MAX_LABELS} labels.`,
            },
          ],
        },
      )
    let repos: Array<string> | null | undefined = undefined
    if (body.repos !== undefined) {
      if (body.repos === null) repos = null
      else {
        repos = []
        for (const full of body.repos) {
          const [o, n] = full.split('/')
          const repo = this.resolve(o, n, p)
          if (repo.owner.toLowerCase() !== account.toLowerCase())
            throw apiError(
              'invalid_request',
              `${full} does not belong to ${account}.`,
              {
                errors: [
                  {
                    pointer: '/body/repos',
                    code: 'other_account',
                    message: 'A runner serves repositories of its own account.',
                  },
                ],
              },
            )
          repos.push(`${repo.owner}/${repo.name}`.toLowerCase())
        }
        repos = [...new Set(repos)]
      }
    }
    return { labels, repos }
  }

  async createRunner(p: Viewer, body: RunnerBody, dry: boolean) {
    if (!p) throw apiError('unauthenticated', 'Sign in to register a runner.')
    const account = body.account ?? p.actingAs
    if (!this.accounts.has(account) || !this.isMember(account, p.handle))
      throw apiError('not_found', `No account ${account}.`)
    if (!this.manages(account, p))
      throw apiError(
        'forbidden',
        `Only an owner or admin of ${account} can register its runners.`,
      )
    if (p.repos)
      throw apiError(
        'forbidden',
        'A token limited to repositories cannot register runners.',
      )
    const own = this.runnersOf(account)
    if (
      own.some(
        (r) => !r.disabled && r.name.toLowerCase() === body.name.toLowerCase(),
      )
    )
      throw nameTaken(account, body.name)
    if (own.filter((r) => !r.disabled).length >= MAX_RUNNERS)
      throw apiError(
        'limit_reached',
        `An account can have ${MAX_RUNNERS} runners.`,
      )
    const { labels, repos } = await this.checkRunnerFields(account, p, body)
    const at = this.now()
    const rec: RunnerRec = {
      id: newId('runner', at),
      account,
      name: body.name,
      kind: body.kind ?? 'self-hosted',
      provider: body.kind === 'hosted' ? (body.provider ?? null) : null,
      labels: labels ?? [],
      repos: repos ?? null,
      concurrency: Math.min(body.concurrency ?? 1, MAX_CONCURRENCY),
      disabled: false,
      lastSeen: null,
      createdBy: p.handle,
      created: at,
      tokenId: '',
    }
    if (dry) return this.presentRunner(rec, null)
    const { record, secret } = await this.svc.auth.create({
      name: `runner ${body.name}`,
      kind: 'runner',
      handle: account,
      actingAs: account,
      scopes: runnerScopes,
      repos: rec.repos,
      runnerId: rec.id,
      device: body.name,
      audience: ['api'],
      ttlMs: RUNNER_TTL_MS,
    })
    rec.tokenId = record.id
    this.runners.set(rec.id, rec)
    this.runnerRev++
    return this.presentRunner(rec, secret)
  }

  async listRunners(p: Viewer, account: string | undefined) {
    if (!p) throw apiError('unauthenticated', 'Sign in to list runners.')
    const acct = account ?? p.actingAs
    if (!this.isMember(acct, p.handle) || p.runnerId)
      throw apiError('not_found', `No account ${acct}.`)
    return this.runnersOf(acct)
      .sort((a, b) => b.created - a.created)
      .map((r) => this.presentRunner(r))
  }

  async getRunner(p: Viewer, id: string) {
    return this.presentRunner(this.runnerFor(p, id, false))
  }

  async updateRunner(
    p: Viewer,
    id: string,
    body: {
      name?: string
      labels?: Array<string>
      repos?: Array<string> | null
      concurrency?: number
    },
    dry: boolean,
  ) {
    const r = this.runnerFor(p, id)
    if (r.disabled)
      throw apiError(
        'invalid_state',
        `Runner ${r.name} was revoked; register a new one.`,
      )
    const { labels, repos } = await this.checkRunnerFields(r.account, p!, body)
    if (
      body.name &&
      body.name.toLowerCase() !== r.name.toLowerCase() &&
      this.runnersOf(r.account).some(
        (x) => !x.disabled && x.name.toLowerCase() === body.name!.toLowerCase(),
      )
    )
      throw nameTaken(r.account, body.name)
    const next: RunnerRec = {
      ...r,
      name: body.name ?? r.name,
      labels: labels ?? r.labels,
      repos: repos === undefined ? r.repos : repos,
      concurrency:
        body.concurrency === undefined
          ? r.concurrency
          : Math.min(body.concurrency, MAX_CONCURRENCY),
    }
    if (dry) return this.presentRunner(next)
    Object.assign(r, next)
    // Its token follows the repositories it may serve.
    const t = await this.svc.auth.get(r.tokenId)
    if (t) t.repos = r.repos
    this.runnerRev++
    return this.presentRunner(r)
  }

  async deleteRunner(p: Viewer, id: string, dry: boolean) {
    const r = this.runnerFor(p, id)
    if (dry) return this.presentRunner({ ...r, disabled: true })
    if (!r.disabled) {
      r.disabled = true
      await this.svc.auth.revoke(r.tokenId)
      this.runnerRev++
    }
    return this.presentRunner(r)
  }

  /** The runner behind a runner token, or a refusal. */
  protected runnerOf(p: Viewer): RunnerRec {
    const r = p?.runnerId ? this.runners.get(p.runnerId) : undefined
    if (!r || r.disabled)
      throw apiError(
        'forbidden',
        'Only a registered runner can do this, with its own token.',
        {
          hint: 'Register one with POST /v1/runners and use the secret it answers with.',
        },
      )
    return r
  }

  async runnerHeartbeat(p: Viewer) {
    const runner = this.runnerOf(p)
    this.sweepPipelineTimers()
    const now = this.now()
    runner.lastSeen = now
    for (const { r, ji } of this.heldBy(runner.id))
      if (r.jobs[ji].status === 'running') {
        r.jobs[ji].lease = now + LEASE_MS
        r.version++
      }
    return this.presentRunner(runner)
  }

  async runnerClaim(p: Viewer) {
    const runner = this.runnerOf(p)
    this.sweepPipelineTimers()
    const now = this.now()
    runner.lastSeen = now
    if (this.heldBy(runner.id).length >= runner.concurrency) return null
    let best: { repo: RepoRec; r: PipelineRunRec; ji: number } | null = null
    for (const repo of this.repos.values()) {
      if (!mayServe(runner, repo.owner, repo.name)) continue
      for (const r of repo.pipelines ?? []) {
        if (r.status !== 'queued' && r.status !== 'running') continue
        if (r.runsOnPending) continue
        if (best && best.r.started <= r.started) continue
        const ji = r.jobs.findIndex(
          (j) =>
            j.status === 'queued' && labelsMatch(j.runsOn ?? [], runner.labels),
        )
        if (ji >= 0) best = { repo, r, ji }
      }
    }
    if (!best) return null
    const { repo, r, ji } = best
    const j = r.jobs[ji]
    j.status = 'running'
    j.runner = runner.name
    j.runnerId = runner.id
    j.lease = now + LEASE_MS
    if (r.status === 'queued') r.status = 'running'
    r.version++
    return this.claimed(repo, r, ji)
  }

  async runnerReport(p: Viewer, body: RunnerReportBody) {
    const runner = this.runnerOf(p)
    const [o, n] = body.repo.split('/')
    const repo = this.resolve(o, n, p)
    if (!mayServe(runner, repo.owner, repo.name))
      throw apiError('not_found', `No repository ${body.repo}.`)
    this.settleTimers(repo)
    const r = this.runOf(repo, body.run)
    const j = r.jobs.at(body.job - 1)
    if (!j || body.job < 1)
      throw apiError('not_found', `Run ${body.run} has no job ${body.job}.`)
    if (j.runnerId !== runner.id)
      throw apiError(
        'forbidden',
        `Job ${body.job} of run ${body.run} is not this runner's.`,
        {
          hint: 'A runner reports only the jobs it claimed. Its lease may have run out.',
        },
      )
    runner.lastSeen = this.now()
    return this.applyReport(repo, r, body.job, body.step, body)
  }

  async runnerJobs(p: Viewer, id: string) {
    let runner: RunnerRec
    if (p?.runnerId) {
      runner = this.runnerOf(p)
      if (runner.id !== id) throw apiError('not_found', `No runner ${id}.`)
    } else runner = this.runnerFor(p, id, false)
    this.sweepPipelineTimers()
    return this.heldBy(runner.id).map(({ repo, r, ji }) => ({
      object: 'runner_job' as const,
      repo: `${repo.owner}/${repo.name}`,
      run: r.number,
      job: ji + 1,
      name: r.jobs[ji].name,
      status: r.jobs[ji].status,
      lease_expires_at: r.jobs[ji].lease ? iso(r.jobs[ji].lease) : null,
      url: `${this.repoUrl(repo)}/pipelines/${r.number}/jobs/${ji + 1}`,
    }))
  }
}

function nameTaken(account: string, name: string) {
  return apiError(
    'invalid_request',
    `${account} already has a runner named ${name}.`,
    {
      errors: [
        {
          pointer: '/body/name',
          code: 'taken',
          message: 'Runner names are unique in an account.',
        },
      ],
    },
  )
}

function pipelineDoneJob(j: Job) {
  return !holds(j.status) && j.status !== 'queued'
}
