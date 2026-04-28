import { styled, View } from '@tamagui/core'
import type * as React from 'react'
import { cn } from '~/lib/utils'

// GH#125 P1a — Tamagui port of the cva+Tailwind shadcn Alert.
//
// Tamagui-handled (in the styled() shell): radius, border, padding,
// variant background/foreground colors.
//
// Tailwind escape hatch (kept in className via `cn()`):
//  - text typography (text-sm font-medium tracking-tight) — View's
//    StackStyle rejects TextStyle props in v2-rc.41 runtime.
//  - CSS Grid layout (grid grid-cols-* gap-* items-start) — View's
//    StackStyle rejects display:'grid' and grid-template-* props.
//  - has-[>svg]:* / *:data-[slot=*]:* descendant-state selectors — the
//    SVG-presence-aware grid template lives entirely in className.
//  - [&>svg]:* descendant selectors.
const ALERT_BASE_ESCAPE_CLASSES =
  'grid has-[>svg]:grid-cols-[calc(var(--spacing)*4)_1fr] grid-cols-[0_1fr] has-[>svg]:gap-x-3 gap-y-0.5 items-start text-sm [&>svg]:size-4 [&>svg]:translate-y-0.5 [&>svg]:text-current'

const ALERT_DESTRUCTIVE_ESCAPE_CLASSES =
  '*:data-[slot=alert-description]:text-destructive/90 [&>svg]:text-current'

const AlertShell = styled(View, {
  name: 'Alert',
  render: 'div',
  position: 'relative',
  width: '100%',
  borderRadius: '$lg',
  borderWidth: 1,
  borderColor: '$border',
  paddingHorizontal: 16,
  paddingVertical: 12,
  variants: {
    variant: {
      default: {
        backgroundColor: '$card',
        color: '$cardForeground',
      },
      destructive: {
        backgroundColor: '$card',
        color: '$destructive',
      },
    },
  } as const,
  defaultVariants: { variant: 'default' },
})

const AlertTitleShell = styled(View, {
  name: 'AlertTitle',
  render: 'div',
})

const AlertDescriptionShell = styled(View, {
  name: 'AlertDescription',
  render: 'div',
})

type AlertVariant = 'default' | 'destructive'

type AlertProps = React.ComponentProps<'div'> & {
  variant?: AlertVariant
}

function Alert({ className, variant = 'default', ...props }: AlertProps) {
  const variantEscape = variant === 'destructive' ? ALERT_DESTRUCTIVE_ESCAPE_CLASSES : ''
  return (
    <AlertShell
      data-slot="alert"
      role="alert"
      variant={variant}
      className={cn(ALERT_BASE_ESCAPE_CLASSES, variantEscape, className)}
      {...(props as React.ComponentProps<typeof AlertShell>)}
    />
  )
}

function AlertTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <AlertTitleShell
      data-slot="alert-title"
      className={cn('col-start-2 line-clamp-1 min-h-4 font-medium tracking-tight', className)}
      {...(props as React.ComponentProps<typeof AlertTitleShell>)}
    />
  )
}

function AlertDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <AlertDescriptionShell
      data-slot="alert-description"
      className={cn(
        'col-start-2 grid justify-items-start gap-1 text-sm text-muted-foreground [&_p]:leading-relaxed',
        className,
      )}
      {...(props as React.ComponentProps<typeof AlertDescriptionShell>)}
    />
  )
}

export { Alert, AlertDescription, AlertTitle }
