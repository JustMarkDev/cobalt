import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pierre } from '@pierre/sdk'
import { remoteUrl } from '@pierre/sdk/git'

// Which clone features does code.storage's git endpoint offer?
//
//   railway run -- bun packages/git/probe/clone-features.ts
//
// It creates a scratch store, pushes three commits, then tries each way of
// fetching them that would make a checkout cheaper, and deletes the store.
// Nothing here is read from the docs: every line is what git itself said.

const org = process.env.PIERRE_ORG
const privateKey = process.env.PIERRE_PRIVATE_KEY
if (!org || !privateKey) {
  console.error(
    'PIERRE_ORG and PIERRE_PRIVATE_KEY are not set: run it with `railway run --`.',
  )
  process.exit(2)
}

const pierre = new Pierre({ org, privateKey })
const name = `cobalt-probe-clone-${Date.now().toString(36)}`
const work = mkdtempSync(join(tmpdir(), 'cb-clone-probe-'))

function git(cwd: string, ...args: Array<string>) {
  const p = Bun.spawnSync(
    [
      'git',
      '-c',
      'user.name=probe',
      '-c',
      'user.email=probe@example.invalid',
      ...args,
    ],
    { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
  )
  return {
    ok: p.exitCode === 0,
    out: `${p.stdout.toString()}${p.stderr.toString()}`.trim(),
  }
}

const results: Array<[string, boolean, string]> = []
const record = (what: string, ok: boolean, detail: string) => {
  results.push([what, ok, detail])
  console.log(`${ok ? 'yes' : 'NO '}  ${what}${detail ? `: ${detail}` : ''}`)
}

let made = false
try {
  await pierre.repos.create({ repo_name: name, default_branch: 'main' })
  made = true
  const url = await remoteUrl(pierre, {
    repo_name: name,
    scopes: ['git:read', 'git:write'],
    ttl: 900,
  })

  const src = join(work, 'src')
  git(work, 'init', '-q', '-b', 'main', src)
  for (let i = 0; i < 3; i++) {
    writeFileSync(join(src, `f${i}.txt`), `file ${i}\n`.repeat(100))
    git(src, 'add', '.')
    git(src, 'commit', '-q', '-m', `commit ${i}`)
  }
  const tip = git(src, 'rev-parse', 'HEAD').out
  const pushed = git(src, 'push', url, 'main')
  record('push over https', pushed.ok, pushed.ok ? '' : pushed.out)
  if (!pushed.ok) throw new Error('cannot push')

  const trace = Bun.spawnSync(
    ['git', '-c', 'protocol.version=2', 'ls-remote', url],
    { env: { ...process.env, GIT_TRACE_PACKET: '1' } },
  )
  const advert = `${trace.stdout.toString()}${trace.stderr.toString()}`
  record('protocol v2', /version 2/.test(advert), '')
  record(
    'advertises `filter` (partial clone)',
    /fetch=[^\n]*\bfilter\b/.test(advert),
    advert.match(/fetch=[^\n]*/)?.[0] ?? 'no fetch capability line',
  )
  record(
    'advertises `packfile-uris`',
    /packfile-uris/.test(advert),
    advert.match(/[^\n]*packfile-uris[^\n]*/)?.[0] ?? '',
  )

  const shallow = git(
    work,
    'clone',
    '-q',
    '--depth',
    '1',
    '--single-branch',
    url,
    'shallow',
  )
  record(
    'clone --depth 1 --single-branch',
    shallow.ok,
    shallow.ok ? '' : shallow.out,
  )

  const bySha = git(
    join(work, 'shallow'),
    'fetch',
    '-q',
    '--depth',
    '1',
    'origin',
    tip,
  )
  record('fetch one commit by id', bySha.ok, bySha.ok ? '' : bySha.out)

  const partial = git(
    work,
    'clone',
    '-q',
    '--filter=blob:none',
    '--no-checkout',
    url,
    'partial',
  )
  const promisor =
    partial.ok &&
    git(join(work, 'partial'), 'config', 'remote.origin.promisor').out ===
      'true'
  record(
    'clone --filter=blob:none (the server really filtered)',
    promisor,
    partial.ok ? '' : partial.out,
  )

  const sparse = git(
    work,
    'clone',
    '-q',
    '--sparse',
    '--depth',
    '1',
    url,
    'sparse',
  )
  record('clone --sparse', sparse.ok, sparse.ok ? '' : sparse.out)
} finally {
  if (made)
    await pierre.repos.delete({ repo_name: name }).catch((e: unknown) => {
      console.error(`could not delete ${name}: ${String(e)}`)
    })
  rmSync(work, { recursive: true, force: true })
}

process.exit(results.every(([, ok]) => ok) ? 0 : 1)
