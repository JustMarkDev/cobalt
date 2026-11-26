import { showTimeline } from '../timeline'
import { showPresence } from '../presence'
import { resolveRepo } from '../repo'
import { CbError, exit, print, table } from '../output'
import { has, str } from '../args'
import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import type { ApiClient } from '../client'
import type { Command } from './types'

const MEDIA: Record<string, { type: string; kind: 'image' | 'recording' }> = {
  '.png': { type: 'image/png', kind: 'image' },
  '.jpg': { type: 'image/jpeg', kind: 'image' },
  '.jpeg': { type: 'image/jpeg', kind: 'image' },
  '.gif': { type: 'image/gif', kind: 'image' },
  '.webp': { type: 'image/webp', kind: 'image' },
  '.mp4': { type: 'video/mp4', kind: 'recording' },
  '.webm': { type: 'video/webm', kind: 'recording' },
}

/** `--screenshot a.png,b.png` */
const filesOf = (v: string | undefined) =>
  (v ?? '')
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean)

/** Upload a screenshot or recording and attach it to an issue as evidence. */
export async function attachEvidence(
  api: ApiClient,
  path: string,
  n: string | number,
  file: string,
  caption: string,
) {
  const media = MEDIA[extname(file).toLowerCase()] as
    | (typeof MEDIA)[string]
    | undefined
  if (!media)
    throw new CbError(
      'unsupported_file',
      `${file} is not an image or a recording.`,
      `Attach one of: ${Object.keys(MEDIA).join(', ')}.`,
      exit.usage,
    )
  let bytes: Uint8Array
  try {
    bytes = readFileSync(file)
  } catch {
    throw new CbError('file_not_found', `Cannot read ${file}.`, '', exit.usage)
  }
  const up = (
    await api.post('/uploads', {
      body: {
        filename: basename(file),
        content_type: media.type,
        size: bytes.length,
        purpose: 'evidence',
      },
    })
  ).json as { id: string; upload_url: string }
  const put = await api.send(up.upload_url, {
    method: 'PUT',
    headers: { 'content-type': media.type },
    body: bytes as BodyInit,
  })
  if (!put.ok)
    throw new CbError(
      'upload_failed',
      `Uploading ${file} failed (${put.status}).`,
      'Try again; the upload address works once, for an hour.',
      exit.error,
    )
  return (
    await api.post(`${path}/issues/${n}/evidence`, {
      body: { upload: up.id, kind: media.kind, caption },
    })
  ).json as { id: string }
}

export const issue: Command = async (
  { rest: [sub = 'list', ...rest], flags },
  ctx,
) => {
  const repo = resolveRepo(str(flags, 'repo'))
  const api = ctx.api()
  if (sub === 'list') {
    const state = str(flags, 'state') ?? 'open'
    const rows = (
      await api.get(`${repo.path}/issues`, { query: { state, limit: 200 } })
    ).json.data as Array<{ number: number; state: string; title: string }>
    print(ctx, rows, () =>
      table(
        rows.map((i) => [`#${i.number}`, i.state, i.title]),
        ['ISSUE', 'STATE', 'TITLE'],
      ),
    )
    return
  }
  if (sub === 'create') {
    const title = str(flags, 'title') ?? rest.join(' ')
    if (!title)
      throw new CbError(
        'missing_argument',
        'issue create needs a title.',
        'Example: cb issue create "Crash on empty repo" --label bug',
        exit.usage,
      )
    const labels = str(flags, 'label')?.split(',')
    const bodyFile = str(flags, 'body-file')
    const body =
      bodyFile !== undefined
        ? readFileSync(bodyFile === '-' ? 0 : bodyFile, 'utf8')
        : str(flags, 'body')
    const shots = filesOf(str(flags, 'screenshot'))
    const dry = has(flags, 'dry-run')
    const r = await api.post(`${repo.path}/issues`, {
      body: {
        title,
        ...(body ? { body } : {}),
        ...(labels ? { labels } : {}),
      },
      dryRun: dry,
    })
    const created = r.headers.get('cb-outcome') !== 'unchanged'
    const attached: Array<string> = []
    if (!dry)
      for (const f of shots) {
        await attachEvidence(
          api,
          repo.path,
          r.json.number,
          f,
          str(flags, 'caption') ?? '',
        )
        attached.push(basename(f))
      }
    print(ctx, { ...r.json, created, attached, dryRun: dry }, () =>
      [
        created
          ? `${dry ? 'would create' : 'created'} #${r.json.number}`
          : `#${r.json.number} already open`,
        ...(dry && shots.length
          ? [`would attach ${shots.join(', ')}`]
          : attached.map((a) => `attached ${a}`)),
      ].join('\n'),
    )
    return
  }
  const n = (rest.at(0) ?? '').replace('#', '')
  if (!/^\d+$/.test(n))
    throw new CbError(
      'issue_not_found',
      `No issue ${rest.at(0) ?? ''}.`,
      'cb issue list --state all shows every issue.',
      exit.notFound,
    )
  if (sub === 'view') {
    const found = (await api.get(`${repo.path}/issues/${n}`)).json
    print(ctx, found, () => `#${found.number} ${found.state}  ${found.title}`)
    return
  }
  if (sub === 'presence') {
    await showPresence(ctx, `${repo.path}/issues/${n}/presence`, n, {
      here: has(flags, 'here'),
      path: str(flags, 'path'),
      leave: has(flags, 'leave'),
    })
    return
  }
  if (sub === 'timeline') {
    await showTimeline(ctx, `${repo.path}/issues/${n}/timeline`, String(n))
    return
  }
  if (sub === 'attach') {
    const files = [...rest.slice(1), ...filesOf(str(flags, 'screenshot'))]
    if (!files.length)
      throw new CbError(
        'missing_argument',
        'issue attach needs a file.',
        'Example: cb issue attach 12 crash.png --caption "On an empty repo"',
        exit.usage,
      )
    const out: Array<{ id: string }> = []
    for (const f of files)
      out.push(
        await attachEvidence(api, repo.path, n, f, str(flags, 'caption') ?? ''),
      )
    print(ctx, out, () =>
      files.map((f) => `attached ${basename(f)} to #${n}`).join('\n'),
    )
    return
  }
  if (sub === 'close') {
    const dry = has(flags, 'dry-run')
    const found = (
      await api.patch(`${repo.path}/issues/${n}`, {
        body: { state: 'closed' },
        dryRun: dry,
      })
    ).json
    print(
      ctx,
      { ...found, dryRun: dry },
      () => `${dry ? 'would close' : 'closed'} #${found.number}`,
    )
    return
  }
  throw new CbError(
    'unknown_command',
    `issue ${sub} is not a command.`,
    'cb issue --help lists them.',
    exit.usage,
  )
}
