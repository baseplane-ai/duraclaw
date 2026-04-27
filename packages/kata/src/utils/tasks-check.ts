import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Driver-keyed env-var names for native task enablement.
 * codex has no equivalent gate — tasks are always enabled.
 */
export const DRIVER_TASK_ENV_VARS: Record<string, string | null> = {
  claude: 'CLAUDE_CODE_ENABLE_TASKS',
  codex: null, // no equivalent — always enabled under codex
}

/**
 * Check whether native tasks are enabled for the given driver.
 *
 * For claude: checks CLAUDE_CODE_ENABLE_TASKS env var (runtime or ~/.claude/settings.json).
 * For codex: always returns true (no equivalent gate).
 *
 * @param driver - driver name; defaults to 'claude' for backwards compat
 */
export function isNativeTasksEnabled(driver = 'claude'): boolean {
  const envVar = DRIVER_TASK_ENV_VARS[driver]

  // codex (or any driver with null env var): always enabled
  if (envVar === null) return true

  // Runtime env takes precedence
  if (process.env[envVar] === 'false') return false
  if (process.env[envVar] === 'true') return true

  // Fall back to ~/.claude/settings.json (claude-specific path)
  if (driver === 'claude') {
    try {
      const settingsPath = join(homedir(), '.claude', 'settings.json')
      if (existsSync(settingsPath)) {
        const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
        const envBlock = settings.env as Record<string, unknown> | undefined
        if (envBlock?.[envVar] === 'false') return false
      }
    } catch {
      // Ignore parse errors — assume enabled
    }
  }

  return true
}
