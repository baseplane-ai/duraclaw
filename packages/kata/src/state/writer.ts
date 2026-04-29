import fs from 'node:fs/promises'
import path from 'node:path'
import { loadKataConfig } from '../config/kata-config.js'
import { type SessionState, SessionStateSchema } from './schema.js'

/**
 * Validate that `state.currentMode` is registered in kata.yaml's modes hash.
 *
 * GH#116 P5: orchestrator no longer enforces mode names — kata is the
 * single source of truth for valid mode strings via its own `kata.yaml`
 * `modes:` registry. This pre-write check guards against typos /
 * stale-state writes that would otherwise propagate a bogus
 * `currentMode` into the session state file.
 *
 * Null / undefined `currentMode` passes — between-mode transient state
 * is legitimate (legacy session files, sessions in setup phase, etc.).
 *
 * @throws Error if `currentMode` is set but not in kata.yaml's modes hash
 */
function validateCurrentMode(state: SessionState): void {
  if (state.currentMode == null) return
  let config: ReturnType<typeof loadKataConfig>
  try {
    config = loadKataConfig()
  } catch {
    // No kata.yaml available (eval harness, fresh project, etc.) — skip
    // validation. The schema-level check still runs on the full state.
    return
  }
  if (!config.modes[state.currentMode]) {
    throw new Error(`Mode '${state.currentMode}' not registered in kata.yaml`)
  }
}

/**
 * Write session state to file atomically
 *
 * Uses atomic write pattern:
 * 1. Validate with Zod
 * 2. Validate mode against kata.yaml registered modes
 * 3. Write to temp file (stateFile + '.tmp')
 * 4. Rename temp to final (atomic on same filesystem)
 *
 * @param stateFile - Path to state.json file
 * @param state - Session state to write
 * @throws Error if validation fails or write fails
 */
export async function writeState(stateFile: string, state: SessionState): Promise<void> {
  // 1. Validate state schema
  const validated = SessionStateSchema.parse(state)

  // 2. Validate mode is registered in kata.yaml
  validateCurrentMode(validated)

  // 3. Ensure directory exists
  const dir = path.dirname(stateFile)
  await fs.mkdir(dir, { recursive: true })

  // 4. Write to temp file
  const tempFile = `${stateFile}.tmp`
  const content = JSON.stringify(validated, null, 2)
  await fs.writeFile(tempFile, content, 'utf-8')

  // 5. Atomic rename (same filesystem)
  await fs.rename(tempFile, stateFile)
}

/**
 * Update existing state with partial updates
 *
 * Reads current state, merges updates, writes atomically.
 * Sets updatedAt timestamp automatically.
 *
 * @param stateFile - Path to state.json file
 * @param updates - Partial state updates
 * @returns Updated state
 */
export async function updateState(
  stateFile: string,
  updates: Partial<SessionState>,
): Promise<SessionState> {
  const { readState } = await import('./reader.js')

  const current = await readState(stateFile)
  const updated: SessionState = {
    ...current,
    ...updates,
    updatedAt: new Date().toISOString(),
  }

  await writeState(stateFile, updated)
  return updated
}
