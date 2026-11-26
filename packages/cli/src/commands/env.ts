import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { join, relative } from 'node:path'
import {
  environmentOf,
  isValuesFile,
  parseDotenv,
  schemaNames,
  withNames,
} from '../dotenv'
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

  if (sub === 'commit') return commitEnv(ctx, repo.path, rest, flags)

  if (sub === 'hook') {
    const root = gitRoot()
    const hook = join(root, '.git', 'hooks', 'pre-commit')
    if (rest.at(0) === 'uninstall') {
      if (existsSync(hook) && readFileSync(hook, 'utf8').includes(HOOK_MARK))
        writeFileSync(hook, '')
      print(ctx, { hook, installed: false }, () => `removed ${hook}`)
      return
    }
    if (
      existsSync(hook) &&
      !readFileSync(hook, 'utf8').includes(HOOK_MARK) &&
      readFileSync(hook, 'utf8').trim()
    )
      throw new CbError(
        'hook_exists',
        `${hook} is already there and is not cobalt's.`,
        'Add this line to it instead: cb env commit --staged',
        exit.usage,
      )
    mkdirSync(join(root, '.git', 'hooks'), { recursive: true })
    writeFileSync(
      hook,
      `#!/bin/sh\n# ${HOOK_MARK}\n# A staged .env file goes to cobalt, sealed, and leaves the commit.\nexec cb env commit --staged\n`,
    )
    chmodSync(hook, 0o755)
    print(ctx, { hook, installed: true }, () =>
      [
        `installed ${relative(process.cwd(), hook) || hook}`,
        'Now `git add .env && git commit` seals its values on cobalt; the file never enters a commit.',
      ].join('\n'),
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

const HOOK_MARK = 'cobalt: cb env hook'

function git(args: Array<string>, cwd?: string) {
  const r = Bun.spawnSync(['git', ...args], { cwd, stderr: 'pipe' })
  if (r.exitCode !== 0)
    throw new CbError(
      'git_failed',
      `git ${args.join(' ')} failed: ${r.stderr.toString().trim()}`,
      'Run it inside a clone.',
      exit.error,
    )
  return r.stdout.toString()
}

function gitRoot() {
  return git(['rev-parse', '--show-toplevel']).trim()
}

/**
 * `.env` files into cobalt instead of into git: every value is sealed on
 * cobalt for the environment its file is for (and sent on to the linked
 * host), the names go into .env.schema, and the files leave the index and
 * are kept out of it (.git/info/exclude, nothing to add to .gitignore).
 */
async function commitEnv(
  ctx: Parameters<Command>[1],
  path: string,
  given: Array<string>,
  flags: Parameters<Command>[0]['flags'],
) {
  const root = gitRoot()
  const dry = has(flags, 'dry-run')
  const staged = git(
    ['diff', '--cached', '--name-only', '--diff-filter=ACMR'],
    root,
  )
    .split('\n')
    .filter(Boolean)
  const files = (
    given.length
      ? given.map((f) => relative(root, join(process.cwd(), f)))
      : has(flags, 'staged')
        ? staged.filter(isValuesFile)
        : readdirSync(root).filter(isValuesFile)
  ).filter(isValuesFile)
  if (!files.length) {
    print(ctx, { files: [], sealed: [] }, () => 'no .env files to commit')
    return
  }
  const api = ctx.api()
  const sealed: Array<{ name: string; environment: string; file: string }> = []
  const failed: Array<{ name: string; environment: string; why: string }> = []
  for (const file of files) {
    const environment = environmentOf(file)
    for (const [name] of parseDotenv(readFileSync(join(root, file), 'utf8'))) {
      const value = parseDotenv(readFileSync(join(root, file), 'utf8')).find(
        ([n]) => n === name,
      )![1]
      try {
        if (!dry)
          await api.put(`${path}/env/${name}/${environment}`, {
            body: { value, declare: true },
          })
        sealed.push({ name, environment, file })
      } catch (e) {
        failed.push({
          name,
          environment,
          why:
            e instanceof CbError
              ? `${e.message}${e.hint ? ` ${e.hint}` : ''}`
              : String(e),
        })
      }
    }
  }
  // Names into the schema, which is committed: reviewers see a variable exists.
  const schemaPath = join(root, '.env.schema')
  const before = existsSync(schemaPath) ? readFileSync(schemaPath, 'utf8') : ''
  const { schema, added } = withNames(before, [
    ...new Set(sealed.map((s) => s.name)),
  ])
  if (!dry && added.length) writeFileSync(schemaPath, schema)
  if (!dry) {
    if (added.length) git(['add', '.env.schema'], root)
    const inIndex = files.filter(
      (f) => staged.includes(f) || git(['ls-files', f], root).trim(),
    )
    if (inIndex.length)
      git(['rm', '--cached', '--quiet', '--', ...inIndex], root)
    const exclude = join(root, '.git', 'info', 'exclude')
    mkdirSync(join(root, '.git', 'info'), { recursive: true })
    const have = existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''
    const missing = files.filter((f) => !have.split('\n').includes(`/${f}`))
    if (missing.length)
      appendFileSync(
        exclude,
        `${have.endsWith('\n') || !have ? '' : '\n'}# kept on cobalt (cb env commit)\n${missing.map((f) => `/${f}`).join('\n')}\n`,
      )
  }
  const known = schemaNames(schema)
  print(
    ctx,
    {
      files,
      sealed: sealed.map(({ name, environment }) => ({ name, environment })),
      failed,
      schema_added: added,
      in_schema: [...known].length,
      dryRun: dry,
    },
    () =>
      [
        ...sealed.map(
          (s) =>
            `${dry ? 'would seal' : 'sealed'} ${s.name} (${s.environment}) from ${s.file}`,
        ),
        ...added.map((n) => `added ${n} to .env.schema`),
        ...failed.map(
          (f) => `NOT sealed ${f.name} (${f.environment}): ${f.why}`,
        ),
        dry
          ? ''
          : `${files.join(', ')} left the commit and stay out of git (.git/info/exclude).`,
      ]
        .filter(Boolean)
        .join('\n'),
  )
  // A value that did not reach cobalt must not be lost: stop the commit.
  if (failed.length) return exit.error
}
