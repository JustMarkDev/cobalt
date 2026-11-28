import { createFileRoute } from '@tanstack/react-router'
import { RequireAuth } from '~/components/forge/auth'
import { PageTitle } from '~/components/forge/bits'
import { NewOrganizationForm } from '~/components/forge/organization'
import type { PlanChoice } from '~/components/forge/organization'

export const Route = createFileRoute('/organizations/new')({
  head: () => ({ meta: [{ title: 'New organization · cobalt' }] }),
  validateSearch: (s: Record<string, unknown>): Partial<PlanChoice> => ({
    ...(s.plan === 'team' || s.plan === 'business' ? { plan: s.plan } : {}),
    ...(typeof s.seats === 'number' && s.seats >= 1
      ? { seats: Math.min(500, Math.floor(s.seats)) }
      : {}),
    ...(s.cycle === 'month' || s.cycle === 'year' ? { cycle: s.cycle } : {}),
  }),
  component: NewOrganization,
})

function NewOrganization() {
  const choice = Route.useSearch()
  return (
    <RequireAuth>
      <div className="mx-auto max-w-xl">
        <PageTitle title="New organization">
          For a company, a team or a project. It owns its repositories, and
          people join it with a role.
        </PageTitle>
        <NewOrganizationForm
          choice={
            choice.plan
              ? { cycle: 'year', seats: 3, ...choice, plan: choice.plan }
              : null
          }
        />
      </div>
    </RequireAuth>
  )
}
