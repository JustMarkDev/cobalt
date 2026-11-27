import * as React from 'react'
import {
  CheckCircleIcon,
  InfoIcon,
  WarningCircleIcon,
  WarningIcon,
} from '@phosphor-icons/react'
import { cn } from 'cn'

const tones = {
  info: { icon: InfoIcon, cls: 'bg-info/8 text-info' },
  success: { icon: CheckCircleIcon, cls: 'bg-success/8 text-success' },
  warning: { icon: WarningIcon, cls: 'bg-warning/8 text-warning' },
  danger: { icon: WarningCircleIcon, cls: 'bg-danger/8 text-danger' },
} as const

function Callout({
  tone = 'info',
  title,
  children,
  className,
}: {
  tone?: keyof typeof tones
  title?: string
  children: React.ReactNode
  className?: string
}) {
  const { icon: Icon, cls } = tones[tone]
  return (
    <div className={cn('flex gap-3 rounded-xl p-4 text-sm', cls, className)}>
      <Icon className="mt-0.5 size-4 shrink-0" />
      <div className="space-y-1 text-foreground">
        {title && <p className="font-medium">{title}</p>}
        <div className="text-muted-foreground">{children}</div>
      </div>
    </div>
  )
}

export { Callout }
