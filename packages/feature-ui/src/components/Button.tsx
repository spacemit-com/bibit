import {
  forwardRef,
  type ButtonHTMLAttributes,
} from 'react'
import { cn } from '../cn'

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement>
>(({ className, type = 'button', ...props }, ref) => (
  <button
    ref={ref}
    type={type}
    className={cn(
      'inline-flex min-h-9 items-center justify-center rounded-md px-3 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
      className
    )}
    {...props}
  />
))
Button.displayName = 'FeatureButton'
