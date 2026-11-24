import { chmodSync, writeFileSync } from 'node:fs'
import { resolveRepo } from '../repo'
import { CbError, exit, print, table } from '../output'
import { has, str } from '../args'
import { cliError, runWithEnv } from '../secrets'
import type { Command } from './types'

type Var = {
  name: string
  kind: string
  secret: boolean
  environments: Array<string>
  set: boolean | null
}
type Confirmation = {
  id: string
  state: string
  environment: string
  device: string | null
  expires_at: string | null
  confirm_url: string
}

export const env: Command = async (
  { rest: [sub = 'list', ...rest], flags },
  ctx,
) => {
  const repo = resolveRepo(str(flags, 'repo'))
  const api = ctx.api()
  const environment = str(flags, 'env') ?? 'development'
  const dry = has(flags, 'dry-run')

  if (sub === 'list') {
    const rows = (
      await api.get(`${repo.path}/env`, {
        query: { environment: environment as 'development' },
      })
    ).json.data as Array<Var>
    print(ctx, rows, () =>
      table(
        rows.map((v) => [
          v.name,
          v.secret ? 'secret' : 'public',
          v.set ? 'set' : 'missing',
        ]),
        ['NAME', 'KIND', environment.toUpperCase()],
      ),
    )
    return
  }

  if (sub === 'set') {
    const name = rest.at(0)
    let value: string | undefined = rest.at(1)
    if (!name)
      throw new CbError(
        'missing_argument',
        'env set needs NAME and a value.',
        'Example: cb env set STRIPE_KEY - --env production  (reads the value from stdin)',
        exit.usage,
      )
    if (value !== '-')
      throw new CbError(
        'value_on_command_line',
        value === undefined
          ? 'env set reads the value from stdin: pass - after the name.'
          : 'A secret on the command line ends up in your shell history. env set reads it from stdin.',
        `Example: printf %s "$VALUE" | cb env set ${name} - --env ${environment}`,
        exit.usage,
      )
    value = (await Bun.stdin.text()).replace(/\n$/, '')
    let v: Var
    try {
      v = (
        await api.put(`${repo.path}/env/${name}/${environment}`, {
          body: { value },
          dryRun: dry,
        })
      ).json as Var
    } catch (e) {
      cliError(e, environment)
    }
    print(
      ctx,
      { name: v.name, env: environment, sealed: !dry, dryRun: dry },
      () => `${dry ? 'would seal' : 'sealed'} ${name} for ${environment}`,
    )
    return
  }

  if (sub === 'pull') {
    if (!has(flags, 'plaintext'))
      throw new CbError(
        'plaintext_refused',
        'env pull writes values to a plaintext file, so it needs --plaintext.',
        `Prefer: cb env run --env ${environment} -- <command>. Values reach that process only.`,
        exit.usage,
      )
    try {
      if (dry) {
        await api.get(`${repo.path}/env/${environment}/values`, {
          query: { check_only: 'true' },
        })
        print(
          ctx,
          { env: environment, written: null, dryRun: true },
          () => `would write .env.local for ${environment}`,
        )
        return
      }
      const values = (await api.get(`${repo.path}/env/${environment}/values`))
        .json as { values: Record<string, string> }
      const text = `${Object.entries(values.values)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join('\n')}\n`
      writeFileSync('.env.local', text, { mode: 0o600 })
      chmodSync('.env.local', 0o600)
      const ignored =
        Bun.spawnSync(['git', 'check-ignore', '-q', '.env.local']).exitCode ===
        0
      if (!ignored)
        ctx.err(
          'warning: .env.local is not in .gitignore. Add it before you commit.',
        )
      const vars = (
        await api.get(`${repo.path}/env`, { query: { environment } })
      ).json.data as Array<Var>
      const missing = vars.filter((v) => !v.set).map((v) => v.name)
      print(
        ctx,
        { env: environment, written: '.env.local', dryRun: false, missing },
        () =>
          `wrote .env.local for ${environment} (only you can read it; keep it out of git)${missing.length ? `\nmissing: ${missing.join(', ')}` : ''}`,
      )
      return
    } catch (e) {
      cliError(e, environment)
    }
  }

  if (sub === 'run') {
    const command = rest
    if (command.length === 0)
      throw new CbError(
        'missing_argument',
        'env run needs a command after --.',
        'Example: cb env run --env development -- bun test',
        exit.usage,
      )
    const result = await runWithEnv({
      ctx,
      repo,
      env: environment,
      only: str(flags, 'only')?.split(','),
      command,
      dryRun: dry,
    })
    print(ctx, { ...result, dryRun: dry }, () =>
      [
        result.stdout.trimEnd(),
        result.stderr.trimEnd(),
        `(${dry ? `would inject ${result.injected.length} variables` : `${result.injected.length} variables injected`}, ${dry ? 'would scrub' : 'scrubbed'} ${result.redacted.length} from output)`,
      ]
        .filter(Boolean)
        .join('\n'),
    )
    return result.exitCode === 0 ? exit.ok : exit.error
  }

  if (sub === 'confirmations') {
    const rows = (await api.get(`${repo.path}/env/confirmations`)).json
      .data as Array<Confirmation>
    print(ctx, rows, () =>
      table(
        rows.map((c) => [
          c.id,
          c.state,
          c.environment,
          c.device ?? '',
          c.state === 'pending' ? c.confirm_url : (c.expires_at ?? ''),
        ]),
        ['CONFIRMATION', 'STATE', 'ENV', 'MACHINE', 'EXPIRES / CONFIRM AT'],
      ),
    )
    return
  }

  throw new CbError(
    'unknown_command',
    `env ${sub} is not a command.`,
    'cb env --help lists them.',
    exit.usage,
  )
}
