import * as React from 'react'
import { Link } from '@tanstack/react-router'
import {
  CheckIcon,
  ClipboardDocumentIcon,
  ClockIcon,
  ExclamationCircleIcon,
  RocketLaunchIcon,
  StarIcon,
} from '@heroicons/react/24/outline'
import { cn } from 'cn'
import * as m from 'motion/react-m'
import { useSignInGate } from './auth'
import { Avatar } from './bits'
import type { Repo } from '~/lib/model/data'
import { GitCommitIcon, GitForkIcon, GitMergeIcon } from '~/components/icons'
import { PageTransition } from '~/components/motion'
import { LinkTabs } from '~/components/ui/tabs'
import { Button } from '~/components/ui/button'
import { Badge } from '~/components/ui/badge'
import { manages, useAccount } from '~/lib/auth/accounts'
import { useOpMaybe, useWrite } from '~/lib/forge'
import { compact, languageColors, seeded } from '~/lib/model/data'

export type RepoPage =
  | 'code'
  | 'issues'
  | 'pulls'
  | 'pipelines'
  | 'release'
  | 'insights'
  | 'settings'

/** Page id -> URL segment. */
export const tabSlug: Record<RepoPage, string> = {
  code: 'code',
  issues: 'issues',
  pulls: 'changes',
  pipelines: 'pipelines',
  release: 'releases',
  insights: 'insights',
  settings: 'settings',
}

const tabs: Array<[RepoPage, string]> = [
  ['code', 'Code'],
  ['issues', 'Issues'],
  ['pulls', 'Changes'],
  ['pipelines', 'Pipelines'],
  ['release', 'Releases'],
  ['insights', 'Insights'],
  ['settings', 'Settings'],
]

export const slugOf = (r: Repo) => `${r.owner}/${r.name}`

export function CopyField({
  value,
  className,
  prefix = '$',
}: {
  value: string
  className?: string
  prefix?: string
}) {
  const [copied, setCopied] = React.useState(false)
  return (
    <div
      className={cn(
        'well flex items-center gap-2 rounded-lg border bg-background py-1 pr-1 pl-3 font-mono text-xs',
        className,
      )}
    >
      {prefix && (
        <span className="text-muted-foreground select-none">{prefix}</span>
      )}
      <span className="min-w-0 flex-1 truncate">{value}</span>
      <button
        type="button"
        aria-label="Copy"
        onClick={() => {
          void navigator.clipboard.writeText(value)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }}
        className="rounded-[calc(var(--radius)-0.25rem-1px)] p-1.5 text-muted-foreground transition-colors focus-ring-inset hover:bg-muted hover:text-foreground"
      >
        {copied ? (
          <CheckIcon className="size-3.5 text-success" />
        ) : (
          <ClipboardDocumentIcon className="size-3.5" />
        )}
      </button>
    </div>
  )
}

/**
 * The repository chrome: header, tabs and page-level actions. It lives above
 * the tab pages so switching tabs only swaps the content below it. Nothing in
 * the header remounts, which keeps its state (Star) and lets the tab pill glide.
 */
export function RepoFrame({
  repo,
  active,
  counts,
  actions,
  children,
}: {
  repo: Repo
  active: RepoPage
  counts?: Partial<Record<RepoPage, number>>
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  // The counts come from the repository read, which stays live: a new issue
  // updates the tab without the page below reporting it.
  return (
    <>
      <RepoHeader
        repo={repo}
        active={active}
        counts={counts}
        actions={actions}
      />
      <PageTransition trigger={active}>{children}</PageTransition>
    </>
  )
}

export function RepoHeader({
  repo,
  active,
  counts,
  actions,
}: {
  repo: Repo
  active: RepoPage
  counts?: Partial<Record<RepoPage, number>>
  /** Page-level controls, shown on the right of the tab row. */
  actions?: React.ReactNode
}) {
  const at = { owner: repo.owner, repo: repo.name }
  const star = useOpMaybe('stars.get', at)
  const write = useWrite()
  const starred = star?.starred ?? false
  const gate = useSignInGate()
  const owner = useAccount(repo.owner)
  // Settings belong to whoever manages the account that owns it: the person,
  // or an owner or admin of the organization. Everyone else sees the public tabs.
  const mine = manages(owner)
  const numbers: Partial<Record<RepoPage, number>> = { ...counts }
  return (
    <header className="mb-5 space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Avatar handle={repo.owner} className="size-9 text-sm" />
          <h1 className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xl leading-tight font-semibold tracking-tight">
            <Link
              to="/$handle"
              params={{ handle: repo.owner }}
              className="font-normal text-muted-foreground hover:text-foreground"
            >
              {owner?.name ?? repo.owner}
            </Link>
            <span aria-hidden className="font-normal text-muted-foreground/50">
              /
            </span>
            {repo.name}
            <Badge tone="outline">
              {repo.visibility === 'private' ? 'Private' : 'Public'}
            </Badge>
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={() => gate()}>
            <GitForkIcon /> Fork
            <span className="text-muted-foreground tabular-nums">
              {compact(repo.forks)}
            </span>
          </Button>
          <Button
            aria-pressed={starred}
            disabled={star === undefined}
            onClick={() =>
              gate(() => void write(starred ? 'stars.remove' : 'stars.add', at))
            }
          >
            <m.span
              key={String(starred)}
              initial={starred ? { scale: 0.5, rotate: -30 } : false}
              animate={{ scale: 1, rotate: 0 }}
              transition={{ type: 'spring', stiffness: 600, damping: 14 }}
              className="inline-flex"
            >
              <StarIcon
                className={cn(starred && 'fill-brand text-brand-ink')}
              />
            </m.span>
            {starred ? 'Starred' : 'Star'}
            <span className="text-muted-foreground tabular-nums">
              {compact(star?.stars ?? repo.stars)}
            </span>
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 max-sm:flex-col max-sm:items-stretch">
        <LinkTabs
          className="max-sm:order-2"
          label="Repository"
          tabs={tabs
            .filter(([id]) => id !== 'settings' || mine)
            .map(([id, label]) => ({
              label,
              count: numbers[id],
              active: id === active,
              link: {
                to: '/$handle/$repo/$tab',
                params: {
                  handle: repo.owner,
                  repo: repo.name,
                  tab: tabSlug[id],
                },
              },
            }))}
        />
        {actions && (
          <div className="flex flex-wrap items-center gap-2 max-sm:order-1">
            {actions}
          </div>
        )}
      </div>
    </header>
  )
}

export function Languages({ repo }: { repo: Repo }) {
  return (
    <div>
      <div className="flex h-2 gap-0.5 overflow-hidden rounded-full">
        {repo.languages.map(([l, pct]) => (
          <span
            key={l}
            title={`${l} ${pct}%`}
            style={{
              width: `${pct}%`,
              background: languageColors[l] ?? '#71717a',
            }}
          />
        ))}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {repo.languages.map(([l, pct]) => (
          <li key={l} className="inline-flex items-center gap-1.5">
            <span
              className="size-2 rounded-full"
              style={{ background: languageColors[l] ?? '#71717a' }}
            />
            <span className="font-medium">{l}</span>
            <span className="text-muted-foreground tabular-nums">{pct}%</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * Shades mixed from the brand into the card, so the steps stay even in both
 * themes instead of turning muddy the way a translucent brand does on dark.
 */
const LEVELS = [
  'var(--heat-0)',
  'color-mix(in oklab, var(--brand) 28%, var(--card))',
  'color-mix(in oklab, var(--brand) 50%, var(--card))',
  'color-mix(in oklab, var(--brand) 74%, var(--card))',
  'var(--brand)',
]

const DAY_MS = 86_400_000
const dayFmt = new Intl.DateTimeFormat('en', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
})
const monthFmt = new Intl.DateTimeFormat('en', {
  month: 'short',
  timeZone: 'UTC',
})

/**
 * Levels by quartile of the busy days, not by share of the busiest one, so a
 * single big day does not wash every other day out to the faintest shade.
 */
function levelsFor(counts: Array<number>) {
  const busy = counts.filter((n) => n > 0).sort((a, b) => a - b)
  const q = (p: number) => busy[Math.floor((busy.length - 1) * p)] ?? 0
  const cuts = [q(0.25), q(0.5), q(0.75)]
  return counts.map((n) =>
    n === 0 ? 0 : n <= cuts[0] ? 1 : n <= cuts[1] ? 2 : n <= cuts[2] ? 3 : 4,
  )
}

/**
 * Contribution heatmap: one column per week, Sunday on top, today last.
 * Totals are merged across everything linked to the account.
 */
export function ContributionGraph({
  seed,
  counts,
  weeks = 26,
  className,
}: {
  seed: number
  /** Real counts per day, oldest first, ending today; drawn instead of the seeded pattern. */
  counts?: Array<number>
  weeks?: number
  className?: string
}) {
  const data = React.useMemo(() => {
    const days = weeks * 7
    const today = Math.floor(Date.now() / DAY_MS)
    let values: Array<number>
    if (counts) {
      values = Array.from(
        { length: days },
        (_, i) => counts[counts.length - days + i] ?? 0,
      )
    } else {
      const rand = seeded(seed)
      values = Array.from({ length: days }, (_, i) => {
        const burst = Math.sin(i / 23) + Math.sin(i / 7) * 0.5
        return rand() + burst * 0.18 > 0.55 ? Math.ceil(rand() * 6) : 0
      })
    }
    const levels = levelsFor(values)
    // Pad the front so every column starts on a Sunday; the last column ends
    // today and may be short.
    const first = today - days + 1
    const lead = new Date(first * DAY_MS).getUTCDay()
    const cells: Array<{ day: number; n: number; level: number } | null> = [
      ...Array.from({ length: lead }, () => null),
      ...values.map((n, i) => ({ day: first + i, n, level: levels[i] })),
    ]
    const columns: Array<typeof cells> = []
    for (let i = 0; i < cells.length; i += 7)
      columns.push(cells.slice(i, i + 7))
    // A month is labelled over the first column that holds its 1st.
    let last = -1
    const months = columns.map((col) => {
      const firstDay = col.find((c) => c)
      if (!firstDay) return ''
      const month = new Date(firstDay.day * DAY_MS).getUTCMonth()
      if (month === last) return ''
      const isFirst = last === -1
      last = month
      // Skip a label squeezed into a partial first month.
      return isFirst && new Date(firstDay.day * DAY_MS).getUTCDate() > 14
        ? ''
        : monthFmt.format(firstDay.day * DAY_MS)
    })
    let streak = 0
    let best = 0
    for (const n of values) {
      streak = n > 0 ? streak + 1 : 0
      best = Math.max(best, streak)
    }
    let current = 0
    for (let i = values.length - 1; i >= 0 && values[i] > 0; i--) current++
    const top = values.reduce((b, n, i) => (n > values[b] ? i : b), 0)
    return {
      columns,
      months,
      total: values.reduce((a, b) => a + b, 0),
      active: values.filter((n) => n > 0).length,
      best,
      current,
      busiest: values[top] > 0 ? { day: first + top, n: values[top] } : null,
    }
  }, [seed, counts, weeks])

  const grid = {
    gridTemplateColumns: `repeat(${data.columns.length}, minmax(0, 1fr))`,
  }
  return (
    <div
      className={cn(
        'flex flex-col gap-6 md:flex-row md:items-center md:justify-between',
        className,
      )}
    >
      <div className="min-w-0 flex-1 md:max-w-120">
        <div className="flex gap-2">
          <div className="grid shrink-0 grid-rows-[auto_repeat(7,minmax(0,1fr))] gap-[3px] text-[10px] leading-none text-muted-foreground">
            <span className="h-3" />
            {['', 'Mon', '', 'Wed', '', 'Fri', ''].map((d, i) => (
              <span key={i} className="flex items-center">
                {d}
              </span>
            ))}
          </div>
          <div className="min-w-0 flex-1">
            <div className="mb-[3px] grid h-3 gap-[3px]" style={grid}>
              {data.months.map((label, i) => (
                <span
                  key={i}
                  className="overflow-visible text-[10px] leading-none whitespace-nowrap text-muted-foreground"
                >
                  {label}
                </span>
              ))}
            </div>
            <div
              className="grid grid-flow-col grid-rows-7 gap-[3px]"
              style={grid}
              role="img"
              aria-label={`${data.total} contributions on ${data.active} days in the past ${weeks} weeks`}
            >
              {data.columns
                .flat()
                .map((c, i) =>
                  c ? (
                    <span
                      key={i}
                      title={`${c.n === 0 ? 'No' : c.n} contribution${c.n === 1 ? '' : 's'} on ${dayFmt.format(c.day * DAY_MS)}`}
                      className="aspect-square rounded-[3px] [--heat-0:color-mix(in_oklab,var(--foreground)_7%,var(--card))]"
                      style={{ background: LEVELS[c.level] }}
                    />
                  ) : (
                    <span key={i} />
                  ),
                )}
            </div>
          </div>
        </div>
        <div className="mt-3 flex items-center justify-end gap-1 text-[10px] text-muted-foreground [--heat-0:color-mix(in_oklab,var(--foreground)_7%,var(--card))]">
          <span className="mr-1">Less</span>
          {LEVELS.map((l) => (
            <span
              key={l}
              className="size-2.5 rounded-[2px]"
              style={{ background: l }}
            />
          ))}
          <span className="ml-1">More</span>
        </div>
      </div>
      <dl className="grid shrink-0 grid-cols-2 gap-x-8 gap-y-4 text-sm md:w-64">
        {(
          [
            ['Contributions', data.total.toLocaleString('en')],
            ['Active days', `${data.active}`],
            [
              'Longest streak',
              `${data.best} ${data.best === 1 ? 'day' : 'days'}`,
            ],
            [
              'Current streak',
              `${data.current} ${data.current === 1 ? 'day' : 'days'}`,
            ],
          ] as const
        ).map(([k, v]) => (
          <div key={k}>
            <dt className="text-xs text-muted-foreground">{k}</dt>
            <dd className="mt-0.5 font-medium tabular-nums">{v}</dd>
          </div>
        ))}
        {data.busiest && (
          <div className="col-span-2">
            <dt className="text-xs text-muted-foreground">Busiest day</dt>
            <dd className="mt-0.5 font-medium tabular-nums">
              {dayFmt.format(data.busiest.day * DAY_MS)}
              <span className="ml-1.5 font-normal text-muted-foreground">
                {data.busiest.n} contributions
              </span>
            </dd>
          </div>
        )}
      </dl>
    </div>
  )
}

type TimelineEvent = {
  kind: 'commit' | 'release' | 'pr' | 'issue'
  title: string
  when: string
  ref: string
}

const kindIcon = {
  commit: GitCommitIcon,
  release: RocketLaunchIcon,
  pr: GitMergeIcon,
  issue: ExclamationCircleIcon,
} as const

/** Commit rail: one history for the project, newest first. */
export function Timeline({ repo }: { repo: Repo }) {
  const latest = repo.releases.at(0)
  const events: Array<TimelineEvent> = [
    ...(latest
      ? [
          {
            kind: 'release',
            title: `Released ${latest.version}: ${latest.title}`,
            when: latest.date,
            ref: latest.version,
          } as const,
        ]
      : []),
    {
      kind: 'commit',
      title: 'Cache negative ref lookups',
      when: '2 days ago',
      ref: 'a41c9e2',
    },
    {
      kind: 'pr',
      title: 'Merged #214: Add a read-only mount mode',
      when: '4 days ago',
      ref: '#214',
    },
    {
      kind: 'commit',
      title: 'Memory-map pack index reads',
      when: '6 days ago',
      ref: '7be03d1',
    },
    {
      kind: 'issue',
      title: 'Closed #198: Panic on trailing-dot ref names',
      when: '9 days ago',
      ref: '#198',
    },
    {
      kind: 'commit',
      title: 'Document S3 retry behaviour',
      when: '12 days ago',
      ref: 'f02a8c6',
    },
  ]
  return (
    <ol className="rail space-y-5">
      {events.map((e, i) => {
        const Icon = kindIcon[e.kind]
        return (
          <li key={i} className="relative pl-9">
            <span className="absolute top-0 left-0 flex size-6 items-center justify-center rounded-full border bg-card">
              <Icon className="size-3.5 text-muted-foreground" />
            </span>
            <div className="text-sm">{e.title}</div>
            <div className="mt-0.5 flex items-center gap-3 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <ClockIcon className="size-3" />
                {e.when}
              </span>
              <span className="font-mono">{e.ref}</span>
            </div>
          </li>
        )
      })}
    </ol>
  )
}
