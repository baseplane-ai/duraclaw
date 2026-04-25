import { type SpawnSyncReturns, spawnSync } from 'node:child_process'

// Resolved per-call so vitest tests setting process.env after import still hit.
const CAAM_BIN = (): string => process.env.CAAM_BIN || 'caam'
const TIMEOUT_MS = 5_000

// ── Wire types from caam JSON output (best-effort, all fields optional) ──
interface CaamLsRow {
  name: string
  active?: boolean
  system?: boolean
  plan?: string | null
  health?: { expires_at?: string | number | null } | null
}

interface CaamLimitsRow {
  name: string
  util_7d_pct?: number | null
  resets_at?: string | number | null
}

interface CaamCooldownRow {
  name: string
  until?: string | number | null
}

// ── Output type — merged row, gateway → worker shape ────────────────────
export interface CaamProfileMerged {
  name: string
  active: boolean
  system: boolean
  plan: string | null
  util_7d_pct: number | null
  resets_at: string | null
  cooldown_until: string | null
}

interface CaamProfilesBody {
  profiles: CaamProfileMerged[]
}

// ── HTTP helper (mirror of server.ts json()) ────────────────────────────

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// ── Internals ───────────────────────────────────────────────────────────

/** Convert a Unix-second number or ISO/string timestamp to an ISO string. */
function toIso(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Treat as Unix seconds; the caam CLI emits seconds for both
    // `resets_at` and `health.expires_at` / `cooldown.until`.
    const ms = value < 1e12 ? value * 1000 : value
    const d = new Date(ms)
    if (Number.isNaN(d.getTime())) return null
    return d.toISOString()
  }
  if (typeof value === 'string' && value.length > 0) {
    const d = new Date(value)
    if (!Number.isNaN(d.getTime())) return d.toISOString()
    return value
  }
  return null
}

/** True when spawnSync indicates the caam binary itself is absent. */
function isMissingBinary(result: SpawnSyncReturns<Buffer | string>): boolean {
  const errCode = (result.error as NodeJS.ErrnoException | undefined)?.code
  if (errCode === 'ENOENT') return true
  // Some shells / wrappers surface ENOENT via the parent process exit (127).
  if (result.status === 127) {
    const stderr = String(result.stderr ?? '')
    if (/not found|no such file|command not found/i.test(stderr)) return true
  }
  return false
}

/** True when spawnSync was killed by our timeout (Node sets signal=SIGTERM). */
function isTimedOut(result: SpawnSyncReturns<Buffer | string>): boolean {
  return result.status === null && result.signal === 'SIGTERM'
}

interface RunResult {
  ok: boolean
  stdout: string
  stderr: string
  /** 'missing' = binary not found; 'timeout' = killed via TIMEOUT_MS; 'error' = non-zero exit */
  failure?: 'missing' | 'timeout' | 'error'
}

function runCaam(args: string[]): RunResult {
  const result = spawnSync(CAAM_BIN(), args, {
    encoding: 'utf-8',
    timeout: TIMEOUT_MS,
  })
  if (isMissingBinary(result)) {
    return { ok: false, stdout: '', stderr: String(result.stderr ?? ''), failure: 'missing' }
  }
  if (isTimedOut(result)) {
    return { ok: false, stdout: '', stderr: String(result.stderr ?? ''), failure: 'timeout' }
  }
  if (result.status !== 0) {
    return {
      ok: false,
      stdout: String(result.stdout ?? ''),
      stderr: String(result.stderr ?? ''),
      failure: 'error',
    }
  }
  return { ok: true, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') }
}

/** Best-effort JSON.parse — tolerates leading garbage / trailing newlines. */
function parseJson<T>(stdout: string): T | null {
  const trimmed = stdout.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed) as T
  } catch {
    return null
  }
}

/** Coerce caam's shifting JSON shapes into a typed array.
 *  Accepts: `T[]`, `{ profiles: T[] }`, `{ items: T[] }`, `{ cooldowns: T[] }`. */
function pickArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[]
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>
    for (const key of ['profiles', 'items', 'cooldowns', 'limits']) {
      if (Array.isArray(v[key])) return v[key] as T[]
    }
  }
  return []
}

interface MergeInputs {
  ls: RunResult
  limits: RunResult
  cooldown: RunResult
}

function mergeProfiles({ ls, limits, cooldown }: MergeInputs): CaamProfileMerged[] {
  const lsRows = ls.ok ? pickArray<CaamLsRow>(parseJson(ls.stdout)) : []
  const limitsRows = limits.ok ? pickArray<CaamLimitsRow>(parseJson(limits.stdout)) : []
  const cooldownRows = cooldown.ok ? pickArray<CaamCooldownRow>(parseJson(cooldown.stdout)) : []

  const limitsByName = new Map<string, CaamLimitsRow>()
  for (const row of limitsRows) {
    if (row?.name) limitsByName.set(row.name, row)
  }
  const cooldownByName = new Map<string, CaamCooldownRow>()
  for (const row of cooldownRows) {
    if (row?.name) cooldownByName.set(row.name, row)
  }

  return lsRows
    .filter((row) => row && typeof row.name === 'string')
    .map((row) => {
      const limit = limitsByName.get(row.name)
      const cd = cooldownByName.get(row.name)
      const resetsAt = toIso(limit?.resets_at) ?? toIso(row.health?.expires_at)
      return {
        name: row.name,
        active: row.active === true,
        system: row.system === true,
        plan: typeof row.plan === 'string' ? row.plan : null,
        util_7d_pct:
          typeof limit?.util_7d_pct === 'number' && Number.isFinite(limit.util_7d_pct)
            ? limit.util_7d_pct
            : null,
        resets_at: resetsAt,
        cooldown_until: toIso(cd?.until),
      }
    })
}

/** Run the three list commands under a single 5s wall-clock budget.
 *  Returns the merged list, or a `failure` token mapped to an HTTP code. */
async function fetchMergedProfiles(): Promise<
  | { ok: true; profiles: CaamProfileMerged[] }
  | { ok: false; failure: 'missing' | 'timeout' | 'error'; message?: string }
> {
  // spawnSync is synchronous; wrapping in microtasks lets us race a single
  // wall-clock timer against the bundle. Each child also has an individual
  // timeout: 5_000 belt for the case where the process group hangs without
  // closing stdio.
  const work = Promise.all([
    Promise.resolve().then(() => runCaam(['ls', 'claude', '--json'])),
    Promise.resolve().then(() => runCaam(['limits', 'claude', '--format', 'json'])),
    Promise.resolve().then(() => runCaam(['cooldown', 'list', '--json'])),
  ])

  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<'__timeout__'>((resolve) => {
    timer = setTimeout(() => resolve('__timeout__'), TIMEOUT_MS)
  })

  const winner = await Promise.race([work, timeout])
  if (timer) clearTimeout(timer)

  if (winner === '__timeout__') {
    return { ok: false, failure: 'timeout' }
  }

  const [ls, limits, cooldown] = winner

  // Binary missing → uniformly degrade to 503 caam_unavailable. We only need
  // one of the three to flag it; if `ls` succeeded but a sibling reports
  // missing, that's a real error, not a binary-absent state.
  if (ls.failure === 'missing' && limits.failure === 'missing' && cooldown.failure === 'missing') {
    return { ok: false, failure: 'missing' }
  }

  // If any individual call timed out (status=null, signal=SIGTERM) under the
  // per-process 5s belt, surface the timeout. This is rare given the outer
  // race already fires at 5s.
  if (ls.failure === 'timeout' || limits.failure === 'timeout' || cooldown.failure === 'timeout') {
    return { ok: false, failure: 'timeout' }
  }

  // If the primary list call (`ls`) failed outright, we have nothing to merge.
  if (ls.failure === 'error') {
    return { ok: false, failure: 'error', message: ls.stderr || 'caam ls failed' }
  }

  return { ok: true, profiles: mergeProfiles({ ls, limits, cooldown }) }
}

// ── Public handlers ────────────────────────────────────────────────────

/** GET /admin/caam/profiles
 *
 *  - 200 { profiles: [...] }
 *  - 503 { error: 'caam_unavailable' }
 *  - 503 { error: 'caam_timeout' }
 *  - 500 { error: 'caam_error', message } */
export async function handleListProfiles(): Promise<Response> {
  const result = await fetchMergedProfiles()
  if (result.ok) {
    return json(200, { profiles: result.profiles } satisfies CaamProfilesBody)
  }
  if (result.failure === 'missing') {
    return json(503, { error: 'caam_unavailable' })
  }
  if (result.failure === 'timeout') {
    return json(503, { error: 'caam_timeout' })
  }
  return json(500, { error: 'caam_error', message: result.message ?? 'unknown caam failure' })
}

/** POST /admin/caam/activate — body { profile: string }
 *
 *  - 400 { error: 'invalid_body' }
 *  - 200 { profiles: [...] } (re-fetched merged list)
 *  - 502 { error: 'activate_failed', stderr } */
export async function handleActivateProfile(body: unknown): Promise<Response> {
  if (
    !body ||
    typeof body !== 'object' ||
    typeof (body as Record<string, unknown>).profile !== 'string' ||
    !((body as Record<string, unknown>).profile as string).trim()
  ) {
    return json(400, { error: 'invalid_body' })
  }
  const profile = ((body as Record<string, unknown>).profile as string).trim()

  const activate = runCaam(['activate', 'claude', profile])
  if (activate.failure === 'missing') {
    return json(503, { error: 'caam_unavailable' })
  }
  if (activate.failure === 'timeout') {
    return json(503, { error: 'caam_timeout' })
  }
  if (!activate.ok) {
    return json(502, { error: 'activate_failed', stderr: activate.stderr })
  }

  // Re-fetch merged list so the dashboard re-renders authoritative state.
  return handleListProfiles()
}
