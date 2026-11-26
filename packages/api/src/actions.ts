// GitHub Actions workflows (.github/workflows/*.yml) as cobalt pipelines: a
// push starts every workflow whose `on:` takes it, and a runner (cb runner
// start) runs each job's `run:` steps. What a runner cannot do, such as
// `uses:` actions other than checkout, is said on the run, not hidden.
import { parse } from 'yaml'
import { globMatcher } from './glob'
import { newId } from './ids'
import type { PipelineRunRec } from './domain/records'

export const WORKFLOWS_DIR = '.github/workflows'

export const isWorkflowFile = (path: string) =>
  path.startsWith(`${WORKFLOWS_DIR}/`) &&
  !path.slice(WORKFLOWS_DIR.length + 1).includes('/') &&
  /\.ya?ml$/.test(path)

export type PushEvent = {
  ref: string
  sha: string
  actor: string
}

export type Planned = {
  workflow: string
  file: string
  branch: string
  sha: string
  trigger: 'push' | 'tag'
  jobs: PipelineRunRec['jobs']
  annotations: PipelineRunRec['annotations']
}

type Obj = Record<string, unknown>
const isObj = (x: unknown): x is Obj =>
  Boolean(x) && typeof x === 'object' && !Array.isArray(x)
const strings = (x: unknown): Array<string> | null =>
  typeof x === 'string'
    ? [x]
    : Array.isArray(x) && x.every((y) => typeof y === 'string')
      ? x
      : null

/** Steps a runner does itself instead of running the action. */
const BUILT_IN: Array<[RegExp, string]> = [
  [/^actions\/checkout@/, 'The runner checks out the commit itself.'],
]

/** Whether `on:` takes a push of `ref`. Path filters are not applied. */
export function takesPush(
  on: unknown,
  ref: string,
): { yes: boolean; note: string | null } {
  const branch = ref.startsWith('refs/heads/')
    ? ref.slice('refs/heads/'.length)
    : null
  const tag = ref.startsWith('refs/tags/')
    ? ref.slice('refs/tags/'.length)
    : null
  const events = strings(on)
  if (events) return { yes: events.includes('push'), note: null }
  if (!isObj(on) || !('push' in on)) return { yes: false, note: null }
  const push = on.push
  if (!isObj(push)) return { yes: true, note: null }
  const match = (globs: unknown, name: string | null) => {
    const g = strings(globs)
    return g === null || name === null
      ? null
      : g.some((x) => globMatcher(x).test(name))
  }
  const hasBranches = 'branches' in push || 'branches-ignore' in push
  const hasTags = 'tags' in push || 'tags-ignore' in push
  let yes: boolean
  if (branch !== null) {
    if (!hasBranches && hasTags) yes = false
    else if ('branches' in push) yes = match(push.branches, branch) === true
    else if ('branches-ignore' in push)
      yes = match(push['branches-ignore'], branch) !== true
    else yes = true
  } else if (tag !== null) {
    if (!hasTags && hasBranches) yes = false
    else if ('tags' in push) yes = match(push.tags, tag) === true
    else if ('tags-ignore' in push)
      yes = match(push['tags-ignore'], tag) !== true
    else yes = true
  } else yes = false
  const note =
    yes && ('paths' in push || 'paths-ignore' in push)
      ? 'on.push has path filters; cobalt starts the workflow on every matching push.'
      : null
  return { yes, note }
}

/**
 * The runs a push starts: one per workflow file whose `on:` takes it, each
 * job with its steps and runs-on labels, queued for a runner.
 */
export function planPush(
  files: Record<string, string>,
  push: PushEvent,
): Array<Planned> {
  const out: Array<Planned> = []
  const branch = push.ref.replace(/^refs\/(heads|tags)\//, '')
  for (const [file, text] of Object.entries(files).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (!isWorkflowFile(file)) continue
    let doc: unknown
    try {
      doc = parse(text)
    } catch {
      continue
    }
    if (!isObj(doc)) continue
    // `on` reads as `true` in YAML 1.1; the yaml package keeps it as "on".
    const on = doc.on ?? (doc as Record<string, unknown>)['true']
    const takes = takesPush(on, push.ref)
    if (!takes.yes) continue
    const annotations: Planned['annotations'] = []
    if (takes.note)
      annotations.push({ level: 'warn', text: takes.note, job: '', step: '' })
    const jobs: Planned['jobs'] = []
    for (const [key, raw] of Object.entries(isObj(doc.jobs) ? doc.jobs : {})) {
      if (!isObj(raw)) continue
      const name = typeof raw.name === 'string' && raw.name ? raw.name : key
      if ('uses' in raw) {
        annotations.push({
          level: 'warn',
          text: `Job ${name} calls a reusable workflow (${String(raw.uses)}), which cobalt runners do not run.`,
          job: name,
          step: '',
        })
        continue
      }
      if (isObj(raw.strategy) && 'matrix' in raw.strategy)
        annotations.push({
          level: 'warn',
          text: `Job ${name} has a matrix; cobalt runs it once, with the matrix values unset.`,
          job: name,
          step: '',
        })
      if ('needs' in raw)
        annotations.push({
          level: 'warn',
          text: `Job ${name} needs other jobs; cobalt does not wait for them.`,
          job: name,
          step: '',
        })
      const labels = strings(raw['runs-on'])
      const steps = (Array.isArray(raw.steps) ? raw.steps : [])
        .filter(isObj)
        .map((s, i) => {
          const uses = typeof s.uses === 'string' ? s.uses : null
          const run = typeof s.run === 'string' ? s.run : null
          const stepName =
            typeof s.name === 'string' && s.name
              ? s.name
              : run
                ? (run.split('\n')[0] ?? '').slice(0, 80)
                : uses
                  ? `Run ${uses}`
                  : `Step ${i + 1}`
          if (uses && !BUILT_IN.some(([re]) => re.test(uses)))
            annotations.push({
              level: 'warn',
              text: `${uses} is a GitHub Action; a cobalt runner skips it and runs only run: steps. Install what it sets up on the runner.`,
              job: name,
              step: stepName,
            })
          return {
            name: stepName,
            status: 'queued' as const,
            duration: 0,
            lines: [],
            wait: null,
          }
        })
      jobs.push({
        name,
        runner: '',
        status: 'queued',
        duration: 0,
        runsOn: (labels ?? []).map((l) => l.toLowerCase()),
        runnerId: null,
        lease: null,
        steps,
      })
    }
    if (!jobs.length) continue
    out.push({
      workflow:
        typeof doc.name === 'string' && doc.name
          ? doc.name
          : (file.split('/').pop() ?? file).replace(/\.ya?ml$/, ''),
      file,
      branch,
      sha: push.sha,
      trigger: push.ref.startsWith('refs/tags/') ? 'tag' : 'push',
      jobs,
      annotations,
    })
  }
  return out
}

/** A queued run of a planned workflow, numbered `number`. */
export function runOf(
  p: Planned,
  a: { number: number; actor: string; at: number },
): PipelineRunRec {
  return {
    id: newId('pipeline', a.at),
    number: a.number,
    workflow: p.workflow,
    title: `${p.workflow} on ${p.branch}`,
    branch: p.branch,
    sha: p.sha,
    status: 'queued',
    trigger: p.trigger,
    actor: a.actor,
    started: a.at,
    finished: null,
    file: p.file,
    annotations: p.annotations,
    jobs: p.jobs,
    version: 1,
  }
}
