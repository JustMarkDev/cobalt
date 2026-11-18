import { resolveRepo } from '../repo'
import { SxError, exit, print } from '../output'
import { has, str } from '../args'
import { resolve } from '../config'
import type { Command } from './types'

/**
 * Hand an issue or a change to an orchestrator. source.code runs no agent and
 * hosts no model: the orchestrator (T3 Code, and boat.dev beneath it) starts
 * one on your machine or its own, under your login. Whatever it writes comes
 * back with a receipt naming the machine, the tool and the model.
 */
const targets = ['t3', 'boat'] as const

export const handoff: Command = async ({ rest: [subject], flags }, ctx) => {
  const repo = resolveRepo(str(flags, 'repo'))
  if (!subject)
    throw new SxError(
      'missing_argument',
      'handoff needs an issue or change.',
      'Example: sx handoff 4,  sx handoff 216 --to boat,  sx handoff run:1839',
      exit.usage,
    )
  const target = str(flags, 'to') ?? resolve('handoff.to').value
  if (!(targets as ReadonlyArray<string>).includes(target))
    throw new SxError(
      'bad_target',
      `${target} is not somewhere to hand off to.`,
      `Use one of: ${targets.join(', ')}.`,
      exit.usage,
    )
  const api = ctx.api()
  const run = /^run:(\d+)$/.exec(subject)
  let prompt: string
  let type: string
  if (run) {
    // A pipeline run: the failure is the task. Its log is read through sx.
    const p = (
      await api.get(`${repo.path}/pipelines/${run[1]}`).catch(() => null)
    )?.json as
      | {
          number: number
          workflow: string
          branch: string
          title: string
          status: string
        }
      | undefined
    if (!p)
      throw new SxError(
        'not_found',
        `${subject} is not a pipeline run here.`,
        'Pipeline runs are on the Pipelines tab.',
        exit.notFound,
      )
    type = 'pipeline'
    prompt = `In ${repo.slug}, pipeline run #${p.number} (${p.workflow}, branch ${p.branch}, "${p.title}") ended ${p.status}. Read its jobs and the failing step's log (sx commands lists the pipelines operations), reproduce the failure, fix it on ${p.branch}, and add a patch set with sx change create. If you have not used sx, run "sx skill" first. Set SX_MODEL to the model you are, so the receipt says so.`
  } else {
    const n = subject.replace(/^#/, '')
    // A number is a change or an issue; the API says which.
    const ref = (await api.get(`${repo.path}/numbers/${n}`).catch(() => null))
      ?.json
    if (!ref)
      throw new SxError(
        'not_found',
        `${subject} is not an issue or change here.`,
        'sx issue list and sx change list show what exists.',
        exit.notFound,
      )
    const title = (
      await api.get(
        `${repo.path}/${ref.type === 'change' ? 'changes' : 'issues'}/${n}`,
      )
    ).json.title as string
    type = ref.type as string
    // Names and structure only. Values never travel in a prompt: the agent
    // runs commands with `sx env run`, under the login of the machine it is on.
    prompt = `Work on ${repo.slug} #${n}: ${title}. Open a draft change. If you have not used sx, run "sx skill" first, then "sx context" for policies and the env schema. Set SX_MODEL to the model you are, so the receipt says so.`
  }
  const command =
    target === 't3'
      ? `t3 thread start . ${JSON.stringify(prompt)} --worktree main`
      : `boat run --repo ${repo.slug} ${JSON.stringify(prompt)}`
  print(
    ctx,
    {
      to: target,
      subject,
      type,
      prompt,
      command,
      started: false,
      dryRun: has(flags, 'dry-run'),
    },
    () => command,
  )
}
