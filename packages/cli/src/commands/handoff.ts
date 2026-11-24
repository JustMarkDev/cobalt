import { resolveRepo } from '../repo'
import { CbError, exit, print } from '../output'
import { has, str } from '../args'
import { resolve } from '../config'
import type { Command } from './types'

const targets = ['t3', 'boat'] as const

export const handoff: Command = async ({ rest: [subject], flags }, ctx) => {
  const repo = resolveRepo(str(flags, 'repo'))
  if (!subject)
    throw new CbError(
      'missing_argument',
      'handoff needs an issue or change.',
      'Example: cb handoff 4,  cb handoff 216 --to boat,  cb handoff run:1839',
      exit.usage,
    )
  const target = str(flags, 'to') ?? resolve('handoff.to').value
  if (!(targets as ReadonlyArray<string>).includes(target))
    throw new CbError(
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
    const p = (
      await api.get(`${repo.path}/pipelines/${run[1]}`).catch(() => null)
    )?.json as
      | {
          number: number
          workflow: string
          branch: string
          title: string
          status: string
          jobs: Array<{
            name: string
            steps: Array<{
              name: string
              status: string
              wait: { reason: string; target: string | null } | null
            }>
          }> | null
        }
      | undefined
    if (!p)
      throw new CbError(
        'not_found',
        `${subject} is not a pipeline run here.`,
        'Pipeline runs are on the Pipelines tab.',
        exit.notFound,
      )
    type = 'pipeline'
    const waiting = (p.jobs ?? [])
      .flatMap((j, ji) =>
        j.steps.flatMap((st, si) =>
          st.status === 'waiting' && st.wait
            ? [{ job: ji + 1, step: si + 1, name: st.name, wait: st.wait }]
            : [],
        ),
      )
      .at(0)
    if (waiting) {
      const resume = `cb pipeline resume ${p.number} --job ${waiting.job} --step ${waiting.step} --status success --note "<what you did>"`
      prompt = `In ${repo.slug}, pipeline run #${p.number} (${p.workflow}, branch ${p.branch}) is waiting at step "${waiting.name}": ${waiting.wait.reason}. Do that work on ${p.branch} and add a patch set with cb change create. When it is done, resume the run with exactly: ${resume} (use --status failure and say why if it cannot be done). If you have not used cb, run "cb skill" first. Set CB_MODEL to the model you are, so the receipt says so.`
    } else
      prompt = `In ${repo.slug}, pipeline run #${p.number} (${p.workflow}, branch ${p.branch}, "${p.title}") ended ${p.status}. Read its jobs and the failing step's log (cb commands lists the pipelines operations), reproduce the failure, fix it on ${p.branch}, and add a patch set with cb change create. If you have not used cb, run "cb skill" first. Set CB_MODEL to the model you are, so the receipt says so.`
  } else {
    const n = subject.replace(/^#/, '')
    const ref = (await api.get(`${repo.path}/numbers/${n}`).catch(() => null))
      ?.json
    if (!ref)
      throw new CbError(
        'not_found',
        `${subject} is not an issue or change here.`,
        'cb issue list and cb change list show what exists.',
        exit.notFound,
      )
    const title = (
      await api.get(
        `${repo.path}/${ref.type === 'change' ? 'changes' : 'issues'}/${n}`,
      )
    ).json.title as string
    type = ref.type as string
    prompt = `Work on ${repo.slug} #${n}: ${title}. Open a draft change. If you have not used cb, run "cb skill" first, then "cb context" for policies and the env schema. Set CB_MODEL to the model you are, so the receipt says so.`
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
