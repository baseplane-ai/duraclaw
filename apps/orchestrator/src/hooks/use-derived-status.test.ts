/**
 * @vitest-environment jsdom
 */
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Shared messages-array that each test mutates before rendering. The hook
// reads this via the mocked `useMessagesCollection`.
let mockMessages: Array<Record<string, unknown>> = []

vi.mock('./use-messages-collection', () => ({
  useMessagesCollection: () => ({
    messages: mockMessages,
    isLoading: false,
    isFetching: false,
  }),
}))

import { useDerivedStatus } from './use-derived-status'

function makeMsg(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'msg',
    sessionId: 'test',
    role: 'assistant',
    parts: [{ type: 'text', text: 'hi', state: 'done' }],
    createdAt: '2026-04-20T00:00:00Z',
    ...overrides,
  }
}

describe('useDerivedStatus', () => {
  beforeEach(() => {
    mockMessages = []
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('derived-status-idle-empty: empty messages returns idle', () => {
    mockMessages = []
    const { result } = renderHook(() => useDerivedStatus('sess'))
    expect(result.current).toBe('idle')
  })

  it('derived-status-running-user-last: last row role=user returns running', () => {
    mockMessages = [
      makeMsg({
        id: 'u1',
        role: 'user',
        parts: [{ type: 'text', text: 'hello' }],
      }),
    ]
    const { result } = renderHook(() => useDerivedStatus('sess'))
    expect(result.current).toBe('running')
  })

  it('derived-status-running-streaming: last assistant part state=streaming returns running', () => {
    mockMessages = [
      makeMsg({
        id: 'a1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Hel', state: 'streaming' }],
      }),
    ]
    const { result } = renderHook(() => useDerivedStatus('sess'))
    expect(result.current).toBe('running')
  })

  it('derived-status-waiting-gate: any part state=approval-requested returns waiting_gate', () => {
    mockMessages = [
      makeMsg({
        id: 'a1',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Done' },
          {
            type: 'tool-permission',
            toolCallId: 'call-1',
            state: 'approval-requested',
          },
        ],
      }),
    ]
    const { result } = renderHook(() => useDerivedStatus('sess'))
    expect(result.current).toBe('waiting_gate')
  })

  it('derived-status-idle-complete: last assistant part state=done returns idle', () => {
    mockMessages = [
      makeMsg({
        id: 'u1',
        role: 'user',
        parts: [{ type: 'text', text: 'hi' }],
      }),
      makeMsg({
        id: 'a1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Hello back', state: 'done' }],
      }),
    ]
    const { result } = renderHook(() => useDerivedStatus('sess'))
    expect(result.current).toBe('idle')
  })

  it('gate check wins over streaming-last-part', () => {
    mockMessages = [
      makeMsg({
        id: 'a1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-ask_user',
            toolCallId: 'q-1',
            state: 'approval-requested',
          },
          { type: 'text', text: 'streaming more', state: 'streaming' },
        ],
      }),
    ]
    const { result } = renderHook(() => useDerivedStatus('sess'))
    expect(result.current).toBe('waiting_gate')
  })

  it('returns idle when last assistant part has output-available state', () => {
    mockMessages = [
      makeMsg({
        id: 'a1',
        role: 'assistant',
        parts: [{ type: 'tool-bash', toolCallId: 't-1', state: 'output-available' }],
      }),
    ]
    const { result } = renderHook(() => useDerivedStatus('sess'))
    expect(result.current).toBe('idle')
  })

  // The canonical mid-turn wedge: the assistant has emitted a tool_use and
  // the SDK is waiting for tool_result from the runner. Pre-fix this read
  // as 'idle' (only the tail part was inspected and `input-available !==
  // 'streaming'`), so the stop button disappeared while the tool was still
  // running. Every tool_use with a slow-to-return result exposed this.
  it('derived-status-running-tool-pending: assistant ending on a tool-* part in input-available returns running', () => {
    mockMessages = [
      makeMsg({
        id: 'a1',
        role: 'assistant',
        parts: [
          { type: 'text', text: "I'll run that", state: 'done' },
          { type: 'tool-bash', toolCallId: 't-1', state: 'input-available' },
        ],
      }),
    ]
    const { result } = renderHook(() => useDerivedStatus('sess'))
    expect(result.current).toBe('running')
  })

  it('derived-status-running-mid-parts-streaming: streaming part in the middle (not tail) still returns running', () => {
    mockMessages = [
      makeMsg({
        id: 'a1',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'partial', state: 'streaming' },
          { type: 'tool-bash', toolCallId: 't-1', state: 'output-available' },
        ],
      }),
    ]
    const { result } = renderHook(() => useDerivedStatus('sess'))
    expect(result.current).toBe('running')
  })
})
