import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildTranscript,
  estimateTokens,
  extractJsonObject,
  type SendFn,
  SessionTitler,
  type SessionTitlerOptions,
  type TranscriptMessage,
} from './titler.js'
import type { RunnerSessionContext } from './types.js'

// ── Mock Claude Agent SDK ────────────────────────────────────────────
//
// Titler swapped from the plain `@anthropic-ai/sdk` to the Agent SDK's
// `query()` so it auths via Claude Code's OAuth subscription (no
// ANTHROPIC_API_KEY needed). Tests mock `query()` to return an async
// iterable yielding one assistant message + one result, matching the
// shape the titler's `oneShotQuery` consumer expects.

interface MockQueryCall {
  systemPrompt: string | string[] | { type: string }
  model?: string
  userText: string
  allowedTools: string[] | undefined
  maxTurns: number | undefined
}

let mockQueryCalls: MockQueryCall[] = []
let mockAssistantText = '{"title":"Fix Auth Bug","confidence":0.92}'
/** When set, the next query() rejects with this error instead of yielding. */
let mockQueryError: Error | null = null

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  return {
    query: ({
      prompt,
      options,
    }: {
      prompt: AsyncIterable<{ message: { content: string } }>
      options: {
        model?: string
        systemPrompt?: string | string[] | { type: string }
        allowedTools?: string[]
        maxTurns?: number
      }
    }) => {
      // Drain the prompt iterable so we see what the titler sent. Caller
      // closure into both prompt + options means we capture the user
      // text alongside the model/system options for assertions.
      const errorOnIter = mockQueryError
      mockQueryError = null
      const userTextPromise: Promise<string> = (async () => {
        for await (const m of prompt) {
          return typeof m.message.content === 'string' ? m.message.content : ''
        }
        return ''
      })()

      const text = mockAssistantText
      return (async function* () {
        const userText = await userTextPromise
        mockQueryCalls.push({
          systemPrompt: options.systemPrompt ?? '',
          model: options.model,
          userText,
          allowedTools: options.allowedTools,
          maxTurns: options.maxTurns,
        })
        if (errorOnIter) throw errorOnIter
        yield {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text }] },
        }
        yield { type: 'result', subtype: 'success' }
      })()
    },
  }
})

// ── Helpers ──────────────────────────────────────────────────────────

function makeSendFn(): { fn: SendFn; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = []
  const fn: SendFn = (_ch, event, _ctx) => {
    calls.push(event)
  }
  return { fn, calls }
}

function makeCtx(overrides?: Partial<RunnerSessionContext['meta']>): RunnerSessionContext {
  return {
    sessionId: 'test-session-123',
    abortController: new AbortController(),
    interrupted: false,
    pendingAnswer: null,
    pendingPermission: null,
    messageQueue: null,
    query: null,
    commandQueue: [],
    nextSeq: 0,
    meta: {
      runner_session_id: null,
      last_activity_ts: 0,
      last_event_seq: 0,
      cost: { input_tokens: 0, output_tokens: 0, usd: 0 },
      model: null,
      turn_count: 3,
      state: 'running',
      ...overrides,
    },
  }
}

function makeTitler(opts?: Partial<SessionTitlerOptions>): {
  titler: SessionTitler
  sendCalls: Array<Record<string, unknown>>
  ctx: RunnerSessionContext
} {
  const ctx = makeCtx()
  const { fn, calls } = makeSendFn()
  const titler = new SessionTitler({
    channel: {} as never,
    ctx,
    sendFn: fn,
    enabled: true,
    ...opts,
  })
  return { titler, sendCalls: calls, ctx }
}

function makeMessages(count: number, charsEach = 600): TranscriptMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `Message ${i}: ${'x'.repeat(charsEach)}`,
  }))
}

// ── Tests ────────────────────────────────────────────────────────────

beforeEach(() => {
  mockQueryCalls = []
  mockAssistantText = '{"title":"Fix Auth Bug","confidence":0.92}'
  mockQueryError = null
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('estimateTokens', () => {
  it('returns ceil(length / 4)', () => {
    expect(estimateTokens('hello')).toBe(2)
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('a')).toBe(1)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
  })
})

describe('buildTranscript', () => {
  it('returns only the last 8 turns from a longer list', () => {
    const messages = makeMessages(12, 100)
    const transcript = buildTranscript(messages)
    // Should contain messages 4-11 (indices) but not 0-3
    expect(transcript).toContain('Message 4')
    expect(transcript).toContain('Message 11')
    expect(transcript).not.toContain('Message 3:')
  })

  it('respects the ~5000 token budget', () => {
    const messages = makeMessages(8, 3000)
    const transcript = buildTranscript(messages)
    const tokens = estimateTokens(transcript)
    expect(tokens).toBeLessThanOrEqual(5050) // small overshoot from truncation
  })

  it('handles string content', () => {
    const messages: TranscriptMessage[] = [
      { role: 'user', content: 'Hello world' },
      { role: 'assistant', content: 'Hi there' },
    ]
    const transcript = buildTranscript(messages)
    expect(transcript).toContain('User: Hello world')
    expect(transcript).toContain('Assistant: Hi there')
  })

  it('extracts text parts and summarises tool use', () => {
    const messages: TranscriptMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check that.' },
          { type: 'tool_use', name: 'read_file', input: { path: '/foo' } },
        ],
      },
    ]
    const transcript = buildTranscript(messages)
    expect(transcript).toContain('Let me check that.')
    expect(transcript).toContain('[tool: read_file]')
  })
})

describe('extractJsonObject', () => {
  // Pins the prose-wrapped fallback that prod evidence demanded.
  // Observed runner log: `JSON Parse error: Unexpected identifier "There"` —
  // Haiku emitted "There is no good title because the conversation just
  // started. {...JSON...}" instead of JSON-only. Plain JSON.parse choked
  // and emitTitleError fired on every result event for the whole session.
  it('parses well-formed JSON directly', () => {
    expect(extractJsonObject<{ title: string }>('{"title":"X"}')).toEqual({ title: 'X' })
  })

  it('strips code fences before parsing', () => {
    expect(extractJsonObject<{ title: string }>('```json\n{"title":"Y"}\n```')).toEqual({
      title: 'Y',
    })
  })

  it('extracts the JSON object when prose precedes it (Haiku prose-wrap regression)', () => {
    const text =
      'There is no clear title yet, but here it is: {"title":"Fix Auth","confidence":0.7}'
    expect(extractJsonObject<{ title: string; confidence: number }>(text)).toEqual({
      title: 'Fix Auth',
      confidence: 0.7,
    })
  })

  it('extracts the JSON object when prose follows it', () => {
    const text = '{"title":"Z","confidence":0.5} (best I can do given the short transcript)'
    expect(extractJsonObject<{ title: string; confidence: number }>(text)).toEqual({
      title: 'Z',
      confidence: 0.5,
    })
  })

  it('throws on text that contains no JSON object at all', () => {
    expect(() => extractJsonObject('There is nothing parseable here.')).toThrow()
  })

  it('throws when the slice between first/last brace is itself malformed', () => {
    expect(() => extractJsonObject('{ this is not json }')).toThrow()
  })
})

describe('SessionTitler', () => {
  describe('maybeInitialTitle', () => {
    it('does NOT fire when transcript is empty (truly-empty turn guard)', async () => {
      // Threshold (10 tokens, ~40 chars) skips only literally-empty
      // turns. An empty messages list produces an empty transcript →
      // 0 tokens → no-op.
      const { titler, sendCalls } = makeTitler()
      await titler.maybeInitialTitle([])
      expect(sendCalls).toHaveLength(0)
      expect(mockQueryCalls).toHaveLength(0)
    })

    it('fires for short prose-only sessions (≈230 chars)', async () => {
      // makeMessages(2,100) → ≈230 chars → ~58 tokens. Previously
      // dropped by the 200-token gate; now clears the lowered floor.
      // Real-world example: a "fix typo" session with two short messages.
      const { titler, sendCalls } = makeTitler()
      await titler.maybeInitialTitle(makeMessages(2, 100))
      expect(mockQueryCalls).toHaveLength(1)
      expect(sendCalls).toHaveLength(1)
      expect(sendCalls[0]).toMatchObject({ type: 'title_update' })
    })

    it('fires for tool-heavy assistant turns (regression — root cause for inconsistent titler)', async () => {
      // Reproduces the exact bug pattern reported in production:
      // session-do/sess-055f9217-... showed the raw first-message text
      // as the displayed "title." The user's prompt is short, the
      // assistant's reply is dominated by tool calls (Read/Edit/Grep)
      // which buildTranscript compacts to `[tool: NAME]` markers
      // (~12 chars each). buildTranscript output ≈80-100 chars → 25
      // tokens, which the old 200-token gate dropped → titler never
      // fired → fallback chain (title || summary || prompt) collapsed
      // to the raw prompt.
      const messages: TranscriptMessage[] = [
        { role: 'user', content: 'Fix the auth bug in middleware.ts' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: "I'll look at this." },
            { type: 'tool_use', name: 'Read', input: { path: 'middleware.ts' } },
            { type: 'tool_use', name: 'Grep', input: { pattern: 'auth' } },
            { type: 'tool_use', name: 'Edit', input: { path: 'middleware.ts' } },
            { type: 'text', text: 'Done.' },
          ],
        },
      ]
      const { titler, sendCalls } = makeTitler()
      await titler.maybeInitialTitle(messages)
      expect(mockQueryCalls).toHaveLength(1)
      expect(sendCalls).toHaveLength(1)
      expect(sendCalls[0]).toMatchObject({
        type: 'title_update',
        session_id: 'test-session-123',
        title: 'Fix Auth Bug',
      })
    })

    it('fires and emits title_update when transcript is large', async () => {
      const { titler, sendCalls } = makeTitler()
      // 4 messages * 2000 chars each ≈ 2000+ tokens
      await titler.maybeInitialTitle(makeMessages(4, 2000))
      expect(mockQueryCalls).toHaveLength(1)
      expect(sendCalls).toHaveLength(1)
      expect(sendCalls[0]).toMatchObject({
        type: 'title_update',
        session_id: 'test-session-123',
        title: 'Fix Auth Bug',
        confidence: 0.92,
        did_pivot: false,
      })
    })

    it('does not fire twice (hasInitialTitle guard)', async () => {
      const { titler } = makeTitler()
      const msgs = makeMessages(4, 2000)
      await titler.maybeInitialTitle(msgs)
      await titler.maybeInitialTitle(msgs)
      expect(mockQueryCalls).toHaveLength(1)
    })
  })

  describe('maybePivotRetitle', () => {
    it('does not fire before initial title exists', async () => {
      const { titler, sendCalls } = makeTitler()
      await titler.maybePivotRetitle(makeMessages(4, 2000), 'new topic')
      expect(sendCalls).toHaveLength(0)
    })

    it('emits title_update only when did_pivot=true AND confidence >= 0.7', async () => {
      const { titler, sendCalls } = makeTitler()
      // First: get initial title
      await titler.maybeInitialTitle(makeMessages(4, 2000))
      expect(sendCalls).toHaveLength(1)

      // Set pivot response
      mockAssistantText = '{"did_pivot":true,"confidence":0.85,"proposed_new_title":"Debug Push"}'

      await titler.maybePivotRetitle(makeMessages(5, 2000), "Let's debug push notifications")
      expect(sendCalls).toHaveLength(2)
      expect(sendCalls[1]).toMatchObject({
        type: 'title_update',
        title: 'Debug Push',
        did_pivot: true,
        confidence: 0.85,
      })
    })

    it('does NOT retitle when did_pivot=false', async () => {
      const { titler, sendCalls } = makeTitler()
      await titler.maybeInitialTitle(makeMessages(4, 2000))

      mockAssistantText = '{"did_pivot":false,"confidence":0.3,"proposed_new_title":null}'

      await titler.maybePivotRetitle(makeMessages(5, 2000), 'follow up')
      expect(sendCalls).toHaveLength(1) // only initial
    })

    it('does NOT retitle when confidence < 0.7', async () => {
      const { titler, sendCalls } = makeTitler()
      await titler.maybeInitialTitle(makeMessages(4, 2000))

      mockAssistantText = '{"did_pivot":true,"confidence":0.5,"proposed_new_title":"Maybe New"}'

      await titler.maybePivotRetitle(makeMessages(5, 2000), 'sort of new topic')
      expect(sendCalls).toHaveLength(1) // only initial
    })

    it('respects 5-min cooldown — second call within 5 min is a no-op', async () => {
      const { titler, sendCalls } = makeTitler()
      await titler.maybeInitialTitle(makeMessages(4, 2000))

      mockAssistantText = '{"did_pivot":true,"confidence":0.9,"proposed_new_title":"Topic B"}'

      await titler.maybePivotRetitle(makeMessages(5, 2000), 'pivot 1')
      expect(sendCalls).toHaveLength(2) // initial + first pivot

      // Second pivot within cooldown — should be a no-op
      await titler.maybePivotRetitle(makeMessages(6, 2000), 'pivot 2')
      expect(sendCalls).toHaveLength(2) // unchanged
      expect(mockQueryCalls).toHaveLength(2) // initial + first pivot, no third call
    })
  })

  describe('single-flight guard', () => {
    it('concurrent calls are deduplicated', async () => {
      const { titler } = makeTitler()
      const msgs = makeMessages(4, 2000)
      // Fire two calls concurrently
      const p1 = titler.maybeInitialTitle(msgs)
      const p2 = titler.maybeInitialTitle(msgs)
      await Promise.all([p1, p2])
      // Only one Haiku call should have been made
      expect(mockQueryCalls).toHaveLength(1)
    })
  })

  describe('enabled=false', () => {
    it('all methods are no-ops', async () => {
      const { titler, sendCalls } = makeTitler({ enabled: false })
      await titler.maybeInitialTitle(makeMessages(4, 2000))
      await titler.maybePivotRetitle(makeMessages(5, 2000), 'new topic')
      expect(sendCalls).toHaveLength(0)
      expect(mockQueryCalls).toHaveLength(0)
    })
  })

  describe('graceful degradation', () => {
    it('logs warning and emits title_error (not title_update) on Haiku failure', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      mockAssistantText = 'not valid json!!!'

      const { titler, sendCalls } = makeTitler()
      await titler.maybeInitialTitle(makeMessages(4, 2000))
      const updates = sendCalls.filter((c) => c.type === 'title_update')
      const errors = sendCalls.filter((c) => c.type === 'title_error')
      expect(updates).toHaveLength(0)
      expect(errors).toHaveLength(1)
      expect(errors[0]).toMatchObject({ phase: 'initial', type: 'title_error' })
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[titler:'), expect.anything())
    })

    it('clears titleInFlight on failure so future calls work', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      // First call: fail (emits title_error, no title_update)
      mockAssistantText = 'bad json'
      const { titler, sendCalls } = makeTitler()
      await titler.maybeInitialTitle(makeMessages(4, 2000))
      expect(sendCalls.filter((c) => c.type === 'title_update')).toHaveLength(0)

      // Second call: succeed (emits title_update)
      mockAssistantText = '{"title":"Recovered","confidence":0.8}'
      await titler.maybeInitialTitle(makeMessages(5, 2000))
      const updates = sendCalls.filter((c) => c.type === 'title_update')
      expect(updates).toHaveLength(1)
      expect(updates[0]).toMatchObject({ title: 'Recovered' })
    })
  })

  describe('Agent SDK one-shot shape', () => {
    // Pins the contract that earned us OAuth-based auth: titler routes
    // through `query()` with the title model, the title system prompt,
    // no tools, and a single-turn cap. Regression guard for anyone
    // tempted to "simplify" back to a plain SDK call (which would
    // re-introduce the ANTHROPIC_API_KEY dependency).
    it('calls query() with TITLER_MODEL, system prompt, no tools, maxTurns=1', async () => {
      const { titler } = makeTitler()
      await titler.maybeInitialTitle(makeMessages(4, 2000))

      expect(mockQueryCalls).toHaveLength(1)
      const call = mockQueryCalls[0]
      // Unsuffixed model name — the dated form (claude-haiku-4-5-20251014)
      // was rejected by the CLI ("model may not exist or you may not have
      // access to it") on subscription auth.
      expect(call.model).toBe('claude-haiku-4-5')
      expect(call.allowedTools).toEqual([])
      expect(call.maxTurns).toBe(1)
      expect(typeof call.systemPrompt).toBe('string')
      expect(call.systemPrompt as string).toContain('session-naming agent')
      // The transcript landed as the user message — confirms we sent
      // it as a synthetic prompt rather than the SDK's default
      // working-context boot prompt.
      expect(call.userText).toContain('Message ')
    })

    // Pins the SDK isolation flag that prevents project hooks from
    // firing in the titler call. Without it, the kata
    // "MODE ENTRY IS MANDATORY" SessionStart hook in
    // .claude/settings.json injects a system reminder telling the
    // model to enter a mode before doing anything — Haiku obeys,
    // hits maxTurns:1 with prose like "I need to enter task mode
    // first to update the README" instead of emitting JSON.
    it('passes settingSources: [] to disable project hooks', () => {
      // Read the source under test directly to verify the option is
      // present at the call site. The mock doesn't currently capture
      // settingSources (only model/system/tools/turns/userText) so
      // this is the most stable assertion.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const titlerSrc = require('node:fs').readFileSync(
        require('node:path').join(__dirname, 'titler.ts'),
        'utf8',
      ) as string
      expect(titlerSrc).toMatch(/settingSources:\s*\[\]/)
    })

    it('uses the pivot system prompt for retitle calls', async () => {
      const { titler } = makeTitler()
      // Get past the initial-title gate first.
      await titler.maybeInitialTitle(makeMessages(4, 2000))
      mockQueryCalls = []

      mockAssistantText = '{"did_pivot":true,"confidence":0.85,"proposed_new_title":"New Topic"}'
      await titler.maybePivotRetitle(makeMessages(5, 2000), 'completely new topic')

      expect(mockQueryCalls).toHaveLength(1)
      expect(mockQueryCalls[0].systemPrompt as string).toContain('Detect whether the user pivoted')
    })

    it('logs warning and emits title_error on query() throw (e.g. missing OAuth)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      mockQueryError = new Error('not authenticated')

      const { titler, sendCalls } = makeTitler()
      await titler.maybeInitialTitle(makeMessages(4, 2000))

      const updates = sendCalls.filter((c) => c.type === 'title_update')
      const errors = sendCalls.filter((c) => c.type === 'title_error')
      expect(updates).toHaveLength(0)
      expect(errors).toHaveLength(1)
      expect(errors[0]).toMatchObject({
        type: 'title_error',
        phase: 'initial',
        error: expect.stringContaining('not authenticated'),
      })
      expect(warnSpy).toHaveBeenCalled()
    })
  })

  describe('code fence stripping', () => {
    it('handles response wrapped in code fences', async () => {
      mockAssistantText = '```json\n{"title":"Fenced Title","confidence":0.88}\n```'
      const { titler, sendCalls } = makeTitler()
      await titler.maybeInitialTitle(makeMessages(4, 2000))
      expect(sendCalls).toHaveLength(1)
      expect(sendCalls[0]).toMatchObject({ title: 'Fenced Title' })
    })
  })
})
