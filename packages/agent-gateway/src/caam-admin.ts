/**
 * GH#92 P5 — admin /caam/status aggregator. Shells out to the `caam`
 * CLI for `status --json`, `cooldown list --json`, and `ls claude --json`
 * in parallel, merges the results into a single `CaamStatus` blob, and
 * scans `$SESSIONS_DIR` for the most-recent `*.meta.json` rotation
 * breadcrumb (written by the runner's exit-file path on a successful
 * caam rotation).
 *
 * Failure model (mirrors the runner-side caam.ts B7 contract):
 *   - Binary missing or not executable → degraded shape, no throw.
 *   - One subcommand fails / times out → that subcommand's data falls
 *     through to empty defaults and a `warnings[]` entry is added; the
 *     other two subcommands' data is preserved.
 *   - Total endpoint budget (3s) racing against the parallel
 *     subcommands' join — when the budget wins, partial data is
 *     returned with a `"endpoint budget exceeded — partial data"`
 *     warning.
 *
 * Reuses NO code from `session-runner/src/caam.ts` (different process
 * boundary; the gateway is not a session-runner dependency). Reuses NO
 * code from `session-runner/src/peer-scan.ts` either — the glob is
 * reimplemented here as ~10 lines (`findLastRotation`).
 */

import { execFile } from 'node:child_process'
import { constants as fsc } from 'node:fs'
import { access, readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { CaamLastRotation, CaamProfileStatus, CaamStatus } from '@duraclaw/shared-types'

const pexec = promisify(execFile)

/** Per-subcommand cap (matches the runner's caamExec default). */
const SUBCOMMAND_TIMEOUT_MS = 2_000
/** Total endpoint budget — caps `Promise.race` on the merged join. */
const TOTAL_BUDGET_MS = 3_000

/** Resolve the caam binary path. Pure env read; no caching since admin
 *  hits are infrequent and tests re-set CAAM_BIN per-test. */
export function resolveCaamBin(): string {
  return process.env.CAAM_BIN ?? '/home/ubuntu/bin/caam'
}

interface SubcommandOk<T> {
  ok: true
  value: T
}
interface SubcommandErr {
  ok: false
  warning: string
}
type SubcommandResult<T> = SubcommandOk<T> | SubcommandErr

/** Shorten stderr for a warning entry — first line, ≤120 chars. */
function shortenStderr(s: string): string {
  const first = s.split('\n').find((l) => l.trim().length > 0) ?? ''
  return first.length > 120 ? `${first.slice(0, 117)}...` : first
}

/** Run a single caam subcommand with a 2s cap. Captures all failures
 *  (nonzero exit, timeout, JSON parse error) into a single warning
 *  string instead of throwing. */
async function runCaamJson<T>(
  bin: string,
  args: string[],
  parse: (raw: string) => T,
  label: string,
): Promise<SubcommandResult<T>> {
  try {
    const { stdout } = await pexec(bin, args, { timeout: SUBCOMMAND_TIMEOUT_MS })
    try {
      return { ok: true, value: parse(String(stdout ?? '')) }
    } catch (e) {
      return {
        ok: false,
        warning: `${label} JSON parse failed: ${e instanceof Error ? e.message : String(e)}`,
      }
    }
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string | Buffer }
    const stderr = typeof err.stderr === 'string' ? err.stderr : String(err.message ?? err)
    return { ok: false, warning: `${label} failed: ${shortenStderr(stderr)}` }
  }
}

// ── Subcommand parsers ──────────────────────────────────────────────

/**
 * Parse `caam status --json`. Tolerant of two shapes seen in the wild:
 *   { active: { claude: 'work2', ... } }
 *   { active_profile: { claude: 'work2' } }
 * Returns `null` when the JSON is well-formed but no claude profile is
 * present (a `(none)` sentinel from the CLI).
 */
function parseActiveProfile(raw: string): string | null {
  const j = JSON.parse(raw) as Record<string, unknown>
  const active = (j.active ?? j.active_profile) as Record<string, unknown> | undefined
  if (!active || typeof active !== 'object') return null
  const claude = active.claude
  if (typeof claude !== 'string' || claude.length === 0) return null
  if (claude.startsWith('(')) return null
  return claude
}

/**
 * Parse `caam cooldown list --json`. Expected shape is an array of
 *   { system, profile, cooldown_until: <ms-epoch | ISO-8601> }
 * Returns a Map keyed by profile name (claude system only). Skips
 * malformed entries silently — caller doesn't need to know which row
 * was bad, only that the shape is best-effort.
 */
function parseCooldowns(raw: string): Map<string, number> {
  const j = JSON.parse(raw) as unknown
  const out = new Map<string, number>()
  if (!Array.isArray(j)) return out
  for (const entry of j) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    if (e.system !== 'claude') continue
    const profile = e.profile
    if (typeof profile !== 'string' || profile.length === 0) continue
    const cu = e.cooldown_until
    let ms: number | null = null
    if (typeof cu === 'number' && Number.isFinite(cu)) {
      ms = cu
    } else if (typeof cu === 'string') {
      const parsed = Date.parse(cu)
      if (!Number.isNaN(parsed)) ms = parsed
    }
    if (ms !== null) out.set(profile, ms)
  }
  return out
}

/**
 * Parse `caam ls claude --json`. Expected shape is an array of
 *   { name, active?, system?, health?: { status, error_count } }
 * Health defaults to `{ status: 'unknown', error_count: 0 }` per
 * profile when caam doesn't emit it.
 */
function parseProfiles(raw: string): CaamProfileStatus[] {
  const j = JSON.parse(raw) as unknown
  if (!Array.isArray(j)) return []
  const out: CaamProfileStatus[] = []
  for (const entry of j) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    const name = e.name
    if (typeof name !== 'string' || name.length === 0) continue
    const active = e.active === true
    const system = typeof e.system === 'string' ? e.system : 'claude'
    let health: CaamProfileStatus['health'] = { status: 'unknown', error_count: 0 }
    if (e.health && typeof e.health === 'object') {
      const h = e.health as Record<string, unknown>
      const status = typeof h.status === 'string' ? h.status : 'unknown'
      const errorCount = typeof h.error_count === 'number' ? h.error_count : 0
      health = { status, error_count: errorCount }
    }
    out.push({ name, active, system, health })
  }
  return out
}

// ── Last-rotation finder ────────────────────────────────────────────

/**
 * Glob `$SESSIONS_DIR/*.meta.json` and return the most-recent rotation
 * breadcrumb (written by session-runner's exit path on caam rotate).
 * Each rotation-bearing meta has a top-level `rotation: { from, to }`
 * object plus a usable `at_ms` timestamp (preferring `last_activity_ts`,
 * falling back to file mtime).
 *
 * Reimplemented inline (~20 lines) rather than importing
 * `scanPeerMeta` from session-runner — the gateway is not a session-runner
 * dependency, and the cross-package edge would couple two binaries that
 * deploy independently.
 */
export async function findLastRotation(sessionsDir: string): Promise<CaamLastRotation | null> {
  let files: string[]
  try {
    files = await readdir(sessionsDir)
  } catch {
    return null
  }
  let best: CaamLastRotation | null = null
  for (const f of files) {
    if (!f.endsWith('.meta.json')) continue
    const sid = f.slice(0, -'.meta.json'.length)
    let parsed: Record<string, unknown>
    let mtimeMs = 0
    try {
      const full = join(sessionsDir, f)
      const raw = await readFile(full, 'utf8')
      parsed = JSON.parse(raw) as Record<string, unknown>
      try {
        const st = await stat(full)
        mtimeMs = st.mtimeMs
      } catch {
        // mtime fallback unavailable — at_ms will require last_activity_ts
      }
    } catch {
      continue
    }
    const rot = parsed.rotation
    if (!rot || typeof rot !== 'object') continue
    const r = rot as Record<string, unknown>
    if (typeof r.from !== 'string' || typeof r.to !== 'string') continue
    const atMs = typeof parsed.last_activity_ts === 'number' ? parsed.last_activity_ts : mtimeMs
    if (!atMs) continue
    if (!best || atMs > best.at_ms) {
      best = { from: r.from, to: r.to, at_ms: atMs, session_id: sid }
    }
  }
  return best
}

// ── Top-level orchestrator ──────────────────────────────────────────

interface FetchOpts {
  caamBin: string
  sessionsDir: string
  /** Test seam: override the default 3s total cap. */
  totalBudgetMs?: number
}

/**
 * Build the degraded-mode response. Used when the caam binary is
 * missing / not executable, OR when the total endpoint budget elapses
 * before any subcommand resolved (in which case we still need to
 * return *something* in the response shape).
 */
function degradedShape(reason: string): CaamStatus {
  return {
    active_profile: null,
    profiles: [],
    warnings: [reason],
    last_rotation: null,
    caam_configured: false,
    fetched_at_ms: Date.now(),
  }
}

/**
 * Orchestrate the three caam subcommands in parallel + last-rotation
 * scan, merge results, and bound the total wallclock to ~3s.
 *
 * Returns a fully-populated `CaamStatus`. Never throws.
 */
export async function fetchCaamStatus(opts: FetchOpts): Promise<CaamStatus> {
  const { caamBin, sessionsDir, totalBudgetMs = TOTAL_BUDGET_MS } = opts

  // Binary-missing degraded mode — bail out before spawning anything.
  try {
    await access(caamBin, fsc.X_OK)
  } catch {
    return degradedShape('caam binary not found on this host')
  }

  const warnings: string[] = []

  // Fan out all three caam subcommands + the rotation scan in parallel.
  // Each promise updates a slot in `slots` AS IT RESOLVES so the
  // budget-exceeded path can read the snapshot of "what we have so far"
  // without awaiting the still-pending promises (which would defeat
  // the budget cap entirely).
  const slots: {
    active: SubcommandResult<string | null> | null
    cooldown: SubcommandResult<Map<string, number>> | null
    profiles: SubcommandResult<CaamProfileStatus[]> | null
    rotation: CaamLastRotation | null
    rotationDone: boolean
  } = {
    active: null,
    cooldown: null,
    profiles: null,
    rotation: null,
    rotationDone: false,
  }

  const activeP = runCaamJson(
    caamBin,
    ['status', '--json'],
    parseActiveProfile,
    'caam status --json',
  ).then((r) => {
    slots.active = r
    return r
  })
  const cooldownP = runCaamJson(
    caamBin,
    ['cooldown', 'list', '--json'],
    parseCooldowns,
    'caam cooldown list --json',
  ).then((r) => {
    slots.cooldown = r
    return r
  })
  const profilesP = runCaamJson(
    caamBin,
    ['ls', 'claude', '--json'],
    parseProfiles,
    'caam ls claude --json',
  ).then((r) => {
    slots.profiles = r
    return r
  })
  const rotationP = findLastRotation(sessionsDir)
    .catch(() => null)
    .then((r) => {
      slots.rotation = r
      slots.rotationDone = true
      return r
    })

  // Sentinel result used when the total budget races ahead of the join.
  const TIMEOUT = Symbol('caam-total-timeout')
  type Joined = readonly [
    SubcommandResult<string | null>,
    SubcommandResult<Map<string, number>>,
    SubcommandResult<CaamProfileStatus[]>,
    CaamLastRotation | null,
  ]
  const join = Promise.all([activeP, cooldownP, profilesP, rotationP] as const) as Promise<Joined>
  const timer = new Promise<typeof TIMEOUT>((resolve) => {
    setTimeout(() => resolve(TIMEOUT), totalBudgetMs).unref?.()
  })
  const raced = await Promise.race([join, timer])

  if (raced === TIMEOUT) {
    // Budget elapsed — return whatever resolved before the timer fired,
    // straight from `slots`. Still-pending subcommands fall through to
    // empty defaults + a warning. We DO NOT await the unsettled promises
    // here (that would defeat the cap).
    warnings.push('endpoint budget exceeded — partial data')
    return {
      ...mergeSlots(slots, warnings),
      caam_configured: true,
      fetched_at_ms: Date.now(),
    }
  }

  const [activeRes, cooldownRes, profilesRes, lastRotation] = raced

  let activeProfile: string | null = null
  if (activeRes.ok) {
    activeProfile = activeRes.value
  } else {
    warnings.push(activeRes.warning)
  }

  let cooldowns = new Map<string, number>()
  if (cooldownRes.ok) {
    cooldowns = cooldownRes.value
  } else {
    warnings.push(cooldownRes.warning)
  }

  let profiles: CaamProfileStatus[] = []
  if (profilesRes.ok) {
    profiles = profilesRes.value.map((p) => ({
      ...p,
      active: p.name === activeProfile,
      cooldown_until: cooldowns.get(p.name),
    }))
  } else {
    warnings.push(profilesRes.warning)
  }

  return {
    active_profile: activeProfile,
    profiles,
    warnings,
    last_rotation: lastRotation,
    caam_configured: true,
    fetched_at_ms: Date.now(),
  }
}

/**
 * Merge the `slots` snapshot into a partial CaamStatus (no
 * `caam_configured` / `fetched_at_ms` — caller stamps those). Used only
 * on the budget-exceeded path. Slots that are still `null` (subcommand
 * unresolved by the timer fire) fall through to empty defaults; a
 * settled-but-failed slot contributes a warning. We do not await any
 * pending promise here.
 */
function mergeSlots(
  slots: {
    active: SubcommandResult<string | null> | null
    cooldown: SubcommandResult<Map<string, number>> | null
    profiles: SubcommandResult<CaamProfileStatus[]> | null
    rotation: CaamLastRotation | null
    rotationDone: boolean
  },
  warnings: string[],
): Pick<CaamStatus, 'active_profile' | 'profiles' | 'warnings' | 'last_rotation'> {
  let activeProfile: string | null = null
  if (slots.active?.ok) activeProfile = slots.active.value
  else if (slots.active && !slots.active.ok) warnings.push(slots.active.warning)

  let cooldowns = new Map<string, number>()
  if (slots.cooldown?.ok) cooldowns = slots.cooldown.value
  else if (slots.cooldown && !slots.cooldown.ok) warnings.push(slots.cooldown.warning)

  let profilesRaw: CaamProfileStatus[] = []
  if (slots.profiles?.ok) profilesRaw = slots.profiles.value
  else if (slots.profiles && !slots.profiles.ok) warnings.push(slots.profiles.warning)

  const profiles: CaamProfileStatus[] = profilesRaw.map((pr) => ({
    ...pr,
    active: pr.name === activeProfile,
    cooldown_until: cooldowns.get(pr.name),
  }))

  return {
    active_profile: activeProfile,
    profiles,
    warnings,
    last_rotation: slots.rotationDone ? slots.rotation : null,
  }
}
