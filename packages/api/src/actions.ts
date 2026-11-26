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
  trigger: PipelineRunRec['trigger']
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

export type Matrix = Record<string, unknown>

/**
 * The combinations of a job's `strategy.matrix` (with `include` and
 * `exclude`), or one empty combination when it has none. The runner works
 * them out the same way to know the values of the job it took.
 */
export function matrixOf(job: Record<string, unknown>): Array<Matrix> {
  const strategy = job.strategy
  const m =
    strategy && typeof strategy === 'object'
      ? (strategy as Record<string, unknown>).matrix
      : undefined
  if (!m || typeof m !== 'object' || Array.isArray(m)) return [{}]
  const spec = m as Record<string, unknown>
  const keys = Object.keys(spec).filter(
    (k) => k !== 'include' && k !== 'exclude' && Array.isArray(spec[k]),
  )
  // Only `include`: the combinations are exactly those.
  let combos: Array<Matrix> = keys.length ? [{}] : []
  for (const [k, v] of Object.entries(spec)) {
    if (k === 'include' || k === 'exclude' || !Array.isArray(v)) continue
    combos = combos.flatMap((c) => v.map((x: unknown) => ({ ...c, [k]: x })))
  }
  const same = (c: Matrix, e: unknown) =>
    e &&
    typeof e === 'object' &&
    Object.entries(e as Matrix).every(
      ([k, v]) => JSON.stringify(c[k]) === JSON.stringify(v),
    )
  if (Array.isArray(spec.exclude))
    combos = combos.filter(
      (c) => !(spec.exclude as Array<unknown>).some((e) => same(c, e)),
    )
  if (Array.isArray(spec.include))
    for (const inc of spec.include as Array<unknown>) {
      if (!inc || typeof inc !== 'object') continue
      const add = inc as Matrix
      // An include that matches the original keys extends those combinations.
      const base = Object.keys(spec).filter(
        (k) => k !== 'include' && k !== 'exclude',
      )
      const hits = combos.filter((c) =>
        base.every(
          (k) => !(k in add) || JSON.stringify(c[k]) === JSON.stringify(add[k]),
        ),
      )
      if (hits.length && base.some((k) => k in add))
        for (const h of hits) Object.assign(h, add)
      else combos.push({ ...add })
    }
  return combos.length ? combos : [{}]
}

/** `Build (macos-latest, 20)`: the job and its matrix values, as GitHub names it. */
export function jobName(base: string, m: Matrix): string {
  const values = Object.values(m).filter(
    (v) =>
      typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean',
  )
  const named = substituteMatrix(base, m)
  if (named !== base || !values.length) return named
  return `${base} (${values.join(', ')})`
}

/** `${{ matrix.os }}` with its value. */
export function substituteMatrix(text: string, m: Matrix): string {
  return text.replace(/\$\{\{\s*matrix\.([\w-]+)\s*\}\}/g, (_, k: string) =>
    k in m ? String(m[k]) : '',
  )
}

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
    const all = isObj(doc.jobs) ? doc.jobs : {}
    // A job is named by its name, and once per matrix combination.
    const namesOf = (key: string): Array<string> => {
      const raw = all[key]
      if (!isObj(raw)) return []
      const base = typeof raw.name === 'string' && raw.name ? raw.name : key
      return matrixOf(raw).map((m) => jobName(base, m))
    }
    for (const [key, raw] of Object.entries(all)) {
      if (!isObj(raw)) continue
      const base = typeof raw.name === 'string' && raw.name ? raw.name : key
      if ('uses' in raw) {
        annotations.push({
          level: 'warn',
          text: `Job ${base} calls a reusable workflow (${String(raw.uses)}), which cobalt runners do not run yet.`,
          job: base,
          step: '',
        })
        continue
      }
      const needs = (strings(raw.needs) ?? []).flatMap(namesOf)
      for (const m of matrixOf(raw)) {
        const name = jobName(base, m)
        const labels = (strings(raw['runs-on']) ?? []).map((l) =>
          substituteMatrix(l, m).toLowerCase(),
        )
        const steps = (Array.isArray(raw.steps) ? raw.steps : [])
          .filter(isObj)
          .map((s, i) => {
            const uses = typeof s.uses === 'string' ? s.uses : null
            const run = typeof s.run === 'string' ? s.run : null
            const stepName = substituteMatrix(
              typeof s.name === 'string' && s.name
                ? s.name
                : run
                  ? (run.split('\n')[0] ?? '').slice(0, 80)
                  : uses
                    ? `Run ${uses}`
                    : `Step ${i + 1}`,
              m,
            )
            if (uses?.startsWith('docker://'))
              annotations.push({
                level: 'warn',
                text: `${uses} runs in a container, which cobalt runners do not do yet: the step is skipped.`,
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
          runsOn: labels,
          ...(needs.length ? { needs } : {}),
          runnerId: null,
          lease: null,
          steps,
        })
      }
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
