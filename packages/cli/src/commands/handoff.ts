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
  let title = ''
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
    title = p.title
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
    const kind = ref.type === 'change' ? 'changes' : 'issues'
    const found = (await api.get(`${repo.path}/${kind}/${n}`)).json as {
      title: string
      body?: string
      description?: string
      html_url?: string
    }
    title = found.title
    type = ref.type as string
    const text = (found.body ?? found.description ?? '').trim()
    const media =
      kind === 'issues'
        ? ((
            (
              await api
                .get(`${repo.path}/issues/${n}/evidence`)
                .catch(() => null)
            )?.json as {
              data: Array<{
                kind: string
                caption: string
                upload: { content_url: string | null }
              }>
            } | null
          )?.data ?? [])
        : []
    prompt = [
      `Work on ${repo.slug} #${n}: ${found.title}.`,
      text
        ? `\n${text.length > 6000 ? `${text.slice(0, 6000)}…` : text}\n`
        : '',
      media.length
        ? `Attached to it (download with your cb token, e.g. curl -H "Authorization: Bearer $CB_TOKEN"; they show the problem):\n${media.map((m) => `- ${m.kind}${m.caption ? ` "${m.caption}"` : ''}: ${m.upload.content_url ?? '(still uploading)'}`).join('\n')}\n`
        : '',
      found.html_url ? `It is at ${found.html_url}.` : '',
      `Open a draft change. If you have not used cb, run "cb skill" first, then "cb context" for policies and the env schema. Set CB_MODEL to the model you are, so the receipt says so.`,
      // A local or self-hosted server: the agent's cb must talk to the same one.
      process.env.CB_API
        ? `Use this cobalt server: CB_API=${process.env.CB_API}`
        : '',
    ]
      .filter(Boolean)
      .join('\n')
  }
  const base =
    str(flags, 'base') ??
    (
      (await api.get(repo.path).catch(() => null))?.json as {
        default_branch?: string
      } | null
    )?.default_branch ??
    'main'
  const threadTitle =
    `${repo.slug} ${subject.startsWith('run:') ? subject : `#${subject.replace(/^#/, '')}`}: ${title}`.slice(
      0,
      120,
    )
  const command =
    target === 't3'
      ? `t3 thread start . ${JSON.stringify(prompt)} --worktree ${base} --title ${JSON.stringify(threadTitle)}`
      : `boat run --repo ${repo.slug} ${JSON.stringify(prompt)}`
  const dry = has(flags, 'dry-run')
  if (!has(flags, 'start') || dry) {
    print(
      ctx,
      {
        to: target,
        subject,
        type,
        prompt,
        command,
        started: false,
        dryRun: dry,
      },
      () => command,
    )
    return
  }
  if (target !== 't3')
    throw new CbError(
      'not_supported',
      `cb cannot start ${target} itself yet.`,
      `Run the command it prints without --start.`,
      exit.usage,
    )
  const thread = await startT3Thread(prompt, base, threadTitle)
  print(
    ctx,
    { to: target, subject, type, prompt, command, started: true, ...thread },
    () =>
      `started T3 Code thread ${thread.thread}${thread.added ? ` (added ${thread.project} to T3 Code)` : ''}`,
  )
}

/**
 * Start a T3 Code thread in this folder's project, in a new worktree on
 * `base`, with `prompt` on stdin. A folder T3 Code does not know yet is added
 * as a project first.
 */
async function startT3Thread(prompt: string, base: string, title: string) {
  const t3 = Bun.which('t3')
  if (!t3)
    throw new CbError(
      't3_not_found',
      'T3 Code is not installed here (no t3 command).',
      'Install it from https://t3.codes, or run the command without --start somewhere it is.',
      exit.error,
    )
  const root =
    (
      await exec(['git', 'rev-parse', '--show-toplevel'], '').catch(() => null)
    )?.out.trim() || process.cwd()
  const start = () =>
    exec(
      [
        t3,
        'thread',
        'start',
        root,
        '-',
        '--worktree',
        base,
        '--title',
        title,
        '--json',
      ],
      prompt,
    )
  let r = await start()
  let added = false
  if (r.code !== 0 && /project/i.test(r.err + r.out)) {
    const add = await exec([t3, 'project', 'add', root], '')
    if (add.code !== 0)
      throw new CbError(
        't3_failed',
        `T3 Code did not add ${root} as a project: ${(add.err || add.out).trim()}`,
        'Is T3 Code running? Start it with t3, then try again.',
        exit.error,
      )
    added = true
    r = await start()
  }
  if (r.code !== 0)
    throw new CbError(
      't3_failed',
      `T3 Code did not start a thread: ${(r.err || r.out).trim()}`,
      'Is T3 Code running? Start it with t3, then try again.',
      exit.error,
    )
  let thread = r.out.trim()
  try {
    const j = JSON.parse(r.out) as { id?: string; threadId?: string }
    thread = j.threadId ?? j.id ?? thread
  } catch {
    // Plain output is the id.
  }
  return { thread, project: root, added }
}

async function exec(cmd: Array<string>, stdin: string) {
  const p = Bun.spawn(cmd, {
    stdin: new TextEncoder().encode(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ])
  return { out, err, code }
}
