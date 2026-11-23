import * as React from 'react'
import {
  ComputerDesktopIcon,
  KeyIcon,
  PuzzlePieceIcon,
} from '@heroicons/react/24/outline'
import { Chip, EmptyState, Panel, SectionLabel } from './bits'
import { CopyField } from './repo-shell'
import { Button } from '~/components/ui/button'
import { useOp, useWrite } from '~/lib/forge'
import { timeAgo } from '~/lib/repo'

/**
 * Where you are signed in. A machine signs in once (`sx auth login`) and every
 * agent on it works under that login, so this list is the whole of who can
 * act as you: machines, applications, and tokens you made. Revoking one ends
 * it on its next request.
 */
export function MachinesPanel() {
  const logins = useOp('authorizations.list', {}).data
  const tokens = useOp('tokens.list', {}).data
  const write = useWrite()
  const [error, setError] = React.useState('')
  const machines = logins.filter((a) => a.device)
  const apps = logins.filter((a) => !a.device)

  const revoke = (op: 'authorizations.revoke' | 'tokens.revoke', id: string) =>
    void write(op, { id }).then((r) => setError(r.error?.message ?? ''))

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <SectionLabel>Machines</SectionLabel>
        <p className="max-w-prose text-sm text-muted-foreground">
          Sign a machine in once. Agents you run on it work under your login,
          read the secrets your team can read, and every write they make names
          the machine, the tool and the model.
        </p>
        <CopyField value="sx auth login" prefix="$" />
        {machines.length ? (
          <Panel as="div" className="divide-y">
            {machines.map((a) => (
              <Row
                key={a.id}
                icon={ComputerDesktopIcon}
                title={a.device!}
                detail={`${a.client.name}, signed in ${timeAgo(a.created_at)}${a.last_used_at ? `, last used ${timeAgo(a.last_used_at)}` : ''}`}
                secrets={a.scopes.includes('secrets:decrypt')}
                onRevoke={() => revoke('authorizations.revoke', a.id)}
                revokeLabel="Sign out"
              />
            ))}
          </Panel>
        ) : (
          <EmptyState title="No machine is signed in">
            Run the command above in a terminal on the machine.
          </EmptyState>
        )}
      </section>

      {apps.length > 0 && (
        <section className="space-y-3">
          <SectionLabel>Applications</SectionLabel>
          <Panel as="div" className="divide-y">
            {apps.map((a) => (
              <Row
                key={a.id}
                icon={PuzzlePieceIcon}
                title={a.client.name}
                detail={`${a.audience.includes('mcp') ? 'MCP and API' : 'API'}, approved ${timeAgo(a.created_at)}`}
                secrets={false}
                onRevoke={() => revoke('authorizations.revoke', a.id)}
                revokeLabel="Revoke"
              />
            ))}
          </Panel>
        </section>
      )}

      <section className="space-y-3">
        <SectionLabel>Tokens</SectionLabel>
        <p className="max-w-prose text-sm text-muted-foreground">
          For a machine that cannot open a browser, or to give an agent less
          than you have: fewer scopes, fewer repositories. Make one with{' '}
          <code className="text-foreground">sx</code> or the API.
        </p>
        {tokens.length ? (
          <Panel as="div" className="divide-y">
            {tokens.map((t) => (
              <Row
                key={t.id}
                icon={KeyIcon}
                title={t.device ? `${t.name} on ${t.device}` : t.name}
                detail={`${t.repos ? t.repos.join(', ') : 'All repositories'}${t.paths ? ` (only ${t.paths.join(', ')})` : ''}, expires ${new Date(t.expires_at).toLocaleDateString('en', { dateStyle: 'medium', timeZone: 'UTC' })}${t.last_used_at ? `, last used ${timeAgo(t.last_used_at)}` : ', never used'}`}
                secrets={t.scopes.includes('secrets:decrypt')}
                onRevoke={() => revoke('tokens.revoke', t.id)}
                revokeLabel="Revoke"
              />
            ))}
          </Panel>
        ) : (
          <p className="text-sm text-muted-foreground">No tokens.</p>
        )}
      </section>
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  )
}

function Row({
  icon: Icon,
  title,
  detail,
  secrets,
  onRevoke,
  revokeLabel,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  detail: string
  secrets: boolean
  onRevoke: () => void
  revokeLabel: string
}) {
  return (
    <div className="flex items-center gap-3 p-4 text-sm">
      <Icon className="size-5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{title}</span>
          {secrets && <Chip tone="warning">reads secrets</Chip>}
        </div>
        <p className="truncate text-xs text-muted-foreground">{detail}</p>
      </div>
      <Button size="sm" variant="outline" onClick={onRevoke}>
        {revokeLabel}
      </Button>
    </div>
  )
}
