// What every probe scenario shares: the Code Storage client, GitHub through
// `gh`, git against both remotes, polling, and the guard that only ever lets a
// probe delete a repository whose name starts with `cobalt-probe-`.
//
// Nothing here prints a secret. Code Storage tokens are passed to git through
// `GIT_CONFIG_*` variables, never on the command line, and are never logged.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Pierre } from '@pierre/sdk'
import { createToken } from '@pierre/sdk/auth'

export const PREFIX = 'cobalt-probe-'
/** The only GitHub account a probe may create or delete repositories on. */
export const GITHUB_OWNER = 'JustMarkDev'

export type Outcome = 'pass' | 'fail' | 'finding' | 'skipped'

export type Report = {
  outcome: Outcome
  /** One line: what the scenario found. */
  summary: string
  /** What it means for the row of the risk table, and for the later phases. */
  consequence: string
  /** The risk-table row this answers, by its first words. */
  risk?: string
}

export type Scenario = {
  id: string
  title: string
  run: (ctx: Ctx) => Promise<Report>
}

// ---------------------------------------------------------------------------
// Errors and logging

export const errorOf = (e: unknown): string => {
  const x = e as
    | { status?: number; code?: string; message?: string; body?: unknown }
    | null
    | undefined
  if (typeof x?.status === 'number') {
    const body =
      x.body && typeof x.body === 'object'
        ? ` body=${JSON.stringify(x.body)}`
        : ''
    return `${x.status} ${x.code ?? ''} ${x.message ?? ''}${body}`.trim()
  }
  return x?.message ?? String(e)
}

export const codeOf = (e: unknown): string | undefined =>
  (e as { code?: string } | null | undefined)?.code

export const statusOf = (e: unknown): number | undefined =>
  (e as { status?: number } | null | undefined)?.status

export class Log {
  readonly lines: Array<string> = []
  readonly t0 = Date.now()
  constructor(readonly id: string) {}
  line(text: string) {
    const at = ((Date.now() - this.t0) / 1000).toFixed(1).padStart(6)
    const l = `[${at}s] ${text}`
    this.lines.push(l)
    console.log(`  ${this.id} ${l}`)
  }
}

// ---------------------------------------------------------------------------
// Shell

export type Ran = { ok: boolean; code: number; out: string; ms: number }

export function sh(
  args: Array<string>,
  o: { cwd?: string; env?: Record<string, string>; input?: string } = {},
): Ran {
  const t = Date.now()
  const p = Bun.spawnSync(args, {
    cwd: o.cwd,
    env: { ...process.env, ...o.env },
    stdin: o.input === undefined ? 'ignore' : Buffer.from(o.input),
  })
  return {
    ok: p.exitCode === 0,
    code: p.exitCode,
    out: `${p.stdout.toString()}${p.stderr.toString()}`.trim(),
    ms: Date.now() - t,
  }
}

/** The text of a git or gh answer, with lines that only report progress removed. */
export const clean = (out: string) =>
  out
    .split('\n')
    .filter(
      (l) =>
        !/^(remote: )?(Enumerating|Counting|Compressing|Writing|Total|Delta|Resolving|Receiving|Unpacking) /.test(
          l,
        ),
    )
    .join('\n')
    .trim()

// ---------------------------------------------------------------------------
// Polling

export async function until<T>(
  check: () =>
    | Promise<T | undefined | null | false>
    | T
    | undefined
    | null
    | false,
  o: { timeout: number; every?: number },
): Promise<
  { value: T; ms: number } | { value: undefined; ms: number; last: string }
> {
  const t = Date.now()
  let last = ''
  while (Date.now() - t < o.timeout) {
    try {
      const v = await check()
      if (v) return { value: v, ms: Date.now() - t }
      last = String(v)
    } catch (e) {
      last = errorOf(e)
    }
    await Bun.sleep(o.every ?? 1000)
  }
  return { value: undefined, ms: Date.now() - t, last }
}

// ---------------------------------------------------------------------------
// Context

export class Ctx {
  readonly pierre: Pierre
  readonly gitHost: string
  readonly cleanups: Array<{ what: string; run: () => Promise<void> | void }> =
    []
  readonly dirs: Array<string> = []
  readonly log: Log
  readonly stamp: string

  constructor(
    readonly scenario: string,
    readonly keep: boolean,
    pierre: Pierre,
  ) {
    this.pierre = pierre
    const host = pierre.options.gitHost
    if (!host) throw new Error('Code Storage has no git host configured.')
    this.gitHost = host
    this.log = new Log(scenario)
    this.stamp = `${Date.now().toString(36)}`
  }

  /** A fresh name for a probe repository. */
  name(tag: string) {
    return `${PREFIX}${this.stamp}-${tag}`
  }

  tmp(): string {
    const d = mkdtempSync(join(tmpdir(), 'cobalt-probe-'))
    this.dirs.push(d)
    return d
  }

  onCleanup(what: string, run: () => Promise<void> | void) {
    this.cleanups.unshift({ what, run })
  }

  async cleanup() {
    for (const d of this.dirs) rmSync(d, { recursive: true, force: true })
    if (this.keep) {
      for (const c of this.cleanups) this.log.line(`kept: ${c.what}`)
      return
    }
    for (const c of this.cleanups) {
      try {
        await c.run()
        this.log.line(`cleanup: ${c.what}: done`)
      } catch (e) {
        this.log.line(`cleanup: ${c.what}: FAILED: ${errorOf(e)}`)
      }
    }
  }

  // -------------------------------------------------------------------------
  // Code Storage

  async storeCreate(
    name: string,
    upstream: {
      owner: string
      name: string
      access?: 'app' | 'public'
      provider?: string
      host?: string
    },
    // Without it, a GitHub upstream answers 412 github_repository_inaccessible
    // (see github-01-create), so the probe always names it.
    defaultBranch: string | null = 'main',
  ) {
    assertProbeName(name)
    const t = Date.now()
    await this.pierre.repos.create({
      repo_name: name,
      upstream: { provider: 'github', ...upstream },
      ...(defaultBranch ? { default_branch: defaultBranch } : {}),
    })
    this.onCleanup(`Code Storage ${name}`, () => this.storeDelete(name))
    return Date.now() - t
  }

  async storeDelete(name: string) {
    assertProbeName(name)
    await this.pierre.repos.delete({ repo_name: name })
  }

  async storeBranches(name: string): Promise<Map<string, string>> {
    const page = await this.pierre.repos.branches.list({
      repo_name: name,
      limit: 100,
    })
    return new Map(page.body.branches.map((b) => [b.name, b.head_sha]))
  }

  async storeTags(name: string): Promise<Map<string, string>> {
    const page = await this.pierre.repos.tags.list({
      repo_name: name,
      limit: 100,
    })
    return new Map(page.body.tags.map((t) => [t.name, t.sha]))
  }

  async storeHead(name: string, branch = 'main'): Promise<string | undefined> {
    return (await this.storeBranches(name)).get(branch)
  }

  async storePull(name: string) {
    const t = Date.now()
    const r = await this.pierre.repos.upstream.pull({ repo_name: name })
    return { ms: Date.now() - t, message: r.message }
  }

  /** Pulls, retrying while the store answers 409 sync_in_progress. */
  async storePullSettled(name: string, timeout = 60_000) {
    const t = Date.now()
    let busy = 0
    for (;;) {
      try {
        const r = await this.storePull(name)
        return { ...r, busy, ms: Date.now() - t }
      } catch (e) {
        if (codeOf(e) === 'sync_in_progress' && Date.now() - t < timeout) {
          busy++
          await Bun.sleep(1000)
          continue
        }
        throw e
      }
    }
  }

  /** Waits until the store's branch points at `sha` (or is gone, for `null`). */
  async storeWaitFor(
    name: string,
    branch: string,
    sha: string | null,
    timeout = 60_000,
  ) {
    return until(
      async () => {
        const head = (await this.storeBranches(name)).get(branch)
        return sha === null ? head === undefined : head === sha
      },
      { timeout, every: 1000 },
    )
  }

  async remoteToken(name: string) {
    return createToken(this.pierre, {
      scopes: ['git:read', 'git:write'],
      repo: name,
      ttl: 600,
      subject: 'cobalt-probe',
    })
  }

  /** git against the Code Storage remote of `name`, with a fresh token. */
  async gitStore(name: string, cwd: string, args: Array<string>) {
    const token = await this.remoteToken(name)
    return sh(['git', ...args], {
      cwd,
      env: {
        ...gitIdentity,
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.extraHeader',
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${btoa(`t:${token}`)}`,
      },
    })
  }

  storeUrl(name: string) {
    return `https://${this.gitHost}/${name}.git`
  }

  /** A clone of the Code Storage repository in a new folder. */
  async cloneStore(name: string): Promise<string> {
    const dir = join(this.tmp(), 'store')
    const r = await this.gitStore(name, dirname(dir), [
      'clone',
      '--quiet',
      this.storeUrl(name),
      dir,
    ])
    if (!r.ok) throw new Error(`clone of the store failed: ${clean(r.out)}`)
    return dir
  }

  // -------------------------------------------------------------------------
  // GitHub

  ghCreate(name: string, o: { public?: boolean } = {}) {
    assertProbeName(name)
    const r = sh([
      'gh',
      'repo',
      'create',
      `${GITHUB_OWNER}/${name}`,
      o.public ? '--public' : '--private',
      '--add-readme',
    ])
    if (!r.ok) throw new Error(`gh repo create failed: ${r.out}`)
    this.onCleanup(`GitHub ${name}`, () => ghDelete(name))
  }

  /** Deletes a GitHub repository made outside ghCreate (a fork) at the end. */
  ghOwned(name: string) {
    assertProbeName(name)
    this.onCleanup(`GitHub ${name}`, () => ghDelete(name))
  }

  /** Re-points the GitHub cleanup after a rename. */
  ghRenamed(from: string, to: string) {
    assertProbeName(to)
    const i = this.cleanups.findIndex((c) => c.what === `GitHub ${from}`)
    const entry = { what: `GitHub ${to}`, run: () => ghDelete(to) }
    if (i >= 0) this.cleanups[i] = entry
    else this.cleanups.unshift(entry)
  }

  gh<T = any>(args: Array<string>, input?: unknown): T {
    const r = sh(
      ['gh', 'api', ...args, ...(input === undefined ? [] : ['--input', '-'])],
      input === undefined ? {} : { input: JSON.stringify(input) },
    )
    if (!r.ok) throw new GhError(args.join(' '), r.out)
    return (r.out ? JSON.parse(r.out) : undefined) as T
  }

  ghHead(repo: string, branch = 'main'): string | undefined {
    try {
      return this.gh<{ object: { sha: string } }>([
        `repos/${GITHUB_OWNER}/${repo}/git/ref/heads/${branch}`,
      ]).object.sha
    } catch (e) {
      if (e instanceof GhError && /404|Not Found/.test(e.out)) return undefined
      throw e
    }
  }

  ghTag(repo: string, tag: string): string | undefined {
    try {
      return this.gh<{ object: { sha: string } }>([
        `repos/${GITHUB_OWNER}/${repo}/git/ref/tags/${tag}`,
      ]).object.sha
    } catch (e) {
      if (e instanceof GhError && /404|Not Found/.test(e.out)) return undefined
      throw e
    }
  }

  /** A commit made on GitHub through the contents API. Returns its sha. */
  ghCommit(repo: string, path: string, text: string, branch = 'main'): string {
    let sha: string | undefined
    try {
      sha = this.gh<{ sha: string }>([
        `repos/${GITHUB_OWNER}/${repo}/contents/${path}?ref=${branch}`,
      ]).sha
    } catch {}
    const r = this.gh<{ commit: { sha: string } }>(
      ['-X', 'PUT', `repos/${GITHUB_OWNER}/${repo}/contents/${path}`],
      {
        message: `probe: ${path} on GitHub`,
        content: Buffer.from(text).toString('base64'),
        branch,
        ...(sha ? { sha } : {}),
      },
    )
    return r.commit.sha
  }

  async ghWaitFor(
    repo: string,
    branch: string,
    sha: string | null,
    timeout = 60_000,
  ) {
    return until(
      () => {
        const head = this.ghHead(repo, branch)
        return sha === null ? head === undefined : head === sha
      },
      { timeout, every: 1000 },
    )
  }

  /** git against GitHub, with gh as the credential helper. */
  gitGithub(cwd: string, args: Array<string>) {
    return sh(['git', ...args], {
      cwd,
      env: {
        ...gitIdentity,
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_0: 'credential.https://github.com.helper',
        GIT_CONFIG_VALUE_0: '',
        GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
        GIT_CONFIG_VALUE_1: '!gh auth git-credential',
      },
    })
  }

  cloneGithub(repo: string): string {
    const dir = join(this.tmp(), 'github')
    const r = this.gitGithub(dirname(dir), [
      'clone',
      '--quiet',
      `https://github.com/${GITHUB_OWNER}/${repo}.git`,
      dir,
    ])
    if (!r.ok) throw new Error(`clone of GitHub failed: ${clean(r.out)}`)
    return dir
  }

  /** A GitHub repository with a README and a Code Storage repository synced from it. */
  async pair(tag: string, o: { public?: boolean } = {}) {
    const name = this.name(tag)
    this.ghCreate(name, o)
    const ghMain = this.ghHead(name)
    if (!ghMain) throw new Error('the new GitHub repository has no main')
    await this.storeCreate(name, { owner: GITHUB_OWNER, name })
    const synced = await this.storeWaitFor(name, 'main', ghMain, 120_000)
    if (!synced.value)
      throw new Error(`first sync did not arrive in 120 s: ${synced.last}`)
    this.log.line(`pair ${name}: first sync after ${synced.ms} ms`)
    return { name, main: ghMain }
  }
}

export class GhError extends Error {
  constructor(
    what: string,
    readonly out: string,
  ) {
    super(`gh api ${what}: ${out}`)
  }
}

export const gitIdentity = {
  GIT_AUTHOR_NAME: 'cobalt-probe',
  GIT_AUTHOR_EMAIL: 'probe@cobaltforge.dev',
  GIT_COMMITTER_NAME: 'cobalt-probe',
  GIT_COMMITTER_EMAIL: 'probe@cobaltforge.dev',
}

export function assertProbeName(name: string) {
  if (!name.startsWith(PREFIX) || name.includes('/'))
    throw new Error(`refusing to touch "${name}": not a ${PREFIX} repository`)
}

export function ghDelete(name: string) {
  assertProbeName(name)
  const r = sh(['gh', 'repo', 'delete', `${GITHUB_OWNER}/${name}`, '--yes'])
  if (!r.ok) throw new Error(r.out)
}

/** Writes a file inside a clone and commits it. Returns the new sha. */
export function commitFile(
  dir: string,
  path: string,
  text: string,
  message?: string,
) {
  const file = join(dir, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
  const add = sh(['git', 'add', path], { cwd: dir })
  if (!add.ok) throw new Error(add.out)
  const c = sh(
    ['git', 'commit', '--quiet', '-m', message ?? `probe: ${path}`],
    {
      cwd: dir,
      env: gitIdentity,
    },
  )
  if (!c.ok) throw new Error(c.out)
  return sh(['git', 'rev-parse', 'HEAD'], { cwd: dir }).out
}

export function revParse(dir: string, ref = 'HEAD') {
  return sh(['git', 'rev-parse', ref], { cwd: dir }).out
}

export function pierreFromEnv(): Pierre {
  const org = process.env.PIERRE_ORG
  const privateKey = process.env.PIERRE_PRIVATE_KEY
  if (!org || !privateKey)
    throw new Error(
      'PIERRE_ORG and PIERRE_PRIVATE_KEY are not set: run it with `railway run --`.',
    )
  return new Pierre({ org, privateKey })
}
