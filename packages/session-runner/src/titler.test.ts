import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildTranscript,
  estimateTokens,
  type SendFn,
  SessionTitler,
  type SessionTitlerOptions,
  type TranscriptMessage,
} from './titler.js'
import type { RunnerSessionContext } from './types.js'

// ── Mock Anthropic SDK ───────────────────────────────────────────────

let mockCreateCalls: Array<{ model: string; system: string; messages: unknown[] }> = []
let mockCreateResponse: { content: Array<{ type: string; text: string }> } = {
  content: [{ type: 'text', text: '{"title":"Fix Auth Bug","confidence":0.92}' }],
}

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class {
      messages = {
        create: async (opts: { model: string; system: string; messages: unknown[] }) => {
          mockCreateCalls.push(opts)
          return mockCreateResponse
        },
      }
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
      sdk_session_id: null,
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
  mockCreateCalls = []
  mockCreateResponse = {
    content: [{ type: 'text', text: '{"title":"Fix Auth Bug","confidence":0.92}' }],
  }
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

describe('SessionTitler', () => {
  describe('maybeInitialTitle', () => {
    it('does NOT fire when transcript < 1500 tokens', async () => {
      const { titler, sendCalls } = makeTitler()
      await titler.maybeInitialTitle(makeMessages(2, 100))
      expect(sendCalls).toHaveLength(0)
      expect(mockCreateCalls).toHaveLength(0)
    })

    it('fires and emits title_update when transcript >= 1500 tokens', async () => {
      const { titler, sendCalls } = makeTitler()
      // 4 messages * 2000 chars each ≈ 2000+ tokens
      await titler.maybeInitialTitle(makeMessages(4, 2000))
      expect(mockCreateCalls).toHaveLength(1)
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
      expect(mockCreateCalls).toHaveLength(1)
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
      mockCreateResponse = {
        content: [
          {
            type: 'text',
            text: '{"did_pivot":true,"confidence":0.85,"proposed_new_title":"Debug Push"}',
          },
        ],
      }

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

      mockCreateResponse = {
        content: [
          {
            type: 'text',
            text: '{"did_pivot":false,"confidence":0.3,"proposed_new_title":null}',
          },
        ],
      }

      await titler.maybePivotRetitle(makeMessages(5, 2000), 'follow up')
      expect(sendCalls).toHaveLength(1) // only initial
    })

    it('does NOT retitle when confidence < 0.7', async () => {
      const { titler, sendCalls } = makeTitler()
      await titler.maybeInitialTitle(makeMessages(4, 2000))

      mockCreateResponse = {
        content: [
          {
            type: 'text',
            text: '{"did_pivot":true,"confidence":0.5,"proposed_new_title":"Maybe New"}',
          },
        ],
      }

      await titler.maybePivotRetitle(makeMessages(5, 2000), 'sort of new topic')
      expect(sendCalls).toHaveLength(1) // only initial
    })

    it('respects 5-min cooldown — second call within 5 min is a no-op', async () => {
      const { titler, sendCalls } = makeTitler()
      await titler.maybeInitialTitle(makeMessages(4, 2000))

      mockCreateResponse = {
        content: [
          {
            type: 'text',
            text: '{"did_pivot":true,"confidence":0.9,"proposed_new_title":"Topic B"}',
          },
        ],
      }

      await titler.maybePivotRetitle(makeMessages(5, 2000), 'pivot 1')
      expect(sendCalls).toHaveLength(2) // initial + first pivot

      // Second pivot within cooldown — should be a no-op
      await titler.maybePivotRetitle(makeMessages(6, 2000), 'pivot 2')
      expect(sendCalls).toHaveLength(2) // unchanged
      expect(mockCreateCalls).toHaveLength(2) // initial + first pivot, no third call
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
      expect(mockCreateCalls).toHaveLength(1)
    })
  })

  describe('enabled=false', () => {
    it('all methods are no-ops', async () => {
      const { titler, sendCalls } = makeTitler({ enabled: false })
      await titler.maybeInitialTitle(makeMessages(4, 2000))
      await titler.maybePivotRetitle(makeMessages(5, 2000), 'new topic')
      expect(sendCalls).toHaveLength(0)
      expect(mockCreateCalls).toHaveLength(0)
    })
  })

  describe('graceful degradation', () => {
    it('logs warning and does not emit on Haiku failure', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      mockCreateResponse = { content: [{ type: 'text', text: 'not valid json!!!' }] }

      const { titler, sendCalls } = makeTitler()
      await titler.maybeInitialTitle(makeMessages(4, 2000))
      expect(sendCalls).toHaveLength(0)
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[titler:'), expect.anything())
    })

    it('clears titleInFlight on failure so future calls work', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      // First call: fail
      mockCreateResponse = { content: [{ type: 'text', text: 'bad json' }] }
      const { titler, sendCalls } = makeTitler()
      await titler.maybeInitialTitle(makeMessages(4, 2000))
      expect(sendCalls).toHaveLength(0)

      // Second call: succeed
      mockCreateResponse = {
        content: [{ type: 'text', text: '{"title":"Recovered","confidence":0.8}' }],
      }
      await titler.maybeInitialTitle(makeMessages(5, 2000))
      expect(sendCalls).toHaveLength(1)
      expect(sendCalls[0]).toMatchObject({ title: 'Recovered' })
    })
  })

  describe('code fence stripping', () => {
    it('handles response wrapped in code fences', async () => {
      mockCreateResponse = {
        content: [
          {
            type: 'text',
            text: '```json\n{"title":"Fenced Title","confidence":0.88}\n```',
          },
        ],
      }
      const { titler, sendCalls } = makeTitler()
      await titler.maybeInitialTitle(makeMessages(4, 2000))
      expect(sendCalls).toHaveLength(1)
      expect(sendCalls[0]).toMatchObject({ title: 'Fenced Title' })
    })
  })
})
