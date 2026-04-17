import fs from 'node:fs/promises'
import path from 'node:path'
import type { ExitFile, MetaFile, PidFile, SessionStateSnapshot } from './types.js'

/**
 * Default directory for per-session control files. Overridden by
 * SESSIONS_DIR in production; tests point this at os.tmpdir().
 */
export const DEFAULT_SESSIONS_DIR = '/run/duraclaw/sessions'

/** Resolve the effective sessions directory from env. */
export function getSessionsDir(): string {
  return process.env.SESSIONS_DIR ?? DEFAULT_SESSIONS_DIR
}

/**
 * Injectable liveness check — defaults to `process.kill(pid, 0)` but tests
 * pass a stub so we never hit a real PID. Returns true iff the OS still
 * has a process with this PID and the current process can signal it.
 */
export type LivenessCheck = (pid: number) => boolean

export function defaultLivenessCheck(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

/** Zero / null defaults for the meta fields when meta.json is missing. */
function emptyMeta(): Omit<MetaFile, 'state'> {
  return {
    sdk_session_id: null,
    last_activity_ts: null,
    last_event_seq: 0,
    cost: { input_tokens: 0, output_tokens: 0, usd: 0 },
    model: null,
    turn_count: 0,
  }
}

function mergeMeta(meta: MetaFile | null): Omit<MetaFile, 'state'> {
  if (!meta) return emptyMeta()
  return {
    sdk_session_id: meta.sdk_session_id ?? null,
    last_activity_ts: meta.last_activity_ts ?? null,
    last_event_seq: meta.last_event_seq ?? 0,
    cost: meta.cost ?? { input_tokens: 0, output_tokens: 0, usd: 0 },
    model: meta.model ?? null,
    turn_count: meta.turn_count ?? 0,
  }
}

export type ResolveResult = { found: true; state: SessionStateSnapshot } | { found: false }

/**
 * Resolve the current state of a session from its on-disk files.
 *
 * Precedence (matches B5):
 *  1. `.exit` present → terminal state from exit file; meta fields merged in.
 *  2. `.pid` present AND live → state="running"; meta fields merged in.
 *  3. `.pid` present AND dead → state="crashed"; meta fields merged in.
 *  4. Neither → `{ found: false }` (caller translates to 404).
 */
export async function resolveSessionState(
  sessionsDir: string,
  sessionId: string,
  isAlive: LivenessCheck = defaultLivenessCheck,
): Promise<ResolveResult> {
  const pidPath = path.join(sessionsDir, `${sessionId}.pid`)
  const exitPath = path.join(sessionsDir, `${sessionId}.exit`)
  const metaPath = path.join(sessionsDir, `${sessionId}.meta.json`)

  const [pid, exit, meta] = await Promise.all([
    readJsonIfExists<PidFile>(pidPath),
    readJsonIfExists<ExitFile>(exitPath),
    readJsonIfExists<MetaFile>(metaPath),
  ])

  if (!pid && !exit) return { found: false }

  let state: SessionStateSnapshot['state']
  if (exit) {
    state = exit.state
  } else if (pid && isAlive(pid.pid)) {
    state = 'running'
  } else {
    state = 'crashed'
  }

  return {
    found: true,
    state: {
      session_id: sessionId,
      state,
      ...mergeMeta(meta),
    },
  }
}
