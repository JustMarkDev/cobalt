#!/usr/bin/env bun
/**
 * Does a model use cobalt's MCP tools the way their descriptions ask?
 * Each case gives a model the server's real instructions and tool list, lets
 * it call the tools on the sample data in this process (nothing leaves the
 * machine but the model requests), and checks the calls it made
 * (`grade.ts`). Change a tool description, run it before and after, compare.
 *
 *   bun packages/cli/eval/mcp-tool-use.ts --dry-run          what would run, free
 *   bun packages/cli/eval/mcp-tool-use.ts --out before.json  every case, 3 samples
 *   bun packages/cli/eval/mcp-tool-use.ts --baseline before.json
 *   … --case blocked-landing-stops --samples 1 --model claude-sonnet-5-5 --effort low
 *
 * A run calls the Claude API and costs money: about 10 cases × samples ×
 * 2 to 4 requests. The report prints the token use and an estimate. It needs
 * credentials (ANTHROPIC_API_KEY, or a profile from `ant auth login`).
 *
 * Refusal fallbacks are off on purpose: an answer from a fallback model would
 * be scored as the model under test. A refusal counts as a failure.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import Anthropic from '@anthropic-ai/sdk'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { createSxMcpServer } from '../src/mcp'
import { cases } from './cases'
import { grade } from './grade'
import type { Call, Case, Trajectory } from './grade'

const argv = process.argv.slice(2)
const flag = (name: string) => argv.includes(`--${name}`)
const arg = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? (argv[i + 1] ?? fallback) : fallback
}
const MODEL = arg('model', 'claude-opus-5-5')
const EFFORT = arg('effort', 'medium') as 'low' | 'medium' | 'high'
const SAMPLES = Number(arg('samples', '3'))
const ONLY = arg('case', '')
const OUT = arg('out', '')
const BASELINE = arg('baseline', '')
const CONCURRENCY = Number(arg('concurrency', '4'))
/** Model turns per sample; a case that needs more is failing anyway. */
const MAX_TURNS = 8

/** Per million tokens, for the estimate: input, output, cache read, cache write. */
const PRICES: Record<string, [number, number, number, number]> = {
  'claude-opus-5-5': [4, 20, 0.2, 5],
  'claude-sonnet-5-5': [2, 10, 0.2, 2.5],
  'claude-haiku-5-5': [0.1, 0.5, 0.01, 0.125],
}

type Usage = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}
type Sample = {
  failures: Array<string>
  calls: Array<Call>
  usage: Usage
  error?: string
}

/** The MCP server as an agent sees it, fresh for each sample. */
async function connect() {
  const [a, b] = InMemoryTransport.createLinkedPair()
  await createSxMcpServer().connect(b)
  const client = new Client({ name: 'mcp-tool-use-eval', version: '0' })
  await client.connect(a)
  const { tools } = await client.listTools()
  return {
    client,
    instructions: client.getInstructions() ?? '',
    tools: tools.map((t): Anthropic.Tool => ({
      name: t.name,
      description: t.description ?? '',
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    })),
  }
}

async function runSample(api: Anthropic, k: Case): Promise<Sample> {
  const { client, instructions, tools } = await connect()
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const calls: Array<Call> = []
  const messages: Array<Anthropic.MessageParam> = [
    { role: 'user', content: k.prompt },
  ]
  let last: Anthropic.Message | null = null
  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      last = await api.messages.create({
        model: MODEL,
        max_tokens: 16000,
        output_config: { effort: EFFORT },
        tools,
        // Tools come first, then the system prompt: a breakpoint here
        // caches both, the same for every case and sample.
        system: [
          {
            type: 'text',
            text: instructions,
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages,
      })
      usage.input += last.usage.input_tokens
      usage.output += last.usage.output_tokens
      usage.cacheRead += last.usage.cache_read_input_tokens ?? 0
      usage.cacheWrite += last.usage.cache_creation_input_tokens ?? 0
      // The whole content goes back, thinking blocks included.
      messages.push({ role: 'assistant', content: last.content })
      if (last.stop_reason !== 'tool_use') break
      const results: Array<Anthropic.ToolResultBlockParam> = []
      for (const block of last.content) {
        if (block.type !== 'tool_use') continue
        const args = (block.input ?? {}) as Record<string, unknown>
        const r = (await client.callTool({
          name: block.name,
          arguments: args,
        })) as {
          isError?: boolean
          content: Array<{ type: string; text?: string }>
        }
        calls.push({ tool: block.name, args, isError: r.isError === true })
        results.push({
          type: 'tool_result',
          tool_use_id: block.id,
          is_error: r.isError === true,
          content: r.content.map((c) => c.text ?? '').join('\n'),
        })
      }
      // Every result of a turn in one message, as parallel calls expect.
      messages.push({ role: 'user', content: results })
    }
  } catch (e) {
    await client.close()
    const error =
      e instanceof Anthropic.APIError
        ? `API ${e.status}: ${e.message}`
        : String(e)
    return { failures: [error], calls, usage, error }
  }
  await client.close()
  const trajectory: Trajectory = {
    calls,
    final:
      last?.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n') ?? '',
    stopReason: last?.stop_reason ?? null,
  }
  const failures = grade(k, trajectory)
  if (last?.stop_reason === 'tool_use')
    failures.push(`still calling tools after ${MAX_TURNS} turns`)
  return { failures, calls, usage }
}

/** Runs `jobs` with at most `n` at a time. */
async function pool<T>(jobs: Array<() => Promise<T>>, n: number) {
  const out: Array<T> = []
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(n, jobs.length) }, async () => {
      while (next < jobs.length) {
        const i = next++
        out[i] = await jobs[i]()
      }
    }),
  )
  return out
}

const selected = cases.filter((k) => !ONLY || k.id === ONLY)
if (!selected.length) {
  console.error(`No case ${ONLY}. Cases: ${cases.map((k) => k.id).join(', ')}`)
  process.exit(2)
}

const { tools, instructions, client: probe } = await connect()
await probe.close()
const toolChars = JSON.stringify(tools).length + instructions.length
console.log(
  `${selected.length} cases × ${SAMPLES} samples on ${MODEL} (effort ${EFFORT}); ` +
    `${tools.length} tools, ${toolChars} characters of tools and instructions (~${Math.round(toolChars / 4)} tokens)`,
)
if (flag('dry-run')) {
  for (const k of selected) console.log(`  ${k.id}: ${k.prompt}`)
  process.exit(0)
}

const api = new Anthropic()
const jobs = selected.flatMap((k) =>
  Array.from({ length: SAMPLES }, () => () => runSample(api, k)),
)
const samples = await pool(jobs, CONCURRENCY)

type Result = {
  id: string
  passed: number
  samples: number
  avgCalls: number
  failures: Array<string>
}
const results: Array<Result> = selected.map((k, i) => {
  const mine = samples.slice(i * SAMPLES, (i + 1) * SAMPLES)
  return {
    id: k.id,
    passed: mine.filter((s) => s.failures.length === 0).length,
    samples: mine.length,
    avgCalls: mine.reduce((a, s) => a + s.calls.length, 0) / mine.length,
    failures: [...new Set(mine.flatMap((s) => s.failures))],
  }
})
const total = samples.reduce(
  (a, s) => ({
    input: a.input + s.usage.input,
    output: a.output + s.usage.output,
    cacheRead: a.cacheRead + s.usage.cacheRead,
    cacheWrite: a.cacheWrite + s.usage.cacheWrite,
  }),
  { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
)
const price = PRICES[MODEL] as [number, number, number, number] | undefined
const cost = price
  ? (total.input * price[0] +
      total.output * price[1] +
      total.cacheRead * price[2] +
      total.cacheWrite * price[3]) /
    1e6
  : null

const base = BASELINE
  ? new Map(
      (
        JSON.parse(readFileSync(BASELINE, 'utf8')) as { results: Array<Result> }
      ).results.map((r) => [r.id, r]),
    )
  : null
for (const r of results) {
  const b = base?.get(r.id)
  const was = b ? `  (was ${b.passed}/${b.samples})` : ''
  console.log(
    `${r.passed === r.samples ? 'pass' : 'FAIL'}  ${r.id.padEnd(30)} ${r.passed}/${r.samples}  ${r.avgCalls.toFixed(1)} calls${was}`,
  )
  for (const f of r.failures) console.log(`        ${f}`)
}
const casesPassed = results.filter((r) => r.passed === r.samples).length
const samplesPassed = results.reduce((a, r) => a + r.passed, 0)
console.log(
  `\n${casesPassed} of ${results.length} cases passed every sample; ` +
    `${samplesPassed} of ${samples.length} samples passed.`,
)
console.log(
  `Tokens: ${total.input} input, ${total.cacheRead} cache read, ${total.cacheWrite} cache write, ${total.output} output.` +
    (cost === null ? '' : ` About $${cost.toFixed(2)}.`),
)
if (OUT)
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        model: MODEL,
        effort: EFFORT,
        samples: SAMPLES,
        toolChars,
        results,
        total,
        cost,
      },
      null,
      2,
    ),
  )
process.exit(samplesPassed === samples.length ? 0 : 1)
