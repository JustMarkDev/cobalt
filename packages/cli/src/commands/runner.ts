import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { tmpdir } from 'node:os'
import { parse as parseYaml } from 'yaml'
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

async function checkout(
  api: ApiClient,
  repo: string,
  sha: string,
  dir: string,
) {
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

async function stepsToRun(api: ApiClient, repo: string, job: Job) {
  const res = await api
    .call('GET', `/repos/${repo}/git/blob`, {
      query: { ref: job.sha, path: job.file },
    })
    .catch(() => null)
  const text = (res?.json as { content?: string; encoding?: string } | null)
    ?.content
  if (!text) return []
  const yaml = parseYaml(
    (res!.json as { encoding?: string }).encoding === 'base64'
      ? Buffer.from(text, 'base64').toString('utf8')
      : text,
  ) as {
    jobs?: Partial<
      Record<
        string,
        { name?: string; steps?: Array<{ run?: string; uses?: string }> }
      >
    >
  }
  const jobs = yaml.jobs ?? {}
  const found =
    jobs[job.name] ?? Object.values(jobs).find((j) => j?.name === job.name)
  return (found?.steps ?? []).map((s) =>
    typeof s.run === 'string'
      ? s.run
      : typeof s.uses === 'string' && s.uses.startsWith('actions/checkout@')
        ? CHECKOUT
        : null,
  )
}

/** A step the runner has already done: it checks the commit out first. */
const CHECKOUT = Symbol('checkout')

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
  const dir = join(workdir, `${repo.replace('/', '-')}-${job.run}-${job.job}`)
  mkdirSync(dir, { recursive: true })
  const report = (body: Record<string, unknown>) =>
    api.post('/runners/report', {
      body: { repo, run: job.run, job: job.job, ...body },
    })
  ctx.err(
    `${repo} #${job.run} ${job.name}: checking out ${job.sha.slice(0, 7)}`,
  )
  await checkout(api, repo, job.sha, dir).catch(() => {})
  const runs = await stepsToRun(api, repo, job)
  for (const step of job.steps) {
    const cmd = runs[step.number - 1] ?? null
    if (cmd === CHECKOUT) {
      await report({
        step: step.number,
        status: 'success',
        lines: [
          {
            text: `Checked out ${job.sha.slice(0, 7)} in ${dir}`,
            level: 'info',
          },
        ],
      })
      continue
    }
    if (!cmd) {
      await report({
        step: step.number,
        status: 'skipped',
        lines: [
          {
            text: 'A GitHub Action, not a run: step: this runner skips it. Install what it sets up on the runner.',
            level: 'info',
          },
        ],
      })
      continue
    }
    await report({ step: step.number, status: 'running' })
    const began = Date.now()
    const proc = Bun.spawn(['sh', '-c', cmd], {
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, CB_RUNNER_TOKEN: '' },
    })
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    const lines = [
      { text: `$ ${cmd}`, level: 'cmd' },
      ...out
        .split('\n')
        .filter(Boolean)
        .map((t) => ({ text: t.slice(0, 4000), level: null })),
      ...err
        .split('\n')
        .filter(Boolean)
        .map((t) => ({
          text: t.slice(0, 4000),
          level: code === 0 ? 'warn' : 'error',
        })),
    ].slice(-1000)
    await report({
      step: step.number,
      status: code === 0 ? 'success' : 'failure',
      lines,
      duration_ms: Date.now() - began,
    })
    if (code !== 0) return 'failure'
  }
  return 'success'
}
