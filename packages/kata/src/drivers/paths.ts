// src/drivers/paths.ts
// Per-driver user-level config path helpers

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Driver } from './types.js'

/**
 * Returns the path to the user-level hook config file for a given driver.
 * - claude → ~/.claude/settings.json
 * - codex  → ~/.codex/hooks.json
 */
export function getUserSettingsPath(driver: Driver): string {
  if (driver.name === 'claude') {
    return join(homedir(), '.claude', 'settings.json')
  }
  return join(homedir(), '.codex', 'hooks.json')
}
