import { type ComponentPropsWithoutRef, type FC } from 'react'

import * as TooltipPrimitive from '@radix-ui/react-tooltip'

import { cn } from '@/lib/utils'

const Content: FC<ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>> = ({ className, sideOffset = 4, ...props }) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      data-slot="tooltip-content"
      sideOffset={sideOffset}
      className={cn(
        'bg-popover text-popover-foreground border-border animate-in fade-in-0 z-50 max-w-72 rounded-md border px-3 py-1.5 text-xs shadow-deep',
        className,
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
)

const Tooltip = Object.assign(
  (props: ComponentPropsWithoutRef<typeof TooltipPrimitive.Root>) => (
    <TooltipPrimitive.Provider delayDuration={200}>
      <TooltipPrimitive.Root data-slot="tooltip" {...props} />
    </TooltipPrimitive.Provider>
  ),
  { Trigger: TooltipPrimitive.Trigger, Content },
)

export default Tooltip
