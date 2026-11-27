import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { tmpdir } from 'node:os'
import { agentJobOf } from '@cobaltforge/api/agent-runs'
import type { AgentJob } from '@cobaltforge/api/agent-runs'
import {
  condition,
  findJob,
  interpolate,
  newContext,
  runStep,
} from '../workflow-runner'
import { handOffHere, reviewHere } from '../agent'
import { CbError, exit, print, table } from '../output'
import { has, str } from '../args'
import { runnerClient } from '../client'
import type { ApiClient } from '../client'
import type { Ctx } from '../output'
import type { Command } from './types'

type Runner = {
  id: string
  name: string
  account: string
  kind: string
  provider: string | null
  labels: Array<string>
  repos: Array<string> | null
  concurrency: number
  status: string
  current_jobs: number
  last_seen_at: string | null
  secret: string | null
}

type Job = {
  run: number
  job: number
  name: string
  workflow: string
  file: string
  branch: string
  sha: string
  steps: Array<{ number: number; name: string }>
  url: string
}

const list = (v: string | undefined) =>
  v
    ? v
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
    : undefined

export const runner: Command = async (
  { rest: [sub = 'list', ...rest], flags },
  ctx,
) => {
  const dry = has(flags, 'dry-run')
  if (sub === 'list') {
    const account = str(flags, 'account')
    const rows = (
      await ctx.api().get('/runners', { query: account ? { account } : {} })
    ).json.data as Array<Runner>
    print(ctx, rows, () =>
      table(
        rows.map((r) => [
          r.id,
          r.name,
          r.status,
          r.labels.join(','),
          String(r.current_jobs),
          r.repos?.join(',') ?? '*',
        ]),
        ['ID', 'NAME', 'STATUS', 'LABELS', 'JOBS', 'REPOS'],
      ),
    )
    return
  }
  if (sub === 'register') {
    const name = rest.at(0)
    if (!name)
      throw new CbError(
        'missing_argument',
        'runner register needs a name.',
        'Example: cb runner register mac-mini --labels macos,arm64,xcode-16',
        exit.usage,
      )
    const provider = str(flags, 'provider')
    const concurrency = str(flags, 'concurrency')
    const r = (
      await ctx.api().post('/runners', {
        body: {
          name,
          ...(str(flags, 'account') ? { account: str(flags, 'account') } : {}),
          ...(provider ? { kind: 'hosted', provider } : {}),
          ...(list(str(flags, 'labels'))
            ? { labels: list(str(flags, 'labels')) }
            : {}),
          ...(list(str(flags, 'repos'))
            ? { repos: list(str(flags, 'repos')) }
            : {}),
          ...(concurrency ? { concurrency: Number(concurrency) } : {}),
        },
        dryRun: dry,
      })
    ).json as Runner
    print(ctx, { ...r, dryRun: dry }, () =>
      dry
        ? `would register ${r.name} with ${r.labels.join(', ') || 'no labels'}`
        : `registered ${r.name} (${r.id}). Its token, shown this once:\n\n  CB_RUNNER_TOKEN=${r.secret}\n\nRun "cb runner start" with it on the machine.`,
    )
    return
  }
  if (sub === 'revoke') {
    const id = rest.at(0)
    if (!id)
      throw new CbError(
        'missing_argument',
        'runner revoke needs an id.',
        'cb runner list shows ids.',
        exit.usage,
      )
    const r = (await ctx.api().del(`/runners/${id}`, { dryRun: dry }))
      .json as Runner
    print(
      ctx,
      { ...r, dryRun: dry },
      () =>
        `${dry ? 'would revoke' : 'revoked'} ${r.name}; its token stops working now`,
    )
    return
  }
  if (sub === 'start') {
    const token = process.env.CB_RUNNER_TOKEN
    if (!token)
      throw new CbError(
        'unauthenticated',
        'cb runner start needs CB_RUNNER_TOKEN.',
        'cb runner register prints it, once.',
        exit.auth,
      )
    const workdir = resolvePath(
      str(flags, 'workdir') ?? join(tmpdir(), 'cb-runner'),
    )
    return await start(runnerClient(token), ctx, {
      workdir,
      once: has(flags, 'once'),
    })
  }
  throw new CbError(
    'unknown_subcommand',
    `runner ${sub} is not a command.`,
    'Use register, list, revoke or start.',
    exit.usage,
  )
}

async function start(
  api: ApiClient,
  ctx: Ctx,
  opts: { workdir: string; once: boolean },
) {
  const me = (await api.post('/runners/heartbeat')).json as Runner
  ctx.err(`${me.name}: ready, labels ${me.labels.join(', ') || 'none'}`)
  let last = Date.now()
  const beat = async () => {
    if (Date.now() - last < 30_000) return
    last = Date.now()
    await api.post('/runners/heartbeat')
  }
  const timer = opts.once ? null : setInterval(() => void beat(), 30_000)
  try {
    for (;;) {
      const r = await api.post('/runners/claim')
      if (r.status === 204) {
        if (opts.once) {
          print(ctx, { ran: null }, () => 'nothing to run')
          return
        }
        await new Promise((x) => setTimeout(x, 5_000))
        continue
      }
      const job = r.json as Job
      const result = await runJob(api, ctx, job, opts.workdir)
      if (opts.once) {
        print(ctx, { ran: job, status: result }, () => `${job.name}: ${result}`)
        return result === 'success' ? exit.ok : exit.error
      }
    }
  } finally {
    if (timer) clearInterval(timer)
  }
}

/**
 * The repository at `sha` in `dir`: a git clone through cobalt with the
 * runner's token when the server is reachable, else the files one by one.
 */
export async function checkout(
  api: ApiClient,
  repo: string,
  sha: string,
  dir: string,
) {
  if (api.mode === 'network' && Bun.which('git')) {
    const origin = api.base.replace(/\/api\/v1$/, '').replace(/\/v1$/, '')
    const url = new URL(`${origin}/${repo}.git`)
    url.username = 'runner'
    url.password = process.env.CB_RUNNER_TOKEN ?? ''
    const git = (args: Array<string>, cwd?: string) =>
      Bun.spawnSync(['git', ...args], { cwd, stderr: 'pipe', stdout: 'pipe' })
    if (!existsSync(join(dir, '.git'))) {
      mkdirSync(dir, { recursive: true })
      if (git(['clone', '--quiet', url.href, dir]).exitCode !== 0)
        throw new Error(`git clone of ${repo} failed`)
    } else
      git(
        [
          'fetch',
          '--quiet',
          '--tags',
          url.href,
          '+refs/heads/*:refs/remotes/origin/*',
        ],
        dir,
      )
    if (
      git(['checkout', '--quiet', '--force', '--detach', sha], dir).exitCode !==
      0
    )
      throw new Error(`commit ${sha.slice(0, 7)} is not in ${repo}`)
    // The token stays out of the clone's remote.
    git(['remote', 'set-url', 'origin', `${origin}/${repo}.git`], dir)
    return
  }
  const tree = (
    await api.get(`/repos/${repo}/git/tree`, {
      query: { ref: sha, recursive: 'true' },
    })
  ).json as { entries: Array<{ path: string; type: string }> }
  for (const e of tree.entries) {
    if (e.type !== 'blob') continue
    const res = await api.call('GET', `/repos/${repo}/git/blob`, {
      query: { ref: sha, path: e.path },
    })
    const blob = res.json as { content: string; encoding: string } | null
    if (!blob) continue
    const path = join(dir, e.path)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(
      path,
      blob.encoding === 'base64'
        ? Buffer.from(blob.content, 'base64')
        : blob.content,
    )
  }
}

async function workflowText(api: ApiClient, repo: string, job: Job) {
  const res = await api
    .call('GET', `/repos/${repo}/git/blob`, {
      query: { ref: job.sha, path: job.file },
    })
    .catch(() => null)
  const b = res?.json as { content?: string; encoding?: string } | null
  if (!b?.content) return null
  return b.encoding === 'base64'
    ? Buffer.from(b.content, 'base64').toString('utf8')
    : b.content
}

async function runJob(
  api: ApiClient,
  ctx: Ctx,
  job: Job,
  workdir: string,
): Promise<'success' | 'failure'> {
  const repo = new URL(job.url).pathname
    .replace(/^.*\/repos\//, '')
    .split('/')
    .slice(0, 2)
    .join('/')
  const report = (body: Record<string, unknown>) =>
    api.post('/runners/report', {
      body: { repo, run: job.run, job: job.job, ...body },
    })
  const agent = agentJobOf(job.file)
  if (agent) return runAgentJob(api, ctx, job, repo, agent, workdir, report)

  const dir = join(workdir, `${repo.replace('/', '-')}-${job.run}-${job.job}`)
  mkdirSync(dir, { recursive: true })
  ctx.err(
    `${repo} #${job.run} ${job.name}: checking out ${job.sha.slice(0, 7)}`,
  )
  try {
    await checkout(api, repo, job.sha, dir)
  } catch (e) {
    await report({
      step: 1,
      status: 'failure',
      lines: [{ text: String(e), level: 'error' }],
    })
    return 'failure'
  }
  const text = await workflowText(api, repo, job)
  // A reusable workflow: from the checkout (./…), or from GitHub.
  const load = async (uses: string) => {
    const local = /^\.\/(.+)$/.exec(uses)
    if (local)
      return existsSync(join(dir, local[1]))
        ? readFileSync(join(dir, local[1]), 'utf8')
        : null
    const at = /^([\w.-]+)\/([\w.-]+)\/(.+)@(.+)$/.exec(uses)
    if (!at) return null
    const res = await fetch(
      `https://raw.githubusercontent.com/${at[1]}/${at[2]}/${at[4]}/${at[3]}`,
    ).catch(() => null)
    return res?.ok ? res.text() : null
  }
  const found = text ? await findJob(text, job.name, load) : null
  if (!found) {
    for (const step of job.steps)
      await report({
        step: step.number,
        status: 'skipped',
        lines: [
          {
            text: `${job.file} has no job ${job.name} at ${job.sha.slice(0, 7)}.`,
            level: 'error',
          },
        ],
      })
    return 'failure'
  }
  const temp = join(workdir, '_temp', `${job.run}-${job.job}`)
  mkdirSync(temp, { recursive: true })
  const context = newContext({
    sha: job.sha,
    branch: job.branch,
    repository: repo,
    workspace: dir,
    temp,
    matrix: found.matrix,
  })
  context.inputs = Object.fromEntries(
    Object.entries(found.inputs).map(([k, v]) => [
      k,
      typeof v === 'string' ? interpolate(v, context) : v,
    ]),
  )
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries({
    ...found.workflowEnv,
    ...(found.job.env && typeof found.job.env === 'object'
      ? found.job.env
      : {}),
  }))
    env[k] = interpolate(String(v), context)
  context.env = env
  const steps = (
    Array.isArray(found.job.steps) ? found.job.steps : []
  ) as Array<Record<string, unknown>>
  for (const step of job.steps) {
    const spec = steps[step.number - 1] ?? {}
    const id = typeof spec.id === 'string' ? spec.id : `step${step.number}`
    context.env = { ...env }
    if (!condition(spec.if, context)) {
      await report({
        step: step.number,
        status: 'skipped',
        lines: [{ text: 'Skipped: its if: is false.', level: 'info' }],
      })
      continue
    }
    await report({ step: step.number, status: 'running' })
    const lines: Array<{ text: string; level: string | null }> = []
    const began = Date.now()
    const outcome = await runStep(
      spec,
      context,
      {
        workspace: dir,
        temp,
        cache: workdir,
        env,
        path: [],
        log: (l) => lines.push(l),
      },
      id,
    ).catch((e: unknown) => {
      lines.push({ text: String(e), level: 'error' })
      return 'failure' as const
    })
    await report({
      step: step.number,
      status: outcome,
      lines: lines.slice(-1000),
      duration_ms: Date.now() - began,
    })
    if (outcome === 'failure' && spec['continue-on-error'] !== true)
      context.job = { status: 'failure' }
  }
  return context.job.status === 'failure' ? 'failure' : 'success'
}

/** A job for the agent on this machine: a hand-off or an AI review. */
async function runAgentJob(
  api: ApiClient,
  ctx: Ctx,
  job: Job,
  repo: string,
  agent: AgentJob,
  workdir: string,
  report: (body: Record<string, unknown>) => Promise<unknown>,
): Promise<'success' | 'failure'> {
  const dir = join(workdir, 'repos', repo.replace('/', '-'))
  await report({ step: 1, status: 'running' })
  const began = Date.now()
  try {
    await checkout(api, repo, job.sha, dir)
    const lines =
      agent.kind === 'handoff'
        ? await handOffHere(api, repo, agent.subject, job.branch, dir)
        : await reviewHere(api, repo, agent.change, agent.patchSet, dir)
    for (const l of lines) ctx.err(`${repo} ${job.name}: ${l.text}`)
    await report({
      step: 1,
      status: 'success',
      lines,
      duration_ms: Date.now() - began,
    })
    return 'success'
  } catch (e) {
    await report({
      step: 1,
      status: 'failure',
      lines: [
        { text: e instanceof Error ? e.message : String(e), level: 'error' },
      ],
      duration_ms: Date.now() - began,
    })
    return 'failure'
  }
}
