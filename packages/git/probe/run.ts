// The Code Storage probe. Each scenario answers one open risk of the provider
// sync plan (docs/plans/provider-sync.md) and writes what it saw, with exact
// errors and timings, into docs/plans/probe-results.md.
//
//   railway run -- bun packages/git/probe/run.ts --only github
//   railway run -- bun packages/git/probe/run.ts --scenario github-04-divergence
//   ... --keep      keep the probe repositories instead of deleting them
//
// Railway injects PIERRE_ORG and PIERRE_PRIVATE_KEY without writing them to
// disk. Every repository a scenario makes is named `cobalt-probe-<time>-<tag>`,
// on the GitHub account JustMarkDev and in the Code Storage org, and is deleted
// when the scenario ends, failed or not. Nothing else is ever deleted.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Ctx, GITHUB_OWNER, errorOf, pierreFromEnv, sh } from './lib'
import { forgejoScenarios, stopForgejo } from './forgejo'
import { githubScenarios } from './github'
import type { Report, Scenario } from './lib'

const RESULTS = join(import.meta.dir, '../../../docs/plans/probe-results.md')

const families: Record<string, Array<Scenario>> = {
  github: githubScenarios,
  forgejo: forgejoScenarios,
}

function parse(argv: Array<string>) {
  const o = {
    only: [] as Array<string>,
    scenarios: [] as Array<string>,
    keep: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--keep') o.keep = true
    else if (a === '--only') o.only.push(...(argv[++i] ?? '').split(','))
    else if (a === '--scenario')
      o.scenarios.push(...(argv[++i] ?? '').split(','))
    else throw new Error(`unknown argument ${a}`)
  }
  return o
}

const opts = parse(process.argv.slice(2))
const chosen = Object.entries(families)
  .filter(([f]) => !opts.only.length || opts.only.includes(f))
  .flatMap(([, s]) => s)
  .filter((s) => !opts.scenarios.length || opts.scenarios.includes(s.id))
if (!chosen.length) {
  console.error('No scenario matches.')
  process.exit(2)
}

const me = sh(['gh', 'api', 'user', '--jq', '.login'])
if (!me.ok || me.out !== GITHUB_OWNER) {
  console.error(
    `gh must be signed in as ${GITHUB_OWNER} (it answers: ${me.out}).`,
  )
  process.exit(2)
}
const pierre = pierreFromEnv()

type Result = {
  scenario: Scenario
  report: Report
  lines: Array<string>
  ms: number
}
const results: Array<Result> = []

for (const scenario of chosen) {
  console.log(`\n== ${scenario.id}: ${scenario.title}`)
  const ctx = new Ctx(scenario.id, opts.keep, pierre)
  let report: Report
  try {
    report = await scenario.run(ctx)
  } catch (e) {
    ctx.log.line(`stopped: ${errorOf(e)}`)
    report = {
      outcome: 'fail',
      summary: `The scenario stopped: ${errorOf(e)}`,
      consequence: 'Not answered; see the log.',
    }
  } finally {
    await ctx.cleanup()
  }
  const ms = Date.now() - ctx.log.t0
  console.log(`-> ${report.outcome.toUpperCase()}: ${report.summary}`)
  results.push({ scenario, report, lines: ctx.log.lines, ms })
}

stopForgejo()

// ---------------------------------------------------------------------------
// docs/plans/probe-results.md keeps one section per scenario. A run replaces
// the sections of the scenarios it ran and keeps the others.

const HEAD = `# Code Storage probe: results

Written by \`packages/git/probe/run.ts\`. Each section is the last run of one
scenario: outcome, timings, the exact answers, and what it means for the risk
table in \`docs/plans/provider-sync.md\`. Re-run a scenario with
\`railway run -- bun packages/git/probe/run.ts --scenario <id>\`.
`

const begin = (id: string) => `<!-- probe:${id}:begin -->`
const end = (id: string) => `<!-- probe:${id}:end -->`

function section(r: Result) {
  return [
    begin(r.scenario.id),
    `## ${r.scenario.id}: ${r.scenario.title}`,
    '',
    `- Run: ${new Date().toISOString()} (${(r.ms / 1000).toFixed(1)} s)`,
    `- Outcome: **${r.report.outcome}**`,
    `- Found: ${r.report.summary}`,
    `- Consequence: ${r.report.consequence}`,
    '',
    '```text',
    ...r.lines,
    '```',
    end(r.scenario.id),
  ].join('\n')
}

let doc = existsSync(RESULTS) ? readFileSync(RESULTS, 'utf8') : HEAD
for (const r of results) {
  const s = section(r)
  const a = doc.indexOf(begin(r.scenario.id))
  const b = doc.indexOf(end(r.scenario.id))
  if (a >= 0 && b > a)
    doc = doc.slice(0, a) + s + doc.slice(b + end(r.scenario.id).length)
  else doc = `${doc.trimEnd()}\n\n${s}\n`
}
// Keep the sections in scenario order.
const order = Object.values(families)
  .flat()
  .map((s) => s.id)
const parts = order
  .map((id) => {
    const a = doc.indexOf(begin(id))
    const b = doc.indexOf(end(id))
    return a >= 0 && b > a ? doc.slice(a, b + end(id).length) : null
  })
  .filter(Boolean)
const firstSection = doc.indexOf('<!-- probe:')
const prefix = firstSection >= 0 ? doc.slice(0, firstSection) : doc
writeFileSync(RESULTS, `${prefix.trimEnd()}\n\n${parts.join('\n\n')}\n`)
console.log(`\nWrote ${RESULTS}`)

const failed = results.filter((r) => r.report.outcome === 'fail').length
process.exit(failed ? 1 : 0)
