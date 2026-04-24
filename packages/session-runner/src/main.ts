/**
 * session-runner executable entrypoint.
 *
 * Spawned detached by `agent-gateway` with 7 positional arguments:
 *   session-runner <sessionId> <cmd-file> <callback_url> <bearer>
 *                  <pid-file> <exit-file> <meta-file>
 *
 * Lifecycle:
 *   1. Parse argv; bail to stderr + exit(2) on arity mismatch.
 *   2. Read cmd-file synchronously. On any failure → write exit-file
 *      `{state:"failed", exit_code:1, error}` and exit(1).
 *   3. Concurrent-resume guard: scan sibling *.meta.json for a live sdk_session_id match.
 *   4. Write pid-file (plain writeFile — nobody races us for this one).
 *   5. Dial DO via BufferedChannel + DialBackClient. Build RunnerSessionContext.
 *   6. Run runner.execute / runner.resume.
 *   7. Every 10s, atomically overwrite the meta-file with ctx.meta.
 *      5 consecutive failures → abortController.abort() (let runner terminate).
 *   8. On terminal resolution or thrown error → flush meta, write exit-file once,
 *      stop DialBackClient, process.exit(0).
 *   9. SIGTERM: abort + 2s watchdog — if watchdog fires first, force-write an
 *      aborted exit-file and process.exit(1).
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { BufferedChannel, DialBackClient, type GapSentinel } from '@duraclaw/shared-transport'
import type { ExecuteCommand, GatewayCommand, ResumeCommand } from '@duraclaw/shared-types'
import { atomicOverwrite, atomicWriteOnce } from './atomic.js'
import { ClaudeRunner } from './claude-runner.js'
import { handleQueryCommand, type QueueableCommand } from './commands.js'
import type { RunnerSessionContext } from './types.js'

const META_INTERVAL_MS = 10_000
const META_FAILURE_LIMIT = 5
const SIGTERM_GRACE_MS = 2_000
const HEARTBEAT_INTERVAL_MS = 15_000

interface Argv {
  sessionId: string
  cmdFile: string
  callbackUrl: string
  bearer: string
  pidFile: string
  exitFile: string
  metaFile: string
}

function parseArgv(args: string[]): Argv {
  if (args.length !== 7) {
    process.stderr.write(
      `[session-runner] expected 7 positional args, got ${args.length}\n` +
        'usage: session-runner <sessionId> <cmd-file> <callback_url> <bearer> <pid-file> <exit-file> <meta-file>\n',
    )
    process.exit(2)
  }
  return {
    sessionId: args[0],
    cmdFile: args[1],
    callbackUrl: args[2],
    bearer: args[3],
    pidFile: args[4],
    exitFile: args[5],
    metaFile: args[6],
  }
}

/**
 * Write an exit-file atomically and exit the process.
 * Used for the cmd-file-unreadable path and concurrent-resume guard, where we
 * must exit before ever creating a RunnerSessionContext or writing a pid.
 *
 * Note: return type is `never` — `process.exit()` terminates the process, and
 * any code after the `await` is unreachable. Callers can still write
 * `await writeExitAndExit(...)` and trust the process will not continue.
 */
async function writeExitAndExit(
  exitFile: string,
  payload: Record<string, unknown>,
  code: number,
): Promise<never> {
  try {
    const outcome = await atomicWriteOnce(exitFile, JSON.stringify(payload))
    if (outcome === 'already_exists') {
      console.warn(`[session-runner] exit file already present, skipping (${exitFile})`)
    }
  } catch (err) {
    console.error(`[session-runner] failed to write exit file: ${(err as Error).message}`)
  }
  process.exit(code)
}

/**
 * Concurrent-resume guard — block a second `resume` against a still-running
 * sdk_session_id. Scans sibling *.meta.json in the pid-file's directory.
 * Meta files without a matching live pid are silently ignored.
 */
async function hasLiveResume(cmd: ResumeCommand, pidFile: string): Promise<boolean> {
  const dir = path.dirname(pidFile)
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return false
  }
  for (const entry of entries) {
    if (!entry.endsWith('.meta.json')) continue
    const metaPath = path.join(dir, entry)
    let parsed: { sdk_session_id?: unknown }
    try {
      const raw = await fs.readFile(metaPath, 'utf8')
      parsed = JSON.parse(raw)
    } catch {
      continue
    }
    if (parsed.sdk_session_id !== cmd.sdk_session_id) continue

    // Resolve sibling pid file: strip `.meta.json`, append `.pid`.
    const base = entry.slice(0, -'.meta.json'.length)
    const siblingPid = path.join(dir, `${base}.pid`)
    let pidRaw: string
    try {
      pidRaw = await fs.readFile(siblingPid, 'utf8')
    } catch {
      continue
    }
    let pid: number
    try {
      pid = JSON.parse(pidRaw).pid
    } catch {
      continue
    }
    if (typeof pid !== 'number' || pid <= 0) continue
    try {
      process.kill(pid, 0)
      return true
    } catch {
      // Dead pid — ignore.
    }
  }
  return false
}

/**
 * Handle a command received from the DO over the dial-back WS.
 * Mirrors the gateway's old `handleDialbackMessage` but against a
 * RunnerSessionContext instead of a gateway session context.
 */
function handleIncomingCommand(msg: unknown, ctx: RunnerSessionContext, ch: BufferedChannel): void {
  if (!msg || typeof msg !== 'object') return
  const m = msg as Record<string, unknown>
  switch (m.type) {
    case 'stream-input': {
      if (!m.message) break
      const msg = m.message as { role: 'user'; content: string }

      // GH#86: fire pivot-retitle in parallel with the main query —
      // zero added latency, fire-and-forget, errors swallowed in titler.
      if (ctx.titler) {
        const userText = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
        ctx.titler.maybePivotRetitle([], userText).catch(() => {})
      }

      // Mid-flight steering: if the SDK query is actively running (not
      // between turns waiting on waitForNext), inject directly via
      // streamInput() so the model sees the user message immediately —
      // same mechanism the CLI uses for mid-generation steering.
      if (ctx.query) {
        const sdkMsg = {
          type: 'user' as const,
          message: { role: 'user' as const, content: msg.content },
          parent_tool_use_id: null,
          priority: 'now' as const,
        }
        async function* singleMessage() {
          yield sdkMsg
        }
        ctx.query.streamInput(singleMessage()).catch((err: unknown) => {
          console.error(
            `[session-runner] streamInput error: ${err instanceof Error ? err.message : String(err)}`,
          )
          // Fall back to queue so the message isn't lost
          ctx.messageQueue?.push(msg)
        })
      } else if (ctx.messageQueue) {
        // Between turns — queue for the next waitForNext() call
        ctx.messageQueue.push(msg)
      }
      break
    }
    case 'permission-response': {
      if (ctx.pendingPermission) {
        ctx.pendingPermission.resolve(Boolean(m.allowed))
        ctx.pendingPermission = null
      }
      break
    }
    case 'answer': {
      if (ctx.pendingAnswer) {
        ctx.pendingAnswer.resolve((m.answers as Record<string, string>) ?? {})
        ctx.pendingAnswer = null
      }
      break
    }
    case 'abort':
    case 'stop': {
      ctx.abortController.abort()
      break
    }
    case 'interrupt':
    case 'get-context-usage':
    case 'set-model':
    case 'set-permission-mode': {
      const queueable = m as unknown as QueueableCommand
      if (ctx.query) {
        handleQueryCommand(ctx, queueable, ch).catch((err) => {
          console.error(`[session-runner] handleQueryCommand error: ${(err as Error).message}`)
        })
      } else {
        ctx.commandQueue.push(queueable)
      }
      break
    }
    case 'stop-task': {
      const taskId = m.task_id
      if (ctx.query && typeof taskId === 'string') {
        ;(ctx.query as unknown as { stopTask: (id: string) => unknown }).stopTask(taskId)
      }
      break
    }
    case 'rewind': {
      if (ctx.query) {
        const q = ctx.query as unknown as {
          rewindFiles: (
            id: string,
            opts: { dryRun?: boolean },
          ) => Promise<{
            canRewind: boolean
            error?: string
            filesChanged?: string[]
            insertions?: number
            deletions?: number
          }>
        }
        q.rewindFiles(String(m.message_id), { dryRun: Boolean(m.dry_run) })
          .then((result) => {
            ch.send({
              type: 'rewind_result',
              session_id: ctx.sessionId,
              can_rewind: result.canRewind,
              error: result.error,
              files_changed: result.filesChanged,
              insertions: result.insertions,
              deletions: result.deletions,
              seq: ++ctx.nextSeq,
            })
          })
          .catch((err: unknown) => {
            ch.send({
              type: 'error',
              session_id: ctx.sessionId,
              error: `Rewind failed: ${err instanceof Error ? err.message : String(err)}`,
              seq: ++ctx.nextSeq,
            })
          })
      }
      break
    }
    case 'ping': {
      // Just ack — no seq needed (diagnostic).
      ch.send({ type: 'pong', seq: ++ctx.nextSeq })
      break
    }
  }
}

async function main(): Promise<void> {
  const argv = parseArgv(process.argv.slice(2))
  const startTime = Date.now()

  // --- Step 2: read cmd-file ---
  let cmd: GatewayCommand | null = null
  let parseErr: Error | null = null
  try {
    const raw = await fs.readFile(argv.cmdFile, 'utf8')
    cmd = JSON.parse(raw) as GatewayCommand
  } catch (err) {
    parseErr = err instanceof Error ? err : new Error(String(err))
  }
  if (!cmd) {
    return writeExitAndExit(
      argv.exitFile,
      {
        state: 'failed',
        exit_code: 1,
        error: `cmd-file unreadable: ${parseErr?.message ?? 'unknown'}`,
      },
      1,
    )
  }

  if (cmd.type !== 'execute' && cmd.type !== 'resume') {
    return writeExitAndExit(
      argv.exitFile,
      {
        state: 'failed',
        exit_code: 1,
        error: `cmd-file unreadable: unsupported cmd.type=${(cmd as { type?: string }).type}`,
      },
      1,
    )
  }

  // --- Step 3: concurrent-resume guard ---
  if (cmd.type === 'resume') {
    const isLive = await hasLiveResume(cmd, argv.pidFile)
    if (isLive) {
      return writeExitAndExit(
        argv.exitFile,
        { state: 'failed', exit_code: 2, error: 'sdk_session_id already active' },
        2,
      )
    }
  }

  // --- Step 4: write pid-file ---
  const pidPayload = {
    pid: process.pid,
    sessionId: argv.sessionId,
    started_at: Date.now(),
  }
  await fs.writeFile(argv.pidFile, JSON.stringify(pidPayload))

  // --- Step 5: dial + SDK ---
  // Spec GH#75 B8 — if a prior runner crashed between BufferedChannel
  // overflow and WS reattach, the `.gap` sidecar holds the coalesced
  // sentinel we need to replay on first attach. Parse defensively: any
  // read/parse/shape failure falls through to a fresh channel (the gap is
  // lost, but startup is never blocked).
  const gapPath = `${argv.metaFile}.gap`
  let initialPendingGap: GapSentinel | null = null
  try {
    const raw = await fs.readFile(gapPath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<GapSentinel>
    if (
      parsed &&
      parsed.type === 'gap' &&
      typeof parsed.dropped_count === 'number' &&
      typeof parsed.from_seq === 'number' &&
      typeof parsed.to_seq === 'number'
    ) {
      initialPendingGap = {
        type: 'gap',
        dropped_count: parsed.dropped_count,
        from_seq: parsed.from_seq,
        to_seq: parsed.to_seq,
      }
    } else {
      console.warn(`[session-runner] ignoring malformed .gap sidecar at ${gapPath}`)
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      console.warn(
        `[session-runner] failed to read .gap sidecar at ${gapPath}: ${(err as Error).message}`,
      )
    }
  }

  const channel = new BufferedChannel({
    initialPendingGap,
    // Spec GH#75 B8 — atomically persist the sentinel on every overflow,
    // unlink on a successful drain. atomicOverwrite handles tmp+rename so
    // a crash mid-write never leaves a torn JSON.
    persistGap: async (gap) => {
      if (gap === null) {
        try {
          await fs.unlink(gapPath)
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
        }
      } else {
        await atomicOverwrite(gapPath, JSON.stringify(gap))
      }
    },
  })

  // Build the per-session context. `messageQueue` / `query` are filled by the
  // runner once session.init arrives; `commandQueue` buffers DO->runner
  // commands received before that moment.
  const ctx: RunnerSessionContext = {
    sessionId: argv.sessionId,
    abortController: new AbortController(),
    interrupted: false,
    pendingAnswer: null,
    pendingPermission: null,
    messageQueue: null,
    query: null,
    commandQueue: [],
    titler: null,
    nextSeq: 0,
    meta: {
      sdk_session_id: null,
      last_activity_ts: Date.now(),
      last_event_seq: 0,
      cost: { input_tokens: 0, output_tokens: 0, usd: 0 },
      model: null,
      turn_count: 0,
      state: 'running',
    },
  }

  const dialBackClient = new DialBackClient({
    callbackUrl: argv.callbackUrl,
    bearer: argv.bearer,
    channel,
    onCommand: (raw) => handleIncomingCommand(raw, ctx, channel),
    // The DO owns session lifecycle via callback-token validation. When it
    // sends a terminal close code (4401 invalid / 4410 rotated) the runner
    // has no business staying alive — abort the SDK query so main's
    // clean-shutdown path runs and writes the exit file. Same for reconnect
    // exhaustion: we can no longer reach anyone.
    onTerminate: (reason) => {
      console.warn(`[session-runner] dial-back terminated: ${reason} — aborting SDK query`)
      ctx.meta.state = 'aborted'
      ctx.abortController.abort()
    },
  })
  dialBackClient.start()

  // --- Step 8: meta-file dumper ---
  let consecutiveMetaFailures = 0
  const flushMeta = async () => {
    try {
      await atomicOverwrite(argv.metaFile, JSON.stringify(ctx.meta))
      consecutiveMetaFailures = 0
    } catch (err) {
      consecutiveMetaFailures++
      console.error(
        `[session-runner] meta write failed (${consecutiveMetaFailures}/${META_FAILURE_LIMIT}): ${(err as Error).message}`,
      )
      if (consecutiveMetaFailures >= META_FAILURE_LIMIT) {
        console.error('[session-runner] meta write failure limit reached — aborting session')
        ctx.abortController.abort()
      }
    }
  }
  // First snapshot immediately so the meta-file exists before the runner
  // produces its first event — the reaper's staleness check can pick it up.
  // Errors here count toward the same budget.
  await flushMeta()
  const metaTimer = setInterval(flushMeta, META_INTERVAL_MS)

  // Heartbeat: prove liveness to the DO so its watchdog can detect silent
  // runner death. The DO already bumps `lastGatewayActivity` on any gateway
  // message (onMessage handler), so this lightweight event is sufficient.
  const heartbeatTimer = setInterval(() => {
    channel.send({
      type: 'heartbeat',
      session_id: argv.sessionId,
      seq: ++ctx.nextSeq,
    })
  }, HEARTBEAT_INTERVAL_MS)

  // --- Step 10: SIGTERM handler ---
  let forcedExit = false
  const sigtermHandler = () => {
    console.warn('[session-runner] SIGTERM received — aborting')
    ctx.abortController.abort()
    setTimeout(async () => {
      if (forcedExit) return
      forcedExit = true
      clearInterval(metaTimer)
      clearInterval(heartbeatTimer)
      try {
        await atomicOverwrite(argv.metaFile, JSON.stringify(ctx.meta))
      } catch {
        /* best-effort */
      }
      const payload = {
        state: 'aborted',
        exit_code: 0,
        duration_ms: Date.now() - startTime,
      }
      try {
        const outcome = await atomicWriteOnce(argv.exitFile, JSON.stringify(payload))
        if (outcome === 'already_exists') {
          console.warn('[session-runner] exit file already present, skipping')
        }
      } catch (err) {
        console.error(`[session-runner] force-exit write failed: ${(err as Error).message}`)
      }
      try {
        await dialBackClient.stop()
      } catch {
        /* best-effort */
      }
      process.exit(1)
    }, SIGTERM_GRACE_MS).unref()
  }
  process.on('SIGTERM', sigtermHandler)

  // --- Step 6: run ---
  const runner = new ClaudeRunner()
  let caughtError: Error | null = null
  try {
    if (cmd.type === 'execute') {
      await runner.execute(channel, cmd as ExecuteCommand, ctx)
    } else {
      await runner.resume(channel, cmd as ResumeCommand, ctx)
    }
  } catch (err) {
    caughtError = err instanceof Error ? err : new Error(String(err))
  }

  // --- Step 9: clean shutdown ---
  if (forcedExit) return // SIGTERM watchdog already handled the exit
  clearInterval(metaTimer)
  clearInterval(heartbeatTimer)
  // Best-effort final meta flush — don't let it throw.
  try {
    await atomicOverwrite(argv.metaFile, JSON.stringify(ctx.meta))
  } catch {
    /* swallow */
  }

  const durationMs = Date.now() - startTime
  let exitPayload: Record<string, unknown>
  if (
    ctx.meta.state === 'completed' ||
    ctx.meta.state === 'failed' ||
    ctx.meta.state === 'aborted'
  ) {
    // aborted (SIGTERM) and completed both exit with 0 per B3; only `failed`
    // maps to 1. The exit code here is informational in the exit-file — the
    // process itself always exits 0 on the clean-shutdown path.
    const exitCode = ctx.meta.state === 'failed' ? 1 : 0
    exitPayload = {
      state: ctx.meta.state,
      exit_code: exitCode,
      duration_ms: durationMs,
    }
  } else if (caughtError) {
    exitPayload = {
      state: 'failed',
      exit_code: 1,
      error: caughtError.message,
      duration_ms: durationMs,
    }
  } else {
    exitPayload = {
      state: 'completed',
      exit_code: 0,
      duration_ms: durationMs,
    }
  }

  try {
    const outcome = await atomicWriteOnce(argv.exitFile, JSON.stringify(exitPayload))
    if (outcome === 'already_exists') {
      console.warn('[session-runner] exit file already present, skipping')
    }
  } catch (err) {
    console.error(`[session-runner] exit-file write failed: ${(err as Error).message}`)
  }

  try {
    await dialBackClient.stop()
  } catch {
    /* best-effort */
  }

  process.exit(0)
}

main().catch((err) => {
  // Last-ditch safety — should not normally reach here; main() is a full
  // try/catch. If something outside the try blew up, log + exit 1.
  console.error(`[session-runner] fatal in main(): ${(err as Error).stack ?? err}`)
  process.exit(1)
})
