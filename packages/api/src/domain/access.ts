import { apiError } from '../problem'
import { changeSearchDoc, issueSearchDoc, repoSearchDoc } from '../search'
import type { SearchDoc } from '../search'
import type { Principal } from '../auth'
import { Moved } from './records'
import type { AccountRec, ChangeRec, RepoRec, Viewer } from './records'
import {
  branchHidden,
  changeVisible,
  hiddenRules,
  pathHidden,
  rulesOverChange,
} from '../access-rules'
import type { RuleViewer } from '../access-rules'
import { touchedFiles } from '../paths'
import { DomainState } from './state'

export abstract class DomainAccess extends DomainState {
  protected isMember(handle: string, who: string) {
    const acc = this.accounts.get(handle)
    return !!acc && (handle === who || acc.members.has(who))
  }

  protected canRead(repo: RepoRec, p: Viewer) {
    const full = `${repo.owner}/${repo.name}`.toLowerCase()
    if (p?.runnerId && repo.owner.toLowerCase() !== p.actingAs.toLowerCase())
      return repo.visibility === 'public'
    if (p?.repos && !p.repos.includes(full)) return repo.visibility === 'public'
    if (repo.visibility === 'public') return true
    return (
      !!p &&
      (this.hasAccess(repo, p) || this.teamLevel(repo, p.handle) !== null)
    )
  }

  protected teamLevel(repo: RepoRec, handle: string): 'read' | 'write' | null {
    const keys = this.teamsOf.get(handle)
    if (!keys) return null
    const full = `${repo.owner}/${repo.name}`
    let level: 'read' | 'write' | null = null
    for (const k of keys) {
      const g = this.teams.get(k)?.repos.get(full)
      if (g === 'write') return 'write'
      if (g) level = 'read'
    }
    return level
  }

  protected hasAccess(repo: RepoRec, p: Principal) {
    return (
      this.isMember(repo.owner, p.handle) || repo.collaborators.has(p.handle)
    )
  }

  protected canWrite(repo: RepoRec, p: Viewer): p is Principal {
    if (!p) return false
    if (p.runnerId) return false
    if (
      p.repos &&
      !p.repos.includes(`${repo.owner}/${repo.name}`.toLowerCase())
    )
      return false
    return this.hasAccess(repo, p) || this.teamLevel(repo, p.handle) === 'write'
  }

  protected resolve(
    owner: string,
    name: string,
    p: Viewer,
    need: 'read' | 'write' = 'read',
  ): RepoRec {
    let repo: RepoRec | undefined
    if (name === '~' && owner.startsWith('rep_'))
      repo = this.reposById.get(owner)
    else {
      const key = `${owner}/${name}`.toLowerCase()
      repo = this.repos.get(key) ?? this.byLower(key)
      if (!repo) {
        let target = key
        const seen = new Set<string>([target])
        for (let i = 0; i < 10; i++) {
          const next = this.aliases.get(target)
          if (!next || seen.has(next)) break
          seen.add(next)
          target = next
        }
        if (target !== key) {
          const moved =
            this.repos.get(target) ?? this.byLower(target.toLowerCase())
          if (moved && this.canRead(moved, p)) throw new Moved(key, target)
        }
      }
    }
    if (!repo || !this.canRead(repo, p))
      throw apiError('not_found', `No repository ${owner}/${name}.`)
    if (need === 'write' && !this.canWrite(repo, p))
      throw apiError(
        'forbidden',
        'You can read this repository but not change it.',
      )
    return repo
  }

  protected ruleViewer(repo: RepoRec, p: Viewer): RuleViewer | null {
    if (!p) return null
    const owner = this.accounts.get(repo.owner)
    const role =
      repo.owner === p.handle ? 'owner' : owner?.members.get(p.handle)
    const runner =
      !!p.runnerId && repo.owner.toLowerCase() === p.actingAs.toLowerCase()
    const teams = new Set<string>()
    for (const k of this.teamsOf.get(p.handle) ?? []) {
      const t = this.teams.get(k)
      if (t && t.org === repo.owner) teams.add(t.slug)
    }
    return {
      handle: p.handle,
      teams,
      all: runner || role === 'owner' || role === 'admin',
    }
  }

  protected hiddenFor(repo: RepoRec, p: Viewer) {
    const rules = repo.accessRules ?? []
    return rules.length ? hiddenRules(rules, this.ruleViewer(repo, p)) : []
  }

  protected rulesOver(repo: RepoRec, c: ChangeRec) {
    const rules = repo.accessRules ?? []
    if (!rules.length) return []
    const head = c.patchSets[c.patchSets.length - 1] as
      | ChangeRec['patchSets'][number]
      | undefined
    return rulesOverChange(rules, {
      branch: c.branch,
      files: head ? touchedFiles(head) : [],
    })
  }

  seesChange(repo: RepoRec, c: ChangeRec, p: Viewer) {
    const over = this.rulesOver(repo, c)
    return (
      !over.length ||
      changeVisible(repo.accessRules ?? [], over, this.ruleViewer(repo, p))
    )
  }

  protected assertMayTouch(
    repo: RepoRec,
    p: Viewer,
    branch: string,
    files: Iterable<string>,
  ) {
    const hidden = this.hiddenFor(repo, p)
    if (!hidden.length) return
    if (branchHidden(hidden, branch))
      throw apiError(
        'forbidden',
        `${branch} is a private branch of ${repo.owner}/${repo.name}.`,
        { hint: 'Its access rule names who may work on it. Ask an admin.' },
      )
    const hit = [...files].filter((f) => pathHidden(hidden, f))
    if (hit.length)
      throw apiError(
        'forbidden',
        `${hit.slice(0, 3).join(', ')} ${hit.length === 1 ? 'is' : 'are'} private in ${repo.owner}/${repo.name}.`,
        { hint: 'Its access rule names who may change it. Ask an admin.' },
      )
  }

  async hiddenChanges(repoId: string | null, p: Viewer): Promise<Set<number>> {
    const repo = repoId ? this.reposById.get(repoId) : undefined
    const out = new Set<number>()
    if (!repo?.accessRules?.length) return out
    for (const c of repo.changes.values())
      if (!this.seesChange(repo, c, p)) out.add(c.number)
    return out
  }

  async accessView(owner: string, name: string, p: Viewer) {
    const repo = this.resolve(owner, name, p)
    return {
      hidden: this.hiddenFor(repo, p).map((r) => ({
        id: r.id,
        kind: r.kind,
        patterns: [...r.patterns],
      })),
    }
  }

  mayRead(repoFull: string, p: Viewer) {
    const r = this.repos.get(repoFull)
    return !!r && this.canRead(r, p)
  }

  *searchDocs(): Iterable<SearchDoc> {
    for (const r of this.repos.values()) {
      const full = `${r.owner}/${r.name}`
      const url = this.repoUrl(r)
      yield repoSearchDoc(r, url)
      for (const c of r.changes.values()) yield changeSearchDoc(full, url, c)
      for (const i of r.issues.values()) yield issueSearchDoc(full, url, i)
    }
  }

  protected orgFor(
    handle: string,
    p: Principal,
    need: 'member' | 'admin',
  ): AccountRec {
    const acct = this.accounts.get(handle)
    if (!acct || acct.kind !== 'organization')
      throw apiError('not_found', `No organization ${handle}.`)
    const role = acct.members.get(p.handle)
    if (!role) throw apiError('not_found', `No organization ${handle}.`)
    if (need === 'admin' && role !== 'owner' && role !== 'admin')
      throw apiError(
        'forbidden',
        `Only an owner or admin of ${handle} can change its teams.`,
        {
          hint: 'GET /v1/accounts shows your role in each account.',
        },
      )
    if (p.repos)
      throw apiError(
        'forbidden',
        'A token limited to repositories cannot read or change teams.',
        {
          hint: 'Use a token that is not limited to repositories.',
        },
      )
    return acct
  }

  protected assertAdmin(repo: RepoRec, p: Principal) {
    const acct = this.accounts.get(repo.owner)
    const role = repo.owner === p.handle ? 'owner' : acct?.members.get(p.handle)
    if (role !== 'owner' && role !== 'admin')
      throw apiError(
        'forbidden',
        `Only an owner or admin of ${repo.owner} can do this.`,
        {
          hint: 'GET /v1/accounts shows your role in each account.',
        },
      )
  }

  protected hasRepoGrant(repo: RepoRec, p: Viewer) {
    if (!p) return false
    const full = `${repo.owner}/${repo.name}`.toLowerCase()
    if (p.repos && !p.repos.includes(full)) return false
    return this.hasAccess(repo, p) || this.teamLevel(repo, p.handle) !== null
  }

  async repoAccessStrict(
    owner: string,
    name: string,
    p: Viewer,
    need: 'read' | 'write' = 'read',
  ) {
    const r = this.resolve(owner, name, p, need)
    if (!this.hasRepoGrant(r, p))
      throw apiError('not_found', `No repository ${owner}/${name}.`, {
        hint: 'Check the path. Private things answer 404 to everyone who cannot see them.',
      })
    return `${r.owner}/${r.name}`
  }

  async secretsAccess(owner: string, name: string, p: Viewer) {
    const r = this.resolve(owner, name, p, 'read')
    const full = `${r.owner}/${r.name}`
    const team =
      !!p &&
      !(p.repos && !p.repos.includes(full.toLowerCase())) &&
      (this.isMember(r.owner, p.handle) ||
        this.teamLevel(r, p.handle) === 'write')
    return { full, repoId: r.id, team }
  }

  async repoAccess(
    owner: string,
    name: string,
    p: Viewer,
    need: 'read' | 'write',
  ) {
    const r = this.resolve(owner, name, p, need)
    return `${r.owner}/${r.name}`
  }

  async canActAs(login: string, account: string) {
    return this.isMember(account, login)
  }

  mayReadId(id: string | null, p: Viewer) {
    if (!id) return false
    const r = this.reposById.get(id)
    return r ? this.canRead(r, p) : false
  }

  assertVersion(
    ifMatch: string | null,
    version: string,
    current: () => unknown,
  ) {
    this.assertMatch(ifMatch, version, current)
  }

  protected assertMatch(
    ifMatch: string | null,
    version: string,
    current: () => unknown,
  ) {
    if (ifMatch === null) return
    const tags = ifMatch
      .split(',')
      .map((t) => t.trim().replace(/^W\//, '').replace(/"/g, ''))
    if (
      tags.includes('*') ||
      tags.some(
        (t) =>
          t === version ||
          t.startsWith(`${version}-`) ||
          t.startsWith(`${version}.`),
      )
    )
      return
    throw apiError(
      'version_mismatch',
      'The object changed since you read it.',
      {
        extra: { current: current() },
      },
    )
  }

  canSee(p: Viewer) {
    return this.readableRepos(p)
  }

  protected administered(full: string, p: Viewer): boolean {
    if (!p) return false
    if (p.repos && !p.repos.includes(full.toLowerCase())) return false
    const owner = this.deleted.get(full)
    if (!owner) return false
    const role =
      owner === p.handle
        ? 'owner'
        : this.accounts.get(owner)?.members.get(p.handle)
    return role === 'owner' || role === 'admin'
  }

  protected readableRepos(p: Viewer) {
    const cache = new Map<string, boolean>()
    return (full: string | null) => {
      if (!full) return !!p
      let ok = cache.get(full)
      if (ok === undefined) {
        const r = this.repos.get(full)
        ok = r ? this.canRead(r, p) : this.administered(full, p)
        cache.set(full, ok)
      }
      return ok
    }
  }

  protected readableRepoIds(p: Viewer) {
    const cache = new Map<string, boolean>()
    return (id: string | null) => {
      if (!id) return !!p
      let ok = cache.get(id)
      if (ok === undefined) {
        const r = this.reposById.get(id)
        if (r) ok = this.canRead(r, p)
        else {
          const d = this.deletedRepos.get(id)
          ok = d ? this.administered(d.full, p) : false
        }
        cache.set(id, ok)
      }
      return ok
    }
  }

  canSeeId(p: Viewer) {
    return this.readableRepoIds(p)
  }
}
