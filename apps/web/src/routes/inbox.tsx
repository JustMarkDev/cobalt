import * as React from 'react'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import {
  ChatBubbleLeftIcon,
  ExclamationCircleIcon,
  HandRaisedIcon,
  LinkIcon,
  NoSymbolIcon,
  PauseCircleIcon,
  RocketLaunchIcon,
  ServerStackIcon,
  XCircleIcon,
} from '@heroicons/react/24/outline'
import { cn } from 'cn'
import type { BadgeTone } from '~/components/ui/badge'
import type { InboxItem, Notification } from '@source-code/sdk'
import { RequireAuth } from '~/components/forge/auth'
import { Stagger } from '~/components/motion'
import { GitMergeIcon } from '~/components/icons'
import { EmptyState } from '~/components/forge/bits'
import { Segmented } from '~/components/ui/tabs'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { useOp, useWrite } from '~/lib/forge'
import { timeAgo } from '~/lib/repo'

/**
 * Two views of the same person. "Needs you" is a queue worked out from the
 * state of things: a review that lands or a build that goes green leaves it
 * by itself. "Activity" is the feed of what happened. Each row in the queue
 * has one button, and it only takes you to the thing: approving, denying or
 * landing happen there, where their own permissions are checked.
 */
export const Route = createFileRoute('/inbox')({
  head: () => ({ meta: [{ title: 'Inbox · source.code' }] }),
  validateSearch: (
    s: Record<string, unknown>,
  ): { tab?: 'needs' | 'activity' } =>
    s.tab === 'activity' ? { tab: 'activity' } : {},
  component: () => (
    <RequireAuth>
      <Inbox />
    </RequireAuth>
  ),
})

function Inbox() {
  const { tab = 'needs' } = Route.useSearch()
  const navigate = useNavigate()
  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Inbox</h1>
      </div>
      <div className="mb-4">
        <Segmented
          label="View"
          value={tab}
          onChange={(t) =>
            void navigate({
              to: '/inbox',
              search: t === 'needs' ? {} : { tab: t },
            })
          }
          options={[
            ['needs', 'Needs you'],
            ['activity', 'Activity'],
          ]}
        />
      </div>
      {tab === 'needs' ? <NeedsYou /> : <Activity />}
    </div>
  )
}

// ---- Needs you ------------------------------------------------------------------

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

const kindIcons: Record<InboxItem['kind'], typeof XCircleIcon> = {
  mirror_stopped: LinkIcon,
  main_failing: XCircleIcon,
  change_blocked: NoSymbolIcon,
  checks_failing: XCircleIcon,
  review_requested: GitMergeIcon as typeof XCircleIcon,
  pipeline_waiting: PauseCircleIcon,
  runner_missing: ServerStackIcon,
  issue_assigned: ExclamationCircleIcon,
  mention: ChatBubbleLeftIcon,
}

const actions: Record<InboxItem['action'], string> = {
  open: 'Open',
  review: 'Review',
  fix: 'Fix',
  retry: 'See the run',
  resume: 'Resume',
  answer: 'Answer',
}

function NeedsYou() {
  const inbox = useOp('inbox.list', { limit: 50 })
  if (inbox.items.length === 0)
    return (
      <EmptyState title="Nothing needs you">
        Reviews, failing builds and steps waiting on you show up here, and leave
        by themselves once they are dealt with.
      </EmptyState>
    )
  const more = inbox.counts.total - inbox.items.length
  return (
    <>
      <Stagger
        as="ul"
        className="surface divide-y overflow-hidden rounded-2xl border bg-card"
      >
        {inbox.items.map((x) => {
          const Icon = kindIcons[x.kind]
          const s = severities[x.severity]
          return (
            <li key={x.id} className="flex items-start gap-3 px-4 py-3">
              <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-muted">
                <Icon className="size-4 text-muted-foreground" />
              </span>
              <span className="min-w-0 flex-1">
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
              </span>
              <Button
                size="sm"
                variant={
                  x.severity === 'stopped' || x.severity === 'failing'
                    ? 'default'
                    : 'outline'
                }
                className="shrink-0 self-center"
                render={<Link to={x.path} />}
              >
                {actions[x.action]}
              </Button>
            </li>
          )
        })}
      </Stagger>
      {more > 0 && (
        <p className="mt-3 text-center text-xs text-muted-foreground">
          And {more} more. Deal with the ones above first.
        </p>
      )}
    </>
  )
}

// ---- Activity -------------------------------------------------------------------

const icons = {
  handoff: HandRaisedIcon,
  review: GitMergeIcon,
  mention: ChatBubbleLeftIcon,
  release: RocketLaunchIcon,
  ci: XCircleIcon,
  issue: ExclamationCircleIcon,
  import: LinkIcon,
} as const

/** What each kind of item is, in words. The ones that ask something of you are coloured. */
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

const filters = [
  ['all', 'All'],
  ['unread', 'Unread'],
  ['review', 'Reviews'],
  ['release', 'Releases'],
] as const

function Activity() {
  const items = useOp('notifications.list', { limit: 100 }).data
  const write = useWrite()
  const navigate = useNavigate()
  const [filter, setFilter] = React.useState<(typeof filters)[number][0]>('all')
  const unread = items.filter((n) => n.unread).length
  const shown = items.filter(
    (n) =>
      filter === 'all' || (filter === 'unread' ? n.unread : n.kind === filter),
  )
  const open = (n: Notification) => {
    if (n.unread) void write('notifications.read', { notification: n.id })
    const to = new URL(n.html_url)
    void navigate({ href: `${to.pathname}${to.search}` })
  }
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Segmented
          label="Filter"
          value={filter}
          onChange={setFilter}
          options={filters.map(([id, label]): [typeof id, string] => [
            id,
            id === 'unread' && unread > 0 ? `${label} ${unread}` : label,
          ])}
        />
        <Button
          variant="ghost"
          size="sm"
          disabled={unread === 0}
          onClick={() => void write('notifications.read_all', {})}
        >
          Mark all as read
        </Button>
      </div>
      {shown.length === 0 ? (
        <EmptyState title="You are all caught up">
          Nothing here right now.
        </EmptyState>
      ) : (
        <Stagger
          as="ul"
          className="surface divide-y overflow-hidden rounded-2xl border bg-card"
        >
          {shown.map((n) => {
            const Icon = icons[n.kind]
            return (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => open(n)}
                  className="flex w-full items-start gap-3 px-4 py-3 text-left focus-ring-inset hover:bg-muted/40"
                >
                  <span className="relative mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-muted">
                    {n.unread && (
                      <span className="absolute top-1/2 -left-3 size-2 -translate-y-1/2 rounded-full bg-brand" />
                    )}
                    <Icon className="size-4 text-muted-foreground" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn('block text-sm', n.unread && 'font-medium')}
                    >
                      {n.unread && <span className="sr-only">Unread: </span>}
                      {n.title}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {n.repo ? `${n.repo}, ` : ''}
                      {timeAgo(n.created_at)}
                    </span>
                  </span>
                  <Badge
                    tone={kinds[n.kind].tone}
                    className="shrink-0 self-center"
                  >
                    {kinds[n.kind].label}
                  </Badge>
                </button>
              </li>
            )
          })}
        </Stagger>
      )}
    </>
  )
}
