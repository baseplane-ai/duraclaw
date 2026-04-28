import * as TabsPrimitive from '@radix-ui/react-tabs'
import { styled } from '@tamagui/core'
import type * as React from 'react'
import { cn } from '~/lib/utils'

// GH#125 P1a — Tamagui port of the shadcn Tabs (Radix wrapper, 4
// subcomponents). Pure structural styling around Radix Tabs internals.
//
// IMPORTANT: `TabsPrimitive.Root` is a context provider for the
// active-tab state that `List`, `Trigger`, and `Content` consume.
// Wrapping it in `styled(...)` breaks the provider chain (same
// pathology as collapsible.tsx and avatar.tsx — caught during P1a
// after-screenshots). Root keeps the bare-Radix shape with a
// className escape-hatch for the flex/gap layout. The leaf shells
// (List, Trigger, Content) are consumers and can wear `styled()`.
//
// Tailwind escape hatch (kept in className via `cn()`):
//  - text typography (text-sm font-medium whitespace-nowrap) — View's
//    StackStyle rejects TextStyle props in v2-rc.41 runtime.
//  - data-[state=active]:* — Tamagui can't observe Radix's data-state
//    attribute without the compiler. The active-tab visuals (bg, shadow,
//    border in dark) all live here.
//  - focus-visible:* / disabled:* / dark:* prefix selectors.
//  - [&_svg]:* descendant selectors.
//  - [calc(100%-1px)] arbitrary-value height for the trigger.
//
// GH#130 follow-up — the Tamagui v2-rc.41 compiler with `extract: true`
// silently drops several styled() props from the emitted atomic CSS:
//  - `padding: 3` (numeric shorthand resolved against `space.3`) — no
//    `_paddingTop-t-space-3` etc. emitted, so the muted pill loses its
//    inner inset.
//  - `borderRadius: '$lg'` — no `_btlr-t-radius-lg` etc. emitted, so the
//    pill loses its rounding.
//  - `color: '$mutedForeground'` — no `_color-mutedForeground` emitted,
//    so the inactive trigger text inherits the page foreground colour.
//  Same root-cause family as the Button buttonVariants() fallback in
//  78d4484/93a074e. In dev mode Tamagui's runtime fallback fills these
//  in (TabsList renders correctly with `pnpm dev`), but in the
//  production build the missing atoms produce the "inline plain text"
//  regression reported on `code.8020os.com` (issue #130 comment).
//  Layer Tailwind utilities for the dropped visuals so they render
//  through CSS variables regardless of compiler extraction.

const TABS_ROOT_CLASSES = 'flex flex-col gap-2'

const TABS_LIST_ESCAPE_CLASSES = 'rounded-lg p-[3px] text-muted-foreground'

const TABS_TRIGGER_ESCAPE_CLASSES =
  "h-[calc(100%-1px)] text-sm font-medium whitespace-nowrap text-foreground transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-background data-[state=active]:shadow-sm dark:text-muted-foreground dark:data-[state=active]:border-input dark:data-[state=active]:bg-input/30 dark:data-[state=active]:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"

// GH#130 follow-up — `flex-1` lives in className, not the styled() shell.
// Tamagui's `flex: 1` expands to `_flexGrow-1 _flexShrink-1 _fb-0px
// _minHeight-0px` (RN-style). The `_minHeight-0px` atom collapses
// TabsContent below intrinsic height when the grandparent (CardContent /
// Tabs Root) has no fixed height, then the production build's content
// surface clips the overflowing children — the "RadioGroup collapsed to
// 1 row" symptom on the dogfood deploy. Tailwind's `.flex-1` (`flex: 1
// 1 0%`) leaves `min-height: auto` so content drives the height.
const TABS_CONTENT_ESCAPE_CLASSES = 'flex-1'

const TabsListShell = styled(TabsPrimitive.List, {
  name: 'TabsList',
  display: 'inline-flex',
  // GH#125 follow-up — minHeight not height. Tamagui atomic `_height-36px`
  // (specificity 0,2,0 via `:root .className`) silently beats Tailwind
  // `.h-N` (0,1,0); consumers passing `className="h-auto"` to fit a
  // multi-line tab list got their override ignored and content clipped
  // by the row's overflow. minHeight preserves the 36px floor while
  // letting consumers grow.
  minHeight: 36,
  width: 'fit-content',
  alignItems: 'center',
  justifyContent: 'center',
  backgroundColor: '$muted',
})

const TabsTriggerShell = styled(TabsPrimitive.Trigger, {
  name: 'TabsTrigger',
  display: 'inline-flex',
  flex: 1,
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  borderRadius: '$md',
  borderWidth: 1,
  borderColor: 'transparent',
  paddingHorizontal: 8,
  paddingVertical: 4,
})

const TabsContentShell = styled(TabsPrimitive.Content, {
  name: 'TabsContent',
  outlineWidth: 0,
})

function Tabs({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root data-slot="tabs" className={cn(TABS_ROOT_CLASSES, className)} {...props} />
  )
}

function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsListShell
      data-slot="tabs-list"
      className={cn(TABS_LIST_ESCAPE_CLASSES, className)}
      {...(props as React.ComponentProps<typeof TabsListShell>)}
    />
  )
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsTriggerShell
      data-slot="tabs-trigger"
      className={cn(TABS_TRIGGER_ESCAPE_CLASSES, className)}
      {...(props as React.ComponentProps<typeof TabsTriggerShell>)}
    />
  )
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsContentShell
      data-slot="tabs-content"
      className={cn(TABS_CONTENT_ESCAPE_CLASSES, className)}
      {...(props as React.ComponentProps<typeof TabsContentShell>)}
    />
  )
}

export { Tabs, TabsContent, TabsList, TabsTrigger }
