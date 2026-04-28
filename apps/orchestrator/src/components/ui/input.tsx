import { styled, View } from '@tamagui/core'
import type * as React from 'react'
import { cn } from '~/lib/utils'

// GH#125 P1a — Tamagui port of the shadcn Input.
//
// Tailwind escape hatch (kept in className via `cn()`):
//  - selection:* / file:* / placeholder:* pseudo-element selectors —
//    Tamagui can't reach these without the compiler.
//  - aria-invalid: ARIA-state selectors.
//  - text typography (text-base / md:text-sm) — @tamagui/core's Stack
//    base (View) doesn't accept TextStyle props.
// P1b-or-later: convert via Tamagui variant + selector primitives.
const INPUT_ESCAPE_CLASSES =
  'text-base md:text-sm selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground dark:bg-input/30 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40'

const InputShell = styled(View, {
  name: 'Input',
  render: 'input',
  display: 'flex',
  height: 36,
  width: '100%',
  minWidth: 0,
  borderRadius: '$md',
  borderWidth: 1,
  borderColor: '$input',
  backgroundColor: 'transparent',
  paddingHorizontal: 12,
  paddingVertical: 4,
  outlineWidth: 0,
  disabledStyle: { opacity: 0.5, cursor: 'not-allowed', pointerEvents: 'none' },
  focusStyle: {
    borderColor: '$ring',
    outlineColor: '$ring',
    outlineWidth: 3,
  },
})

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <InputShell
      data-slot="input"
      className={cn(INPUT_ESCAPE_CLASSES, className)}
      // type / name / value etc. flow through Tamagui's `render: 'input'`
      // path to the underlying <input>.
      {...({ type, ...props } as React.ComponentProps<typeof InputShell>)}
    />
  )
}

export { Input }
