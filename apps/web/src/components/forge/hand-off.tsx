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

        <div className="space-y-2">
          <CopyField value={command} prefix="$" />
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
