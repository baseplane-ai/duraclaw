/**
 * GH#92 P5 — unit tests for the gateway admin caam aggregator.
 *
 * The shape under test (`fetchCaamStatus`) shells out via
 * `child_process.execFile` and `fs.access` against the resolved caam
 * binary. We mock both so the test never touches a real binary or
 * filesystem, and so we can exercise the timeout / failure / merge
 * paths deterministically.
 *
 * Bearer-token / route-level auth lives in `server.ts` (registered
 * exactly like `/sessions/start`) and is not exercised here. The
 * existing `server.test.ts` covers `handleStartSession` directly
 * without hitting the route layer either, so this file mirrors that
 * pattern. A follow-up integration test could spin Bun.serve and
 * verify 401 on missing bearer; not in this unit's scope.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import nodePath from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── execFile / fs.access mocks ──────────────────────────────────────
//
// `caam-admin.ts` imports `execFile` from `node:child_process` and
// `access` from `node:fs/promises`. We mock both so the suite is
// hermetic.
//
// Each `runCaamJson` call invokes `pexec(bin, args, {timeout})` (the
// promisified form). Our mock dispatches on the first arg of `args`
// (the subcommand verb) and returns either `{stdout, stderr}` or
// rejects with `{stderr, code}` shaped like `child_process.ExecException`.

interface SubcommandHandler {
  /** Resolve / reject the pexec call after `delayMs`. Default 0. */
  delayMs?: number
  /** When set, reject with this stderr string. */
  reject?: string
  /** When set, resolve with this stdout. */
  stdout?: string
}

let handlers: Record<string, SubcommandHandler> = {}
let accessOk = true

vi.mock('node:child_process', () => {
  // The native `child_process.execFile` declares a custom promisify
  // shape via `util.promisify.custom` so `pexec(bin, args, opts)`
  // resolves to `{stdout, stderr}` instead of the callback's bare
  // `stdout` value. We replicate the same symbol on the mock — without
  // it, `await pexec(...)` returns the stdout string and the
  // `const { stdout } = await pexec(...)` destructure in
  // `runCaamJson` produces `undefined`, which is what blew up our
  // first run of this suite.
  const execFile = (
    _bin: string,
    args: string[],
    _opts: unknown,
    cb: (
      err: (NodeJS.ErrnoException & { stderr?: string }) | null,
      stdout: string,
      stderr: string,
    ) => void,
  ) => {
    const key = args[0] === 'cooldown' ? 'cooldown' : args[0]
    const h = handlers[key] ?? { stdout: '' }
    const delay = h.delayMs ?? 0
    setTimeout(() => {
      if (h.reject !== undefined) {
        const err = new Error(h.reject) as NodeJS.ErrnoException & {
          stderr?: string
          stdout?: string
        }
        err.stderr = h.reject
        err.stdout = ''
        cb(err, '', h.reject)
      } else {
        cb(null, h.stdout ?? '', '')
      }
    }, delay)
    return { unref: () => {} } as unknown
  }
  // Match the native shape so `promisify(execFile)` resolves `{stdout, stderr}`.
  const promisified = (bin: string, args: string[], opts: unknown) =>
    new Promise((resolve, reject) => {
      execFile(bin, args, opts, (err, stdout, stderr) => {
        if (err) {
          const ann = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string }
          ann.stdout = stdout
          ann.stderr = stderr
          reject(err)
        } else {
          resolve({ stdout, stderr })
        }
      })
    })
  ;(execFile as unknown as Record<symbol, unknown>)[Symbol.for('nodejs.util.promisify.custom')] =
    promisified
  return { execFile, default: { execFile } }
})

vi.mock('node:fs/promises', async () => {
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return {
    ...real,
    // `fetchCaamStatus` calls `access(caamBin, X_OK)` to gate the
    // degraded-mode path. We intercept ONLY that call (single-arg with
    // a mode int) so the test fixtures never need a real binary on
    // disk; every other access (readdir/stat/readFile in
    // findLastRotation, mkdtemp scaffolding, etc.) still hits the real
    // fs untouched.
    access: (path: unknown, mode?: unknown) => {
      const isCaamBinaryProbe = typeof path === 'string' && typeof mode === 'number'
      if (isCaamBinaryProbe) {
        return accessOk ? Promise.resolve() : Promise.reject(new Error('ENOENT'))
      }
      return real.access(path as string, mode as number | undefined)
    },
  }
})

// Import AFTER the mocks register.
const { fetchCaamStatus, findLastRotation } = await import('./caam-admin.js')

// ── Fixtures ────────────────────────────────────────────────────────

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'duraclaw-caam-admin-'))
  handlers = {}
  accessOk = true
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
  vi.clearAllMocks()
})

function setSubcommands(h: {
  status?: SubcommandHandler
  cooldown?: SubcommandHandler
  ls?: SubcommandHandler
}) {
  handlers = {
    status: h.status ?? { stdout: '{"active":{"claude":"work2"}}' },
    cooldown: h.cooldown ?? { stdout: '[]' },
    ls: h.ls ?? { stdout: '[]' },
  }
}

// ── gateway-admin-caam-json-merge ───────────────────────────────────

describe('fetchCaamStatus — successful merge', () => {
  it('merges three subcommands into a CaamStatus with cooldown_until + active stamping', async () => {
    setSubcommands({
      status: { stdout: '{"active":{"claude":"work2"}}' },
      cooldown: {
        stdout: JSON.stringify([
          { system: 'claude', profile: 'work3', cooldown_until: 1700000000000 },
          // Mixed-format ISO entry — must parse to ms-epoch.
          { system: 'claude', profile: 'work4', cooldown_until: '2026-04-25T00:00:00Z' },
          // Different system → ignored.
          { system: 'codex', profile: 'workX', cooldown_until: 999 },
        ]),
      },
      ls: {
        stdout: JSON.stringify([
          { name: 'work1', system: 'claude', health: { status: 'ok', error_count: 0 } },
          { name: 'work2', system: 'claude' }, // health absent → defaulted
          { name: 'work3', system: 'claude', health: { status: 'cooling', error_count: 2 } },
          { name: 'work4', system: 'claude' },
        ]),
      },
    })

    const result = await fetchCaamStatus({ caamBin: '/fake/caam', sessionsDir: tmpDir })

    expect(result.caam_configured).toBe(true)
    expect(result.active_profile).toBe('work2')
    expect(result.warnings).toEqual([])
    expect(result.last_rotation).toBeNull()
    expect(result.profiles).toHaveLength(4)

    const byName = Object.fromEntries(result.profiles.map((p) => [p.name, p]))
    expect(byName.work1.active).toBe(false)
    expect(byName.work1.health).toEqual({ status: 'ok', error_count: 0 })
    expect(byName.work1.cooldown_until).toBeUndefined()

    expect(byName.work2.active).toBe(true)
    expect(byName.work2.health).toEqual({ status: 'unknown', error_count: 0 })

    expect(byName.work3.cooldown_until).toBe(1700000000000)
    expect(byName.work3.health).toEqual({ status: 'cooling', error_count: 2 })

    // ISO → epoch ms via Date.parse
    expect(byName.work4.cooldown_until).toBe(Date.parse('2026-04-25T00:00:00Z'))

    expect(typeof result.fetched_at_ms).toBe('number')
  })
})

// ── gateway-admin-caam-no-binary ────────────────────────────────────

describe('fetchCaamStatus — degraded mode (no binary)', () => {
  it('returns caam_configured:false with empty profiles + warning, never throws', async () => {
    accessOk = false

    const result = await fetchCaamStatus({ caamBin: '/nope/caam', sessionsDir: tmpDir })

    expect(result.caam_configured).toBe(false)
    expect(result.active_profile).toBeNull()
    expect(result.profiles).toEqual([])
    expect(result.warnings.length).toBeGreaterThan(0)
    expect(result.warnings[0]).toMatch(/caam binary not found/i)
    expect(result.last_rotation).toBeNull()
    expect(typeof result.fetched_at_ms).toBe('number')
  })
})

// ── gateway-admin-caam-budget ───────────────────────────────────────

describe('fetchCaamStatus — total endpoint budget', () => {
  it('returns within budget with partial data + warning when one subcommand stalls', async () => {
    setSubcommands({
      status: { stdout: '{"active":{"claude":"work2"}}' },
      // Stall cooldown beyond the test budget so the total race trips.
      cooldown: { stdout: '[]', delayMs: 200 },
      ls: {
        stdout: JSON.stringify([{ name: 'work1', system: 'claude' }]),
      },
    })

    const start = Date.now()
    const result = await fetchCaamStatus({
      caamBin: '/fake/caam',
      sessionsDir: tmpDir,
      totalBudgetMs: 50,
    })
    const elapsed = Date.now() - start

    expect(elapsed).toBeLessThan(180) // generous slack — we capped at 50ms
    expect(result.caam_configured).toBe(true)
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/endpoint budget exceeded/i)]),
    )

    // The two fast subcommands' data must still flow through.
    expect(result.active_profile).toBe('work2')
    expect(result.profiles).toHaveLength(1)
    expect(result.profiles[0].name).toBe('work1')
    expect(result.profiles[0].active).toBe(false) // active_profile is work2, not work1

    // The slow subcommand's data is absent; its profile has no cooldown_until.
    expect(result.profiles[0].cooldown_until).toBeUndefined()
  })
})

// ── gateway-admin-caam-individual-failure ───────────────────────────

describe('fetchCaamStatus — individual subcommand failure', () => {
  it('absorbs one failure into warnings while preserving the other two', async () => {
    setSubcommands({
      status: { stdout: '{"active":{"claude":"work2"}}' },
      cooldown: { reject: 'caam: cooldown subsystem unavailable' },
      ls: {
        stdout: JSON.stringify([
          { name: 'work1', system: 'claude' },
          { name: 'work2', system: 'claude' },
        ]),
      },
    })

    const result = await fetchCaamStatus({ caamBin: '/fake/caam', sessionsDir: tmpDir })

    expect(result.caam_configured).toBe(true)
    expect(result.active_profile).toBe('work2')
    expect(result.profiles).toHaveLength(2)
    expect(result.profiles.find((p) => p.name === 'work2')?.active).toBe(true)
    // cooldown subcommand failed → no cooldown_until on any profile.
    for (const p of result.profiles) expect(p.cooldown_until).toBeUndefined()
    // Warning recorded for the failed subcommand.
    expect(result.warnings.length).toBe(1)
    expect(result.warnings[0]).toMatch(/cooldown list/i)
  })
})

// ── findLastRotation ────────────────────────────────────────────────

describe('findLastRotation', () => {
  it('returns null when sessions dir is missing', async () => {
    const missing = nodePath.join(tmpDir, 'does-not-exist')
    expect(await findLastRotation(missing)).toBeNull()
  })

  it('returns null when no meta files contain a rotation field', async () => {
    await fs.writeFile(
      nodePath.join(tmpDir, 'A.meta.json'),
      JSON.stringify({ state: 'running', last_activity_ts: 100 }),
    )
    expect(await findLastRotation(tmpDir)).toBeNull()
  })

  it('picks the rotation with the highest at_ms across multiple meta files', async () => {
    await fs.writeFile(
      nodePath.join(tmpDir, 'OLDER.meta.json'),
      JSON.stringify({
        state: 'completed',
        last_activity_ts: 1000,
        rotation: { from: 'work1', to: 'work2' },
      }),
    )
    await fs.writeFile(
      nodePath.join(tmpDir, 'NEWER.meta.json'),
      JSON.stringify({
        state: 'completed',
        last_activity_ts: 5000,
        rotation: { from: 'work2', to: 'work3' },
      }),
    )
    // No rotation field — must be ignored even though it has the highest ts.
    await fs.writeFile(
      nodePath.join(tmpDir, 'NOROT.meta.json'),
      JSON.stringify({ state: 'running', last_activity_ts: 9999 }),
    )

    const r = await findLastRotation(tmpDir)
    expect(r).not.toBeNull()
    expect(r?.session_id).toBe('NEWER')
    expect(r?.from).toBe('work2')
    expect(r?.to).toBe('work3')
    expect(r?.at_ms).toBe(5000)
  })

  it('falls back to mtime when last_activity_ts is absent', async () => {
    await fs.writeFile(
      nodePath.join(tmpDir, 'MTIME.meta.json'),
      JSON.stringify({ rotation: { from: 'a', to: 'b' } }),
    )
    const r = await findLastRotation(tmpDir)
    expect(r).not.toBeNull()
    expect(r?.session_id).toBe('MTIME')
    expect(r?.at_ms).toBeGreaterThan(0)
  })
})
