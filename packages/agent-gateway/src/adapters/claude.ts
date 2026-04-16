import type {
  ContentBlock,
  ExecuteCommand,
  GatewayEvent,
  ResumeCommand,
} from '@duraclaw/shared-types'
import { handleQueryCommand } from '../commands.js'
import { buildCleanEnv } from '../env.js'
import { resolveProject } from '../projects.js'
import type { SessionChannel } from '../session-channel.js'
import type { GatewaySessionContext } from '../types.js'
import type { AdapterCapabilities, AgentAdapter } from './types.js'

/** How often to send a heartbeat on the WS to prevent idle timeout (ms). */
const HEARTBEAT_INTERVAL_MS = 15_000

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

/** Send a GatewayEvent to the channel. */
function send(ch: SessionChannel, event: GatewayEvent): void {
  try {
    ch.send(JSON.stringify(event))
  } catch {
    // Channel already closed -- swallow
  }
}

/**
 * Start a heartbeat that sends periodic pings on the WS.
 * This keeps the connection alive while the SDK is blocked executing tools
 * (the for-await loop pauses, so no messages flow during tool execution).
 * Returns a stop function.
 */
function startHeartbeat(ch: SessionChannel, sessionId: string): () => void {
  const timer = setInterval(() => {
    try {
      ch.send(JSON.stringify({ type: 'heartbeat', session_id: sessionId }))
    } catch {
      // Channel closed
    }
  }, HEARTBEAT_INTERVAL_MS)
  return () => clearInterval(timer)
}

/** Shape expected by the Claude Agent SDK for streaming user messages. */
interface SDKUserMsg {
  type: 'user'
  message: { role: 'user'; content: string | ContentBlock[] }
  parent_tool_use_id: string | null
}

/**
 * Create an async iterable queue for streaming user messages into a running session.
 * The queue yields messages as they are pushed, and stops when done() is called.
 */
function createMessageQueue() {
  const pending: Array<{ role: 'user'; content: string | ContentBlock[] }> = []
  let resolve: (() => void) | null = null
  let waitResolve: (() => void) | null = null
  let finished = false

  const iterable: AsyncIterable<SDKUserMsg> = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          while (true) {
            if (pending.length > 0) {
              const msg = pending.shift() as { role: 'user'; content: string | ContentBlock[] }
              const sdkMsg: SDKUserMsg = {
                type: 'user',
                message: { role: 'user', content: msg.content },
                parent_tool_use_id: null,
              }
              return { value: sdkMsg, done: false }
            }
            if (finished) {
              return { value: undefined, done: true as const }
            }
            await new Promise<void>((r) => {
              resolve = r
            })
            resolve = null
          }
        },
      }
    },
  }

  return {
    iterable,
    push(msg: { role: 'user'; content: string | ContentBlock[] }) {
      pending.push(msg)
      resolve?.()
      waitResolve?.()
    },
    /** Block until the next message is pushed, returning it as an SDKUserMsg. Returns null if done(). */
    async waitForNext(): Promise<SDKUserMsg | null> {
      while (true) {
        if (pending.length > 0) {
          const msg = pending.shift() as { role: 'user'; content: string | ContentBlock[] }
          return {
            type: 'user',
            message: { role: 'user', content: msg.content },
            parent_tool_use_id: null,
          }
        }
        if (finished) return null
        await new Promise<void>((r) => {
          waitResolve = r
        })
        waitResolve = null
      }
    },
    done() {
      finished = true
      resolve?.()
      waitResolve?.()
    },
  }
}

/**
 * Handle SDK canUseTool callback — intercepts AskUserQuestion and permission prompts.
 * Extracted for testability.
 */
export async function handleCanUseTool(
  toolName: string,
  input: Record<string, unknown>,
  opts: { signal: AbortSignal; toolUseID: string },
  ctx: GatewaySessionContext,
  sendEvent: (event: Record<string, unknown>) => void,
  sessionId: string,
): Promise<
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string }
> {
  const { toolUseID: id, signal } = opts

  if (toolName === 'AskUserQuestion') {
    // Send ask_user event to orchestrator
    sendEvent({
      type: 'ask_user',
      session_id: sessionId,
      tool_call_id: id,
      questions: (input as any).questions ?? [],
    })

    // No timeout — the agent waits indefinitely for the user to answer.
    // The user can still abort the session, which fires `signal` and rejects.
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

    return { behavior: 'allow', updatedInput: { ...input, answers } }
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

export class ClaudeAdapter implements AgentAdapter {
  readonly name = 'claude'

  async execute(
    ch: SessionChannel,
    cmd: ExecuteCommand,
    ctx: GatewaySessionContext,
  ): Promise<void> {
    return this.runSession(ch, cmd, ctx)
  }

  async resume(ch: SessionChannel, cmd: ResumeCommand, ctx: GatewaySessionContext): Promise<void> {
    return this.runSession(ch, cmd, ctx)
  }

  abort(ctx: GatewaySessionContext): void {
    ctx.abortController.abort()
  }

  async getCapabilities(): Promise<AdapterCapabilities> {
    let available = false
    try {
      await import('@anthropic-ai/claude-agent-sdk')
      available = true
    } catch {
      // SDK not importable
    }

    return {
      agent: 'claude',
      available,
      supportedCommands: ['execute', 'resume', 'abort', 'stop', 'interrupt', 'set-model', 'rewind'],
      description: 'Claude Code via Agent SDK',
    }
  }

  /**
   * Run a session: execute the Claude SDK query() and stream GatewayEvent messages
   * back over the WebSocket connection. Works for both "execute" and "resume" commands.
   */
  private async runSession(
    ch: SessionChannel,
    cmd: ExecuteCommand | ResumeCommand,
    ctx: GatewaySessionContext,
  ): Promise<void> {
    const { sessionId, abortController: ac } = ctx
    const startTime = Date.now()
    console.log(`[agent-gateway] executeSession: resolving project=${cmd.project}`)

    // Resolve project path
    const resolvedPath = await resolveProject(cmd.project)
    console.log(`[agent-gateway] executeSession: projectPath=${resolvedPath}`)
    if (!resolvedPath) {
      send(ch, {
        type: 'error',
        session_id: sessionId,
        error: `Project "${cmd.project}" not found`,
      })
      return
    }
    const projectPath: string = resolvedPath

    // Set up message queue for streaming input
    const queue = createMessageQueue()
    ctx.messageQueue = queue

    let sdkSessionId: string | null = null
    const stopHeartbeat = startHeartbeat(ch, sessionId)

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
          (event) => send(ch, event as unknown as GatewayEvent),
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
                    send(ch, {
                      type: 'file_changed',
                      session_id: sessionId,
                      path: filePath,
                      tool: toolName,
                      timestamp: new Date().toISOString(),
                    })
                  }
                }

                return { continue: true }
              },
            ],
          },
        ],
      }

      /** Process all messages from a single SDK query() call. */
      async function processQueryMessages(iter: any) {
        ctx.query = iter

        for await (const message of iter) {
          console.log(`[agent-gateway] executeSession: message type=${message.type}`)
          if (ac.signal.aborted) break

          if (message.type === 'system' && (message as any).subtype === 'init') {
            sdkSessionId = (message as any).session_id ?? null
            const model = (message as any).model ?? null
            const tools = (message as any).tools ?? []

            send(ch, {
              type: 'session.init',
              session_id: sessionId,
              sdk_session_id: sdkSessionId ?? null,
              project: cmd.project,
              model,
              tools,
            })

            // Drain command queue now that Query is available
            if (ctx.commandQueue.length > 0) {
              for (const queuedCmd of ctx.commandQueue) {
                await handleQueryCommand(ctx, queuedCmd, ch)
              }
              ctx.commandQueue = []
            }
          } else if (message.type === 'assistant' && (message as any).partial) {
            // Partial assistant message -- emit incremental content
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
                    typeof block.input === 'string'
                      ? block.input
                      : JSON.stringify(block.input ?? ''),
                }
              }
              return { type: block.type, id: block.id ?? '' }
            })

            send(ch, {
              type: 'partial_assistant',
              session_id: sessionId,
              content: blocks,
            })
          } else if (message.type === 'assistant') {
            send(ch, {
              type: 'assistant',
              session_id: sessionId,
              uuid: (message as any).uuid,
              content: (message as any).message?.content ?? [],
            })
          } else if (message.type === 'tool_use_summary') {
            send(ch, {
              type: 'tool_result',
              session_id: sessionId,
              uuid: (message as any).uuid ?? '',
              content: (message as any).content ?? (message as any).results ?? [],
            })
          } else if (
            message.type === 'system' &&
            (message as any).subtype === 'session_state_changed'
          ) {
            send(ch, {
              type: 'session_state_changed',
              session_id: sessionId,
              state: (message as any).state,
            })
          } else if (message.type === 'rate_limit_event') {
            send(ch, {
              type: 'rate_limit',
              session_id: sessionId,
              rate_limit_info: (message as any).rate_limit_info,
            })
          } else if (message.type === 'system' && (message as any).subtype === 'task_started') {
            send(ch, {
              type: 'task_started',
              session_id: sessionId,
              task_id: (message as any).task_id,
              description: (message as any).description ?? '',
              task_type: (message as any).task_type,
              prompt: (message as any).prompt,
            })
          } else if (message.type === 'system' && (message as any).subtype === 'task_progress') {
            send(ch, {
              type: 'task_progress',
              session_id: sessionId,
              task_id: (message as any).task_id,
              description: (message as any).description ?? '',
              usage: (message as any).usage ?? { total_tokens: 0, tool_uses: 0, duration_ms: 0 },
              last_tool_name: (message as any).last_tool_name,
              summary: (message as any).summary,
            })
          } else if (
            message.type === 'system' &&
            (message as any).subtype === 'task_notification'
          ) {
            send(ch, {
              type: 'task_notification',
              session_id: sessionId,
              task_id: (message as any).task_id,
              status: (message as any).status,
              summary: (message as any).summary ?? '',
              output_file: (message as any).output_file ?? '',
              usage: (message as any).usage,
            })
          } else if (message.type === 'result') {
            const result = message as any

            // Suppress idle stops — the SDK hit the interactive stop sequence
            // with "No response requested." Don't forward to orchestrator; keep
            // the session alive so the user can send follow-up messages.
            if (isIdleStop(result)) {
              console.log(`[agent-gateway] executeSession: idle stop suppressed`)
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

            send(ch, {
              type: 'result',
              session_id: sessionId,
              subtype: result.subtype,
              duration_ms: duration,
              total_cost_usd: result.total_cost_usd ?? null,
              result: result.result ?? null,
              num_turns: result.num_turns ?? null,
              is_error: result.subtype !== 'success',
              sdk_summary: sdkSummary,
            })
          }
        }
      }

      // --- Initial turn ---
      // Build the streaming prompt: initial prompt only (no queue — each turn gets its own query)
      async function* initialPrompt(): AsyncGenerator<SDKUserMsg> {
        yield {
          type: 'user',
          message: { role: 'user', content: cmd.prompt },
          parent_tool_use_id: null,
        }
      }

      console.log(`[agent-gateway] executeSession: calling query() for ${cmd.project}`)
      const iter = query({
        prompt: initialPrompt(),
        options: options as any,
      })
      await processQueryMessages(iter)

      // --- Multi-turn loop: wait for follow-up messages and resume ---
      // After each turn's result, keep the session alive by waiting for the next
      // stream-input message. When one arrives, start a new query() with resume.
      //
      // If the SDK idle-stopped ("No response requested."), the result was
      // suppressed (not forwarded to orchestrator) so the session stays "running".
      // The loop just goes back to waiting for the next user message.
      while (!ac.signal.aborted && sdkSessionId) {
        const nextMsg = await queue.waitForNext()
        if (!nextMsg) break // queue.done() was called — session is closing

        const msg = nextMsg // capture for generator closure
        async function* followUpPrompt(): AsyncGenerator<SDKUserMsg> {
          yield msg
        }

        console.log(`[agent-gateway] executeSession: resuming for follow-up turn`)
        const resumeOpts = { ...options, resume: sdkSessionId }
        const resumeIter = query({
          prompt: followUpPrompt(),
          options: resumeOpts as any,
        })
        await processQueryMessages(resumeIter)
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)

      // Don't send error for aborted sessions
      if (!ac.signal.aborted) {
        send(ch, { type: 'error', session_id: sessionId, error: errMsg })
      }
    } finally {
      stopHeartbeat()
      // Clean up the message queue and query reference
      queue.done()
      ctx.messageQueue = null
      ctx.query = null
    }
  }
}
