import type { BufferedChannel } from '@duraclaw/shared-transport'
import type {
  GatewayEvent,
  GetContextUsageCommand,
  InterruptCommand,
  SetModelCommand,
  SetPermissionModeCommand,
} from '@duraclaw/shared-types'
import type { RunnerSessionContext } from './types.js'

/** Commands that can be queued before Query is available */
export type QueueableCommand =
  | InterruptCommand
  | SetModelCommand
  | SetPermissionModeCommand
  | GetContextUsageCommand

/**
 * Send a GatewayEvent to the buffered channel.
 * Stamps the next monotonic seq from `ctx.nextSeq` and updates live meta
 * (`last_activity_ts`, `last_event_seq`).
 */
function send(ch: BufferedChannel, event: GatewayEvent, ctx: RunnerSessionContext): void {
  const seq = ++ctx.nextSeq
  ch.send({ ...(event as unknown as Record<string, unknown>), seq })
  ctx.meta.last_activity_ts = Date.now()
  ctx.meta.last_event_seq = seq
}

/**
 * Execute a query command against an active SDK Query object.
 * Called both for direct command handling and for draining the command queue.
 */
export async function handleQueryCommand(
  ctx: RunnerSessionContext,
  cmd: QueueableCommand,
  ch: BufferedChannel,
): Promise<void> {
  const q = ctx.query
  if (!q) {
    send(
      ch,
      {
        type: 'error',
        session_id: ctx.sessionId,
        error: `Cannot execute ${cmd.type}: no active Query object`,
      },
      ctx,
    )
    return
  }

  switch (cmd.type) {
    case 'interrupt': {
      // Mark the context as interrupted BEFORE calling q.interrupt(). On
      // long-running / mid-tool-use sessions the SDK's query generator can
      // throw rather than cleanly yield a result; the outer catch in
      // claude-runner.ts uses this flag to suppress the `error` event and
      // mark meta.state='aborted' so the session lands in `idle` ("just
      // pausing") instead of `error` (genuine failure).
      ctx.interrupted = true
      await q.interrupt()
      break
    }
    case 'get-context-usage': {
      const usage = await q.getContextUsage()
      send(
        ch,
        {
          type: 'context_usage',
          session_id: ctx.sessionId,
          usage: usage as unknown as Record<string, unknown>,
        },
        ctx,
      )
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
