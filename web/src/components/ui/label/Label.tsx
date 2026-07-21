import { type ComponentProps, type FC, forwardRef } from 'react'

import * as LabelPrimitive from '@radix-ui/react-label'

import { cn } from '@/lib/utils'

type LabelProps = ComponentProps<typeof LabelPrimitive.Root>

const Label: FC<LabelProps> = ({ ref, className, ...props }) => (
  <LabelPrimitive.Root
    ref={ref}
    data-slot="label"
    className={cn(
      'text-sm leading-none font-medium select-none peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
      className,
    )}
    {...props}
  />
)

// React 18 bridge — remove forwardRef wrapper when upgrading to React 19
export default forwardRef<HTMLLabelElement, LabelProps>((props, ref) => Label({ ...props, ref }))
