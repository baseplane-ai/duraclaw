import { styled, View } from '@tamagui/core'
import type * as React from 'react'
import { cn } from '~/lib/utils'

// GH#125 P1a — Tamagui port of the shadcn Card subcomponents (pure
// layout, no variants).
//
// Tailwind escape hatch (kept in className via `cn()`):
//  - text typography (font-semibold, text-sm, text-muted-foreground,
//    leading-none) — @tamagui/core's Stack base doesn't accept TextStyle.
//  - descendant-state selectors ([.border-b]:pb-6, [.border-t]:pt-6) —
//    Tamagui variants can't reach these without the compiler.
//  - container query (@container/card-header) — same.
//  - data-slot composition (has-data-[slot=card-action]:grid-cols-...).
// P1b-or-later: convert via Tamagui group + selector primitives.

const CardShell = styled(View, {
  name: 'Card',
  display: 'flex',
  flexDirection: 'column',
  gap: '$6',
  borderRadius: '$xl',
  borderWidth: 1,
  borderColor: '$border',
  backgroundColor: '$card',
  paddingVertical: '$5',
  // shadow-sm — Tamagui shadow props live on Stack styles
  shadowColor: 'rgba(0,0,0,0.05)',
  shadowOffset: { width: 0, height: 1 },
  shadowOpacity: 1,
  shadowRadius: 2,
})

const CardHeaderShell = styled(View, {
  name: 'CardHeader',
  // display: grid + grid-* layout props live in className escape hatch
  // (Tamagui StackStyle doesn't accept grid display or justifySelf).
  paddingHorizontal: '$5',
})

const CardTitleShell = styled(View, {
  name: 'CardTitle',
  // typography lives in className escape hatch (font-semibold,
  // leading-none) — see header comment.
})

const CardDescriptionShell = styled(View, {
  name: 'CardDescription',
  // typography lives in className escape hatch (text-sm,
  // text-muted-foreground) — see header comment.
})

const CardActionShell = styled(View, {
  name: 'CardAction',
  alignSelf: 'flex-start',
  // grid-{column,row}-start, grid-row-span, justify-self all live in
  // className escape hatch (Tamagui StackStyle doesn't accept them).
})

const CardContentShell = styled(View, {
  name: 'CardContent',
  paddingHorizontal: '$5',
})

const CardFooterShell = styled(View, {
  name: 'CardFooter',
  display: 'flex',
  flexDirection: 'row',
  alignItems: 'center',
  paddingHorizontal: '$5',
})

function Card({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <CardShell
      data-slot="card"
      className={cn('text-card-foreground', className)}
      {...(props as React.ComponentProps<typeof CardShell>)}
    />
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <CardHeaderShell
      data-slot="card-header"
      className={cn(
        '@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-1.5 has-data-[slot=card-action]:grid-cols-[1fr_auto] [.border-b]:pb-6',
        className,
      )}
      {...(props as React.ComponentProps<typeof CardHeaderShell>)}
    />
  )
}

function CardTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <CardTitleShell
      data-slot="card-title"
      className={cn('leading-none font-semibold', className)}
      {...(props as React.ComponentProps<typeof CardTitleShell>)}
    />
  )
}

function CardDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <CardDescriptionShell
      data-slot="card-description"
      className={cn('text-sm text-muted-foreground', className)}
      {...(props as React.ComponentProps<typeof CardDescriptionShell>)}
    />
  )
}

function CardAction({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <CardActionShell
      data-slot="card-action"
      className={cn('col-start-2 row-span-2 row-start-1 justify-self-end', className)}
      {...(props as React.ComponentProps<typeof CardActionShell>)}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <CardContentShell
      data-slot="card-content"
      className={cn(className)}
      {...(props as React.ComponentProps<typeof CardContentShell>)}
    />
  )
}

function CardFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <CardFooterShell
      data-slot="card-footer"
      className={cn('[.border-t]:pt-6', className)}
      {...(props as React.ComponentProps<typeof CardFooterShell>)}
    />
  )
}

export { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle }
