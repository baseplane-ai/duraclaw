import type { AdapterCapabilities, ContentBlock, WireContextUsage } from '@duraclaw/shared-types'
import { PushPullQueue } from '../push-pull-queue.js'
import type { AdapterStartOptions, RunnerAdapter } from './types.js'

/**
 * Default context window when a model is not found in `gemini_models`.
 * GH#110 / spec 110 B6.
 */
const DEFAULT_CONTEXT_WINDOW = 1_000_000

// ── Gemini JSONL event shapes (from live fixtures, GH#110 P1 spike) ────

interface GeminiInitEvent {
  type: 'init'
  session_id: string
  model: string
  timestamp?: string
}

interface GeminiMessageEvent {
  type: 'message'
  role: 'user' | 'assistant'
  content: string
  delta?: boolean
  timestamp?: string
}

interface GeminiToolUseEvent {
  type: 'tool_use'
  tool_name: string
  tool_id: string
  parameters: Record<string, unknown>
  timestamp?: string
}

interface GeminiToolResultEvent {
  type: 'tool_result'
  tool_id: string
  status: string
  timestamp?: string
}

interface GeminiResultEvent {
  type: 'result'
  status: string
  stats: {
    total_tokens: number
    input_tokens: number
    output_tokens: number
    cached?: number
    duration_ms?: number
    tool_calls?: number
    models?: Record<string, unknown>
  }
  timestamp?: string
}

type GeminiEvent =
  | GeminiInitEvent
  | GeminiMessageEvent
  | GeminiToolUseEvent
  | GeminiToolResultEvent
  | GeminiResultEvent
  | { type: string; [k: string]: unknown }

// ── JSONL stream parser ────────────────────────────────────────────────

async function* parseJsonlStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<GeminiEvent> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          yield JSON.parse(trimmed) as GeminiEvent
        } catch {
          // Non-JSON line (stderr leak, debug noise) — skip
        }
      }
    }
    // Flush remaining buffer
    const trimmed = buffer.trim()
    if (trimmed) {
      try {
        yield JSON.parse(trimmed) as GeminiEvent
      } catch {
        // Non-JSON — skip
      }
    }
  } finally {
    reader.releaseLock()
  }
}

// ── GeminiCliAdapter ─────────────────────────────────────────────────

/**
 * GeminiCliAdapter — wraps Google's `gemini` CLI as a subprocess behind
 * the runner's `RunnerAdapter` interface. GH#110 / spec 110 P3.
 *
 * Architecture: respawn-per-turn. Each `pushUserTurn` triggers a fresh
 * `gemini --resume <session_id>` subprocess. The runner process stays alive
 * across turns; subprocess cold-start (~4s) is the per-turn cost.
 *
 * Signal handling: SIGINT → 2s → SIGKILL (google-gemini/gemini-cli#15873
 * fixed in v0.32.0; gateway preflight enforces >= 0.32.0).
 */
export class GeminiCliAdapter implements RunnerAdapter {
  readonly name = 'gemini' as const

  private opts: AdapterStartOptions | null = null
  private geminiSessionId: string | null = null
  private currentModel = 'auto-gemini-3'
  private unknownModelWarned = false
  private turnQueue: PushPullQueue<string> = new PushPullQueue<string>()
  private currentChild: ReturnType<typeof Bun.spawn> | null = null
  private sigkillTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  get capabilities(): AdapterCapabilities {
    const models = this.opts?.geminiModels?.map((m) => m.name) ?? []
    return {
      supportsRewind: false,
      supportsThinkingDeltas: false,
      supportsPermissionGate: false,
      supportsSubagents: false,
      supportsPermissionMode: false,
      supportsSetModel: false,
      supportsContextUsage: true,
      supportsInterrupt: true,
      supportsCleanAbort: false,
      emitsUsdCost: false,
      availableProviders: [{ provider: 'google', models }],
    }
  }

  async run(opts: AdapterStartOptions): Promise<void> {
    this.opts = opts
    this.currentModel = opts.model ?? 'auto-gemini-3'

    if (opts.resumeSessionId) {
      this.geminiSessionId = opts.resumeSessionId
    }

    if (opts.signal.aborted) return

    const firstPrompt = coercePrompt(opts.prompt)

    // Emit session_state_changed{running} before first turn
    opts.onEvent({
      type: 'session_state_changed',
      session_id: opts.sessionId,
      state: 'running',
      ts: Date.now(),
    })

    // Drive the first turn
    const firstTurnOk = await this.spawnTurn(firstPrompt, true)
    if (!firstTurnOk || opts.signal.aborted) return

    // Multi-turn loop: await pushed user turns until abort or dispose
    const onAbort = () => this.turnQueue.close()
    if (opts.signal.aborted) {
      this.turnQueue.close()
    } else {
      opts.signal.addEventListener('abort', onAbort, { once: true })
    }

    try {
      for await (const next of this.turnQueue) {
        if (opts.signal.aborted || this.disposed) break
        opts.onEvent({
          type: 'session_state_changed',
          session_id: opts.sessionId,
          state: 'running',
          ts: Date.now(),
        })
        await this.spawnTurn(next, false)
        if (opts.signal.aborted || this.disposed) break
      }
    } finally {
      opts.signal.removeEventListener('abort', onAbort)
    }
  }

  /**
   * Spawn a single `gemini` turn subprocess, parse its JSONL output,
   * and emit GatewayEvents. Returns true on success, false on fatal error.
   */
  private async spawnTurn(prompt: string, isFirstTurn: boolean): Promise<boolean> {
    if (!this.opts) return false

    const args: string[] = ['-y', '--skip-trust', '--output-format', 'stream-json']
    if (this.geminiSessionId) {
      args.push('--resume', this.geminiSessionId)
    }
    if (this.currentModel && this.currentModel !== 'auto-gemini-3') {
      args.push('--model', this.currentModel)
    }
    args.push('--prompt', prompt)

    const child = Bun.spawn(['gemini', ...args], {
      cwd: this.opts.project,
      env: { ...this.opts.env },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    this.currentChild = child

    // Accumulated turn state
    const accumulatedText: string[] = []
    const accumulatedContent: unknown[] = []
    // Map tool_id -> tool_name for tool_result lookup
    const pendingTools = new Map<string, string>()
    let sessionInitEmitted = !isFirstTurn

    try {
      for await (const event of parseJsonlStream(child.stdout)) {
        if (this.disposed || this.opts.signal.aborted) break

        switch (event.type) {
          case 'init': {
            const ev = event as GeminiInitEvent
            if (isFirstTurn && !this.geminiSessionId) {
              this.geminiSessionId = ev.session_id
            }
            if (!sessionInitEmitted) {
              this.opts.onEvent({
                type: 'session.init',
                session_id: this.opts.sessionId,
                runner_session_id: ev.session_id,
                project: this.opts.project,
                model: ev.model ?? this.currentModel,
                tools: [],
                capabilities: this.capabilities,
              })
              sessionInitEmitted = true
            }
            break
          }

          case 'message': {
            const ev = event as GeminiMessageEvent
            if (ev.role === 'user') {
              // Input echo — filter silently
              break
            }
            if (ev.role === 'assistant' && ev.delta === true) {
              const text = ev.content ?? ''
              accumulatedText.push(text)
              // Also push a text content block for the final assistant event
              accumulatedContent.push({ type: 'text', text })
              this.opts.onEvent({
                type: 'partial_assistant',
                session_id: this.opts.sessionId,
                content: [{ type: 'text', id: crypto.randomUUID(), delta: text }],
              })
            }
            break
          }

          case 'tool_use': {
            const ev = event as GeminiToolUseEvent
            // Buffer tool_name for later tool_result lookup
            pendingTools.set(ev.tool_id, ev.tool_name)
            // Add as content block in final assistant event
            accumulatedContent.push({
              type: 'tool_use',
              id: ev.tool_id,
              tool_name: ev.tool_name,
              input: ev.parameters,
            })
            break
          }

          case 'tool_result': {
            const ev = event as GeminiToolResultEvent
            const toolName = pendingTools.get(ev.tool_id) ?? 'unknown'
            this.opts.onEvent({
              type: 'tool_result',
              session_id: this.opts.sessionId,
              uuid: crypto.randomUUID(),
              content: [
                {
                  type: 'tool_call',
                  toolCallId: ev.tool_id,
                  toolName,
                  status: ev.status,
                },
              ],
            })
            break
          }

          case 'result': {
            const ev = event as GeminiResultEvent
            // Emit final assistant message with all accumulated content
            if (accumulatedContent.length > 0) {
              this.opts.onEvent({
                type: 'assistant',
                session_id: this.opts.sessionId,
                uuid: crypto.randomUUID(),
                content: accumulatedContent,
              })
            }
            // Synthesize context_usage from stats
            const contextUsage = this.buildContextUsage(ev.stats)
            this.opts.onEvent({
              type: 'result',
              session_id: this.opts.sessionId,
              subtype: ev.status === 'success' ? 'success' : 'error',
              duration_ms: ev.stats?.duration_ms ?? 0,
              total_cost_usd: null,
              result: accumulatedText.join('') || null,
              num_turns: 1,
              is_error: ev.status !== 'success',
              sdk_summary: null,
              context_usage: contextUsage,
            })
            this.opts.onEvent({
              type: 'session_state_changed',
              session_id: this.opts.sessionId,
              state: 'idle',
              ts: Date.now(),
            })
            break
          }

          default: {
            // Unknown event type — log and skip (defensive for schema drift)
            console.debug(`[GeminiCliAdapter] Unknown JSONL event type: ${event.type} — skipping`)
            break
          }
        }
      }
    } catch (err) {
      if (!this.disposed && !this.opts.signal.aborted) {
        const msg = err instanceof Error ? err.message : String(err)
        this.opts.onEvent({
          type: 'error',
          session_id: this.opts.sessionId,
          error: `GeminiCliAdapter stream error: ${msg}`,
        })
      }
    }

    const exitCode = await child.exited
    // Child exited cleanly — cancel any pending SIGKILL escalation.
    if (this.sigkillTimer !== null) {
      clearTimeout(this.sigkillTimer)
      this.sigkillTimer = null
    }
    this.currentChild = null

    if (exitCode !== 0 && !this.disposed && !this.opts.signal.aborted) {
      // Drain stderr for error context (capped at 4KB). Safe in Bun: stderr is
      // a separate ReadableStream from stdout and is buffered independently —
      // the parseJsonlStream loop above only consumes child.stdout.
      let stderrText = ''
      try {
        const buf = await new Response(child.stderr).text()
        stderrText = buf.slice(0, 4096)
      } catch {
        /* ignore */
      }

      const isResumeFail =
        this.geminiSessionId &&
        (stderrText.includes('not found') || stderrText.includes('no session'))

      if (isResumeFail) {
        // Resume failure — signal the DO to use forkWithHistory fallback
        this.opts.onEvent({
          type: 'error',
          session_id: this.opts.sessionId,
          error: `Gemini session not found — falling back to history replay [gemini_resume_failed]: ${stderrText.slice(0, 500)}`,
        })
        return false
      }

      this.opts.onEvent({
        type: 'error',
        session_id: this.opts.sessionId,
        error: `gemini exited with code ${exitCode}: ${stderrText.slice(0, 500)}`,
      })
      this.opts.onEvent({
        type: 'session_state_changed',
        session_id: this.opts.sessionId,
        state: 'idle',
        ts: Date.now(),
      })
      return false
    }

    return true
  }

  private buildContextUsage(stats: GeminiResultEvent['stats'] | undefined): WireContextUsage {
    const totalTokens = stats?.total_tokens ?? 0
    const inputTokens = stats?.input_tokens ?? 0
    const outputTokens = stats?.output_tokens ?? 0
    const model = this.currentModel

    const entry = this.opts?.geminiModels?.find((m) => m.name === model)
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
          error: `Unknown model context window for '${model}' — using 1M default`,
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

  pushUserTurn(message: { role: 'user'; content: string | ContentBlock[] }): void {
    const text = coercePrompt(message.content)
    try {
      this.turnQueue.push(text)
    } catch {
      // Queue closed — dispose was called or run loop exited
    }
  }

  async interrupt(): Promise<void> {
    if (!this.currentChild) return
    const child = this.currentChild
    try {
      child.kill('SIGINT')
    } catch {
      /* ignore */
    }
    // 2s SIGKILL fallback (spec B7)
    this.sigkillTimer = setTimeout(() => {
      this.sigkillTimer = null
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    }, 2000)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    try {
      this.currentChild?.kill('SIGKILL')
    } catch {
      /* ignore */
    }
    if (this.sigkillTimer !== null) {
      clearTimeout(this.sigkillTimer)
      this.sigkillTimer = null
    }
    try {
      this.turnQueue.close()
    } catch {
      /* ignore */
    }
    this.currentChild = null
    this.opts = null
  }
}

function coercePrompt(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text') parts.push(block.text)
  }
  return parts.join('\n')
}

// Registry alias — the registry imports `GeminiAdapter` by convention.
export { GeminiCliAdapter as GeminiAdapter }
