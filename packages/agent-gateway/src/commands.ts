import type { GatewayEvent } from '@duraclaw/shared-types'
import type { SessionChannel } from './session-channel.js'
import type {
  GatewaySessionContext,
  GetContextUsageCommand,
  InterruptCommand,
  SetModelCommand,
  SetPermissionModeCommand,
} from './types.js'

/** Commands that can be queued before Query is available */
export type QueueableCommand =
  | InterruptCommand
  | SetModelCommand
  | SetPermissionModeCommand
  | GetContextUsageCommand

/** Send a GatewayEvent to the WebSocket client. */
function send(ch: SessionChannel, event: GatewayEvent): void {
  try {
    ch.send(JSON.stringify(event))
  } catch {
    // WS already closed — swallow
  }
}

/**
 * Execute a query command against an active SDK Query object.
 * Called both for direct command handling and for draining the command queue.
 */
export async function handleQueryCommand(
  ctx: GatewaySessionContext,
  cmd: QueueableCommand,
  ch: SessionChannel,
): Promise<void> {
  const q = ctx.query
  if (!q) {
    send(ch, {
      type: 'error',
      session_id: ctx.sessionId,
      error: `Cannot execute ${cmd.type}: no active Query object`,
    })
    return
  }

  switch (cmd.type) {
    case 'interrupt': {
      await q.interrupt()
      break
    }
    case 'get-context-usage': {
      const usage = await q.getContextUsage()
      send(ch, {
        type: 'context_usage',
        session_id: ctx.sessionId,
        usage: usage as unknown as Record<string, unknown>,
      })
      break
    }
    case 'set-model': {
      await q.setModel(cmd.model ?? undefined)
      break
    }
    case 'set-permission-mode': {
      await q.setPermissionMode(cmd.mode as any)
      break
    }
  }
}
