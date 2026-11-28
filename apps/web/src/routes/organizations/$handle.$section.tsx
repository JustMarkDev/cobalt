import { createFileRoute, notFound } from '@tanstack/react-router'
import type { OrgSection, PlanChoice } from '~/components/forge/organization'
import { RequireAuth } from '~/components/forge/auth'
import { OrgSettings, orgSections } from '~/components/forge/organization'

export const Route = createFileRoute('/organizations/$handle/$section')({
  head: () => ({ meta: [{ title: 'Organization settings · cobalt' }] }),
  validateSearch: (s: Record<string, unknown>): Partial<PlanChoice> => ({
    ...(s.plan === 'team' || s.plan === 'business' ? { plan: s.plan } : {}),
    ...(typeof s.seats === 'number' && s.seats >= 1
      ? { seats: Math.min(500, Math.floor(s.seats)) }
      : {}),
    ...(s.cycle === 'month' || s.cycle === 'year' ? { cycle: s.cycle } : {}),
  }),
  component: OrganizationSettings,
})

function OrganizationSettings() {
  const { handle, section } = Route.useParams()
  const choice = Route.useSearch()
  const known = orgSections.find(([id]) => id === section)?.[0]
  if (!known) throw notFound()
  return (
    <RequireAuth>
      <OrgSettings
        handle={handle}
        section={known satisfies OrgSection}
        choice={choice}
      />
    </RequireAuth>
  )
}
