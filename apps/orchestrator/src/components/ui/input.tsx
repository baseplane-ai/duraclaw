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

// GH#125 P1b hotfix — the Tamagui compiler is dropping token-referenced
// border / bg / color props in the styled() shell below (no
// _borderColor-input, no _backgroundColor-primary in extracted CSS), so
// the Input renders without visible borders. Layer the original shadcn
// Tailwind utilities via cn() so border + height + radius + padding +
// transition + focus-visible resolve through CSS variables defined in
// theme.css. tailwind-merge in cn() dedups; the styled() shell's
// remaining layout atoms still emit and serve as a backup.
const INPUT_BASE_CLASSES =
  'flex h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 shadow-xs transition-[color,box-shadow] outline-none disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50'

const InputShell = styled(View, {
  name: 'Input',
  render: 'input',
  display: 'flex',
  // Tamagui View defaults to flexDirection: 'column'. <input> has no
  // rendered DOM children so the value doesn't matter visually here,
  // but declaring it explicitly satisfies the styled-flex-direction
  // guard and protects against future restyles.
  flexDirection: 'row',
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
      className={cn(INPUT_BASE_CLASSES, INPUT_ESCAPE_CLASSES, className)}
      // type / name / value etc. flow through Tamagui's `render: 'input'`
      // path to the underlying <input>.
      {...({ type, ...props } as React.ComponentProps<typeof InputShell>)}
    />
  )
}

export { Input }
