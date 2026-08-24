import { type ComponentPropsWithoutRef, type FC } from 'react'

import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area'

import { cn } from '@/lib/utils'

const ScrollArea: FC<ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root>> = ({ className, children, ...props }) => (
  <ScrollAreaPrimitive.Root data-slot="scroll-area" className={cn('relative overflow-hidden', className)} {...props}>
    {/* max-h-[inherit] passes a max-h-* cap set on the Root down to the viewport — without
        it Radix's viewport never constrains, so the content clips instead of scrolling.
        The [&>div] override neutralizes Radix's injected `display: table` wrapper, which
        otherwise expands to intrinsic content width and defeats truncation (author
        !important beats inline styles; the inline min-width:100% is harmless on a block). */}
    <ScrollAreaPrimitive.Viewport className="h-full max-h-[inherit] w-full rounded-[inherit] [&>div]:!block">
      {children}
    </ScrollAreaPrimitive.Viewport>
    <ScrollAreaPrimitive.Scrollbar
      orientation="vertical"
      className="flex w-2 touch-none p-0.5 select-none"
    >
      <ScrollAreaPrimitive.Thumb className="bg-border relative flex-1 rounded-full" />
    </ScrollAreaPrimitive.Scrollbar>
    <ScrollAreaPrimitive.Corner />
  </ScrollAreaPrimitive.Root>
)

export default ScrollArea
