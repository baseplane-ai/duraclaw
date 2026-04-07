import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { KataSessionState } from '@duraclaw/shared-types'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Find the most recent kata session state for a project.
 * Reads .kata/sessions/ directory, finds the session with the newest state.json,
 * and returns the parsed state. Returns null if no valid state is found.
 */
export async function findLatestKataState(projectPath: string): Promise<KataSessionState | null> {
  const sessionsDir = path.join(projectPath, '.kata', 'sessions')
  try {
    await fs.access(sessionsDir)
  } catch {
    return null
  }

  const entries = await fs.readdir(sessionsDir, { withFileTypes: true }).catch(() => null)
  if (!entries) return null

  let latest: { id: string; mtimeMs: number } | null = null
  for (const entry of entries) {
    if (!entry.isDirectory() || !UUID_RE.test(entry.name)) continue
    const stateFile = path.join(sessionsDir, entry.name, 'state.json')
    try {
      const { mtimeMs } = await fs.stat(stateFile)
      if (!latest || mtimeMs > latest.mtimeMs) {
        latest = { id: entry.name, mtimeMs }
      }
    } catch {
      // no state.json in this session dir
    }
  }

  if (!latest) return null

  try {
    const content = await fs.readFile(path.join(sessionsDir, latest.id, 'state.json'), 'utf-8')
    return JSON.parse(content) as KataSessionState
  } catch (err) {
    console.warn(`[cc-gateway] Failed to read kata state for session ${latest.id}:`, err)
    return null
  }
}
