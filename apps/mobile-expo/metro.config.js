// Metro config for the Expo SDK 55 native target.
//
// Key constraints:
// - Watch the workspace root so packages/ai-elements, packages/shared-types,
//   packages/op-sqlite-tanstack-persistence, and apps/orchestrator/src all
//   resolve as siblings of node_modules.
// - Use a single resolver root so metro doesn't duplicate React across
//   workspace packages.
const path = require('node:path')
const { getDefaultConfig } = require('expo/metro-config')

const projectRoot = __dirname
const workspaceRoot = path.resolve(projectRoot, '../..')

const config = getDefaultConfig(projectRoot)

config.watchFolders = [workspaceRoot]
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
]
config.resolver.disableHierarchicalLookup = true

// Allow .ts/.tsx in node_modules (some workspace deps publish source).
config.resolver.sourceExts = [
  ...config.resolver.sourceExts.filter((ext) => ext !== 'svg'),
  'mjs',
  'cjs',
]

module.exports = config
