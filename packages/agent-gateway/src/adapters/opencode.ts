import type { ExecuteCommand, GatewayEvent, ResumeCommand } from '@duraclaw/shared-types'
import type { SessionChannel } from '../session-channel.js'
import type { GatewaySessionContext } from '../types.js'
import type { AdapterCapabilities, AgentAdapter } from './types.js'

const DEFAULT_OPENCODE_URL = 'http://127.0.0.1:3000'

/** Send a GatewayEvent to the channel. */
function send(ch: SessionChannel, event: GatewayEvent): void {
  try {
    ch.send(JSON.stringify(event))
  } catch {
    // Channel already closed -- swallow
  }
}

/**
 * Parse a model string like "anthropic/claude-sonnet-4-20250514" into providerID + modelID.
 *
 * Exported for unit testing.
 */
export function parseModelSpec(
  model?: string,
): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined
  const slashIdx = model.indexOf('/')
  if (slashIdx > 0) {
    return { providerID: model.substring(0, slashIdx), modelID: model.substring(slashIdx + 1) }
  }
  // No slash -- assume anthropic as default provider
  return { providerID: 'anthropic', modelID: model }
}

/**
 * Normalize an OpenCode Part into GatewayEvent assistant content blocks.
 *
 * Exported for unit testing.
 */
export function normalizePartToContent(part: {
  type: string
  id: string
  text?: string
  tool?: string
  callID?: string
  state?: {
    status: string
    input?: Record<string, unknown>
    output?: string
    error?: string
    title?: string
  }
}): unknown[] {
  switch (part.type) {
    case 'text':
      return [{ type: 'text', text: part.text ?? '' }]
    case 'reasoning':
      return [{ type: 'text', text: part.text ?? '' }]
    case 'tool': {
      const state = part.state
      if (!state) return []
      return [
        {
          type: 'tool_use',
          name: part.tool ?? 'unknown',
          input: state.input ?? {},
        },
      ]
    }
    default:
      return [{ type: 'text', text: `[${part.type}]` }]
  }
}

/**
 * Build tool_result content from a completed tool part.
 *
 * Exported for unit testing.
 */
export function normalizePartToToolResult(part: {
  type: string
  id: string
  tool?: string
  state?: {
    status: string
    output?: string
    error?: string
  }
}): unknown[] {
  if (part.type !== 'tool') return []
  const state = part.state
  if (!state) return [{ type: 'text', text: 'completed' }]

  if (state.status === 'error') {
    return [{ type: 'text', text: `Error: ${state.error ?? ''}` }]
  }
  return [{ type: 'text', text: state.output ?? '' }]
}

export class OpenCodeAdapter implements AgentAdapter {
  readonly name = 'opencode'

  async execute(
    ch: SessionChannel,
    cmd: ExecuteCommand,
    ctx: GatewaySessionContext,
  ): Promise<void> {
    return this.runSession(ch, cmd, ctx)
  }

  async resume(ch: SessionChannel, cmd: ResumeCommand, ctx: GatewaySessionContext): Promise<void> {
    // OpenCode doesn't have a direct resume mechanism like Claude's sdk_session_id.
    // We send the prompt to the existing session referenced by sdk_session_id.
    return this.runSession(ch, cmd, ctx)
  }

  abort(ctx: GatewaySessionContext): void {
    ctx.abortController.abort()
  }

  async getCapabilities(): Promise<AdapterCapabilities> {
    let available = false
    const baseUrl = process.env.OPENCODE_URL ?? DEFAULT_OPENCODE_URL

    try {
      // Check if the OpenCode sidecar is reachable
      const res = await fetch(`${baseUrl}/health`, {
        signal: AbortSignal.timeout(3000),
      })
      if (res.ok) {
        available = true
      }
    } catch {
      // Sidecar not reachable -- try /project endpoint as fallback
      try {
        const res = await fetch(`${baseUrl}/project`, {
          signal: AbortSignal.timeout(3000),
        })
        if (res.ok) {
          available = true
        }
      } catch {
        // Sidecar not reachable
      }
    }

    return {
      agent: 'opencode',
      available,
      supportedCommands: ['execute', 'abort'],
      description: 'OpenCode multi-provider agent',
    }
  }

  private async runSession(
    ch: SessionChannel,
    cmd: ExecuteCommand | ResumeCommand,
    ctx: GatewaySessionContext,
  ): Promise<void> {
    const { sessionId, abortController: ac } = ctx
    const startTime = Date.now()
    const baseUrl = process.env.OPENCODE_URL ?? DEFAULT_OPENCODE_URL

    console.log(`[agent-gateway] OpenCodeAdapter: starting session for project=${cmd.project}`)

    try {
      const { createOpencodeClient } = await import('@opencode-ai/sdk')

      const clientConfig: Record<string, unknown> = {
        baseUrl,
      }

      // Add auth if password is configured
      if (process.env.OPENCODE_SERVER_PASSWORD) {
        clientConfig.auth = () =>
          `Basic ${btoa(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`)}`
      }

      const client = createOpencodeClient(clientConfig as any)

      // Create or reuse session
      let ocSessionId: string
      if (cmd.type === 'resume' && cmd.sdk_session_id) {
        ocSessionId = cmd.sdk_session_id
      } else {
        const sessionResult = await client.session.create({
          body: {},
        })
        if (!sessionResult.data) {
          send(ch, {
            type: 'error',
            session_id: sessionId,
            error: `Failed to create OpenCode session: ${sessionResult.error ? JSON.stringify(sessionResult.error) : 'unknown error'}`,
          })
          return
        }
        ocSessionId = sessionResult.data.id
      }

      // Parse model spec for the prompt
      const modelSpec = cmd.type === 'execute' ? parseModelSpec(cmd.model ?? undefined) : undefined

      // Build prompt text
      const promptText =
        typeof cmd.prompt === 'string'
          ? cmd.prompt
          : cmd.prompt
              .filter((b) => b.type === 'text')
              .map((b) => b.text)
              .join('\n')

      // Subscribe to the SSE event stream before sending the prompt
      const eventResult = await client.event.subscribe({
        query: {},
      })

      // Send session.init immediately
      send(ch, {
        type: 'session.init',
        session_id: sessionId,
        sdk_session_id: ocSessionId,
        project: cmd.project,
        model: modelSpec ? `${modelSpec.providerID}/${modelSpec.modelID}` : 'opencode',
        tools: [],
      })

      // Send the prompt asynchronously (non-blocking)
      const promptBody: Record<string, unknown> = {
        parts: [{ type: 'text', text: promptText }],
      }
      if (modelSpec) {
        promptBody.model = modelSpec
      }

      const promptPromise = client.session.promptAsync({
        path: { id: ocSessionId },
        body: promptBody as any,
      })

      // Track the prompt in case we need to handle errors
      promptPromise.catch((err: unknown) => {
        if (!ac.signal.aborted) {
          const errMsg = err instanceof Error ? err.message : String(err)
          send(ch, {
            type: 'error',
            session_id: sessionId,
            error: `OpenCode prompt failed: ${errMsg}`,
          })
        }
      })

      // Process the SSE event stream
      let sessionBusy = true
      for await (const event of eventResult.stream) {
        if (ac.signal.aborted) break

        const evt = event as { type: string; properties: Record<string, unknown> }

        switch (evt.type) {
          case 'message.part.updated': {
            const part = evt.properties.part as {
              type: string
              id: string
              sessionID: string
              messageID: string
              text?: string
              tool?: string
              callID?: string
              state?: {
                status: string
                input?: Record<string, unknown>
                output?: string
                error?: string
                title?: string
              }
            }
            const delta = evt.properties.delta as string | undefined

            // Only process events for our session
            if (part.sessionID !== ocSessionId) break

            if (part.type === 'text' && delta !== undefined) {
              // Streaming text delta
              send(ch, {
                type: 'partial_assistant',
                session_id: sessionId,
                content: [{ type: 'text', id: part.id, delta }],
              })
            } else if (part.type === 'tool') {
              const state = part.state
              if (state?.status === 'running') {
                // Tool started running -- emit as partial_assistant
                send(ch, {
                  type: 'partial_assistant',
                  session_id: sessionId,
                  content: [
                    {
                      type: 'tool_use',
                      id: part.id,
                      tool_name: part.tool ?? 'unknown',
                      input_delta: JSON.stringify(state.input ?? {}),
                    },
                  ],
                })
              } else if (state?.status === 'completed') {
                // Tool completed -- emit assistant + tool_result
                send(ch, {
                  type: 'assistant',
                  session_id: sessionId,
                  uuid: part.id,
                  content: normalizePartToContent(part),
                })
                send(ch, {
                  type: 'tool_result',
                  session_id: sessionId,
                  uuid: part.id,
                  content: normalizePartToToolResult(part),
                })
              } else if (state?.status === 'error') {
                // Tool error -- emit tool_result with error
                send(ch, {
                  type: 'assistant',
                  session_id: sessionId,
                  uuid: part.id,
                  content: normalizePartToContent(part),
                })
                send(ch, {
                  type: 'tool_result',
                  session_id: sessionId,
                  uuid: part.id,
                  content: normalizePartToToolResult(part),
                })
              }
            }
            break
          }

          case 'message.updated': {
            const info = evt.properties.info as {
              role: string
              id: string
              sessionID: string
              time?: { completed?: number }
              error?: { name: string; data?: { message?: string } }
              cost?: number
            }
            if (info.sessionID !== ocSessionId) break

            if (info.role === 'assistant' && info.time?.completed) {
              // Assistant message completed -- emit full assistant event
              // We don't re-emit content here since parts already streamed it
            }

            if (info.error) {
              const errorMsg = info.error.data?.message ?? info.error.name ?? 'Unknown error'
              send(ch, {
                type: 'error',
                session_id: sessionId,
                error: errorMsg,
              })
            }
            break
          }

          case 'session.error': {
            const props = evt.properties as {
              sessionID?: string
              error?: { name: string; data?: { message?: string } }
            }
            if (props.sessionID && props.sessionID !== ocSessionId) break

            const errorMsg =
              props.error?.data?.message ?? props.error?.name ?? 'Unknown session error'
            send(ch, {
              type: 'error',
              session_id: sessionId,
              error: errorMsg,
            })
            break
          }

          case 'session.status': {
            const props = evt.properties as {
              sessionID: string
              status: { type: string }
            }
            if (props.sessionID !== ocSessionId) break

            if (props.status.type === 'idle' && !sessionBusy) {
              // Session went idle -- nothing special to do
            } else if (props.status.type === 'busy') {
              sessionBusy = true
            }
            break
          }

          case 'session.idle': {
            const props = evt.properties as { sessionID: string }
            if (props.sessionID !== ocSessionId) break

            if (sessionBusy) {
              // Session transitioned from busy to idle -- session is done
              sessionBusy = false
              const duration = Date.now() - startTime

              send(ch, {
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
              return
            }
            break
          }

          case 'file.edited': {
            const props = evt.properties as { file: string }
            send(ch, {
              type: 'file_changed',
              session_id: sessionId,
              path: props.file,
              tool: 'opencode',
              timestamp: new Date().toISOString(),
            })
            break
          }

          // Lifecycle events we don't need to relay
          case 'session.created':
          case 'session.updated':
          case 'session.deleted':
          case 'session.compacted':
          case 'session.diff':
          case 'message.removed':
          case 'message.part.removed':
          case 'permission.updated':
          case 'permission.replied':
          case 'todo.updated':
          case 'command.executed':
          case 'server.connected':
            break
        }
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)

      // Don't send error for aborted sessions
      if (!ac.signal.aborted) {
        send(ch, { type: 'error', session_id: sessionId, error: errMsg })
      }
    }
  }
}
