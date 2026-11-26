import {
  changeActions,
  checksSummary,
  evaluatePolicy,
  evaluateRules,
  headOf,
  policyState,
  presentChange,
  presentCheck,
  presentEvidence,
  presentFinding,
  ruleMode,
  unmetCount,
} from '../change-view'
import type { PolicyConfig } from '../change-view'
import { Pre } from '../registry'
import type { UploadRec } from '../uploads'
import type { z } from 'zod'
import type * as S from '../schemas'
import { iso } from './records'
import { presentSteps } from '../landing'
import type {
  AccountRec,
  ActorRec,
  Assume,
  ChangeRec,
  CheckRec,
  EvidenceRec,
  FindingRec,
  IssueRec,
  OperationRec,
  PolicyState,
  RepoRec,
  Requirement,
  RuleMode,
  Viewer,
} from './records'
import { DomainAccess } from './access'

export abstract class DomainPresent extends DomainAccess {
  protected actor(a: ActorRec): z.infer<typeof S.Actor> {
    return { object: 'actor', id: a.id, handle: a.handle }
  }

  protected repoRef(r: RepoRec): z.infer<typeof S.RepoRef> {
    return {
      object: 'repo',
      id: r.id,
      full_name: `${r.owner}/${r.name}`,
      url: this.repoUrl(r),
    }
  }

  protected presentRepo(r: RepoRec): z.infer<typeof S.Repo> {
    const key = `${r.rev}:${r.changes.size}:${r.issues.size}`
    if (r.counts.key !== key) {
      let openChanges = 0
      for (const c of r.changes.values())
        if (c.state === 'open' || c.state === 'draft') openChanges++
      let openIssues = 0
      for (const i of r.issues.values()) if (i.state === 'open') openIssues++
      r.counts = { key, openChanges, openIssues }
    }
    const { openChanges, openIssues } = r.counts
    return {
      object: 'repo',
      id: r.id,
      owner: r.owner,
      name: r.name,
      full_name: `${r.owner}/${r.name}`,
      description: r.description,
      visibility: r.visibility,
      default_branch: r.defaultBranch,
      stars: r.stars,
      stars_today:
        r.starsTodayBase +
        r.starTimes.filter((t) => t > this.now() - 86_400_000).length,
      forks: r.forks,
      upstream: r.upstream,
      install: r.install,
      category: r.category,
      language: r.languages[0]?.[0] ?? null,
      languages: r.languages.map(([name, percent]) => ({ name, percent })),
      license: r.license,
      website: r.website,
      docs_url: r.docsUrl,
      maintainers: [...r.maintainers].sort(),
      declined_models: [...(r.declinedModels ?? [])],
      auto_land: !!r.autoLand,
      vouched: [...(r.vouched ?? [])].sort(),
      denounced: (r.denounced ?? []).map((d) => ({
        handle: d.handle,
        reason: d.reason,
      })),
      open_changes: openChanges,
      open_issues: openIssues,
      url: this.repoUrl(r),
      html_url: `${this.urls.html}/${r.owner}/${r.name}`,
      created_at: iso(r.created),
      updated_at: iso(r.updated),
      version: r.version,
    }
  }

  protected head(c: ChangeRec) {
    return headOf(c)
  }

  protected checksFor(c: ChangeRec) {
    return checksSummary(c)
  }

  protected latestReviews(c: ChangeRec) {
    let l = c.latest
    if (!l) c.latest = l = { map: new Map(), seen: 0 }
    for (; l.seen < c.reviews.length; l.seen++) {
      const r = c.reviews[l.seen]
      l.map.set(r.actor.id, r)
    }
    return [...l.map.values()]
  }

  protected evaluate(
    repo: RepoRec,
    c: ChangeRec,
    assume?: Assume,
  ): Array<Requirement> {
    if (assume) return this.evaluateFresh(repo, c, assume)
    const memo = c.policyMemo
    const rev = repo.policyRev ?? 0
    if (memo && memo.version === c.version && (memo.rev ?? 0) === rev)
      return memo.reqs
    const reqs = this.evaluateFresh(repo, c, {})
    c.policyMemo = { version: c.version, rev, reqs }
    return reqs
  }

  protected policyConfig(repo: RepoRec): PolicyConfig {
    return {
      modes: repo.ruleModes,
      exceptions: repo.policyExceptions,
      customRules: repo.customRules,
      landing: repo.landing,
      isMaintainer: (h) => repo.maintainers.has(h),
      now: this.now(),
    }
  }

  protected modeOf(repo: RepoRec, id: string): RuleMode {
    return ruleMode(this.policyConfig(repo), id)
  }

  protected evaluateFresh(
    repo: RepoRec,
    c: ChangeRec,
    assume: Assume,
  ): Array<Requirement> {
    return evaluatePolicy(
      this.policyConfig(repo),
      c,
      this.latestReviews(c),
      assume,
    )
  }

  protected evaluateRules(
    repo: RepoRec,
    c: ChangeRec,
    assume: Assume,
  ): Array<Requirement> {
    return evaluateRules(
      this.policyConfig(repo),
      c,
      this.latestReviews(c),
      assume,
    )
  }

  protected policyState(reqs: ReadonlyArray<Requirement>): PolicyState {
    return policyState(reqs)
  }

  protected unmet(reqs: ReadonlyArray<Requirement>) {
    return unmetCount(reqs)
  }

  protected actionsFor(repo: RepoRec, c: ChangeRec, p: Viewer) {
    return changeActions({
      change: c,
      viewer: p,
      canWrite: !!p && this.canWrite(repo, p),
      reqs: p ? this.evaluate(repo, c) : [],
      parent: this.parentOf(repo, c),
      branchOwner: repo.openChangeByBranch.get(c.branch),
    })
  }

  protected parentOf(repo: RepoRec, c: ChangeRec) {
    if (!c.stackId) return null
    const members = repo.stacks.get(c.stackId) ?? []
    const i = members.indexOf(c.number)
    return i > 0 ? (repo.changes.get(members[i - 1]) ?? null) : null
  }

  protected presentFinding(repo: RepoRec, c: ChangeRec, f: FindingRec) {
    return presentFinding(this.repoUrl(repo), c, f)
  }

  protected presentCheck(k: CheckRec) {
    return presentCheck(k)
  }

  protected readonly shown = new Map<string, Pre>()

  protected shownChars = 0

  static readonly SHOWN_MAX = 8000

  static readonly SHOWN_CHARS_MAX = 24_000_000

  shownChange(
    repo: RepoRec,
    c: ChangeRec,
    viewer: Viewer | 'event',
    expand: ReadonlyArray<string> = [],
  ): Pre {
    const who =
      viewer === 'event' ? 'event' : viewer ? viewer.capId : 'anonymous'
    const ex = expand.length ? expand.join(',') : ''
    const key = `${repo.id}|${c.id}|${c.version}|${c.stackId ? this.stackRev(repo, c) : 0}|${repo.openChangeByBranch.get(c.branch)?.id ?? ''}|${ex}|${who}|${repo.version}|${this.accessRevision}${expand.includes('repo') ? `|${repo.rev}` : ''}`
    const hit = this.shown.get(key)
    if (hit) return hit
    const obj = this.presentChange(repo, c, viewer, expand)
    const pre = new Pre(JSON.stringify(obj), obj, key)
    this.shown.set(key, pre)
    this.shownChars += pre.json.length
    while (
      (this.shown.size > DomainPresent.SHOWN_MAX ||
        this.shownChars > DomainPresent.SHOWN_CHARS_MAX) &&
      this.shown.size > 1
    ) {
      const gone = this.shown.keys().next().value as string
      this.shownChars -= this.shown.get(gone)!.json.length
      this.shown.delete(gone)
    }
    return pre
  }

  presentChange(
    repo: RepoRec,
    c: ChangeRec,
    viewer: Viewer | 'event',
    expand: ReadonlyArray<string> = [],
  ): z.infer<typeof S.Change> {
    return presentChange({
      change: c,
      repoUrl: this.repoUrl(repo),
      htmlUrl: `${this.urls.html}/${repo.owner}/${repo.name}`,
      repo: expand.includes('repo')
        ? this.presentRepo(repo)
        : this.repoRef(repo),
      reqs: this.evaluate(repo, c),
      reviews: this.latestReviews(c),
      members: c.stackId ? (repo.stacks.get(c.stackId) ?? []) : [],
      parent: this.parentOf(repo, c),
      actions: viewer === 'event' ? null : this.actionsFor(repo, c, viewer),
      expand,
    }) as z.infer<typeof S.Change>
  }

  protected readonly shownIssues = new Map<string, Pre>()

  protected shownIssueChars = 0

  static readonly SHOWN_ISSUES_MAX = 6000

  static readonly SHOWN_ISSUES_CHARS_MAX = 12_000_000

  shownIssue(repo: RepoRec, i: IssueRec): Pre {
    const key = `${repo.id}|${i.id}|${i.version}|${repo.version}`
    const hit = this.shownIssues.get(key)
    if (hit) return hit
    const json = JSON.stringify(this.presentIssue(repo, i))
    const pre = new Pre(json, () => JSON.parse(json), key)
    this.shownIssues.set(key, pre)
    this.shownIssueChars += json.length
    while (
      (this.shownIssues.size > DomainPresent.SHOWN_ISSUES_MAX ||
        this.shownIssueChars > DomainPresent.SHOWN_ISSUES_CHARS_MAX) &&
      this.shownIssues.size > 1
    ) {
      const gone = this.shownIssues.keys().next().value as string
      this.shownIssueChars -= this.shownIssues.get(gone)!.json.length
      this.shownIssues.delete(gone)
    }
    return pre
  }

  presentIssue(repo: RepoRec, i: IssueRec): z.infer<typeof S.Issue> {
    return {
      object: 'issue',
      id: i.id,
      number: i.number,
      url: `${this.repoUrl(repo)}/issues/${i.number}`,
      html_url: `${this.urls.html}/${repo.owner}/${repo.name}/issues/${i.number}`,
      repo: this.repoRef(repo),
      title: i.title,
      body: i.body,
      state: i.state,
      author: this.actor(i.author),
      labels: i.labels,
      assignees: (i.assignees ?? []).map((a) => this.actor(a)),
      comments: i.comments?.length ?? 0,
      closed_at: i.closed ? iso(i.closed) : null,
      closed_as: i.state === 'closed' ? (i.closedAs ?? null) : null,
      created_at: iso(i.created),
      updated_at: iso(i.updated),
      version: i.version,
    }
  }

  protected presentOp(o: OperationRec): z.infer<typeof S.Operation> {
    return {
      object: 'operation',
      id: o.id,
      kind: o.kind,
      state: o.state,
      progress: { done: o.done, total: o.total },
      result: o.result,
      error: o.error,
      url: `${this.urls.api}/operations/${o.id}`,
      created_at: iso(o.created),
      finished_at: o.finished ? iso(o.finished) : null,
      steps: presentSteps(o.steps ?? [], iso),
    }
  }

  protected presentEvidence(c: ChangeRec, e: EvidenceRec, u: UploadRec) {
    return presentEvidence(this.urls.api, c, e, u)
  }

  protected presentAccount(
    a: AccountRec,
    p: Viewer,
  ): z.infer<typeof S.Account> {
    return {
      object: 'account',
      id: a.id,
      handle: a.handle,
      name: a.name,
      kind: a.kind,
      bio: a.bio,
      role: !p
        ? null
        : a.handle === p.handle
          ? 'owner'
          : (a.members.get(p.handle) ?? null),
      url: `${this.urls.api}/accounts/${a.handle}`,
      html_url: `${this.urls.html}/${a.handle}`,
      created_at: iso(a.created),
      updated_at: iso(a.updated),
      version: a.version,
    }
  }

  protected stackRev(repo: RepoRec, c: ChangeRec) {
    let rev = 0
    for (const n of repo.stacks.get(c.stackId!) ?? [])
      rev += repo.changes.get(n)?.version ?? 0
    return rev
  }
}
