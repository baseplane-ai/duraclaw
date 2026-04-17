import fs from 'node:fs/promises'
import {
  defaultLivenessCheck,
  getSessionsDir,
  type LivenessCheck,
  resolveSessionState,
} from './session-state.js'
import type { SessionStateSnapshot } from './types.js'

const PID_SUFFIX = '.pid'

/**
 * Scan the sessions directory for `*.pid` files and return a state snapshot
 * per session. Missing directory → empty array. Entries whose resolver
 * returns `found:false` (raced unlink) are dropped.
 *
 * `isAlive` is injected so tests can exercise live/dead pid combinations
 * without ever actually spawning a process.
 */
export async function listSessions(
  sessionsDir: string = getSessionsDir(),
  isAlive: LivenessCheck = defaultLivenessCheck,
): Promise<SessionStateSnapshot[]> {
  let entries: string[]
  try {
    entries = await fs.readdir(sessionsDir)
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return []
    throw err
  }

  const sessionIds = entries
    .filter((name) => name.endsWith(PID_SUFFIX))
    .map((name) => name.slice(0, -PID_SUFFIX.length))

  const results = await Promise.all(
    sessionIds.map(async (id) => {
      const res = await resolveSessionState(sessionsDir, id, isAlive)
      return res.found ? res.state : null
    }),
  )

  return results.filter((s): s is SessionStateSnapshot => s !== null)
}
