import type { ExecuteCommand, ResumeCommand } from '@duraclaw/shared-types'
import type { SessionChannel } from '../session-channel.js'
import type { GatewaySessionContext } from '../types.js'

export interface AdapterCapabilities {
  agent: string
  available: boolean
  supportedCommands: string[]
  models?: string[]
  description: string
}

export interface AgentAdapter {
  readonly name: string
  execute(ch: SessionChannel, cmd: ExecuteCommand, ctx: GatewaySessionContext): Promise<void>
  resume(ch: SessionChannel, cmd: ResumeCommand, ctx: GatewaySessionContext): Promise<void>
  abort(ctx: GatewaySessionContext): void
  getCapabilities(): Promise<AdapterCapabilities>
}
