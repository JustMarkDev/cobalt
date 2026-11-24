import * as React from 'react'
import { createFileRoute, notFound, redirect } from '@tanstack/react-router'
import type { RepoPage } from '~/components/forge/repo-shell'
import { RequireAuth } from '~/components/forge/auth'
import { RepoFrame } from '~/components/forge/repo-shell'
import type { Repo } from '~/lib/model/data'
import { ForgeRefused, loadOp, useOp } from '~/lib/forge'
import { toRelease, toRepo } from '~/lib/repo'

/** URL segment -> the tab it highlights. */
const activeOf: Partial<Record<string, RepoPage>> = {
  code: 'code',
  issues: 'issues',
  changes: 'pulls',
  pipelines: 'pipelines',
  releases: 'release',
  insights: 'insights',
  settings: 'settings',
}

/**
 * A module loaded once, that React's `use` reads at once when it is ready:
 * React looks at `status` and `value` before it waits on a promise.
 */
function once<T>(load: () => Promise<T>): () => Promise<T> {
  let loading: Promise<T> | undefined
  return () => {
    if (!loading) {
      const p: Promise<T> = load().then((value) => {
        const tracked = p as Promise<T> & { status?: string; value?: T }
        tracked.status = 'fulfilled'
        tracked.value = value
        return value
      })
      // A chunk that failed to arrive is asked for again next time.
      void p.catch(() => {
        if (loading === p) loading = undefined
      })
      loading = p
    }
    return loading
  }
}

/**
 * Each tab's code, loaded only when that tab is shown. They differ a lot in
 * size: the code and changes tabs carry the file tree and the diff viewer,
 * which the others do not need, and only one tab needs settings, runs or
 * reviews. The loader waits for the tab's module with its data, so a server
 * render and a move between tabs render it at once. When the browser first
 * takes over a page, React waits for it with the server's HTML still on
 * screen.
 */
const modules = {
  variants: once(() => import('~/components/forge/repo-variants')),
  releases: once(() => import('~/components/forge/repo-releases')),
  pages: once(() => import('~/components/forge/repo-pages')),
  changes: once(() => import('~/components/forge/repo-changes')),
  runs: once(() => import('~/components/forge/repo-runs')),
  settings: once(() => import('~/components/forge/repo-settings')),
}
const moduleOf: Partial<Record<string, keyof typeof modules>> = {
  code: 'variants',
  releases: 'releases',
  issues: 'pages',
  insights: 'pages',
  changes: 'changes',
  pipelines: 'runs',
  settings: 'settings',
}

/** The tab's module; an unknown tab has none, and is the router's 404. */
function loadTab(tab: string) {
  const name = moduleOf[tab]
  return name ? modules[name]() : null
}

type TabSearch = {
  n?: number
  section?: string
  /** A production confirmation to open, from the link `cb` prints. */
  confirm?: string
  path?: string
  view?: 'history'
}

export const Route = createFileRoute('/$handle/$repo/$tab')({
  // The tab was called Actions. Old links lead to the same page under its name.
  beforeLoad: ({ params }) => {
    if (params.tab === 'actions')
      throw redirect({
        to: '/$handle/$repo/$tab',
        params: { ...params, tab: 'pipelines' },
        search: true,
      })
  },
  head: ({ params }) => ({
    meta: [{ title: `${params.handle}/${params.repo} · cobalt` }],
  }),
  validateSearch: (s: Record<string, unknown>): TabSearch => ({
    n:
      typeof s.n === 'number'
        ? s.n
        : typeof s.n === 'string' && s.n
          ? Number(s.n)
          : undefined,
    section: typeof s.section === 'string' ? s.section : undefined,
    confirm:
      typeof s.confirm === 'string' && /^cnf_[0-9a-z]+$/.test(s.confirm)
        ? s.confirm
        : undefined,
    path: typeof s.path === 'string' && s.path ? s.path : undefined,
    view: s.view === 'history' ? 'history' : undefined,
  }),
  // A repository that does not exist, or that this person may not read, is
  // the router's 404.
  loader: ({ context, params }) =>
    // A repository that moved (renamed or transferred) sends people to where
    // it is now, as the API's 308 does.
    Promise.all([
      loadOp(context.queryClient, 'repos.get', {
        owner: params.handle,
        repo: params.repo,
      }),
      loadOp(context.queryClient, 'releases.list', {
        owner: params.handle,
        repo: params.repo,
        limit: 50,
      }),
      loadTab(params.tab),
    ])
      // The module is code, not data: it stays out of what goes to the browser.
      .then(([repo, releases]) => [repo, releases] as const)
      .catch((e: unknown) => {
        const to =
          e instanceof ForgeRefused && e.code === 'moved' ? e.moved_to : null
        if (!to) throw e
        const [handle, repo] = to.split('/')
        throw redirect({
          to: '/$handle/$repo/$tab',
          params: { handle, repo, tab: params.tab },
          statusCode: 308,
        })
      }),
  component: RepoTab,
})

function RepoTab() {
  const { handle, repo: name, tab } = Route.useParams()
  const { n, section, path, view } = Route.useSearch()
  const found = useOp('repos.get', { owner: handle, repo: name })
  const releases = useOp('releases.list', {
    owner: handle,
    repo: name,
    limit: 50,
  }).data
  const repo = React.useMemo(
    () => toRepo(found, releases.map(toRelease)),
    [found, releases],
  )
  const [finding, setFinding] = React.useState(false)
  const active = activeOf[tab]
  if (!active) throw notFound()

  // The page below the header reads data the loader does not fetch, such as
  // the issue list, so the first visit to a tab suspends. A move between tabs
  // reaches React as a router store update, not a transition, and a suspend
  // there hides the whole frame behind the router's empty fallback: the
  // screen goes black. The page renders from a deferred copy of where we are
  // instead, so the tab on screen stays until the next one is ready, while the
  // tab bar shows the new tab at once.
  const shown = React.useDeferredValue(
    React.useMemo(
      () => ({ tab, n, section, path, view }),
      [tab, n, section, path, view],
    ),
  )

  return (
    // The frame is keyed by repository only, so switching tabs keeps the
    // header mounted and swaps just the page below it.
    <RepoFrame
      key={repo.name}
      repo={repo}
      active={active}
      counts={{
        issues: found.open_issues,
        pulls: found.open_changes,
      }}
      actions={
        shown.tab === 'code' && shown.view !== 'history' ? (
          <CodeActions repo={repo} onFind={() => setFinding(true)} />
        ) : undefined
      }
    >
      <RepoTabPage
        tab={shown.tab}
        repo={repo}
        n={shown.n}
        section={shown.section}
        path={shown.path}
        view={shown.view}
        finding={finding}
        onFinding={setFinding}
      />
    </RepoFrame>
  )
}

function RepoTabPage({
  tab,
  repo,
  n,
  section,
  path,
  view,
  finding,
  onFinding,
}: {
  tab: string
  repo: Repo
  n?: number
  section?: string
  path?: string
  view?: 'history'
  finding: boolean
  onFinding: (open: boolean) => void
}) {
  switch (tab) {
    case 'code': {
      const { CodePage } = React.use(modules.variants())
      return (
        <CodePage
          repo={repo}
          path={path}
          view={view}
          finding={finding}
          onFinding={onFinding}
        />
      )
    }
    case 'issues': {
      const { IssuesPage } = React.use(modules.pages())
      return <IssuesPage key={repo.name} repo={repo} n={n} />
    }
    case 'changes': {
      const { ChangesPage } = React.use(modules.changes())
      return <ChangesPage key={repo.name} repo={repo} n={n} />
    }
    case 'pipelines': {
      const { PipelinesPage } = React.use(modules.runs())
      return <PipelinesPage key={repo.name} repo={repo} n={n} />
    }
    case 'releases': {
      const { ReleasesPage } = React.use(modules.releases())
      return <ReleasesPage repo={repo} />
    }
    case 'insights': {
      const { InsightsPage } = React.use(modules.pages())
      return <InsightsPage repo={repo} />
    }
    case 'settings': {
      const { RepoSettings } = React.use(modules.settings())
      return (
        <RequireAuth>
          <RepoSettings repo={repo} section={section} />
        </RequireAuth>
      )
    }
    default:
      throw notFound()
  }
}

function CodeActions(
  props: React.ComponentProps<
    Awaited<ReturnType<typeof modules.variants>>['CodeActions']
  >,
) {
  const { CodeActions: Actions } = React.use(modules.variants())
  return <Actions {...props} />
}
