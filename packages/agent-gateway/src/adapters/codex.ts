import type { ExecuteCommand, GatewayEvent, ResumeCommand } from '@duraclaw/shared-types'
import type { ServerWebSocket } from 'bun'
import { resolveProject } from '../projects.js'
import type { GatewaySessionContext, WsData } from '../types.js'
import type { AdapterCapabilities, AgentAdapter } from './types.js'

/** Send a GatewayEvent to the WebSocket client. */
function send(ws: ServerWebSocket<WsData>, event: GatewayEvent): void {
  try {
    ws.send(JSON.stringify(event))
  } catch {
    // WS already closed -- swallow
  }
}

/**
 * Normalize a Codex SDK ThreadItem into GatewayEvent(s).
 *
 * Exported for unit testing.
 */
export function normalizeItemToAssistantContent(item: {
  type: string
  id: string
  text?: string
  command?: string
  aggregated_output?: string
  changes?: Array<{ path: string; kind: string }>
  status?: string
}): unknown[] {
  switch (item.type) {
    case 'agent_message':
      return [{ type: 'text', text: item.text ?? '' }]
    case 'reasoning':
      return [{ type: 'text', text: item.text ?? '' }]
    case 'command_execution':
      return [
        {
          type: 'tool_use',
          name: 'command_execution',
          input: { command: item.command ?? '' },
        },
      ]
    case 'file_change':
      return [
        {
          type: 'tool_use',
          name: 'file_change',
          input: { changes: item.changes ?? [] },
        },
      ]
    case 'mcp_tool_call':
      return [
        {
          type: 'tool_use',
          name: `mcp:${(item as any).server ?? 'unknown'}/${(item as any).tool ?? 'unknown'}`,
          input: (item as any).arguments ?? {},
        },
      ]
    case 'error':
      return [{ type: 'text', text: `Error: ${(item as any).message ?? ''}` }]
    default:
      return [{ type: 'text', text: `[${item.type}]` }]
  }
}

/**
 * Build tool_result content from a completed item.
 *
 * Exported for unit testing.
 */
export function normalizeItemToToolResult(item: {
  type: string
  id: string
  aggregated_output?: string
  status?: string
  changes?: Array<{ path: string; kind: string }>
}): unknown[] {
  switch (item.type) {
    case 'command_execution':
      return [
        {
          type: 'text',
          text: item.aggregated_output ?? '',
        },
      ]
    case 'file_change':
      return [
        {
          type: 'text',
          text: `File changes: ${(item.changes ?? []).map((c) => `${c.kind} ${c.path}`).join(', ')}`,
        },
      ]
    case 'mcp_tool_call': {
      const mcp = item as any
      if (mcp.error) return [{ type: 'text', text: `Error: ${mcp.error.message}` }]
      if (mcp.result) return mcp.result.content ?? []
      return [{ type: 'text', text: 'completed' }]
    }
    default:
      return [{ type: 'text', text: `[${item.type} completed]` }]
  }
}

export class CodexAdapter implements AgentAdapter {
  readonly name = 'codex'

  async execute(
    ws: ServerWebSocket<WsData>,
    cmd: ExecuteCommand,
    ctx: GatewaySessionContext,
  ): Promise<void> {
    return this.runSession(ws, cmd, ctx, false)
  }

  async resume(
    ws: ServerWebSocket<WsData>,
    cmd: ResumeCommand,
    ctx: GatewaySessionContext,
  ): Promise<void> {
    return this.runSession(ws, cmd, ctx, true)
  }

  abort(ctx: GatewaySessionContext): void {
    ctx.abortController.abort()
  }

  async getCapabilities(): Promise<AdapterCapabilities> {
    let available = false
    try {
      await import('@openai/codex-sdk')
      // SDK is importable — available if API key is set or OAuth is configured
      available = true
    } catch {
      // SDK not importable
    }

    return {
      agent: 'codex',
      available,
      supportedCommands: ['execute', 'resume', 'abort'],
      description: 'OpenAI Codex via codex-sdk',
    }
  }

  private async runSession(
    ws: ServerWebSocket<WsData>,
    cmd: ExecuteCommand | ResumeCommand,
    ctx: GatewaySessionContext,
    isResume: boolean,
  ): Promise<void> {
    const { sessionId, abortController: ac } = ctx
    const startTime = Date.now()
    console.log(`[agent-gateway] CodexAdapter: resolving project=${cmd.project}`)

    // Resolve project path
    const projectPath = await resolveProject(cmd.project)
    console.log(`[agent-gateway] CodexAdapter: projectPath=${projectPath}`)
    if (!projectPath) {
      send(ws, {
        type: 'error',
        session_id: sessionId,
        error: `Project "${cmd.project}" not found`,
      })
      return
    }

    try {
      const { Codex } = await import('@openai/codex-sdk')

      const codexOptions: Record<string, unknown> = {}
      if (process.env.OPENAI_API_KEY) {
        codexOptions.apiKey = process.env.OPENAI_API_KEY
      }

      const codex = new Codex(codexOptions as any)

      // Thread options
      const threadOptions: Record<string, unknown> = {
        workingDirectory: projectPath,
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never',
      }

      if (cmd.type === 'execute' && cmd.model) {
        threadOptions.model = cmd.model
      }

      // Start or resume thread
      const thread =
        isResume && cmd.type === 'resume'
          ? codex.resumeThread(cmd.sdk_session_id, threadOptions as any)
          : codex.startThread(threadOptions as any)

      // Build prompt from command
      const prompt =
        typeof cmd.prompt === 'string'
          ? cmd.prompt
          : cmd.prompt
              .filter((b) => b.type === 'text')
              .map((b) => b.text)
              .join('\n')

      console.log(`[agent-gateway] CodexAdapter: running prompt for ${cmd.project}`)
      const streamedTurn = await thread.runStreamed(prompt, {
        signal: ac.signal,
      })

      for await (const event of streamedTurn.events) {
        if (ac.signal.aborted) break

        switch (event.type) {
          case 'thread.started': {
            const threadId = event.thread_id
            send(ws, {
              type: 'session.init',
              session_id: sessionId,
              sdk_session_id: threadId,
              project: cmd.project,
              model: (threadOptions.model as string) ?? 'codex',
              tools: ['command_execution', 'file_change', 'mcp_tool_call'],
            })
            break
          }

          case 'item.updated': {
            const item = event.item
            if (item.type === 'agent_message') {
              send(ws, {
                type: 'partial_assistant',
                session_id: sessionId,
                content: [{ type: 'text', id: item.id, delta: item.text ?? '' }],
              })
            } else if (item.type === 'command_execution') {
              send(ws, {
                type: 'partial_assistant',
                session_id: sessionId,
                content: [
                  {
                    type: 'tool_use',
                    id: item.id,
                    tool_name: 'command_execution',
                    input_delta: item.aggregated_output ?? '',
                  },
                ],
              })
            }
            break
          }

          case 'item.completed': {
            const item = event.item
            if (item.type === 'agent_message' || item.type === 'reasoning') {
              send(ws, {
                type: 'assistant',
                session_id: sessionId,
                uuid: item.id,
                content: normalizeItemToAssistantContent(item),
              })
            } else if (
              item.type === 'command_execution' ||
              item.type === 'file_change' ||
              item.type === 'mcp_tool_call'
            ) {
              // Emit the tool use as assistant content
              send(ws, {
                type: 'assistant',
                session_id: sessionId,
                uuid: item.id,
                content: normalizeItemToAssistantContent(item),
              })
              // Emit the tool result
              send(ws, {
                type: 'tool_result',
                session_id: sessionId,
                uuid: item.id,
                content: normalizeItemToToolResult(item),
              })

              // Emit file_changed events for file changes
              if (item.type === 'file_change') {
                for (const change of item.changes) {
                  send(ws, {
                    type: 'file_changed',
                    session_id: sessionId,
                    path: change.path,
                    tool: 'file_change',
                    timestamp: new Date().toISOString(),
                  })
                }
              }
            } else if (item.type === 'error') {
              send(ws, {
                type: 'error',
                session_id: sessionId,
                error: item.message,
              })
            }
            break
          }

          case 'turn.completed': {
            const duration = Date.now() - startTime
            send(ws, {
              type: 'result',
              session_id: sessionId,
              subtype: 'success',
              duration_ms: duration,
              total_cost_usd: null,
              result: null,
              num_turns: 1,
              is_error: false,
              sdk_summary: null,
            })
            break
          }

          case 'turn.failed': {
            const duration = Date.now() - startTime
            send(ws, {
              type: 'result',
              session_id: sessionId,
              subtype: 'error',
              duration_ms: duration,
              total_cost_usd: null,
              result: event.error.message,
              num_turns: 1,
              is_error: true,
              sdk_summary: null,
            })
            break
          }

          case 'error': {
            send(ws, {
              type: 'error',
              session_id: sessionId,
              error: event.message,
            })
            break
          }

          // turn.started and item.started are lifecycle events -- no gateway event needed
          case 'turn.started':
          case 'item.started':
            break
        }
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)

      // Don't send error for aborted sessions
      if (!ac.signal.aborted) {
        send(ws, { type: 'error', session_id: sessionId, error: errMsg })
      }
    }
  }
}
