import { styled, View } from '@tamagui/core'
import type * as React from 'react'
import { cn } from '~/lib/utils'

// GH#125 P1a — Tamagui port of the shadcn Textarea.
//
// Tailwind escape hatch (kept in className via `cn()`):
//  - text typography (text-base / md:text-sm) — View's StackStyle
//    rejects TextStyle props in v2-rc.41 runtime.
//  - placeholder:* pseudo-element selector.
//  - aria-invalid:* / focus-visible:* ARIA-state selectors.
//  - field-sizing-content — Tailwind shim for the new CSS field-sizing
//    property; not exposed via Tamagui StackStyle.
//  - dark:* prefix selectors.
//  - shadow-xs / transition-[color,box-shadow] — kept in className for
//    parity with input.tsx (which keeps shadow stylings out of the
//    Tamagui shadow* props because the Tailwind tokens differ).
const TEXTAREA_ESCAPE_CLASSES =
  'field-sizing-content text-base md:text-sm placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:bg-input/30 dark:aria-invalid:ring-destructive/40 shadow-xs transition-[color,box-shadow]'

const TextareaShell = styled(View, {
  name: 'Textarea',
  render: 'textarea',
  display: 'flex',
  // Tamagui View defaults to flexDirection: 'column'. <textarea> has
  // no rendered DOM children so the value doesn't matter visually,
  // but declaring it explicitly satisfies the styled-flex-direction
  // guard alongside InputShell.
  flexDirection: 'row',
  minHeight: 64,
  width: '100%',
  borderRadius: '$md',
  borderWidth: 1,
  borderColor: '$input',
  backgroundColor: 'transparent',
  paddingHorizontal: 12,
  paddingVertical: 8,
  outlineWidth: 0,
})

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <TextareaShell
      data-slot="textarea"
      className={cn(TEXTAREA_ESCAPE_CLASSES, className)}
      {...(props as React.ComponentProps<typeof TextareaShell>)}
    />
  )
}

export { Textarea }
