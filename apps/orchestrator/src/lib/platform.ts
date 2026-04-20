/// <reference types="vite/client" />

/**
 * Platform detection helpers for Capacitor vs web.
 *
 * `isNative()` keys off `import.meta.env.VITE_PLATFORM`, a build-time flag
 * set to `'capacitor'` in the mobile build (`apps/mobile/.env.production`)
 * and unset on the web build. Vite substitutes the literal value at build
 * time, so call sites like `if (isNative())` are tree-shaken on web —
 * the Capacitor SQLite plugin and other native-only modules are never
 * bundled into the browser build.
 *
 * `apiBaseUrl()` and `wsBaseUrl()` are added in P3a; `apiUrl()` lands in P2.
 */

export function isNative(): boolean {
  return import.meta.env.VITE_PLATFORM === 'capacitor'
}
