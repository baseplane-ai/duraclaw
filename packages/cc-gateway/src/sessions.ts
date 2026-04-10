import type { ServerWebSocket } from 'bun'
import { handleQueryCommand } from './commands.js'
import { buildCleanEnv } from './env.js'
import { resolveProject } from './projects.js'
import type {
  ContentBlock,
  ExecuteCommand,
  GatewayEvent,
  GatewaySessionContext,
  ResumeCommand,
  WsData,
} from './types.js'

/** Send a GatewayEvent to the WebSocket client. */
function send(ws: ServerWebSocket<WsData>, event: GatewayEvent): void {
  try {
    ws.send(JSON.stringify(event))
  } catch {
    // WS already closed — swallow
  }
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
    },
    done() {
      finished = true
      resolve?.()
    },
  }
}

/**
 * Execute a session: run the Claude SDK query() and stream GatewayEvent messages
 * back over the WebSocket connection. Works for both "execute" and "resume" commands.
 */
export async function executeSession(
  ws: ServerWebSocket<WsData>,
  cmd: ExecuteCommand | ResumeCommand,
  ctx: GatewaySessionContext,
): Promise<void> {
  const { sessionId, abortController: ac } = ctx
  const startTime = Date.now()
  console.log(`[cc-gateway] executeSession: resolving project=${cmd.project}`)

  // Resolve project path
  const projectPath = await resolveProject(cmd.project)
  console.log(`[cc-gateway] executeSession: projectPath=${projectPath}`)
  if (!projectPath) {
    send(ws, {
      type: 'error',
      session_id: sessionId,
      error: `Project "${cmd.project}" not found`,
    })
    return
  }

  // Set up message queue for streaming input
  const queue = createMessageQueue()
  ctx.messageQueue = queue

  let sdkSessionId: string | null = null

  try {
    // Dynamic import — the SDK is ESM-only
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

    // SDK hooks: PreToolUse for permission gating + AskUserQuestion relay, PostToolUse for file-changed events
    options.hooks = {
      PreToolUse: [
        {
          hooks: [
            async (input: any, toolUseId: string | undefined, _opts: { signal: AbortSignal }) => {
              const toolName: string = input.tool_name
              const toolInput: Record<string, unknown> = input.tool_input ?? {}
              const id = toolUseId ?? input.tool_use_id ?? ''

              if (toolName === 'AskUserQuestion') {
                // Relay questions to the orchestrator, wait for answers
                send(ws, {
                  type: 'ask_user',
                  session_id: sessionId,
                  tool_call_id: id,
                  questions: (toolInput as any).questions ?? [],
                })

                const answers = await new Promise<Record<string, string>>((resolve, reject) => {
                  const timeout = setTimeout(
                    () => {
                      ctx.pendingAnswer = null
                      reject(new Error('AskUserQuestion timed out after 5 minutes'))
                    },
                    5 * 60 * 1000,
                  )

                  ctx.pendingAnswer = {
                    resolve: (a) => {
                      clearTimeout(timeout)
                      resolve(a)
                    },
                    reject: (e) => {
                      clearTimeout(timeout)
                      reject(e)
                    },
                  }

                  ac.signal.addEventListener(
                    'abort',
                    () => {
                      clearTimeout(timeout)
                      ctx.pendingAnswer = null
                      reject(new Error('Session aborted'))
                    },
                    { once: true },
                  )
                })

                return {
                  continue: true,
                  hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    permissionDecision: 'allow' as const,
                    updatedInput: { ...toolInput, answers },
                  },
                }
              }

              // Permission prompt for other tools
              send(ws, {
                type: 'permission_request',
                session_id: sessionId,
                tool_call_id: id,
                tool_name: toolName,
                input: toolInput,
              })

              const allowed = await new Promise<boolean>((resolve, reject) => {
                const timeout = setTimeout(
                  () => {
                    ctx.pendingPermission = null
                    reject(new Error('Permission prompt timed out after 5 minutes'))
                  },
                  5 * 60 * 1000,
                )

                ctx.pendingPermission = {
                  resolve: (a) => {
                    clearTimeout(timeout)
                    resolve(a)
                  },
                  reject: (e) => {
                    clearTimeout(timeout)
                    reject(e)
                  },
                }

                ac.signal.addEventListener(
                  'abort',
                  () => {
                    clearTimeout(timeout)
                    ctx.pendingPermission = null
                    reject(new Error('Session aborted'))
                  },
                  { once: true },
                )
              })

              return {
                continue: true,
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse',
                  permissionDecision: allowed ? ('allow' as const) : ('deny' as const),
                },
              }
            },
          ],
        },
      ],
      PostToolUse: [
        {
          hooks: [
            async (input: any, _toolUseId: string | undefined, _opts: { signal: AbortSignal }) => {
              const toolName: string = input.tool_name
              const toolInput: Record<string, unknown> = input.tool_input ?? {}

              if (toolName === 'Edit' || toolName === 'Write') {
                const filePath = toolInput.file_path as string | undefined
                if (filePath) {
                  send(ws, {
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

    // Build the streaming prompt: initial prompt + async iterable for follow-up messages
    async function* messageGenerator(): AsyncGenerator<SDKUserMsg> {
      yield {
        type: 'user',
        message: { role: 'user', content: cmd.prompt },
        parent_tool_use_id: null,
      }
      for await (const msg of queue.iterable) {
        yield msg
      }
    }

    console.log(`[cc-gateway] executeSession: calling query() for ${cmd.project}`)
    const iter = query({
      prompt: messageGenerator(),
      options: options as any,
    })

    // Store Query object on context for mid-session control
    ctx.query = iter
    console.log(`[cc-gateway] executeSession: got iterator, starting loop`)

    for await (const message of iter) {
      console.log(`[cc-gateway] executeSession: message type=${message.type}`)
      if (ac.signal.aborted) break

      if (message.type === 'system' && (message as any).subtype === 'init') {
        sdkSessionId = (message as any).session_id ?? null
        const model = (message as any).model ?? null
        const tools = (message as any).tools ?? []

        send(ws, {
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
            await handleQueryCommand(ctx, queuedCmd, ws)
          }
          ctx.commandQueue = []
        }
      } else if (message.type === 'assistant' && (message as any).partial) {
        // Partial assistant message — emit incremental content
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

        send(ws, {
          type: 'partial_assistant',
          session_id: sessionId,
          content: blocks,
        })
      } else if (message.type === 'assistant') {
        send(ws, {
          type: 'assistant',
          session_id: sessionId,
          uuid: (message as any).uuid,
          content: (message as any).message?.content ?? [],
        })
      } else if (message.type === 'tool_use_summary') {
        send(ws, {
          type: 'tool_result',
          session_id: sessionId,
          uuid: (message as any).uuid ?? '',
          content: (message as any).content ?? (message as any).results ?? [],
        })
      } else if (
        message.type === 'system' &&
        (message as any).subtype === 'session_state_changed'
      ) {
        send(ws, {
          type: 'session_state_changed',
          session_id: sessionId,
          state: (message as any).state,
        })
      } else if (message.type === 'rate_limit_event') {
        send(ws, {
          type: 'rate_limit',
          session_id: sessionId,
          rate_limit_info: (message as any).rate_limit_info,
        })
      } else if (message.type === 'system' && (message as any).subtype === 'task_started') {
        send(ws, {
          type: 'task_started',
          session_id: sessionId,
          task_id: (message as any).task_id,
          description: (message as any).description ?? '',
          task_type: (message as any).task_type,
          prompt: (message as any).prompt,
        })
      } else if (message.type === 'system' && (message as any).subtype === 'task_progress') {
        send(ws, {
          type: 'task_progress',
          session_id: sessionId,
          task_id: (message as any).task_id,
          description: (message as any).description ?? '',
          usage: (message as any).usage ?? { total_tokens: 0, tool_uses: 0, duration_ms: 0 },
          last_tool_name: (message as any).last_tool_name,
          summary: (message as any).summary,
        })
      } else if (message.type === 'system' && (message as any).subtype === 'task_notification') {
        send(ws, {
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
        const duration = Date.now() - startTime

        // Fetch SDK session summary (best-effort)
        let sdkSummary: string | null = null
        if (sdkSessionId) {
          try {
            const { getSessionInfo } = await import('@anthropic-ai/claude-agent-sdk')
            const info = await getSessionInfo(sdkSessionId, { dir: projectPath })
            sdkSummary = info?.summary ?? null
          } catch {
            // Non-fatal — summary is best-effort
          }
        }

        send(ws, {
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
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err)

    // Don't send error for aborted sessions
    if (!ac.signal.aborted) {
      send(ws, { type: 'error', session_id: sessionId, error: errMsg })
    }
  } finally {
    // Clean up the message queue and query reference
    queue.done()
    ctx.messageQueue = null
    ctx.query = null
  }
}
