/**
 * GH#86: Haiku-based session titler.
 *
 * Lives in the session-runner, not the DO — the runner owns the transcript
 * and inherits ANTHROPIC_API_KEY from the gateway's buildCleanEnv().
 *
 * Two call sites:
 *  1. `maybeInitialTitle(messages)` — fire-and-forget after `type=result`
 *     (turn-complete) when the transcript exceeds ~1500 estimated tokens.
 *  2. `maybePivotRetitle(messages, newUserMessage)` — fire-and-forget on
 *     each incoming `stream-input`, in parallel with the main `query()`.
 *
 * All Haiku calls are single-flighted and non-blocking. Failures are
 * logged and swallowed — the session continues untitled.
 */
import type { BufferedChannel } from '@duraclaw/shared-transport'
import type { RunnerSessionContext } from './types.js'

// ── Constants ────────────────────────────────────────────────────────

/** Model used for title generation. Named constant so rotations are a one-line diff. */
const TITLER_MODEL = 'claude-haiku-4-5-20251014'

/** Minimum estimated tokens before the initial title fires. */
const INITIAL_TITLE_TOKEN_THRESHOLD = 1500

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
}

export class SessionTitler {
  private channel: BufferedChannel
  private ctx: RunnerSessionContext
  private sendFn: SendFn
  private enabled: boolean

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
    try {
      const Anthropic = (await import('@anthropic-ai/sdk')).default
      const client = new Anthropic()
      const response = await client.messages.create({
        model: TITLER_MODEL,
        max_tokens: 100,
        system: INITIAL_TITLE_SYSTEM,
        messages: [{ role: 'user', content: transcript }],
      })

      const text = response.content[0]?.type === 'text' ? response.content[0].text : ''
      const parsed = JSON.parse(stripCodeFences(text)) as InitialTitleResult

      if (!parsed.title || typeof parsed.title !== 'string') {
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
      console.warn(`[titler:${this.ctx.sessionId}] initial title failed:`, err)
    }
  }

  private async doPivotRetitle(newUserMessage: string): Promise<void> {
    try {
      // Build the pivot prompt — intentionally minimal (current title +
      // new user message), not the full transcript. The actual current
      // title is tracked via currentTitleValue (set on each successful emit).
      const pivotPrompt = `Current session title: "${this.getCurrentTitle()}"\n\nNew user message:\n${newUserMessage}`

      const Anthropic = (await import('@anthropic-ai/sdk')).default
      const client = new Anthropic()
      const response = await client.messages.create({
        model: TITLER_MODEL,
        max_tokens: 100,
        system: PIVOT_GATE_SYSTEM,
        messages: [{ role: 'user', content: pivotPrompt }],
      })

      const text = response.content[0]?.type === 'text' ? response.content[0].text : ''
      const parsed = JSON.parse(stripCodeFences(text)) as PivotGateResult

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
      console.warn(`[titler:${this.ctx.sessionId}] pivot retitle failed:`, err)
    }
  }

  /** In-memory cache of the current title for pivot prompts. */
  private currentTitleValue: string | null = null

  private getCurrentTitle(): string {
    return this.currentTitleValue ?? 'Untitled Session'
  }
}
