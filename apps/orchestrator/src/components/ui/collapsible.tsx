import * as CollapsiblePrimitive from '@radix-ui/react-collapsible'
import type * as React from 'react'

// GH#125 P1a — shadcn Collapsible (Radix wrapper, zero styling).
//
// IMPORTANT: do NOT wrap any of these three Radix primitives in
// `styled()`. The Radix `Collapsible.Root` provides a React Context
// that `Trigger` and `Content` consume; wrapping `Root` in
// `styled(...)` creates an extra forwardRef boundary that breaks the
// context provider chain and yields the runtime error
//   "`CollapsibleContent` must be used within `Collapsible`"
// in production trees (caught during P1a after-screenshots; see
// planning/research/2026-04-28-gh125-screenshots/after-p1a/README.md).
// Tests passed because no test renders the full Trigger+Content pair.
//
// The collapsible has no styling of its own — Sidebar's Tailwind
// utility classes do all the work via the className escape hatch.
// Tamagui registry-consistency is not worth the production breakage.

function Collapsible({ ...props }: React.ComponentProps<typeof CollapsiblePrimitive.Root>) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />
}

function CollapsibleTrigger({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleTrigger>) {
  return <CollapsiblePrimitive.CollapsibleTrigger data-slot="collapsible-trigger" {...props} />
}

function CollapsibleContent({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleContent>) {
  return <CollapsiblePrimitive.CollapsibleContent data-slot="collapsible-content" {...props} />
}

export { Collapsible, CollapsibleContent, CollapsibleTrigger }
