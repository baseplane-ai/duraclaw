// GH#125 P1a: Tamagui's `createTamagui()` registers the runtime config in
// a module-level singleton inside `@tamagui/web`. Components rendered by
// vitest tests reach `getConfig()` during render, but unless something
// imports `~/tamagui.config` first, the singleton stays empty and tests
// fail with "Missing tamagui config".
//
// Importing the config here in a setupFile guarantees `createTamagui()`
// fires before any test render. The runtime app already does this via
// __root.tsx → TamaguiProvider; tests skip the provider wrap, so this
// side-effect import is the equivalent shim.
import './tamagui.config'
