import { type ComponentPropsWithoutRef, type FC } from 'react'

import * as TabsPrimitive from '@radix-ui/react-tabs'

import { cn } from '@/lib/utils'

const List: FC<ComponentPropsWithoutRef<typeof TabsPrimitive.List>> = ({ className, ...props }) => (
  <TabsPrimitive.List
    data-slot="tabs-list"
    className={cn('border-border bg-card inline-flex gap-1 rounded-lg border p-1', className)}
    {...props}
  />
)

const Trigger: FC<ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>> = ({ className, ...props }) => (
  <TabsPrimitive.Trigger
    data-slot="tabs-trigger"
    className={cn(
      'text-muted-foreground data-[state=active]:bg-primary/10 data-[state=active]:text-foreground hover:text-foreground cursor-pointer rounded-md px-3 py-1.5 text-sm outline-none transition-colors',
      className,
    )}
    {...props}
  />
)

const Content: FC<ComponentPropsWithoutRef<typeof TabsPrimitive.Content>> = ({ className, ...props }) => (
  <TabsPrimitive.Content data-slot="tabs-content" className={cn('mt-4 outline-none', className)} {...props} />
)

const Tabs = Object.assign(
  (props: ComponentPropsWithoutRef<typeof TabsPrimitive.Root>) => <TabsPrimitive.Root data-slot="tabs" {...props} />,
  { List, Trigger, Content },
)

export default Tabs
