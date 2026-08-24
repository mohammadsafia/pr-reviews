import { type ComponentPropsWithoutRef, type FC } from 'react'

import { cn } from '@/lib/utils'

const Skeleton: FC<ComponentPropsWithoutRef<'div'>> = ({ className, ...props }) => (
  <div data-slot="skeleton" className={cn('bg-muted-100 dark:bg-popover animate-pulse rounded-md', className)} {...props} />
)

export default Skeleton
