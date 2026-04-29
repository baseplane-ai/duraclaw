// GH#131 P2 — Metro config for the smoke-bundle CI gate.
//
// This config is NOT used to ship a production native bundle. The web
// build still goes through Vite (see `vite.config.ts`). The only
// purpose of this file is to enable `metro build` (invoked from
// `scripts/check-metro-bundle.sh`) to prove that the orchestrator's
// source tree resolves cleanly under a Metro+RN target — the
// concrete proof that P2's renderer swap actually unlocks P3.
//
// pnpm-monorepo recipe: `watchFolders` includes the workspace root
// and root `node_modules` so Metro can follow symlinks to hoisted
// pnpm packages. `unstable_enablePackageExports` and
// `unstable_enableSymlinks` are required for any package that
// publishes via the modern exports map (Tamagui v2-rc.41 does, as do
// most of our deps).

const path = require('node:path')
const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)

config.watchFolders = [
  path.resolve(__dirname, '../..'),
  path.resolve(__dirname, '../../node_modules'),
]
config.resolver.unstable_enablePackageExports = true
config.resolver.unstable_enableSymlinks = true
config.resolver.disableHierarchicalLookup = false

// GH#131 P2 — Capacitor-only stub list. These packages contain
// non-static dynamic imports (e.g. `await import(getSpecifier())`)
// that Metro's babel transform rejects. They are dead code on the
// web bundle (the Capacitor runtime guards them), so we point Metro
// at an empty stub. Vite is unaffected — the production web build
// uses the real modules.
const STUBBED_PACKAGES = new Set([
  '@tanstack/capacitor-db-sqlite-persistence',
])
const EMPTY_STUB = path.resolve(__dirname, 'src/metro-stubs/empty.js')

const upstreamResolveRequest = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (STUBBED_PACKAGES.has(moduleName)) {
    return { type: 'sourceFile', filePath: EMPTY_STUB }
  }
  if (upstreamResolveRequest) {
    return upstreamResolveRequest(context, moduleName, platform)
  }
  return context.resolveRequest(context, moduleName, platform)
}

module.exports = config
