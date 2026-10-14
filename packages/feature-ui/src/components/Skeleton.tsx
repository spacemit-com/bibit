import type { HTMLAttributes } from 'react'
import { cn } from '../cn'

export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn('animate-pulse rounded-md bg-muted', className)}
      {...props}
    />
  )
}
