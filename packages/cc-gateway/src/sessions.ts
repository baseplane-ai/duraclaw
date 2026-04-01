import type { ServerWebSocket } from 'bun'
import { buildCleanEnv } from './env.js'
import type {
  ExecuteCommand,
  GatewayEvent,
  ResumeCommand,
  SessionContext,
  WsData,
} from './types.js'
import { resolveWorktree } from './worktrees.js'

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
  message: { role: 'user'; content: string }
  parent_tool_use_id: string | null
}

/**
 * Create an async iterable queue for streaming user messages into a running session.
 * The queue yields messages as they are pushed, and stops when done() is called.
 */
function createMessageQueue() {
  const pending: Array<{ role: 'user'; content: string }> = []
  let resolve: (() => void) | null = null
  let finished = false

  const iterable: AsyncIterable<SDKUserMsg> = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          while (true) {
            if (pending.length > 0) {
              const msg = pending.shift()!
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
    push(msg: { role: 'user'; content: string }) {
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
  ctx: SessionContext,
): Promise<void> {
  const { sessionId, abortController: ac } = ctx
  const startTime = Date.now()
  console.log(`[cc-gateway] executeSession: resolving worktree=${cmd.worktree}`)

  // Resolve worktree path
  const worktreePath = await resolveWorktree(cmd.worktree)
  console.log(`[cc-gateway] executeSession: worktreePath=${worktreePath}`)
  if (!worktreePath) {
    send(ws, {
      type: 'error',
      session_id: sessionId,
      error: `Worktree "${cmd.worktree}" not found`,
    })
    return
  }

  // Set up message queue for streaming input
  const queue = createMessageQueue()
  ctx.messageQueue = queue

  try {
    // Dynamic import — the SDK is ESM-only
    const { query } = await import('@anthropic-ai/claude-agent-sdk')

    const options: Record<string, unknown> = {
      abortController: ac,
      cwd: worktreePath,
      env: buildCleanEnv(),
      permissionMode: 'default',
      includePartialMessages: true,
      settingSources: ['user', 'project', 'local'],
    }

    if (cmd.type === 'execute') {
      if (cmd.model) options.model = cmd.model
      if (cmd.system_prompt) options.systemPrompt = cmd.system_prompt
      if (cmd.allowed_tools) options.allowedTools = cmd.allowed_tools
      if (cmd.max_turns) options.maxTurns = cmd.max_turns
      if (cmd.max_budget_usd) options.maxBudgetUsd = cmd.max_budget_usd
    } else {
      // resume
      options.resume = cmd.sdk_session_id
    }

    // Intercept tool calls: AskUserQuestion -> relay questions, others -> permission prompt
    options.canUseTool = async (
      toolName: string,
      input: Record<string, unknown>,
      toolOptions: { id: string },
    ) => {
      if (toolName === 'AskUserQuestion') {
        // Relay questions to the orchestrator, wait for answers
        send(ws, {
          type: 'ask_user',
          session_id: sessionId,
          tool_call_id: toolOptions.id,
          questions: (input as any).questions ?? [],
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

        return { behavior: 'allow', updatedInput: { ...input, answers } }
      }

      // Permission prompt for other tools
      send(ws, {
        type: 'permission_request',
        session_id: sessionId,
        tool_call_id: toolOptions.id,
        tool_name: toolName,
        input,
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

      return allowed
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: 'User denied permission' }
    }

    // PostToolUse hook: emit file-changed events for Edit/Write tools
    options.postToolUse = async (
      toolName: string,
      input: Record<string, unknown>,
      _output: unknown,
    ) => {
      if (toolName === 'Edit' || toolName === 'Write') {
        const filePath = input.file_path as string | undefined
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

    console.log(`[cc-gateway] executeSession: calling query() for ${cmd.worktree}`)
    const iter = query({
      prompt: messageGenerator(),
      options: options as any,
    })
    console.log(`[cc-gateway] executeSession: got iterator, starting loop`)

    for await (const message of iter) {
      console.log(`[cc-gateway] executeSession: message type=${message.type}`)
      if (ac.signal.aborted) break

      if (message.type === 'system' && (message as any).subtype === 'init') {
        const sdkSessionId = (message as any).session_id as string | undefined
        const model = (message as any).model ?? null
        const tools = (message as any).tools ?? []

        send(ws, {
          type: 'session.init',
          session_id: sessionId,
          sdk_session_id: sdkSessionId ?? null,
          worktree: cmd.worktree,
          model,
          tools,
        })
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
                typeof block.input === 'string'
                  ? block.input
                  : JSON.stringify(block.input ?? ''),
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
      } else if (message.type === 'result') {
        const result = message as any
        const duration = Date.now() - startTime

        send(ws, {
          type: 'result',
          session_id: sessionId,
          subtype: result.subtype,
          duration_ms: duration,
          total_cost_usd: result.total_cost_usd ?? null,
          result: result.result ?? null,
          num_turns: result.num_turns ?? null,
          is_error: result.subtype !== 'success',
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
    // Clean up the message queue
    queue.done()
    ctx.messageQueue = null
  }
}
