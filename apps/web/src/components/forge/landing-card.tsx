import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { Chip, Panel } from './bits'
import { StateIcon } from './status-card'
import { opQuery, useOpMaybe } from '~/lib/forge'
import { followedOperation } from '~/lib/landing-state'
import type { LandingAsk } from '~/lib/landing-state'

const started = new Map<string, string>()
const listeners = new Set<() => void>()
const keyOf = (at: { owner: string; repo: string; number: string }) =>
  `${at.owner}/${at.repo}#${at.number}`

export function rememberLanding(
  at: { owner: string; repo: string; number: string },
  id: string,
) {
  started.set(keyOf(at), id)
  for (const f of listeners) f()
}

function useStarted(at: { owner: string; repo: string; number: string }) {
  return React.useSyncExternalStore(
    (f) => {
      listeners.add(f)
      return () => listeners.delete(f)
    },
    () => started.get(keyOf(at)) ?? null,
    () => null,
  )
}

export function useLandingOperation(
  at: { owner: string; repo: string; number: string },
  ask: LandingAsk,
) {
  const operation = followedOperation(ask, useStarted(at))
  const op = useQuery({
    ...opQuery('operations.get', { id: operation ?? '' }),
    enabled: !!operation,
    refetchInterval: (q) => {
      const state = (q.state.data as { state?: string } | undefined)?.state
      return state === 'succeeded' || state === 'failed' ? false : 1000
    },
  }).data
  return { operation, op: operation ? op : undefined }
}

export function LandingCard({
  at,
  landed,
  sha,
  operation,
  op,
}: {
  at: { owner: string; repo: string; number: string }
  landed: boolean
  sha: string
  operation: string | null
  op: ReturnType<typeof useLandingOperation>['op']
}) {
  const l = useOpMaybe('changes.landability', at)
  if (op && operation) return <OperationSteps op={op} />
  if (!l) return null
  const waits = new Map(l.blockers.map((b) => [b.id, b]))
  const steps = (landed ? [] : l.landing.steps).flatMap((s) =>
    'wait_checks' in s
      ? (s.wait_checks as Array<string>).map((name) => {
          const b = waits.get(`landing:wait_checks:${name}`)
          return {
            key: `wait:${name}`,
            label: `Wait for ${name}`,
            state: landed ? ('pass' as const) : (b?.state ?? ('pass' as const)),
            detail: landed
              ? 'Passed before landing.'
              : (b?.detail ?? `${name} passed.`),
          }
        })
      : [
          {
            key: JSON.stringify(s),
            label:
              'run_pipeline' in s
                ? `Run ${String(s.run_pipeline)}`
                : `Call ${new URL(String(s.webhook)).host}`,
            state: landed ? ('pass' as const) : ('pending' as const),
            detail: landed ? 'Ran after landing.' : 'Runs after it lands.',
          },
        ],
  )
  const policy = l.blockers.filter((b) => !b.id.startsWith('landing:'))
  return (
    <Panel className="space-y-3 p-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Landing</span>
        <Chip tone="outline">{l.landing.strategy}</Chip>
        {l.landing.fresh_approvals && <Chip tone="muted">fresh approvals</Chip>}
        {l.verification && (
          <Chip
            tone={
              l.verification.state === 'failed'
                ? 'danger'
                : l.verification.state === 'passed'
                  ? 'success'
                  : 'muted'
            }
          >
            {l.verification.state === 'failed'
              ? `verification failed: ${l.verification.checks
                  .filter((c) => c.state === 'fail')
                  .map((c) => c.name)
                  .join(', ')}`
              : l.verification.state === 'passed'
                ? 'verified'
                : 'verifies after landing'}
          </Chip>
        )}
        <span className="ml-auto">
          {landed ? (
            <Chip tone="merged">landed</Chip>
          ) : l.landable ? (
            <Chip tone="success">ready</Chip>
          ) : (
            <Chip tone="warning">{l.blockers.length} in the way</Chip>
          )}
        </span>
      </div>
      <ol className="space-y-2">
        <Step
          label="Policy"
          state={
            landed || !policy.length
              ? 'pass'
              : policy.some((b) => b.state === 'fail')
                ? 'fail'
                : 'pending'
          }
          detail={
            landed || !policy.length
              ? 'Every requirement holds.'
              : policy.map((b) => b.detail).join(' ')
          }
        />
        {steps.map((s) => (
          <Step key={s.key} label={s.label} state={s.state} detail={s.detail} />
        ))}
        <Step
          label={landed ? 'Landed' : 'Lands'}
          state={landed ? 'pass' : 'pending'}
          detail={
            landed
              ? `As ${sha.slice(0, 7)}, tree ${l.tree}.`
              : `Tree ${l.tree}, patch set ${l.patch_set}.`
          }
        />
      </ol>
    </Panel>
  )
}

function Step({
  label,
  state,
  detail,
}: {
  label: string
  state: 'pass' | 'fail' | 'pending' | 'na'
  detail: string
}) {
  return (
    <li className="flex gap-2">
      <StateIcon state={state} />
      <div className="min-w-0">
        <p className="font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{detail}</p>
      </div>
    </li>
  )
}

function OperationSteps({
  op,
}: {
  op: {
    state: string
    steps: Array<{ name: string; state: string; detail: string }>
    error: Record<string, unknown> | null
  }
}) {
  const icon = (s: string) =>
    s === 'succeeded'
      ? ('pass' as const)
      : s === 'failed'
        ? ('fail' as const)
        : s === 'skipped'
          ? ('na' as const)
          : ('pending' as const)
  return (
    <Panel className="space-y-3 p-4 text-sm">
      <div className="flex items-center gap-2">
        <span className="font-medium">Landing</span>
        <span className="ml-auto">
          <Chip
            tone={
              op.state === 'succeeded'
                ? 'merged'
                : op.state === 'failed'
                  ? 'danger'
                  : 'info'
            }
          >
            {op.state === 'succeeded'
              ? 'landed'
              : op.state === 'failed'
                ? 'stopped'
                : 'running'}
          </Chip>
        </span>
      </div>
      <ol className="space-y-2">
        {op.steps.map((s) => (
          <Step
            key={s.name}
            label={s.name}
            state={icon(s.state)}
            detail={
              s.detail || (s.state === 'running' ? 'Running…' : 'Waiting.')
            }
          />
        ))}
      </ol>
    </Panel>
  )
}
