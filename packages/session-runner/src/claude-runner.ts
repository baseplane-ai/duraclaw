import { type FSWatcher, watch } from 'node:fs'
import fs from 'node:fs/promises'
import nodePath from 'node:path'
import type { BufferedChannel } from '@duraclaw/shared-transport'
import type {
  ExecuteCommand,
  GatewayEvent,
  KataSessionState,
  ResumeCommand,
} from '@duraclaw/shared-types'
import { buildCleanEnv } from './env.js'
import { resolveProject } from './project-resolver.js'
import { PushPullQueue } from './push-pull-queue.js'
import { SessionTitler, type TranscriptMessage } from './titler.js'
import type { RunnerSessionContext, SDKUserMsg } from './types.js'

/** Debounce interval for kata state file changes (ms). Matches gateway. */
const KATA_DEBOUNCE_MS = 150

/**
 * Read the kata session state for a specific SDK session id.
 *
 * GH#73: replaces the previous "scan all sessions by mtime" algorithm. When
 * multiple SDK sessions share a worktree (e.g. two chain rungs running in
 * parallel), the newest-mtime heuristic propagated the wrong session's state
 * to D1 — every chain card would flip between its two peers' modes. The
 * runner already knows its own SDK session id via `ctx.meta.sdk_session_id`
 * (set from `session.init`), and kata names its session folders by that id,
 * so a direct read is both correct and cheaper.
 *
 * Also checks for `.kata/sessions/<sdkSessionId>/run-end.json` — kata's Stop
 * hook writes it whenever `can-exit` succeeds (no-op modes or all stop
 * conditions met) and skips it on block / background-agents-running. The
 * `runEnded` flag is surfaced on the event so the DO can gate chain
 * auto-advance on an authoritative signal instead of fragile spec/VP
 * filesystem probes through the gateway.
 *
 * Returns `null` when the session folder has no state.json yet (very early
 * in the session lifecycle, before kata's SessionStart hook lands).
 */
async function readSessionKataState(
  projectPath: string,
  sdkSessionId: string,
): Promise<KataSessionState | null> {
  const sessionDir = nodePath.join(projectPath, '.kata', 'sessions', sdkSessionId)
  let raw: string
  try {
    raw = await fs.readFile(nodePath.join(sessionDir, 'state.json'), 'utf-8')
  } catch {
    // No state.json yet — kata hasn't initialised this session.
    return null
  }

  let parsed: KataSessionState
  try {
    parsed = JSON.parse(raw) as KataSessionState
  } catch {
    return null
  }

  // Existence-only probe for run-end.json. Written by kata's Stop hook on
  // successful can-exit; absence means either (a) kata hasn't finished the
  // current rung yet, or (b) can-exit blocked. Either way, chain advance
  // should wait.
  let runEnded = false
  try {
    await fs.stat(nodePath.join(sessionDir, 'run-end.json'))
    runEnded = true
  } catch {
    /* absent — runEnded stays false */
  }

  return { ...parsed, runEnded }
}

/**
 * Watch `.kata/sessions/<sdk-session-id>/` for state.json / run-end.json
 * changes and emit KataStateEvent over the runner's dial-back channel.
 *
 * GH#73: read is targeted at `ctx.meta.sdk_session_id` rather than scanning
 * all sessions by mtime. `sdk_session_id` isn't set until the SDK emits
 * `session.init`, so `emitState()` is a no-op until then; the caller pokes
 * this watcher (via `emitKataStateNow`) from the init handler so the DO
 * sees the first snapshot as soon as it's resolvable.
 *
 * Returns `{ stop, emitNow }` — `emitNow()` is used by the session.init
 * handler to force a snapshot as soon as `sdk_session_id` is known, without
 * waiting for the next filesystem event.
 *
 * Errors are swallowed — kata state is best-effort.
 */
function startKataWatcher(
  projectPath: string,
  project: string,
  ch: BufferedChannel,
  ctx: RunnerSessionContext,
): { stop: () => void; emitNow: () => void } {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let watcher: FSWatcher | null = null

  const emitState = async () => {
    const sdkSessionId = ctx.meta.sdk_session_id
    // Pre-init: we don't know which kata session folder to read yet. Skip —
    // emitNow() from the session.init handler will fire as soon as the id
    // arrives.
    if (!sdkSessionId) return
    try {
      const state = await readSessionKataState(projectPath, sdkSessionId)
      send(ch, { type: 'kata_state', session_id: ctx.sessionId, project, kata_state: state }, ctx)
    } catch {
      /* best-effort */
    }
  }

  const sessionsDir = nodePath.join(projectPath, '.kata', 'sessions')
  try {
    watcher = watch(sessionsDir, { recursive: true }, (_event, filename) => {
      // Only react to files the runner cares about. `state.json` is the
      // live mode/phase snapshot; `run-end.json` is the GH#73 can-exit
      // evidence file written by kata's Stop hook.
      if (!filename?.endsWith('state.json') && !filename?.endsWith('run-end.json')) return
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        emitState()
      }, KATA_DEBOUNCE_MS)
    })
  } catch {
    // .kata/sessions/ may not exist yet — that's fine.
  }

  return {
    stop: () => {
      if (debounceTimer) clearTimeout(debounceTimer)
      if (watcher) {
        watcher.close()
        watcher = null
      }
    },
    emitNow: () => {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = null
      void emitState()
    },
  }
}

/**
 * Detect SDK "idle stop" — the model emitted "No response requested." and hit
 * the interactive stop sequence.  In headless/orchestrated mode this is a false
 * stop; we should auto-resume instead of surfacing it to the user.
 */
export function isIdleStop(result: Record<string, unknown>): boolean {
  if (result.subtype !== 'success') return false
  const text = typeof result.result === 'string' ? result.result.trim() : ''
  return /^no response requested\.?$/i.test(text)
}

/**
 * Send a GatewayEvent to the buffered channel.
 * Stamps the next monotonic seq from `ctx.nextSeq` and updates live meta
 * (`last_activity_ts`, `last_event_seq`) so the 10s meta-dumper sees it.
 */
function send(ch: BufferedChannel, event: GatewayEvent, ctx: RunnerSessionContext): void {
  const seq = ++ctx.nextSeq
  ch.send({ ...(event as unknown as Record<string, unknown>), seq })
  ctx.meta.last_activity_ts = Date.now()
  ctx.meta.last_event_seq = seq
}

/**
 * Handle SDK canUseTool callback — intercepts AskUserQuestion and permission prompts.
 * Extracted for testability.
 */
export async function handleCanUseTool(
  toolName: string,
  input: Record<string, unknown>,
  opts: { signal: AbortSignal; toolUseID: string },
  ctx: RunnerSessionContext,
  sendEvent: (event: Record<string, unknown>) => void,
  sessionId: string,
): Promise<
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string }
> {
  const { toolUseID: id, signal } = opts

  if (toolName === 'AskUserQuestion') {
    const askedAt = Date.now()
    const rawQuestions = Array.isArray((input as any).questions) ? (input as any).questions : []
    const qSummary = rawQuestions.map((q: Record<string, unknown>, idx: number) => ({
      idx,
      header: typeof q?.header === 'string' ? q.header.slice(0, 80) : null,
      questionLen: typeof q?.question === 'string' ? q.question.length : null,
      optionsCount: Array.isArray(q?.options) ? (q.options as unknown[]).length : null,
      multiSelect: typeof q?.multiSelect === 'boolean' ? q.multiSelect : null,
    }))
    console.log(
      `[gate] canUseTool AskUserQuestion entered toolUseID=${id} questions_count=${rawQuestions.length} q_summary=${JSON.stringify(qSummary)}`,
    )

    // Send ask_user event to orchestrator
    sendEvent({
      type: 'ask_user',
      session_id: sessionId,
      tool_call_id: id,
      questions: rawQuestions,
    })

    // No timeout — the agent waits indefinitely for the user to answer.
    // The user can still abort the session, which fires `signal` and rejects.
    try {
      const answers = await new Promise<Record<string, string>>((resolve, reject) => {
        ctx.pendingAnswer = { resolve, reject }

        signal.addEventListener(
          'abort',
          () => {
            ctx.pendingAnswer = null
            reject(new Error('Session aborted'))
          },
          { once: true },
        )
      })

      const answerKeys = Object.keys(answers ?? {})
      const totalAnswerLen = answerKeys.reduce((acc, k) => acc + (answers[k]?.length ?? 0), 0)
      console.log(
        `[gate] canUseTool AskUserQuestion resolved toolUseID=${id} answers_keys_count=${answerKeys.length} answer_total_chars=${totalAnswerLen} duration_ms=${Date.now() - askedAt} keys=${JSON.stringify(answerKeys.map((k) => k.slice(0, 60)))}`,
      )

      return { behavior: 'allow', updatedInput: { ...input, answers } }
    } catch (err) {
      console.warn(
        `[gate] canUseTool AskUserQuestion rejected toolUseID=${id} duration_ms=${Date.now() - askedAt} reason=${err instanceof Error ? err.message : String(err)}`,
      )
      throw err
    }
  }

  // Permission prompt for all other tools
  sendEvent({
    type: 'permission_request',
    session_id: sessionId,
    tool_call_id: id,
    tool_name: toolName,
    input,
  })

  // No timeout — the agent waits indefinitely for the user to decide.
  // The user can still abort the session, which fires `signal` and rejects.
  const allowed = await new Promise<boolean>((resolve, reject) => {
    ctx.pendingPermission = { resolve, reject }

    signal.addEventListener(
      'abort',
      () => {
        ctx.pendingPermission = null
        reject(new Error('Session aborted'))
      },
      { once: true },
    )
  })

  // Note: the SDK's runtime Zod validator requires `updatedInput` on every
  // 'allow' result (the `.d.ts` marks it optional but the schema doesn't).
  // Returning `{ behavior: 'allow' }` without it triggers a ZodError that
  // surfaces as a hard failure on any user-approved permission prompt —
  // most visibly when editing paths under `.claude/` since those always
  // gate. Pass the original, unmodified input through.
  return allowed
    ? { behavior: 'allow', updatedInput: input }
    : { behavior: 'deny', message: 'Denied by user' }
}

export class ClaudeRunner {
  readonly name = 'claude'

  async execute(
    ch: BufferedChannel,
    cmd: ExecuteCommand,
    ctx: RunnerSessionContext,
  ): Promise<void> {
    return this.runSession(ch, cmd, ctx)
  }

  async resume(ch: BufferedChannel, cmd: ResumeCommand, ctx: RunnerSessionContext): Promise<void> {
    return this.runSession(ch, cmd, ctx)
  }

  abort(ctx: RunnerSessionContext): void {
    ctx.abortController.abort()
  }

  /**
   * Run a session: execute the Claude SDK query() and stream GatewayEvent messages
   * back over the WebSocket connection. Works for both "execute" and "resume" commands.
   */
  private async runSession(
    ch: BufferedChannel,
    cmd: ExecuteCommand | ResumeCommand,
    ctx: RunnerSessionContext,
  ): Promise<void> {
    const { sessionId, abortController: ac } = ctx
    const startTime = Date.now()
    console.log(`[session-runner] executeSession: resolving project=${cmd.project}`)

    // Resolve project path
    const resolvedPath = await resolveProject(cmd.project)
    console.log(`[session-runner] executeSession: projectPath=${resolvedPath}`)
    if (!resolvedPath) {
      // GH#8: verbose miss log — project-resolver returns null for both
      // "directory absent" and "prefix filter rejected", and the two are
      // indistinguishable in the current error event. Dump the visible
      // project list + active prefix filter so operators can tell which
      // one fired without re-running with a debugger.
      const projectsDir = '/data/projects'
      const rawPatterns = process.env.PROJECT_PATTERNS ?? process.env.WORKTREE_PATTERNS ?? '(unset)'
      let visible = '(unreadable)'
      try {
        const entries = await (await import('node:fs/promises')).readdir(projectsDir)
        visible = entries.join(',')
      } catch {
        /* best-effort */
      }
      console.error(
        `[session-runner] project miss: name="${cmd.project}" patterns="${rawPatterns}" projects_dir="${projectsDir}" visible=[${visible}] — either the directory is missing or PROJECT_PATTERNS / WORKTREE_PATTERNS is filtering it out`,
      )
      send(
        ch,
        {
          type: 'error',
          session_id: sessionId,
          error: `Project "${cmd.project}" not found (patterns="${rawPatterns}")`,
        },
        ctx,
      )
      ctx.meta.state = 'failed'
      return
    }
    const projectPath: string = resolvedPath

    // Lifetime queue: a single PushPullQueue feeds the one-and-only Query()
    // for this runner process. Initial user turn is pushed below; subsequent
    // stream-input commands push onto the same queue (see main.ts).
    const userQueue = new PushPullQueue<SDKUserMsg>()
    ctx.userQueue = userQueue

    let sdkSessionId: string | null = null
    const kataWatcher = startKataWatcher(projectPath, cmd.project, ch, ctx)

    try {
      // Dynamic import -- the SDK is ESM-only
      const { query } = await import('@anthropic-ai/claude-agent-sdk')

      const options: Record<string, unknown> = {
        abortController: ac,
        cwd: projectPath,
        env: buildCleanEnv(),
        permissionMode: 'default',
        includePartialMessages: true,
        settingSources: ['user', 'project', 'local'],
        enableFileCheckpointing: true,
      }

      if (cmd.type === 'execute') {
        if (cmd.model) options.model = cmd.model
        if (cmd.system_prompt) options.systemPrompt = cmd.system_prompt
        if (cmd.allowed_tools) options.allowedTools = cmd.allowed_tools
        if (cmd.max_turns) options.maxTurns = cmd.max_turns
        if (cmd.max_budget_usd) options.maxBudgetUsd = cmd.max_budget_usd
        if (cmd.thinking) options.thinking = cmd.thinking
        if (cmd.effort) options.effort = cmd.effort
      } else {
        // resume
        options.resume = cmd.sdk_session_id
      }

      // GH#86: instantiate the Haiku session titler. Runs fire-and-forget
      // calls to Haiku after turn-complete and on pivot detection. Lives
      // on ctx so handleIncomingCommand in main.ts can trigger pivot checks.
      const titler = new SessionTitler({
        channel: ch,
        ctx,
        sendFn: (channel, event, context) =>
          send(channel, event as unknown as GatewayEvent, context),
        enabled: !!cmd.titler_enabled,
      })
      ctx.titler = titler

      // Accumulates user/assistant text for the titler's transcript. The
      // titler needs a rolling window of recent messages — we collect them
      // here because the SDK query() stream provides each message inline.
      const titlerHistory: TranscriptMessage[] = []

      // canUseTool callback: intercepts AskUserQuestion and permission prompts
      options.canUseTool = async (
        toolName: string,
        input: Record<string, unknown>,
        opts: { signal: AbortSignal; toolUseID: string },
      ) => {
        return handleCanUseTool(
          toolName,
          input,
          opts,
          ctx,
          (event) => send(ch, event as unknown as GatewayEvent, ctx),
          sessionId,
        )
      }

      // PostToolUse hooks for file-change tracking (unchanged)
      options.hooks = {
        PostToolUse: [
          {
            hooks: [
              async (
                input: any,
                _toolUseId: string | undefined,
                _opts: { signal: AbortSignal },
              ) => {
                const toolName: string = input.tool_name
                const toolInput: Record<string, unknown> = input.tool_input ?? {}

                if (toolName === 'Edit' || toolName === 'Write') {
                  const filePath = toolInput.file_path as string | undefined
                  if (filePath) {
                    send(
                      ch,
                      {
                        type: 'file_changed',
                        session_id: sessionId,
                        path: filePath,
                        tool: toolName,
                        timestamp: new Date().toISOString(),
                      },
                      ctx,
                    )
                  }
                }

                return { continue: true }
              },
            ],
          },
        ],
      }

      // --- Initial user turn: push onto the lifetime queue ---
      // GH#86: capture initial prompt for titler transcript.
      const promptText = typeof cmd.prompt === 'string' ? cmd.prompt : JSON.stringify(cmd.prompt)
      titlerHistory.push({ role: 'user', content: promptText })
      userQueue.push({
        type: 'user',
        message: { role: 'user', content: cmd.prompt },
        parent_tool_use_id: null,
      })

      // --- One Query for the runner's lifetime ---
      // Both `execute` and `resume` converge here; only options differ.
      console.log(`[session-runner] executeSession: calling query() for ${cmd.project}`)
      const q = query({
        prompt: userQueue as AsyncIterable<SDKUserMsg>,
        options: options as any,
      })
      ctx.query = q

      // Single message loop for the session lifetime. interrupt() does NOT
      // close the queue; the SDK yields a result sentinel and the loop keeps
      // pulling. The loop exits when (a) abortController fires, (b)
      // userQueue.close() is called by `stop` and the SDK reaches end-of-
      // stream, or (c) the SDK throws / ends naturally.
      for await (const message of q) {
        console.log(`[session-runner] executeSession: message type=${message.type}`)
        if (ac.signal.aborted) break

        if (message.type === 'system' && (message as any).subtype === 'init') {
          sdkSessionId = (message as any).session_id ?? null
          const model = (message as any).model ?? null
          const tools = (message as any).tools ?? []

          ctx.meta.sdk_session_id = sdkSessionId
          ctx.meta.model = model

          send(
            ch,
            {
              type: 'session.init',
              session_id: sessionId,
              sdk_session_id: sdkSessionId ?? null,
              project: cmd.project,
              model,
              tools,
            },
            ctx,
          )

          // GH#73: with the kata session id now known, push an initial
          // kata_state snapshot so the DO syncs the mode/issue + runEnded
          // fields for this session immediately. Prior to session.init the
          // watcher can't pick the right folder, so this is the first
          // viable emission point.
          if (sdkSessionId) kataWatcher.emitNow()
        } else if (
          message.type === 'system' &&
          (message as any).subtype === 'session_state_changed'
        ) {
          // GH#102 / spec 102-sdk-peelback B1: SDK-native liveness signal.
          // Translates the SDK's 3-value enum directly. SDK type
          // SDKSessionStateChangedMessage — see addendum §1.1.
          send(
            ch,
            {
              type: 'session_state_changed',
              session_id: sessionId,
              state: (message as any).state,
              ts: Date.now(),
            },
            ctx,
          )
        } else if (message.type === 'system' && (message as any).subtype === 'status') {
          // GH#102 / spec 102-sdk-peelback B1: synthesise `compacting` from
          // SDKStatusMessage. `status:'compacting'` → state:'compacting'.
          // `status:null` → no-op (the next session_state_changed will
          // reassert authority). See addendum §1.2.
          if ((message as any).status === 'compacting') {
            send(
              ch,
              {
                type: 'session_state_changed',
                session_id: sessionId,
                state: 'compacting',
                ts: Date.now(),
              },
              ctx,
            )
          }
        } else if (message.type === 'system' && (message as any).subtype === 'api_retry') {
          // GH#102 / spec 102-sdk-peelback B1: synthesise `api_retry` from
          // SDKAPIRetryMessage for the liveness signal. The dedicated
          // `api_retry` GatewayEvent (spec phase p4 / B12) will be added
          // alongside this in P1.5; here we emit the liveness frame only.
          send(
            ch,
            {
              type: 'session_state_changed',
              session_id: sessionId,
              state: 'api_retry',
              ts: Date.now(),
            },
            ctx,
          )
        } else if (message.type === 'stream_event') {
          // Token-level partial from the SDK. SDKPartialAssistantMessage wraps
          // a BetaRawMessageStreamEvent. We forward both text_delta and
          // thinking_delta so extended-thinking traces stream incrementally
          // alongside the assistant text. input_json_delta (tool_use input)
          // is skipped — it can't render incrementally against the existing
          // parts model and arrives fully resolved in the final `assistant`.
          const ev = (message as any).event
          if (ev?.type === 'content_block_delta' && ev.delta) {
            const idx = typeof ev.index === 'number' ? ev.index : 0
            if (ev.delta.type === 'text_delta') {
              send(
                ch,
                {
                  type: 'partial_assistant',
                  session_id: sessionId,
                  content: [{ type: 'text', id: `blk-${idx}`, delta: ev.delta.text ?? '' }],
                },
                ctx,
              )
            } else if (ev.delta.type === 'thinking_delta') {
              send(
                ch,
                {
                  type: 'partial_assistant',
                  session_id: sessionId,
                  content: [{ type: 'thinking', id: `blk-${idx}`, delta: ev.delta.thinking ?? '' }],
                },
                ctx,
              )
            }
          }
        } else if (message.type === 'assistant' && (message as any).partial) {
          // Legacy path: older SDK versions emitted `assistant` with partial=true.
          // Kept for safety; current SDK (0.2.98+) uses `stream_event` above.
          const content = (message as any).message?.content ?? []
          const blocks = content.map((block: any) => {
            if (block.type === 'text') {
              return { type: 'text', id: block.id ?? '', delta: block.text ?? '' }
            }
            if (block.type === 'tool_use') {
              return {
                type: 'tool_use',
                id: block.id ?? '',
                tool_name: block.name,
                input_delta:
                  typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? ''),
              }
            }
            return { type: block.type, id: block.id ?? '' }
          })

          send(
            ch,
            {
              type: 'partial_assistant',
              session_id: sessionId,
              content: blocks,
            },
            ctx,
          )
        } else if (message.type === 'assistant') {
          // GH#86: accumulate finalized assistant turns for the titler.
          const assistantContent = (message as any).message?.content ?? []
          titlerHistory.push({ role: 'assistant', content: assistantContent })

          send(
            ch,
            {
              type: 'assistant',
              session_id: sessionId,
              uuid: (message as any).uuid,
              content: assistantContent,
            },
            ctx,
          )
        } else if (message.type === 'tool_use_summary') {
          send(
            ch,
            {
              type: 'tool_result',
              session_id: sessionId,
              uuid: (message as any).uuid ?? '',
              content: (message as any).content ?? (message as any).results ?? [],
            },
            ctx,
          )
        } else if (message.type === 'rate_limit_event') {
          send(
            ch,
            {
              type: 'rate_limit',
              session_id: sessionId,
              rate_limit_info: (message as any).rate_limit_info,
            },
            ctx,
          )
        } else if (message.type === 'system' && (message as any).subtype === 'task_started') {
          send(
            ch,
            {
              type: 'task_started',
              session_id: sessionId,
              task_id: (message as any).task_id,
              description: (message as any).description ?? '',
              task_type: (message as any).task_type,
              prompt: (message as any).prompt,
            },
            ctx,
          )
        } else if (message.type === 'system' && (message as any).subtype === 'task_progress') {
          send(
            ch,
            {
              type: 'task_progress',
              session_id: sessionId,
              task_id: (message as any).task_id,
              description: (message as any).description ?? '',
              usage: (message as any).usage ?? { total_tokens: 0, tool_uses: 0, duration_ms: 0 },
              last_tool_name: (message as any).last_tool_name,
              summary: (message as any).summary,
            },
            ctx,
          )
        } else if (message.type === 'system' && (message as any).subtype === 'task_notification') {
          send(
            ch,
            {
              type: 'task_notification',
              session_id: sessionId,
              task_id: (message as any).task_id,
              status: (message as any).status,
              summary: (message as any).summary ?? '',
              output_file: (message as any).output_file ?? '',
              usage: (message as any).usage,
            },
            ctx,
          )
        } else if (message.type === 'result') {
          const result = message as any
          const wasInterrupted = ctx.interrupted

          // Idle stop — the model hit the interactive stop sequence with
          // "No response requested." Normally suppress the result and
          // auto-nudge by pushing "continue" onto the lifetime queue.
          // BUT if the user interrupted, forward the result so the DO
          // transitions to idle (otherwise it stays stuck in 'running'
          // with no runner).
          if (isIdleStop(result) && !wasInterrupted) {
            console.log(`[session-runner] executeSession: idle stop detected — auto-nudging`)
            ctx.meta.turn_count++
            userQueue.push({
              type: 'user',
              message: { role: 'user', content: 'continue' },
              parent_tool_use_id: null,
            })
            continue
          }

          const duration = Date.now() - startTime

          // Fetch SDK session summary (best-effort)
          let sdkSummary: string | null = null
          if (sdkSessionId) {
            try {
              const { getSessionInfo } = await import('@anthropic-ai/claude-agent-sdk')
              const info = await getSessionInfo(sdkSessionId, { dir: projectPath })
              sdkSummary = info?.summary ?? null
            } catch {
              // Non-fatal -- summary is best-effort
            }
          }

          if (typeof result.total_cost_usd === 'number') {
            ctx.meta.cost.usd = result.total_cost_usd
          }

          send(
            ch,
            {
              type: 'result',
              session_id: sessionId,
              subtype: result.subtype,
              duration_ms: duration,
              total_cost_usd: result.total_cost_usd ?? null,
              result: result.result ?? null,
              num_turns: result.num_turns ?? null,
              is_error: result.subtype !== 'success',
              sdk_summary: sdkSummary,
            },
            ctx,
          )

          // Reset interrupt flag and bump turn counter once the result has
          // been forwarded. The for-await loop continues — the next push
          // on userQueue will start the next turn under the same Query.
          if (wasInterrupted) ctx.interrupted = false
          ctx.meta.turn_count++

          // GH#86: fire-and-forget initial title check after turn-complete.
          // Errors are swallowed inside the titler — no risk of breaking
          // the main event loop.
          titler.maybeInitialTitle(titlerHistory).catch(() => {})
        }
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)

      // Don't send error for aborted/interrupted sessions — both are
      // user-initiated stops that should land the DO in 'idle' (not 'error')
      // via the gateway-close recovery path.
      const isIntentionalStop = ac.signal.aborted || ctx.interrupted
      if (!isIntentionalStop) {
        send(ch, { type: 'error', session_id: sessionId, error: errMsg }, ctx)
      }
      // Terminal state precedence: abort/interrupt wins over failure (SIGTERM
      // or user Stop while erroring should still surface as "aborted").
      if (isIntentionalStop) {
        ctx.meta.state = 'aborted'
      } else {
        ctx.meta.state = 'failed'
      }
    } finally {
      kataWatcher.stop()
      // Close the lifetime queue and clear ctx pointers. close() is
      // idempotent and safe even if `stop` already closed it from main.ts.
      userQueue.close()
      ctx.userQueue = null
      ctx.query = null
      // If we reached here without hitting the catch and no terminal state was
      // set yet, this was a natural completion (result event received, loop exited).
      if (ctx.meta.state === 'running') {
        ctx.meta.state = ac.signal.aborted || ctx.interrupted ? 'aborted' : 'completed'
      }
    }
  }
}
