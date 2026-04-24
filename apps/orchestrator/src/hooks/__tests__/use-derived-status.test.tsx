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

  it('returns undefined when D1 messageSeq has caught up (tiebreaker)', () => {
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
    // D1 serverSeq (2) >= localMaxSeq (2) → fall through to undefined
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
