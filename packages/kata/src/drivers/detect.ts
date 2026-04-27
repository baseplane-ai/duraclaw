// src/drivers/detect.ts
// Driver detection — returns installed drivers by checking PATH
import type { Driver } from './types.js'
import { claudeDriver } from './claude.js'
import { codexDriver } from './codex.js'

/**
 * Returns all drivers whose CLI binary is present on PATH.
 * Order: claude first, codex second.
 */
export function detectInstalled(): Driver[] {
  const installed: Driver[] = []
  if (claudeDriver.isInstalled()) installed.push(claudeDriver)
  if (codexDriver.isInstalled()) installed.push(codexDriver)
  return installed
}
