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
 *   3. Concurrent-resume guard: scan sibling *.meta.json for a live runner_session_id match.
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
import { ClaudeAdapter, createAdapter, type RunnerAdapter } from './adapters/index.js'
import { atomicOverwrite, atomicWriteOnce } from './atomic.js'
import type { RunnerSessionContext } from './types.js'

const META_INTERVAL_MS = 10_000
const META_FAILURE_LIMIT = 5
const SIGTERM_GRACE_MS = 2_000

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
 * runner_session_id. Scans sibling *.meta.json in the pid-file's directory.
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
    let parsed: { runner_session_id?: unknown }
    try {
      const raw = await fs.readFile(metaPath, 'utf8')
      parsed = JSON.parse(raw)
    } catch {
      continue
    }
    if (parsed.runner_session_id !== cmd.runner_session_id) continue

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
 *
 * `currentAdapter` is module-scope state (set in `main()` after the
 * registry returns) so codex sessions can route stream-input /
 * interrupt to the adapter's per-turn API instead of the Claude-only
 * lifetime queue.
 */
let currentAdapter: RunnerAdapter | null = null

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

      // GH#107: route via the adapter's pushUserTurn interface. Each
      // adapter owns the SDK coupling — ClaudeAdapter pushes onto the
      // lifetime PushPullQueue (spec 102-sdk-peelback B4+B5);
      // CodexAdapter kicks off a fresh per-turn `runStreamed()`.
      if (currentAdapter) {
        currentAdapter.pushUserTurn({ role: 'user', content: msg.content })
      } else {
        console.warn('[session-runner] stream-input arrived before adapter was ready — dropping')
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
      const answersObj =
        m.answers && typeof m.answers === 'object' ? (m.answers as Record<string, string>) : {}
      const keys = Object.keys(answersObj)
      const totalLen = keys.reduce((acc, k) => acc + (answersObj[k]?.length ?? 0), 0)
      const keySamples = keys.map((k) => k.slice(0, 60))
      if (ctx.pendingAnswer) {
        console.log(
          `[gate] answer received tool_call_id=${m.tool_call_id} keys=${keys.length} total_chars=${totalLen} key_samples=${JSON.stringify(keySamples)}`,
        )
        ctx.pendingAnswer.resolve(answersObj)
        ctx.pendingAnswer = null
      } else {
        // No pendingAnswer means: AbortSignal already cleared it (session
        // aborted or canUseTool rejected before this frame arrived). The
        // answer is silently dropped — the SDK has already moved on. Worth
        // a warn so we can correlate timing in playback.
        console.warn(
          `[gate] answer received but no pendingAnswer tool_call_id=${m.tool_call_id} keys=${keys.length} key_samples=${JSON.stringify(keySamples)}`,
        )
      }
      break
    }
    case 'stop': {
      // Close the lifetime queue first so the Query exhausts cleanly,
      // then abort to trigger the SIGTERM/watchdog shutdown path if
      // the SDK doesn't unwind on its own.
      try {
        ctx.userQueue?.close()
      } catch {
        /* close is idempotent in PushPullQueue; defensive */
      }
      ctx.abortController.abort()
      break
    }
    case 'interrupt': {
      // Mark the context as interrupted BEFORE delegating. On
      // long-running / mid-tool-use sessions the SDK's query generator can
      // throw rather than cleanly yield a result; the outer catch in
      // claude-runner.ts uses this flag to suppress the `error` event and
      // mark meta.state='aborted' so the session lands in `idle` ("just
      // pausing") instead of `error` (genuine failure). The lifetime
      // PushPullQueue is NOT touched — interrupt only stops the current
      // turn; the queue stays open for the next stream-input.
      // ClaudeAdapter.interrupt also sets ctx.interrupted; setting it
      // here too is idempotent and keeps the invariant explicit at the
      // dispatch site.
      ctx.interrupted = true
      // GH#107: route via the adapter interface — ClaudeAdapter calls
      // `ctx.query?.interrupt()` internally; CodexAdapter aborts the
      // in-flight `runStreamed` via the SDK's TurnOptions.signal.
      currentAdapter?.interrupt().catch((err: unknown) => {
        console.error(
          `[session-runner] interrupt error: ${err instanceof Error ? err.message : String(err)}`,
        )
      })
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
        { state: 'failed', exit_code: 2, error: 'runner_session_id already active' },
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

  // Build the per-session context. `userQueue` / `query` are filled by the
  // runner at session start (userQueue is constructed before query() is
  // invoked, so it's available to `stream-input` from the very first
  // command after session.init).
  const ctx: RunnerSessionContext = {
    sessionId: argv.sessionId,
    abortController: new AbortController(),
    interrupted: false,
    pendingAnswer: null,
    pendingPermission: null,
    userQueue: null,
    query: null,
    titler: null,
    nextSeq: 0,
    meta: {
      runner_session_id: null,
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

  // --- Step 10: SIGTERM handler ---
  let forcedExit = false
  const sigtermHandler = () => {
    console.warn('[session-runner] SIGTERM received — aborting')
    ctx.abortController.abort()
    setTimeout(async () => {
      if (forcedExit) return
      forcedExit = true
      clearInterval(metaTimer)
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
  // GH#107 / spec 107 P1.1: select the runner adapter via the registry.
  // Unknown agent → emit error event + write failed exit-file + exit(1)
  // before any SDK is touched.
  let runner: RunnerAdapter
  try {
    runner = createAdapter(cmd.agent)
  } catch (err) {
    const errMsg = (err as Error).message
    channel.send({
      type: 'error',
      session_id: argv.sessionId,
      error: errMsg,
      seq: ++ctx.nextSeq,
    })
    try {
      await dialBackClient.stop()
    } catch {
      /* best-effort */
    }
    clearInterval(metaTimer)
    return writeExitAndExit(argv.exitFile, { state: 'failed', exit_code: 1, error: errMsg }, 1)
  }

  currentAdapter = runner
  let caughtError: Error | null = null
  try {
    // P1.1 legacy bridge: ClaudeAdapter still drives `ClaudeRunner` via
    // `runLegacy(channel, cmd, ctx)`. CodexAdapter (P3) uses the
    // standard `run(opts)` path with channel-mediated event routing —
    // every event funnels through `channel.send` so BufferedChannel
    // stamps `seq` automatically (same monotonic stream Claude uses).
    if (runner instanceof ClaudeAdapter) {
      if (cmd.type === 'execute') {
        await runner.runLegacy(channel, cmd as ExecuteCommand, ctx)
      } else {
        await runner.runLegacy(channel, cmd as ResumeCommand, ctx)
      }
    } else if (runner.name === 'codex') {
      const execCmd = cmd as ExecuteCommand | ResumeCommand
      await runner.run({
        sessionId: argv.sessionId,
        project: execCmd.project,
        model: execCmd.type === 'execute' ? execCmd.model : undefined,
        prompt: execCmd.prompt,
        resumeSessionId: execCmd.type === 'resume' ? execCmd.runner_session_id : undefined,
        env: process.env as unknown as Readonly<Record<string, string>>,
        signal: ctx.abortController.signal,
        codexModels: execCmd.codex_models,
        onEvent: (event) => {
          // BufferedChannel.send requires `seq` on every event — stamp
          // monotonic seq from the same `ctx.nextSeq` counter Claude
          // uses so codex sessions live on the same gap-detection rail.
          channel.send({ ...(event as object), seq: ++ctx.nextSeq })
          // Track meta-file invariants: last activity + seq + state.
          ctx.meta.last_activity_ts = Date.now()
          ctx.meta.last_event_seq = ctx.nextSeq
          if ((event as { type?: string }).type === 'session.init') {
            const ev = event as { runner_session_id?: string | null; model?: string | null }
            ctx.meta.runner_session_id = ev.runner_session_id ?? null
            if (ev.model) ctx.meta.model = ev.model
          } else if ((event as { type?: string }).type === 'result') {
            ctx.meta.turn_count++
          }
        },
      })
      ctx.meta.state = ctx.interrupted ? 'aborted' : 'completed'
    } else {
      throw new Error(`adapter '${runner.name}' has no main.ts dispatch path yet`)
    }
  } catch (err) {
    caughtError = err instanceof Error ? err : new Error(String(err))
  } finally {
    try {
      await runner.dispose()
    } catch {
      /* best-effort — dispose must not throw */
    }
    currentAdapter = null
  }

  // --- Step 9: clean shutdown ---
  if (forcedExit) return // SIGTERM watchdog already handled the exit
  clearInterval(metaTimer)
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
