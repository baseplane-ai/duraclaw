import fs from 'node:fs/promises'
import path from 'node:path'
import { getDocsRunnersDir } from './docs-runner-handlers.js'
import { defaultLivenessCheck, getSessionsDir, type LivenessCheck } from './session-state.js'
import type { ExitFile, MetaFile } from './types.js'

// ── Defaults (B6) ──────────────────────────────────────────────────
const DEFAULT_INTERVAL_MS = 5 * 60_000
const DEFAULT_STALE_THRESHOLD_MS = 30 * 60_000
const DEFAULT_SIGTERM_GRACE_MS = 10_000
const DEFAULT_CMD_ORPHAN_MAX_AGE_MS = 5 * 60_000
const DEFAULT_TERMINAL_FILE_MAX_AGE_MS = 60 * 60_000

// ── Types ──────────────────────────────────────────────────────────

export type KillFn = (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void

export interface ReaperLogger {
  info: (msg: string, ...rest: unknown[]) => void
  warn: (msg: string, ...rest: unknown[]) => void
  error: (msg: string, ...rest: unknown[]) => void
}

export interface ReaperOptions {
  sessionsDir: string
  /**
   * Additional directories to sweep on each pass alongside `sessionsDir`.
   * Used so the docs-runner control-file dir gets the same staleness /
   * SIGTERM / orphan-GC / terminal-GC treatment as `/run/duraclaw/sessions`.
   */
  extraDirs?: string[]
  livenessCheck?: LivenessCheck
  kill?: KillFn
  now?: () => number
  intervalMs?: number
  staleThresholdMs?: number
  sigtermGraceMs?: number
  cmdOrphanMaxAgeMs?: number
  terminalFileMaxAgeMs?: number
  logger?: ReaperLogger
}

export interface ReapReport {
  scanned: number
  sigtermed: string[]
  sigkilled: string[]
  markedCrashed: string[]
  cmdOrphansDeleted: string[]
  terminalFilesDeleted: string[]
}

export interface Reaper {
  start: () => void
  stop: () => void
  reapOnce: () => Promise<ReapReport>
}

// ── Helpers ────────────────────────────────────────────────────────

const defaultKill: KillFn = (pid, signal) => {
  process.kill(pid, signal)
}

const defaultLogger: ReaperLogger = {
  info: (msg, ...rest) => console.log(msg, ...rest),
  warn: (msg, ...rest) => console.warn(msg, ...rest),
  error: (msg, ...rest) => console.error(msg, ...rest),
}

const PID_SUFFIX = '.pid'
const CMD_SUFFIX = '.cmd'
const EXIT_SUFFIX = '.exit'

async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

async function statOrNull(filePath: string): Promise<{ mtimeMs: number } | null> {
  try {
    const s = await fs.stat(filePath)
    return { mtimeMs: s.mtimeMs }
  } catch {
    return null
  }
}

async function unlinkSafe(filePath: string, logger: ReaperLogger): Promise<boolean> {
  try {
    await fs.unlink(filePath)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return false
    logger.warn(`[reaper] unlink failed path=${filePath} err=${(err as Error).message}`)
    return false
  }
}

/**
 * Write a file exactly once — mirror of session-runner's atomicWriteOnce but
 * local to the gateway (never imported from session-runner). writeFile to a
 * .tmp sibling, then fs.link(tmp, final). EEXIST means someone else (the
 * session-runner itself) already won the race; we unlink tmp and move on.
 */
async function writeExitOnce(
  finalPath: string,
  payload: string,
): Promise<'written' | 'already_exists'> {
  const tmp = `${finalPath}.tmp.${process.pid}.${Date.now()}`
  await fs.writeFile(tmp, payload)
  try {
    await fs.link(tmp, finalPath)
    return 'written'
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EEXIST') return 'already_exists'
    throw err
  } finally {
    try {
      await fs.unlink(tmp)
    } catch {
      /* tmp already gone — swallow */
    }
  }
}

function parseSessionIdFromPidEntry(name: string): string | null {
  if (!name.endsWith(PID_SUFFIX)) return null
  return name.slice(0, -PID_SUFFIX.length)
}

function parseSessionIdFromCmdEntry(name: string): string | null {
  if (!name.endsWith(CMD_SUFFIX)) return null
  return name.slice(0, -CMD_SUFFIX.length)
}

function parseSessionIdFromExitEntry(name: string): string | null {
  if (!name.endsWith(EXIT_SUFFIX)) return null
  return name.slice(0, -EXIT_SUFFIX.length)
}

// ── Reaper factory ────────────────────────────────────────────────

export function createReaper(opts: ReaperOptions): Reaper {
  const sessionsDir = opts.sessionsDir
  const extraDirs = opts.extraDirs ?? []
  const livenessCheck = opts.livenessCheck ?? defaultLivenessCheck
  const kill = opts.kill ?? defaultKill
  const now = opts.now ?? Date.now
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS
  const staleThresholdMs = opts.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS
  const sigtermGraceMs = opts.sigtermGraceMs ?? DEFAULT_SIGTERM_GRACE_MS
  const cmdOrphanMaxAgeMs = opts.cmdOrphanMaxAgeMs ?? DEFAULT_CMD_ORPHAN_MAX_AGE_MS
  const terminalFileMaxAgeMs = opts.terminalFileMaxAgeMs ?? DEFAULT_TERMINAL_FILE_MAX_AGE_MS
  const logger = opts.logger ?? defaultLogger

  // Cadence state
  let interval: ReturnType<typeof setInterval> | null = null

  // Pending SIGKILL escalation watchdogs, keyed by session id.
  const killTimers = new Map<string, ReturnType<typeof setTimeout>>()
  // Session ids we have SIGTERMed and are awaiting liveness decay on.
  const awaitingKill = new Map<string, { pid: number; termedAt: number }>()

  function cancelKillTimer(sessionId: string): void {
    const t = killTimers.get(sessionId)
    if (t) {
      clearTimeout(t)
      killTimers.delete(sessionId)
    }
    awaitingKill.delete(sessionId)
  }

  function scheduleSigkillWatchdog(sessionId: string, pid: number): void {
    // If we already have one, don't stack.
    if (killTimers.has(sessionId)) return
    const timer = setTimeout(() => {
      killTimers.delete(sessionId)
      // Still alive after the grace window? escalate.
      if (livenessCheck(pid)) {
        try {
          logger.info(`[reaper] sigkill escalation sessionId=${sessionId} pid=${pid}`)
          kill(pid, 'SIGKILL')
        } catch (err) {
          logger.warn(
            `[reaper] SIGKILL failed sessionId=${sessionId} pid=${pid} err=${(err as Error).message}`,
          )
        }
      } else {
        // Raced and died on its own — nothing to do.
        awaitingKill.delete(sessionId)
      }
    }, sigtermGraceMs)
    // setTimeout in Node returns an object with .unref(); unref so the
    // gateway process can exit even if a watchdog is pending.
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      ;(timer as { unref: () => void }).unref()
    }
    killTimers.set(sessionId, timer)
  }

  async function reapDir(
    dir: string,
    report: ReapReport,
    inflight: Array<{ id: string; pid: number; ageSec: number; idleSec: number; seq: number }>,
  ): Promise<void> {
    logger.info(`[reaper] scan start dir=${dir} ts=${now()}`)

    let entries: string[]
    try {
      entries = await fs.readdir(dir)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        return
      }
      throw err
    }

    const pidNames = entries.filter((n) => n.endsWith(PID_SUFFIX))
    const cmdNames = entries.filter((n) => n.endsWith(CMD_SUFFIX))
    const exitNames = entries.filter((n) => n.endsWith(EXIT_SUFFIX))
    report.scanned += pidNames.length

    // ── 1. Scan pid files ────────────────────────────────────────
    for (const pidName of pidNames) {
      const sessionId = parseSessionIdFromPidEntry(pidName)
      if (!sessionId) continue

      const pidPath = path.join(dir, pidName)
      const metaPath = path.join(dir, `${sessionId}.meta.json`)
      const exitPath = path.join(dir, `${sessionId}.exit`)

      const pidFile = await readJsonIfExists<{ pid: number }>(pidPath)
      const pidFileStat = await statOrNull(pidPath)
      const pid =
        pidFile &&
        typeof pidFile.pid === 'number' &&
        Number.isFinite(pidFile.pid) &&
        pidFile.pid > 0
          ? pidFile.pid
          : null

      const alive = pid !== null ? livenessCheck(pid) : false

      // Determine staleness: prefer meta.last_activity_ts, fall back to pid mtime.
      const meta = await readJsonIfExists<MetaFile>(metaPath)
      let lastActivityTs: number | null = null
      if (meta && typeof meta.last_activity_ts === 'number') {
        lastActivityTs = meta.last_activity_ts
      } else if (pidFileStat) {
        lastActivityTs = pidFileStat.mtimeMs
      }

      const currentNow = now()
      const stale = lastActivityTs !== null && currentNow - lastActivityTs > staleThresholdMs

      if (alive && pid !== null) {
        // Track for the inflight summary line at scan end.
        const ageSec = pidFileStat ? Math.round((currentNow - pidFileStat.mtimeMs) / 1000) : 0
        const idleSec =
          lastActivityTs !== null ? Math.round((currentNow - lastActivityTs) / 1000) : -1
        inflight.push({
          id: sessionId,
          pid,
          ageSec,
          idleSec,
          seq: meta?.last_event_seq ?? 0,
        })

        // Previously SIGTERMed and still alive? The watchdog handles escalation
        // via setTimeout; here we only need to detect NEW stale sessions.
        if (stale && !awaitingKill.has(sessionId)) {
          try {
            logger.info(
              `[reaper] stale session sessionId=${sessionId} alive=true last_activity_ts=${lastActivityTs} — SIGTERM`,
            )
            kill(pid, 'SIGTERM')
            awaitingKill.set(sessionId, { pid, termedAt: currentNow })
            report.sigtermed.push(sessionId)
            scheduleSigkillWatchdog(sessionId, pid)
            // Report sigkilled targets are populated by the watchdog's own
            // firing path if it runs during a subsequent reapOnce. We don't
            // synthesize them here.
          } catch (err) {
            logger.warn(
              `[reaper] SIGTERM failed sessionId=${sessionId} pid=${pid} err=${(err as Error).message}`,
            )
          }
        }
        continue
      }

      // Process not alive: cancel any pending escalation.
      if (awaitingKill.has(sessionId)) {
        cancelKillTimer(sessionId)
      }

      // Dead + no exit → write crashed marker atomically (link+EEXIST).
      // Pre-check is a fast path; the canonical guard is fs.link's own
      // EEXIST semantics (session-runner may write between our stat and link).
      const existingExit = await readJsonIfExists<ExitFile>(exitPath)
      if (existingExit) {
        logger.info(`[reaper] exit file already present, skipping sessionId=${sessionId}`)
      } else {
        const durationMs = pidFileStat ? currentNow - pidFileStat.mtimeMs : 0
        const payload = JSON.stringify({
          state: 'crashed',
          exit_code: null,
          duration_ms: durationMs,
        })
        try {
          const result = await writeExitOnce(exitPath, payload)
          if (result === 'written') {
            report.markedCrashed.push(sessionId)
            logger.info(`[reaper] crash marked sessionId=${sessionId} duration_ms=${durationMs}`)
          } else {
            logger.info(`[reaper] exit file already present, skipping sessionId=${sessionId}`)
          }
        } catch (err) {
          logger.warn(
            `[reaper] crash write failed sessionId=${sessionId} err=${(err as Error).message}`,
          )
        }
      }
    }

    // ── 2. GC stale .cmd files ──────────────────────────────────
    for (const cmdName of cmdNames) {
      const sessionId = parseSessionIdFromCmdEntry(cmdName)
      if (!sessionId) continue
      const cmdPath = path.join(dir, cmdName)
      const cmdStat = await statOrNull(cmdPath)
      if (!cmdStat) continue

      const age = now() - cmdStat.mtimeMs
      if (age <= cmdOrphanMaxAgeMs) continue

      // Matching live pid? Skip GC.
      const pidPath = path.join(dir, `${sessionId}.pid`)
      const pidFile = await readJsonIfExists<{ pid: number }>(pidPath)
      const pid =
        pidFile &&
        typeof pidFile.pid === 'number' &&
        Number.isFinite(pidFile.pid) &&
        pidFile.pid > 0
          ? pidFile.pid
          : null
      const matchingLive = pid !== null && livenessCheck(pid)
      if (matchingLive) continue

      const removed = await unlinkSafe(cmdPath, logger)
      if (removed) report.cmdOrphansDeleted.push(sessionId)
    }

    // ── 3. Terminal file GC ────────────────────────────────────
    for (const exitName of exitNames) {
      const sessionId = parseSessionIdFromExitEntry(exitName)
      if (!sessionId) continue
      const exitPath = path.join(dir, exitName)
      const exitStat = await statOrNull(exitPath)
      if (!exitStat) continue
      const age = now() - exitStat.mtimeMs
      if (age <= terminalFileMaxAgeMs) continue

      const pidPath = path.join(dir, `${sessionId}.pid`)
      const metaPath = path.join(dir, `${sessionId}.meta.json`)
      // Spec GH#75 B8 — the BufferedChannel gap-sentinel sidecar lives next
      // to the meta file; clean it up in the same terminal-GC sweep so we
      // don't leave orphaned `.gap` files for sessions that have long since
      // finished.
      const gapPath = path.join(dir, `${sessionId}.meta.json.gap`)
      const logPath = path.join(dir, `${sessionId}.log`)
      const cmdPath = path.join(dir, `${sessionId}.cmd`)

      // Unlink best-effort — ENOENT is fine.
      await unlinkSafe(pidPath, logger)
      await unlinkSafe(metaPath, logger)
      await unlinkSafe(gapPath, logger)
      await unlinkSafe(exitPath, logger)
      await unlinkSafe(logPath, logger)
      await unlinkSafe(cmdPath, logger)
      report.terminalFilesDeleted.push(sessionId)
    }
  }

  async function reapOnce(): Promise<ReapReport> {
    const report: ReapReport = {
      scanned: 0,
      sigtermed: [],
      sigkilled: [],
      markedCrashed: [],
      cmdOrphansDeleted: [],
      terminalFilesDeleted: [],
    }

    // Per-session snapshot collected during the scan, emitted as a single
    // structured log at the end. Helps reason about what's running between
    // reaps without having to hit /sessions or tail individual session logs.
    const inflight: Array<{
      id: string
      pid: number
      ageSec: number
      idleSec: number
      seq: number
    }> = []

    for (const dir of [sessionsDir, ...extraDirs]) {
      await reapDir(dir, report, inflight)
    }

    logger.info(
      `[reaper] scan complete scanned=${report.scanned} sigtermed=[${report.sigtermed.join(',')}] sigkilled=[${report.sigkilled.join(',')}] crashed=[${report.markedCrashed.join(',')}] cmdOrphans=[${report.cmdOrphansDeleted.join(',')}] terminalDeleted=[${report.terminalFilesDeleted.join(',')}]`,
    )

    if (inflight.length > 0) {
      const summary = inflight
        .map((s) => `${s.id.slice(0, 8)}:pid${s.pid}/seq${s.seq}/age${s.ageSec}s/idle${s.idleSec}s`)
        .join(' ')
      logger.info(`[gateway] inflight=${inflight.length} ${summary}`)
    }

    return report
  }

  function start(): void {
    if (interval) return
    // Fire one pass immediately; swallow errors.
    void (async () => {
      try {
        await reapOnce()
      } catch (err) {
        logger.error(`[reaper] initial pass failed err=${(err as Error).message}`)
      }
    })()
    interval = setInterval(() => {
      void (async () => {
        try {
          await reapOnce()
        } catch (err) {
          logger.error(`[reaper] pass failed err=${(err as Error).message}`)
        }
      })()
    }, intervalMs)
    if (typeof (interval as { unref?: () => void }).unref === 'function') {
      ;(interval as { unref: () => void }).unref()
    }
  }

  function stop(): void {
    if (interval) {
      clearInterval(interval)
      interval = null
    }
    for (const [, t] of killTimers) {
      clearTimeout(t)
    }
    killTimers.clear()
    awaitingKill.clear()
  }

  return { start, stop, reapOnce }
}

// ── Module-level gateway reaper (used by server.ts) ────────────────

let moduleReaper: Reaper | null = null

/**
 * Lazily construct the module-level reaper for the gateway. Used by the
 * debug endpoint + startup wiring so tests can avoid the 5-min interval
 * by not calling `startReaper()`.
 */
export function getOrCreateReaper(): Reaper {
  if (moduleReaper) return moduleReaper
  moduleReaper = createReaper({
    sessionsDir: getSessionsDir(),
    extraDirs: [getDocsRunnersDir()],
  })
  return moduleReaper
}

/** Call from the bin entry point — starts the 5-min interval. */
export function startReaper(): void {
  getOrCreateReaper().start()
}

/** Call from the graceful-shutdown path. Idempotent. */
export function stopReaper(): void {
  if (moduleReaper) moduleReaper.stop()
}
