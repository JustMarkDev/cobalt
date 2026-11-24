export const inboxSeverities = [
  'stopped',
  'failing',
  'blocked',
  'review',
  'handoff',
  'assigned',
  'mention',
] as const
export type InboxSeverity = (typeof inboxSeverities)[number]

export const inboxActions = [
  'open',
  'review',
  'fix',
  'retry',
  'resume',
  'answer',
] as const
export type InboxAction = (typeof inboxActions)[number]

export const inboxKinds = [
  'mirror_stopped',
  'main_failing',
  'change_blocked',
  'checks_failing',
  'review_requested',
  'pipeline_waiting',
  'runner_missing',
  'issue_assigned',
  'mention',
] as const
export type InboxKind = (typeof inboxKinds)[number]

export type NeedsFacts = {
  mirrors: Array<{
    repo: string
    host: string
    detail: string | null
    lastSync: number
  }>
  mainFailures: Array<{
    repo: string
    number: number
    workflow: string
    title: string
    started: number
  }>
  toReview: Array<{
    repo: string
    number: number
    title: string
    author: string
    updated: number
  }>
  assigned: Array<{
    repo: string
    number: number
    title: string
    updated: number
  }>
  blocked?: Array<{
    repo: string
    number: number
    title: string
    updated: number
    blocking: number
  }>
  checksFailing?: Array<{
    repo: string
    number: number
    title: string
    updated: number
    failed: number
  }>
  mentions?: Array<{
    id: string
    title: string
    repo: string | null
    path: string
    created: number
  }>
  waiting?: Array<{
    repo: string
    run: number
    job: number
    step: number
    workflow: string
    stepName: string
    reason: string
    expires: number
    since: number
  }>
  noRunner?: Array<{
    repo: string
    run: number
    workflow: string
    labels: Array<string>
    started: number
  }>
}

export type Need = {
  id: string
  kind: InboxKind
  severity: InboxSeverity
  title: string
  repo: string | null
  note: string
  at: number
  action: InboxAction
  label: string
  path: string
  subject: { type: 'change' | 'issue' | 'run'; number: number } | null
}

const rank = Object.fromEntries(
  inboxSeverities.map((s, i) => [s, i]),
) as Record<InboxSeverity, number>

const path = (full: string, tail = '') => `/${full}${tail}`

export function needsFrom(f: NeedsFacts): Array<Need> {
  const out: Array<Need> = []
  for (const m of f.mirrors)
    out.push({
      id: `mirror:${m.repo}:${m.host}`,
      kind: 'mirror_stopped',
      severity: 'stopped',
      title: `Mirror to ${m.host} stopped`,
      repo: m.repo,
      note: m.detail ?? 'It stopped syncing.',
      at: m.lastSync,
      action: 'fix',
      label: 'Reconnect',
      path: path(m.repo, '/settings?section=mirrors'),
      subject: null,
    })
  for (const r of f.mainFailures)
    out.push({
      id: `main:${r.repo}:${r.number}`,
      kind: 'main_failing',
      severity: 'failing',
      title: `${r.workflow} is failing on main`,
      repo: r.repo,
      note: r.title,
      at: r.started,
      action: 'retry',
      label: 'See the run',
      path: path(r.repo, `/pipelines?n=${r.number}`),
      subject: { type: 'run', number: r.number },
    })
  for (const c of f.checksFailing ?? [])
    out.push({
      id: `checks:${c.repo}:${c.number}`,
      kind: 'checks_failing',
      severity: 'failing',
      title: `Checks failed on #${c.number} ${c.title}`,
      repo: c.repo,
      note: `${c.failed} failing on the newest patch set.`,
      at: c.updated,
      action: 'fix',
      label: 'Fix',
      path: path(c.repo, `/changes?n=${c.number}`),
      subject: { type: 'change', number: c.number },
    })
  for (const c of f.blocked ?? [])
    out.push({
      id: `blocked:${c.repo}:${c.number}`,
      kind: 'change_blocked',
      severity: 'blocked',
      title: `#${c.number} ${c.title} is blocked`,
      repo: c.repo,
      note: `Policy blocks it: ${c.blocking} requirement${c.blocking === 1 ? '' : 's'} not met.`,
      at: c.updated,
      action: 'fix',
      label: 'See why',
      path: path(c.repo, `/changes?n=${c.number}`),
      subject: { type: 'change', number: c.number },
    })
  for (const r of f.noRunner ?? [])
    out.push({
      id: `runner:${r.repo}:${r.run}`,
      kind: 'runner_missing',
      severity: 'blocked',
      title: `${r.workflow} #${r.run} has no runner`,
      repo: r.repo,
      note: `Waiting for a runner with: ${r.labels.join(', ')}.`,
      at: r.started,
      action: 'open',
      label: 'See the run',
      path: path(r.repo, `/pipelines?n=${r.run}`),
      subject: { type: 'run', number: r.run },
    })
  for (const c of f.toReview)
    out.push({
      id: `review:${c.repo}:${c.number}`,
      kind: 'review_requested',
      severity: 'review',
      title: `Review #${c.number} ${c.title}`,
      repo: c.repo,
      note: `${c.author} opened it.`,
      at: c.updated,
      action: 'review',
      label: 'Review',
      path: path(c.repo, `/changes?n=${c.number}`),
      subject: { type: 'change', number: c.number },
    })
  for (const w of f.waiting ?? [])
    out.push({
      id: `wait:${w.repo}:${w.run}:${w.job}:${w.step}`,
      kind: 'pipeline_waiting',
      severity: 'handoff',
      title: `${w.workflow} #${w.run} waits on you at ${w.stepName}`,
      repo: w.repo,
      note: w.reason,
      at: w.since,
      action: 'resume',
      label: 'Resume',
      path: path(w.repo, `/pipelines?n=${w.run}&job=${w.job}`),
      subject: { type: 'run', number: w.run },
    })
  for (const i of f.assigned)
    out.push({
      id: `issue:${i.repo}:${i.number}`,
      kind: 'issue_assigned',
      severity: 'assigned',
      title: `#${i.number} ${i.title}`,
      repo: i.repo,
      note: 'Assigned to you.',
      at: i.updated,
      action: 'open',
      label: 'Open',
      path: path(i.repo, `/issues?n=${i.number}`),
      subject: { type: 'issue', number: i.number },
    })
  for (const m of f.mentions ?? []) {
    const n = /[?&]n=(\d+)/.exec(m.path)
    out.push({
      id: `mention:${m.id}`,
      kind: 'mention',
      severity: 'mention',
      title: m.title,
      repo: m.repo,
      note: 'You were mentioned.',
      at: m.created,
      action: 'answer',
      label: 'Answer',
      path: m.path,
      subject: n
        ? {
            type: m.path.includes('/issues') ? 'issue' : 'change',
            number: Number(n[1]),
          }
        : null,
    })
  }
  return out
}

export function sortNeeds(items: Array<Need>) {
  return [...items].sort(
    (a, b) => rank[a.severity] - rank[b.severity] || b.at - a.at,
  )
}

export const INBOX_MAX = 100

export function presentInbox(items: Array<Need>, limit: number) {
  const sorted = sortNeeds(items)
  const counts = Object.fromEntries(
    inboxSeverities.map((s) => [s, 0]),
  ) as Record<InboxSeverity, number>
  for (const x of sorted) counts[x.severity]++
  return {
    object: 'inbox' as const,
    items: sorted.slice(0, limit).map((x) => ({
      object: 'inbox_item' as const,
      id: x.id,
      kind: x.kind,
      severity: x.severity,
      title: x.title,
      repo: x.repo,
      note: x.note,
      action: x.action,
      path: x.path,
      subject: x.subject,
      created_at: new Date(x.at).toISOString(),
    })),
    counts: { ...counts, total: sorted.length },
  }
}

export function dashboardNeeds(items: Array<Need>) {
  const order = { stopped: 0, failing: 1, review: 2, assigned: 3 } as const
  type Shown = keyof typeof order
  return items
    .filter(
      (x): x is Need & { severity: Shown } =>
        x.kind === 'mirror_stopped' ||
        x.kind === 'main_failing' ||
        x.kind === 'review_requested' ||
        x.kind === 'issue_assigned',
    )
    .sort((a, b) => order[a.severity] - order[b.severity])
    .map((x) => ({
      severity: x.severity,
      title: x.title,
      repo: x.repo ?? '',
      note: x.note,
      at: new Date(x.at).toISOString(),
      action: x.label,
      path: x.path,
    }))
}
