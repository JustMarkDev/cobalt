// Run one job of a GitHub Actions workflow on this machine, as GitHub's own
// runner would: run: steps in bash, JavaScript and composite actions from
// their repositories (actions/checkout is the checkout the runner already
// did), ${{ }} expressions, if:, env, outputs, GITHUB_ENV and GITHUB_PATH.
// Docker actions are not run.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { jobName, matrixOf } from '@cobaltforge/api/actions'

type Obj = Record<string, unknown>
const isObj = (x: unknown): x is Obj =>
  Boolean(x) && typeof x === 'object' && !Array.isArray(x)

export type Line = { text: string; level: string | null }
export type StepResult = {
  status: 'success' | 'failure' | 'skipped'
  lines: Array<Line>
  durationMs: number
}

export type Context = {
  github: Obj
  runner: Obj
  env: Record<string, string>
  matrix: Obj
  steps: Record<
    string,
    { outputs: Record<string, string>; outcome: string; conclusion: string }
  >
  inputs: Obj
  secrets: Obj
  job: { status: string }
}

// ---------- expressions ----------

type Tok = { t: 'str' | 'num' | 'id' | 'op' | 'p'; v: string }

function tokens(src: string): Array<Tok> {
  const out: Array<Tok> = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (c === "'") {
      let j = i + 1
      let s = ''
      while (j < src.length) {
        if (src[j] === "'" && src[j + 1] === "'") {
          s += "'"
          j += 2
        } else if (src[j] === "'") break
        else s += src[j++]
      }
      out.push({ t: 'str', v: s })
      i = j + 1
      continue
    }
    const two = src.slice(i, i + 2)
    if (['==', '!=', '&&', '||', '<=', '>='].includes(two)) {
      out.push({ t: 'op', v: two })
      i += 2
      continue
    }
    if ('!<>'.includes(c)) {
      out.push({ t: 'op', v: c })
      i++
      continue
    }
    if ('(),[]'.includes(c)) {
      out.push({ t: 'p', v: c })
      i++
      continue
    }
    const num = /^-?\d+(\.\d+)?/.exec(src.slice(i))
    if (num) {
      out.push({ t: 'num', v: num[0] })
      i += num[0].length
      continue
    }
    const id = /^[A-Za-z_][\w-]*(\.[\w-]+|\.\*)*/.exec(src.slice(i))
    if (id) {
      out.push({ t: 'id', v: id[0] })
      i += id[0].length
      continue
    }
    i++
  }
  return out
}

/** A value as text: objects as JSON, nothing as empty. */
const asText = (v: unknown): string =>
  v === null || v === undefined
    ? ''
    : typeof v === 'string'
      ? v
      : typeof v === 'number' || typeof v === 'boolean'
        ? `${v}`
        : JSON.stringify(v)

const truthy = (v: unknown) =>
  v !== null && v !== undefined && v !== false && v !== 0 && v !== ''

/** Evaluate a GitHub Actions expression (without the ${{ }}). */
export function evaluate(src: string, ctx: Context): unknown {
  const ts = tokens(src)
  let pos = 0
  const peek = () => ts[pos] as Tok | undefined
  const next = () => ts[pos++]
  const lookup = (path: string): unknown => {
    const parts = path.split('.')
    let cur: unknown = ctx
    for (const p of parts) {
      if (!isObj(cur)) return undefined
      cur = cur[p]
    }
    return cur
  }
  const call = (name: string, args: Array<unknown>): unknown => {
    const s = (x: unknown) => asText(x).toLowerCase()
    switch (name.toLowerCase()) {
      case 'success':
        return ctx.job.status === 'success'
      case 'failure':
        return ctx.job.status === 'failure'
      case 'always':
        return true
      case 'cancelled':
        return false
      case 'contains':
        return Array.isArray(args[0])
          ? args[0].map(s).includes(s(args[1]))
          : s(args[0]).includes(s(args[1]))
      case 'startswith':
        return s(args[0]).startsWith(s(args[1]))
      case 'endswith':
        return s(args[0]).endsWith(s(args[1]))
      case 'format':
        return asText(args[0]).replace(/\{(\d+)\}/g, (_, n: string) =>
          asText(args[Number(n) + 1]),
        )
      case 'tojson':
        return JSON.stringify(args[0], null, 2)
      case 'fromjson':
        try {
          return JSON.parse(String(args[0]))
        } catch {
          return null
        }
      case 'hashfiles':
        return ''
      default:
        return ''
    }
  }
  const primary = (): unknown => {
    const t = next() as Tok | undefined
    if (!t) return ''
    if (t.t === 'str') return t.v
    if (t.t === 'num') return Number(t.v)
    if (t.t === 'op' && t.v === '!') return !truthy(primary())
    if (t.t === 'p' && t.v === '(') {
      const v = or()
      next()
      return v
    }
    if (t.t === 'id') {
      if (t.v === 'true') return true
      if (t.v === 'false') return false
      if (t.v === 'null') return null
      if (peek()?.v === '(') {
        next()
        const args: Array<unknown> = []
        while (peek() && peek()!.v !== ')') {
          args.push(or())
          if (peek()?.v === ',') next()
        }
        next()
        return call(t.v, args)
      }
      let v = lookup(t.v)
      while (peek()?.v === '[') {
        next()
        const k = or()
        next()
        v = isObj(v)
          ? v[String(k)]
          : Array.isArray(v)
            ? v[Number(k)]
            : undefined
      }
      return v
    }
    return ''
  }
  const compare = (): unknown => {
    let l = primary()
    while (
      peek()?.t === 'op' &&
      ['==', '!=', '<', '>', '<=', '>='].includes(peek()!.v)
    ) {
      const op = next().v
      const r = primary()
      const a = typeof l === 'string' ? l.toLowerCase() : l
      const b = typeof r === 'string' ? r.toLowerCase() : r
      l =
        op === '=='
          ? a == b // eslint-disable-line eqeqeq -- GitHub compares loosely
          : op === '!='
            ? a != b // eslint-disable-line eqeqeq
            : op === '<'
              ? Number(a) < Number(b)
              : op === '>'
                ? Number(a) > Number(b)
                : op === '<='
                  ? Number(a) <= Number(b)
                  : Number(a) >= Number(b)
    }
    return l
  }
  const and = (): unknown => {
    let l = compare()
    while (peek()?.v === '&&') {
      next()
      const r = compare()
      l = truthy(l) ? r : l
    }
    return l
  }
  const or = (): unknown => {
    let l = and()
    while (peek()?.v === '||') {
      next()
      const r = and()
      l = truthy(l) ? l : r
    }
    return l
  }
  return or()
}

/** `${{ expr }}` in a string, each replaced by its value. */
export function interpolate(text: string, ctx: Context): string {
  return text.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, e: string) => {
    return asText(evaluate(e.trim(), ctx))
  })
}

/** An `if:`: bare expressions are allowed, and success() is implied. */
export function condition(when: unknown, ctx: Context): boolean {
  if (when === undefined || when === null || when === '')
    return ctx.job.status === 'success'
  if (typeof when === 'boolean') return when && ctx.job.status === 'success'
  const src = asText(when).replace(/^\s*\$\{\{([\s\S]*)\}\}\s*$/, '$1')
  const statusFn = /\b(success|failure|always|cancelled)\s*\(/.test(src)
  const v = truthy(evaluate(src, ctx))
  return statusFn ? v : v && ctx.job.status === 'success'
}

// ---------- files GitHub's runner keeps ----------

/** KEY=value lines and KEY<<EOF heredocs, as GITHUB_ENV and GITHUB_OUTPUT hold. */
export function readKeyValues(source: string): Record<string, string> {
  const out: Record<string, string> = {}
  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const heredoc = /^([^=<]+)<<(.+)$/.exec(lines[i])
    if (heredoc) {
      const body: Array<string> = []
      while (++i < lines.length && lines[i] !== heredoc[2]) body.push(lines[i])
      out[heredoc[1]] = body.join('\n')
      continue
    }
    const at = lines[i].indexOf('=')
    if (at > 0) out[lines[i].slice(0, at)] = lines[i].slice(at + 1)
  }
  return out
}

// ---------- actions ----------

async function fetchAction(uses: string, cache: string): Promise<string> {
  const m = /^([^/@]+)\/([^/@]+)((?:\/[^@]+)?)@(.+)$/.exec(uses)
  if (!m) throw new Error(`${uses} is not owner/repo@ref`)
  const [, owner, repo, sub, ref] = m
  const dir = join(cache, owner, repo, ref)
  if (!existsSync(join(dir, '.complete'))) {
    mkdirSync(dir, { recursive: true })
    const res = await fetch(
      `https://codeload.github.com/${owner}/${repo}/tar.gz/${ref}`,
    )
    if (!res.ok) throw new Error(`downloading ${uses} answered ${res.status}`)
    const tar = join(dir, '..', `${ref.replace(/\W/g, '_')}.tar.gz`)
    writeFileSync(tar, new Uint8Array(await res.arrayBuffer()))
    const x = Bun.spawnSync([
      'tar',
      '-xzf',
      tar,
      '-C',
      dir,
      '--strip-components=1',
    ])
    if (x.exitCode !== 0) throw new Error(`unpacking ${uses} failed`)
    writeFileSync(join(dir, '.complete'), '')
  }
  return sub ? join(dir, sub.slice(1)) : dir
}

function actionYaml(dir: string): Obj {
  for (const f of ['action.yml', 'action.yaml']) {
    const p = join(dir, f)
    if (existsSync(p)) return parseYaml(readFileSync(p, 'utf8')) as Obj
  }
  throw new Error(`no action.yml in ${dir}`)
}

export type Env = Record<string, string>

export type Runtime = {
  workspace: string
  temp: string
  cache: string
  env: Env
  path: Array<string>
  log: (line: Line) => void
}

async function spawn(
  cmd: Array<string>,
  o: { cwd: string; env: Env; timeoutMs?: number },
  log: (line: Line) => void,
): Promise<number> {
  const p = Bun.spawn(cmd, {
    cwd: o.cwd,
    env: o.env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const timer = o.timeoutMs
    ? setTimeout(() => {
        log({
          text: `Timed out after ${Math.round(o.timeoutMs! / 60_000)} minutes.`,
          level: 'error',
        })
        p.kill()
      }, o.timeoutMs)
    : null
  const pump = async (s: ReadableStream<Uint8Array>, level: string | null) => {
    const dec = new TextDecoder()
    let buf = ''
    for await (const chunk of s) {
      buf += dec.decode(chunk, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const t = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        // Workflow commands GitHub's runner understands, the common ones.
        if (t.startsWith('::add-mask::')) continue
        const cmdLine = /^::(error|warning|notice|debug)[^:]*::(.*)$/.exec(t)
        if (cmdLine)
          log({
            text: cmdLine[2],
            level:
              cmdLine[1] === 'error'
                ? 'error'
                : cmdLine[1] === 'warning'
                  ? 'warn'
                  : null,
          })
        else log({ text: t.slice(0, 4000), level })
      }
    }
    if (buf) log({ text: buf.slice(0, 4000), level })
  }
  await Promise.all([pump(p.stdout, null), pump(p.stderr, null)])
  const code = await p.exited
  if (timer) clearTimeout(timer)
  return code
}

/** Run one step (a run: or a uses:). Its outputs land in ctx.steps[id]. */
export async function runStep(
  step: Obj,
  ctx: Context,
  rt: Runtime,
  id: string,
): Promise<'success' | 'failure' | 'skipped'> {
  const outputs: Record<string, string> = {}
  const files = {
    GITHUB_ENV: join(rt.temp, `env-${id}`),
    GITHUB_PATH: join(rt.temp, `path-${id}`),
    GITHUB_OUTPUT: join(rt.temp, `output-${id}`),
    GITHUB_STATE: join(rt.temp, `state-${id}`),
    GITHUB_STEP_SUMMARY: join(rt.temp, `summary-${id}`),
  }
  for (const f of Object.values(files)) writeFileSync(f, '')
  const stepEnv: Env = {}
  for (const [k, v] of Object.entries(isObj(step.env) ? step.env : {}))
    stepEnv[k] = interpolate(String(v), ctx)
  const baseEnv = (): Env => ({
    ...(process.env as Env),
    ...rt.env,
    ...stepEnv,
    ...files,
    PATH: [...rt.path, process.env.PATH ?? ''].join(':'),
    CI: 'true',
    GITHUB_ACTIONS: 'true',
    GITHUB_WORKSPACE: rt.workspace,
    GITHUB_SHA: String(ctx.github.sha),
    GITHUB_REF: String(ctx.github.ref),
    GITHUB_REF_NAME: String(ctx.github.ref_name),
    GITHUB_REPOSITORY: String(ctx.github.repository),
    GITHUB_EVENT_NAME: String(ctx.github.event_name),
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_API_URL: 'https://api.github.com',
    RUNNER_OS: String(ctx.runner.os),
    RUNNER_ARCH: String(ctx.runner.arch),
    RUNNER_TEMP: rt.temp,
    RUNNER_TOOL_CACHE: join(rt.cache, '_tool'),
    CB_RUNNER_TOKEN: '',
  })
  const timeoutMs =
    typeof step['timeout-minutes'] === 'number'
      ? step['timeout-minutes'] * 60_000
      : undefined
  let code = 0
  const uses =
    typeof step.uses === 'string' ? interpolate(step.uses, ctx) : null
  const withs: Env = {}
  for (const [k, v] of Object.entries(isObj(step.with) ? step.with : {}))
    withs[k] = interpolate(String(v), ctx)
  if (typeof step.run === 'string') {
    const script = interpolate(step.run, ctx)
    const cwd =
      typeof step['working-directory'] === 'string'
        ? resolvePath(rt.workspace, interpolate(step['working-directory'], ctx))
        : rt.workspace
    const shell =
      typeof step.shell === 'string'
        ? step.shell
        : Bun.which('bash')
          ? 'bash'
          : 'sh'
    const file = join(rt.temp, `step-${id}.sh`)
    writeFileSync(file, script)
    rt.log({
      text: `$ ${script.split('\n')[0]}${script.includes('\n') ? ' …' : ''}`,
      level: 'cmd',
    })
    const argv =
      shell === 'bash'
        ? ['bash', '--noprofile', '--norc', '-eo', 'pipefail', file]
        : shell === 'sh'
          ? ['sh', '-e', file]
          : shell === 'python'
            ? ['python3', file]
            : shell === 'pwsh'
              ? ['pwsh', '-command', `. '${file}'`]
              : shell.replace('{0}', file).split(' ')
    code = await spawn(argv, { cwd, env: baseEnv(), timeoutMs }, rt.log)
  } else if (uses?.startsWith('actions/checkout@')) {
    rt.log({
      text: `Checked out ${String(ctx.github.sha).slice(0, 7)} in ${rt.workspace}`,
      level: 'info',
    })
  } else if (uses?.startsWith('docker://')) {
    rt.log({
      text: `${uses} runs in a container, which this runner does not do yet.`,
      level: 'warn',
    })
    return 'skipped'
  } else if (uses) {
    let dir: string
    try {
      dir = uses.startsWith('./')
        ? resolvePath(rt.workspace, uses)
        : await fetchAction(uses, join(rt.cache, '_actions'))
    } catch (e) {
      rt.log({ text: String(e), level: 'error' })
      return 'failure'
    }
    const action = actionYaml(dir)
    const runs = isObj(action.runs) ? action.runs : {}
    const inputs: Env = {}
    for (const [k, v] of Object.entries(
      isObj(action.inputs) ? action.inputs : {},
    )) {
      const given = k in withs ? withs[k] : undefined
      const def =
        isObj(v) && v.default !== undefined
          ? interpolate(asText(v.default), ctx)
          : undefined
      if (given !== undefined) inputs[k] = given
      else if (def !== undefined) inputs[k] = def
    }
    for (const [k, v] of Object.entries(withs))
      if (!(k in inputs)) inputs[k] = v
    const using = asText(runs.using)
    rt.log({ text: `Run ${uses}`, level: 'cmd' })
    if (/^node\d+$/.test(using)) {
      const node = Bun.which('node')
      if (!node) {
        rt.log({
          text: `${uses} is a Node action and this machine has no node.`,
          level: 'error',
        })
        return 'failure'
      }
      const env = baseEnv()
      for (const [k, v] of Object.entries(inputs))
        env[`INPUT_${k.replace(/ /g, '_').toUpperCase()}`] = v
      env.GITHUB_ACTION_PATH = dir
      code = await spawn(
        [node, join(dir, String(runs.main))],
        { cwd: rt.workspace, env, timeoutMs },
        rt.log,
      )
    } else if (using === 'composite') {
      const inner: Context = { ...ctx, inputs, steps: {} }
      const steps = Array.isArray(runs.steps) ? runs.steps.filter(isObj) : []
      for (const [i, s] of steps.entries()) {
        const sub = { ...s, env: { ...(isObj(s.env) ? s.env : {}) } }
        if (!condition(s.if, inner)) continue
        const r = await runStep(
          sub,
          { ...inner, env: { ...ctx.env, ...rt.env } },
          { ...rt, workspace: rt.workspace },
          `${id}-${i}`,
        )
        if (r === 'failure' && s['continue-on-error'] !== true) {
          inner.job = { status: 'failure' }
          code = 1
        }
      }
      for (const [k, v] of Object.entries(
        isObj(action.outputs) ? action.outputs : {},
      ))
        if (isObj(v) && typeof v.value === 'string')
          outputs[k] = interpolate(v.value, inner)
    } else {
      rt.log({
        text: `${uses} uses ${using || 'an unknown runtime'}, which this runner does not run.`,
        level: 'warn',
      })
      return 'skipped'
    }
  } else {
    return 'skipped'
  }
  // What the step left for the next ones.
  Object.assign(rt.env, readKeyValues(readFileSync(files.GITHUB_ENV, 'utf8')))
  rt.path.unshift(
    ...readFileSync(files.GITHUB_PATH, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
  )
  Object.assign(
    outputs,
    readKeyValues(readFileSync(files.GITHUB_OUTPUT, 'utf8')),
  )
  const outcome = code === 0 ? 'success' : 'failure'
  ctx.steps[id] = {
    outputs,
    outcome,
    conclusion:
      outcome === 'failure' && step['continue-on-error'] === true
        ? 'success'
        : outcome,
  }
  return outcome
}

/**
 * The job of a workflow file the runner took, with its matrix values, worked
 * out the way the server named it.
 */
export function findJob(
  yamlText: string,
  name: string,
): { job: Obj; matrix: Obj; workflowEnv: Obj } | null {
  const doc = parseYaml(yamlText) as Obj
  const jobs = isObj(doc.jobs) ? doc.jobs : {}
  for (const [key, raw] of Object.entries(jobs)) {
    if (!isObj(raw)) continue
    const base = typeof raw.name === 'string' && raw.name ? raw.name : key
    for (const m of matrixOf(raw))
      if (jobName(base, m) === name)
        return {
          job: raw,
          matrix: m,
          workflowEnv: isObj(doc.env) ? doc.env : {},
        }
  }
  return null
}

export function newContext(a: {
  sha: string
  branch: string
  repository: string
  workspace: string
  temp: string
  matrix: Obj
}): Context {
  return {
    github: {
      sha: a.sha,
      ref: `refs/heads/${a.branch}`,
      ref_name: a.branch,
      head_ref: '',
      base_ref: '',
      repository: a.repository,
      repository_owner: a.repository.split('/')[0],
      workspace: a.workspace,
      event_name: 'push',
      server_url: 'https://github.com',
      run_number: 1,
      run_id: 1,
      actor: a.repository.split('/')[0],
    },
    runner: {
      os:
        process.platform === 'darwin'
          ? 'macOS'
          : process.platform === 'win32'
            ? 'Windows'
            : 'Linux',
      arch: process.arch === 'arm64' ? 'ARM64' : 'X64',
      temp: a.temp,
      name: 'cobalt',
    },
    env: {},
    matrix: a.matrix,
    steps: {},
    inputs: {},
    secrets: {},
    job: { status: 'success' },
  }
}

export function appendLog(file: string, line: string) {
  appendFileSync(file, `${line}\n`)
}
