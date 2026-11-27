// A repository that exists only on cobalt, with every agent-native feature in
// use: no GitHub link, nothing mirrored, so what cobalt does that GitHub
// cannot is what you see.
//
//   bun scripts/dev/seed-native.ts             # mark/cobalt-native-lab
//   bun scripts/dev/seed-native.ts --fresh     # delete it and start again
//   bun scripts/dev/seed-native.ts --as mark --name other-lab
//   bun scripts/dev/seed-native.ts --fresh --external-runner   # your runner runs the jobs
//
// Changes (draft, patch sets that address comments, a stack, findings with
// suggestions and agent prompts, a reading guide, checks bound to the tree,
// evidence, presence, a landed change that fires a trigger), policies with a
// path rule and an exception, an access rule, declined models and vouching,
// secrets per environment, receipts with tool and model, issues with
// screenshots, a hand-off, labels, a release, a webhook, a runner that runs
// the workflows, and a step that waits for a person.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { $ } from 'bun'

const flag = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? (process.argv.at(i + 1) ?? fallback) : fallback
}
const who = flag('as', 'mark')
const name = flag('name', 'cobalt-native-lab')
const full = `${who}/${name}`
const API = process.env.CB_API ?? 'http://localhost:3000/api/v1'
const host = API.replace(/\/api\/v1$/, '')
const main = join(import.meta.dir, '../../packages/cli/src/main.ts')
const token = (
  await $`bun ${import.meta.dir}/token.ts ${who} --ttl 3600`.text()
).trim()
const work = mkdtempSync(join(tmpdir(), 'native-lab-'))
const MODEL = 'Claude Opus 5.5'

let ok = 0
const failed: Array<string> = []
async function api(
  method: string,
  path: string,
  body?: unknown,
  o: { model?: string; quiet?: boolean } = {},
): Promise<any> {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'cb-tool': 'seed-native',
      ...(o.model ? { 'cb-model': o.model } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await r.text()
  const json = text ? JSON.parse(text) : null
  if (!o.quiet) {
    const good = r.ok
    if (good) ok++
    else failed.push(`${method} ${path}: ${r.status} ${json?.detail ?? text}`)
    console.log(
      `${good ? '✓' : '✗'} ${r.status} ${method} ${path}${good ? '' : `  ${json?.detail ?? ''}`}`,
    )
  }
  return r.ok ? json : null
}

const cb = async (args: Array<string>, cwd = repoDir, stdin?: string) => {
  const p = Bun.spawn(['bun', main, ...args, '--json'], {
    cwd,
    env: {
      ...process.env,
      CB_API: API,
      CB_TOKEN: token,
      CB_CONFIG_DIR: join(work, 'cfg'),
      CB_TOOL: 'seed-native',
      CB_MODEL: MODEL,
    },
    stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ])
  if (code === 0) ok++
  else failed.push(`cb ${args.join(' ')}: ${(err || out).trim().slice(0, 300)}`)
  console.log(`${code === 0 ? '✓' : '✗'} cb ${args.join(' ')}`)
  try {
    return JSON.parse(out)
  } catch {
    return out
  }
}

// --- The repository --------------------------------------------------------
const exists = await api('GET', `/repos/${full}`, undefined, { quiet: true })
if (exists && !process.argv.includes('--fresh')) {
  console.log(`${full} exists. Pass --fresh to delete it and seed it again.`)
  process.exit(0)
}
if (exists)
  await api('DELETE', `/repos/${full}?confirm=${encodeURIComponent(full)}`)
// Runners outlive a deleted repository: the lab's go with it.
const runners = await api('GET', '/runners', undefined, { quiet: true })
for (const r of runners?.data ?? [])
  if (String(r.name).startsWith(`${name}-`))
    await api('DELETE', `/runners/${r.id}`, undefined, { quiet: true })
await api('POST', '/repos', {
  name,
  visibility: 'private',
  description:
    'Cobalt-only lab: every agent-native feature, nothing linked to GitHub.',
})

const repoDir = join(work, name)
mkdirSync(repoDir)
const write = (files: Record<string, string | Uint8Array>) => {
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(repoDir, p)), { recursive: true })
    writeFileSync(join(repoDir, p), c)
  }
}
const git = (args: Array<string>) =>
  $`git -c user.name=${who} -c user.email=${who}@users.cobaltforge.dev ${args}`
    .cwd(repoDir)
    .quiet()
const commit = async (message: string, model = MODEL) => {
  await git(['add', '-A'])
  await git([
    'commit',
    '-qm',
    `${message}\n\nAssisted-by: claude-code:${model}`,
  ])
}
const push = (branch: string) => git(['push', '-qf', 'origin', branch])
const head = async () => (await git(['rev-parse', 'HEAD'])).text().trim()

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAKElEQVR42mNkYPhfz0AEYBxVSF+FjIyM/4lRSKxCRkZGxv/EKBzVTAEAg2gP8ZpU5W8AAAAASUVORK5CYII=',
  'base64',
)

await $`git init -q -b main ${repoDir}`.quiet()
await git([
  'remote',
  'add',
  'origin',
  `${host.replace('://', `://x:${token}@`)}/${full}.git`,
])
write({
  'README.md': `# Cobalt native lab

A repository that lives only on cobalt. It exists to try what cobalt does
that a GitHub mirror cannot: changes with patch sets and stacks, findings
with suggestions and agent prompts, reading guides, policies as code,
triggers, access rules, receipts, secrets for agents and steps that wait.

![logo](assets/logo.png)

\`\`\`sh
cb env run -- bun test
\`\`\`
`,
  'CONTRIBUTING.md':
    '# Contributing\n\nOpen a change with `cb change create`. Agents declare their model; checks and the AI reviewer come first.\n',
  'SECURITY.md':
    '# Security\n\nReport a vulnerability privately to the maintainers. Do not open an issue.\n',
  LICENSE: `MIT License\n\nCopyright (c) 2026 ${who}\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software, to deal in it without restriction.\n`,
  '.env.schema': `# @defaultSensitive=true @defaultRequired=false
# ---
# The port the API listens on
# @type=port @public
PORT=3000
# Signs session cookies
# @required
SESSION_SECRET=
# Stripe, for billing
STRIPE_KEY=
# @type=url @public
PUBLIC_URL=
`,
  'package.json': JSON.stringify(
    { name: 'native-lab', private: true, scripts: { test: 'bun test' } },
    null,
    2,
  ),
  'src/util/math.ts':
    'export const add = (a: number, b: number) => a + b\n\nexport const divide = (a: number, b: number) => a / b\n',
  'src/util/math.test.ts':
    "import { expect, test } from 'bun:test'\nimport { add } from './math'\n\ntest('add', () => expect(add(2, 2)).toBe(4))\n",
  'src/store/kv.ts':
    'const data = new Map<string, string>()\n\nexport const get = (k: string) => data.get(k)\nexport const set = (k: string, v: string) => void data.set(k, v)\n',
  'src/api/server.ts':
    "import { get } from '../store/kv'\n\nexport function handle(path: string) {\n  return get(path) ?? 'not found'\n}\n",
  'tools/report.py':
    'import csv\n\nwith open("data/sample.csv") as f:\n    print(sum(1 for _ in csv.reader(f)))\n',
  'cmd/lab/main.go':
    'package main\n\nimport "fmt"\n\nfunc main() { fmt.Println("lab") }\n',
  'crates/lab/src/lib.rs': 'pub fn answer() -> u32 {\n    42\n}\n',
  'scripts/build.sh': '#!/bin/sh\nset -eu\nbun build src/api/server.ts\n',
  'data/sample.csv': 'id,name\n1,ada\n2,grace\n',
  'config/app.json': '{ "features": { "billing": false } }\n',
  'docs/guide.md': '# Guide\n\nHow the lab is put together.\n',
  'docs/arch.svg':
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" rx="6" fill="#2563eb"/><text x="12" y="25" fill="#fff">api → kv</text></svg>\n',
  'assets/logo.png': PNG,
  'finance/budget.csv': 'quarter,amount\nQ1,1200\n',
  '.source/policy/main.yml': `rules:
  - id: ci-evidence
    mode: enforce
  - id: findings
    mode: enforce
  - id: reviewed
    mode: dry-run
  - id: storage-owners
    when:
      paths: ['src/store/**']
    require:
      - approval: { min: 1, from: [${who}] }
`,
  '.source/triggers/docs.yml': `triggers:
  - id: docs-build
    on: [change.landed]
    filter:
      paths: ['docs/**']
    run: Docs
`,
  '.github/workflows/ci.yml': `name: CI
on: [push]
jobs:
  test:
    runs-on: self-hosted
    steps:
      - uses: actions/checkout@v4
      - run: bun test
  lint:
    needs: test
    runs-on: self-hosted
    strategy:
      matrix:
        target: [api, store]
    steps:
      - run: echo "lint \${{ matrix.target }}"
`,
  '.github/workflows/deploy.yml': `name: Deploy
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: deploy-gate
    steps:
      - run: echo building
      - run: echo shipping
`,
  '.github/workflows/docs.yml': `name: Docs
on:
  push:
    branches: [main]
jobs:
  build:
    runs-on: self-hosted
    steps:
      - run: ls docs
`,
})
await commit('chore: the lab, with every kind of file')
await push('main')
const base = await head()

// --- Settings, labels, rules, secrets ---------------------------------------
await api('PATCH', `/repos/${full}`, {
  category: 'Developer tools',
  website: 'https://cobaltforge.dev',
  declined_models: ['GPT-3.5 Turbo'],
  vouched: [who],
  auto_land: false,
})
for (const [l, color] of [
  ['bug', 'red'],
  ['feature', 'blue'],
  ['docs', 'purple'],
  ['agent', 'green'],
] as const)
  await api('POST', `/repos/${full}/labels`, { name: l, color })
await api('PUT', `/repos/${full}/access-rules/finance`, {
  kind: 'path',
  patterns: ['finance/**'],
  readers: [who],
})
// The policy and the triggers come from the files just pushed: wait for them.
for (let i = 0; i < 30; i++) {
  const pol = await api('GET', `/repos/${full}/policy`, undefined, {
    quiet: true,
  })
  if (JSON.stringify(pol ?? {}).includes('storage-owners')) break
  await Bun.sleep(1000)
}
const week = new Date(Date.now() + 7 * 86_400_000).toISOString()
await api('POST', `/repos/${full}/policy/exceptions`, {
  rule: 'storage-owners',
  who,
  reason: 'Seeding the lab: the store has one owner today',
  expires_at: week,
})
for (const [n, env, value] of [
  ['SESSION_SECRET', 'development', 'dev-session-secret-123'],
  ['SESSION_SECRET', 'preview', 'preview-session-secret-456'],
  ['SESSION_SECRET', 'production', 'prod-session-secret-789'],
  ['STRIPE_KEY', 'development', 'sk_test_lab_000111'],
  ['STRIPE_KEY', 'production', 'sk_live_lab_999888'],
  ['PUBLIC_URL', 'development', 'http://localhost:3000'],
] as const)
  await api('PUT', `/repos/${full}/env/${n}/${env}`, { value, declare: true })
await api('POST', `/repos/${full}/webhooks`, {
  endpoint: 'https://example.com/cobalt-hook',
  events: ['change.landed', 'issue.opened'],
  description: 'Lab webhook (goes nowhere)',
})

// --- Issues -----------------------------------------------------------------
const shot = join(work, 'crash.png')
writeFileSync(shot, PNG)
const bug = await cb([
  'issue',
  'create',
  'Dividing by zero returns Infinity',
  '--body',
  '`divide(1, 0)` should throw, not return Infinity.',
  '--label',
  'bug',
  '--screenshot',
  shot,
])
await cb([
  'issue',
  'create',
  'Paginate the API',
  '--body',
  'Lists past 100 items need a cursor.',
  '--label',
  'feature',
])
const agentIssue = await cb([
  'issue',
  'create',
  'Write the architecture doc',
  '--body',
  'Explain api → kv with the diagram in docs/arch.svg.',
  '--label',
  'agent',
])
const closed = await cb([
  'issue',
  'create',
  'Typo in README',
  '--body',
  'Fixed already.',
])
if (closed?.number) await cb(['issue', 'close', String(closed.number)])
if (agentIssue?.number)
  await api('POST', `/repos/${full}/handoffs`, {
    subject: String(agentIssue.number),
    to: 't3',
  })

// --- Changes ----------------------------------------------------------------
const branch = async (
  ref: string,
  from: string,
  files: Record<string, string>,
  message: string,
) => {
  await git(['checkout', '-qB', ref, from])
  write(files)
  await commit(message)
  await push(ref)
  return head()
}
const change = (b: Record<string, unknown>) =>
  api('POST', `/repos/${full}/changes`, b, { model: MODEL })

// A draft
await branch(
  'feat/pagination',
  base,
  {
    'src/api/server.ts':
      "import { get } from '../store/kv'\n\nexport function handle(path: string, cursor?: string) {\n  return get(path) ?? 'not found'\n}\n",
  },
  'feat(api): accept a cursor',
)
await change({
  branch: 'feat/pagination',
  title: 'feat(api): paginate lists',
  description: 'Starts #2. Not ready.',
  draft: true,
})

// Two patch sets, the second addressing a comment; guide, findings, checks,
// evidence, a review and presence
const ps1 = await branch(
  'fix/divide',
  base,
  {
    'src/util/math.ts':
      'export const add = (a: number, b: number) => a + b\n\nexport const divide = (a: number, b: number) => {\n  if (b === 0) return NaN\n  return a / b\n}\n',
  },
  'fix(math): no Infinity from divide',
)
const fix = await change({
  branch: 'fix/divide',
  title: 'fix(math): dividing by zero',
  description: `Fixes #${bug?.number ?? 1}.`,
})
const n = fix?.number
if (n) {
  const c = await api('POST', `/repos/${full}/changes/${n}/comments`, {
    body: 'NaN hides the mistake. Throw instead?',
    file: 'src/util/math.ts',
    line: 4,
  })
  await git(['checkout', '-q', 'fix/divide'])
  write({
    'src/util/math.ts':
      "export const add = (a: number, b: number) => a + b\n\nexport const divide = (a: number, b: number) => {\n  if (b === 0) throw new RangeError('division by zero')\n  return a / b\n}\n",
    'src/util/math.test.ts':
      "import { expect, test } from 'bun:test'\nimport { add, divide } from './math'\n\ntest('add', () => expect(add(2, 2)).toBe(4))\ntest('divide by zero throws', () => expect(() => divide(1, 0)).toThrow())\n",
  })
  await commit('fix(math): throw on zero, with a test')
  await push('fix/divide')
  const ps2 = await head()
  // The push is the new patch set; it says which comment it answers.
  await Bun.sleep(1500)
  if (c?.id)
    await api(
      'POST',
      `/repos/${full}/changes/${n}/comments/${c.id}/address`,
      { note: 'Throws now, as asked' },
      { model: MODEL },
    )
  await api('PUT', `/repos/${full}/changes/${n}/guide`, {
    summary: 'divide throws on zero instead of returning Infinity.',
    order: [
      {
        path: 'src/util/math.ts',
        why: 'The fix, for callers that relied on Infinity',
        risk: 'medium',
      },
      { path: 'src/util/math.test.ts', why: 'Proves it', risk: 'low' },
    ],
  })
  await api('POST', `/repos/${full}/changes/${n}/findings`, {
    severity: 'high',
    file: 'src/util/math.ts',
    line: 4,
    title: 'Negative zero still divides',
    body: '`divide(1, -0)` passes the check on some paths. Use Object.is.',
    suggestion: {
      summary: 'Catch -0 too',
      file: 'src/util/math.ts',
      replace: ["  if (b === 0) throw new RangeError('division by zero')"],
      lines: [
        "  if (b === 0 || Object.is(b, -0)) throw new RangeError('division by zero')",
      ],
    },
    prompt:
      'In src/util/math.ts, make divide throw for -0 as well, and add a test.',
  })
  await api('POST', `/repos/${full}/changes/${n}/findings`, {
    severity: 'low',
    file: 'src/util/math.test.ts',
    line: 5,
    title: 'Name the error in the test',
    prompt: 'Assert the RangeError message in the divide test.',
  })
  const tree =
    (
      await api('GET', `/repos/${full}/changes/${n}`, undefined, {
        quiet: true,
      })
    )?.head?.tree ?? ps2.slice(0, 7)
  await api('POST', `/repos/${full}/changes/${n}/checks`, {
    key: 'ci/test',
    state: 'pass',
    tree,
    name: 'Unit tests',
    cases: [
      { suite: 'math', name: 'add', ms: 1, base: 'pass', head: 'pass' },
      {
        suite: 'math',
        name: 'divide by zero throws',
        ms: 2,
        base: 'fail',
        head: 'pass',
      },
    ],
  })
  await api('POST', `/repos/${full}/changes/${n}/checks`, {
    key: 'lint',
    state: 'pass',
    tree: ps1.slice(0, 7),
    name: 'Lint (on patch set 1: not evidence for this tree)',
  })
  await api('POST', `/repos/${full}/changes/${n}/reviews`, {
    state: 'commented',
    body: 'Looks right once the -0 finding is handled.',
  })
  await api('PUT', `/repos/${full}/changes/${n}/presence`, {
    session: 'seed-native-reader',
    path: 'src/util/math.ts',
  })
}

// A stack of two
await branch(
  'stack/kv-ttl',
  base,
  {
    'src/store/kv.ts':
      'const data = new Map<string, { v: string; until: number }>()\n\nexport const get = (k: string) => {\n  const e = data.get(k)\n  return e && e.until > Date.now() ? e.v : undefined\n}\nexport const set = (k: string, v: string, ttl = 60_000) =>\n  void data.set(k, { v, until: Date.now() + ttl })\n',
  },
  'feat(store): keys expire',
)
await change({ branch: 'stack/kv-ttl', title: 'feat(store): keys expire' })
await branch(
  'stack/kv-stats',
  'stack/kv-ttl',
  {
    'src/store/stats.ts':
      "import { get } from './kv'\n\nexport const hit = (k: string) => get(k) !== undefined\n",
  },
  'feat(store): hit counter',
)
await change({
  branch: 'stack/kv-stats',
  base: 'stack/kv-ttl',
  title: 'feat(store): count hits',
})

// A docs change that lands and fires the docs trigger
await branch(
  'docs/architecture',
  base,
  {
    'docs/guide.md':
      '# Guide\n\nHow the lab is put together.\n\n## Architecture\n\n![api to kv](arch.svg)\n\nThe API reads from an in-memory store.\n',
  },
  'docs: architecture',
)
const docs = await change({
  branch: 'docs/architecture',
  title: 'docs: architecture',
  description: `Closes #${agentIssue?.number ?? 3}.`,
})
if (docs?.number) {
  const tree =
    (
      await api('GET', `/repos/${full}/changes/${docs.number}`, undefined, {
        quiet: true,
      })
    )?.head?.tree ?? ''
  await api('POST', `/repos/${full}/changes/${docs.number}/checks`, {
    key: 'ci/test',
    state: 'pass',
    tree,
    name: 'Unit tests',
  })
  await Bun.sleep(1500)
  await api('POST', `/repos/${full}/changes/${docs.number}/land`, {
    expected_tree: tree,
  })
}

// A change from a declined model
await branch(
  'chore/old-model',
  base,
  { 'config/app.json': '{ "features": { "billing": true } }\n' },
  'chore: turn billing on',
)
await api(
  'POST',
  `/repos/${full}/changes`,
  { branch: 'chore/old-model', title: 'chore: turn billing on' },
  { model: 'GPT-3.5 Turbo', quiet: true },
).then((r) =>
  console.log(
    r
      ? '✗ the declined model opened a change'
      : '✓ the declined model was turned away',
  ),
)

// --- A release --------------------------------------------------------------
await api('POST', `/repos/${full}/releases`, {
  tag: 'v0.1.0',
  title: 'Lab 0.1.0',
  commit: base,
  notes: {
    added: ['Every kind of file', 'Policies and triggers'],
    fixed: ['Nothing yet'],
  },
})

// --- A runner runs the workflows; one step then waits for a person ----------
// --external-runner: a `cb runner start` already running takes the jobs.
const runner = process.argv.includes('--external-runner')
  ? null
  : await api('POST', '/runners', {
      name: `${name}-runner`,
      labels: ['self-hosted', 'linux', 'macos'],
      repos: [full],
    })
if (runner?.secret) {
  for (let i = 0; i < 60; i++) {
    const p = Bun.spawn(['bun', main, 'runner', 'start', '--once', '--json'], {
      env: {
        ...process.env,
        CB_API: API,
        CB_RUNNER_TOKEN: runner.secret,
        CB_CONFIG_DIR: join(work, 'cfg'),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = await new Response(p.stdout).text()
    await p.exited
    if (out.includes('"ran": null')) break
    console.log(`  runner: ${out.replace(/\s+/g, ' ').slice(0, 120)}`)
  }
}
// The deploy gate: a second runner takes the deploy job, runs its first
// step and pauses the second until a person says go.
const gate = await api('POST', '/runners', {
  name: `${name}-deploy-gate`,
  labels: ['deploy-gate'],
  repos: [full],
})
if (gate?.secret) {
  const as = (path: string, body?: unknown) =>
    fetch(`${API}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${gate.secret}`,
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  await as('/runners/heartbeat')
  const claim = await as('/runners/claim')
  const job: any = claim.status === 200 ? await claim.json() : null
  if (job) {
    const at = { repo: full, run: job.run, job: job.job }
    await as('/runners/report', { ...at, step: 1, status: 'running' })
    await as('/runners/report', {
      ...at,
      step: 1,
      status: 'success',
      lines: [{ text: 'building', level: null }],
      duration_ms: 1200,
    })
    await as('/runners/report', { ...at, step: 2, status: 'running' })
    const w = await as('/runners/wait', {
      ...at,
      step: 2,
      kind: 'approval',
      reason: 'Ship to production? Check the preview first.',
      target: who,
    })
    console.log(`${w.ok ? '✓' : '✗'} ${w.status} deploy waits for ${who}`)
    if (w.ok) ok++
    else failed.push(`runners/wait: ${w.status} ${await w.text()}`)
  } else failed.push('the deploy gate found no job to claim')
}

console.log(
  `\n${ok} steps worked, ${failed.length} did not.${failed.length ? `\n  ${failed.join('\n  ')}` : ''}\n${host}/${full}`,
)
process.exit(failed.length ? 1 : 0)
