import { CbError } from './output'
import type { Ctx } from './output'
import type { RepoRef } from './repo'

export function scrub(text: string, secrets: Record<string, string>): string {
  let out = text
  for (const [name, value] of Object.entries(secrets)) {
    if (value.length === 0) continue
    const forms = new Set([
      value,
      Buffer.from(value).toString('base64'),
      encodeURIComponent(value),
      JSON.stringify(value).slice(1, -1),
    ])
    for (const f of forms) {
      if (f.length < 4) {
        const escaped = f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        out = out.replace(
          new RegExp(
            `(?<![^\\s()\\[\\]{}"'=,;:!?.])${escaped}(?![^\\s()\\[\\]{}"'=,;:!?.])`,
            'g',
          ),
          `«${name}»`,
        )
        continue
      }
      out = out.split(f).join(`«${name}»`)
    }
  }
  return out
}

export type RunResult = {
  env: string
  injected: Array<string>
  redacted: Array<string>
  exitCode: number
  stdout: string
  stderr: string
}

export function cliError(e: unknown, env: string): never {
  if (e instanceof CbError && e.code === 'confirmation_required')
    throw new CbError(
      e.code,
      `${env} values need you to confirm this login first.`,
      e.hint ??
        'Confirm it in Settings, Secrets, where you are signed in, then retry.',
      e.status,
    )
  if (e instanceof CbError && e.code === 'secrets_unavailable')
    throw new CbError(
      e.code,
      'This server keeps no secret values.',
      'Ask its operator to set CB_SECRETS_KEY.',
      e.status,
    )
  throw e
}

export async function runWithEnv(opts: {
  ctx: Ctx
  repo: RepoRef
  env: string
  only: Array<string> | undefined
  command: Array<string>
  dryRun: boolean
}): Promise<RunResult> {
  const api = opts.ctx.api()
  const names = opts.only?.join(',')

  if (opts.dryRun) {
    try {
      await api.get(`${opts.repo.path}/env/${opts.env}/values`, {
        query: { check_only: 'true' },
      })
    } catch (e) {
      cliError(e, opts.env)
    }
    const vars = (
      await api.get(`${opts.repo.path}/env`, {
        query: { environment: opts.env as 'development' },
      })
    ).json.data as Array<{ name: string; secret: boolean; set: boolean }>
    const shown = vars.filter(
      (v) => v.set && (!opts.only || opts.only.includes(v.name)),
    )
    return {
      env: opts.env,
      injected: shown.map((v) => v.name),
      redacted: shown.filter((v) => v.secret).map((v) => v.name),
      exitCode: 0,
      stdout: '',
      stderr: '',
    }
  }

  let read
  try {
    read = (
      await api.get(`${opts.repo.path}/env/${opts.env}/values`, {
        query: { names },
      })
    ).json as {
      values: Record<string, string>
      secrets: Array<string>
    }
  } catch (e) {
    cliError(e, opts.env)
  }
  const secrets = Object.fromEntries(
    read.secrets
      .filter((n) => n in read.values)
      .map((n) => [n, read.values[n]]),
  )
  const proc = Bun.spawn(opts.command, {
    env: { ...process.env, ...read.values },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return {
    env: opts.env,
    injected: Object.keys(read.values),
    redacted: Object.keys(secrets),
    exitCode,
    stdout: scrub(stdout, secrets),
    stderr: scrub(stderr, secrets),
  }
}
