import { type ComponentPropsWithoutRef, type FC } from 'react'

import * as DialogPrimitive from '@radix-ui/react-dialog'

import { cn } from '@/lib/utils'

const Content: FC<ComponentPropsWithoutRef<typeof DialogPrimitive.Content>> = ({ className, children, ...props }) => (
  <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay className="animate-in fade-in-0 fixed inset-0 z-50 bg-black/50" />
    <DialogPrimitive.Content
      data-slot="sheet-content"
      className={cn(
        'bg-sidebar border-sidebar-border animate-in slide-in-from-left fixed inset-y-0 left-0 z-50 w-64 border-r p-4 outline-none',
        className,
      )}
      {...props}
    >
      {children}
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
)

const Sheet = Object.assign(
  (props: ComponentPropsWithoutRef<typeof DialogPrimitive.Root>) => <DialogPrimitive.Root data-slot="sheet" {...props} />,
  { Trigger: DialogPrimitive.Trigger, Content, Title: DialogPrimitive.Title },
)

export default Sheet
