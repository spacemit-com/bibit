import { useRef, type ReactNode } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Button } from './Button'

export interface DialogProps {
  open: boolean
  title: string
  children?: ReactNode
  onClose: () => void
}

export function Dialog({ open, title, children, onClose }: DialogProps) {
  const closeRef = useRef<HTMLButtonElement>(null)
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose()
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 bg-black/40" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 w-[min(32rem,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border bg-background p-4 shadow-lg"
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            closeRef.current?.focus()
          }}
        >
          <DialogPrimitive.Title className="text-lg font-semibold">
            {title}
          </DialogPrimitive.Title>
          <div className="py-4">{children}</div>
          <DialogPrimitive.Close asChild>
            <Button ref={closeRef}>Close</Button>
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
