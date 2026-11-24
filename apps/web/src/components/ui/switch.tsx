import { Switch as SwitchPrimitive } from '@base-ui/react/switch'
import { cn } from 'cn'

function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        'well relative inline-flex h-6 w-10 shrink-0 items-center rounded-full border border-(--control-border) bg-input focus-ring transition-colors data-[checked]:border-brand data-[checked]:bg-brand data-[disabled]:opacity-50',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="block size-5 shadow-(--lift) translate-x-0.5 rounded-full bg-background transition-transform dark:not-data-[checked]:bg-muted-foreground data-[checked]:translate-x-[calc(1.125rem-2px)] data-[checked]:bg-white" />
    </SwitchPrimitive.Root>
  )
}

function SwitchRow({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  hint?: string
}) {
  return (
    <div className="flex items-start justify-between gap-6">
      <div className="text-sm">
        <div className="font-medium">{label}</div>
        {hint && <div className="text-muted-foreground">{hint}</div>}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </div>
  )
}

export { Switch, SwitchRow }
