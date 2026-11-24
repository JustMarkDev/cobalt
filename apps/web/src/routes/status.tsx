import { createFileRoute } from '@tanstack/react-router'
import {
  CheckCircleIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/outline'
import { cn } from 'cn'
import type { Status as StatusReport } from '@cobaltforge/sdk'
import { Badge } from '~/components/ui/badge'
import { opQuery, useOp } from '~/lib/forge'

export const Route = createFileRoute('/status')({
  head: () => ({ meta: [{ title: 'Status · cobalt' }] }),
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(opQuery('status.get', {})),
  component: Status,
})

type State = StatusReport['state']
type Service = StatusReport['services'][number]

const tone: Record<State, { dot: string; label: string }> = {
  up: { dot: 'bg-success', label: 'Operational' },
  degraded: { dot: 'bg-warning', label: 'Degraded' },
  down: { dot: 'bg-danger', label: 'Down' },
}

/** One bar a day: no requests is gray, any failure amber, over 5% red. */
function Days({ days }: { days: Service['days'] }) {
  return (
    <div
      className="flex h-7 items-end gap-[2px]"
      role="img"
      aria-label="Last 90 days"
    >
      {days.map((d) => {
        const rate = d.requests ? d.errors / d.requests : 0
        const bad = rate > 0.05
        const some = d.errors > 0
        return (
          <span
            key={d.date}
            title={`${d.date}: ${d.requests} requests, ${d.errors} failed`}
            className={cn(
              'w-[3px] flex-1 rounded-[1px]',
              d.requests === 0
                ? 'bg-muted'
                : bad
                  ? 'bg-danger'
                  : some
                    ? 'bg-warning'
                    : 'bg-success/70',
            )}
            style={{ height: bad ? '55%' : some ? '75%' : '100%' }}
          />
        )
      })}
    </div>
  )
}

const months = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ')
const pad = (n: number) => String(n).padStart(2, '0')

/**
 * A moment as "Nov 23, 2026, 13:43 UTC". Built by hand, in UTC, so the
 * server's ICU and the browser's (and their time zones) write the same text
 * and hydration never sees two dates.
 */
const moment = (iso: string) => {
  const d = new Date(iso)
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
}

const day = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })

function Status() {
  const s = useOp('status.get', {})
  const affected = s.services.filter((x) => x.state !== 'up')
  const open = s.incidents.find((i) => i.state === 'open')
  const headline =
    s.state === 'up'
      ? 'All systems operational'
      : affected.length === 1
        ? `${affected[0].name} is ${affected[0].state === 'down' ? 'down' : 'degraded'}`
        : `${affected.length} services are affected`
  return (
    <div className="mx-auto max-w-3xl space-y-12">
      <header className="space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Status</h1>
        <div
          className={cn(
            'surface flex flex-wrap items-center gap-x-4 gap-y-3 rounded-2xl border p-5',
            s.state === 'up'
              ? 'bg-card'
              : s.state === 'down'
                ? 'border-danger/30 bg-danger/5'
                : 'border-warning/30 bg-warning/5',
          )}
        >
          {s.state === 'up' ? (
            <CheckCircleIcon className="size-6 shrink-0 text-success" />
          ) : (
            <ExclamationTriangleIcon
              className={cn(
                'size-6 shrink-0',
                s.state === 'down' ? 'text-danger' : 'text-warning',
              )}
            />
          )}
          <div className="min-w-0 flex-1 basis-64 space-y-0.5">
            <h2 className="font-medium">{headline}</h2>
            <p className="text-sm text-muted-foreground">
              {s.state === 'up'
                ? 'Your repositories, history and releases are safe on cobalt whatever other hosts do.'
                : 'Everything else is working. Your repositories, history and releases are safe on cobalt whatever other hosts do.'}
            </p>
            {open && (
              <p className="text-sm">
                <a
                  href="#incidents"
                  className="font-medium underline decoration-border underline-offset-4 hover:decoration-foreground"
                >
                  {open.title}
                </a>
              </p>
            )}
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Measured by this server from its own answers since {moment(s.since)}.
          It holds {s.counts.repositories.toLocaleString('en')} repositories,{' '}
          {s.counts.changes.toLocaleString('en')} changes and{' '}
          {s.counts.issues.toLocaleString('en')} issues.
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Services</h2>
        <ul className="surface divide-y overflow-hidden rounded-2xl border bg-card">
          {s.services.map((x) => (
            <li
              key={x.id}
              className={cn(
                'space-y-3 p-5',
                x.state !== 'up' && 'bg-warning/5',
              )}
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{x.name}</div>
                  <div className="text-sm text-muted-foreground">
                    {x.detail ?? x.note}
                  </div>
                </div>
                <span className="text-xs text-muted-foreground tabular-nums max-sm:order-last max-sm:w-full sm:text-right">
                  {x.uptime !== null && <div>{x.uptime}% up</div>}
                  {x.p50_ms !== null && (
                    <div>
                      {x.p50_ms} ms median · {x.p95_ms} ms p95
                    </div>
                  )}
                </span>
                <span className="inline-flex items-center gap-1.5 text-sm">
                  <span
                    className={cn('size-2 rounded-full', tone[x.state].dot)}
                  />
                  {tone[x.state].label}
                </span>
              </div>
              {x.days.length > 0 && (
                <>
                  <Days days={x.days} />
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>90 days ago</span>
                    <span>
                      {x.requests.toLocaleString('en')} requests,{' '}
                      {x.errors.toLocaleString('en')} failed
                    </span>
                    <span>Today</span>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section id="incidents" className="scroll-mt-header space-y-3">
        <h2 className="text-sm font-medium">Recent incidents</h2>
        {s.incidents.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            None since this server started measuring.
          </p>
        ) : (
          <ul className="space-y-4">
            {s.incidents.map((i) => (
              <li
                key={`${i.service}-${i.date}-${i.title}`}
                className="flex gap-4"
              >
                <span className="w-14 shrink-0 pt-0.5 text-sm text-muted-foreground">
                  {day(i.date)}
                </span>
                <div className="space-y-1">
                  <div className="flex items-center gap-2 font-medium">
                    {i.title}
                    <Badge
                      tone={i.state === 'resolved' ? 'success' : 'warning'}
                    >
                      {i.state === 'resolved' ? 'Resolved' : 'Open'}
                    </Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">{i.detail}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
