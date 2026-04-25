import fs from 'node:fs/promises'
import os from 'node:os'
import nodePath from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReaper, type ReaperLogger, type ReaperOptions } from './reaper.js'

// ────────────────────────────────────────────────────────────────────
// Test fixture helpers
// ────────────────────────────────────────────────────────────────────

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'duraclaw-reaper-test-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const FIXED_NOW = 1_700_000_000_000

function mkLogger(): ReaperLogger & {
  infoCalls: string[]
  warnCalls: string[]
  errorCalls: string[]
} {
  const infoCalls: string[] = []
  const warnCalls: string[] = []
  const errorCalls: string[] = []
  return {
    infoCalls,
    warnCalls,
    errorCalls,
    info: (msg, ...rest) => {
      infoCalls.push([msg, ...rest.map((r) => String(r))].join(' '))
    },
    warn: (msg, ...rest) => {
      warnCalls.push([msg, ...rest.map((r) => String(r))].join(' '))
    },
    error: (msg, ...rest) => {
      errorCalls.push([msg, ...rest.map((r) => String(r))].join(' '))
    },
  }
}

interface FixtureOpts {
  id: string
  pid?: number
  startedAt?: number
  meta?: {
    last_activity_ts?: number | null
    state?: string
    runner_session_id?: string | null
    last_event_seq?: number
    cost?: { input_tokens: number; output_tokens: number; usd: number }
    model?: string | null
    turn_count?: number
  }
  exit?: {
    state: 'completed' | 'failed' | 'aborted' | 'crashed'
    exit_code: number | null
    duration_ms: number
  }
  pidMtime?: number
  exitMtime?: number
  cmdMtime?: number
  writeCmd?: boolean
  writeLog?: boolean
}

async function writeSession(dir: string, f: FixtureOpts): Promise<void> {
  if (f.pid !== undefined) {
    const pidPath = nodePath.join(dir, `${f.id}.pid`)
    await fs.writeFile(
      pidPath,
      JSON.stringify({ pid: f.pid, sessionId: f.id, started_at: f.startedAt ?? 1 }),
    )
    if (f.pidMtime) await fs.utimes(pidPath, f.pidMtime / 1000, f.pidMtime / 1000)
  }
  if (f.meta) {
    const metaPath = nodePath.join(dir, `${f.id}.meta.json`)
    await fs.writeFile(
      metaPath,
      JSON.stringify({
        runner_session_id: f.meta.runner_session_id ?? null,
        last_activity_ts: f.meta.last_activity_ts ?? null,
        last_event_seq: f.meta.last_event_seq ?? 0,
        cost: f.meta.cost ?? { input_tokens: 0, output_tokens: 0, usd: 0 },
        model: f.meta.model ?? null,
        turn_count: f.meta.turn_count ?? 0,
        state: f.meta.state ?? 'running',
      }),
    )
  }
  if (f.exit) {
    const exitPath = nodePath.join(dir, `${f.id}.exit`)
    await fs.writeFile(exitPath, JSON.stringify(f.exit))
    if (f.exitMtime) await fs.utimes(exitPath, f.exitMtime / 1000, f.exitMtime / 1000)
  }
  if (f.writeCmd) {
    const cmdPath = nodePath.join(dir, `${f.id}.cmd`)
    await fs.writeFile(cmdPath, JSON.stringify({ type: 'execute' }))
    if (f.cmdMtime) await fs.utimes(cmdPath, f.cmdMtime / 1000, f.cmdMtime / 1000)
  }
  if (f.writeLog) {
    await fs.writeFile(nodePath.join(dir, `${f.id}.log`), '')
  }
}

function baseOpts(overrides: Partial<ReaperOptions> = {}): ReaperOptions {
  return {
    sessionsDir: tmpDir,
    now: () => FIXED_NOW,
    livenessCheck: () => false,
    kill: () => {},
    ...overrides,
  }
}

// ────────────────────────────────────────────────────────────────────
// reapOnce behavior
// ────────────────────────────────────────────────────────────────────

describe('createReaper.reapOnce', () => {
  it('SIGTERMs a stale session that is still alive', async () => {
    await writeSession(tmpDir, {
      id: 'STALE',
      pid: 1000,
      meta: { last_activity_ts: FIXED_NOW - 31 * 60_000 },
    })
    const killCalls: Array<[number, string]> = []
    const logger = mkLogger()
    const reaper = createReaper(
      baseOpts({
        livenessCheck: (pid) => pid === 1000,
        kill: (pid, sig) => killCalls.push([pid, sig]),
        logger,
      }),
    )

    const report = await reaper.reapOnce()
    reaper.stop()

    expect(report.sigtermed).toEqual(['STALE'])
    expect(report.markedCrashed).toEqual([])
    expect(killCalls).toEqual([[1000, 'SIGTERM']])
    expect(logger.infoCalls.some((l) => l.includes('stale session') && l.includes('STALE'))).toBe(
      true,
    )
  })

  it('escalates to SIGKILL after sigtermGraceMs when still alive', async () => {
    vi.useFakeTimers()
    await writeSession(tmpDir, {
      id: 'STUBBORN',
      pid: 2000,
      meta: { last_activity_ts: FIXED_NOW - 31 * 60_000 },
    })
    const killCalls: Array<[number, string]> = []
    const reaper = createReaper(
      baseOpts({
        livenessCheck: () => true,
        kill: (pid, sig) => killCalls.push([pid, sig]),
        sigtermGraceMs: 10_000,
      }),
    )
    await reaper.reapOnce()
    expect(killCalls).toEqual([[2000, 'SIGTERM']])

    // Advance fake timers past the grace window — watchdog fires SIGKILL.
    vi.advanceTimersByTime(10_001)
    expect(killCalls).toEqual([
      [2000, 'SIGTERM'],
      [2000, 'SIGKILL'],
    ])
    reaper.stop()
  })

  it('skips crash mark when .exit file already present (TOCTOU)', async () => {
    await writeSession(tmpDir, {
      id: 'RACED',
      pid: 3000,
      exit: { state: 'aborted', exit_code: 0, duration_ms: 42 },
    })
    const logger = mkLogger()
    const reaper = createReaper(
      baseOpts({
        livenessCheck: () => false,
        logger,
      }),
    )
    const report = await reaper.reapOnce()
    reaper.stop()

    expect(report.markedCrashed).toEqual([])
    // Original "aborted" state preserved — not overwritten.
    const exitContent = await fs.readFile(nodePath.join(tmpDir, 'RACED.exit'), 'utf8')
    expect(JSON.parse(exitContent).state).toBe('aborted')
    expect(
      logger.infoCalls.some((l) => l.includes('exit file already present') && l.includes('RACED')),
    ).toBe(true)
  })

  it('writes state:"crashed" exit file for dead pid with no exit', async () => {
    const pidMtime = FIXED_NOW - 5 * 60_000
    await writeSession(tmpDir, {
      id: 'CRASHED',
      pid: 999,
      pidMtime,
    })
    const reaper = createReaper(
      baseOpts({
        livenessCheck: () => false,
      }),
    )
    const report = await reaper.reapOnce()
    reaper.stop()

    expect(report.markedCrashed).toEqual(['CRASHED'])
    const exitContent = await fs.readFile(nodePath.join(tmpDir, 'CRASHED.exit'), 'utf8')
    const exit = JSON.parse(exitContent)
    expect(exit.state).toBe('crashed')
    expect(exit.exit_code).toBeNull()
    expect(typeof exit.duration_ms).toBe('number')
    // duration_ms should be roughly (now - pid mtime) = 5 min
    expect(exit.duration_ms).toBeGreaterThan(4 * 60_000)
    expect(exit.duration_ms).toBeLessThan(6 * 60_000)
  })

  it('meta-missing fallback uses pid mtime for staleness', async () => {
    const pidMtime = FIXED_NOW - 31 * 60_000
    await writeSession(tmpDir, {
      id: 'NOMETA',
      pid: 4000,
      pidMtime,
    })
    const killCalls: Array<[number, string]> = []
    const reaper = createReaper(
      baseOpts({
        livenessCheck: () => true,
        kill: (pid, sig) => killCalls.push([pid, sig]),
      }),
    )
    const report = await reaper.reapOnce()
    reaper.stop()

    expect(report.sigtermed).toEqual(['NOMETA'])
    expect(killCalls).toEqual([[4000, 'SIGTERM']])
  })

  it('unlinks stale .cmd file with no matching pid', async () => {
    const cmdMtime = FIXED_NOW - 6 * 60_000
    await writeSession(tmpDir, {
      id: 'ORPHAN',
      writeCmd: true,
      cmdMtime,
    })
    const reaper = createReaper(baseOpts())
    const report = await reaper.reapOnce()
    reaper.stop()

    expect(report.cmdOrphansDeleted).toEqual(['ORPHAN'])
    await expect(fs.stat(nodePath.join(tmpDir, 'ORPHAN.cmd'))).rejects.toThrow()
  })

  it('does NOT unlink .cmd when young or when matching live pid exists', async () => {
    // Case A: young .cmd (3 min old)
    await writeSession(tmpDir, {
      id: 'YOUNG',
      writeCmd: true,
      cmdMtime: FIXED_NOW - 3 * 60_000,
    })
    // Case B: old .cmd but matching live pid
    await writeSession(tmpDir, {
      id: 'LIVE-CMD',
      pid: 5000,
      writeCmd: true,
      cmdMtime: FIXED_NOW - 10 * 60_000,
    })
    const reaper = createReaper(
      baseOpts({
        livenessCheck: (pid) => pid === 5000,
      }),
    )
    const report = await reaper.reapOnce()
    reaper.stop()

    expect(report.cmdOrphansDeleted).toEqual([])
    await expect(fs.stat(nodePath.join(tmpDir, 'YOUNG.cmd'))).resolves.toBeDefined()
    await expect(fs.stat(nodePath.join(tmpDir, 'LIVE-CMD.cmd'))).resolves.toBeDefined()
  })

  it('GCs all terminal files when .exit mtime exceeds threshold', async () => {
    const exitMtime = FIXED_NOW - 61 * 60_000
    await writeSession(tmpDir, {
      id: 'OLD-DONE',
      pid: 6000,
      meta: { last_activity_ts: FIXED_NOW - 60 * 60_000, state: 'completed' },
      exit: { state: 'completed', exit_code: 0, duration_ms: 1234 },
      exitMtime,
      writeCmd: true,
      writeLog: true,
    })
    const reaper = createReaper(
      baseOpts({
        livenessCheck: () => false,
      }),
    )
    const report = await reaper.reapOnce()
    reaper.stop()

    expect(report.terminalFilesDeleted).toEqual(['OLD-DONE'])
    for (const suffix of ['.pid', '.meta.json', '.exit', '.log', '.cmd']) {
      await expect(fs.stat(nodePath.join(tmpDir, `OLD-DONE${suffix}`))).rejects.toThrow()
    }
  })

  it('terminal GC also unlinks .meta.json.gap sidecars (spec GH#75 B8)', async () => {
    // Pre-populate an older-than-threshold terminal triplet PLUS a .gap
    // sidecar that a crashed runner would have left behind. All four should
    // disappear in a single sweep.
    const exitMtime = FIXED_NOW - 61 * 60_000
    await writeSession(tmpDir, {
      id: 'OLD-GAP',
      exit: { state: 'crashed', exit_code: null, duration_ms: 999 },
      exitMtime,
      writeLog: true,
    })
    const gapPath = nodePath.join(tmpDir, 'OLD-GAP.meta.json.gap')
    await fs.writeFile(
      gapPath,
      JSON.stringify({ type: 'gap', dropped_count: 1, from_seq: 1, to_seq: 1 }),
    )

    const reaper = createReaper(baseOpts({ livenessCheck: () => false }))
    const report = await reaper.reapOnce()
    reaper.stop()

    expect(report.terminalFilesDeleted).toEqual(['OLD-GAP'])
    await expect(fs.stat(gapPath)).rejects.toThrow()
    await expect(fs.stat(nodePath.join(tmpDir, 'OLD-GAP.exit'))).rejects.toThrow()
    await expect(fs.stat(nodePath.join(tmpDir, 'OLD-GAP.log'))).rejects.toThrow()
  })

  it('leaves terminal files alone when .exit is young', async () => {
    const exitMtime = FIXED_NOW - 30 * 60_000
    await writeSession(tmpDir, {
      id: 'RECENT-DONE',
      exit: { state: 'completed', exit_code: 0, duration_ms: 100 },
      exitMtime,
    })
    const reaper = createReaper(baseOpts())
    const report = await reaper.reapOnce()
    reaper.stop()

    expect(report.terminalFilesDeleted).toEqual([])
    await expect(fs.stat(nodePath.join(tmpDir, 'RECENT-DONE.exit'))).resolves.toBeDefined()
  })

  it('start() fires one immediate pass and schedules an interval; stop() cancels future passes', async () => {
    await writeSession(tmpDir, {
      id: 'TICK',
      pid: 7000,
      meta: { last_activity_ts: FIXED_NOW - 31 * 60_000 },
    })
    const killCalls: Array<[number, string]> = []
    // Large interval — we only want to assert the immediate pass ran and the
    // interval was scheduled, without actually letting it fire.
    const reaper = createReaper(
      baseOpts({
        intervalMs: 60_000,
        livenessCheck: () => true,
        kill: (pid, sig) => killCalls.push([pid, sig]),
      }),
    )

    reaper.start()
    // Yield to the event loop so the IIFE-wrapped immediate reapOnce completes.
    // Several microtask + macrotask hops are needed because reapOnce awaits
    // multiple fs operations internally.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(killCalls).toEqual([[7000, 'SIGTERM']])

    // Calling start() again should be idempotent (no double-scheduling).
    reaper.start()
    await new Promise((resolve) => setTimeout(resolve, 50))
    // awaitingKill suppresses a second SIGTERM on the same id.
    expect(killCalls.filter((c) => c[1] === 'SIGTERM')).toHaveLength(1)

    // stop() clears the interval and any pending SIGKILL watchdog.
    reaper.stop()
    // Idempotent stop — second call is a no-op.
    reaper.stop()
    // A subsequent reapOnce (invoked manually) still works.
    const report = await reaper.reapOnce()
    expect(report.scanned).toBe(1)
  })
})
