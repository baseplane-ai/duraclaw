import type { ExecuteCommand, ResumeCommand } from '@duraclaw/shared-types'
import type { ServerWebSocket } from 'bun'
import { ClaudeAdapter } from './adapters/claude.js'
import type { GatewaySessionContext, WsData } from './types.js'

/**
 * @deprecated Use ClaudeAdapter directly via the adapter registry.
 * Kept for backward compatibility during migration.
 */
const claude = new ClaudeAdapter()

export async function executeSession(
  ws: ServerWebSocket<WsData>,
  cmd: ExecuteCommand | ResumeCommand,
  ctx: GatewaySessionContext,
): Promise<void> {
  if (cmd.type === 'resume') {
    return claude.resume(ws, cmd, ctx)
  }
  return claude.execute(ws, cmd, ctx)
}
