import * as React from 'react'
import { ServerStackIcon } from '@heroicons/react/24/outline'
import type { Runner } from '@cobaltforge/sdk'
import { Chip, EmptyState, Panel, SectionLabel } from './bits'
import { CopyField } from './repo-shell'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { useOp, useWrite } from '~/lib/forge'
import { timeAgo } from '~/lib/repo'

const tones = {
  online: 'success',
  busy: 'warning',
  offline: 'muted',
  disabled: 'muted',
} as const

const list = (s: string) =>
  s
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean)

export function RunnersPanel() {
  const accounts = useOp('accounts.list', {}).data.filter(
    (a) => a.role === 'owner' || a.role === 'admin',
  )
  const [account, setAccount] = React.useState(accounts.at(0)?.handle ?? '')
  if (!account)
    return (
      <EmptyState title="No account to register runners for">
        You can register runners for yourself, or for an organization you own or
        administer.
      </EmptyState>
    )
  return (
    <div className="space-y-6">
      {accounts.length > 1 && (
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Account</span>
          <select
            className="rounded-md border bg-background px-2 py-1"
            value={account}
            onChange={(e) => setAccount(e.target.value)}
          >
            {accounts.map((a) => (
              <option key={a.handle} value={a.handle}>
                {a.handle}
              </option>
            ))}
          </select>
        </label>
      )}
      <AccountRunners key={account} account={account} />
    </div>
  )
}

function AccountRunners({ account }: { account: string }) {
  const runners = useOp('runners.list', { account }).data
  const write = useWrite()
  const [error, setError] = React.useState('')
  const [made, setMade] = React.useState<Runner | null>(null)
  const [name, setName] = React.useState('')
  const [labels, setLabels] = React.useState('')
  const [repos, setRepos] = React.useState('')
  const [concurrency, setConcurrency] = React.useState('1')
  const [provider, setProvider] = React.useState('')
  const live = runners.filter((r) => r.status !== 'disabled')

  const register = (e: React.FormEvent) => {
    e.preventDefault()
    void write('runners.create', {
      body: {
        name: name.trim(),
        account,
        labels: list(labels),
        ...(list(repos).length ? { repos: list(repos) } : {}),
        concurrency: Number(concurrency) || 1,
        ...(provider.trim()
          ? { kind: 'hosted' as const, provider: provider.trim() }
          : {}),
      },
    }).then((r) => {
      if (r.error) return setError(r.error.message)
      setError('')
      setMade(r.data)
      setName('')
      setLabels('')
      setRepos('')
    })
  }
  const revoke = (id: string) =>
    void write('runners.delete', { id }).then((r) =>
      setError(r.error?.message ?? ''),
    )

  return (
    <div className="space-y-6">
      {made?.secret && (
        <Panel className="space-y-2 border-warning/40 p-4 text-sm">
          <p className="font-medium">
            {made.name} is registered. Its token is shown this once:
          </p>
          <CopyField value={`CB_RUNNER_TOKEN=${made.secret}`} prefix="" />
          <p className="text-muted-foreground">
            On the machine, run <code>cb runner start</code> with it set. It
            reads the repositories the runner serves, claims and reports jobs,
            and nothing else.
          </p>
          <Button size="sm" variant="ghost" onClick={() => setMade(null)}>
            I have saved it
          </Button>
        </Panel>
      )}

      <section className="space-y-3">
        <SectionLabel>{account}&apos;s runners</SectionLabel>
        {live.length ? (
          <Panel as="div" className="divide-y">
            {live.map((r) => (
              <div key={r.id} className="flex items-start gap-3 p-4 text-sm">
                <ServerStackIcon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{r.name}</span>
                    <Chip tone={tones[r.status]}>{r.status}</Chip>
                    {r.provider && <Chip tone="info">{r.provider}</Chip>}
                  </div>
                  <p className="font-mono text-xs text-muted-foreground">
                    {r.labels.length ? r.labels.join(', ') : 'no labels'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {r.repos ? r.repos.join(', ') : 'Every repository'} ·{' '}
                    {r.current_jobs}/{r.concurrency} jobs ·{' '}
                    {r.last_seen_at
                      ? `seen ${timeAgo(r.last_seen_at)}`
                      : 'never seen'}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => revoke(r.id)}
                >
                  Revoke
                </Button>
              </div>
            ))}
          </Panel>
        ) : (
          <EmptyState title="No runners yet">
            Register one below, then start it on the machine.
          </EmptyState>
        )}
      </section>

      <section className="space-y-3">
        <SectionLabel>Register a runner</SectionLabel>
        <form onSubmit={register} className="grid gap-3 sm:grid-cols-2">
          <Input
            aria-label="Name"
            placeholder="Name, such as mac-mini"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <Input
            aria-label="Labels"
            placeholder="Labels: macos, arm64, xcode-16"
            value={labels}
            onChange={(e) => setLabels(e.target.value)}
          />
          <Input
            aria-label="Repositories"
            placeholder={`Repositories (empty: all of ${account}'s)`}
            value={repos}
            onChange={(e) => setRepos(e.target.value)}
          />
          <Input
            aria-label="Jobs at once"
            type="number"
            min={1}
            max={64}
            value={concurrency}
            onChange={(e) => setConcurrency(e.target.value)}
          />
          <Input
            aria-label="Hosted provider"
            placeholder="Hosted provider (empty for your own machine)"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
          />
          <div className="flex items-center">
            <Button type="submit" disabled={!name.trim()}>
              Register
            </Button>
          </div>
        </form>
        <p className="max-w-prose text-xs text-muted-foreground">
          Labels are what the machine says it offers; nobody checks them. A
          runner that takes a job it cannot run fails it. Run untrusted code on
          a machine or container of its own.
        </p>
      </section>
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  )
}
