// Metro config for the Expo SDK 55 native target.
//
// Key constraints:
// - Watch the workspace root so packages/ai-elements, packages/shared-types,
//   packages/op-sqlite-tanstack-persistence, and apps/orchestrator/src all
//   resolve as siblings of node_modules.
// - Use a single resolver root so metro doesn't duplicate React across
//   workspace packages.
// - Include apps/orchestrator/node_modules as a resolver path because
//   entry-rn.tsx (in apps/orchestrator/src/) imports orchestrator's own
//   deps (@tanstack/*, better-auth, etc.) which pnpm only symlinks under
//   apps/orchestrator/node_modules. With disableHierarchicalLookup=true
//   Metro won't walk up the directory tree to find them — it relies on
//   this explicit list. Native-only branches (Platform.OS gates) are
//   tree-shaken by babel-preset-expo so web-only deps inside those
//   branches never hit Metro's resolver. (Required for VP-2 — fixed
//   during VP-11 verification of GH#132 P3.)
const path = require('node:path')
const { getDefaultConfig } = require('expo/metro-config')

const projectRoot = __dirname
const workspaceRoot = path.resolve(projectRoot, '../..')

const config = getDefaultConfig(projectRoot)

config.watchFolders = [workspaceRoot]
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'apps/orchestrator/node_modules'),
  path.resolve(workspaceRoot, 'packages/ai-elements/node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
]
config.resolver.disableHierarchicalLookup = true

// Capacitor-only modules that Metro statically bundles (because they
// live in dead-code branches Metro doesn't tree-shake). They throw at
// runtime if reached — but they never are, because db-instance.ts and
// platform.ts test isExpoNative() first and return before reaching
// the Capacitor fallback. Stub them so Metro's parser doesn't choke on
// their internal Node-only dynamic imports (e.g. capacitor-sqlite-driver
// uses `import(getNodeAsyncHooksSpecifier())` which Metro rejects).
const NATIVE_STUB = path.resolve(projectRoot, 'native-stubs/empty.js')
const CAPACITOR_STUBS = new Set([
  '@tanstack/capacitor-db-sqlite-persistence',
  'better-auth-capacitor',
  'better-auth-capacitor/client',
  '@capacitor/core',
  '@capacitor/app',
  '@capacitor/network',
  '@capacitor/preferences',
  '@capacitor/push-notifications',
  '@capacitor-community/sqlite',
  '@capgo/capacitor-updater',
])
const originalResolveRequest = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (CAPACITOR_STUBS.has(moduleName)) {
    return { type: 'sourceFile', filePath: NATIVE_STUB }
  }
  if (originalResolveRequest) {
    return originalResolveRequest(context, moduleName, platform)
  }
  return context.resolveRequest(context, moduleName, platform)
}

// Allow .ts/.tsx in node_modules (some workspace deps publish source).
config.resolver.sourceExts = [
  ...config.resolver.sourceExts.filter((ext) => ext !== 'svg'),
  'mjs',
  'cjs',
]

module.exports = config
