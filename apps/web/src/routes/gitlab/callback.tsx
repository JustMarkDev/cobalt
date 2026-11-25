import { createFileRoute } from '@tanstack/react-router'
import { RequireAuth } from '~/components/forge/auth'
import { ProviderCallback } from '~/components/forge/provider-callback'

type Search = { code?: string; state?: string; error?: string }

export const Route = createFileRoute('/gitlab/callback')({
  head: () => ({
    meta: [{ title: 'Bring your GitLab repositories · cobalt' }],
  }),
  validateSearch: (s: Record<string, unknown>): Search => ({
    ...(typeof s.code === 'string' ? { code: s.code } : {}),
    ...(typeof s.state === 'string' ? { state: s.state } : {}),
    ...(typeof s.error === 'string' ? { error: s.error } : {}),
  }),
  component: () => <Page />,
})

function Page() {
  const s = Route.useSearch()
  return (
    <RequireAuth>
      <ProviderCallback
        provider="gitlab"
        code={s.code}
        state={s.state}
        denied={s.error}
      />
    </RequireAuth>
  )
}
