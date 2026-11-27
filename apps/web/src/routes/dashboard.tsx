import { Link, createFileRoute } from '@tanstack/react-router'
import type { ProfileTab } from '~/components/forge/profile-tabs'
import type { DashboardData } from '~/lib/model/dashboard'
import type { Account } from '~/lib/auth/accounts'
import type { Box } from '~/components/forge/inbox'
import { RequireAuth } from '~/components/forge/auth'
import { GettingStarted, History, Numbers } from '~/components/forge/dashboard'
import { RailTop, RepoBrowser } from '~/components/forge/home-rail'
import { InboxList, useInbox } from '~/components/forge/inbox'
import { Segmented } from '~/components/ui/tabs'
import { OrgPage } from '~/components/forge/organization'
import { profileTabs } from '~/components/forge/profile-tabs'
import { ProfileView } from '~/components/forge/profile-view'
import { Button } from '~/components/ui/button'
import { useAccounts } from '~/lib/auth/accounts'
import { useOp, useWrite } from '~/lib/forge'
import { toDashboardData } from '~/lib/dashboard'

type Search = { view?: 'profile'; tab?: ProfileTab; box?: Box }

export const Route = createFileRoute('/dashboard')({
  head: () => ({ meta: [{ title: 'Dashboard · cobalt' }] }),
  validateSearch: (s: Record<string, unknown>): Search => ({
    view: s.view === 'profile' ? 'profile' : undefined,
    tab: profileTabs.find(([id]) => id === s.tab)?.[0],
    box: s.box === 'unread' ? 'unread' : undefined,
  }),
  component: () => (
    <RequireAuth>
      <Dashboard />
    </RequireAuth>
  ),
})

function Home({
  data,
  account,
  box,
}: {
  data: DashboardData
  account: Account
  box: Box
}) {
  const inbox = useInbox()
  const write = useWrite()
  const navigate = Route.useNavigate()
  const notesUnread = inbox.entries.some(
    (e) => e.type === 'note' && e.unread.length > 0,
  )
  const health = { owner: account.handle, repos: data.health }
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-8 md:grid-cols-[208px_minmax(0,1fr)] lg:grid-cols-[220px_minmax(0,1fr)_288px]">
      <aside className="flex flex-col gap-6 md:sticky md:top-20 md:row-span-2 md:max-h-[calc(100dvh-6rem)] md:self-start lg:row-span-1">
        <RailTop account={account} />
        <RepoBrowser health={health} className="hidden border-t pt-5 md:flex" />
      </aside>
      <main className="min-w-0 space-y-8">
        <section aria-labelledby="inbox-title">
          <div className="mb-3 flex min-h-8 flex-wrap items-center justify-between gap-3">
            <h1
              id="inbox-title"
              className="text-xl font-semibold tracking-tight"
            >
              Inbox
            </h1>
            <div className="flex items-center gap-2">
              {notesUnread && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void write('notifications.read_all', {})}
                >
                  Mark all as read
                </Button>
              )}
              <Segmented
                label="Show"
                value={box}
                onChange={(b) =>
                  void navigate({ search: b === 'unread' ? { box: b } : {} })
                }
                options={[
                  ['all', 'All'],
                  [
                    'unread',
                    inbox.counts.unread > 0
                      ? `Unread ${inbox.counts.unread}`
                      : 'Unread',
                  ],
                ]}
              />
            </div>
          </div>
          <InboxList inbox={inbox} box={box} />
        </section>
        <RepoBrowser health={health} className="md:hidden" />
        {data.empty && box === 'all' && <GettingStarted account={account} />}
      </main>
      <aside className="min-w-0 space-y-8 md:col-start-2 lg:col-start-auto">
        <Numbers data={data} />
        <History data={data} organization={account.kind === 'organization'} />
      </aside>
    </div>
  )
}

function Dashboard() {
  const {
    view = 'dashboard',
    tab = 'overview',
    box = 'all',
  } = Route.useSearch()
  const { active } = useAccounts()
  if (!active) return null
  return (
    <DashboardFor
      key={active.handle}
      active={active}
      view={view}
      tab={tab}
      box={box}
    />
  )
}

function DashboardFor({
  active,
  view,
  tab,
  box,
}: {
  active: Account
  view: 'dashboard' | 'profile'
  tab: ProfileTab
  box: Box
}) {
  const org = active.kind === 'organization'
  const api = useOp('dashboard.get', { account: active.handle })
  const owned = useOp('repos.list', { owner: active.handle, limit: 100 }).data
  const data = toDashboardData(api, owned)
  if (view === 'dashboard')
    return <Home data={data} account={active} box={box} />
  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {org ? 'Your public page' : 'Your public profile'}
          </h1>
          <p className="mt-1 text-muted-foreground">
            This is exactly what other people see.
          </p>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <Link
            to="/$handle"
            params={{ handle: active.handle }}
            className="py-1 text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            Open as a visitor
          </Link>
          <Button
            variant="outline"
            size="sm"
            nativeButton={false}
            render={<Link to="/dashboard" />}
          >
            Back to the dashboard
          </Button>
        </div>
      </header>
      {org ? (
        <OrgPage handle={active.handle} embedded />
      ) : (
        <ProfileView
          embedded
          handle={active.handle}
          tab={tab}
          tabLink={(id) => ({
            to: '/dashboard',
            search:
              id === 'overview'
                ? { view: 'profile' }
                : { view: 'profile', tab: id },
          })}
        />
      )}
    </div>
  )
}
