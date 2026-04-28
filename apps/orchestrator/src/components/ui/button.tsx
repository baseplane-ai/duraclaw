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
    // <Link>...</Link></Button> rely on Tailwind classes for visuals,
    // which the ARIA/SVG escape-hatch + any consumer className still
    // provide for adjacent layout. Visual variant fidelity (bg/color)
    // for asChild is a known P1b cleanup item.
    return (
      <Slot
        data-slot="button"
        className={cn(BASE_ESCAPE_CLASSES, className)}
        {...(props as React.ComponentProps<typeof Slot>)}
      />
    )
  }
  return (
    <ButtonShell
      data-slot="button"
      variant={variant}
      size={size}
      className={cn(BASE_ESCAPE_CLASSES, className)}
      {...(props as React.ComponentProps<typeof ButtonShell>)}
    />
  )
}

// Preserve the buttonVariants() export — alert-dialog.tsx (and possibly
// other consumers we haven't audited) compose this into <a> / Link
// className strings. The shim returns just the ARIA/SVG escape-hatch
// classes so those callsites stay structurally intact; the bg/color/
// size visuals from cva are gone for these specific consumers until
// they migrate to <Button asChild>...</Button>. P1b's compiler audit
// will surface remaining buttonVariants() callsites.
function buttonVariants(_args?: { variant?: ButtonVariant; size?: ButtonSize }) {
  return BASE_ESCAPE_CLASSES
}

export { Button, buttonVariants }
