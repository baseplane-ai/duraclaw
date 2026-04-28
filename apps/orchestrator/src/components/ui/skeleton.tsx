import { styled, View } from '@tamagui/core'
import type * as React from 'react'
import { cn } from '~/lib/utils'

// GH#125 P1a — Tamagui port of the shadcn Skeleton.
//
// Tailwind escape hatch (kept in className via `cn()`):
//  - animate-pulse — Tamagui has no clean equivalent without
//    Animations setup; keep the Tailwind keyframe.

const SKELETON_ESCAPE_CLASSES = 'animate-pulse'

const SkeletonShell = styled(View, {
  name: 'Skeleton',
  borderRadius: '$md',
  backgroundColor: '$accent',
})

function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <SkeletonShell
      data-slot="skeleton"
      className={cn(SKELETON_ESCAPE_CLASSES, className)}
      {...(props as React.ComponentProps<typeof SkeletonShell>)}
    />
  )
}

export { Skeleton }
