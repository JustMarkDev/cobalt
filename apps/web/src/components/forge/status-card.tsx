import {
  CheckCircleIcon,
  EllipsisHorizontalCircleIcon,
  MinusIcon,
  XCircleIcon,
} from '@heroicons/react/24/outline'
import { Panel } from './bits'
import { GitMergeIcon } from '~/components/icons'
import { Button } from '~/components/ui/button'

export function StateIcon({
  state,
}: {
  state: 'pass' | 'fail' | 'pending' | 'na'
}) {
  if (state === 'pass')
    return <CheckCircleIcon className="size-4 text-success" />
  if (state === 'fail') return <XCircleIcon className="size-4 text-danger" />
  if (state === 'pending')
    return <EllipsisHorizontalCircleIcon className="size-4 text-warning" />
  return <MinusIcon className="size-4 text-muted-foreground" />
}

export type StatusItem = {
  id: string
  label: string
  detail: string
  state: 'pass' | 'fail' | 'pending'
  goto?: 'code' | 'timeline'
}

export function StatusCard({
  items,
  landing,
  canLand,
  changeId,
  note,
  onLand,
  onGoto,
  landedText = 'Landed. Children were rebased.',
}: {
  items: Array<StatusItem>
  landing: 'idle' | 'landing' | 'landed'
  canLand: boolean
  changeId: string
  note: string
  onLand: () => void
  onGoto?: (tab: 'code' | 'timeline') => void
  /** What the card says once the change has landed. */
  landedText?: string
}) {
  return (
    <Panel className="overflow-hidden p-2">
      <ul className="empty:hidden">
        {items.map((i) => (
          <li key={i.id}>
            <button
              type="button"
              disabled={!i.goto || !onGoto}
              onClick={() => i.goto && onGoto?.(i.goto)}
              className="flex w-full items-start gap-3 rounded-lg px-3 py-3 text-left enabled:hover:bg-muted/60"
            >
              <span className="mt-0.5">
                <StateIcon state={i.state} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{i.label}</span>
                <span className="block text-sm text-muted-foreground">
                  {i.detail}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="space-y-2 pt-3">
        {landing === 'landed' ? (
          <div className="flex items-center gap-2 rounded-lg bg-merged/10 px-4 py-3 font-medium text-merged">
            <GitMergeIcon className="size-4" />
            {landedText}
          </div>
        ) : (
          <>
            <Button
              variant={canLand ? 'brand' : 'outline'}
              size="lg"
              className="w-full"
              disabled={!canLand || landing === 'landing'}
              onClick={onLand}
            >
              <GitMergeIcon />
              {landing === 'landing' ? 'Landing' : `Land #${changeId}`}
            </Button>
            <p className="px-1 text-center text-xs text-muted-foreground">
              {note}
            </p>
          </>
        )}
      </div>
    </Panel>
  )
}
