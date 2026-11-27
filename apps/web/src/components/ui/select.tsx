import * as React from 'react'
import { Select as SelectPrimitive } from '@base-ui/react/select'
import { CaretUpDownIcon, CheckIcon } from '@phosphor-icons/react'
import { cn } from 'cn'
import { field } from './input'

type ItemProps = {
  value?: string
  disabled?: boolean
  children: React.ReactNode
}

function SelectItem(props: ItemProps): null {
  void props
  return null
}

type Choice = { value: string; label: React.ReactNode; disabled: boolean }

const text = (node: React.ReactNode): string =>
  typeof node === 'string' || typeof node === 'number'
    ? String(node)
    : Array.isArray(node)
      ? node.map(text).join('')
      : ''

function choices(children: React.ReactNode): Array<Choice> {
  return React.Children.toArray(children).flatMap((child): Array<Choice> => {
    if (!React.isValidElement(child)) return []
    if (child.type === React.Fragment)
      return choices((child.props as { children?: React.ReactNode }).children)
    if (child.type !== SelectItem) return []
    const p = child.props as ItemProps
    return [
      {
        value: p.value ?? text(p.children),
        label: p.children,
        disabled: p.disabled ?? false,
      },
    ]
  })
}

function Select({
  value,
  defaultValue,
  onValueChange,
  placeholder,
  disabled,
  name,
  id,
  title,
  className,
  children,
  ...aria
}: {
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  placeholder?: string
  disabled?: boolean
  name?: string
  id?: string
  title?: string
  className?: string
  'aria-label'?: string
  'aria-invalid'?: boolean
  children: React.ReactNode
}) {
  const items = choices(children)
  return (
    <SelectPrimitive.Root
      items={items}
      value={value}
      defaultValue={defaultValue}
      onValueChange={(next) => {
        if (next !== null) onValueChange?.(String(next))
      }}
      disabled={disabled}
      name={name}
      id={id}
    >
      <SelectPrimitive.Trigger
        data-slot="select"
        title={title}
        className={cn(
          field,
          'flex h-9 items-center justify-between gap-2 pr-2 text-left data-[popup-open]:border-foreground/40',
          className,
        )}
        {...aria}
      >
        <SelectPrimitive.Value
          placeholder={placeholder}
          className="min-w-0 flex-1 truncate data-[placeholder]:text-muted-foreground"
        />
        <SelectPrimitive.Icon>
          <CaretUpDownIcon className="size-4 text-muted-foreground" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Positioner
          sideOffset={6}
          alignItemWithTrigger={false}
          className="z-50 outline-none"
        >
          <SelectPrimitive.Popup className="overlay-popup max-h-[min(20rem,var(--available-height))] min-w-[var(--anchor-width)] overflow-y-auto rounded-xl border bg-popover p-1 text-sm floating outline-none">
            <SelectPrimitive.List>
              {items.map((item) => (
                <SelectPrimitive.Item
                  key={item.value}
                  value={item.value}
                  disabled={item.disabled}
                  className="flex cursor-default items-center gap-2 rounded-lg py-1.5 pr-2 pl-2.5 outline-none select-none data-[disabled]:opacity-45 data-[highlighted]:bg-muted"
                >
                  <SelectPrimitive.ItemText className="min-w-0 flex-1">
                    {item.label}
                  </SelectPrimitive.ItemText>
                  <SelectPrimitive.ItemIndicator>
                    <CheckIcon className="size-4" />
                  </SelectPrimitive.ItemIndicator>
                </SelectPrimitive.Item>
              ))}
            </SelectPrimitive.List>
          </SelectPrimitive.Popup>
        </SelectPrimitive.Positioner>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  )
}

export { Select, SelectItem }
