import * as React from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import {
  ArrowClockwiseIcon,
  ChatCircleIcon,
  CheckIcon,
  GitMergeIcon,
  HandIcon,
  HardDrivesIcon,
  LinkIcon,
  PauseCircleIcon,
  ProhibitIcon,
  RocketLaunchIcon,
  WarningCircleIcon,
  XCircleIcon,
} from '@phosphor-icons/react'
import { cn } from 'cn'
import { EmptyState } from './bits'
import type { Icon as PhosphorIcon } from '@phosphor-icons/react'
import type { BadgeTone } from '~/components/ui/badge'
import type { InboxItem, Notification } from '@cobaltforge/sdk'
import { BrandLogo } from '~/components/brand'
import { Stagger } from '~/components/motion'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { op, useOp, useWrite } from '~/lib/forge'
import { timeAgo } from '~/lib/repo'

export const boxes = ['all', 'unread'] as const
export type Box = (typeof boxes)[number]

type Entry =
  | { type: 'need'; id: string; at: string; item: InboxItem }
  | {
      type: 'note'
      id: string
      at: string
      item: Notification
      /** Every notification this row stands for: the same thing said again. */
      ids: Array<string>
      unread: Array<string>
    }

export type Inbox = {
  entries: Array<Entry>
  more: number
  counts: Record<Box, number>
}

const isUnread = (e: Entry) => e.type === 'need' || e.unread.length > 0

const pathOf = (url: string) => {
  const u = new URL(url, 'http://x')
  return `${u.pathname}${u.search}`
}

/** Newest first, one row per thing: repeats of the same title and place fold. */
function groupNotes(notes: Array<Notification>): Array<Entry> {
  const rows = new Map<string, Extract<Entry, { type: 'note' }>>()
  const sorted = [...notes].sort(
    (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
  )
  for (const n of sorted) {
    const key = `${n.kind}\u0000${n.repo}\u0000${n.title}\u0000${n.html_url}`
    const row = rows.get(key)
    if (row) {
      row.ids.push(n.id)
      if (n.unread) row.unread.push(n.id)
    } else
      rows.set(key, {
        type: 'note',
        id: n.id,
        at: n.created_at,
        item: n,
        ids: [n.id],
        unread: n.unread ? [n.id] : [],
      })
  }
  return [...rows.values()]
}

/**
 * What waits on you, in the order the server ranks it, then what happened,
 * newest first. A notification about something that waits on you is dropped:
 * the waiting item already says it.
 */
export function useInbox(): Inbox {
  const needs = useOp('inbox.list', { limit: 50 })
  const notes = useOp('notifications.list', { limit: 100 }).data
  const paths = new Set(needs.items.map((n) => n.path))
  const entries: Array<Entry> = [
    ...needs.items.map((item): Entry => ({
      type: 'need',
      id: item.id,
      at: item.created_at,
      item,
    })),
    ...groupNotes(notes.filter((n) => !paths.has(pathOf(n.html_url)))),
  ]
  return {
    entries,
    more: needs.counts.total - needs.items.length,
    counts: { all: entries.length, unread: entries.filter(isUnread).length },
  }
}

const severities: Record<
  InboxItem['severity'],
  { label: string; tone: BadgeTone }
> = {
  stopped: { label: 'Stopped', tone: 'danger' },
  failing: { label: 'Failing', tone: 'danger' },
  blocked: { label: 'Blocked', tone: 'warning' },
  review: { label: 'Review', tone: 'merged' },
  handoff: { label: 'Waiting on you', tone: 'info' },
  assigned: { label: 'Assigned', tone: 'info' },
  mention: { label: 'Mention', tone: 'muted' },
}

const needIcons: Record<InboxItem['kind'], PhosphorIcon> = {
  mirror_stopped: LinkIcon,
  main_failing: XCircleIcon,
  change_blocked: ProhibitIcon,
  checks_failing: XCircleIcon,
  review_requested: GitMergeIcon,
  pipeline_waiting: PauseCircleIcon,
  runner_missing: HardDrivesIcon,
  issue_assigned: WarningCircleIcon,
  mention: ChatCircleIcon,
}

const actions: Record<InboxItem['action'], string> = {
  open: 'Open',
  review: 'Review',
  fix: 'Open',
  retry: 'See the run',
  resume: 'Open',
  answer: 'Answer',
}

const noteIcons: Record<Notification['kind'], PhosphorIcon> = {
  handoff: HandIcon,
  review: GitMergeIcon,
  mention: ChatCircleIcon,
  release: RocketLaunchIcon,
  ci: XCircleIcon,
  issue: WarningCircleIcon,
  import: LinkIcon,
}

const kinds: Record<Notification['kind'], { label: string; tone: BadgeTone }> =
  {
    handoff: { label: 'Waiting', tone: 'info' },
    review: { label: 'Review', tone: 'merged' },
    ci: { label: 'Failed', tone: 'danger' },
    issue: { label: 'Assigned', tone: 'info' },
    mention: { label: 'Mention', tone: 'muted' },
    release: { label: 'Release', tone: 'muted' },
    import: { label: 'Import', tone: 'muted' },
  }

function Glyph({ icon: I, unread }: { icon: PhosphorIcon; unread?: boolean }) {
  return (
    <span className="relative mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-muted">
      <I className="size-4 text-muted-foreground" />
      {unread && (
        <span className="absolute -top-px -right-px size-2.5 rounded-full bg-brand ring-2 ring-card">
          <span className="sr-only">Unread</span>
        </span>
      )}
    </span>
  )
}

const repoOf = (x: InboxItem) => {
  const [owner = '', repo = ''] = (x.repo ?? '').split('/')
  return { owner, repo }
}

type Quick = { label: string; icon: PhosphorIcon; run: () => Promise<string> }

/** The one-click way to deal with an item where it stands, when there is one. */
function useQuick(item: InboxItem): Quick | null {
  const write = useWrite()
  const run = item.subject?.type === 'run' ? item.subject.number : null
  if (run === null) return null
  const at = { ...repoOf(item), run }
  if (item.kind === 'main_failing')
    return {
      label: 'Retry',
      icon: ArrowClockwiseIcon,
      run: async () => {
        const r = await write('pipelines.rerun', at)
        if (r.error) throw new Error(r.error.message)
        return `Run #${r.data.number} started`
      },
    }
  if (item.kind === 'pipeline_waiting')
    return {
      label: 'Approve',
      icon: CheckIcon,
      run: async () => {
        const detail = await op('pipelines.get', at)
        const waiting = (detail.jobs ?? [])
          .flatMap((j, ji) =>
            j.steps.flatMap((s, si) =>
              s.status === 'waiting' ? [{ job: ji + 1, step: si + 1 }] : [],
            ),
          )
          .at(0)
        if (!waiting) throw new Error('Nothing waits on this run any more.')
        const r = await write('pipelines.resume', {
          ...at,
          ...waiting,
          body: { status: 'success', summary: 'Approved from the inbox.' },
        })
        if (r.error) throw new Error(r.error.message)
        return 'Approved'
      },
    }
  return null
}

function QuickButton({ quick }: { quick: Quick }) {
  const [state, setState] = React.useState<
    { busy: true } | { done: string } | { error: string } | null
  >(null)
  if (state && 'done' in state)
    return (
      <span
        role="status"
        className="flex items-center gap-1 text-xs text-success"
      >
        <CheckIcon className="size-3.5" />
        {state.done}
      </span>
    )
  const Icon = quick.icon
  return (
    <span className="flex flex-col items-end gap-1">
      <Button
        size="sm"
        variant="brand"
        disabled={state !== null && 'busy' in state}
        onClick={() => {
          setState({ busy: true })
          quick.run().then(
            (done) => setState({ done }),
            (e: unknown) =>
              setState({
                error: e instanceof Error ? e.message : 'That did not work.',
              }),
          )
        }}
      >
        <Icon />
        {quick.label}
      </Button>
      {state && 'error' in state && (
        <span role="alert" className="max-w-48 text-right text-xs text-danger">
          {state.error}
        </span>
      )}
    </span>
  )
}

/** What can be handed to an agent: something broken or assigned, not a review. */
const handable = new Set<InboxItem['kind']>([
  'main_failing',
  'checks_failing',
  'change_blocked',
  'pipeline_waiting',
  'issue_assigned',
])

type Sent =
  | { state: 'idle' }
  | { state: 'sending' }
  | { state: 'sent'; agent: boolean; run: number | null }
  | { state: 'failed'; message: string }

/** Queues the item for your agent, a runner labelled t3 that opens T3 Code. */
function useHandOff(x: InboxItem) {
  const write = useWrite()
  const [sent, setSent] = React.useState<Sent>({ state: 'idle' })
  const { owner, repo } = repoOf(x)
  const subject = x.subject
  const send =
    handable.has(x.kind) && x.repo && subject
      ? () => {
          setSent({ state: 'sending' })
          void write('handoffs.start', {
            owner,
            repo,
            body: {
              subject:
                subject.type === 'run'
                  ? `run:${subject.number}`
                  : String(subject.number),
              to: 't3',
            },
          }).then((r) =>
            setSent(
              r.error
                ? { state: 'failed', message: r.error.message }
                : { state: 'sent', agent: r.data.agent, run: r.data.run },
            ),
          )
        }
      : null
  return { sent, send, owner, repo }
}

function HandOffState({
  sent,
  owner,
  repo,
}: {
  sent: Sent
  owner: string
  repo: string
}) {
  if (sent.state === 'failed')
    return (
      <span role="alert" className="mt-1.5 block text-xs text-danger">
        {sent.message}
      </span>
    )
  if (sent.state !== 'sent') return null
  if (!sent.agent)
    return (
      <span
        role="status"
        className="mt-1.5 block text-xs text-muted-foreground"
      >
        <span className="font-medium text-foreground">
          Queued, but no agent takes hand-offs yet.
        </span>{' '}
        Once, on the machine with T3 Code:{' '}
        <code className="font-mono text-foreground">
          cb runner register my-mac --labels t3
        </code>
        , then{' '}
        <code className="font-mono text-foreground">cb runner start</code>.
      </span>
    )
  return (
    <span
      role="status"
      className="mt-1.5 flex flex-wrap items-center gap-1 text-xs text-success"
    >
      <CheckIcon className="size-3.5" />
      {sent.run === null
        ? 'Already with your agent.'
        : 'Sent. Your agent opens a T3 Code thread on its machine.'}
      {sent.run !== null && (
        <Link
          to="/$handle/$repo/$tab"
          params={{ handle: owner, repo, tab: 'pipelines' }}
          search={{ n: sent.run }}
          className="text-muted-foreground underline underline-offset-4 hover:text-foreground"
        >
          Run #{sent.run}
        </Link>
      )}
    </span>
  )
}

function NeedRow({ x }: { x: InboxItem }) {
  const s = severities[x.severity]
  const quick = useQuick(x)
  const hand = useHandOff(x)
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-2 px-4 py-3">
      <Glyph icon={needIcons[x.kind]} />
      <span className="min-w-0 flex-1 basis-48">
        <span className="flex flex-wrap items-center gap-2">
          <Badge tone={s.tone}>{s.label}</Badge>
          <span className="min-w-0 text-sm font-medium break-words">
            {x.title}
          </span>
        </span>
        <span className="mt-1 block text-xs text-muted-foreground">
          {x.note}
        </span>
        <span className="mt-0.5 block text-xs text-muted-foreground">
          {x.repo ? `${x.repo}, ` : ''}
          {timeAgo(x.created_at)}
        </span>
        <HandOffState sent={hand.sent} owner={hand.owner} repo={hand.repo} />
      </span>
      <span className="ml-11 flex shrink-0 flex-wrap items-start justify-end gap-2 self-center sm:ml-0">
        {quick && <QuickButton quick={quick} />}
        {hand.send && hand.sent.state !== 'sent' && (
          <Button
            size="sm"
            variant="outline"
            disabled={hand.sent.state === 'sending'}
            onClick={hand.send}
          >
            <BrandLogo id="t3code" className="size-4" />
            {x.subject?.type === 'issue'
              ? 'Start with T3 Code'
              : 'Fix with T3 Code'}
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          render={<Link to={x.path} />}
          nativeButton={false}
        >
          {actions[x.action]}
        </Button>
      </span>
    </li>
  )
}

function NoteRow({ e }: { e: Extract<Entry, { type: 'note' }> }) {
  const write = useWrite()
  const navigate = useNavigate()
  const n = e.item
  const unread = e.unread.length > 0
  const markRead = () =>
    Promise.all(
      e.unread.map((id) => write('notifications.read', { notification: id })),
    )
  const open = () => {
    if (unread) void markRead()
    void navigate({ href: pathOf(n.html_url) })
  }
  return (
    <li className="group/note relative flex items-start gap-3 px-4 py-3 hover:bg-muted/40">
      <Glyph icon={noteIcons[n.kind]} unread={unread} />
      <button
        type="button"
        onClick={open}
        className="min-w-0 flex-1 text-left focus-ring-inset after:absolute after:inset-0"
      >
        <span className={cn('block text-sm', unread && 'font-medium')}>
          {n.title}
          {e.ids.length > 1 && (
            <span className="ml-1.5 rounded-full bg-muted px-1.5 font-mono text-xs font-normal text-muted-foreground tabular-nums">
              ×{e.ids.length}
            </span>
          )}
        </span>
        <span className="mt-0.5 block text-xs text-muted-foreground">
          {n.repo ? `${n.repo}, ` : ''}
          {timeAgo(n.created_at)}
        </span>
      </button>
      <span className="relative flex shrink-0 items-center gap-1 self-center">
        {unread && (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Mark as read"
            title="Mark as read"
            className="md:opacity-0 md:group-focus-within/note:opacity-100 md:group-hover/note:opacity-100"
            onClick={() => void markRead()}
          >
            <CheckIcon />
          </Button>
        )}
        <Badge tone={kinds[n.kind].tone} className="max-sm:hidden">
          {kinds[n.kind].label}
        </Badge>
      </span>
    </li>
  )
}

export function InboxList({ inbox, box }: { inbox: Inbox; box: Box }) {
  const shown =
    box === 'unread' ? inbox.entries.filter(isUnread) : inbox.entries
  if (shown.length === 0)
    return box === 'unread' ? (
      <EmptyState title="You are all caught up">
        Nothing unread, and nothing waits on you.
      </EmptyState>
    ) : (
      <EmptyState title="Your inbox is empty">
        Reviews, failing builds, steps waiting on you, mentions and releases
        show up here.
      </EmptyState>
    )
  return (
    <>
      <Stagger
        as="ul"
        className="surface divide-y overflow-hidden rounded-2xl border bg-card"
      >
        {shown.map((e) =>
          e.type === 'need' ? (
            <NeedRow key={e.id} x={e.item} />
          ) : (
            <NoteRow key={e.id} e={e} />
          ),
        )}
      </Stagger>
      {inbox.more > 0 && (
        <p className="mt-3 text-center text-xs text-muted-foreground">
          And {inbox.more} more that wait on you. Deal with the ones above
          first.
        </p>
      )}
    </>
  )
}
