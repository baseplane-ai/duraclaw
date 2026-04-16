import type { AgentAdapter } from './adapters/types.js'
import { handleQueryCommand } from './commands.js'
import { fromWebSocket, type SessionChannel } from './session-channel.js'
import type { GatewayCommand, GatewaySessionContext } from './types.js'

/**
 * Shared map tracking dial-back sessions by session ID.
 * Used by both dialOutboundWs and the shutdown handler.
 */
export const dialbackSessions = new Map<
  string,
  { ctx: GatewaySessionContext; channel: SessionChannel; ws: WebSocket }
>()

/**
 * Handle a message received on the dial-back WS from the DO.
 * These are commands like abort, stop, answer, stream-input, etc.
 */
export function handleDialbackMessage(
  sessionId: string,
  msg: any,
  ctx: GatewaySessionContext,
  channel: SessionChannel,
) {
  switch (msg.type) {
    case 'stream-input': {
      if (ctx.messageQueue) {
        ctx.messageQueue.push(msg.message)
      }
      break
    }
    case 'permission-response': {
      if (ctx.pendingPermission) {
        ctx.pendingPermission.resolve(msg.allowed)
        ctx.pendingPermission = null
      }
      break
    }
    case 'abort': {
      ctx.abortController.abort()
      dialbackSessions.delete(sessionId)
      break
    }
    case 'stop': {
      const sdkSessionId = ctx.sessionId
      ctx.abortController.abort()
      try {
        channel.send(
          JSON.stringify({
            type: 'stopped',
            session_id: ctx.sessionId,
            sdk_session_id: sdkSessionId,
          }),
        )
      } catch {
        /* closed */
      }
      dialbackSessions.delete(sessionId)
      break
    }
    case 'answer': {
      if (ctx.pendingAnswer) {
        ctx.pendingAnswer.resolve(msg.answers)
        ctx.pendingAnswer = null
      }
      break
    }
    case 'interrupt':
    case 'get-context-usage':
    case 'set-model':
    case 'set-permission-mode': {
      if (ctx.query) {
        handleQueryCommand(ctx, msg, channel)
      } else {
        ctx.commandQueue.push(msg)
      }
      break
    }
    case 'rewind': {
      if (ctx.query) {
        ctx.query
          .rewindFiles(msg.message_id, { dryRun: msg.dry_run })
          .then((result: any) => {
            try {
              channel.send(
                JSON.stringify({
                  type: 'rewind_result',
                  session_id: ctx.sessionId,
                  can_rewind: result.canRewind,
                  error: result.error,
                  files_changed: result.filesChanged,
                  insertions: result.insertions,
                  deletions: result.deletions,
                }),
              )
            } catch {
              /* closed */
            }
          })
          .catch((err: any) => {
            try {
              channel.send(
                JSON.stringify({
                  type: 'error',
                  session_id: ctx.sessionId,
                  error: `Rewind failed: ${err instanceof Error ? err.message : String(err)}`,
                }),
              )
            } catch {
              /* closed */
            }
          })
      }
      break
    }
    case 'stop-task': {
      if (ctx.query) {
        ctx.query.stopTask(msg.task_id)
      }
      break
    }
    case 'ping': {
      try {
        channel.send(JSON.stringify({ type: 'pong' }))
      } catch {
        /* closed */
      }
      break
    }
  }
}

/**
 * Dial an outbound WebSocket to the DO callback_url and run an adapter session over it.
 * Implements reconnect with exponential backoff (1s, 3s, 9s) if the WS drops while the session is still running.
 */
export function dialOutboundWs(
  callbackUrl: string,
  cmd: GatewayCommand,
  ctx: GatewaySessionContext,
  adapter: AgentAdapter,
  sessionId: string,
  attempt = 0,
) {
  const ws = new WebSocket(callbackUrl)
  const channel = fromWebSocket(ws)

  ws.addEventListener('open', () => {
    console.log(`[agent-gateway] Dial-back WS connected for session ${sessionId}`)
    dialbackSessions.set(sessionId, { ctx, channel, ws })

    // Run session in background
    const sessionPromise =
      cmd.type === 'resume'
        ? adapter.resume(channel, cmd as any, ctx)
        : adapter.execute(channel, cmd as any, ctx)

    sessionPromise
      .then(() => {
        console.log(`[agent-gateway] Dial-back session ${sessionId} completed`)
      })
      .catch((err) => {
        console.error(`[agent-gateway] Dial-back session ${sessionId} error:`, err)
      })
      .finally(() => {
        dialbackSessions.delete(sessionId)
      })
  })

  ws.addEventListener('message', (event: MessageEvent) => {
    // Route DO->gateway commands to the session context
    try {
      const msg = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString())
      handleDialbackMessage(sessionId, msg, ctx, channel)
    } catch (err) {
      console.error(`[agent-gateway] Failed to parse dial-back message:`, err)
    }
  })

  ws.addEventListener('close', () => {
    console.log(`[agent-gateway] Dial-back WS closed for session ${sessionId}`)
    const entry = dialbackSessions.get(sessionId)
    if (entry && !ctx.abortController.signal.aborted) {
      // Reconnect with exponential backoff: 1s, 3s, 9s
      const maxRetries = 3
      if (attempt < maxRetries) {
        const delay = 3 ** attempt * 1000
        console.log(
          `[agent-gateway] Reconnecting dial-back WS in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`,
        )
        setTimeout(() => {
          dialOutboundWs(callbackUrl, cmd, ctx, adapter, sessionId, attempt + 1)
        }, delay)
      } else {
        console.error(
          `[agent-gateway] Dial-back WS reconnect failed after ${maxRetries} attempts — aborting session ${sessionId}`,
        )
        ctx.abortController.abort()
        dialbackSessions.delete(sessionId)
      }
    } else {
      dialbackSessions.delete(sessionId)
    }
  })

  ws.addEventListener('error', (event: Event) => {
    console.error(`[agent-gateway] Dial-back WS error for session ${sessionId}:`, event)
  })
}
