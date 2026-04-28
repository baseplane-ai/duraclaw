import * as AvatarPrimitive from '@radix-ui/react-avatar'
import { styled } from '@tamagui/core'
import type * as React from 'react'
import { cn } from '~/lib/utils'

// GH#125 P1a — Tamagui port of the shadcn Avatar (Radix wrapper, 3
// subcomponents). Pure structural styling, no variants.
//
// Tailwind escape hatch (kept in className via `cn()`):
//  - aspect-square — Tamagui StackStyle has no aspectRatio shorthand
//    matching Tailwind's 1:1 idiom; lighter to keep it in className.

const AvatarShell = styled(AvatarPrimitive.Root, {
  name: 'Avatar',
  position: 'relative',
  display: 'flex',
  width: 32,
  height: 32,
  flexShrink: 0,
  overflow: 'hidden',
  borderRadius: 9999,
})

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
    <AvatarShell
      data-slot="avatar"
      className={cn(className)}
      {...(props as React.ComponentProps<typeof AvatarShell>)}
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
