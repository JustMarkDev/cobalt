import { normalizeModels } from '../via'
import { receiptFor } from '../receipt'
import { newId } from '../ids'
import { pageSorted } from '../cursor'
import { apiError } from '../problem'
import { allowsPrivate } from '../plans'
import type { CursorPosition, Page } from '../cursor'
import type { Principal } from '../auth'
import type { PlanId } from '../plans'
import type { z } from 'zod'
import type * as S from '../schemas'
import { recId } from './records'
import type {
  ChangeRec,
  IssueRec,
  RepoCategory,
  RepoRec,
  Viewer,
} from './records'
import { DomainAccounts } from './accounts'

export abstract class DomainRepos extends DomainAccounts {
  private assertPrivateAllowed(
    acct: { handle: string; plan?: PlanId } | undefined,
  ) {
    if (acct && !allowsPrivate(acct.plan ?? 'business'))
      throw apiError(
        'plan_required',
        `${acct.handle} is on the Free plan, which is for public repositories.`,
        {
          hint: 'Upgrade the account that owns the repository to keep it private. See /pricing.',
          extra: { plan: acct.plan },
        },
      )
  }

  async createRepo(
    p: Principal,
    input: {
      owner?: string
      name: string
      description?: string
      visibility: 'public' | 'private'
      maintainers?: Array<string>
    },
    dry: boolean,
  ) {
    const owner = input.owner ?? p.actingAs
    const acct = this.accounts.get(owner)
    if (!acct) throw apiError('not_found', `No account ${owner}.`)
    const role = owner === p.handle ? 'owner' : acct.members.get(p.handle)
    if (!role) throw apiError('not_found', `No account ${owner}.`)
    if (role === 'member')
      throw apiError(
        'forbidden',
        `Members of ${owner} cannot create repositories there.`,
        {
          hint: 'Ask an owner or admin, or create it in an account you manage. GET /v1/accounts shows your role in each.',
        },
      )
    if (p.repos)
      throw apiError(
        'forbidden',
        'A token limited to repositories cannot create new ones.',
      )
    if (input.visibility === 'private') this.assertPrivateAllowed(acct)
    const maintainers = new Set(input.maintainers ?? [])
    if (input.maintainers) {
      if (input.maintainers.length === 0)
        throw apiError(
          'invalid_request',
          'A repository needs at least one maintainer.',
          {
            errors: [
              {
                pointer: '/body/maintainers',
                code: 'empty',
                message: 'Name at least one person.',
              },
            ],
          },
        )
      for (const h of input.maintainers)
        if (this.accounts.get(h)?.kind !== 'person')
          throw apiError('invalid_request', `${h} is not a person.`, {
            errors: [
              {
                pointer: '/body/maintainers',
                code: 'not_a_person',
                message: `${h} is not a person.`,
              },
            ],
          })
    } else {
      if (acct.kind === 'person') maintainers.add(acct.handle)
      for (const [h, r] of acct.members)
        if (
          (r === 'owner' || r === 'admin') &&
          this.accounts.get(h)?.kind === 'person'
        )
          maintainers.add(h)
      if (this.accounts.get(p.handle)?.kind === 'person')
        maintainers.add(p.handle)
    }
    if (maintainers.size === 0)
      throw apiError(
        'invalid_request',
        'A repository needs at least one maintainer.',
        {
          errors: [
            {
              pointer: '/body/maintainers',
              code: 'empty',
              message: 'Name at least one person.',
            },
          ],
        },
      )
    const existing =
      this.repos.get(`${owner}/${input.name}`) ??
      this.byLower(`${owner}/${input.name}`.toLowerCase())
    if (existing) return { repo: this.presentRepo(existing), created: false }
    if (dry)
      return {
        repo: this.presentRepo(
          this.makeRepo(owner, input.name, {
            description: input.description ?? '',
            visibility: input.visibility,
            created: this.now(),
            maintainers: [...maintainers],
            collaborators: [...maintainers],
          }),
        ),
        created: true,
      }
    const rec = this.seedRepo(owner, input.name, {
      id: newId('repo', this.now()),
      description: input.description ?? '',
      visibility: input.visibility,
      created: this.now(),
      maintainers: [...maintainers],
      collaborators: [...maintainers],
    })
    rec.maintainerGrants = new Set(maintainers)
    this.accessRevision++
    const lower = `${owner}/${input.name}`.toLowerCase()
    this.aliases.delete(lower)
    for (const [key, value] of this.aliases)
      if (value.toLowerCase() === lower) this.aliases.delete(key)
    this.svc.git.setRepo?.(`${owner}/${input.name}`, rec.storeId)
    this.svc.search.upsertIfBuilt({
      key: `repo:${rec.id}`,
      type: 'repo',
      id: rec.id,
      repo: `${owner}/${input.name}`,
      number: null,
      title: `${owner}/${input.name}`,
      text: rec.description,
      state: rec.visibility,
      author: owner,
      labels: [],
      updated: rec.updated,
      url: this.repoUrl(rec),
    })
    return { repo: this.presentRepo(rec), created: true }
  }

  async updateRepo(
    owner: string,
    name: string,
    p: Principal,
    body: {
      name?: string
      description?: string
      visibility?: 'public' | 'private'
      default_branch?: string
      maintainers?: Array<string>
      category?: RepoCategory | null
      website?: string | null
      docs_url?: string | null
      install?: string | null
      declined_models?: Array<string>
      auto_land?: boolean
      vouched?: Array<string>
      denounced?: Array<{ handle: string; reason: string }>
    },
    ifMatch: string | null,
    dry: boolean,
  ) {
    const repo = this.resolve(owner, name, p, 'write')
    this.assertAdmin(repo, p)
    this.assertMatch(ifMatch, `${repo.id}.${repo.version}`, () =>
      this.presentRepo(repo),
    )
    const renaming = body.name !== undefined && body.name !== repo.name
    if (renaming && p.repos)
      throw apiError(
        'forbidden',
        'A token limited to repositories cannot rename one.',
        {
          hint: 'Use a token that is not limited to repositories.',
        },
      )
    if (renaming) {
      const target = `${repo.owner}/${body.name}`
      const taken = this.repos.get(target) ?? this.byLower(target.toLowerCase())
      if (taken && taken !== repo)
        throw apiError('invalid_state', `${target} already exists.`, {
          hint: 'Pick another name, or delete the repository that has it.',
        })
    }
    const nextMaintainers =
      body.maintainers !== undefined
        ? [...new Set(body.maintainers)].sort()
        : undefined
    const maintainersChanged =
      nextMaintainers !== undefined &&
      JSON.stringify([...repo.maintainers].sort()) !==
        JSON.stringify(nextMaintainers)
    if (maintainersChanged && p.repos)
      throw apiError(
        'forbidden',
        'A token limited to repositories cannot change maintainers.',
        {
          hint: 'Use a token that is not limited to repositories.',
        },
      )
    if (body.maintainers !== undefined) {
      if (body.maintainers.length === 0)
        throw apiError(
          'invalid_request',
          'A repository needs at least one maintainer.',
          {
            errors: [
              {
                pointer: '/body/maintainers',
                code: 'empty',
                message: 'Name at least one person.',
              },
            ],
          },
        )
      for (const h of body.maintainers)
        if (this.accounts.get(h)?.kind !== 'person')
          throw apiError('invalid_request', `${h} is not a person.`, {
            errors: [
              {
                pointer: '/body/maintainers',
                code: 'not_a_person',
                message: `${h} is not a person.`,
              },
            ],
          })
    }
    if (dry)
      return this.presentRepo({
        ...repo,
        name: body.name ?? repo.name,
        description: body.description ?? repo.description,
        visibility: body.visibility ?? repo.visibility,
        defaultBranch: body.default_branch ?? repo.defaultBranch,
        category: body.category === undefined ? repo.category : body.category,
        website: body.website === undefined ? repo.website : body.website,
        docsUrl: body.docs_url === undefined ? repo.docsUrl : body.docs_url,
        install: body.install === undefined ? repo.install : body.install,
        declinedModels: body.declined_models ?? repo.declinedModels,
        autoLand:
          body.auto_land === undefined
            ? repo.autoLand
            : body.auto_land
              ? { by: p.handle }
              : null,
        vouched: body.vouched ?? repo.vouched,
        denounced: body.denounced ?? repo.denounced,
        maintainers: nextMaintainers
          ? new Set(nextMaintainers)
          : repo.maintainers,
      })
    const changed: Array<string> = []
    if (
      body.description !== undefined &&
      body.description !== repo.description
    ) {
      repo.description = body.description
      changed.push('description')
    }
    if (body.visibility !== undefined && body.visibility !== repo.visibility) {
      if (body.visibility === 'private')
        this.assertPrivateAllowed(this.accounts.get(repo.owner))
      repo.visibility = body.visibility
      changed.push('visibility')
    }
    if (
      body.default_branch !== undefined &&
      body.default_branch !== repo.defaultBranch
    ) {
      repo.defaultBranch = body.default_branch
      changed.push('default_branch')
    }
    if (body.category !== undefined && body.category !== repo.category) {
      repo.category = body.category
      changed.push('category')
    }
    if (body.website !== undefined && body.website !== repo.website) {
      repo.website = body.website
      changed.push('website')
    }
    if (body.docs_url !== undefined && body.docs_url !== repo.docsUrl) {
      repo.docsUrl = body.docs_url
      changed.push('docs_url')
    }
    if (body.install !== undefined && body.install !== repo.install) {
      repo.install = body.install
      changed.push('install')
    }
    if (body.declined_models !== undefined) {
      repo.declinedModels = normalizeModels(body.declined_models)
      changed.push('declined_models')
    }
    if (body.auto_land !== undefined && body.auto_land !== !!repo.autoLand) {
      repo.autoLand = body.auto_land ? { by: p.handle } : null
      changed.push('auto_land')
    }
    if (body.vouched !== undefined) {
      repo.vouched = [...new Set(body.vouched.map((h) => h.toLowerCase()))]
      changed.push('vouched')
    }
    if (body.denounced !== undefined) {
      repo.denounced = body.denounced.map((d) => ({
        handle: d.handle.toLowerCase(),
        reason: d.reason,
      }))
      changed.push('denounced')
    }
    if (maintainersChanged) {
      const removed = [...repo.maintainers].filter(
        (h) => !nextMaintainers.includes(h),
      )
      for (const h of removed)
        if (repo.maintainerGrants.delete(h)) repo.collaborators.delete(h)
      for (const h of nextMaintainers)
        if (!repo.collaborators.has(h)) {
          repo.collaborators.add(h)
          repo.maintainerGrants.add(h)
        }
      repo.maintainers = new Set(nextMaintainers)
      for (const c of repo.changes.values()) c.policyMemo = undefined
      this.accessRevision++
      this.svc.search.reset()
      changed.push('maintainers')
    }
    if (renaming) {
      this.moveRepo(repo, repo.owner, body.name!)
      changed.push('name')
    }
    if (changed.length) {
      repo.version++
      if (changed.includes('visibility') || changed.includes('name'))
        this.accessRevision++
      if (
        renaming ||
        changed.includes('visibility') ||
        changed.includes('description')
      )
        this.svc.search.reset()
      this.emit(
        repo,
        'repo.updated',
        this.asActor(p),
        { object: 'repo', id: repo.id, number: null },
        changed,
        this.presentRepo(repo),
      )
    }
    return this.presentRepo(repo)
  }

  async transferRepo(
    owner: string,
    name: string,
    p: Principal,
    body: { owner: string; name?: string; confirm: string },
    dry: boolean,
  ) {
    const repo = this.resolve(owner, name, p, 'write')
    this.assertAdmin(repo, p)
    const from = `${repo.owner}/${repo.name}`
    if (p.repos)
      throw apiError(
        'forbidden',
        'A token limited to repositories cannot transfer one.',
      )
    if (body.confirm !== from)
      throw apiError(
        'invalid_request',
        `Transferring ${from} changes who owns it. Send confirm=${from} to do it.`,
        {
          errors: [
            {
              pointer: '/body/confirm',
              code: 'confirmation_required',
              message: `Send confirm: "${from}".`,
            },
          ],
        },
      )
    const acct = this.accounts.get(body.owner)
    const role = !acct
      ? undefined
      : acct.handle === p.handle
        ? 'owner'
        : acct.members.get(p.handle)
    if (!acct || !role) throw apiError('not_found', `No account ${body.owner}.`)
    if (role === 'member')
      throw apiError(
        'forbidden',
        `Members of ${body.owner} cannot bring repositories there.`,
        { hint: 'Ask an owner or admin of that account to do it.' },
      )
    const toName = body.name ?? repo.name
    const to = `${acct.handle}/${toName}`
    if (to === from) return this.presentRepo(repo)
    const taken = this.repos.get(to) ?? this.byLower(to.toLowerCase())
    if (taken && taken !== repo)
      throw apiError('invalid_state', `${to} already exists.`, {
        hint: 'Pass another name, or delete the repository that has it.',
      })
    if (dry)
      return this.presentRepo({ ...repo, owner: acct.handle, name: toName })
    const changed = repo.owner === acct.handle ? ['name'] : ['owner']
    const newOwner = repo.owner !== acct.handle
    if (newOwner) {
      for (const t of this.teams.values())
        if (t.repos.delete(from)) {
          t.updated = this.now()
          t.version++
        }
      if (toName !== repo.name) changed.push('name')
      repo.collaborators.clear()
      repo.maintainerGrants.clear()
      repo.maintainers.clear()
      repo.autoLand = null
      repo.declinedModels = []
      repo.vouched = []
      repo.denounced = []
      this.svc.hooks.dropRepo(from)
      this.memAuth.dropRepo(from)
    }
    this.moveRepo(repo, acct.handle, toName)
    if (newOwner) {
      const x = await this.svc.extras.open(to)
      if (x.clearValues()) {
        const r = receiptFor(p)
        x.note(
          `${p.handle} on ${r.machine ?? 'an unnamed machine'}${r.tool ? ` via ${r.tool}` : ''}`,
          `cleared every value and mirror: ${from} moved to ${acct.handle}`,
          { kind: 'revoke' },
        )
      }
    }
    repo.version++
    this.accessRevision++
    this.svc.search.reset()
    this.emit(
      repo,
      'repo.updated',
      this.asActor(p),
      { object: 'repo', id: repo.id, number: null },
      changed,
      this.presentRepo(repo),
    )
    return this.presentRepo(repo)
  }

  protected moveRepo(repo: RepoRec, toOwner: string, toName: string) {
    const from = `${repo.owner}/${repo.name}`
    const to = `${toOwner}/${toName}`
    this.repos.delete(from)
    repo.owner = toOwner
    repo.name = toName
    this.repos.set(to, repo)
    this.memAuth.renameRepo(from, to)
    this.svc.git.setRepo?.(to, repo.storeId)
    if (from.toLowerCase() !== to.toLowerCase()) this.svc.git.dropRepo?.(from)
    for (const [key, value] of this.aliases)
      if (value === from || value.toLowerCase() === from.toLowerCase())
        this.aliases.set(key, to)
    this.aliases.set(from.toLowerCase(), to)
    this.aliases.delete(to.toLowerCase())
    this.svc.hooks.rename(from, to)
    this.svc.extras.rename(from, to)
    for (const t of this.teams.values())
      if (t.repos.has(from)) {
        t.repos.set(to, t.repos.get(from)!)
        t.repos.delete(from)
        t.updated = this.now()
        t.version++
      }
    this.onRepoMoved(from, to)
  }

  protected onRepoMoved(_from: string, _to: string) {}

  async deleteRepo(
    owner: string,
    name: string,
    p: Principal,
    confirm: string | undefined,
    dry: boolean,
  ) {
    const repo = this.resolve(owner, name, p, 'write')
    this.assertAdmin(repo, p)
    const full = `${repo.owner}/${repo.name}`
    if (p.repos)
      throw apiError(
        'forbidden',
        'A token limited to repositories cannot delete one.',
      )
    if (confirm !== full)
      throw apiError(
        'invalid_request',
        `Deleting ${full} cannot be undone. Pass confirm=${full} to do it.`,
        {
          errors: [
            {
              pointer: '/query/confirm',
              code: 'confirmation_required',
              message: `Send confirm=${full}.`,
            },
          ],
          hint: 'Check you are deleting the right repository, then repeat the request with ?confirm=owner/name.',
        },
      )
    if (dry) return { deleted: false, full }
    this.emit(
      repo,
      'repo.deleted',
      this.asActor(p),
      { object: 'repo', id: repo.id, number: null },
      ['deleted'],
      null,
    )
    this.repos.delete(full)
    this.aliases.delete(full.toLowerCase())
    for (const [key, value] of this.aliases)
      if (value.toLowerCase() === full.toLowerCase()) this.aliases.delete(key)
    this.memAuth.dropRepo(full)
    this.memUploads.dropRepo(repo.id)
    this.svc.git.dropRepo?.(full)
    this.deleted.set(full, repo.owner)
    this.deletedRepos.set(repo.id, { full, owner: repo.owner })
    this.deletedIds.set(full.toLowerCase(), repo.id)
    this.accessRevision++
    this.reposById.delete(repo.id)
    this.svc.hooks.dropRepo(full)
    this.svc.extras.drop(full)
    for (const t of this.teams.values())
      if (t.repos.delete(full)) {
        t.updated = this.now()
        t.version++
      }
    this.svc.search.reset()
    return { deleted: true, full }
  }

  async listAccounts(p: Principal): Promise<Array<z.infer<typeof S.Account>>> {
    const out: Array<z.infer<typeof S.Account>> = []
    for (const a of this.accounts.values())
      if (a.handle === p.handle || a.members.has(p.handle))
        out.push(this.presentAccount(a, p))
    return out
  }

  async getAccount(handle: string, p: Viewer) {
    const a = this.accounts.get(handle)
    if (!a) throw apiError('not_found', `No account ${handle}.`)
    return this.presentAccount(a, p)
  }

  async accountVersion(handle: string) {
    const a = this.accounts.get(handle)
    return a ? `${a.id}.${a.version}.${this.accessRevision}` : null
  }

  async listRepos(
    p: Viewer,
    q: { owner?: string; after: CursorPosition | null; limit: number },
  ): Promise<Page<z.infer<typeof S.Repo>>> {
    const all = [...this.repos.values()]
      .filter((r) => this.canRead(r, p) && (!q.owner || r.owner === q.owner))
      .sort((a, b) => b.created - a.created || (a.id < b.id ? 1 : -1))
    const page = pageSorted(all, (r) => r.created, recId, {
      limit: q.limit,
      after: q.after,
      desc: true,
      stored: 'desc',
    })
    return {
      items: page.items.map((r) => this.presentRepo(r)),
      next: page.next,
    }
  }

  gitAccess(owner: string, name: string, p: Viewer, need: 'read' | 'write') {
    const repo = this.resolve(owner, name, p, need)
    return Promise.resolve({
      storeId: repo.storeId,
      defaultBranch: repo.defaultBranch,
    })
  }

  async getRepo(owner: string, name: string, p: Viewer) {
    return this.presentRepo(this.resolve(owner, name, p))
  }

  async commitFacts(
    full: string,
    commits: ReadonlyArray<{ sha: string; author: { email: string } }>,
  ) {
    const repo = this.repos.get(full) ?? this.byLower(full.toLowerCase())
    const landed = new Map<string, ChangeRec>()
    if (repo)
      for (const c of repo.changes.values())
        if (c.state === 'landed') {
          const head = c.patchSets.at(-1)
          if (head) landed.set(head.sha, c)
        }
    return commits.map((c) => {
      const login = /^([a-z0-9-]+)@users\.cobaltforge\.dev$/.exec(
        c.author.email.toLowerCase(),
      )?.[1]
      const who = login ? this.actors.get(login) : undefined
      const change = landed.get(c.sha)
      const checks = change?.checks ?? []
      const facts = change
        ? {
            change: change.number,
            checks: checks.length
              ? checks.some((k) => k.state === 'fail')
                ? ('fail' as const)
                : ('pass' as const)
              : null,
          }
        : (repo?.sampleCommitFacts?.(c.sha) ?? { change: null, checks: null })
      return { actor: who ? this.actor(who) : null, ...facts }
    })
  }

  async getStar(owner: string, name: string, p: Viewer) {
    return this.presentStar(this.resolve(owner, name, p), p)
  }

  async setStar(
    owner: string,
    name: string,
    p: Principal,
    on: boolean,
    dry: boolean,
  ) {
    const repo = this.resolve(owner, name, p)
    const had = repo.starredBy.has(p.handle)
    if (had === on || dry)
      return {
        star: {
          ...this.presentStar(repo, p),
          starred: on,
          stars: repo.stars + (had === on ? 0 : on ? 1 : -1),
        },
        changed: had !== on,
      }
    if (on) {
      repo.starredBy.add(p.handle)
      repo.starTimes.push(this.now())
      if (repo.starTimes.length > 10_000) repo.starTimes.shift()
    } else {
      repo.starredBy.delete(p.handle)
      repo.starTimes.pop()
    }
    repo.stars += on ? 1 : -1
    repo.version++
    return { star: this.presentStar(repo, p), changed: true }
  }

  private presentStar(repo: RepoRec, p: Viewer) {
    return {
      object: 'star' as const,
      repo: `${repo.owner}/${repo.name}`,
      starred: !!p && repo.starredBy.has(p.handle),
      stars: repo.stars,
    }
  }

  async repoVersion(owner: string, name: string, p: Viewer) {
    return this.repoKey(this.resolve(owner, name, p))
  }

  async changeListVersion(owner: string, name: string, p: Viewer) {
    const r = this.resolve(owner, name, p)
    return `${r.id}.${r.changeRev}.${r.version}.${this.accessRevision}`
  }

  async issueListVersion(owner: string, name: string, p: Viewer) {
    const r = this.resolve(owner, name, p)
    return `${r.id}.${r.issueRev}.${r.version}.${this.accessRevision}`
  }

  protected repoKey(r: RepoRec) {
    return `${r.id}.${r.version}.${r.rev}.${r.changes.size}.${r.issues.size}.${this.accessRevision}`
  }

  async repoIdOf(owner: string, name: string, p: Viewer) {
    return this.resolve(owner, name, p).id
  }

  async bumpRepo(owner: string, name: string, p: Viewer) {
    const r = this.resolve(owner, name, p, 'write')
    r.updated = this.now()
    r.version++
  }

  async numberRef(owner: string, name: string, n: number, p: Viewer) {
    const r = this.resolve(owner, name, p)
    const type: 'change' | 'issue' | null = r.changes.has(n)
      ? 'change'
      : r.issues.has(n)
        ? 'issue'
        : null
    if (!type)
      throw apiError('not_found', `Nothing numbered #${n} in ${owner}/${name}.`)
    return {
      object: 'number_ref' as const,
      number: n,
      type,
      url: `${this.repoUrl(r)}/${type === 'change' ? 'changes' : 'issues'}/${n}`,
    }
  }

  async context(
    owner: string,
    name: string,
    p: Viewer,
  ): Promise<z.infer<typeof S.Context>> {
    const r = this.resolve(owner, name, p)
    const canPull = !p || p.scopes.has('pulls:read')
    const canIssue = !p || p.scopes.has('issues:read')
    const open: Array<ChangeRec> = []
    if (canPull)
      for (
        let k = r.byUpdated.items.length - 1;
        k >= 0 && open.length < 50;
        k--
      ) {
        const c = r.byUpdated.items[k]
        if (c.state === 'open' || c.state === 'draft') open.push(c)
      }
    const issues: Array<IssueRec> = []
    if (canIssue)
      for (
        let k = r.issuesByNumber.items.length - 1;
        k >= 0 && issues.length < 50;
        k--
      ) {
        const i = r.issuesByNumber.items[k]
        if (i.state === 'open') issues.push(i)
      }
    return {
      object: 'context',
      repo: this.presentRepo(r),
      changes: open.slice(0, 50).map((c) => {
        const reqs = this.evaluate(r, c)
        return {
          number: c.number,
          title: c.title,
          state: c.state,
          author: this.actor(c.author),
          checks: this.checksFor(c).state,
          policy: this.policyState(reqs),
          blocking: reqs
            .filter((q) => q.state === 'fail' || q.state === 'pending')
            .map((q) => `${q.id}:${q.state}`),
        }
      }),
      issues: issues.slice(0, 50).map((i) => ({
        number: i.number,
        title: i.title,
        labels: i.labels,
      })),
      policy: { rules: 4, mode: 'enforce' },
      env:
        p?.scopes.has('secrets:schema') && this.hasRepoGrant(r, p)
          ? this.memExtras.for(`${r.owner}/${r.name}`).env.map((v) => ({
              name: v.name,
              kind: v.kind,
              set: [...v.set],
            }))
          : [],
      cursor: `e_${r.id}_${this.events.head}`,
    }
  }
}
