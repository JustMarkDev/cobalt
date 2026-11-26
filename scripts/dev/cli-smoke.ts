// Run every cb command against the local app and say which ones work.
//
//   bun scripts/dev/cli-smoke.ts                       # as mark
//   bun scripts/dev/cli-smoke.ts --as mark --read mark/music-companion
//
// Writes only to a new scratch repository (<you>/cb-smoke-<time>), which it
// leaves behind for a look; --read names a repository it only reads.
// Exits 1 when a step does not do what it should.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $ } from 'bun'

const flag = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? (process.argv.at(i + 1) ?? fallback) : fallback
}
const who = flag('as', 'mark')
const readOnly = flag('read', `${who}/music-companion`)
const API = process.env.CB_API ?? 'http://localhost:3000/api/v1'
const host = API.replace(/\/api\/v1$/, '')
const main = join(import.meta.dir, '../../packages/cli/src/main.ts')
const token = (
  await $`bun ${import.meta.dir}/token.ts ${who} --ttl 3600`.text()
).trim()
const name = `cb-smoke-${Date.now().toString(36)}`
const repo = `${who}/${name}`
const work = mkdtempSync(join(tmpdir(), 'cb-smoke-'))
const config = mkdtempSync(join(tmpdir(), 'cb-config-'))
const env = {
  ...process.env,
  CB_API: API,
  CB_TOKEN: token,
  CB_CONFIG_DIR: config,
  NO_COLOR: '1',
}

type Step = {
  cmd: string
  code: number
  want: Array<number>
  ms: number
  out: string
}
const steps: Array<Step> = []

async function cb(
  args: Array<string>,
  want: Array<number> = [0],
  o: { cwd?: string; stdin?: string } = {},
) {
  const t0 = performance.now()
  const p = Bun.spawn(['bun', main, ...args, '--json'], {
    cwd: o.cwd ?? work,
    env,
    stdin: o.stdin === undefined ? 'ignore' : new TextEncoder().encode(o.stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ])
  const step = {
    cmd: `cb ${args.join(' ')}`,
    code,
    want,
    ms: Math.round(performance.now() - t0),
    out: (out || err).trim(),
  }
  steps.push(step)
  const mark = want.includes(code) ? '✓' : '✗'
  console.log(
    `${mark} ${String(step.ms).padStart(5)}ms  exit ${code}  ${step.cmd}`,
  )
  if (!want.includes(code))
    console.log(`    ${step.out.slice(0, 400).replace(/\n/g, '\n    ')}`)
  try {
    return JSON.parse(out)
  } catch {
    return out
  }
}

const git = (cwd: string) => (args: Array<string>) =>
  $`git -c user.name=cb-smoke -c user.email=cb-smoke@example.com ${args}`
    .cwd(cwd)
    .quiet()

// Who and where
await cb(['auth', 'status'])
await cb(['account', 'list'])
await cb(['account', 'current'])
await cb(['config', 'list'])
await cb(['config', 'path'])
await cb(['commands'])
await cb(['skill'])
await cb(['completion', 'zsh'])

// Read only, on a real imported repository
await cb(['repo', 'view', '-R', readOnly])
await cb(['context', '-R', readOnly])
const changes = await cb(['change', 'list', '--all', '-R', readOnly])
await cb(['issue', 'list', '--state', 'all', '-R', readOnly])
await cb(['mirror', 'list', '-R', readOnly])
const open = Array.isArray(changes)
  ? changes.find((c: any) => c.state === 'open')
  : null
if (open) {
  await cb(['change', 'view', String(open.number), '-R', readOnly])
  await cb(['change', 'timeline', String(open.number), '-R', readOnly])
  await cb(['policy', 'explain', String(open.number), '-R', readOnly], [0, 5])
  await cb(['handoff', String(open.number), '-R', readOnly, '--to', 't3'])
}

// A scratch repository: create, push, change, issue, env, runner
await cb([
  'repo',
  'create',
  name,
  '--private',
  '--description',
  'cb smoke test (safe to delete)',
])
await cb(['repo', 'list'])
await cb(['repo', 'clone', repo])
const clone = join(work, name)
await $`git init -q -b main ${clone}`.quiet()
const g = git(clone)
writeFileSync(join(clone, 'README.md'), '# cb smoke\n')
writeFileSync(
  join(clone, '.env.schema'),
  '# @defaultSensitive=true\n# ---\nSMOKE_SECRET=\n',
)
await g(['add', '.'])
await g(['commit', '-qm', 'docs: start'])
await g([
  'remote',
  'add',
  'origin',
  `${host.replace('://', `://x:${token}@`)}/${repo}.git`,
])
await g(['push', '-q', 'origin', 'main'])
await cb(['repo', 'view'], [0], { cwd: clone })
await g(['checkout', '-qb', 'feat/hello'])
writeFileSync(join(clone, 'hello.txt'), 'hello\n')
await g(['add', '.'])
await g(['commit', '-qm', 'feat: say hello'])
await g(['push', '-q', 'origin', 'feat/hello'])
const change = await cb(['change', 'create', '--draft'], [0], { cwd: clone })
const n = String(change?.number ?? 1)
await cb(['change', 'list'], [0], { cwd: clone })
await cb(['change', 'view', n], [0], { cwd: clone })
await cb(['change', 'timeline', n], [0], { cwd: clone })
await cb(['change', 'presence', n, '--here'], [0], { cwd: clone })
await cb(['change', 'guide', n], [0, 3], { cwd: clone })
await cb(['policy', 'check', n], [0, 5], { cwd: clone })
await cb(['change', 'ready', n], [0], { cwd: clone })
await cb(['change', 'land', n, '--dry-run'], [0, 5], { cwd: clone })
await cb(['change', 'checkout', n], [0], { cwd: clone })

const png = join(work, 'shot.png')
await Bun.write(
  png,
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
)
const issue = await cb(
  [
    'issue',
    'create',
    'Smoke: it crashes',
    '--body',
    'Steps to reproduce.',
    '--screenshot',
    png,
    '--label',
    'bug',
  ],
  [0],
  { cwd: clone },
)
const i = String(issue?.number ?? 1)
await cb(['issue', 'attach', i, png, '--caption', 'again'], [0], { cwd: clone })
await cb(['issue', 'view', i], [0], { cwd: clone })
await cb(['issue', 'timeline', i], [0], { cwd: clone })
await cb(['handoff', i, '--to', 't3'], [0], { cwd: clone })
await cb(['issue', 'close', i], [0], { cwd: clone })

await cb(['env', 'set', 'SMOKE_SECRET', '-'], [0], {
  cwd: clone,
  stdin: 'hunter2-smoke',
})
await cb(['env', 'list'], [0], { cwd: clone })
const ran = await cb(
  [
    'env',
    'run',
    '--',
    'sh',
    '-c',
    'test "$SMOKE_SECRET" = hunter2-smoke && echo ok-$SMOKE_SECRET',
  ],
  [0],
  { cwd: clone },
)
if (
  typeof ran === 'string'
    ? ran.includes('hunter2-smoke')
    : JSON.stringify(ran).includes('hunter2-smoke')
)
  steps.push({
    cmd: 'env run scrubs the value from output',
    code: 1,
    want: [0],
    ms: 0,
    out: 'the secret value reached the output',
  })
await cb(['env', 'confirmations'], [0], { cwd: clone })

const runner = await cb([
  'runner',
  'register',
  `smoke-${Date.now().toString(36)}`,
  '--labels',
  'smoke',
  '--repos',
  repo,
])
await cb(['runner', 'list'])
if (runner?.id) await cb(['runner', 'revoke', runner.id])

await cb(['mirror', 'list'], [0], { cwd: clone })
await cb(['import', 'list'])

// The MCP server answers tools/list over stdio
const mcp = Bun.spawn(['bun', main, 'mcp'], {
  env,
  stdin: 'pipe',
  stdout: 'pipe',
  stderr: 'pipe',
})
const say = (m: object) => mcp.stdin.write(`${JSON.stringify(m)}\n`)
void say({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '0' },
  },
})
void say({ jsonrpc: '2.0', method: 'notifications/initialized' })
void say({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
await mcp.stdin.flush()
const reader = mcp.stdout.getReader()
let buf = ''
const until = Date.now() + 15_000
while (!/"id":2[,}]/.test(buf) && Date.now() < until) {
  const r = await Promise.race([
    reader.read(),
    Bun.sleep(1000).then(() => null),
  ])
  if (r && !r.done) buf += new TextDecoder().decode(r.value)
}
mcp.kill()
const tools =
  buf
    .split('\n')
    .flatMap((l) => {
      try {
        return [
          JSON.parse(l) as { id?: number; result?: { tools?: Array<unknown> } },
        ]
      } catch {
        return []
      }
    })
    .find((m) => m.id === 2)?.result?.tools?.length ?? 0
steps.push({
  cmd: 'cb mcp (tools/list)',
  code: tools > 0 ? 0 : 1,
  want: [0],
  ms: 0,
  out: `${tools} tools`,
})
console.log(
  `${tools > 0 ? '✓' : '✗'}          cb mcp answers tools/list with ${tools} tools`,
)

const bad = steps.filter((s) => !s.want.includes(s.code))
console.log(
  `\n${steps.length - bad.length}/${steps.length} steps did what they should. Scratch repository: ${host}/${repo}`,
)
process.exit(bad.length ? 1 : 0)
