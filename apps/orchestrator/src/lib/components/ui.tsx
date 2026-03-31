import { type ButtonHTMLAttributes, type HTMLAttributes, type InputHTMLAttributes, type TextareaHTMLAttributes, forwardRef } from 'react'
import { cn } from '~/lib/utils'

// ── Button ──────────────────────────────────────────────────────────

type ButtonVariant = 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost'
type ButtonSize = 'default' | 'sm' | 'lg' | 'icon'

const buttonVariants: Record<ButtonVariant, string> = {
  default: 'bg-primary text-primary-foreground hover:bg-primary/90',
  destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
  outline: 'border border-border bg-transparent hover:bg-accent hover:text-accent-foreground',
  secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
  ghost: 'hover:bg-accent hover:text-accent-foreground',
}

const buttonSizes: Record<ButtonSize, string> = {
  default: 'h-10 px-4 py-2',
  sm: 'h-9 px-3 text-sm',
  lg: 'h-11 px-8',
  icon: 'h-10 w-10',
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', size = 'default', ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'disabled:pointer-events-none disabled:opacity-50',
        buttonVariants[variant],
        buttonSizes[size],
        className,
      )}
      {...props}
    />
  ),
)
Button.displayName = 'Button'

// ── Card ────────────────────────────────────────────────────────────

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-lg border border-border bg-card text-card-foreground', className)} {...props} />
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col space-y-1.5 p-4', className)} {...props} />
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn('text-sm font-semibold leading-none tracking-tight', className)} {...props} />
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-4 pt-0', className)} {...props} />
}

// ── Badge ───────────────────────────────────────────────────────────

type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning'

const badgeVariants: Record<BadgeVariant, string> = {
  default: 'bg-primary text-primary-foreground',
  secondary: 'bg-secondary text-secondary-foreground',
  destructive: 'bg-destructive text-destructive-foreground',
  outline: 'border border-border text-foreground',
  success: 'bg-success/20 text-success border border-success/30',
  warning: 'bg-warning/20 text-warning border border-warning/30',
}

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant
}

export function Badge({ className, variant = 'default', ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
        badgeVariants[variant],
        className,
      )}
      {...props}
    />
  )
}

// ── Input ───────────────────────────────────────────────────────────

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'flex h-10 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm',
        'placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
)
Input.displayName = 'Input'

// ── Textarea ────────────────────────────────────────────────────────

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        'flex min-h-[80px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm',
        'placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
)
Textarea.displayName = 'Textarea'

// ── Select ──────────────────────────────────────────────────────────

interface SelectProps extends HTMLAttributes<HTMLSelectElement> {
  value?: string
  onValueChange?: (value: string) => void
  disabled?: boolean
}

export function Select({ className, value, onValueChange, children, ...props }: SelectProps) {
  return (
    <select
      className={cn(
        'flex h-10 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      value={value}
      onChange={(e) => onValueChange?.((e.target as unknown as { value: string }).value)}
      {...props}
    >
      {children}
    </select>
  )
}

// ── Dialog ──────────────────────────────────────────────────────────

interface DialogProps {
  open: boolean
  onClose: () => void
  children: React.ReactNode
}

export function Dialog({ open, onClose, children }: DialogProps) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-black/80" onClick={onClose} />
      <div className="relative z-50 w-full max-w-lg rounded-lg border border-border bg-card p-6 shadow-lg">
        {children}
      </div>
    </div>
  )
}

export function DialogHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('mb-4 flex flex-col space-y-1.5', className)} {...props} />
}

export function DialogTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn('text-lg font-semibold leading-none tracking-tight', className)} {...props} />
}

// ── Skeleton ────────────────────────────────────────────────────────

export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('animate-pulse rounded-md bg-muted', className)} {...props} />
}

// ── ScrollArea ──────────────────────────────────────────────────────

export function ScrollArea({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('overflow-auto', className)} {...props}>
      {children}
    </div>
  )
}
