import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { exitMeaning } from './schema'

const MARK = '<!-- cb:begin -->'
const END = '<!-- cb:end -->'

export const skillBody = `# Using cb (the cobalt CLI)

cb is the command line for cobalt, a git host. You have probably not seen
it before. Do not guess commands. Learn it from the tool itself.

## First, every time

1. Run \`cb context\`. It prints the repository, open changes with what blocks
   them, open issues, policy and the env schema as JSON.
2. Run \`cb commands\` once if you need a command you have not used. It lists
   every command with its arguments, whether it changes anything, and its exit
   codes.

## Rules

- cb never asks a question. If it needs something it exits 2 with a \`hint\` that
  names the flag. Read the hint and rerun. Do not wait for input.
- Output is JSON when piped. Parse it. Errors are JSON on stderr:
  \`{"error":{"code","message","hint"}}\`. Branch on \`code\`, never on \`message\`.
- Before a command that changes something, run it with \`--dry-run\`.
- Creating things is safe to repeat: \`change create\`, \`issue create\` and
  \`repo create\` return the existing thing instead of duplicating it.
- Pass \`-R owner/name\` if you are not inside a clone.
- cb acts as one account at a time: you, or an organization you belong to.
  \`cb account current\` says which and why. In a clone it is the repository's
  owner. To act as another for one command, pass \`-A handle\`; \`cb account switch\`
  changes it for good, so do not use it unless told to.

## Exit codes

${Object.entries(exitMeaning)
  .map(([k, v]) => `- ${k}: ${v}`)
  .join('\n')}

## Working on a task

You work under the login of the machine you run on: whatever you write is
the person's, and keeps a receipt with this machine, your tool and your model.

1. Set \`CB_MODEL\` to the model you are (for example \`Claude Opus 5.5\`) in the
   environment of every cb command, unless your orchestrator already did.
   Commits you push can say it too: \`Assisted-by: <tool>:<model>\`.
2. \`cb context\`, then read the issue or change you were given. \`rules\` says
   which models this repository declines; if yours is one, stop and say so.
3. Branch, commit, push with git as normal.
4. \`cb change create --draft\`. Re-run it after each push; it adds a patch set.
5. \`cb change view\` lists every requirement blocking the change.
6. Never run \`cb change land\` yourself unless told to. Landing is the
   person's act. If it exits 5, stop and report the requirements.

## Secrets

- \`cb env list\` and \`cb context\` show names and kinds, never values. You never
  need to see a value, and must not try to.
- To run something that needs values (tests, a dev server), go through cb:
  \`cb env run --env development -- <command>\`. The values reach that process
  and are scrubbed from the output you get back. A value shorter than four
  characters is scrubbed only where it stands alone.
- Never put a value in a commit, a log, a comment or a prompt. Never run a
  command whose job is to print or send environment variables, and never
  \`cb env pull\`: a plaintext file is what leaks.
- Production values wait for the person to confirm this login. Exit 6 with
  \`confirmation_required\` means stop, give them the link in the hint, and
  retry after they confirm.
- To store a value, pipe it: \`printf %s "$V" | cb env set NAME - --env development\`.

## Help

\`cb --help\`, \`cb <command> --help\`, and the docs at /docs/cli.
`

export const skillFile = `---
name: cb
description: Use when working with cobalt repositories, changes, issues, env secrets or mirrors from a terminal. Teaches the cb CLI, which has no prior training data.
---

${skillBody}`

export function installSkill(
  root: string,
  target: 'claude' | 'agents',
): { path: string; action: 'created' | 'updated' | 'unchanged' } {
  if (target === 'claude') {
    const path = join(root, '.claude', 'skills', 'cb', 'SKILL.md')
    const prev = existsSync(path) ? readFileSync(path, 'utf8') : undefined
    if (prev === skillFile) return { path, action: 'unchanged' }
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, skillFile)
    return { path, action: prev === undefined ? 'created' : 'updated' }
  }
  const path = join(root, 'AGENTS.md')
  const block = `${MARK}\n${skillBody}${END}\n`
  const prev = existsSync(path) ? readFileSync(path, 'utf8') : undefined
  if (prev?.includes(block)) return { path, action: 'unchanged' }
  const start = prev?.indexOf(MARK) ?? -1
  const stop = prev?.indexOf(END) ?? -1
  const next =
    prev === undefined
      ? block
      : start >= 0 && stop > start
        ? prev.slice(0, start) + block + prev.slice(stop + END.length + 1)
        : `${prev.trimEnd()}\n\n${block}`
  writeFileSync(path, next)
  return { path, action: prev === undefined ? 'created' : 'updated' }
}
