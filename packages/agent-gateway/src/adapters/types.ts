import type { ExecuteCommand, ResumeCommand } from '@duraclaw/shared-types'
import type { ServerWebSocket } from 'bun'
import type { GatewaySessionContext, WsData } from '../types.js'

export interface AdapterCapabilities {
  agent: string
  available: boolean
  supportedCommands: string[]
  models?: string[]
  description: string
}

export interface AgentAdapter {
  readonly name: string
  execute(
    ws: ServerWebSocket<WsData>,
    cmd: ExecuteCommand,
    ctx: GatewaySessionContext,
  ): Promise<void>
  resume(ws: ServerWebSocket<WsData>, cmd: ResumeCommand, ctx: GatewaySessionContext): Promise<void>
  abort(ctx: GatewaySessionContext): void
  getCapabilities(): Promise<AdapterCapabilities>
}
