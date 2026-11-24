import * as React from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { CheckIcon } from '@heroicons/react/24/outline'
import { cn } from 'cn'
import type { BrandId } from '~/components/brand'
import type { FreePlan, Plan } from '~/lib/pricing'
import { BrandLogo, brandName } from '~/components/brand'
import { CheckoutButton, useEurope } from '~/components/forge/checkout-button'
import { ContactSales } from '~/components/forge/contact-sales'
import { Button } from '~/components/ui/button'
import { Segmented } from '~/components/ui/tabs'
import { freePlan, overage, perMonth, perYear, plans } from '~/lib/pricing'

export const Route = createFileRoute('/pricing')({
  head: () => ({ meta: [{ title: 'Pricing · cobalt' }] }),
  component: Pricing,
})

const own: Array<{ title: string; body: string; names: Array<BrandId> }> = [
  {
    title: 'Runners',
    body: 'Run workflows on any runner you like.',
    names: ['blacksmith', 'namespace', 'depot', 'warpbuild'],
  },
  {
    title: 'Models and agents',
    body: 'Claude Code, Codex, OpenCode or your own. Your keys, your bill.',
    names: ['claudereview', 'bugbot', 'coderabbit', 'greptile', 'qodo'],
  },
  {
    title: 'Environments',
    body: 'Hand work to a machine you choose.',
    names: ['t3code', 'boat', 'e2b', 'daytona'],
  },
]

const questions: Array<[string, string]> = [
  [
    'Is there a free plan?',
    `Yes, and it does not expire. Free is for public repositories: ${size(freePlan.limits.storageGb)} of storage, ${size(freePlan.limits.transferGb)} of transfer a month and unlimited mirrors, with no card. Private repositories, agent access to secrets and more room need a paid plan.`,
  ],
  [
    'Is there a trial of the paid plans?',
    'No. Free is how you try cobalt. If you pay and it is not for you, you have the withdrawal period the law gives you where you live, and we refund it.',
  ],
  [
    'Why are there no CI minutes or AI credits?',
    'Because we would have to pick for you. cobalt works with any runner, model, harness and agent, and stays out of the way of the ones you already pay for. We never resell compute or tokens, so there is no markup and no credit to run out of.',
  ],
  [
    'What counts as transfer?',
    'Data leaving cobalt: clones, fetches and mirror pushes. Agents and CI clone a lot, so heavy automation uses more. Pushing data in has its own, smaller allowance. Release downloads do not count.',
  ],
  [
    'What happens if I go over?',
    `Nothing breaks. Extra storage is $${overage.storagePerGbMonth.toFixed(2)} per GB a month and extra transfer is $${overage.transferPerGb.toFixed(2)} per GB, billed after the month. You can set a cap.`,
  ],
  [
    'What happens to my history if I stop paying?',
    'Your account moves to Free. Your history stays readable, cloneable and exportable for 90 days, and we tell you before anything is deleted. Over the Free limits, pushes pause; going over never deletes anything. Mirrors on other hosts keep their copy.',
  ],
  [
    'Is there a self-hosted version?',
    'No. We do not offer or support a self-hosted version. Your repositories are plain git, and mirrors keep copies on other hosts, so you are never locked in.',
  ],
  [
    'Do agents cost extra?',
    'Agents use the same seats as people. What they cost to run is between you and the provider you chose. Their use of storage and transfer counts toward your allowance.',
  ],
]

function size(gb: number): string {
  return gb < 1 ? `${Math.round(gb * 1000)} MB` : `${gb} GB`
}

const isPaid = (p: Plan | FreePlan): p is Plan => p.id !== 'free'

function limitLines(plan: Plan | FreePlan): Array<[string, string]> {
  const l = plan.limits
  const unit = isPaid(plan) && plan.perSeat ? ' per seat' : ''
  return [
    ['Storage', `${size(l.storageGb)}${unit}`],
    ['Transfer out', `${size(l.transferGb)} a month${unit}`],
    ['Mirrors', 'Unlimited'],
  ]
}

function Pricing() {
  const [billing, setBilling] = React.useState<'month' | 'year'>('year')
  const money = useEurope() ? '€' : '$'
  return (
    <div className="space-y-20">
      <header className="mx-auto max-w-2xl space-y-4 text-center">
        <h1 className="text-4xl font-semibold tracking-tight text-balance">
          Pay to keep your work, not to run it.
        </h1>
        <p className="text-lg text-muted-foreground">
          Plans cover storage, transfer, history and seats. Bring your own
          runner, model and agent. We never resell compute or tokens.
        </p>
        <p className="text-sm text-muted-foreground">
          Just here to download software? That is free, and never needs an
          account or a plan.
        </p>
        <div className="pt-2">
          <Segmented
            label="Billing"
            value={billing}
            onChange={setBilling}
            options={[
              ['year', 'Yearly, save about 20%'],
              ['month', 'Monthly'],
            ]}
          />
        </div>
      </header>

      <section className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-4">
        {[freePlan, ...plans].map((p) => (
          <article
            key={p.id}
            className={cn(
              'surface flex flex-col gap-6 rounded-2xl bg-card',
              isPaid(p) && p.featured
                ? 'border-2 border-brand-ink p-[calc(1.75rem-1px)] dark:border-brand/45'
                : 'border p-7',
            )}
          >
            <div className="space-y-1">
              <h2 className="text-lg font-semibold">{p.name}</h2>
              <p className="text-sm text-muted-foreground">{p.blurb}</p>
            </div>
            <div>
              <span className="text-4xl font-semibold tracking-tight tabular-nums">
                {money}
                {isPaid(p) ? perMonth(p, billing) : 0}
              </span>
              <span className="ml-1.5 text-sm text-muted-foreground">
                {isPaid(p) && p.perSeat ? 'per seat, per month' : 'per month'}
              </span>
              <p className="mt-1 text-xs text-muted-foreground">
                {!isPaid(p)
                  ? 'Free, with no card'
                  : billing === 'year'
                    ? `Billed yearly, ${money}${perYear(p)}${p.perSeat ? ' per seat' : ''}`
                    : 'Billed monthly'}
              </p>
            </div>
            {isPaid(p) ? (
              <CheckoutButton
                plan={p.id}
                cycle={billing}
                variant={p.featured ? 'brand' : 'outline'}
              >
                Choose {p.name}
              </CheckoutButton>
            ) : (
              <Button
                size="lg"
                variant="outline"
                render={<Link to="/sign-up" />}
                nativeButton={false}
              >
                Sign up free
              </Button>
            )}
            <dl className="well space-y-2 rounded-xl border bg-muted/60 p-4 text-sm">
              {limitLines(p).map(([k, v]) => (
                <div
                  key={k}
                  className="flex justify-between gap-4 max-sm:flex-col max-sm:gap-0.5 xl:flex-col xl:gap-0.5"
                >
                  <dt className="text-muted-foreground">{k}</dt>
                  <dd className="font-medium">{v}</dd>
                </div>
              ))}
            </dl>
            <div className="space-y-3 text-sm">
              {p.lead && <p className="font-medium">{p.lead}</p>}
              <ul className="space-y-2.5">
                {p.features.map((i) => (
                  <li key={i} className="flex gap-2.5">
                    <CheckIcon className="mt-0.5 size-4 shrink-0 text-success" />
                    <span className="text-muted-foreground">{i}</span>
                  </li>
                ))}
              </ul>
            </div>
          </article>
        ))}
      </section>

      <p className="mx-auto -mt-12 max-w-[68ch] text-center text-sm text-balance text-muted-foreground">
        Beyond a plan: ${overage.storagePerGbMonth.toFixed(2)} per extra GB of
        storage a month, ${overage.transferPerGb.toFixed(2)} per extra GB
        transferred, in dollars. Plans are charged in euros in Europe, at the
        same number as in dollars, and in dollars elsewhere. Prices exclude tax.
      </p>

      <section className="surface rounded-2xl border bg-card p-8 md:p-10">
        <div className="grid grid-cols-1 gap-8 md:grid-cols-[1fr_2fr]">
          <div className="space-y-2">
            <h2 className="text-2xl font-semibold tracking-tight">
              Enterprise
            </h2>
            <p className="text-muted-foreground">
              SSO, audit export, data residency and an SLA, with someone to
              call.
            </p>
            <div className="pt-2">
              <ContactSales>Talk to us</ContactSales>
            </div>
          </div>
          <ul className="grid grid-cols-1 gap-x-6 gap-y-2.5 text-sm text-muted-foreground sm:grid-cols-2">
            {[
              'SAML and SCIM',
              'Audit log export',
              'Data residency',
              'Uptime SLA',
              'Volume pricing on storage and transfer',
              'Dedicated support',
            ].map((i) => (
              <li key={i} className="flex gap-2.5">
                <CheckIcon className="mt-0.5 size-4 shrink-0 text-success" />
                {i}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="space-y-8">
        <div className="mx-auto max-w-2xl space-y-2 text-center">
          <h2 className="text-2xl font-semibold tracking-tight">
            Bring your own
          </h2>
          <p className="text-muted-foreground">
            These are things you connect, not things we sell. The list is open:
            anything that speaks to a git host can join it.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
          {own.map((o) => (
            <div
              key={o.title}
              className="surface space-y-4 rounded-2xl border bg-card p-6"
            >
              <div>
                <h3 className="font-medium">{o.title}</h3>
                <p className="text-sm text-muted-foreground">{o.body}</p>
              </div>
              <ul className="flex flex-wrap gap-2">
                {o.names.map((id) => (
                  <li
                    key={id}
                    className="inline-flex items-center gap-1.5 rounded-lg border bg-card px-2.5 py-1 text-sm"
                  >
                    <BrandLogo id={id} className="size-4" />
                    {brandName(id)}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-3xl space-y-6">
        <h2 className="text-center text-2xl font-semibold tracking-tight">
          Common questions
        </h2>
        <div className="surface divide-y overflow-hidden rounded-2xl border bg-card">
          {questions.map(([q, a]) => (
            <details key={q} className="group p-5">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium">
                {q}
                <span className="text-muted-foreground transition-transform group-open:rotate-45">
                  +
                </span>
              </summary>
              <p className="mt-3 text-sm text-muted-foreground">{a}</p>
            </details>
          ))}
        </div>
      </section>
    </div>
  )
}
