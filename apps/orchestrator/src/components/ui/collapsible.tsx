import * as CollapsiblePrimitive from '@radix-ui/react-collapsible'
import { styled } from '@tamagui/core'
import type * as React from 'react'

// GH#125 P1a — Tamagui port of the shadcn Collapsible (Radix wrapper).
//
// The original shadcn Collapsible has zero styling — it's a thin
// passthrough over the Radix primitive. We still wrap each subcomponent
// in `styled(...)` so the Tamagui registry sees them and the data-slot
// attributes flow through Tamagui's prop pipeline (consistent with
// the rest of the P1a fanout).

const CollapsibleShell = styled(CollapsiblePrimitive.Root, {
  name: 'Collapsible',
})

const CollapsibleTriggerShell = styled(CollapsiblePrimitive.CollapsibleTrigger, {
  name: 'CollapsibleTrigger',
})

const CollapsibleContentShell = styled(CollapsiblePrimitive.CollapsibleContent, {
  name: 'CollapsibleContent',
})

function Collapsible({ ...props }: React.ComponentProps<typeof CollapsiblePrimitive.Root>) {
  return (
    <CollapsibleShell
      data-slot="collapsible"
      {...(props as React.ComponentProps<typeof CollapsibleShell>)}
    />
  )
}

function CollapsibleTrigger({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleTrigger>) {
  return (
    <CollapsibleTriggerShell
      data-slot="collapsible-trigger"
      {...(props as React.ComponentProps<typeof CollapsibleTriggerShell>)}
    />
  )
}

function CollapsibleContent({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleContent>) {
  return (
    <CollapsibleContentShell
      data-slot="collapsible-content"
      {...(props as React.ComponentProps<typeof CollapsibleContentShell>)}
    />
  )
}

export { Collapsible, CollapsibleContent, CollapsibleTrigger }
