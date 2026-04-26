import type { AdapterCapabilities, ContentBlock, WireContextUsage } from '@duraclaw/shared-types'
import {
  Codex,
  type ItemCompletedEvent,
  type ItemUpdatedEvent,
  type Thread,
  type Usage,
} from '@openai/codex-sdk'
import { PushPullQueue } from '../push-pull-queue.js'
import type { AdapterStartOptions, RunnerAdapter } from './types.js'

/**
 * Default context window when a model is not present in `codex_models`.
 * GH#107 / spec 107 B9.
 */
const DEFAULT_CONTEXT_WINDOW = 128_000

/** Inputs accepted by the Codex CLI for `runStreamed`. We always pass plain text. */
type CodexInput = string

/**
 * CodexAdapter — wraps `@openai/codex-sdk` behind the runner's
 * `RunnerAdapter` interface. GH#107 / spec 107 P3.
 *
 * Lifecycle differs from Claude:
 *   - Claude: lifetime `query()` driven by `PushPullQueue<SDKUserMsg>`.
 *   - Codex: per-turn `thread.runStreamed(prompt)` invocation. Multi-turn
 *     is implemented adapter-side by looping on a queue, awaiting each
 *     `pushUserTurn` and kicking off a fresh `runStreamed` against the
 *     same `Thread`.
 *
 * `Thread.id` from the SDK is `string | null` until the first turn
 * starts, so for fresh threads we capture the id from the `thread.started`
 * event and emit `session.init` only after it arrives. For resume we use
 * the caller-supplied `runner_session_id` directly.
 */
export class CodexAdapter implements RunnerAdapter {
  readonly name = 'codex' as const

  private codex: Codex | null = null
  private thread: Thread | null = null
  private opts: AdapterStartOptions | null = null
  private currentModel = 'gpt-5.1'
  private unknownModelWarned = false
  private turnQueue: PushPullQueue<string> = new PushPullQueue<string>()
  private currentTurnAbort: AbortController | null = null
  private disposed = false

  get capabilities(): AdapterCapabilities {
    const models = this.opts?.codexModels?.map((m) => m.name) ?? ['gpt-5.1', 'o4-mini']
    return {
      supportsRewind: false,
      supportsThinkingDeltas: false,
      supportsPermissionGate: false,
      supportsSubagents: false,
      supportsPermissionMode: false,
      supportsSetModel: false,
      supportsContextUsage: true,
      supportsInterrupt: false,
      supportsCleanAbort: false,
      emitsUsdCost: false,
      availableProviders: [{ provider: 'openai', models }],
    }
  }

  async run(opts: AdapterStartOptions): Promise<void> {
    this.opts = opts
    this.currentModel = opts.model ?? 'gpt-5.1'

    // The SDK accepts an `env` map; when present it does not inherit
    // process.env. We pass through whatever main.ts handed us — gateway
    // already built a clean env including OPENAI_API_KEY.
    this.codex = new Codex({ env: { ...opts.env } })

    let runnerSessionId: string | null = null
    if (opts.resumeSessionId) {
      try {
        // resumeThread is synchronous — it returns a Thread immediately.
        this.thread = this.codex.resumeThread(opts.resumeSessionId)
        runnerSessionId = opts.resumeSessionId
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // Signal failure so the DO orphan-recovery pathway can take over.
        // `SessionStateChangedEvent` has no 'error' variant on the wire
        // (spec text predates the canonical state union); the `error`
        // GatewayEvent is the authoritative failure signal and the DO
        // already drives `SessionMeta.status = 'error'` from it.
        opts.onEvent({
          type: 'error',
          session_id: opts.sessionId,
          error: `Codex thread file missing — falling back to history replay [codex_resume_failed]: ${msg}`,
        })
        return
      }
    } else {
      this.thread = this.codex.startThread({
        workingDirectory: opts.project,
        approvalPolicy: 'never',
        skipGitRepoCheck: true,
      })
    }

    // Honour an already-aborted signal before doing any work.
    if (opts.signal.aborted) return

    // Emit session.init for the resume case immediately. For fresh
    // threads we defer until `thread.started` arrives so the wire
    // `runner_session_id` is always populated from the authoritative
    // SDK source.
    if (runnerSessionId) {
      this.emitSessionInit(runnerSessionId)
    }

    const firstPrompt = coerceInput(opts.prompt)

    // Drive the first turn directly, then loop on the queue for follow-ups.
    try {
      await this.runTurn(firstPrompt, runnerSessionId === null)
    } catch (err) {
      if (this.disposed || opts.signal.aborted) return
      this.emitTurnError(err)
      return
    }

    // Multi-turn loop: await pushed user turns until the abort fires or
    // the queue is closed (dispose).
    const onAbort = () => this.turnQueue.close()
    if (opts.signal.aborted) {
      this.turnQueue.close()
    } else {
      opts.signal.addEventListener('abort', onAbort, { once: true })
    }

    try {
      for await (const next of this.turnQueue) {
        if (opts.signal.aborted) break
        try {
          await this.runTurn(next, false)
        } catch (err) {
          if (this.disposed || opts.signal.aborted) return
          this.emitTurnError(err)
          // Continue the loop — next pushUserTurn can still drive a new
          // turn; the SDK Thread is still usable unless dispose was called.
        }
      }
    } finally {
      opts.signal.removeEventListener('abort', onAbort)
    }
  }

  private emitSessionInit(runnerSessionId: string): void {
    if (!this.opts) return
    this.opts.onEvent({
      type: 'session.init',
      session_id: this.opts.sessionId,
      runner_session_id: runnerSessionId,
      project: this.opts.project,
      model: this.currentModel,
      tools: [],
      capabilities: this.capabilities,
    })
  }

  private async runTurn(input: CodexInput, captureThreadId: boolean): Promise<void> {
    if (!this.thread || !this.opts) return
    const { sessionId, onEvent, signal } = this.opts

    const turnAbort = new AbortController()
    this.currentTurnAbort = turnAbort
    const onOuterAbort = () => turnAbort.abort()
    signal.addEventListener('abort', onOuterAbort, { once: true })

    onEvent({
      type: 'session_state_changed',
      session_id: sessionId,
      state: 'running',
      ts: Date.now(),
    })

    const turnStartedAt = Date.now()
    let lastUsage: Usage | null = null
    let lastFinalText = ''
    let sessionInitEmittedThisTurn = false

    try {
      const { events } = await this.thread.runStreamed(input, { signal: turnAbort.signal })

      for await (const ev of events) {
        if (turnAbort.signal.aborted) break
        switch (ev.type) {
          case 'thread.started': {
            if (captureThreadId && !sessionInitEmittedThisTurn) {
              this.emitSessionInit(ev.thread_id)
              sessionInitEmittedThisTurn = true
            }
            break
          }
          case 'turn.started': {
            // No-op — we already emitted session_state_changed above.
            break
          }
          case 'item.started':
          case 'item.updated': {
            this.emitItemUpdate(ev as ItemUpdatedEvent)
            break
          }
          case 'item.completed': {
            const text = this.emitItemCompleted(ev as ItemCompletedEvent)
            if (text !== null) lastFinalText = text
            break
          }
          case 'turn.completed': {
            lastUsage = ev.usage
            break
          }
          case 'turn.failed': {
            onEvent({
              type: 'error',
              session_id: sessionId,
              error: `Codex turn failed: ${ev.error.message}`,
            })
            break
          }
          case 'error': {
            onEvent({
              type: 'error',
              session_id: sessionId,
              error: `Codex stream error: ${ev.message}`,
            })
            break
          }
          default: {
            const _exhaust: never = ev
            void _exhaust
          }
        }
      }
    } finally {
      signal.removeEventListener('abort', onOuterAbort)
      this.currentTurnAbort = null
    }

    if (turnAbort.signal.aborted && !signal.aborted) {
      // turn-only abort (interrupt) — surface idle and return without
      // a result frame. Outer signal abort takes the same exit path.
      onEvent({
        type: 'session_state_changed',
        session_id: sessionId,
        state: 'idle',
        ts: Date.now(),
      })
      return
    }

    // Synthesize the result frame from the last turn.completed.
    const contextUsage = this.buildContextUsage(lastUsage)
    onEvent({
      type: 'result',
      session_id: sessionId,
      subtype: 'success',
      duration_ms: Date.now() - turnStartedAt,
      total_cost_usd: null,
      result: lastFinalText || null,
      num_turns: 1,
      is_error: false,
      sdk_summary: null,
      context_usage: contextUsage,
    })

    onEvent({
      type: 'session_state_changed',
      session_id: sessionId,
      state: 'idle',
      ts: Date.now(),
    })
  }

  private emitItemUpdate(ev: ItemUpdatedEvent): void {
    if (!this.opts) return
    const item = ev.item
    if (item.type === 'agent_message') {
      this.opts.onEvent({
        type: 'partial_assistant',
        session_id: this.opts.sessionId,
        content: [{ type: 'text', id: item.id, delta: item.text }],
      })
    }
    // Other item types (command_execution, file_change, mcp_tool_call,
    // todo_list, web_search) only emit on completion — Codex's wire shape
    // typically carries the final payload at the `item.completed` boundary.
  }

  /**
   * Map a completed item to the appropriate gateway event. Returns the
   * agent_message text if the completed item was the final assistant
   * response (used to populate `result.result`).
   */
  private emitItemCompleted(ev: ItemCompletedEvent): string | null {
    if (!this.opts) return null
    const { sessionId, onEvent } = this.opts
    const item = ev.item

    switch (item.type) {
      case 'agent_message': {
        onEvent({
          type: 'assistant',
          session_id: sessionId,
          uuid: item.id,
          content: [{ type: 'text', text: item.text }],
        })
        return item.text
      }
      case 'reasoning': {
        // Codex SDK exposes a top-level reasoning summary item. We don't
        // have a thinking-delta capability; surface as a finalized
        // assistant block so it lands in the transcript.
        onEvent({
          type: 'assistant',
          session_id: sessionId,
          uuid: item.id,
          content: [{ type: 'thinking', thinking: item.text }],
        })
        return null
      }
      case 'command_execution': {
        onEvent({
          type: 'tool_result',
          session_id: sessionId,
          uuid: item.id,
          content: [
            {
              type: 'command_execution',
              command: item.command,
              output: item.aggregated_output,
              exit_code: item.exit_code ?? null,
              status: item.status,
            },
          ],
        })
        return null
      }
      case 'file_change': {
        onEvent({
          type: 'tool_result',
          session_id: sessionId,
          uuid: item.id,
          content: [{ type: 'file_change', changes: item.changes, status: item.status }],
        })
        return null
      }
      case 'mcp_tool_call': {
        onEvent({
          type: 'tool_result',
          session_id: sessionId,
          uuid: item.id,
          content: [
            {
              type: 'mcp_tool_call',
              server: item.server,
              tool: item.tool,
              arguments: item.arguments,
              result: item.result ?? null,
              error: item.error ?? null,
              status: item.status,
            },
          ],
        })
        return null
      }
      case 'web_search': {
        onEvent({
          type: 'tool_result',
          session_id: sessionId,
          uuid: item.id,
          content: [{ type: 'web_search', query: item.query }],
        })
        return null
      }
      case 'todo_list': {
        onEvent({
          type: 'tool_result',
          session_id: sessionId,
          uuid: item.id,
          content: [{ type: 'todo_list', items: item.items }],
        })
        return null
      }
      case 'error': {
        onEvent({
          type: 'error',
          session_id: sessionId,
          error: `Codex item error: ${item.message}`,
        })
        return null
      }
      default: {
        const _exhaust: never = item
        void _exhaust
        return null
      }
    }
  }

  private buildContextUsage(usage: Usage | null): WireContextUsage {
    // Per OpenAI usage convention: `cached_input_tokens` is a SUBSET of
    // `input_tokens` (tokens served from prompt cache), NOT additive.
    // The codex SDK's JSDoc on these fields is ambiguous; we follow the
    // documented OpenAI billing/usage semantics. `reasoning_output_tokens`
    // IS genuinely additional output (o-series reasoning tokens) so it
    // stays additive on the output / total side.
    const totalTokens =
      usage === null ? 0 : usage.input_tokens + usage.output_tokens + usage.reasoning_output_tokens
    const inputTokens = usage === null ? 0 : usage.input_tokens
    const outputTokens = usage === null ? 0 : usage.output_tokens + usage.reasoning_output_tokens

    const model = this.currentModel
    const entry = this.opts?.codexModels?.find((m) => m.name === model)
    let maxTokens: number
    if (entry) {
      maxTokens = entry.context_window
    } else {
      maxTokens = DEFAULT_CONTEXT_WINDOW
      if (!this.unknownModelWarned && this.opts) {
        this.unknownModelWarned = true
        this.opts.onEvent({
          type: 'error',
          session_id: this.opts.sessionId,
          error: `Unknown model context window for '${model}' — using 128k default`,
        })
      }
    }

    return {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: totalTokens,
      max_tokens: maxTokens,
      percentage: maxTokens > 0 ? totalTokens / maxTokens : 0,
      model,
    }
  }

  private emitTurnError(err: unknown): void {
    if (!this.opts) return
    const msg = err instanceof Error ? err.message : String(err)
    this.opts.onEvent({
      type: 'error',
      session_id: this.opts.sessionId,
      error: `Codex turn error: ${msg}`,
    })
    this.opts.onEvent({
      type: 'session_state_changed',
      session_id: this.opts.sessionId,
      state: 'idle',
      ts: Date.now(),
    })
  }

  pushUserTurn(message: { role: 'user'; content: string | ContentBlock[] }): void {
    const text = coerceInput(message.content)
    try {
      this.turnQueue.push(text)
    } catch {
      // Queue closed — dispose was called or the run loop exited.
    }
  }

  async interrupt(): Promise<void> {
    // Codex SDK exposes an AbortSignal on TurnOptions, so we can cleanly
    // cancel the in-flight `runStreamed` even though `supportsCleanAbort`
    // is declared false (the SDK ergonomics are only "best-effort" — see
    // openai/codex#5494). dispose() handles the no-signal-fallback case.
    this.currentTurnAbort?.abort()
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    try {
      this.currentTurnAbort?.abort()
    } catch {
      /* ignore */
    }
    try {
      this.turnQueue.close()
    } catch {
      /* ignore */
    }
    this.thread = null
    this.codex = null
    this.opts = null
  }
}

function coerceInput(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content
  // Flatten content blocks → plain text. Codex SDK accepts string or
  // structured `UserInput[]` (text/local_image); we collapse to text for
  // v1 since the runner's prompt path is text-dominant.
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text') parts.push(block.text)
    // Image blocks are dropped silently — Codex's `local_image` shape
    // requires a filesystem path, not base64; bridging that is a v2 task.
  }
  return parts.join('\n')
}
