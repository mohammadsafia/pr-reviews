import { type ComponentProps, type FC, forwardRef } from 'react'

import { cn } from '@/lib/utils'

type TextareaProps = ComponentProps<'textarea'>

const Textarea: FC<TextareaProps> = ({ ref, className, ...props }) => (
  <textarea
    data-slot="textarea"
    ref={ref}
    className={cn(
      'border-muted-200 bg-background flex min-h-20 w-full rounded-md border p-3 text-sm shadow-xs transition-[color,box-shadow] outline-none',
      'placeholder:text-muted-foreground',
      'hover:not-disabled:border-primary hover:not-disabled:ring-primary hover:not-disabled:ring',
      'focus-visible:ring-primary focus-visible:border-primary focus-visible:ring',
      'disabled:bg-muted-50 disabled:text-muted-300 disabled:placeholder:text-muted-300 disabled:pointer-events-none',
      className,
    )}
    {...props}
  />
)

// React 18 bridge — remove forwardRef wrapper when upgrading to React 19
export default forwardRef<HTMLTextAreaElement, TextareaProps>((props, ref) => Textarea({ ...props, ref }))
