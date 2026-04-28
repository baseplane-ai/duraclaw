/**
 * GH#86: Haiku-based session titler.
 *
 * Lives in the session-runner, not the DO — the runner owns the transcript.
 *
 * Two call sites:
 *  1. `maybeInitialTitle(messages)` — fire-and-forget after `type=result`
 *     (turn-complete) when the transcript exceeds INITIAL_TITLE_TOKEN_THRESHOLD
 *     (200 tokens ≈ 800 chars).
 *  2. `maybePivotRetitle(messages, newUserMessage)` — fire-and-forget on
 *     each incoming `stream-input`, in parallel with the main `query()`.
 *
 * Auth: rides the same `@anthropic-ai/claude-agent-sdk` that the main
 * session uses, so it picks up the user's Claude Code OAuth subscription
 * automatically — no `ANTHROPIC_API_KEY` env var needed. Each title call
 * spins up its own one-shot `query()` with `model = TITLER_MODEL`,
 * `allowedTools: []`, and `maxTurns: 1` so the model emits a single
 * JSON-only assistant turn and then halts.
 *
 * All title calls are single-flighted and non-blocking. Failures are
 * logged and swallowed — the session continues untitled.
 */
import type { BufferedChannel } from '@duraclaw/shared-transport'
import type { RunnerSessionContext } from './types.js'

// ── Constants ────────────────────────────────────────────────────────

/** Model used for title generation. Named constant so rotations are a one-line diff. */
const TITLER_MODEL = 'claude-haiku-4-5-20251014'

/**
 * Minimum estimated tokens before the initial title fires.
 *
 * Originally 1500 (≈6000 chars) so titles only landed on long sessions —
 * but that meant the typical "hi, can you fix X" first turn never got
 * a title at all, and the sidebar fallback chain (title || summary ||
 * prompt || id) collapsed to the session-id prefix indefinitely. 200
 * tokens (≈800 chars) clears even short conversations after the first
 * round-trip while still skipping the truly empty "hello" → "hi" pings.
 */
const INITIAL_TITLE_TOKEN_THRESHOLD = 200

/** Maximum turns to include in the transcript sent to Haiku. */
const MAX_TRANSCRIPT_TURNS = 8

/** Maximum estimated tokens for the transcript payload. */
const MAX_TRANSCRIPT_TOKENS = 5000

/** Cooldown between pivot retitles (ms). */
const RETITLE_COOLDOWN_MS = 300_000 // 5 minutes

// ── Prompts ──────────────────────────────────────────────────────────

const INITIAL_TITLE_SYSTEM = `You name work sessions. Emit ONLY a JSON object — no prose, no code fences.

Style: 2-3 words, sentence case, no articles. Examples:
- "Verify 2128"
- "Researching Scroll"
- "Fix Auth Bug"
- "Debug Memory Leak"
- "Refactor Gateway"

Prefer the user's most recent intent over older context.

Output: {"title": "...", "confidence": 0.0-1.0}`

const PIVOT_GATE_SYSTEM = `Detect whether the user pivoted to a new task. A pivot is a change in primary goal, technical domain, or problem statement. Elaboration and follow-ups are NOT pivots. If a pivot occurred, propose a new 2-3 word title in the same style as above.

Respond ONLY as JSON — no prose, no code fences.

Output: {"did_pivot": true/false, "confidence": 0.0-1.0, "proposed_new_title": "..." or null}`

// ── Helpers ──────────────────────────────────────────────────────────

/** Rough token estimate — 4 chars per token, rounded up. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** Simplified message shape for transcript building. */
export interface TranscriptMessage {
  role: 'user' | 'assistant' | string
  content: string | Array<{ type: string; text?: string; name?: string; [k: string]: unknown }>
}

/**
 * Build a condensed transcript from the last N turns.
 *
 * Strips tool-call bodies (keeps tool names), head-truncates to stay
 * under MAX_TRANSCRIPT_TOKENS. The result is a single string passed as
 * the user prompt to Haiku.
 */
export function buildTranscript(messages: TranscriptMessage[]): string {
  // Take the last MAX_TRANSCRIPT_TURNS messages
  const recent = messages.slice(-MAX_TRANSCRIPT_TURNS)

  const lines: string[] = []
  let totalTokens = 0

  for (const msg of recent) {
    let text: string
    if (typeof msg.content === 'string') {
      text = msg.content
    } else if (Array.isArray(msg.content)) {
      // Extract text parts, summarise tool use blocks
      const parts: string[] = []
      for (const part of msg.content) {
        if (part.type === 'text' && part.text) {
          parts.push(part.text)
        } else if (part.type === 'tool_use' && part.name) {
          parts.push(`[tool: ${part.name}]`)
        } else if (part.type === 'tool_result' && part.text) {
          parts.push(`[tool result: ${part.text.slice(0, 100)}]`)
        }
      }
      text = parts.join('\n')
    } else {
      continue
    }

    const role = msg.role === 'user' ? 'User' : 'Assistant'
    const line = `${role}: ${text}`
    const lineTokens = estimateTokens(line)

    // Head-truncate: if adding this line would exceed the budget, trim it
    if (totalTokens + lineTokens > MAX_TRANSCRIPT_TOKENS) {
      const remaining = MAX_TRANSCRIPT_TOKENS - totalTokens
      if (remaining > 50) {
        // Include a truncated version
        const chars = remaining * 4
        lines.push(`${line.slice(0, chars)}…`)
      }
      break
    }

    lines.push(line)
    totalTokens += lineTokens
  }

  return lines.join('\n\n')
}

/** Strip optional code fences from Haiku's response. */
function stripCodeFences(text: string): string {
  return text
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim()
}

/**
 * Extract a JSON object from Haiku's response.
 *
 * Haiku's instruction-following on "respond ONLY as JSON" is unreliable —
 * observed in prod returning "There is no good title yet because the
 * conversation just started. {...}" before the JSON. Prior simple
 * `JSON.parse(stripCodeFences(text))` choked on the leading prose with
 * `SyntaxError: Unexpected identifier "There"`.
 *
 * Strategy:
 *   1. Try the strict path first: stripCodeFences then JSON.parse. Success
 *      on well-formed responses (most of the time).
 *   2. Fallback: scan the text for the first `{` and last `}` and try
 *      JSON.parse on that slice. Catches prose-wrapped JSON without
 *      tolerating malformed JSON itself.
 *
 * Throws on both-failed so the caller's catch fires emitTitleError as
 * before.
 */
export function extractJsonObject<T = unknown>(text: string): T {
  const stripped = stripCodeFences(text)
  try {
    return JSON.parse(stripped) as T
  } catch (strictErr) {
    const firstBrace = stripped.indexOf('{')
    const lastBrace = stripped.lastIndexOf('}')
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      const slice = stripped.slice(firstBrace, lastBrace + 1)
      try {
        return JSON.parse(slice) as T
      } catch {
        // Both attempts failed — re-throw the strict error for the
        // clearer message ("Unexpected identifier" beats "Unexpected
        // end of JSON" in error reports).
        throw strictErr
      }
    }
    throw strictErr
  }
}

// ── Types ────────────────────────────────────────────────────────────

interface InitialTitleResult {
  title: string
  confidence: number
}

interface PivotGateResult {
  did_pivot: boolean
  confidence: number
  proposed_new_title: string | null
}

/**
 * send() helper signature — matches the module-level `send` in
 * `claude-runner.ts`. Injected to avoid circular imports.
 */
export type SendFn = (
  ch: BufferedChannel,
  event: Record<string, unknown>,
  ctx: RunnerSessionContext,
) => void

// ── SessionTitler ────────────────────────────────────────────────────

export interface SessionTitlerOptions {
  channel: BufferedChannel
  ctx: RunnerSessionContext
  sendFn: SendFn
  enabled: boolean
  /**
   * Optional explicit path to the Claude Code executable. Plumbed
   * through from the main runner's `resolveGlibcClaudeBinary()` so the
   * titler's one-shot `query()` doesn't trip the SDK's musl-first
   * lookup on glibc-only hosts (same fix as `claude-runner.ts`'s main
   * `query()` call). Undefined → SDK falls back to its default lookup.
   */
  pathToClaudeCodeExecutable?: string
}

export class SessionTitler {
  private channel: BufferedChannel
  private ctx: RunnerSessionContext
  private sendFn: SendFn
  private enabled: boolean
  private pathToClaudeCodeExecutable: string | undefined

  /** True after the initial title has been generated. */
  private hasInitialTitle = false
  /** Timestamp of the last successful retitle. */
  private lastRetitleTs = 0
  /** Current title source — tracks user-set freeze without D1. */
  private titleSource: 'user' | 'haiku' | null = null
  /** Single-flight guard. */
  private titleInFlight: Promise<void> | null = null

  constructor(opts: SessionTitlerOptions) {
    this.channel = opts.channel
    this.ctx = opts.ctx
    this.sendFn = opts.sendFn
    this.enabled = opts.enabled
    this.pathToClaudeCodeExecutable = opts.pathToClaudeCodeExecutable
  }

  /**
   * One-shot Agent SDK call. Spins up `query()` with a single
   * synthetic user message, JSON-only system prompt, no tools, and
   * `maxTurns: 1` so the model emits one assistant turn and stops.
   *
   * Returns the concatenated text of the assistant's content blocks.
   * Throws on SDK error (`error_*` result subtype, missing assistant
   * message, or import failure) — callers catch and log.
   */
  private async oneShotQuery(systemPrompt: string, userPrompt: string): Promise<string> {
    const { query } = await import('@anthropic-ai/claude-agent-sdk')

    // Single-message async iterable — yields once, then completes so
    // the SDK's prompt-stream sees end-of-input after the first turn.
    async function* oneshotPrompt() {
      yield {
        type: 'user' as const,
        message: { role: 'user' as const, content: userPrompt },
        parent_tool_use_id: null,
        session_id: '',
      }
    }

    const q = query({
      prompt: oneshotPrompt(),
      options: {
        model: TITLER_MODEL,
        systemPrompt,
        allowedTools: [],
        maxTurns: 1,
        // No tools means nothing dangerous can run; pick the strict
        // default so an unexpected tool attempt is denied rather than
        // prompted (titler is fire-and-forget, no UI to prompt).
        permissionMode: 'default',
        ...(this.pathToClaudeCodeExecutable
          ? { pathToClaudeCodeExecutable: this.pathToClaudeCodeExecutable }
          : {}),
      },
    })

    let assistantText = ''
    for await (const msg of q) {
      // Only the assistant text blocks matter for title parsing.
      if (msg.type === 'assistant') {
        const content = (msg as unknown as { message: { content: unknown } }).message.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (
              block &&
              typeof block === 'object' &&
              (block as { type?: string }).type === 'text' &&
              typeof (block as { text?: unknown }).text === 'string'
            ) {
              assistantText += (block as { text: string }).text
            }
          }
        }
      } else if (msg.type === 'result') {
        // SDKResultMessage — done. `subtype` indicates success vs error.
        const subtype = (msg as unknown as { subtype?: string }).subtype
        if (subtype && subtype !== 'success') {
          throw new Error(`titler one-shot query result subtype=${subtype}`)
        }
        break
      }
    }

    if (!assistantText) {
      throw new Error('titler one-shot query produced no assistant text')
    }
    return assistantText
  }

  /**
   * Called after each `type=result` event (turn-complete).
   * Fires the initial title when the transcript is long enough.
   */
  async maybeInitialTitle(messages: TranscriptMessage[]): Promise<void> {
    if (!this.enabled || this.hasInitialTitle) return

    const transcript = buildTranscript(messages)
    if (estimateTokens(transcript) < INITIAL_TITLE_TOKEN_THRESHOLD) return

    if (this.titleInFlight) return
    this.titleInFlight = this.doInitialTitle(transcript).finally(() => {
      this.titleInFlight = null
    })
    return this.titleInFlight
  }

  /**
   * Called on each incoming `stream-input` command (new user message).
   * Fires a pivot-gate check if conditions are met.
   */
  async maybePivotRetitle(_messages: TranscriptMessage[], newUserMessage: string): Promise<void> {
    if (!this.enabled) return
    if (!this.hasInitialTitle) return
    if (this.titleSource === 'user') return
    if (Date.now() - this.lastRetitleTs < RETITLE_COOLDOWN_MS) return

    if (this.titleInFlight) return
    this.titleInFlight = this.doPivotRetitle(newUserMessage).finally(() => {
      this.titleInFlight = null
    })
    return this.titleInFlight
  }

  /**
   * Called when the DO notifies us that the user manually set a title.
   * Prevents future Haiku retitles.
   */
  setUserTitle(): void {
    this.titleSource = 'user'
  }

  // ── Private ──────────────────────────────────────────────────────

  private async doInitialTitle(transcript: string): Promise<void> {
    let text: string
    try {
      text = await this.oneShotQuery(INITIAL_TITLE_SYSTEM, transcript)
    } catch (err) {
      this.emitTitleError('initial', err)
      console.warn(`[titler:${this.ctx.sessionId}] initial title query failed:`, err)
      return
    }
    try {
      const parsed = extractJsonObject<InitialTitleResult>(text)

      if (!parsed.title || typeof parsed.title !== 'string') {
        this.emitTitleError('initial', 'missing or invalid title field', text.slice(0, 200))
        console.warn(`[titler:${this.ctx.sessionId}] initial title: missing or invalid title field`)
        return
      }

      this.hasInitialTitle = true
      this.titleSource = 'haiku'
      this.currentTitleValue = parsed.title

      this.sendFn(
        this.channel,
        {
          type: 'title_update',
          session_id: this.ctx.sessionId,
          title: parsed.title,
          confidence: parsed.confidence ?? 0.5,
          did_pivot: false,
          turn_stamp: this.ctx.meta.turn_count,
        },
        this.ctx,
      )

      console.log(
        `[titler:${this.ctx.sessionId}] initial title: "${parsed.title}" (confidence: ${parsed.confidence})`,
      )
    } catch (err) {
      this.emitTitleError('initial', err)
      console.warn(`[titler:${this.ctx.sessionId}] initial title failed:`, err)
    }
  }

  private async doPivotRetitle(newUserMessage: string): Promise<void> {
    try {
      // Build the pivot prompt — intentionally minimal (current title +
      // new user message), not the full transcript. The actual current
      // title is tracked via currentTitleValue (set on each successful emit).
      const pivotPrompt = `Current session title: "${this.getCurrentTitle()}"\n\nNew user message:\n${newUserMessage}`

      const text = await this.oneShotQuery(PIVOT_GATE_SYSTEM, pivotPrompt)
      const parsed = extractJsonObject<PivotGateResult>(text)

      if (!parsed.did_pivot || (parsed.confidence ?? 0) < 0.7) {
        return
      }

      if (!parsed.proposed_new_title || typeof parsed.proposed_new_title !== 'string') {
        console.warn(`[titler:${this.ctx.sessionId}] pivot detected but no proposed_new_title`)
        return
      }

      this.lastRetitleTs = Date.now()
      this.currentTitleValue = parsed.proposed_new_title

      this.sendFn(
        this.channel,
        {
          type: 'title_update',
          session_id: this.ctx.sessionId,
          title: parsed.proposed_new_title,
          confidence: parsed.confidence,
          did_pivot: true,
          turn_stamp: this.ctx.meta.turn_count,
        },
        this.ctx,
      )

      console.log(
        `[titler:${this.ctx.sessionId}] pivot retitle: "${parsed.proposed_new_title}" (confidence: ${parsed.confidence})`,
      )
    } catch (err) {
      this.emitTitleError('pivot', err)
      console.warn(`[titler:${this.ctx.sessionId}] pivot retitle failed:`, err)
    }
  }

  /** In-memory cache of the current title for pivot prompts. */
  private currentTitleValue: string | null = null

  private getCurrentTitle(): string {
    return this.currentTitleValue ?? 'Untitled Session'
  }

  /**
   * Emit a `title_error` GatewayEvent so titler failures land in the
   * DO's per-session `event_log` (queryable via `getEventLog()` RPC)
   * instead of only in the runner's stdout file on the VPS. Best-effort:
   * if the channel itself is gone, swallow — the runner-side console.warn
   * still records the failure.
   */
  private emitTitleError(phase: 'initial' | 'pivot', err: unknown, detail?: string): void {
    try {
      const errMsg = err instanceof Error ? err.message : String(err)
      this.sendFn(
        this.channel,
        {
          type: 'title_error',
          session_id: this.ctx.sessionId,
          phase,
          error: errMsg,
          ...(detail ? { detail } : {}),
        },
        this.ctx,
      )
    } catch {
      // Channel send failed (e.g. closed). Runner-side log already records it.
    }
  }
}
