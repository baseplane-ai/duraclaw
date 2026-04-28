import type {
  AdapterCapabilities,
  AgentName,
  ContentBlock,
  GatewayEvent,
} from '@duraclaw/shared-types'

/**
 * Options handed to a `RunnerAdapter.run()` call. Captures everything
 * the adapter needs to drive a single session lifetime, decoupled from
 * the runner's process-level wiring (channel, ctx, dial-back client).
 *
 * GH#107 / spec 107-codex-runner-revival: this is the runner-internal
 * contract. Wire types still live in `@duraclaw/shared-types`; this
 * file defines the adapter-side surface that ClaudeAdapter (P1.1) and
 * CodexAdapter (P3) both implement.
 */
export interface AdapterStartOptions {
  sessionId: string
  project: string
  model?: string
  prompt: string | ContentBlock[]
  resumeSessionId?: string
  env: Readonly<Record<string, string>>
  signal: AbortSignal
  codexModels?: ReadonlyArray<{ name: string; context_window: number }>
  geminiModels?: ReadonlyArray<{ name: string; context_window: number }>
  onEvent: (event: GatewayEvent) => void
}

/**
 * Adapter contract — one implementation per backend SDK.
 *
 * Lifecycle: `run()` is called exactly once per runner process. The
 * adapter drives the session until natural completion or abort.
 * `pushUserTurn()` injects a follow-up turn while `run()` is in
 * progress. `interrupt()` and `dispose()` are best-effort and
 * idempotent.
 */
export interface RunnerAdapter {
  readonly name: AgentName
  readonly capabilities: AdapterCapabilities
  /** Drive the session until natural completion or abort. */
  run(opts: AdapterStartOptions): Promise<void>
  /** Inject a new user turn (stream-input command). */
  pushUserTurn(message: { role: 'user'; content: string | ContentBlock[] }): void
  /** Best-effort mid-turn interruption. */
  interrupt(): Promise<void>
  /** Release resources — kill child processes, close streams. Idempotent. */
  dispose(): Promise<void>
}
