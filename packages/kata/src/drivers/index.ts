// src/drivers/index.ts
// Driver registry — public API for the drivers module
export type { CanonicalHookInput, CanonicalHookOutput, NativeTask, NativeTaskStore, Driver } from './types.js'
export { getUserSettingsPath } from './paths.js'
export { claudeDriver } from './claude.js'
export { codexDriver } from './codex.js'
export { detectInstalled } from './detect.js'

import { claudeDriver } from './claude.js'
import { codexDriver } from './codex.js'
import type { Driver } from './types.js'

const REGISTRY: Record<string, Driver> = {
  claude: claudeDriver,
  codex: codexDriver,
}

/**
 * Get a driver by name. Throws if name is not recognised.
 */
export function getDriver(name: 'claude' | 'codex'): Driver {
  const driver = REGISTRY[name]
  if (!driver) throw new Error(`Unknown driver: ${name}`)
  return driver
}

/**
 * Returns all registered drivers (both claude and codex), regardless of install status.
 */
export function listDrivers(): Driver[] {
  return [claudeDriver, codexDriver]
}
