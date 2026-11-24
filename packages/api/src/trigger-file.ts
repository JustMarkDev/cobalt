import { LineCounter, isMap, isSeq, parseDocument } from 'yaml'
import { matchesType } from './events'
import { globMatcher } from './glob'

export const TRIGGERS_DIR = '.source/triggers'
export const MAX_TRIGGERS = 20
export const MAX_RUNS_PER_EVENT = 3

export type Trigger = {
  id: string
  on: Array<string>
  filter: {
    paths: Array<string> | null
    labels: Array<string> | null
    actor: Array<string> | null
    model: Array<string> | null
  }
  run: string
  file: string
}

export type FileError = {
  file: string
  path: string
  line: number | null
  message: string
}

export function isTriggerFile(path: string) {
  if (!path.startsWith(`${TRIGGERS_DIR}/`)) return false
  const rest = path.slice(TRIGGERS_DIR.length + 1)
  return !rest.includes('/') && /\.ya?ml$/.test(rest)
}

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/
const EVENT = /^[a-z_]+\.([a-z_]+|\*)$/
const KEYS = new Set(['id', 'on', 'filter', 'run'])
const FILTER_KEYS = new Set(['paths', 'labels', 'actor', 'model'])
const ACTIONS = new Set(['run'])

function badGlob(g: string) {
  if (!g.trim()) return 'A glob is not empty.'
  if (g.startsWith('/'))
    return `${g}: globs are relative to the repository root.`
  if (g.includes('\\')) return `${g}: use / between folders.`
  if (g.split('/').includes('..'))
    return `${g}: a glob stays inside the repository.`
  if (g.includes('***')) return `${g}: use * or **, not ***.`
  return null
}

const list = (v: unknown) =>
  typeof v === 'string' ? [v] : Array.isArray(v) ? (v as Array<unknown>) : null

export function parseTriggers(
  text: string,
  file = `${TRIGGERS_DIR}/triggers.yml`,
): { triggers: Array<Trigger> | null; errors: Array<FileError> } {
  const lc = new LineCounter()
  const d = parseDocument(text, { lineCounter: lc, prettyErrors: false })
  const errors: Array<FileError> = []
  const lineOf = (n: unknown): number | null => {
    const range = (n as { range?: [number, number, number] } | null)?.range
    return range ? lc.linePos(range[0]).line : null
  }
  const err = (path: string, node: unknown, message: string) =>
    errors.push({ file, path, line: lineOf(node), message })
  for (const e of d.errors)
    errors.push({
      file,
      path: '',
      line: e.linePos?.[0].line ?? null,
      message: e.message.split('\n')[0],
    })
  if (errors.length) return { triggers: null, errors }
  const root = d.contents
  if (root === null) return { triggers: [], errors }
  if (!isMap(root)) {
    err('', root, 'The file is a map with a triggers list.')
    return { triggers: null, errors }
  }
  for (const pair of root.items) {
    const key = (pair.key as { value?: unknown } | null)?.value
    if (key !== 'triggers')
      err(String(key), pair.key, `Unknown key ${String(key)}. Use triggers.`)
  }
  const js = d.toJS({ maxAliasCount: 0 }) as { triggers?: unknown }
  const node = root.get('triggers', true)
  const all = js.triggers ?? []
  if (!Array.isArray(all)) {
    err('triggers', node, 'triggers is a list.')
    return { triggers: null, errors }
  }
  const out: Array<Trigger> = []
  const ids = new Set<string>()
  all.forEach((raw: unknown, i) => {
    const at = `triggers[${i}]`
    const n = isSeq(node) ? node.items[i] : node
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      return err(at, n, 'A trigger is a map with an id, on and run.')
    const t = raw as Record<string, unknown>
    for (const k of Object.keys(t))
      if (!KEYS.has(k))
        err(
          `${at}.${k}`,
          n,
          `Unknown key ${k}. A trigger has id, on, filter and run.`,
        )
    const id = t.id
    if (typeof id !== 'string' || !ID.test(id))
      return err(`${at}.id`, n, 'id is lowercase letters, digits and dashes.')
    if (ids.has(id)) err(`${at}.id`, n, `Two triggers are called ${id}.`)
    ids.add(id)
    const on = list(t.on)
    if (!on?.length || !on.every((x) => typeof x === 'string'))
      return err(`${at}.on`, n, 'on is an event type or a list of them.')
    for (const e of on) {
      if (e === '*' || e.startsWith('pipeline.'))
        err(
          `${at}.on`,
          n,
          `${e}: a pipeline event cannot start a pipeline, so a trigger cannot loop.`,
        )
      else if (!EVENT.test(e))
        err(`${at}.on`, n, `${e} is not an event type such as change.landed.`)
    }
    const actions = Object.keys(t).filter((k) => ACTIONS.has(k))
    if (actions.length !== 1)
      return err(at, n, 'A trigger has exactly one action: run.')
    if (typeof t.run !== 'string' || !/^[\w.-]{1,100}$/.test(t.run))
      return err(`${at}.run`, n, 'run names a workflow.')
    const f = (t.filter ?? {}) as Record<string, unknown>
    if (typeof f !== 'object' || Array.isArray(f))
      return err(`${at}.filter`, n, 'filter is a map.')
    for (const k of Object.keys(f))
      if (!FILTER_KEYS.has(k))
        err(
          `${at}.filter.${k}`,
          n,
          `Unknown filter ${k}. Use paths, labels, actor or model.`,
        )
    const strings = (k: string) => {
      if (f[k] === undefined || f[k] === null) return null
      const v = list(f[k])
      if (!v?.length || !v.every((x) => typeof x === 'string' && x)) {
        err(`${at}.filter.${k}`, n, `${k} is a value or a list of them.`)
        return null
      }
      return v as Array<string>
    }
    const paths = strings('paths')
    for (const g of paths ?? []) {
      const bad = badGlob(g)
      if (bad) err(`${at}.filter.paths`, n, bad)
    }
    out.push({
      id,
      on: on,
      filter: {
        paths,
        labels: strings('labels'),
        actor: strings('actor'),
        model: strings('model'),
      },
      run: t.run,
      file,
    })
  })
  return errors.length ? { triggers: null, errors } : { triggers: out, errors }
}

export function parseTriggerFiles(files: Record<string, string>): {
  triggers: Array<Trigger> | null
  errors: Array<FileError>
} {
  const errors: Array<FileError> = []
  const all: Array<Trigger> = []
  for (const file of Object.keys(files).sort()) {
    const r = parseTriggers(files[file], file)
    errors.push(...r.errors)
    if (r.triggers) all.push(...r.triggers)
  }
  const seen = new Map<string, string>()
  for (const t of all) {
    const other = seen.get(t.id)
    if (other && other !== t.file)
      errors.push({
        file: t.file,
        path: 'id',
        line: null,
        message: `${t.id} is also in ${other}; ids are unique across trigger files.`,
      })
    seen.set(t.id, t.file)
  }
  if (all.length > MAX_TRIGGERS)
    errors.push({
      file: TRIGGERS_DIR,
      path: '',
      line: null,
      message: `${all.length} triggers; a repository has at most ${MAX_TRIGGERS}.`,
    })
  return errors.length ? { triggers: null, errors } : { triggers: all, errors }
}

export type TriggerEvent = {
  type: string
  actor: string
  model: string | null
  files: ReadonlyArray<string>
  labels: ReadonlyArray<string>
}

export function triggerMatches(t: Trigger, e: TriggerEvent) {
  if (!matchesType(t.on, e.type)) return false
  const f = t.filter
  if (f.paths) {
    const ms = f.paths.map(globMatcher)
    if (!e.files.some((p) => ms.some((m) => m.test(p)))) return false
  }
  if (f.labels) {
    const have = new Set(e.labels.map((l) => l.toLowerCase()))
    if (!f.labels.some((l) => have.has(l.toLowerCase()))) return false
  }
  if (f.actor && !f.actor.includes(e.actor)) return false
  if (f.model) {
    const m = e.model?.toLowerCase()
    if (!m || !f.model.some((x) => x.toLowerCase() === m)) return false
  }
  return true
}

export function triggersFor(triggers: ReadonlyArray<Trigger>, e: TriggerEvent) {
  const hit = triggers.filter((t) => triggerMatches(t, e))
  return {
    start: hit.slice(0, MAX_RUNS_PER_EVENT),
    capped: hit.slice(MAX_RUNS_PER_EVENT),
  }
}
