/**
 * GH#115 §B-KATA-1: kata-side worktree auto-reserve.
 *
 * Code-touching modes ({debug, implementation, verify, task}) reserve
 * a clone from the orchestrator's pool. Read-only modes
 * ({research, planning, freeform, onboard}) skip — they run in
 * whatever cwd the user invoked kata in.
 *
 * The orchestrator's POST /api/worktrees handler enforces same-
 * `reservedBy` idempotency (B-CONCURRENCY-3), so retries (e.g. user
 * runs `kata enter implementation --issue=123` twice) reuse the same
 * row.
 *
 * Returns null when no reservation was made (read-only mode or
 * caller passed allowReadOnly=false elsewhere). Throws on transport
 * failure; the caller decides whether to surface a fatal error.
 */

export const CODE_TOUCHING_MODES = new Set<string>([
  'debug',
  'implementation',
  'verify',
  'task',
])

export const READ_ONLY_MODES = new Set<string>([
  'research',
  'planning',
  'freeform',
  'onboard',
])

export interface ReservedBy {
  kind: 'arc' | 'session' | 'manual'
  id: string | number
}

export interface WorktreeRow {
  id: string
  path: string
  branch: string | null
  status: 'free' | 'held' | 'active' | 'cleanup'
  reservedBy: ReservedBy | null
  ownerId: string
  releasedAt: number | null
  createdAt: number
  lastTouchedAt: number
}

export interface ReserveOptions {
  /** Base URL of the orchestrator API. e.g. `http://127.0.0.1:43054` */
  orchestratorBaseUrl: string
  /** kata session id (UUID-like). Used as `reservedBy.id` when no kataIssue is set. */
  sessionId: string
  /** Mode the user is entering. */
  mode: string
  /** Optional GH issue number; populates `reservedBy.kind='arc'` when present. */
  kataIssue?: number | null
  /** Bearer token for orchestrator auth, if the API requires one. Optional. */
  authToken?: string
}

export type ReserveOutcome =
  | { kind: 'reserved'; row: WorktreeRow }
  | { kind: 'skipped'; reason: 'read_only_mode' | 'unknown_mode' }

/**
 * Thrown by `reserveWorktreeIfNeeded` when the orchestrator returns
 * 503 pool_exhausted. Surfaces the structured fields so the CLI
 * front-end can format a clean stderr line and exit; library callers
 * (eval harness, tests) can `instanceof`-check and handle it without
 * the helper unilaterally calling `process.exit`.
 */
export class PoolExhaustedError extends Error {
  freeCount: number
  totalCount: number
  hint: string
  constructor(freeCount: number, totalCount: number, hint: string) {
    super(`Worktree pool exhausted (free=${freeCount} total=${totalCount}). ${hint}`)
    this.name = 'PoolExhaustedError'
    this.freeCount = freeCount
    this.totalCount = totalCount
    this.hint = hint
  }
}

/**
 * Resolve the orchestrator base URL from env. Falls back to the
 * worktree-derived dev port via VERIFY_ORCH_PORT (set by
 * scripts/verify/common.sh -> sync_dev_vars). Returns null if
 * neither is set — caller treats as "kata not running in a duraclaw
 * worktree" and skips the reservation entirely.
 */
export function getOrchestratorBaseUrl(
  env?: Record<string, string | undefined>,
): string | null {
  const e = env ?? process.env
  if (e.DURACLAW_ORCH_URL) return e.DURACLAW_ORCH_URL.replace(/\/$/, '')
  if (e.VERIFY_ORCH_PORT) return `http://127.0.0.1:${e.VERIFY_ORCH_PORT}`
  return null
}

export async function reserveWorktreeIfNeeded(
  opts: ReserveOptions,
): Promise<ReserveOutcome> {
  const { orchestratorBaseUrl, sessionId, mode, kataIssue, authToken } = opts

  if (READ_ONLY_MODES.has(mode)) {
    return { kind: 'skipped', reason: 'read_only_mode' }
  }
  if (!CODE_TOUCHING_MODES.has(mode)) {
    return { kind: 'skipped', reason: 'unknown_mode' }
  }

  const reservedBy: ReservedBy =
    typeof kataIssue === 'number' && kataIssue > 0
      ? { kind: 'arc', id: kataIssue }
      : { kind: 'session', id: sessionId }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }
  if (authToken) {
    headers.authorization = `Bearer ${authToken}`
  }

  const url = `${orchestratorBaseUrl.replace(/\/$/, '')}/api/worktrees`
  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ kind: 'fresh', reservedBy }),
    signal: AbortSignal.timeout(5000),
  })

  if (resp.status === 200) {
    const row = (await resp.json()) as WorktreeRow
    return { kind: 'reserved', row }
  }

  if (resp.status === 503) {
    let body: {
      error?: string
      freeCount?: number
      totalCount?: number
      hint?: string
    } = {}
    try {
      body = (await resp.json()) as typeof body
    } catch {
      // Body wasn't JSON — fall through with empty fields.
    }
    if (body.error === 'pool_exhausted') {
      const freeCount = body.freeCount ?? 0
      const totalCount = body.totalCount ?? 0
      const hint = body.hint ?? 'Add a clone to the pool.'
      throw new PoolExhaustedError(freeCount, totalCount, hint)
    }
  }

  let body = ''
  try {
    body = await resp.text()
  } catch {
    // ignore — already failing, body is best-effort
  }
  throw new Error(`kata reserve-worktree: HTTP ${resp.status}: ${body}`)
}
