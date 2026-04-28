'use client'

import * as LabelPrimitive from '@radix-ui/react-label'
import { styled } from '@tamagui/core'
import type * as React from 'react'
import { cn } from '~/lib/utils'

// GH#125 P1a — Tamagui port of the shadcn Label.
//
// Tailwind escape hatch (kept in className via `cn()`):
//  - peer-disabled: + group-data-[disabled=true]: state composition —
//    Tamagui can't observe sibling/ancestor data-attribute state without
//    the compiler.
//  - text typography (text-sm font-medium leading-none, select-none) —
//    Tamagui's Stack base styling around LabelPrimitive.Root doesn't
//    extract TextStyle props in v2-rc.41 runtime mode.
// P1b-or-later: convert via Tamagui group + selector primitives.
const LABEL_ESCAPE_CLASSES =
  'flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50'

const StyledLabel = styled(LabelPrimitive.Root, {
  name: 'Label',
})

function Label({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <StyledLabel
      data-slot="label"
      className={cn(LABEL_ESCAPE_CLASSES, className)}
      {...(props as React.ComponentProps<typeof StyledLabel>)}
    />
  )
}

export { Label }
