import { Slot } from '@radix-ui/react-slot'
import { styled, View } from '@tamagui/core'
import type * as React from 'react'
import { cn } from '~/lib/utils'

// GH#125 P1a — Tamagui port of the cva+Tailwind shadcn Button.
//
// Tamagui-handled (in the styled() shell): layout (height, padding, gap,
// font-size), color tokens (bg, text, border, ring), radii, hover /
// focus / disabled pseudo-states, variant + size variants.
//
// Tailwind escape hatch (kept in className via `cn()`): aria-invalid:
// ARIA-state selectors, [&_svg]: descendant selectors, has-[>svg]:px-3
// :has() composition. Tamagui's variant API can't reach these without
// the compiler. Also kept here: text typography (font-size, font-weight)
// because @tamagui/core's Stack base (View) doesn't accept TextStyle
// props — moving to a Text-like base would lose Stack layout semantics.
// P1b-or-later: convert these to Tamagui variant + selector primitives
// if/when the compiler can extract them.
const BASE_ESCAPE_CLASSES =
  "text-sm font-medium [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive"

const ButtonShell = styled(View, {
  name: 'Button',
  // v2-rc.41 uses `render` (not `tag`) to override the rendered HTML element.
  render: 'button',
  // base layout (was: 'inline-flex items-center justify-center gap-2
  // whitespace-nowrap rounded-md text-sm font-medium ... shrink-0 outline-none')
  display: 'inline-flex',
  // GH#125 follow-up: Tamagui `styled(View)` defaults to flexDirection:
  // 'column' (RN semantics). Without `row` here, an icon child (Loader2,
  // ArrowRight, etc.) stacks above the label text — visible regression
  // in GateResolver Approve/Deny buttons and any icon+label button.
  flexDirection: 'row',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '$2',
  flexShrink: 0,
  borderRadius: '$md',
  cursor: 'pointer',
  outlineWidth: 0,
  disabledStyle: { opacity: 0.5, pointerEvents: 'none' },
  focusStyle: {
    borderColor: '$ring',
    borderWidth: 1,
    outlineColor: '$ring',
    outlineWidth: 3,
  },
  variants: {
    variant: {
      default: {
        backgroundColor: '$primary',
        color: '$primaryForeground',
        hoverStyle: { backgroundColor: '$primary', opacity: 0.9 },
      },
      destructive: {
        backgroundColor: '$destructive',
        color: '#ffffff',
        hoverStyle: { backgroundColor: '$destructive', opacity: 0.9 },
      },
      outline: {
        borderWidth: 1,
        borderColor: '$border',
        backgroundColor: '$background',
        hoverStyle: { backgroundColor: '$accent', color: '$accentForeground' },
      },
      secondary: {
        backgroundColor: '$secondary',
        color: '$secondaryForeground',
        hoverStyle: { backgroundColor: '$secondary', opacity: 0.8 },
      },
      ghost: {
        backgroundColor: 'transparent',
        hoverStyle: { backgroundColor: '$accent', color: '$accentForeground' },
      },
      link: {
        backgroundColor: 'transparent',
        color: '$primary',
        hoverStyle: { textDecorationLine: 'underline' },
      },
    },
    size: {
      default: { height: 36, paddingHorizontal: 16, paddingVertical: 8 },
      sm: { height: 32, paddingHorizontal: 12 },
      lg: { height: 40, paddingHorizontal: 24 },
      icon: { height: 36, width: 36, paddingHorizontal: 0 },
    },
  } as const,
  defaultVariants: { variant: 'default', size: 'default' },
})

type ButtonVariant = 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link'
type ButtonSize = 'default' | 'sm' | 'lg' | 'icon'

type ButtonProps = React.ComponentProps<'button'> & {
  variant?: ButtonVariant
  size?: ButtonSize
  asChild?: boolean
}

function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  if (asChild) {
    // Slot polymorphism — passes props through to a child element. The
    // styled() shell isn't used here; consumers using <Button asChild>
    // <Link>...</Link></Button> rely on Tailwind classes for visuals.
    // Layer the cva-equivalent buttonVariants() class string so bg/color
    // variants render correctly (GH#125 P1b hotfix — was previously
    // unstyled).
    return (
      <Slot
        data-slot="button"
        className={cn(BASE_ESCAPE_CLASSES, buttonVariants({ variant, size }), className)}
        {...(props as React.ComponentProps<typeof Slot>)}
      />
    )
  }
  // GH#125 P1b hotfix — the Tamagui compiler is dropping token-referenced
  // color props (`backgroundColor: '$primary'`, `color:
  // '$primaryForeground'`) inside `variants` blocks of the styled() shell,
  // so the bundled CSS lacks _color-* / _backgroundColor-primary atoms.
  // Layer Tailwind utilities via buttonVariants() in className so visuals
  // resolve through CSS variables (var(--primary), etc.) defined in
  // theme.css. tailwind-merge in cn() dedups; the styled() shell's
  // remaining layout atoms still emit and serve as a backup.
  return (
    <ButtonShell
      data-slot="button"
      variant={variant}
      size={size}
      className={cn(BASE_ESCAPE_CLASSES, buttonVariants({ variant, size }), className)}
      {...(props as React.ComponentProps<typeof ButtonShell>)}
    />
  )
}

// Preserve the buttonVariants() export — alert-dialog.tsx (and possibly
// other consumers we haven't audited) compose this into <a> / Link
// className strings, expecting the full variant + size class string the
// original cva config produced. The lookup tables below mirror that cva
// config verbatim so consumers like `buttonVariants({ variant:
// 'destructive', size: 'lg' })` keep their bg/color/height visuals.
// cva itself is gone from package.json — the lookup tables are simpler
// and have no runtime cost.
const BUTTON_BASE_CLASSES =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive"

const BUTTON_VARIANT_CLASSES: Record<ButtonVariant, string> = {
  default: 'bg-primary text-primary-foreground shadow-xs hover:bg-primary/90',
  destructive:
    'bg-destructive text-white shadow-xs hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60',
  outline:
    'border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50',
  secondary: 'bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80',
  ghost: 'hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50',
  link: 'text-primary underline-offset-4 hover:underline',
}

const BUTTON_SIZE_CLASSES: Record<ButtonSize, string> = {
  default: 'h-9 px-4 py-2 has-[>svg]:px-3',
  sm: 'h-8 rounded-md gap-1.5 px-3 has-[>svg]:px-2.5',
  lg: 'h-10 rounded-md px-6 has-[>svg]:px-4',
  icon: 'size-9',
}

function buttonVariants({
  variant = 'default',
  size = 'default',
}: {
  variant?: ButtonVariant
  size?: ButtonSize
} = {}) {
  return cn(BUTTON_BASE_CLASSES, BUTTON_VARIANT_CLASSES[variant], BUTTON_SIZE_CLASSES[size])
}

export { Button, buttonVariants }
