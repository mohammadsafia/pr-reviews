import { type ComponentProps, type FC, forwardRef } from 'react'

import * as SeparatorPrimitive from '@radix-ui/react-separator'

import { cn } from '@/lib/utils'

type SeparatorProps = ComponentProps<typeof SeparatorPrimitive.Root>

const Separator: FC<SeparatorProps> = ({ ref, className, orientation = 'horizontal', decorative = true, ...props }) => (
  <SeparatorPrimitive.Root
    ref={ref}
    data-slot="separator"
    decorative={decorative}
    orientation={orientation}
    className={cn(
      'bg-muted-200 shrink-0 data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px',
      className,
    )}
    {...props}
  />
)

// React 18 bridge — remove forwardRef wrapper when upgrading to React 19
export default forwardRef<HTMLDivElement, SeparatorProps>((props, ref) => Separator({ ...props, ref }))
