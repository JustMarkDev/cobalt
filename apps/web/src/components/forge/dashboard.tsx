import * as React from 'react'
import { Link } from '@tanstack/react-router'
import { PlusIcon } from '@phosphor-icons/react'
import { cn } from 'cn'
import { CopyField } from './repo-shell'
import type { DashboardData } from '~/lib/model/dashboard'
import { BrandLogo } from '~/components/brand'
import { TrendChart } from '~/components/charts'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { compact } from '~/lib/model/data'
import { installCommand } from '~/lib/install-script'

function Heading({
  id,
  title,
  count,
  children,
}: {
  id: string
  title: string
  count?: number
  children?: React.ReactNode
}) {
  return (
    <div className="mb-3 flex min-h-8 flex-wrap items-center justify-between gap-3">
      <h2 id={id} className="flex items-baseline gap-2 text-sm font-medium">
        {title}
        {count !== undefined && (
          <span className="text-xs text-muted-foreground tabular-nums">
            {count}
          </span>
        )}
      </h2>
      {children}
    </div>
  )
}

function Delta({ value }: { value: number }) {
  return (
    <Badge tone={value >= 0 ? 'success' : 'muted'}>
      {value >= 0 ? '+' : ''}
      {value}%
    </Badge>
  )
}

const bytes = (n: number) =>
  n < 1e9
    ? `${Math.round(n / 1e6)} MB`
    : `${Math.round((n / 1e9) * 100) / 100} GB`

const DAY = 86_400_000
const shortDate = (t: number) =>
  new Date(t).toLocaleDateString('en', { month: 'short', day: 'numeric' })

function Kpi({
  label,
  value,
  context,
  bad,
}: {
  label: string
  value: React.ReactNode
  context: React.ReactNode
  bad?: boolean
}) {
  return (
    <div className="bg-card px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tracking-tight tabular-nums">
        {value}
      </div>
      <div
        className={cn('text-xs', bad ? 'text-danger' : 'text-muted-foreground')}
      >
        {context}
      </div>
    </div>
  )
}

/** The numbers column next to the inbox. */
export function Numbers({ data }: { data: DashboardData }) {
  const health = Object.values(data.health).filter((h) => h !== undefined)
  const failing = health.filter((h) => h.checks === 'failing').length
  const changes = health.reduce((n, h) => n + h.openChanges, 0)
  const reviews = data.needsYou.filter((n) => n.severity === 'review').length
  const daily = data.downloads.daily
  const end = Date.now()
  const points = daily.map((value, i) => ({
    label: shortDate(end - (daily.length - 1 - i) * DAY),
    value,
  }))
  const c = data.contributions
  return (
    <div className="space-y-4">
      <section
        aria-labelledby="downloads"
        className="surface lit-edge rounded-2xl border bg-card p-4"
      >
        <h2 id="downloads" className="text-xs text-muted-foreground">
          Downloads, 30 days
        </h2>
        <div className="mt-1 flex items-center gap-2">
          <span className="text-2xl font-semibold tracking-tight tabular-nums">
            {compact(data.downloads.total)}
          </span>
          <Delta value={data.downloads.change} />
        </div>
        <div className="mt-3 h-24">
          <TrendChart data={points} axes={false} unit="Downloads" />
        </div>
        {points.length > 1 && (
          <div className="mt-1 flex justify-between text-xs text-muted-foreground">
            <span>{points[0].label}</span>
            <span>{points[points.length - 1].label}</span>
          </div>
        )}
      </section>
      <div className="surface grid grid-cols-2 gap-px overflow-hidden rounded-2xl border bg-border">
        <Kpi
          label="Stars"
          value={compact(data.stars.total)}
          context={`${data.stars.today} new today`}
        />
        <Kpi
          label="Open changes"
          value={changes}
          context={`${reviews} waiting on you`}
        />
        <Kpi
          label="Checks on main"
          value={
            health.length
              ? `${health.length - failing} / ${health.length}`
              : '—'
          }
          context={
            failing > 0
              ? `${failing} failing`
              : health.length
                ? 'All passing'
                : 'No checks yet'
          }
          bad={failing > 0}
        />
        <Kpi
          label="Contributions"
          value={c.total}
          context={`Last 4 weeks, ${c.change >= 0 ? '+' : ''}${c.change}%`}
        />
      </div>
    </div>
  )
}

export function History({
  data,
  organization,
}: {
  data: DashboardData
  organization: boolean
}) {
  const { usedBytes, limitBytes, unlimited } = data.storage
  const pct = unlimited
    ? 0
    : Math.min(100, Math.round((usedBytes / limitBytes) * 100))
  return (
    <section aria-labelledby="safe">
      <Heading id="safe" title={organization ? 'History' : 'Your history'}>
        {!organization && (
          <Link
            to="/settings/$section"
            params={{ section: 'accounts' }}
            className="-my-1.5 py-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            Linked accounts
          </Link>
        )}
      </Heading>
      <div className="space-y-4 surface rounded-2xl border bg-card p-4 text-sm">
        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between text-xs">
            <span className="font-medium">Stored here</span>
            <span className="text-muted-foreground tabular-nums">
              {unlimited
                ? `${bytes(usedBytes)}, no limit`
                : `${bytes(usedBytes)} of ${bytes(limitBytes)}`}
            </span>
          </div>
          <div
            role="progressbar"
            aria-label="Storage used"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            className="h-1.5 overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Commits, issues, reviews and releases.
          </p>
        </div>
        {data.mirrors.length > 0 ? (
          <ul className="divide-y border-t">
            {data.mirrors.map((m) => (
              <li key={m.host} className="flex items-center gap-3 py-2.5">
                <BrandLogo id={m.host} className="size-4" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{m.name}</div>
                  <div
                    className={cn(
                      'text-xs',
                      m.state === 'stopped'
                        ? 'text-danger'
                        : 'text-muted-foreground',
                    )}
                  >
                    {m.note}
                  </div>
                </div>
                {m.state === 'stopped' ? (
                  <Button
                    size="sm"
                    render={
                      <Link
                        to="/$handle/$repo/$tab"
                        params={{
                          handle: 'dana',
                          repo: 'gitfs',
                          tab: 'settings',
                        }}
                        search={{ section: 'mirrors' }}
                      />
                    }
                    nativeButton={false}
                  >
                    Reconnect
                  </Button>
                ) : (
                  <span className="size-2 rounded-full bg-success" />
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="border-t pt-3 text-xs text-muted-foreground">
            No mirrors. Everything lives here, and nothing depends on another
            host.
          </p>
        )}
        {data.imported > 0 && (
          <p className="border-t pt-3 text-xs text-muted-foreground">
            <b className="font-medium text-foreground tabular-nums">
              {data.imported.toLocaleString('en-US')}
            </b>{' '}
            {data.imported === 1
              ? 'past contribution from another host is'
              : 'past contributions from other hosts are'}{' '}
            on your profile.
          </p>
        )}
      </div>
    </section>
  )
}

export function GettingStarted({
  account,
}: {
  account: { kind: 'person' | 'organization'; handle: string; name: string }
}) {
  const org = account.kind === 'organization'
  const steps: Array<{
    title: string
    body: string
    action: React.ReactNode
  }> = [
    {
      title: org
        ? 'Create or import its first repository'
        : 'Create or import a repository',
      body: org
        ? `Repositories you create here belong to ${account.name}, not to you.`
        : 'Start something new, or bring a project and its history from GitHub, GitLab, Codeberg or Gitea.',
      action: (
        <Button
          variant="brand"
          render={<Link to="/new" />}
          nativeButton={false}
        >
          <PlusIcon /> New repository
        </Button>
      ),
    },
    org
      ? {
          title: 'Invite your team',
          body: 'People join with a role. Owners manage everything, admins manage people, members work in the repositories.',
          action: (
            <Button
              render={
                <Link
                  to="/organizations/$handle/$section"
                  params={{ handle: account.handle, section: 'members' }}
                />
              }
              nativeButton={false}
            >
              Invite people
            </Button>
          ),
        }
      : {
          title: 'Install the CLI',
          body: 'One file, nothing else to install. It never asks a question and every command speaks JSON, so scripts and agents can use it.',
          action: (
            <CopyField value={installCommand('https://cobaltforge.dev')} />
          ),
        },
    org
      ? {
          title: 'Act as it from the CLI',
          body: 'One login, any account. Switch once and every cb command works as the organization.',
          action: <CopyField value={`cb account switch ${account.handle}`} />,
        }
      : {
          title: 'Teach your agents',
          body: 'One command makes any coding agent fluent in cb, with scoped access and no secret values.',
          action: <CopyField value="cb skill install" />,
        },
  ]
  if (!org)
    steps.push({
      title: 'Work for a company or a team?',
      body: 'Make an organization. It owns its repositories, so they stay with the team when people come and go.',
      action: (
        <Button render={<Link to="/organizations/new" />} nativeButton={false}>
          New organization
        </Button>
      ),
    })
  return (
    <section aria-labelledby="start">
      <Heading id="start" title="Get started" />
      <ol className="divide-y surface overflow-hidden rounded-2xl border bg-card">
        {steps.map((step, i) => (
          <li
            key={step.title}
            className="flex flex-wrap items-center gap-x-6 gap-y-3 px-5 py-4"
          >
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted font-mono text-xs text-muted-foreground">
              {i + 1}
            </span>
            <div className="min-w-0 flex-1 basis-64 space-y-0.5">
              <div className="text-sm font-medium">{step.title}</div>
              <p className="text-sm text-muted-foreground">{step.body}</p>
            </div>
            <div className="w-full sm:w-80">{step.action}</div>
          </li>
        ))}
      </ol>
    </section>
  )
}
