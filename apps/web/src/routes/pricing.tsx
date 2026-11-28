import * as React from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { cn } from 'cn'
import type { Plan } from '~/lib/pricing'
import { CheckoutButton, useEurope } from '~/components/forge/checkout-button'
import { ContactSales } from '~/components/forge/contact-sales'
import { Button } from '~/components/ui/button'
import { Segmented } from '~/components/ui/tabs'
import {
  YEARLY_MONTHS,
  freeLimits,
  money,
  organizationPlans,
  personalPlans,
  price,
  size,
} from '~/lib/pricing'

export const Route = createFileRoute('/pricing')({
  head: () => ({ meta: [{ title: 'Pricing · cobalt' }] }),
  component: Pricing,
})

type Cycle = 'month' | 'year'
type Who = 'personal' | 'organization'

const businessAdds = [
  'An audit log of who changed what, kept for a year',
  'Policies set once for every repository',
]

const reasons: Array<[string, string]> = [
  [
    'We do not resell compute or tokens',
    'There are no CI minutes or AI credits in these plans, and none to run out of. Run your pipelines on any runner and your agents on any model, and pay those providers directly, without our markup on top.',
  ],
  [
    'Agents work here the way people do',
    'An agent signs in, takes a seat, opens changes and waits for the same approvals and policies as everyone else. The CLI, the MCP server and the agent skill come with every plan, Free included.',
  ],
  [
    'Your history always lives somewhere else too',
    'Every plan mirrors to as many hosts as you like, with no limit. If you leave, or we go away, a full copy of every repository is already on GitHub, GitLab or wherever you chose.',
  ],
]

const questions: Array<[string, string]> = [
  [
    'Can I keep private repositories on Free?',
    `Yes, on your own account, as long as everything fits in ${size(freeLimits.storageGb)}. An organization needs Team or Business for private repositories; on Free it can host public ones.`,
  ],
  [
    'Who needs a seat?',
    'Everyone who belongs to an organization on Team or Business, people and agents alike. You choose how many seats to buy, and storage and transfer grow with them, shared by the whole organization.',
  ],
  [
    'My team is small but has a large codebase. What should we pick?',
    `Business. A seat on Business comes with ${size(organizationPlans[1].limits.storageGb)} instead of ${size(organizationPlans[0].limits.storageGb)}, so two people with a big repository do not have to buy seats they do not use.`,
  ],
  [
    'What counts as transfer?',
    'Data leaving cobalt: clones, fetches and mirror pushes. Release downloads do not count.',
  ],
  [
    'What happens if I go over?',
    'On Free, pushes pause until you make room; nothing is deleted. On a paid plan nothing stops.',
  ],
  [
    'Which currency will I pay in?',
    'Euros in Europe, at the same number as in dollars, and dollars everywhere else. Prices exclude tax.',
  ],
  [
    'What happens if I stop paying?',
    'You move to Free. Your history stays readable, cloneable and exportable for 90 days, and we tell you before anything is deleted. Mirrors on other hosts keep their copy.',
  ],
]

function Pricing() {
  const [who, setWho] = React.useState<Who>('personal')
  const [cycle, setCycle] = React.useState<Cycle>('year')
  const [seats, setSeats] = React.useState(3)
  const currency = useEurope() ? '€' : '$'
  return (
    <div className="space-y-24">
      <header className="mx-auto max-w-2xl space-y-8 text-center">
        <h1 className="text-4xl font-semibold tracking-tight text-balance">
          Start free. Pay as your code and your team grow.
        </h1>
        <div className="flex flex-wrap justify-center gap-3">
          <Segmented
            label="Who the plans are for"
            value={who}
            onChange={setWho}
            options={[
              ['personal', 'Personal'],
              ['organization', 'Organizations'],
            ]}
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
      </header>

      <section className="-mt-12 space-y-6">
        {who === 'personal' ? (
          <div className="mx-auto grid max-w-3xl grid-cols-1 gap-5 md:grid-cols-2">
            <FreeCard currency={currency} />
            {personalPlans.map((p) => (
              <PaidCard
                key={p.id}
                plan={p}
                cycle={cycle}
                seats={1}
                currency={currency}
                onYearly={() => setCycle('year')}
              />
            ))}
          </div>
        ) : (
          <>
            <Seats seats={seats} onChange={setSeats} />
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
              {organizationPlans.map((p) => (
                <PaidCard
                  key={p.id}
                  plan={p}
                  cycle={cycle}
                  seats={seats}
                  currency={currency}
                  onYearly={() => setCycle('year')}
                />
              ))}
              <EnterpriseCard />
            </div>
          </>
        )}
        <p className="mx-auto max-w-[68ch] text-center text-sm text-balance text-muted-foreground">
          A year is {YEARLY_MONTHS} months for 12. Prices exclude tax.
        </p>
      </section>

      <section className="grid grid-cols-1 gap-x-10 gap-y-8 md:grid-cols-3">
        <h2 className="text-2xl font-semibold tracking-tight md:col-span-3">
          What the price pays for
        </h2>
        {reasons.map(([title, body]) => (
          <div key={title} className="space-y-2">
            <h3 className="font-medium">{title}</h3>
            <p className="text-sm text-muted-foreground">{body}</p>
          </div>
        ))}
      </section>

      <section className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <h2 className="text-2xl font-semibold tracking-tight">Questions</h2>
        <div className="surface divide-y overflow-hidden rounded-2xl border bg-card lg:col-span-2">
          {questions.map(([q, a]) => (
            <details key={q} className="group p-5">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium">
                {q}
                <span
                  aria-hidden
                  className="text-muted-foreground transition-transform group-open:rotate-45 motion-reduce:transition-none"
                >
                  +
                </span>
              </summary>
              <p className="mt-3 max-w-[65ch] text-sm text-muted-foreground">
                {a}
              </p>
            </details>
          ))}
        </div>
      </section>
    </div>
  )
}

const cardClass = (featured?: boolean) =>
  cn(
    'surface flex flex-col gap-6 rounded-2xl bg-card',
    featured
      ? 'border-2 border-brand-ink p-[calc(1.75rem-1px)] dark:border-brand/45'
      : 'border p-7',
  )

function Limits({
  rows,
  note,
}: {
  rows: Array<[string, string]>
  note?: string
}) {
  return (
    <div className="space-y-2">
      <dl className="well space-y-2 rounded-xl border bg-muted/60 p-4 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-4">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="text-right font-medium">{v}</dd>
          </div>
        ))}
      </dl>
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
    </div>
  )
}

function FreeCard({ currency }: { currency: '$' | '€' }) {
  return (
    <article className={cardClass()}>
      <h2 className="text-lg font-semibold">Free</h2>
      <div>
        <span className="text-5xl font-semibold tracking-tight">
          {currency}0
        </span>
        <p className="mt-2 text-sm text-muted-foreground">No card needed</p>
      </div>
      <Button
        size="lg"
        variant="outline"
        render={<Link to="/sign-up" />}
        nativeButton={false}
      >
        Sign up free
      </Button>
      <Limits
        rows={[
          ['Repositories', 'Public and private'],
          ['Storage', size(freeLimits.storageGb)],
          ['Transfer', `${size(freeLimits.transferGb)} a month`],
        ]}
      />
    </article>
  )
}

function PaidCard({
  plan,
  cycle,
  seats,
  currency,
  onYearly,
}: {
  plan: Plan
  cycle: Cycle
  seats: number
  currency: '$' | '€'
  onYearly: () => void
}) {
  const n = plan.perSeat ? seats : 1
  const one = price(plan, cycle)
  const total = one.total * n
  const saving = plan.monthly * (12 - YEARLY_MONTHS) * n
  return (
    <article className={cardClass(plan.featured)}>
      <h2 className="text-lg font-semibold">{plan.name}</h2>
      <div>
        <p className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-5xl font-semibold tracking-tight tabular-nums">
            {money(total, currency)}
          </span>
          <span className="text-sm text-muted-foreground">
            / {cycle === 'year' ? 'year' : 'month'}
          </span>
          {cycle === 'year' && (
            <s
              className="text-lg text-muted-foreground tabular-nums"
              aria-label={`instead of ${money(one.full * n, currency)}`}
            >
              {money(one.full * n, currency)}
            </s>
          )}
        </p>
        <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          {cycle === 'year' ? (
            <>
              <span className="rounded-full bg-success/12 px-2 py-0.5 text-xs font-semibold text-success">
                Save {money(saving, currency)}
              </span>
              {plan.perSeat
                ? `${money(one.total, currency)} per seat a year`
                : `${money(Math.round(one.monthly * 100) / 100, currency)} a month`}
            </>
          ) : (
            <>
              {plan.perSeat && `${money(one.total, currency)} per seat. `}
              <button
                type="button"
                onClick={onYearly}
                className="font-medium text-brand-ink underline-offset-4 hover:underline"
              >
                Save {money(saving, currency)} a year, paying yearly
              </button>
            </>
          )}
        </p>
      </div>
      {plan.id !== 'solo' ? (
        <Button
          size="lg"
          variant={plan.featured ? 'brand' : 'outline'}
          render={
            <Link
              to="/organizations/new"
              search={{ plan: plan.id, seats: n, cycle }}
            />
          }
          nativeButton={false}
        >
          Choose {plan.name}
        </Button>
      ) : (
        <CheckoutButton
          plan={plan.id}
          cycle={cycle}
          variant={plan.featured ? 'brand' : 'outline'}
        >
          Choose {plan.name}
        </CheckoutButton>
      )}
      <Limits
        rows={[
          ['Repositories', 'Public and private'],
          ['Storage', size(plan.limits.storageGb * n)],
          ['Transfer', `${size(plan.limits.transferGb * n)} a month`],
        ]}
        note={
          plan.perSeat
            ? `For ${n} ${n === 1 ? 'seat' : 'seats'}, shared by the whole organization.`
            : undefined
        }
      />
      {plan.id === 'business' && (
        <ul className="space-y-1.5 text-sm text-muted-foreground">
          {businessAdds.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      )}
    </article>
  )
}

function EnterpriseCard() {
  return (
    <article className={cardClass()}>
      <h2 className="text-lg font-semibold">Enterprise</h2>
      <p className="text-sm text-muted-foreground">
        Everything in Business, with room and seats priced for your volume, a
        yearly contract and invoices.
      </p>
      <div className="mt-auto">
        <ContactSales>Talk to us</ContactSales>
      </div>
    </article>
  )
}

function Seats({
  seats,
  onChange,
}: {
  seats: number
  onChange: (n: number) => void
}) {
  const set = (n: number) => onChange(Math.min(500, Math.max(1, n)))
  return (
    <div className="flex items-center justify-center gap-3">
      <label htmlFor="seats" className="text-sm text-muted-foreground">
        Seats
      </label>
      <div className="inline-flex items-center overflow-hidden rounded-xl border bg-card">
        <button
          type="button"
          aria-label="One seat fewer"
          onClick={() => set(seats - 1)}
          disabled={seats <= 1}
          className="grid size-10 place-items-center text-lg hover:bg-muted disabled:opacity-40"
        >
          −
        </button>
        <input
          id="seats"
          type="number"
          min={1}
          max={500}
          value={seats}
          onChange={(e) => set(Number(e.target.value) || 1)}
          className="w-14 bg-transparent text-center font-semibold tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
        />
        <button
          type="button"
          aria-label="One seat more"
          onClick={() => set(seats + 1)}
          className="grid size-10 place-items-center text-lg hover:bg-muted"
        >
          +
        </button>
      </div>
    </div>
  )
}
