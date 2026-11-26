// What the agent on someone's machine does with the jobs cobalt gives it
// (cb runner start with the labels t3 and reviewer, once for every
// repository of the account): open a T3 Code thread for a hand-off, and
// review a change with a local coding agent, posting what it finds.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { handoffPrompt, startT3Thread } from './commands/handoff'
import type { ApiClient } from './client'

type Line = { text: string; level: string | null }

/** A hand-off from the web: the T3 Code thread, in a clone on this machine. */
export async function handOffHere(
  api: ApiClient,
  repo: string,
  subject: string,
  branch: string,
  dir: string,
): Promise<Array<Line>> {
  const { prompt, title } = await handoffPrompt(
    api,
    { slug: repo, path: `/repos/${repo}` },
    subject,
  )
  const ref = subject.startsWith('run:') ? subject : `#${subject}`
  const t = await startT3Thread(
    prompt,
    branch,
    `${repo} ${ref}: ${title}`.slice(0, 120),
    dir,
  )
  return [
    {
      text: `Started T3 Code thread ${t.thread} in ${t.project}.`,
      level: 'info',
    },
    ...(t.added
      ? [{ text: `Added ${t.project} to T3 Code.`, level: 'info' }]
      : []),
  ]
}

export type Finding = {
  severity: 'high' | 'medium' | 'low'
  file: string
  line: number
  title: string
  body?: string
}

/** The findings an agent wrote between <findings> and </findings>. */
export function findingsOf(text: string): Array<Finding> {
  const m = /<findings>([\s\S]*?)<\/findings>/.exec(text)
  if (!m) return []
  let raw: unknown
  try {
    raw = JSON.parse(m[1].trim())
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  return raw
    .filter(
      (f): f is Finding =>
        Boolean(f) &&
        typeof f === 'object' &&
        ['high', 'medium', 'low'].includes((f as Finding).severity) &&
        typeof (f as Finding).file === 'string' &&
        Number.isInteger((f as Finding).line) &&
        (f as Finding).line > 0 &&
        typeof (f as Finding).title === 'string',
    )
    .slice(0, 30)
}

const PROMPT = (a: {
  repo: string
  number: number
  title: string
  description: string
  base: string
  diff: string
}) => `You are reviewing change #${a.number} of ${a.repo}: "${a.title}".
${a.description ? `\nWhat its author says:\n${a.description.slice(0, 4000)}\n` : ''}
The working directory is the repository at the change's newest patch set. Its diff against ${a.base}:

${a.diff}

Review it like a careful senior engineer: correctness bugs, security problems, data loss, broken edge cases, missing tests for risky code. Skip style nits. Read files in the repository when you need context. Do not change any file.

Answer with a short summary, then the findings as JSON between <findings> and </findings>: an array of {"severity": "high" | "medium" | "low", "file": "path in the repository", "line": line number in the new version, "title": "one line", "body": "what is wrong and how to fix it"}. An empty array when there is nothing worth raising.`

/**
 * An AI review of a change: the diff of its newest patch set to a local
 * agent (opencode by default, or CB_REVIEW_COMMAND), and its findings posted
 * on the change.
 */
export async function reviewHere(
  api: ApiClient,
  repo: string,
  number: number,
  patchSet: number,
  dir: string,
): Promise<Array<Line>> {
  const c = (await api.get(`/repos/${repo}/changes/${number}`)).json as {
    title: string
    description: string
    base: string
    head: { patch_set: number; sha: string }
  }
  if (c.head.patch_set !== patchSet)
    return [
      {
        text: `Patch set ${patchSet} is no longer the newest (${c.head.patch_set}): nothing to review.`,
        level: 'info',
      },
    ]
  const diff = Bun.spawnSync(
    ['git', 'diff', '--no-color', `origin/${c.base}...HEAD`],
    { cwd: dir, stdout: 'pipe', stderr: 'pipe' },
  ).stdout.toString()
  if (!diff.trim())
    return [{ text: 'The change has no diff to review.', level: 'info' }]
  // A large diff goes in a file the agent reads, inside .git so it is never committed.
  let shown = diff
  if (diff.length > 60_000) {
    const file = join(dir, '.git', 'cobalt-review.diff')
    writeFileSync(file, diff)
    shown = `(${diff.length.toLocaleString('en')} characters: read it from ${file})`
  }
  const prompt = PROMPT({
    repo,
    number,
    title: c.title,
    description: c.description,
    base: c.base,
    diff: shown,
  })
  const custom = process.env.CB_REVIEW_COMMAND?.trim()
  const argv = custom
    ? [...custom.split(/\s+/), prompt]
    : Bun.which('opencode')
      ? ['opencode', 'run', prompt]
      : null
  if (!argv)
    throw new Error(
      'No reviewer here: install opencode (https://opencode.ai), or set CB_REVIEW_COMMAND to a command that takes the prompt as its last argument.',
    )
  const p = Bun.spawn(argv, {
    cwd: dir,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, CB_RUNNER_TOKEN: '' },
  })
  const timer = setTimeout(() => p.kill(), 15 * 60_000)
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ])
  clearTimeout(timer)
  if (code !== 0)
    throw new Error(
      `${argv[0]} ended with ${code}: ${(err || out).trim().slice(-1500)}`,
    )
  const findings = findingsOf(out)
  const lines: Array<Line> = [
    {
      text: `${argv[0]} reviewed patch set ${patchSet}: ${findings.length} findings.`,
      level: 'info',
    },
  ]
  for (const f of findings) {
    try {
      await api.post(`/repos/${repo}/changes/${number}/findings`, {
        body: {
          severity: f.severity,
          file: f.file,
          line: f.line,
          title: f.title.slice(0, 200),
          ...(f.body ? { body: f.body.slice(0, 65536) } : {}),
        },
      })
      lines.push({
        text: `[${f.severity}] ${f.file}:${f.line} ${f.title}`,
        level: f.severity === 'high' ? 'warn' : null,
      })
    } catch (e) {
      lines.push({
        text: `Could not post ${f.file}:${f.line}: ${e instanceof Error ? e.message : String(e)}`,
        level: 'warn',
      })
    }
  }
  const summary = out.replace(/<findings>[\s\S]*?<\/findings>/, '').trim()
  if (summary)
    lines.push(
      ...summary
        .split('\n')
        .slice(-40)
        .map((t) => ({ text: t.slice(0, 2000), level: null })),
    )
  return lines
}
