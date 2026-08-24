import { type ComponentPropsWithoutRef, type FC } from 'react'

import * as SelectPrimitive from '@radix-ui/react-select'
import { Check, ChevronDown } from 'lucide-react'

import { cn } from '@/lib/utils'

const Trigger: FC<ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>> = ({ className, children, ...props }) => (
  <SelectPrimitive.Trigger
    data-slot="select-trigger"
    className={cn(
      'border-border bg-card hover:not-disabled:border-primary focus-visible:ring-primary flex h-9 w-full cursor-pointer items-center justify-between gap-2 rounded-md border px-3 text-sm outline-none focus-visible:ring-1 disabled:opacity-50',
      className,
    )}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon>
      <ChevronDown className="text-muted-foreground h-4 w-4" />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
)

const Content: FC<ComponentPropsWithoutRef<typeof SelectPrimitive.Content>> = ({ className, children, ...props }) => (
  <SelectPrimitive.Portal>
    <SelectPrimitive.Content
      data-slot="select-content"
      position="popper"
      sideOffset={4}
      className={cn(
        'bg-popover text-popover-foreground border-border animate-in fade-in-0 zoom-in-95 z-50 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-md border shadow-deep',
        className,
      )}
      {...props}
    >
      <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
    </SelectPrimitive.Content>
  </SelectPrimitive.Portal>
)

const Item: FC<ComponentPropsWithoutRef<typeof SelectPrimitive.Item>> = ({ className, children, ...props }) => (
  <SelectPrimitive.Item
    data-slot="select-item"
    className={cn(
      'focus:bg-primary/10 flex cursor-pointer items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none',
      className,
    )}
    {...props}
  >
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    <SelectPrimitive.ItemIndicator>
      <Check className="text-primary h-4 w-4" />
    </SelectPrimitive.ItemIndicator>
  </SelectPrimitive.Item>
)

const Select = Object.assign(
  (props: ComponentPropsWithoutRef<typeof SelectPrimitive.Root>) => <SelectPrimitive.Root data-slot="select" {...props} />,
  { Trigger, Value: SelectPrimitive.Value, Content, Item },
)

export default Select
