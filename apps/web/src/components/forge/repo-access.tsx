import * as React from 'react'
import { LockClosedIcon } from '@heroicons/react/24/outline'
import { Chip, EmptyState, Panel, SectionLabel } from './bits'
import type { Repo } from '~/lib/model/data'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { useOp, useWrite } from '~/lib/forge'

const list = (s: string) =>
  s
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean)

export function AccessPage({ repo }: { repo: Repo }) {
  const at = { owner: repo.owner, repo: repo.name }
  const rules = useOp('access_rules.list', at).data
  const write = useWrite()
  const [error, setError] = React.useState('')
  const [id, setId] = React.useState('')
  const [kind, setKind] = React.useState<'branch' | 'path'>('branch')
  const [patterns, setPatterns] = React.useState('')
  const [readers, setReaders] = React.useState('')

  const save = (e: React.FormEvent) => {
    e.preventDefault()
    void write('access_rules.put', {
      ...at,
      rule: id.trim(),
      body: { kind, patterns: list(patterns), readers: list(readers) },
    }).then((r) => {
      if (r.error) return setError(r.error.message)
      setError('')
      setId('')
      setPatterns('')
      setReaders('')
    })
  }
  const remove = (rule: string) =>
    void write('access_rules.delete', { ...at, rule }).then((r) =>
      setError(r.error?.message ?? ''),
    )

  return (
    <div className="space-y-6">
      <div className="mb-6 space-y-1">
        <h2 className="text-lg font-semibold tracking-tight">Access</h2>
        <p className="max-w-[60ch] text-sm text-muted-foreground">
          Branches and paths only some people may see. Everyone else does not
          see them anywhere: not the files, not the changes, not search, events
          or notifications. Owners and admins always see everything. A clone is
          not filtered yet, so keep what must never leak in its own repository.
        </p>
      </div>
      {rules.length === 0 ? (
        <EmptyState title="Everything is visible to everyone who reads it">
          Add a rule below to keep a branch or a folder to a few people.
        </EmptyState>
      ) : (
        <Panel as="div" className="divide-y">
          {rules.map((r) => (
            <div key={r.id} className="flex items-start gap-3 p-4 text-sm">
              <LockClosedIcon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{r.id}</span>
                  <Chip tone="info">{r.kind}</Chip>
                </div>
                <p className="font-mono text-xs">{r.patterns.join(', ')}</p>
                <p className="text-xs text-muted-foreground">
                  Readers: {r.readers.join(', ')}
                </p>
              </div>
              <Button size="sm" variant="outline" onClick={() => remove(r.id)}>
                Remove
              </Button>
            </div>
          ))}
        </Panel>
      )}
      <section className="space-y-3">
        <SectionLabel>Add or replace a rule</SectionLabel>
        <form onSubmit={save} className="grid gap-3 sm:grid-cols-2">
          <Input
            aria-label="Rule id"
            placeholder="Id, such as deal"
            value={id}
            onChange={(e) => setId(e.target.value)}
            required
          />
          <select
            aria-label="Kind"
            className="rounded-md border bg-background px-2 py-1 text-sm"
            value={kind}
            onChange={(e) => setKind(e.target.value as 'branch' | 'path')}
          >
            <option value="branch">Branches</option>
            <option value="path">Paths</option>
          </select>
          <Input
            aria-label="Patterns"
            placeholder={kind === 'branch' ? 'deal/*' : 'finance/**, *.key'}
            value={patterns}
            onChange={(e) => setPatterns(e.target.value)}
            required
          />
          <Input
            aria-label="Readers"
            placeholder="dana, hollis, team:legal"
            value={readers}
            onChange={(e) => setReaders(e.target.value)}
            required
          />
          <div>
            <Button type="submit" disabled={!id.trim()}>
              Save rule
            </Button>
          </div>
        </form>
      </section>
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  )
}
