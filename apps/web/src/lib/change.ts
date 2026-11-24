import type {
  Finding as ApiFinding,
  PatchSet as ApiPatchSet,
  Change,
  CheckRun,
  Evidence,
  PatchSetFiles,
} from '@cobaltforge/sdk'
import type {
  ChangeItem,
  FileVersions,
  Finding,
  PatchSet,
} from '~/lib/model/platform'
import type { Media, TestRun } from '~/lib/model/evidence'
import type { TimelineEvent } from '~/components/forge/change-timeline'
import { timeAgo } from '~/lib/repo'

const HOUR = 3_600_000

const ci = (c: Change): ChangeItem['ci'] =>
  c.checks.state === 'pass'
    ? 'pass'
    : c.checks.state === 'fail'
      ? 'fail'
      : 'pending'

export function toPatchSet(p: ApiPatchSet): PatchSet {
  return {
    n: p.number,
    when: timeAgo(p.created_at),
    note: p.note,
    tree: p.tree,
  }
}

export function toChangeItem(
  c: Change,
  patchSets?: Array<ApiPatchSet>,
): ChangeItem {
  return {
    id: String(c.number),
    title: c.title,
    author: { name: c.author.handle, kind: 'human', via: c.head.via },
    state: c.state === 'abandoned' ? 'abandoned' : c.state,
    stack: c.stack ? { index: c.stack.position, of: c.stack.size } : undefined,
    patchSets: patchSets
      ? patchSets.map(toPatchSet)
      : [{ n: c.head.patch_set, when: '', note: '', tree: c.head.tree }],
    files: c.stats.files,
    additions: c.stats.additions,
    deletions: c.stats.deletions,
    reviewers: c.reviewers.map((r) => ({
      name: r.actor.handle,
      kind: 'human',
      state: r.state,
    })),
    ci: ci(c),
    when: timeAgo(c.updated_at),
    mirror: c.mirrors[0]
      ? {
          host: c.mirrors[0].host as NonNullable<ChangeItem['mirror']>['host'],
          number: c.mirrors[0].number,
          origin: c.mirrors[0].origin,
        }
      : undefined,
    blocking: c.policy.state === 'blocked' ? c.policy.blocking : 0,
    stackId: c.stack?.id,
  }
}

export function toFinding(f: ApiFinding, humans: Set<string>): Finding {
  return {
    id: f.label,
    by: f.by,
    kind: humans.has(f.by) ? 'human' : 'reviewer',
    severity: f.severity,
    file: f.file,
    line: f.line,
    title: f.title,
    body: f.body,
    suggestion: f.suggestion
      ? {
          summary: f.suggestion.summary,
          file: f.suggestion.file,
          replace: f.suggestion.replace,
          after: f.suggestion.after ?? undefined,
          lines: f.suggestion.lines,
        }
      : undefined,
    prompt: f.prompt ?? undefined,
  }
}

export function toVersions(all: Array<PatchSetFiles>): {
  base: FileVersions
  versions: Array<FileVersions>
} {
  const base: FileVersions = {}
  for (const p of all)
    for (const f of p.files) if (!(f.path in base)) base[f.path] = f.base ?? ''
  return {
    base,
    versions: all.map((p) =>
      Object.fromEntries(p.files.map((f) => [f.path, f.content ?? ''])),
    ),
  }
}

export function toTestRun(checks: Array<CheckRun>): TestRun | undefined {
  const k = checks.find((x) => x.cases?.length)
  if (!k?.cases) return undefined
  return {
    runner: k.name,
    run: 0,
    tree: k.tree,
    origin: { by: k.name, kind: 'ci' },
    cases: k.cases.map((c) => ({
      suite: c.suite,
      name: c.name,
      ms: c.ms,
      base: c.base === 'skip' ? 'skipped' : c.base,
      head: c.head === 'skip' ? 'skipped' : c.head,
    })),
  }
}

export function toMedia(
  evidence: Array<
    Pick<Evidence, 'id' | 'caption' | 'created_by' | 'upload'> & {
      kind: Evidence['kind']
    }
  >,
): Array<Media> {
  const out: Array<Media> = []
  for (const e of evidence) {
    const src = e.upload.content_url
    if (!src || e.kind === 'test_results') continue
    const base = {
      id: e.id,
      origin: {
        by: e.created_by.handle,
        kind: 'human' as const,
      },
    }
    if (e.kind === 'image')
      out.push({ ...base, title: e.caption || 'Image', kind: 'image', src })
    else if (e.kind === 'recording')
      out.push({ ...base, title: e.caption || 'Recording', kind: 'video', src })
    else out.push({ ...base, title: e.caption || 'Preview', kind: 'page', src })
  }
  return out
}

const ago = (iso: string, now: number) =>
  Math.max(0, (now - Date.parse(iso)) / HOUR)

export function timelineOf(
  c: Change,
  patchSets: Array<ApiPatchSet>,
  findings: Array<ApiFinding>,
  checks: Array<CheckRun>,
  now = Date.now(),
): Array<TimelineEvent> {
  const out: Array<TimelineEvent> = [
    {
      kind: 'opened',
      who: c.author.handle,
      actor: 'human',
      what: `opened this change from ${c.branch}`,
      hoursAgo: ago(c.created_at, now),
    },
  ]
  for (const p of patchSets)
    out.push({
      kind: 'patchset',
      who: p.author.handle,
      actor: 'human',
      via: p.via,
      what: `pushed patch set ${p.number}`,
      detail: p.note,
      hoursAgo: ago(p.created_at, now),
      patchSet: p.number,
    })
  for (const f of findings)
    out.push({
      kind: 'finding',
      who: f.by,
      actor: 'bot',
      what: `left a ${f.severity} finding`,
      detail: `${f.label}: ${f.title}`,
      hoursAgo: ago(f.created_at, now),
      tone:
        f.severity === 'high'
          ? 'danger'
          : f.severity === 'medium'
            ? 'warning'
            : undefined,
    })
  for (const k of checks)
    if (k.state !== 'pending')
      out.push({
        kind: 'ci',
        who: k.name,
        actor: 'bot',
        what: `${k.state === 'pass' ? 'passed' : 'failed'} on tree ${k.tree}`,
        hoursAgo: ago(k.updated_at, now),
        tone: k.state === 'pass' ? 'success' : 'danger',
      })
  for (const r of c.reviewers)
    if (r.state !== 'pending' && r.patch_set !== null) {
      const at = patchSets.find((p) => p.number === r.patch_set)
      out.push({
        kind: 'review',
        who: r.actor.handle,
        actor: 'human',
        what:
          r.state === 'approved'
            ? `approved patch set ${r.patch_set}`
            : r.state === 'changes'
              ? `asked for changes on patch set ${r.patch_set}`
              : `commented on patch set ${r.patch_set}`,
        hoursAgo: at ? ago(at.created_at, now) - 0.01 : 0,
        tone: r.state === 'approved' ? 'success' : undefined,
      })
    }
  if (c.landed_at)
    out.push({
      kind: 'land',
      who: c.author.handle,
      actor: 'human',
      what: `landed #${c.number}`,
      hoursAgo: ago(c.landed_at, now),
      tone: 'success',
    })
  return out
}
