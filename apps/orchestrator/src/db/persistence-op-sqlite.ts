/**
 * op-sqlite persistence adapter for TanStack DB on the Expo native target.
 *
 * Mirrors the shape of `persistence-capacitor.ts`: opens an op-sqlite
 * connection and wraps it in the `@duraclaw/op-sqlite-tanstack-persistence`
 * adapter that `persistedCollectionOptions` consumes.
 *
 * This module is dynamically imported by `db-instance.ts` ONLY when
 * `Platform.OS !== 'web'` AND we're inside the Expo runtime (Metro), so
 * the op-sqlite JSI bindings are tree-shaken out of the Vite web bundle
 * and the Vite Capacitor bundle alike.
 *
 * Why we pre-install the JSI proxy before importing op-sqlite:
 *
 * op-sqlite@15.2.12 contains a module-init side-effect that probes the
 * JSI proxy via the legacy bridge:
 *
 *   if (global.__OPSQLiteProxy == null) {
 *     if (NativeModules.OPSQLite == null) throw "Base module not found"
 *     const installed = NativeModules.OPSQLite.install()  // ← broken
 *     ...
 *   }
 *
 * Under React Native New Architecture (Fabric / TurboModules — which
 * Expo SDK 55 + `newArchEnabled: true` enable by default), TurboModules
 * are not exposed through `NativeModules` as plain bridge methods. RN's
 * compatibility layer returns a *stub* `NativeModules.OPSQLite` object
 * — `== null` is false, but `.install` is undefined. The legacy probe
 * then throws `TypeError: undefined is not a function`, which surfaces
 * as `[duraclaw-db] op-sqlite init failed` in db-instance.ts.
 *
 * The TurboModule spec ships in op-sqlite under `src/NativeOPSQLite.ts`
 * (`TurboModuleRegistry.getEnforcing<Spec>('OPSQLite')`) but the
 * functions.ts module-init code never calls it. We do the install here
 * via the same TurboModuleRegistry path *before* importing op-sqlite,
 * so by the time op-sqlite's module-init runs, `__OPSQLiteProxy` is
 * already set on `global` and the broken legacy probe is skipped.
 *
 * This is a workaround for an upstream bug. When op-sqlite ships a
 * release that uses TurboModuleRegistry directly in functions.ts (or
 * we move off Expo SDK 55's legacy interop), this preflight becomes
 * a no-op and can be removed.
 */

type TurboModuleSpec = { install: () => boolean }

/**
 * Pre-flight: install the op-sqlite JSI proxy via the TurboModule spec
 * so op-sqlite's broken legacy probe in functions.ts is skipped.
 *
 * Safe to call multiple times — idempotent via the `__OPSQLiteProxy`
 * guard. Throws if the TurboModule isn't registered (caller logs and
 * falls back to memory-only storage).
 */
async function ensureOpSqliteJsiInstalled(): Promise<void> {
  const g = globalThis as { __OPSQLiteProxy?: unknown }
  if (g.__OPSQLiteProxy != null) return

  const RN = (await import(/* @vite-ignore */ 'react-native')) as {
    TurboModuleRegistry?: {
      getEnforcing: <T>(name: string) => T
    }
  }
  if (!RN.TurboModuleRegistry) {
    throw new Error(
      'op-sqlite preflight: react-native.TurboModuleRegistry unavailable; New Architecture must be enabled',
    )
  }
  const turbo = RN.TurboModuleRegistry.getEnforcing<TurboModuleSpec>('OPSQLite')
  const installed = turbo.install()
  if (!installed) {
    throw new Error(
      'op-sqlite preflight: TurboModuleRegistry.install() returned false; native logs will have details',
    )
  }
  if (g.__OPSQLiteProxy == null) {
    throw new Error(
      'op-sqlite preflight: install() succeeded but __OPSQLiteProxy was not set on globalThis',
    )
  }
}

// All imports are dynamic + @vite-ignore so this file never adds a
// resolvable static import to the Vite (web/Capacitor) bundle. It is
// only reachable from db-instance.ts under the `isExpoNative()` branch,
// which Vite-built code never enters at runtime.
export async function createOpSqliteAdapter() {
  // MUST run before importing '@op-engineering/op-sqlite' — see file
  // header for why. The import side-effect probes the JSI proxy at
  // module load and throws if it's missing.
  await ensureOpSqliteJsiInstalled()

  const opSqlite = (await import(/* @vite-ignore */ '@op-engineering/op-sqlite')) as {
    open: (opts: { name: string }) => unknown
  }
  const persistenceMod = (await import(
    /* @vite-ignore */ '@duraclaw/op-sqlite-tanstack-persistence'
  )) as { createOpSqlitePersistence: (opts: unknown) => unknown }
  const database = opSqlite.open({ name: 'duraclaw.db' })
  // op-sqlite opens the connection synchronously; no `database.open()`
  // step is needed (unlike the Capacitor SQLite plugin).
  return persistenceMod.createOpSqlitePersistence({
    database,
    schemaMismatchPolicy: 'reset',
  })
}
