import * as TabsPrimitive from '@radix-ui/react-tabs'
import { styled } from '@tamagui/core'
import type * as React from 'react'
import { cn } from '~/lib/utils'

// GH#125 P1a — Tamagui port of the shadcn Tabs (Radix wrapper, 4
// subcomponents). Pure structural styling around Radix Tabs internals.
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

const TABS_TRIGGER_ESCAPE_CLASSES =
  "h-[calc(100%-1px)] text-sm font-medium whitespace-nowrap text-foreground transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-background data-[state=active]:shadow-sm dark:text-muted-foreground dark:data-[state=active]:border-input dark:data-[state=active]:bg-input/30 dark:data-[state=active]:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"

const TabsShell = styled(TabsPrimitive.Root, {
  name: 'Tabs',
  display: 'flex',
  flexDirection: 'column',
  gap: '$2',
})

const TabsListShell = styled(TabsPrimitive.List, {
  name: 'TabsList',
  display: 'inline-flex',
  height: 36,
  width: 'fit-content',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: '$lg',
  backgroundColor: '$muted',
  padding: 3,
  color: '$mutedForeground',
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
  flex: 1,
  outlineWidth: 0,
})

function Tabs({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsShell
      data-slot="tabs"
      className={cn(className)}
      {...(props as React.ComponentProps<typeof TabsShell>)}
    />
  )
}

function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsListShell
      data-slot="tabs-list"
      className={cn(className)}
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
      className={cn(className)}
      {...(props as React.ComponentProps<typeof TabsContentShell>)}
    />
  )
}

export { Tabs, TabsContent, TabsList, TabsTrigger }
