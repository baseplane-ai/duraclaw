import * as SeparatorPrimitive from '@radix-ui/react-separator'
import { styled } from '@tamagui/core'
import type * as React from 'react'
import { cn } from '~/lib/utils'

// GH#125 P1a — Tamagui port of the shadcn Separator (Radix wrapper).
//
// Tamagui-handled (in the styled() shell): shrink, background.
//
// Tailwind escape hatch (kept in className via `cn()`):
//  - data-[orientation=*]: state-dependent dimensions — Tamagui can't
//    observe Radix's orientation data attribute without the compiler.
const SEPARATOR_ESCAPE_CLASSES =
  'data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:w-px data-[orientation=vertical]:h-full'

const SeparatorShell = styled(SeparatorPrimitive.Root, {
  name: 'Separator',
  flexShrink: 0,
  backgroundColor: '$border',
})

function Separator({
  className,
  orientation = 'horizontal',
  decorative = true,
  ...props
}: React.ComponentProps<typeof SeparatorPrimitive.Root>) {
  return (
    <SeparatorShell
      data-slot="separator"
      decorative={decorative}
      orientation={orientation}
      className={cn(SEPARATOR_ESCAPE_CLASSES, className)}
      {...(props as React.ComponentProps<typeof SeparatorShell>)}
    />
  )
}

export { Separator }
