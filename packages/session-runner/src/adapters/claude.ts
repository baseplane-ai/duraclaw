import type { BufferedChannel } from '@duraclaw/shared-transport'
import type {
  AdapterCapabilities,
  ContentBlock,
  ExecuteCommand,
  ResumeCommand,
} from '@duraclaw/shared-types'
import { ClaudeRunner } from '../claude-runner.js'
import type { RunnerSessionContext, SDKUserMsg } from '../types.js'
import type { AdapterStartOptions, RunnerAdapter } from './types.js'

/**
 * Capability bitmap declared by the Claude adapter on `session.init`.
 *
 * GH#107 / spec 107-codex-runner-revival B3: lifted out of the runner
 * so any consumer (the runner emitting `session.init`, capability
 * gates, future `/capabilities` endpoint) can read a single source of
 * truth. CodexAdapter (P3) ships the contrasting bitmap.
 */
export const CLAUDE_CAPABILITIES: AdapterCapabilities = {
  supportsRewind: true,
  supportsThinkingDeltas: true,
  supportsPermissionGate: true,
  supportsSubagents: true,
  supportsPermissionMode: true,
  supportsSetModel: true,
  supportsContextUsage: true,
  supportsInterrupt: true,
  supportsCleanAbort: true,
  emitsUsdCost: true,
  availableProviders: [
    { provider: 'anthropic', models: ['claude-4-sonnet', 'claude-4-opus', 'claude-4-haiku'] },
  ],
}

/**
 * ClaudeAdapter — wraps the existing `ClaudeRunner` behind the
 * `RunnerAdapter` interface.
 *
 * P1.1 is a pure refactor: zero behaviour change for Claude sessions.
 * Rather than rewrite the SDK message-loop in `claude-runner.ts`, this
 * adapter is a thin delegating shell. The runner-internal entry points
 * (`ClaudeRunner.execute` / `ClaudeRunner.resume`) still take
 * `(channel, cmd, ctx)` directly; `runLegacy()` below is the legacy
 * bridge `main.ts` calls into for the Claude path.
 *
 * The standard `run(opts)` path is left as a placeholder — CodexAdapter
 * (P3) will exercise the opts-based contract; Claude continues on the
 * legacy bridge until a future cleanup folds the two paths together.
 */
export class ClaudeAdapter implements RunnerAdapter {
  readonly name = 'claude' as const
  readonly capabilities: AdapterCapabilities = CLAUDE_CAPABILITIES

  private readonly inner = new ClaudeRunner()
  private boundCtx: RunnerSessionContext | null = null

  /**
   * Legacy bridge for P1.1; CodexAdapter will use the standard `run()`
   * path in P3. Drives `ClaudeRunner.execute()` / `.resume()` against
   * the runner's channel + ctx (the adapter doesn't synthesise those —
   * `main.ts` constructs them and hands them in here).
   */
  async runLegacy(
    channel: BufferedChannel,
    cmd: ExecuteCommand | ResumeCommand,
    ctx: RunnerSessionContext,
  ): Promise<void> {
    this.boundCtx = ctx
    if (cmd.type === 'execute') {
      return this.inner.execute(channel, cmd, ctx)
    }
    return this.inner.resume(channel, cmd, ctx)
  }

  async run(_opts: AdapterStartOptions): Promise<void> {
    // P1.1: ClaudeAdapter ships on the legacy bridge. The opts-based
    // path is reserved for CodexAdapter (P3) and a future Claude
    // cleanup that folds the two.
    throw new Error(
      'ClaudeAdapter.run(opts) not implemented in P1.1 — use runLegacy(channel, cmd, ctx)',
    )
  }

  pushUserTurn(message: { role: 'user'; content: string | ContentBlock[] }): void {
    // Adapter is the SDK-coupling site. Mirrors what main.ts's
    // `handleIncomingCommand 'stream-input'` currently does for the
    // queue push (titler integration stays in main.ts — it's not an
    // SDK detail).
    const ctx = this.boundCtx
    if (!ctx) return
    if (ctx.userQueue) {
      const sdkMsg: SDKUserMsg = {
        type: 'user',
        message: { role: 'user', content: message.content },
        parent_tool_use_id: null,
      }
      ctx.userQueue.push(sdkMsg)
    } else {
      console.warn('[claude-adapter] pushUserTurn arrived before userQueue was ready — dropping')
    }
  }

  async interrupt(): Promise<void> {
    const ctx = this.boundCtx
    if (!ctx) return
    ctx.interrupted = true
    try {
      await ctx.query?.interrupt()
    } catch (err) {
      console.error(
        `[claude-adapter] interrupt error: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  async dispose(): Promise<void> {
    // ClaudeRunner.runSession's finally-block already handles its own
    // cleanup (kataWatcher.stop, userQueue.close, ctx pointer reset).
    // Idempotent no-op here for symmetry with future adapters.
    this.boundCtx = null
  }
}
