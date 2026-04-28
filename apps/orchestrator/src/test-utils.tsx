// GH#125 P1a: shared test helpers. Re-exports @testing-library/react's API
// with a custom `render()` that wraps in TamaguiProvider — Tamagui-styled
// primitives (button/card/input/label/etc.) read from context at render
// time and throw "Missing theme" when rendered bare.
//
// Usage:
//   import { render, screen, fireEvent } from '~/test-utils'
//
// instead of importing from '@testing-library/react' directly. The setup
// file (vitest.config.ts → setupFiles) handles `createTamagui()`'s
// global-singleton registration; this helper handles the React-tree
// provider context.

import { TamaguiProvider } from '@tamagui/core'
import { type RenderOptions, type RenderResult, render as rtlRender } from '@testing-library/react'
import type { ReactElement, ReactNode } from 'react'
import { tamaguiConfig } from './tamagui.config'

function TestProviders({ children }: { children: ReactNode }) {
  return (
    <TamaguiProvider config={tamaguiConfig} defaultTheme="light">
      {children}
    </TamaguiProvider>
  )
}

export function render(ui: ReactElement, options?: RenderOptions): RenderResult {
  return rtlRender(ui, { wrapper: TestProviders, ...options })
}

// Re-export everything else from @testing-library/react so tests can do a
// single import statement.
export {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
