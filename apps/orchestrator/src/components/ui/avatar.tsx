import * as AvatarPrimitive from '@radix-ui/react-avatar'
import { styled } from '@tamagui/core'
import type * as React from 'react'
import { cn } from '~/lib/utils'

// GH#125 P1a — shadcn Avatar (Radix wrapper, 3 subcomponents).
//
// IMPORTANT: `AvatarPrimitive.Root` is a context provider for the
// image-load state machine that `Image` + `Fallback` consume. Wrapping
// it in `styled(...)` breaks the provider chain (same pathology as
// collapsible.tsx — caught during P1a after-screenshots). Root keeps
// the bare-Radix shape with a className escape-hatch for layout. The
// leaf shells `AvatarImage` + `AvatarFallback` are pure consumers and
// can wear `styled()` safely.
//
// Tailwind escape hatch on Root: `relative flex size-8 shrink-0
// overflow-hidden rounded-full` — Tamagui StackStyle has no
// aspect-ratio shorthand on `View` in v2-rc.41 and the layout is too
// state-aware for Tamagui's variant API to express cleanly.

const AVATAR_ROOT_CLASSES = 'relative flex size-8 shrink-0 overflow-hidden rounded-full'

const AvatarImageShell = styled(AvatarPrimitive.Image, {
  name: 'AvatarImage',
  width: '100%',
  height: '100%',
})

const AvatarFallbackShell = styled(AvatarPrimitive.Fallback, {
  name: 'AvatarFallback',
  display: 'flex',
  width: '100%',
  height: '100%',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 9999,
  backgroundColor: '$muted',
})

function Avatar({ className, ...props }: React.ComponentProps<typeof AvatarPrimitive.Root>) {
  return (
    <AvatarPrimitive.Root
      data-slot="avatar"
      className={cn(AVATAR_ROOT_CLASSES, className)}
      {...props}
    />
  )
}

function AvatarImage({ className, ...props }: React.ComponentProps<typeof AvatarPrimitive.Image>) {
  return (
    <AvatarImageShell
      data-slot="avatar-image"
      className={cn('aspect-square', className)}
      {...(props as React.ComponentProps<typeof AvatarImageShell>)}
    />
  )
}

function AvatarFallback({
  className,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Fallback>) {
  return (
    <AvatarFallbackShell
      data-slot="avatar-fallback"
      className={cn(className)}
      {...(props as React.ComponentProps<typeof AvatarFallbackShell>)}
    />
  )
}

export { Avatar, AvatarFallback, AvatarImage }
