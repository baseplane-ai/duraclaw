import { Slot } from '@radix-ui/react-slot'
import { styled, View } from '@tamagui/core'
import type * as React from 'react'
import { cn } from '~/lib/utils'

// GH#125 P1a — Tamagui port of the cva+Tailwind shadcn Badge.
//
// Tamagui-handled (in the styled() shell): inline-flex layout, gap,
// padding, radius, border, hover for the link-variant ([a&]:hover:*),
// focus-visible ring shell, variant background/foreground colors.
//
// Tailwind escape hatch (kept in className via `cn()`):
//  - text typography (text-xs font-medium whitespace-nowrap) — View's
//    StackStyle rejects TextStyle props in v2-rc.41 runtime.
//  - [&>svg]:* descendant selectors — Tamagui can't reach these without
//    the compiler.
//  - aria-invalid:* / focus-visible:* ARIA-state selectors.
//  - [a&]:hover:* — sibling/element-tag composition.
//  - dark:* — dark-mode prefix lives in Tailwind (Tamagui themes flip
//    via theme switch, but the dark-only ring/destructive offsets stay
//    in className for now).
const BADGE_ESCAPE_CLASSES =
  'text-xs font-medium whitespace-nowrap [&>svg]:size-3 [&>svg]:pointer-events-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive transition-[color,box-shadow]'

const BadgeShell = styled(View, {
  name: 'Badge',
  render: 'span',
  display: 'inline-flex',
  // GH#125 follow-up: Tamagui `styled(View)` defaults to flexDirection:
  // 'column' (RN semantics). Without `row` here, badges with an icon +
  // text child (e.g. BrainIcon + "Thought for…" in the reasoning pill)
  // stack vertically — visible regression in chat thinking-bubble.
  flexDirection: 'row',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '$1',
  flexShrink: 0,
  borderRadius: '$md',
  borderWidth: 1,
  paddingHorizontal: 8,
  paddingVertical: 2,
  width: 'fit-content',
  overflow: 'hidden',
  variants: {
    variant: {
      default: {
        borderColor: 'transparent',
        backgroundColor: '$primary',
        color: '$primaryForeground',
        hoverStyle: { backgroundColor: '$primary', opacity: 0.9 },
      },
      secondary: {
        borderColor: 'transparent',
        backgroundColor: '$secondary',
        color: '$secondaryForeground',
        hoverStyle: { backgroundColor: '$secondary', opacity: 0.9 },
      },
      destructive: {
        borderColor: 'transparent',
        backgroundColor: '$destructive',
        color: '#ffffff',
        hoverStyle: { backgroundColor: '$destructive', opacity: 0.9 },
      },
      outline: {
        borderColor: '$border',
        color: '$foreground',
        hoverStyle: { backgroundColor: '$accent', color: '$accentForeground' },
      },
    },
  } as const,
  defaultVariants: { variant: 'default' },
})

type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline'

type BadgeProps = React.ComponentProps<'span'> & {
  variant?: BadgeVariant
  asChild?: boolean
}

function Badge({ className, variant, asChild = false, ...props }: BadgeProps) {
  if (asChild) {
    // Slot polymorphism — passes props through to a child element. As
    // with Button asChild, visual variant fidelity for asChild relies
    // on the escape-hatch classes plus consumer className. P1b cleanup
    // item.
    return (
      <Slot
        data-slot="badge"
        className={cn(BADGE_ESCAPE_CLASSES, className)}
        {...(props as React.ComponentProps<typeof Slot>)}
      />
    )
  }
  return (
    <BadgeShell
      data-slot="badge"
      variant={variant}
      className={cn(BADGE_ESCAPE_CLASSES, className)}
      {...(props as React.ComponentProps<typeof BadgeShell>)}
    />
  )
}

// Preserve the badgeVariants() export — consumers may compose this into
// className strings (matching the Button pattern), expecting the full
// variant class string the original cva config produced. The lookup
// table below mirrors that cva config verbatim so consumers calling
// `badgeVariants({ variant: 'destructive' })` keep their bg/color
// visuals. cva itself is gone from package.json — the lookup table is
// simpler and has no runtime cost.
const BADGE_BASE_CLASSES =
  'inline-flex items-center justify-center rounded-md border px-2 py-0.5 text-xs font-medium w-fit whitespace-nowrap shrink-0 [&>svg]:size-3 gap-1 [&>svg]:pointer-events-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive transition-[color,box-shadow] overflow-hidden'

const BADGE_VARIANT_CLASSES: Record<BadgeVariant, string> = {
  default: 'border-transparent bg-primary text-primary-foreground [a&]:hover:bg-primary/90',
  secondary: 'border-transparent bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90',
  destructive:
    'border-transparent bg-destructive text-white [a&]:hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60',
  outline: 'text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground',
}

function badgeVariants({ variant = 'default' }: { variant?: BadgeVariant } = {}) {
  return cn(BADGE_BASE_CLASSES, BADGE_VARIANT_CLASSES[variant])
}

export { Badge, badgeVariants }
