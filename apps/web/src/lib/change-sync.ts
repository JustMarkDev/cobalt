export type Host = 'github' | 'gitlab' | 'codeberg' | 'gitea'

export const hostName: Record<Host, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  codeberg: 'Codeberg',
  gitea: 'Gitea',
}

export const hostTerms: Record<
  Host,
  { unit: string; short: string; ref: (n: number) => string }
> = {
  github: { unit: 'pull request', short: 'PR', ref: (n) => `#${n}` },
  gitlab: { unit: 'merge request', short: 'MR', ref: (n) => `!${n}` },
  codeberg: { unit: 'pull request', short: 'PR', ref: (n) => `#${n}` },
  gitea: { unit: 'pull request', short: 'PR', ref: (n) => `#${n}` },
}

export const draftMarker: Record<Host, { flag: true } | { prefix: string }> = {
  github: { flag: true },
  gitlab: { prefix: 'Draft: ' },
  codeberg: { prefix: 'WIP: ' },
  gitea: { prefix: 'WIP: ' },
}

export type ChangeState = 'open' | 'draft' | 'landed' | 'abandoned'
export type RemoteState = 'open' | 'draft' | 'merged' | 'closed'

const toRemoteState: Record<ChangeState, RemoteState> = {
  open: 'open',
  draft: 'draft',
  landed: 'merged',
  abandoned: 'closed',
}

const fromRemoteState: Record<RemoteState, ChangeState> = {
  open: 'open',
  draft: 'draft',
  merged: 'landed',
  closed: 'abandoned',
}

export type RemoteChange = {
  host: Host
  number: number
  title: string
  body: string
  state: RemoteState
  headRef: string
  baseRef: string
  headSha: string
}

export type LocalChange = {
  number: number
  title: string
  body: string
  state: ChangeState
  headSha: string
  branch: string
  parent?: { number: number; branch: string }
  baseBranch: string
}

const MARKER = /<!--\s*cobalt:change=(\d+)(?:\s+ps=(\d+))?\s*-->/

const slug = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')

export const branchFor = (number: number, title: string) =>
  `cb/${number}${slug(title) ? `-${slug(title)}` : ''}`

export function marker(number: number, patchSet: number) {
  return `<!-- cobalt:change=${number} ps=${patchSet} -->`
}

export function readMarker(body: string) {
  const m = MARKER.exec(body)
  return m
    ? { number: Number(m[1]), patchSet: m[2] ? Number(m[2]) : undefined }
    : null
}

const DRAFT_PREFIX = /^\s*(?:draft:|\[draft\]|wip:|\[wip\])\s*/i

export const stripDraft = (title: string) => title.replace(DRAFT_PREFIX, '')

export const isDraftTitle = (title: string) => DRAFT_PREFIX.test(title)

export function toRemote(
  change: LocalChange,
  host: Host,
  patchSet: number,
): Omit<RemoteChange, 'number'> {
  const state = toRemoteState[change.state]
  const draft = draftMarker[host]
  const asDraft = state === 'draft' && 'prefix' in draft
  return {
    host,
    title: asDraft ? `${draft.prefix}${change.title}` : change.title,
    body: `${change.body}\n\n${marker(change.number, patchSet)}`.trim(),
    state,
    headRef: change.branch,
    baseRef: change.parent ? change.parent.branch : change.baseBranch,
    headSha: change.headSha,
  }
}

export function fromRemote(
  remote: RemoteChange,
  nextNumber: number,
): {
  number: number
  title: string
  body: string
  state: ChangeState
  openedThere: boolean
} {
  const found = readMarker(remote.body)
  const state =
    remote.state === 'open' && isDraftTitle(remote.title)
      ? 'draft'
      : fromRemoteState[remote.state]
  return {
    number: found?.number ?? nextNumber,
    title: stripDraft(remote.title),
    body: remote.body.replace(MARKER, '').trim(),
    state,
    openedThere: !found,
  }
}

type Linked = Pick<RemoteChange, 'number' | 'headRef' | 'baseRef' | 'state'>

export type StackPlace = {
  number: number
  index: number
  of: number
  parent?: number
}

export function stacksFromRemotes(remotes: Array<Linked>) {
  const live = remotes
    .filter((r) => r.state === 'open' || r.state === 'draft')
    .sort((a, b) => a.number - b.number)
  const parentOf = (r: Linked) =>
    live.find((p) => p.number !== r.number && p.headRef === r.baseRef)
  const kids = (r: Linked) =>
    live.filter((c) => parentOf(c)?.number === r.number)

  const places = new Map<number, StackPlace>()
  const emit = (chain: Array<Linked>, forkedFrom?: number) => {
    if (chain.length < 2 && forkedFrom === undefined) return
    chain.forEach((r, i) =>
      places.set(r.number, {
        number: r.number,
        index: i + 1,
        of: chain.length,
        parent: i === 0 ? forkedFrom : chain[i - 1].number,
      }),
    )
  }
  const walk = (node: Linked, chain: Array<Linked>, forkedFrom?: number) => {
    chain.push(node)
    const next = kids(node)
    if (next.length === 1) return walk(next[0], chain, forkedFrom)
    emit(chain, forkedFrom)
    for (const k of next) walk(k, [], node.number)
  }
  for (const root of live.filter((r) => !parentOf(r))) walk(root, [])
  return places
}

export function afterParentLands(
  landed: Pick<RemoteChange, 'headRef'>,
  children: Array<Pick<RemoteChange, 'number' | 'baseRef'>>,
  defaultBranch: string,
) {
  return children
    .filter((c) => c.baseRef === landed.headRef)
    .map((c) => ({
      number: c.number,
      baseRef: defaultBranch,
      rebase: true as const,
    }))
}

export function patchSetsFromPushes(heads: Array<string>) {
  const seen: Array<string> = []
  for (const sha of heads) if (seen.at(-1) !== sha) seen.push(sha)
  return seen.map((tree, i) => ({ n: i + 1, tree }))
}

export type Verdict = 'approved' | 'changes' | 'commented'

export function remoteVerdict(host: Host, v: Verdict) {
  if (v === 'commented') return { kind: 'comment' } as const
  if (v === 'approved') return { kind: 'approval' } as const
  return host === 'gitlab'
    ? ({ kind: 'unresolved-thread' } as const)
    : ({ kind: 'request-changes' } as const)
}

export type Fit = 'syncs' | 'partial' | 'native'

export type Feature = {
  id: string
  label: string
  there: string
  fit: Fit | Partial<Record<Host, Fit>>
  note?: string
}

export const features: Array<Feature> = [
  {
    id: 'title',
    label: 'Title and description',
    there: 'The title and body. A hidden footer carries the change id.',
    fit: 'syncs',
  },
  {
    id: 'state',
    label: 'Draft, landed, abandoned',
    there: 'Draft, merged, closed.',
    fit: 'syncs',
    note: 'Where the host has no draft flag, the title gets a prefix.',
  },
  {
    id: 'patch-sets',
    label: 'Patch sets',
    there: 'Each patch set is a push to one stable branch.',
    fit: 'partial',
    note: 'The host shows pushes, not numbered patch sets. A comment names each one.',
  },
  {
    id: 'reviews',
    label: 'Approvals and requests for changes',
    there: 'Reviews on GitHub, Codeberg and Gitea. Approvals on GitLab.',
    fit: {
      github: 'syncs',
      codeberg: 'syncs',
      gitea: 'syncs',
      gitlab: 'partial',
    },
    note: 'GitLab has no review that blocks, so a request for changes becomes an unresolved thread.',
  },
  {
    id: 'comments',
    label: 'Comments and line threads',
    there: 'Review comments on the same lines.',
    fit: 'syncs',
  },
  {
    id: 'checks',
    label: 'Checks',
    there: 'Commit statuses on the pushed branch.',
    fit: 'syncs',
  },
  {
    id: 'labels',
    label: 'Labels',
    there: 'Labels, matched by name.',
    fit: 'syncs',
  },
  {
    id: 'stack',
    label: 'Stacks',
    there:
      'A chain of requests, each aimed at its parent branch. Read the same way when a stack is opened on the host.',
    fit: 'partial',
    note: 'Landing in order and rebasing the children is done here. On the host each one is merged by hand, and a merged parent re-aims its children, which become a new patch set here.',
  },
  {
    id: 'findings',
    label: 'Findings with severity',
    there: 'Line comments that start with the severity.',
    fit: 'partial',
    note: 'Whether a finding blocks landing is a policy here. The host sees only the comment.',
  },
  {
    id: 'policy',
    label: 'Policies as code',
    there: 'One required status, cobalt/policy.',
    fit: 'partial',
    note: 'The host can require the status. The rules themselves stay here.',
  },
  {
    id: 'media',
    label: 'Images and videos',
    there: 'Linked from the description.',
    fit: 'partial',
    note: 'Before and after pairs arrive as two images. Sliders and interactive previews stay here, and the host gets a link.',
  },
  {
    id: 'tests',
    label: 'Test results',
    there: 'A check with the pass and fail counts.',
    fit: 'partial',
    note: 'Which tests ran, what failed on the base, and the screenshots from before and after stay here.',
  },
  {
    id: 'interdiff',
    label: 'Compare patch sets',
    there: 'Nothing.',
    fit: 'native',
  },
  {
    id: 'carry',
    label: 'Approvals that follow a rewrite',
    there: 'Nothing. The host may mark an approval stale after a force-push.',
    fit: 'native',
  },
  {
    id: 'agents',
    label: 'Send a finding to an agent',
    there: 'Nothing.',
    fit: 'native',
  },
]

export function fitFor(feature: Feature, host: Host): Fit {
  return typeof feature.fit === 'string'
    ? feature.fit
    : (feature.fit[host] ?? 'syncs')
}

export function compatibility(host: Host) {
  const rows = features.map((f) => ({ ...f, fit: fitFor(f, host) }))
  return {
    syncs: rows.filter((r) => r.fit === 'syncs'),
    partial: rows.filter((r) => r.fit === 'partial'),
    native: rows.filter((r) => r.fit === 'native'),
  }
}
