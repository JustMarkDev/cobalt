import * as React from 'react'
import { useSearch } from '@tanstack/react-router'
import { File } from '@pierre/diffs/react'
import {
  ComputerDesktopIcon,
  LockClosedIcon,
  ShieldExclamationIcon,
  UserGroupIcon,
} from '@heroicons/react/24/outline'
import { cn } from 'cn'
import { Chip, Modal, Panel, SectionLabel, Seg } from './bits'
import { CopyField } from './repo-shell'
import type { Repo } from '~/lib/model/data'
import type { AuditEvent, EnvName, EnvVar } from '~/lib/model/platform'
import { codeTheme, useCodeOverflow } from '~/lib/highlight'
import { Button } from '~/components/ui/button'
import { useIsDark } from '~/lib/theme'
import { envNames } from '~/lib/model/platform'
import { useOp, useOpMaybe, useWrite } from '~/lib/forge'
import { timeAgo } from '~/lib/repo'
import { field } from '~/components/ui/input'

function Variables({
  env,
  vars,
  onRotate,
}: {
  env: EnvName
  vars: Array<EnvVar>
  onRotate: (v: EnvVar) => void
}) {
  return (
    <Panel className="overflow-x-auto" tabIndex={0}>
      <table className="w-full min-w-[40rem] text-sm">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th className="px-4 py-2 font-medium">Variable</th>
            <th className="px-4 py-2 font-medium">Type</th>
            <th className="px-4 py-2 font-medium">In {env}</th>
            <th className="px-4 py-2 font-medium">Rotated</th>
            <th className="relative px-4 py-2">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {vars.map((v) => {
            const has = v.set[env]
            const needed = v.required.includes(env)
            return (
              // A missing required value is the one thing here that needs doing, so it stands out.
              <tr key={v.name} className={cn(!has && needed && 'bg-danger/5')}>
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-2 font-mono text-xs font-semibold">
                    {v.sensitive && (
                      <LockClosedIcon className="size-3 text-muted-foreground" />
                    )}
                    {v.name}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {v.description}
                  </div>
                </td>
                <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">
                  {v.type}
                </td>
                <td className="px-4 py-2.5">
                  {has ? (
                    <Chip tone="success">
                      {v.sensitive ? 'Encrypted' : 'Set'}
                    </Chip>
                  ) : needed ? (
                    <Chip tone="danger">Missing, required</Chip>
                  ) : (
                    <Chip>Not set</Chip>
                  )}
                </td>
                <td className="px-4 py-2.5 text-xs text-muted-foreground">
                  {v.rotated}
                  {v.by !== '—' && ` by ${v.by}`}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onRotate(v)}
                  >
                    {has ? 'Rotate' : 'Set'}
                  </Button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </Panel>
  )
}

function RotateDialog({
  v,
  env,
  repo,
  onClose,
}: {
  v: EnvVar | null
  env: EnvName
  repo: Repo
  onClose: () => void
}) {
  const write = useWrite()
  const [value, setValue] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const close = () => {
    setValue('')
    setError('')
    onClose()
  }
  return (
    <Modal
      open={v !== null}
      onClose={close}
      title={v ? `${v.set[env] ? 'Rotate' : 'Set'} ${v.name}` : ''}
      description={`Sealed the moment it arrives, under this repository's own key, and never shown again. Only the team can set or read it.`}
    >
      {v && (
        <>
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault()
              if (!value) return
              setBusy(true)
              void write('env.set', {
                owner: repo.owner,
                repo: repo.name,
                name: v.name,
                environment: env,
                body: { value },
              }).then((r) => {
                setBusy(false)
                if (r.error) return setError(r.error.message)
                close()
              })
            }}
          >
            <input
              type="password"
              autoComplete="off"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={`Value for ${env}`}
              aria-label={`Value of ${v.name} for ${env}`}
              className={cn(field, 'h-9 font-mono')}
            />
            {error && <p className="text-sm text-danger">{error}</p>}
            <div className="flex justify-end">
              <Button type="submit" variant="brand" disabled={!value || busy}>
                {busy ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </form>
          <p className="text-sm text-muted-foreground">
            Or from a terminal in the repository:
          </p>
          <CopyField
            value={`printf %s "$VALUE" | sx env set ${v.name} - --env ${env} -R ${repo.owner}/${repo.name}`}
            prefix="$"
          />
          <p className="text-xs text-muted-foreground">
            Rotating here does not change the provider. Also create the new
            credential at the service that issued it, then revoke the old one.
          </p>
        </>
      )}
    </Modal>
  )
}

type Confirmation = {
  id: string
  environment: string
  state: 'pending' | 'active' | 'revoked' | 'expired'
  device: string | null
  tool: string | null
  expires_at: string
  created_at: string
}

/**
 * Production values wait for the person to confirm the login that asked,
 * from here: a page you are signed in to, which a token cannot reach. A link
 * from `sx` (`?confirm=cnf_…`) opens the request; nothing is confirmed until
 * you press the button.
 */
function Confirmations({ repo }: { repo: Repo }) {
  const at = { owner: repo.owner, repo: repo.name }
  const write = useWrite()
  const { confirm }: { confirm?: string } = useSearch({ strict: false })
  const list = useOp('confirmations.list', at).data as Array<Confirmation>
  const [hours, setHours] = React.useState(1)
  const [error, setError] = React.useState('')
  const shown = list.filter(
    (c) => c.state === 'pending' || c.state === 'active',
  )
  const asked = shown.find((c) => c.id === confirm && c.state === 'pending')
  const act = (c: Confirmation, verb: 'confirm' | 'revoke') =>
    void write(
      verb === 'confirm' ? 'confirmations.confirm' : 'confirmations.revoke',
      verb === 'confirm'
        ? { ...at, confirmation: c.id, body: { ttl_minutes: hours * 60 } }
        : { ...at, confirmation: c.id },
    ).then((r) => setError(r.error?.message ?? ''))
  return (
    <section className="space-y-3" id="confirmations">
      <SectionLabel>Production confirmations</SectionLabel>
      <p className="max-w-prose text-sm text-muted-foreground">
        A machine reads production values only after you confirm it here, for a
        few hours at a time. Development and preview need no confirmation.
      </p>
      {shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing is waiting, and no machine can read production values now.
        </p>
      ) : (
        <Panel as="div" className="divide-y">
          {shown.map((c) => (
            <div
              key={c.id}
              className={cn(
                'flex flex-wrap items-center gap-3 p-4 text-sm',
                c.id === asked?.id && 'bg-warning/8',
              )}
            >
              <ComputerDesktopIcon className="size-5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="font-medium">
                  {c.device ?? 'A token'}
                  {c.tool && (
                    <span className="font-normal text-muted-foreground">
                      {' '}
                      through {c.tool}
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {c.state === 'pending'
                    ? `Asked ${timeAgo(c.created_at)} for production values. Confirm only if you started this.`
                    : `Can read production values until ${new Date(c.expires_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`}
                </p>
              </div>
              {c.state === 'pending' ? (
                <div className="flex items-center gap-2">
                  <Seg
                    value={String(hours)}
                    onChange={(v) => setHours(Number(v))}
                    options={[
                      ['1', '1 hour'],
                      ['4', '4 hours'],
                      ['8', '8 hours'],
                    ]}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => act(c, 'revoke')}
                  >
                    Turn down
                  </Button>
                  <Button
                    size="sm"
                    variant="brand"
                    onClick={() => act(c, 'confirm')}
                  >
                    Confirm
                  </Button>
                </div>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => act(c, 'revoke')}
                >
                  End now
                </Button>
              )}
            </div>
          ))}
        </Panel>
      )}
      {confirm && !shown.some((c) => c.id === confirm) && (
        <p className="text-sm text-muted-foreground">
          That request is no longer waiting. Run the command again to ask anew.
        </p>
      )}
      {error && <p className="text-sm text-danger">{error}</p>}
    </section>
  )
}

/** Who reads values: the team, through their own logins. Nobody else. */
function WhoReads({ repo }: { repo: Repo }) {
  return (
    <Panel className="space-y-3 p-5 text-sm">
      <div className="flex items-center gap-2 font-medium">
        <UserGroupIcon className="size-4" />
        The team reads values. Nobody else does.
      </div>
      <p className="text-muted-foreground">
        The team is {repo.owner} (every member, if it is an organization) and
        the teams with write access. Each of them signs in a machine once, and
        the values follow them there, with any agent they run on it. Anyone else
        who can read this repository sees the names below and never a value: not
        on this page, not in a clone, not through the API.
      </p>
      <CopyField
        value={`sx env run --env development -R ${repo.owner}/${repo.name} -- bun dev`}
        prefix="$"
      />
      <p className="text-xs text-muted-foreground">
        Values go into that one process and are scrubbed from what it prints. No
        .env file is written unless you ask for one with{' '}
        <code>sx env pull --plaintext</code>.
      </p>
    </Panel>
  )
}

function Audit({ events }: { events: Array<AuditEvent> }) {
  const tone = {
    rotate: 'info',
    grant: 'success',
    revoke: 'warning',
    read: 'muted',
    reject: 'danger',
  } as const
  return (
    <Panel className="overflow-hidden">
      <ul className="divide-y">
        {events.map((e, i) => (
          <li key={i} className="flex items-center gap-3 px-4 py-2.5 text-sm">
            <Chip tone={tone[e.kind]} className="w-16 justify-center">
              {e.kind}
            </Chip>
            <span className="min-w-0 flex-1">
              <span className="font-medium">{e.who}</span> {e.action}{' '}
              <span className="text-muted-foreground">{e.target}</span>
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {e.when}
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  )
}

export function SecretsPage({ repo }: { repo: Repo }) {
  const dark = useIsDark()
  const overflow = useCodeOverflow()
  const theme = codeTheme(dark)
  const at = { owner: repo.owner, repo: repo.name }
  const [env, setEnv] = React.useState<EnvName>('production')
  const vars: Array<EnvVar> = useOp('env.list', at).data.map((v) => ({
    name: v.name,
    type: v.kind,
    sensitive: v.secret,
    description: v.description,
    set: {
      development: v.environments.includes('development'),
      preview: v.environments.includes('preview'),
      production: v.environments.includes('production'),
    },
    required: v.required,
    rotated: v.rotated_at ? timeAgo(v.rotated_at) : 'never',
    by: v.rotated_by ?? '',
  }))
  const [rotating, setRotating] = React.useState<EnvVar | null>(null)
  // The audit log is the team's: anyone else sees the names and no log.
  const events: Array<AuditEvent> | null =
    useOpMaybe('env.audit', at)?.data.map((a) => ({
      when: timeAgo(a.at),
      who: a.who,
      action: a.action,
      target: a.target ?? '',
      kind: a.kind ?? 'read',
    })) ?? null
  // The schema file, as the variables say it.
  const envSchema = vars
    .map(
      (v) =>
        `# ${v.description || v.name}\n# @type=${v.type}${v.sensitive ? ' @sensitive' : ''}${v.required.length ? ` @required=${v.required.join(',')}` : ''}\n${v.name}=`,
    )
    .join('\n\n')

  const required = vars.filter((v) => v.required.includes(env))
  const missing = required.filter((v) => !v.set[env])

  return (
    <>
      <div className="space-y-10">
        <div className="max-w-3xl space-y-2">
          <h2 className="text-2xl font-semibold tracking-tight">Secrets</h2>
          <p className="text-muted-foreground">
            The names live in the repository; the values live here, sealed, and
            only your team can read them. This page shows names, types and
            status, never values.
          </p>
        </div>

        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Seg
              value={env}
              onChange={setEnv}
              options={envNames.map((e): [EnvName, string] => [e, e])}
            />
            <div className="flex items-center gap-2 text-sm">
              {missing.length === 0 ? (
                <Chip tone="success">
                  {required.length} of {required.length} required set
                </Chip>
              ) : (
                <Chip tone="danger">
                  {required.length - missing.length} of {required.length}{' '}
                  required set. Missing {missing.map((m) => m.name).join(', ')}
                </Chip>
              )}
            </div>
          </div>
          <Variables env={env} vars={vars} onRotate={setRotating} />
        </section>

        <WhoReads repo={repo} />

        <Confirmations repo={repo} />

        <section className="space-y-3">
          <SectionLabel>In the repository</SectionLabel>
          <div className="surface lit-edge overflow-hidden rounded-2xl border bg-card">
            <File
              file={{ name: '.env.schema', contents: envSchema }}
              options={{ theme, overflow }}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Anyone who can read the repository sees the schema: names, types and
            which are secret. No value is ever committed, so a clone carries
            none.
          </p>
        </section>

        {events && (
          <section className="space-y-3">
            <SectionLabel>Audit log</SectionLabel>
            <Audit events={events} />
          </section>
        )}

        <Panel className="space-y-3 p-5">
          <div className="flex items-center gap-2 font-medium">
            <ShieldExclamationIcon className="size-4" />
            What this cannot do
          </div>
          <ul className="grid grid-cols-1 gap-3 text-sm text-muted-foreground md:grid-cols-3">
            <li>
              <span className="font-medium text-foreground">
                Take back what was read.
              </span>{' '}
              Someone who leaves the team could have read values while on it.
              Rotate the real credentials at each provider; the audit log says
              who read what.
            </li>
            <li>
              <span className="font-medium text-foreground">
                Hide variable names.
              </span>{' '}
              Names and types are in the schema on purpose. Do not name a
              variable after the thing it protects.
            </li>
            <li>
              <span className="font-medium text-foreground">
                Stop a command you run.
              </span>{' '}
              A process given values can still send them somewhere. Keep
              production behind its confirmation, and run agents you do not
              trust where outbound traffic is limited.
            </li>
          </ul>
        </Panel>
      </div>

      <RotateDialog
        v={rotating}
        env={env}
        repo={repo}
        onClose={() => setRotating(null)}
      />
    </>
  )
}
