/**
 * GH#76 — useDerivedStatus unit tests.
 * @vitest-environment jsdom
 */
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('~/hooks/use-messages-collection', () => ({
  useMessagesCollection: vi.fn(),
}))

vi.mock('~/hooks/use-sessions-collection', () => ({
  useSession: vi.fn(),
}))

import { useMessagesCollection } from '~/hooks/use-messages-collection'
import { useSession } from '~/hooks/use-sessions-collection'
import { useDerivedStatus } from '../use-derived-status'

const mockUseMessagesCollection = vi.mocked(useMessagesCollection)
const mockUseSession = vi.mocked(useSession)

function setup(messages: Array<{ id: string; seq: number; parts: unknown[] }>) {
  mockUseMessagesCollection.mockReturnValue({
    messages,
    isLoading: false,
    isFetching: false,
  } as ReturnType<typeof useMessagesCollection>)
  // Default: session has messageSeq = -1 (stale), so derived status wins
  mockUseSession.mockReturnValue(undefined)
  return renderHook(() => useDerivedStatus('session-1'))
}

describe('useDerivedStatus', () => {
  it('returns undefined for an empty collection', () => {
    const { result } = setup([])
    expect(result.current).toBeUndefined()
  })

  it('returns idle when tail message has a result part', () => {
    const { result } = setup([
      { id: 'msg-1', seq: 1, parts: [{ type: 'text', state: 'complete' }] },
      { id: 'msg-2', seq: 2, parts: [{ type: 'result' }] },
    ])
    expect(result.current).toBe('idle')
  })

  it('returns waiting_gate when tail has a tool-permission part with approval-requested', () => {
    const { result } = setup([
      { id: 'msg-1', seq: 1, parts: [{ type: 'text', state: 'complete' }] },
      {
        id: 'msg-2',
        seq: 2,
        parts: [{ type: 'tool-permission', state: 'approval-requested', toolCallId: 'tc-1' }],
      },
    ])
    expect(result.current).toBe('waiting_gate')
  })

  it('returns running when tail has a text part with streaming state', () => {
    const { result } = setup([
      { id: 'msg-1', seq: 1, parts: [{ type: 'text', state: 'complete' }] },
      { id: 'msg-2', seq: 2, parts: [{ type: 'text', state: 'streaming' }] },
    ])
    expect(result.current).toBe('running')
  })

  it('returns running when tail has a reasoning part with streaming state (extended thinking)', () => {
    // During extended thinking the latest message only has reasoning@streaming
    // parts — no text@streaming. Without this rule the hook walks back to a
    // prior result and returns idle for the entire thinking phase.
    const { result } = setup([
      { id: 'msg-a0', seq: 1, parts: [{ type: 'result' }] },
      { id: 'msg-u1', seq: 2, parts: [{ type: 'text', text: 'go', state: 'complete' }] },
      { id: 'msg-a1', seq: 3, parts: [{ type: 'reasoning', state: 'streaming' }] },
    ])
    expect(result.current).toBe('running')
  })

  it('returns idle when a result part appears after a tool_result part (tail-first scan)', () => {
    const { result } = setup([
      { id: 'msg-1', seq: 1, parts: [{ type: 'tool_result' }] },
      { id: 'msg-2', seq: 2, parts: [{ type: 'result' }] },
    ])
    expect(result.current).toBe('idle')
  })

  it('returns waiting_gate for tool-ask_user (not just tool-permission)', () => {
    const { result } = setup([
      { id: 'msg-1', seq: 1, parts: [{ type: 'text', state: 'complete' }] },
      {
        id: 'msg-2',
        seq: 2,
        parts: [{ type: 'tool-ask_user', state: 'approval-requested', toolCallId: 'tc-2' }],
      },
    ])
    expect(result.current).toBe('waiting_gate')
  })

  // Regression: SDK-native AskUserQuestion gate shape is
  // `tool-AskUserQuestion + input-available` (not the legacy
  // `tool-ask_user + approval-requested` promotion). Before sharing
  // `isPendingGatePart` with `useDerivedGate`, the hand-rolled predicate
  // here missed the SDK-native shape, leaving status to fall through to
  // stale D1 `running` while the runner was actually parked on the gate.
  it('returns waiting_gate for SDK-native tool-AskUserQuestion + input-available', () => {
    const { result } = setup([
      { id: 'msg-1', seq: 1, parts: [{ type: 'text', state: 'complete' }] },
      {
        id: 'msg-2',
        seq: 2,
        parts: [{ type: 'tool-AskUserQuestion', state: 'input-available', toolCallId: 'tc-3' }],
      },
    ])
    expect(result.current).toBe('waiting_gate')
  })

  it('returns undefined for null sessionId', () => {
    mockUseMessagesCollection.mockReturnValue({
      messages: [],
      isLoading: false,
      isFetching: false,
    } as ReturnType<typeof useMessagesCollection>)
    mockUseSession.mockReturnValue(undefined)
    const { result } = renderHook(() => useDerivedStatus(null))
    expect(result.current).toBeUndefined()
  })

  it('returns running even when D1 messageSeq has caught up (live evidence wins)', () => {
    // Live-evidence signals (running, waiting_gate, pending) are direct
    // proof of current state and should NOT be suppressed by seq comparison.
    // This prevents the B1/B2 stale-status edge cases where D1 status
    // arrives (via UserSettingsDO) before the final message deltas land.
    mockUseMessagesCollection.mockReturnValue({
      messages: [
        { id: 'msg-1', seq: 1, parts: [{ type: 'text', state: 'complete' }] },
        { id: 'msg-2', seq: 2, parts: [{ type: 'text', state: 'streaming' }] },
      ],
      isLoading: false,
      isFetching: false,
    } as ReturnType<typeof useMessagesCollection>)
    mockUseSession.mockReturnValue({
      id: 'session-1',
      messageSeq: 2,
    } as ReturnType<typeof useSession>)
    const { result } = renderHook(() => useDerivedStatus('session-1'))
    expect(result.current).toBe('running')
  })

  it('returns undefined when D1 has caught up and derived is idle (tiebreaker for non-live signals)', () => {
    // For idle / undefined, the tiebreaker still applies: if D1 seq has
    // caught up, return undefined so callers fall through to session?.status.
    mockUseMessagesCollection.mockReturnValue({
      messages: [
        { id: 'msg-1', seq: 1, parts: [{ type: 'text', state: 'complete' }] },
        { id: 'msg-2', seq: 2, parts: [{ type: 'result' }] },
      ],
      isLoading: false,
      isFetching: false,
    } as ReturnType<typeof useMessagesCollection>)
    mockUseSession.mockReturnValue({
      id: 'session-1',
      messageSeq: 2,
    } as ReturnType<typeof useSession>)
    const { result } = renderHook(() => useDerivedStatus('session-1'))
    // D1 serverSeq (2) >= localMaxSeq (2) + derived is idle → undefined
    expect(result.current).toBeUndefined()
  })

  // ── Spec #80: awaiting-response → 'pending' status ─────────────────

  it("returns 'pending' when the tail user message has an awaiting_response@pending part", () => {
    const { result } = setup([
      {
        id: 'msg-1',
        seq: 1,
        parts: [
          { type: 'text', text: 'hello', state: 'complete' },
          {
            type: 'awaiting_response',
            state: 'pending',
            reason: 'first_token',
            startedTs: 1_000,
          },
        ],
      },
    ])
    expect(result.current).toBe('pending')
  })

  it("picks 'pending' over a streaming text part elsewhere in the tail message", () => {
    // Awaiting comes first in the parts array; the tail scan visits parts
    // in order and should short-circuit on 'pending' before reaching
    // 'streaming'.
    const { result } = setup([
      {
        id: 'msg-1',
        seq: 1,
        parts: [
          {
            type: 'awaiting_response',
            state: 'pending',
            reason: 'first_token',
            startedTs: 1_000,
          },
          { type: 'text', state: 'streaming' },
        ],
      },
    ])
    expect(result.current).toBe('pending')
  })

  it("transitions 'pending' → 'running' once the awaiting part is cleared and streaming begins", () => {
    // Phase 1: user row + awaiting tail → 'pending'.
    mockUseMessagesCollection.mockReturnValue({
      messages: [
        {
          id: 'msg-u1',
          seq: 1,
          parts: [
            { type: 'text', text: 'hi', state: 'complete' },
            {
              type: 'awaiting_response',
              state: 'pending',
              reason: 'first_token',
              startedTs: 1_000,
            },
          ],
        },
      ],
      isLoading: false,
      isFetching: false,
    } as ReturnType<typeof useMessagesCollection>)
    mockUseSession.mockReturnValue(undefined)
    const { result, rerender } = renderHook(() => useDerivedStatus('session-1'))
    expect(result.current).toBe('pending')

    // Phase 2: awaiting part removed (DO clear), assistant streaming tail
    // appended. `seq` on the new assistant row advances past the user
    // row's seq so localMaxSeq stays ahead of the (undefined) server seq.
    mockUseMessagesCollection.mockReturnValue({
      messages: [
        {
          id: 'msg-u1',
          seq: 1,
          parts: [{ type: 'text', text: 'hi', state: 'complete' }],
        },
        {
          id: 'msg-a1',
          seq: 2,
          parts: [{ type: 'text', state: 'streaming' }],
        },
      ],
      isLoading: false,
      isFetching: false,
    } as ReturnType<typeof useMessagesCollection>)
    rerender()
    expect(result.current).toBe('running')
  })

  // ── Mid-turn tool-execution wedge (regression guard for ad5f548 / 362ca50) ──

  it("returns 'running' when the tail assistant has a tool part in input-available", () => {
    // Canonical mid-turn shape: assistant emitted text + tool_use, SDK is
    // blocked on tool_result. text@done, tool@input-available — without the
    // input-available rule this falls through to the prior `result` → idle,
    // and the StatusBar / sidebar / stop button all desync from reality.
    const { result } = setup([
      { id: 'msg-a0', seq: 1, parts: [{ type: 'result' }] },
      { id: 'msg-u1', seq: 2, parts: [{ type: 'text', text: 'go', state: 'complete' }] },
      {
        id: 'msg-a1',
        seq: 3,
        parts: [
          { type: 'text', text: 'running it now', state: 'done' },
          {
            type: 'tool-bash',
            state: 'input-available',
            toolCallId: 'tc-1',
            toolName: 'bash',
            input: { cmd: 'ls' },
          },
        ],
      },
    ])
    expect(result.current).toBe('running')
  })

  it("returns 'running' for a lone tool part in input-available (no streaming text)", () => {
    // Tool-only assistant turn, no text block at all — common for SDK
    // tool-only emissions.
    const { result } = setup([
      { id: 'msg-a0', seq: 1, parts: [{ type: 'result' }] },
      { id: 'msg-u1', seq: 2, parts: [{ type: 'text', text: 'go', state: 'complete' }] },
      {
        id: 'msg-a1',
        seq: 3,
        parts: [
          {
            type: 'tool-edit',
            state: 'input-available',
            toolCallId: 'tc-2',
            toolName: 'edit',
            input: {},
          },
        ],
      },
    ])
    expect(result.current).toBe('running')
  })

  // Regression: stalled-runner sessions whose runner died mid-tool leave
  // dangling `tool-* + input-available` parts that `finalizeStreamingParts`
  // never sweeps (the DO only finalizes `currentTurnMessageId`'s message at
  // result-time, and a runner that died never sent a result). The post-
  // 2a0da13 generic tool-input-available rule then mis-classifies the
  // session as 'running' forever. With the latched-tool tiebreaker, when
  // D1's `messageSeq` has caught up to `localMaxSeq`, we defer to
  // `session?.status` (D1 truth) instead of trusting the latched marker.
  it('defers to D1 when tail has dangling tool input-available and serverSeq caught up', () => {
    mockUseMessagesCollection.mockReturnValue({
      messages: [
        { id: 'msg-9', seq: 9, parts: [{ type: 'result' }] },
        {
          id: 'msg-10',
          seq: 10,
          parts: [
            { type: 'text', text: 'running it', state: 'done' },
            {
              type: 'tool-Bash',
              state: 'input-available',
              toolCallId: 'tc-1',
              toolName: 'Bash',
              input: { cmd: 'ls' },
            },
            {
              type: 'tool-Read',
              state: 'input-available',
              toolCallId: 'tc-2',
              toolName: 'Read',
              input: { path: '/x' },
            },
          ],
        },
      ],
      isLoading: false,
      isFetching: false,
    } as ReturnType<typeof useMessagesCollection>)
    mockUseSession.mockReturnValue({
      id: 'session-1',
      messageSeq: 10,
      status: 'idle',
    } as ReturnType<typeof useSession>)
    const { result } = renderHook(() => useDerivedStatus('session-1'))
    // serverSeq (10) >= localMaxSeq (10) + derived is latched-tool-running →
    // undefined so caller falls through to session.status === 'idle'.
    expect(result.current).toBeUndefined()
  })

  it("still returns 'running' for tool input-available when D1 is behind (mid-turn)", () => {
    // Sanity: the latched-tool tiebreaker must NOT fire mid-turn. When the
    // user just sent a turn and D1 hasn't caught up yet, a tool-input-
    // available part really does indicate active execution.
    mockUseMessagesCollection.mockReturnValue({
      messages: [
        { id: 'msg-1', seq: 1, parts: [{ type: 'result' }] },
        { id: 'msg-2', seq: 2, parts: [{ type: 'text', text: 'go', state: 'complete' }] },
        {
          id: 'msg-3',
          seq: 3,
          parts: [
            {
              type: 'tool-bash',
              state: 'input-available',
              toolCallId: 'tc-1',
              toolName: 'bash',
              input: { cmd: 'ls' },
            },
          ],
        },
      ],
      isLoading: false,
      isFetching: false,
    } as ReturnType<typeof useMessagesCollection>)
    mockUseSession.mockReturnValue({
      id: 'session-1',
      messageSeq: 1, // D1 still behind — only result row mirrored
      status: 'running',
    } as ReturnType<typeof useSession>)
    const { result } = renderHook(() => useDerivedStatus('session-1'))
    // serverSeq (1) < localMaxSeq (3) → tiebreaker doesn't fire → 'running'.
    expect(result.current).toBe('running')
  })

  it("falls back to 'running' when awaiting is cleared but streaming is the only in-flight marker", () => {
    // Direct sanity: awaiting absent, streaming text present → 'running'.
    const { result } = setup([
      {
        id: 'msg-u1',
        seq: 1,
        parts: [{ type: 'text', text: 'hi', state: 'complete' }],
      },
      {
        id: 'msg-a1',
        seq: 2,
        parts: [{ type: 'text', state: 'streaming' }],
      },
    ])
    expect(result.current).toBe('running')
  })
})
