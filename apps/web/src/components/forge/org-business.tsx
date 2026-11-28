import * as React from 'react'
import { useMutation, usePaginatedQuery, useQuery } from 'convex/react'
import { Link } from '@tanstack/react-router'
import { api } from '../../../../../convex/_generated/api'
import { Billing } from '~/components/forge/account-data'
import { CheckoutButton, useEurope } from '~/components/forge/checkout-button'
import { Button } from '~/components/ui/button'
import { Callout } from '~/components/ui/callout'
import { Field, Input } from '~/components/ui/input'
import { Select, SelectItem } from '~/components/ui/select'
import { Segmented } from '~/components/ui/tabs'
import type { Role } from '~/lib/auth/accounts'
import {
  YEARLY_MONTHS,
  money,
  organizationPlans,
  planName,
  price,
  size,
} from '~/lib/pricing'

const card = 'space-y-4 surface rounded-2xl border bg-card p-5'

type OrgPlanData = {
  handle: string
  manage: boolean
  plan: 'free' | 'solo' | 'team' | 'business'
  source: 'free' | 'subscription' | 'grant'
  until: number | null
  unlimited: boolean
  seats: number
  members: number
  limits: { storageGb: number; transferGb: number } | null
  usage: { storageBytes: number; transferBytes: number }
}

function useOrgPlan(handle: string): OrgPlanData | undefined {
  const raw = useQuery(api.plans.ofOrganization, { handle })
  return React.useMemo(
    () => (raw ? (JSON.parse(raw) as OrgPlanData) : undefined),
    [raw],
  )
}

const used = (bytes: number) => size(bytes / 1_000_000_000)

function message(e: unknown): string {
  const d = (e as { data?: { detail?: unknown } }).data
  return typeof d?.detail === 'string'
    ? d.detail
    : 'That did not work. Try again in a moment.'
}

export type Choice = {
  plan: 'team' | 'business'
  seats: number
  cycle: 'month' | 'year'
}

export function OrgPlan({
  handle,
  choice,
}: {
  handle: string
  choice: Partial<Choice>
}) {
  const data = useOrgPlan(handle)
  if (!data) return <p className="text-sm text-muted-foreground">Loading…</p>
  const paying = data.source === 'subscription'
  return (
    <div className="space-y-6">
      <section className={card}>
        <div className="flex items-baseline justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">{planName(data.plan)}</h2>
            <p className="text-sm text-muted-foreground">
              {data.unlimited
                ? 'No limits. Given to this organization with no end date.'
                : data.source === 'grant' && data.until
                  ? `Given to this organization until ${new Date(data.until).toLocaleDateString('en', { dateStyle: 'long' })}.`
                  : paying
                    ? `${data.seats} ${data.seats === 1 ? 'seat' : 'seats'} for ${data.members} ${data.members === 1 ? 'member' : 'members'}.`
                    : 'Public repositories only.'}
            </p>
          </div>
          {paying && data.manage && <Billing account={handle} />}
        </div>
        <dl className="well space-y-2 rounded-xl border bg-muted/60 p-4 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Storage</dt>
            <dd className="font-medium">
              {data.limits
                ? `${used(data.usage.storageBytes)} of ${size(data.limits.storageGb)}`
                : `${used(data.usage.storageBytes)}, no limit`}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Transfer out</dt>
            <dd className="font-medium">
              {data.limits
                ? `${used(data.usage.transferBytes)} of ${size(data.limits.transferGb)} this month`
                : `${used(data.usage.transferBytes)} this month, no limit`}
            </dd>
          </div>
        </dl>
        {paying && data.manage && data.seats < data.members && (
          <Callout tone="warning">
            {data.members} people belong here and the plan has {data.seats}{' '}
            seats. Add seats from Manage billing.
          </Callout>
        )}
      </section>
      {!paying &&
        (data.manage ? (
          <Choose handle={handle} members={data.members} choice={choice} />
        ) : (
          <p className="text-sm text-muted-foreground">
            Only an owner can choose a plan for this organization.
          </p>
        ))}
    </div>
  )
}

function Choose({
  handle,
  members,
  choice,
}: {
  handle: string
  members: number
  choice: Partial<Choice>
}) {
  const [plan, setPlan] = React.useState<Choice['plan']>(choice.plan ?? 'team')
  const [cycle, setCycle] = React.useState<Choice['cycle']>(
    choice.cycle ?? 'year',
  )
  const [seats, setSeats] = React.useState(
    Math.max(members, choice.seats ?? members),
  )
  const currency = useEurope() ? '€' : '$'
  const p = organizationPlans.find((x) => x.id === plan)!
  const one = price(p, cycle)
  return (
    <section className={card}>
      <h2 className="text-lg font-semibold">Choose a plan</h2>
      <div className="flex flex-wrap gap-3">
        <Segmented
          label="Plan"
          value={plan}
          onChange={setPlan}
          options={organizationPlans.map((x) => [
            x.id as Choice['plan'],
            x.name,
          ])}
        />
        <Segmented
          label="Billing"
          value={cycle}
          onChange={setCycle}
          options={[
            ['year', 'Yearly'],
            ['month', 'Monthly'],
          ]}
        />
      </div>
      <Field
        label="Seats"
        hint={`At least one for each of the ${members} ${members === 1 ? 'member' : 'members'}, people and agents alike.`}
      >
        <Input
          type="number"
          min={members}
          max={500}
          value={seats}
          onChange={(e) =>
            setSeats(Math.min(500, Math.max(members, Number(e.target.value))))
          }
          className="w-28"
        />
      </Field>
      <p className="text-sm">
        <span className="text-2xl font-semibold tabular-nums">
          {money(one.total * seats, currency)}
        </span>{' '}
        <span className="text-muted-foreground">
          / {cycle === 'year' ? 'year' : 'month'}, for{' '}
          {size(p.limits.storageGb * seats)} and{' '}
          {size(p.limits.transferGb * seats)} of transfer a month
          {cycle === 'year' &&
            `. ${YEARLY_MONTHS} months for 12, you save ${money(p.monthly * (12 - YEARLY_MONTHS) * seats, currency)}`}
        </span>
      </p>
      <CheckoutButton
        plan={plan}
        cycle={cycle}
        account={handle}
        seats={seats}
        variant="brand"
      >
        Continue to payment
      </CheckoutButton>
    </section>
  )
}

function NeedsBusiness({ handle, what }: { handle: string; what: string }) {
  return (
    <Callout tone="info" title="This is part of Business">
      {what}{' '}
      <Link
        to="/organizations/$handle/$section"
        params={{ handle, section: 'plan' }}
        className="underline underline-offset-4"
      >
        See the plan
      </Link>
    </Callout>
  )
}

const kinds = {
  path_approval: 'Approvals on paths',
  required_check: 'A check must pass',
  max_lines: 'At most so many lines',
  allowed_paths: 'Only these paths',
} as const
type Kind = keyof typeof kinds

const list = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)

export function OrgPolicies({ handle }: { handle: string }) {
  const data = useQuery(api.forge.orgPolicy.get, { org: handle })
  const remove = useMutation(api.forge.orgPolicy.removeRule)
  const [error, setError] = React.useState('')
  if (!data) return <p className="text-sm text-muted-foreground">Loading…</p>
  return (
    <div className="space-y-6">
      {!data.business && (
        <NeedsBusiness
          handle={handle}
          what="Set rules once and they apply to every repository here, or only to some teams' repositories. A repository adds its own, but cannot turn these off."
        />
      )}
      <section className={card}>
        <div>
          <h2 className="text-lg font-semibold">Rules for every repository</h2>
          <p className="text-sm text-muted-foreground">
            They join each repository&rsquo;s own rules. A repository cannot
            turn them off or make exceptions to them.
          </p>
        </div>
        {data.rules.length === 0 ? (
          <p className="text-sm text-muted-foreground">No rules yet.</p>
        ) : (
          <ul className="divide-y rounded-xl border">
            {data.rules.map((r) => (
              <li
                key={r.id}
                className="flex items-start justify-between gap-4 p-4 text-sm"
              >
                <div className="space-y-1">
                  <p className="font-medium">{r.name}</p>
                  <p className="text-muted-foreground">
                    {r.when === 'any change' ? 'Any change' : r.when}:{' '}
                    {r.requires.join(', ')}.{' '}
                    {r.teams.length
                      ? `Repositories of ${r.teams.join(', ')}.`
                      : 'Every repository.'}
                  </p>
                  <p className="font-mono text-xs text-muted-foreground">
                    {r.id}
                  </p>
                </div>
                {data.canEdit && data.business && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      void remove({ org: handle, id: r.id }).catch((e) =>
                        setError(message(e)),
                      )
                    }
                  >
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {error && <p className="text-sm text-danger">{error}</p>}
      </section>
      {data.canEdit && data.business && <NewRule handle={handle} />}
    </div>
  )
}

function NewRule({ handle }: { handle: string }) {
  const set = useMutation(api.forge.orgPolicy.setRule)
  const [kind, setKind] = React.useState<Kind>('path_approval')
  const [f, setF] = React.useState({
    id: '',
    name: '',
    paths: '',
    approvals: '1',
    check: '',
    maxLines: '400',
    teams: '',
  })
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const on = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setF({ ...f, [k]: e.target.value })
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await set({
        org: handle,
        id: f.id.trim(),
        name: f.name.trim(),
        kind,
        ...(kind === 'required_check' ? { check: f.check.trim() } : {}),
        ...(kind === 'path_approval' || kind === 'allowed_paths'
          ? { paths: list(f.paths) }
          : {}),
        ...(kind === 'path_approval'
          ? { approvals: Number(f.approvals) || 1 }
          : {}),
        ...(kind === 'max_lines' ? { max_lines: Number(f.maxLines) } : {}),
        teams: list(f.teams),
      })
      setF({ ...f, id: '', name: '' })
    } catch (err) {
      setError(message(err))
    }
    setBusy(false)
  }
  return (
    <form onSubmit={(e) => void submit(e)} className={card} noValidate>
      <h2 className="text-lg font-semibold">Add a rule</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name">
          <Input
            value={f.name}
            onChange={on('name')}
            placeholder="Two approvals on the API"
          />
        </Field>
        <Field label="Id" hint="Lowercase letters, digits and dashes.">
          <Input value={f.id} onChange={on('id')} placeholder="api-reviews" />
        </Field>
        <Field label="Kind">
          <Select
            aria-label="Kind of rule"
            value={kind}
            onValueChange={(v) => setKind(v as Kind)}
          >
            {(Object.keys(kinds) as Array<Kind>).map((k) => (
              <SelectItem key={k} value={k}>
                {kinds[k]}
              </SelectItem>
            ))}
          </Select>
        </Field>
        {(kind === 'path_approval' || kind === 'allowed_paths') && (
          <Field label="Paths" hint="Globs, separated by commas.">
            <Input
              value={f.paths}
              onChange={on('paths')}
              placeholder="api/**, db/**"
            />
          </Field>
        )}
        {kind === 'path_approval' && (
          <Field label="Approvals">
            <Input
              type="number"
              min={1}
              max={10}
              value={f.approvals}
              onChange={on('approvals')}
            />
          </Field>
        )}
        {kind === 'required_check' && (
          <Field label="Check">
            <Input
              value={f.check}
              onChange={on('check')}
              placeholder="ci/test"
            />
          </Field>
        )}
        {kind === 'max_lines' && (
          <Field label="Lines">
            <Input
              type="number"
              min={1}
              value={f.maxLines}
              onChange={on('maxLines')}
            />
          </Field>
        )}
        <Field
          label="Teams"
          hint="Leave empty for every repository. Team slugs, separated by commas."
        >
          <Input value={f.teams} onChange={on('teams')} placeholder="web" />
        </Field>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      <Button type="submit" variant="brand" disabled={busy}>
        {busy ? 'Saving…' : 'Add rule'}
      </Button>
    </form>
  )
}

const actionText: Record<string, string> = {
  'organization.created': 'created the organization',
  'organization.updated': 'changed the organization',
  'member.added': 'added a member',
  'member.role_changed': 'changed the role of',
  'member.removed': 'removed a member',
  'invitation.sent': 'invited',
  'invitation.revoked': 'revoked the invitation of',
  'invitation.accepted': 'joined',
  'team.created': 'created the team',
  'team.updated': 'changed the team',
  'team.deleted': 'deleted the team',
  'team.member_added': 'added someone to',
  'team.member_removed': 'removed someone from',
  'team.repo_added': 'gave a repository to',
  'team.repo_removed': 'took a repository from',
  'repo.created': 'created',
  'repo.updated': 'changed',
  'repo.deleted': 'deleted',
  'repo.policy_changed': 'changed the policy of',
  'policy.rule_set': 'set the organization rule',
  'policy.rule_removed': 'removed the organization rule',
  'plan.changed': 'changed the plan of',
}

function detailText(detail: string | null): string {
  if (!detail) return ''
  try {
    return Object.entries(JSON.parse(detail) as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)
      .join('; ')
  } catch {
    return ''
  }
}

function csvCell(s: string) {
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}

export function OrgAudit({ handle, role }: { handle: string; role: Role }) {
  const plan = useOrgPlan(handle)
  const [at] = React.useState(() => Date.now())
  const allowed = plan?.plan === 'business' && role !== 'member'
  const { results, status, loadMore } = usePaginatedQuery(
    api.forge.audit.list,
    allowed ? { org: handle, at } : 'skip',
    { initialNumItems: 50 },
  )
  if (!plan) return <p className="text-sm text-muted-foreground">Loading…</p>
  if (role === 'member')
    return (
      <p className="text-sm text-muted-foreground">
        Only owners and admins read the audit log.
      </p>
    )
  if (plan.plan !== 'business')
    return (
      <NeedsBusiness
        handle={handle}
        what="See who changed members, teams, repositories, policies and the plan, for the last year, and download it."
      />
    )
  const download = () => {
    const rows = [
      ['time', 'actor', 'via', 'action', 'target', 'detail'],
      ...results.map((e) => [
        new Date(e.at).toISOString(),
        e.actor,
        e.via ?? '',
        e.action,
        e.target,
        e.detail ?? '',
      ]),
    ]
    const blob = new Blob(
      [rows.map((r) => r.map(csvCell).join(',')).join('\n')],
      {
        type: 'text/csv',
      },
    )
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${handle}-audit-log.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }
  return (
    <section className={card}>
      <div className="flex items-baseline justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Audit log</h2>
          <p className="text-sm text-muted-foreground">
            The last year, newest first.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={download}
          disabled={!results.length}
        >
          Download CSV
        </Button>
      </div>
      {results.length === 0 && status !== 'LoadingFirstPage' ? (
        <p className="text-sm text-muted-foreground">Nothing yet.</p>
      ) : (
        <ol className="divide-y rounded-xl border text-sm">
          {results.map((e) => (
            <li key={e.id} className="flex flex-wrap gap-x-3 gap-y-1 p-3">
              <time
                dateTime={new Date(e.at).toISOString()}
                className="w-40 shrink-0 text-muted-foreground tabular-nums"
              >
                {new Date(e.at).toLocaleString('en', {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}
              </time>
              <span className="min-w-0 flex-1">
                <span className="font-medium">{e.actor}</span>
                {e.via && (
                  <span className="text-muted-foreground"> via {e.via}</span>
                )}{' '}
                {actionText[e.action] ?? e.action}{' '}
                <span className="font-medium">{e.target}</span>
                {detailText(e.detail) && (
                  <span className="block text-muted-foreground">
                    {detailText(e.detail)}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
      {status === 'CanLoadMore' && (
        <Button variant="outline" size="sm" onClick={() => loadMore(100)}>
          Load more
        </Button>
      )}
    </section>
  )
}
