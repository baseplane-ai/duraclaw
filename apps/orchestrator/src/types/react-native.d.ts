// GH#131 P2 — minimal ambient types for the smoke-bundle entry point.
//
// `entry-rn.tsx` imports `AppRegistry` from `react-native` so Metro
// can bootstrap the bundle. The Vite alias (`vite.config.ts`)
// rewrites that to `@tamagui/react-native-web-lite`, which doesn't
// publish full RN types via its exports map. Rather than install the
// full @types/react-native (large surface, only one consumer), we
// declare the small slice the smoke entry actually uses. If P3 adds
// more RN imports, swap this for the real type package.

declare module 'react-native' {
  import type { ComponentType } from 'react'

  export interface AppRegistryRunOptions {
    rootTag: HTMLElement
  }

  export const AppRegistry: {
    registerComponent(name: string, getComponent: () => ComponentType): string
    runApplication(name: string, options: AppRegistryRunOptions): void
  }
}

declare module '@expo/metro-runtime'
