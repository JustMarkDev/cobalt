import { resolveRepo } from '../repo'
import { SxError, exit, print } from '../output'
import { has, str } from '../args'
import type { Command } from './types'

/**
 * A pipeline step that waits on a person or an agent, and its answer.
 *
 *   sx pipeline wait 1839 --job 1 --step 3 --reason "Update the docs" --kind agent
 *   sx pipeline resume 1839 --job 1 --step 3 --status success --note "docs updated"
 *
 * Both run under your own login, which needs write access to the repository.
 */
export const pipeline: Command = async (
  { rest: [sub, runArg], flags },
  ctx,
) => {
  const repo = resolveRepo(str(flags, 'repo'))
  const api = ctx.api()
  const dry = has(flags, 'dry-run')
  const run = Number(runArg)
  const job = Number(str(flags, 'job') ?? '1')
  const step = Number(str(flags, 'step'))
  if (
    (sub !== 'resume' && sub !== 'wait') ||
    !Number.isInteger(run) ||
    run < 1 ||
    !Number.isInteger(job) ||
    !Number.isInteger(step) ||
    step < 1
  )
    throw new SxError(
      'missing_argument',
      'pipeline needs wait or resume, a run number, --job and --step.',
      'Example: sx pipeline resume 1839 --job 1 --step 3 --status success --note "docs updated"',
      exit.usage,
    )
  const at = `${repo.path}/pipelines/${run}/jobs/${job}/steps/${step}`
  if (sub === 'resume') {
    const status = str(flags, 'status') ?? 'success'
    if (status !== 'success' && status !== 'failure')
      throw new SxError(
        'bad_status',
        `${status} is not how a step ends.`,
        'Use --status success or --status failure.',
        exit.usage,
      )
    const note = str(flags, 'note')
    const r = (
      await api.post(`${at}/resume`, {
        body: { status, ...(note ? { summary: note } : {}) },
        dryRun: dry,
      })
    ).json as { status: string }
    print(
      ctx,
      { ...r, dryRun: dry },
      () =>
        `${dry ? 'would resume' : 'resumed'} run ${run} job ${job} step ${step} as ${status}; the run is ${r.status}`,
    )
    return
  }
  const reason = str(flags, 'reason')
  if (!reason)
    throw new SxError(
      'missing_argument',
      'pipeline wait needs --reason.',
      'Example: sx pipeline wait 1839 --job 1 --step 3 --reason "Sign off the migration"',
      exit.usage,
    )
  const kind = str(flags, 'kind') ?? 'person'
  const target = str(flags, 'target')
  const expires = str(flags, 'expires')
  const r = (
    await api.post(`${at}/wait`, {
      body: {
        kind,
        reason,
        ...(target ? { target } : {}),
        ...(expires ? { expires_at: expires } : {}),
      },
      dryRun: dry,
    })
  ).json as { status: string }
  print(
    ctx,
    { ...r, dryRun: dry },
    () =>
      `${dry ? 'would pause' : 'paused'} run ${run} job ${job} step ${step}: ${reason}`,
  )
}
