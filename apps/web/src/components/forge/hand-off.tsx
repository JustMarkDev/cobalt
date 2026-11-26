import * as React from 'react'
import { Link } from '@tanstack/react-router'
import {
  ArrowUpRightIcon,
  CloudIcon,
  ComputerDesktopIcon,
} from '@heroicons/react/24/outline'
import { cn } from 'cn'
import { CopyField } from './repo-shell'
import { Modal } from './bits'
import { Button } from '~/components/ui/button'
import { useWrite } from '~/lib/forge'

type Subject = {
  kind: 'issue' | 'change' | 'run'
  ref: string
  title: string
}

const targets = [
  {
    id: 't3',
    icon: ComputerDesktopIcon,
    name: 'T3 Code',
    body: 'On your machine, with the agents and subscriptions you already use. Opens a thread in a new worktree.',
  },
  {
    id: 'boat',
    icon: CloudIcon,
    name: 'boat.dev',
    body: 'A fresh cloud machine for this task, signed in as you, removed when it ends.',
  },
] as const

export function HandOff({
  subject,
  repo,
  label = 'Hand off',
}: {
  subject: Subject
  repo: string
  label?: string
}) {
  const [open, setOpen] = React.useState(false)
  const [target, setTarget] =
    React.useState<(typeof targets)[number]['id']>('t3')
  const command = `cb handoff ${subject.ref.replace(/^#/, '')} -R ${repo} --to ${target}`
  const write = useWrite()
  const [sent, setSent] = React.useState<
    | { state: 'idle' }
    | { state: 'sending' }
    | { state: 'sent'; agent: boolean; run: number | null }
    | { state: 'failed'; message: string }
  >({ state: 'idle' })
  const [owner, name] = repo.split('/')
  const send = () => {
    setSent({ state: 'sending' })
    void write('handoffs.start', {
      owner,
      repo: name,
      body: { subject: subject.ref.replace(/^#/, ''), to: 't3' },
    }).then((r) =>
      r.error
        ? setSent({ state: 'failed', message: r.error.message })
        : setSent({ state: 'sent', agent: r.data.agent, run: r.data.run }),
    )
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <ArrowUpRightIcon className="size-4" />
        {label}
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        wide
        title={
          subject.kind === 'run' ? 'Hand off this failure' : 'Hand this off'
        }
        description={`${subject.ref} ${subject.title}`}
      >
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {targets.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-pressed={target === t.id}
              onClick={() => setTarget(t.id)}
              className={cn(
                'space-y-1 rounded-lg border p-3 text-left text-sm focus-ring',
                target === t.id
                  ? 'raised border-foreground/60 bg-card'
                  : 'hover:bg-muted',
              )}
            >
              <t.icon className="size-4" />
              <div className="font-medium">{t.name}</div>
              <div className="text-xs text-muted-foreground">{t.body}</div>
            </button>
          ))}
        </div>

        {target === 't3' && (
          <div className="space-y-2 rounded-lg border p-3 text-sm">
            {sent.state === 'sent' ? (
              sent.agent ? (
                <p>
                  Sent. Your agent opens the T3 Code thread on its machine
                  {sent.run ? ` (pipeline run #${sent.run})` : ''}.
                </p>
              ) : (
                <p>
                  Queued, but no agent takes hand-offs yet. Once, on the machine
                  with T3 Code:{' '}
                  <code className="font-mono text-xs">
                    cb runner register my-mac --labels t3,reviewer &&
                    CB_RUNNER_TOKEN=… cb runner start
                  </code>
                  . It takes this one when it starts, and every later one for
                  all your repositories.
                </p>
              )
            ) : sent.state === 'failed' ? (
              <p className="text-danger">{sent.message}</p>
            ) : (
              <p className="text-muted-foreground">
                Your agent (cb runner start, labelled t3) opens the thread for
                you. Nothing to copy.
              </p>
            )}
            <Button
              variant="brand"
              disabled={sent.state === 'sending' || sent.state === 'sent'}
              onClick={send}
            >
              {sent.state === 'sending'
                ? 'Sending'
                : sent.state === 'sent'
                  ? 'Sent'
                  : 'Send to T3 Code'}
            </Button>
          </div>
        )}

        <div className="space-y-2">
          {target !== 't3' && <CopyField value={command} prefix="$" />}
          {target === 't3' && (
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">Or run it yourself</summary>
              <div className="mt-2">
                <CopyField value={`${command} --start`} prefix="$" />
              </div>
            </details>
          )}
          <p className="text-xs text-muted-foreground">
            Run it where you are signed in. It sends the{' '}
            {subject.kind === 'run' ? 'failing log, the ' : ''}
            {subject.kind} text and the variable names, never a value. The agent
            works under your login, opens a draft change, and every write
            carries its receipt: this machine, the tool and the model.{' '}
            <Link
              to="/docs/$"
              params={{ _splat: 'cli/agents' }}
              className="underline underline-offset-4"
            >
              How hand-off works
            </Link>
          </p>
        </div>

        <div className="flex justify-end">
          <Button variant="brand" onClick={() => setOpen(false)}>
            Done
          </Button>
        </div>
      </Modal>
    </>
  )
}
