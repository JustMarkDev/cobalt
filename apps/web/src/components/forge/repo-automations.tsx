import { useSuspenseQueries } from '@tanstack/react-query'
import {
  HardDrivesIcon,
  LightningIcon,
  WarningIcon,
} from '@phosphor-icons/react'
import { Chip, EmptyState, Panel, SectionLabel } from './bits'
import type { Repo } from '~/lib/model/data'
import { opQuery, useOp, useOpMaybe } from '~/lib/forge'
import { timeAgo } from '~/lib/repo'

export function AutomationsPage({ repo }: { repo: Repo }) {
  const t = useOp('triggers.list', { owner: repo.owner, repo: repo.name })
  return (
    <div className="space-y-6">
      <div className="mb-6 space-y-1">
        <h2 className="text-lg font-semibold tracking-tight">Automations</h2>
        <p className="max-w-[60ch] text-sm text-muted-foreground">
          What starts a workflow when something happens, from{' '}
          <code>{t.path}/*.yml</code> on the default branch. Edit those files in
          a change; they are read when it lands. At most 20 triggers, at most 3
          runs for one event, and no trigger on a pipeline event.
        </p>
      </div>
      {t.errors.length > 0 && (
        <Panel className="space-y-2 border-warning/40 p-4 text-sm">
          <p className="flex items-center gap-2 font-medium">
            <WarningIcon className="size-4 text-warning" />
            The newest trigger files did not read. The triggers below are the
            last ones that did.
          </p>
          <ul className="space-y-1 font-mono text-xs">
            {t.errors.map((e, i) => (
              <li key={i}>
                {e.file}
                {e.line ? `:${e.line}` : ''} {e.path && `${e.path}: `}
                {e.message}
              </li>
            ))}
          </ul>
        </Panel>
      )}
      {t.triggers.length === 0 ? (
        <EmptyState title="No triggers">
          Add a file such as <code>{t.path}/ci.yml</code> in a change. Its
          triggers start once it lands.
        </EmptyState>
      ) : (
        <Panel as="div" className="divide-y">
          {t.triggers.map((x) => (
            <div key={x.id} className="flex items-start gap-3 p-4 text-sm">
              <LightningIcon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{x.id}</span>
                  {x.on.map((e) => (
                    <Chip key={e} tone="info">
                      {e}
                    </Chip>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  Runs <code>{x.action.run}</code>
                  {x.filter.paths &&
                    ` when it touches ${x.filter.paths.join(', ')}`}
                  {x.filter.labels &&
                    `, labelled ${x.filter.labels.join(' or ')}`}
                  {x.filter.actor && `, by ${x.filter.actor.join(' or ')}`}
                  {x.filter.model &&
                    `, made with ${x.filter.model.join(' or ')}`}
                </p>
                <a
                  href={x.html_url}
                  className="font-mono text-xs text-muted-foreground underline underline-offset-4"
                >
                  {x.file}
                </a>
              </div>
            </div>
          ))}
        </Panel>
      )}
      {t.recent.length > 0 && (
        <section className="space-y-3">
          <SectionLabel>Lately</SectionLabel>
          <Panel as="div" className="divide-y text-sm">
            {t.recent.map((r, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2 p-3">
                <span className="font-medium">{r.trigger}</span>
                <Chip
                  tone={
                    r.state === 'started'
                      ? 'success'
                      : r.state === 'failed'
                        ? 'danger'
                        : 'warning'
                  }
                >
                  {r.state}
                </Chip>
                {r.run !== null && <span>run #{r.run}</span>}
                {r.error && (
                  <span className="text-muted-foreground">{r.error}</span>
                )}
                <span className="ml-auto text-xs text-muted-foreground">
                  {timeAgo(r.at)}
                </span>
              </div>
            ))}
          </Panel>
        </section>
      )}
    </div>
  )
}

export function RepoRunnersPage({ repo }: { repo: Repo }) {
  const all = useOpMaybe('runners.list', { account: repo.owner })
  const queued = useOp('pipelines.list', {
    owner: repo.owner,
    repo: repo.name,
    status: 'queued',
    limit: 5,
  }).data
  const details = useSuspenseQueries({
    queries: queued.map((r) =>
      opQuery('pipelines.get', {
        owner: repo.owner,
        repo: repo.name,
        run: r.number,
      }),
    ),
  }).map((q) => q.data)
  const full = `${repo.owner}/${repo.name}`.toLowerCase()
  const serving = (all?.data ?? []).filter(
    (r) => r.status !== 'disabled' && (!r.repos || r.repos.includes(full)),
  )
  const offered = [...new Set(serving.flatMap((r) => r.labels))].sort()
  const missing = new Map<string, Array<number>>()
  for (const d of details)
    for (const j of d.jobs ?? [])
      if (j.waiting_for_labels) {
        const key = j.waiting_for_labels.join(', ')
        missing.set(key, [...(missing.get(key) ?? []), d.number])
      }
  return (
    <div className="space-y-6">
      <div className="mb-6 space-y-1">
        <h2 className="text-lg font-semibold tracking-tight">Runners</h2>
        <p className="max-w-[60ch] text-sm text-muted-foreground">
          The machines that may take this repository&apos;s jobs. A job goes to
          a runner whose labels include every label its <code>runs-on</code>{' '}
          asks for. Register runners in account settings.
        </p>
      </div>
      {[...missing].map(([labels, runs]) => (
        <Panel
          key={labels}
          className="flex items-start gap-2 border-warning/40 p-4 text-sm"
        >
          <WarningIcon className="mt-0.5 size-4 shrink-0 text-warning" />
          <span>
            No runner offers <code>{labels}</code>, so{' '}
            {runs.map((n) => `#${n}`).join(', ')} wait
            {runs.length === 1 ? 's' : ''} for one.
          </span>
        </Panel>
      ))}
      {all === null ? (
        <p className="text-sm text-muted-foreground">
          Only members of {repo.owner} see its runners.
        </p>
      ) : serving.length === 0 ? (
        <EmptyState title="No runner serves this repository">
          Jobs that ask for no labels can still be taken by a runner you start
          by name. Register one in account settings to route jobs by label.
        </EmptyState>
      ) : (
        <>
          <p className="text-sm">
            <span className="text-muted-foreground">Labels offered: </span>
            <span className="font-mono text-xs">
              {offered.join(', ') || 'none'}
            </span>
          </p>
          <Panel as="div" className="divide-y">
            {serving.map((r) => (
              <div key={r.id} className="flex items-start gap-3 p-4 text-sm">
                <HardDrivesIcon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{r.name}</span>
                    <Chip tone={r.status === 'online' ? 'success' : 'muted'}>
                      {r.status}
                    </Chip>
                    {r.provider && <Chip tone="info">{r.provider}</Chip>}
                  </div>
                  <p className="font-mono text-xs text-muted-foreground">
                    {r.labels.join(', ') || 'no labels'}
                  </p>
                </div>
              </div>
            ))}
          </Panel>
        </>
      )}
    </div>
  )
}
