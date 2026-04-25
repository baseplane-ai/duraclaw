/**
 * GH#92 — typed wrappers around the `caam` CLI (Claude Auth Account
 * Manager) installed at `/home/ubuntu/bin/caam` on the production VPS.
 *
 * Every wrapper follows the same pattern: try `--json` first, fall
 * back to text parsing on non-JSON / non-zero exit, and swallow all
 * caam failures into typed return values (`null` / `false`) so the
 * rate-limit branch in claude-runner.ts can treat "caam not
 * configured" as a first-class state (B7) rather than a throw path.
 *
 * Binary resolution:
 *   1. `process.env.CAAM_BIN` override (absolute path)
 *   2. `/home/ubuntu/bin/caam` (prod VPS default)
 *   3. `$PATH` probe via the shell — intentionally NOT implemented here;
 *      `access(bin, X_OK)` on the default path is the only probe. Dev
 *      boxes without caam set `CAAM_BIN=/nonexistent` and land in the
 *      `caamIsConfigured() === false` branch.
 *
 * caam CLI argument conventions (authoritative — verified against the
 * installed binary's `--help`):
 *
 *   | Operation        | argv                                                |
 *   |------------------|-----------------------------------------------------|
 *   | activate         | `activate claude <profile> [--force]`               |
 *   | rotate (smart)   | `next claude --quiet` / `next claude --json`        |
 *   | set cooldown     | `cooldown set claude/<profile> --minutes <N>`       |
 *   | list cooldowns   | `cooldown list`                                     |
 *   | clear cooldowns  | `cooldown clear --all` / `cooldown clear claude/<p>`|
 *   | list profiles    | `ls claude`                                         |
 *   | active profile   | `which` (no tool arg; prints all tools)             |
 *   | status dashboard | `status`                                            |
 *
 * The tool name always comes AFTER the subcommand, EXCEPT for
 * `cooldown set` / `clear` which take `<tool>/<profile>` slash-joined.
 */

import { execFile } from 'node:child_process'
import { constants as fsc } from 'node:fs'
import { access } from 'node:fs/promises'
import { promisify } from 'node:util'

const pexec = promisify(execFile)

/** Resolve the caam binary path. Not cached — test overrides re-set
 *  `CAAM_BIN` per-test, so we read env on each call. Cheap: string only. */
export function caamResolveBin(): string {
  return process.env.CAAM_BIN ?? '/home/ubuntu/bin/caam'
}

interface ExecResult {
  stdout: string
  stderr: string
  code: number
}

/**
 * Shell out to caam. All failures (nonzero exit, ENOENT, timeout)
 * surface as `{code: nonzero, stderr: ...}` rather than throws — the
 * rate-limit branch's gates are easier to reason about against a
 * single return shape.
 */
async function caamExec(args: string[], timeoutMs = 5_000): Promise<ExecResult> {
  const bin = caamResolveBin()
  try {
    const { stdout, stderr } = await pexec(bin, args, { timeout: timeoutMs })
    return { stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code: 0 }
  } catch (e) {
    const err = e as NodeJS.ErrnoException & {
      stdout?: string | Buffer
      stderr?: string | Buffer
      code?: number | string
    }
    const codeNum = typeof err.code === 'number' ? err.code : 1
    return {
      stdout: typeof err.stdout === 'string' ? err.stdout : '',
      stderr: typeof err.stderr === 'string' ? err.stderr : String(err.message ?? err),
      code: codeNum,
    }
  }
}

/**
 * Cached configured-check — repeated calls from the rate-limit branch
 * hit the cache. Reset exposed for tests via `resetCaamConfiguredCache()`.
 */
let _configuredCache: boolean | null = null

/** Reset the cached `caamIsConfigured()` result. Test-only. */
export function resetCaamConfiguredCache(): void {
  _configuredCache = null
}

/**
 * B7 gate: caam is "configured" when the binary is executable AND
 * `caam ls claude` returns ≥1 profile. Dev boxes without caam fall
 * into `false` and the rate-limit branch short-circuits to raw-relay.
 */
export async function caamIsConfigured(): Promise<boolean> {
  if (_configuredCache !== null) return _configuredCache
  const bin = caamResolveBin()
  try {
    await access(bin, fsc.X_OK)
  } catch {
    _configuredCache = false
    return false
  }
  const ls = await caamExec(['ls', 'claude'])
  if (ls.code !== 0) {
    _configuredCache = false
    return false
  }
  // "claude profiles" header + at least one profile line matching
  // `work\d+` / `_original` / any non-empty alphanumeric token on a
  // line (defensive).
  const hasProfile = ls.stdout
    .split('\n')
    .some((line) => /^\s*(work\d+|_original|\w+)\b/i.test(line.trim()))
  _configuredCache = hasProfile
  return hasProfile
}

/**
 * Read the currently-active Claude profile name. Uses `caam which`,
 * which prints lines like `claude: work2` (or `claude: (none)` when
 * no profile is active / logged-in sentinel).
 *
 * Returns `null` when caam reports no active profile or exits nonzero.
 */
export async function caamActiveProfile(): Promise<string | null> {
  const r = await caamExec(['which'])
  if (r.code !== 0) return null
  const m = r.stdout.match(/^\s*claude:\s+(\S+)/m)
  if (!m) return null
  const name = m[1]
  // caam prints `(none)` / `(logged out)` / `(logged in, no match)`
  // as its "no profile" sentinels. Parenthesised → not a real profile name.
  if (name.startsWith('(')) return null
  return name
}

/** Activate a Claude profile. Throws on caam failure so the pinned-profile
 *  path (B2) can catch it and map to `.exit {state:'failed', ...}`. */
export async function caamActivate(profile: string, opts: { force?: boolean } = {}): Promise<void> {
  const args = ['activate', 'claude', profile]
  if (opts.force) args.push('--force')
  const r = await caamExec(args)
  if (r.code !== 0) {
    throw new Error(
      `caam activate claude ${profile} failed (code=${r.code}): ${r.stderr.trim() || 'unknown'}`,
    )
  }
}

/**
 * Rotate to the next non-cooling Claude profile. Returns `{activated}`
 * on success, `null` when every profile is cooling (caller reads
 * `caamEarliestClearTs()` to schedule a waiting_profile alarm).
 *
 * `--json` first, text fallback for older caam versions.
 */
export async function caamNext(): Promise<{ activated: string } | null> {
  const json = await caamExec(['next', 'claude', '--json'])
  if (json.code === 0 && json.stdout.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(json.stdout) as { activated?: unknown }
      if (typeof parsed.activated === 'string' && parsed.activated.length > 0) {
        return { activated: parsed.activated }
      }
    } catch {
      // fall through to text parse
    }
  }
  const q = await caamExec(['next', 'claude', '--quiet'])
  if (q.code !== 0) return null
  // Text fallback: last whitespace-delimited token on the first
  // non-empty line is the newly-activated profile name. Guards
  // against parenthesised sentinels (same as `which`).
  const line = q.stdout
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (!line) return null
  const tokens = line.split(/\s+/)
  const name = tokens[tokens.length - 1]
  if (!name || name.startsWith('(')) return null
  return { activated: name }
}

/** Record a per-profile cooldown in caam. Minutes must be a positive
 *  integer; caller clamps via `Math.max(1, Math.ceil(...))`. */
export async function caamCooldownSet(profile: string, minutes: number): Promise<void> {
  const r = await caamExec(['cooldown', 'set', `claude/${profile}`, '--minutes', String(minutes)])
  if (r.code !== 0) {
    throw new Error(
      `caam cooldown set claude/${profile} failed (code=${r.code}): ${r.stderr.trim() || 'unknown'}`,
    )
  }
}

/**
 * Find the earliest cooldown-clear timestamp across all Claude
 * profiles. Used by the `rate_limited_no_profile` branch to schedule
 * the DO's delayed-resume alarm. Returns `now + 60min` as a defensive
 * default when every line fails to parse (caller adds +30s slop).
 *
 * Text-format parse: each cooling profile line looks roughly like
 *   `claude/work1    cooling   clears 2026-04-24T19:22:00Z`
 * The regex is deliberately loose — any ISO-8601 Z timestamp on a
 * `claude/...` line counts.
 */
export async function caamEarliestClearTs(): Promise<number> {
  const r = await caamExec(['cooldown', 'list'])
  const now = Date.now()
  if (r.code !== 0) return now + 60 * 60_000
  const times: number[] = []
  for (const raw of r.stdout.split('\n')) {
    const line = raw.trim()
    if (!/^claude\//.test(line)) continue
    const m = line.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/)
    if (!m) continue
    const t = Date.parse(m[1])
    if (!Number.isNaN(t) && t > now) times.push(t)
  }
  return times.length > 0 ? Math.min(...times) : now + 60 * 60_000
}

/**
 * List cooldowns for ops / admin dashboard consumption. Returns the
 * raw stdout so the admin /admin/caam/status aggregator can slice it
 * however it wants; the runner itself uses `caamEarliestClearTs()`.
 */
export async function caamCooldownList(): Promise<string> {
  const r = await caamExec(['cooldown', 'list'])
  return r.stdout
}
