/**
 * @vitest-environment jsdom
 */
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let mockMessages: Array<Record<string, unknown>> = []

vi.mock('./use-messages-collection', () => ({
  useMessagesCollection: () => ({
    messages: mockMessages,
    isLoading: false,
    isFetching: false,
  }),
}))

import { useDerivedGate } from './use-derived-gate'

function makeMsg(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'msg',
    sessionId: 'test',
    role: 'assistant',
    parts: [],
    createdAt: '2026-04-20T00:00:00Z',
    ...overrides,
  }
}

describe('useDerivedGate', () => {
  beforeEach(() => {
    mockMessages = []
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('derived-gate-returns-permission: tool-permission in approval-requested returns payload', () => {
    mockMessages = [
      makeMsg({
        parts: [
          {
            type: 'tool-permission',
            toolCallId: 'call-perm-1',
            state: 'approval-requested',
          },
        ],
      }),
    ]
    const { result } = renderHook(() => useDerivedGate('sess'))
    expect(result.current).not.toBeNull()
    expect(result.current?.id).toBe('call-perm-1')
    expect(result.current?.type).toBe('permission_request')
    expect(result.current?.part).toBeDefined()
  })

  it('derived-gate-returns-ask-user: tool-ask_user in approval-requested returns payload', () => {
    mockMessages = [
      makeMsg({
        parts: [
          {
            type: 'tool-ask_user',
            toolCallId: 'q-1',
            state: 'approval-requested',
          },
        ],
      }),
    ]
    const { result } = renderHook(() => useDerivedGate('sess'))
    expect(result.current).not.toBeNull()
    expect(result.current?.id).toBe('q-1')
    expect(result.current?.type).toBe('ask_user')
  })

  it('derived-gate-null-after-resolution: state=approval-given returns null', () => {
    mockMessages = [
      makeMsg({
        parts: [
          {
            type: 'tool-permission',
            toolCallId: 'call-1',
            state: 'approval-given',
          },
        ],
      }),
    ]
    const { result } = renderHook(() => useDerivedGate('sess'))
    expect(result.current).toBeNull()
  })

  it('derived-gate-null-no-approval-pending: no gate parts returns null', () => {
    mockMessages = [
      makeMsg({
        role: 'assistant',
        parts: [{ type: 'text', text: 'hello', state: 'done' }],
      }),
      makeMsg({ role: 'user', parts: [{ type: 'text', text: 'hi' }] }),
    ]
    const { result } = renderHook(() => useDerivedGate('sess'))
    expect(result.current).toBeNull()
  })

  it('returns null for gate part missing toolCallId', () => {
    mockMessages = [
      makeMsg({
        parts: [{ type: 'tool-permission', state: 'approval-requested' }],
      }),
    ]
    const { result } = renderHook(() => useDerivedGate('sess'))
    expect(result.current).toBeNull()
  })

  it('returns null when messages empty', () => {
    mockMessages = []
    const { result } = renderHook(() => useDerivedGate('sess'))
    expect(result.current).toBeNull()
  })

  it('returns the first approval-requested gate when multiple exist', () => {
    mockMessages = [
      makeMsg({
        id: 'm1',
        parts: [
          {
            type: 'tool-permission',
            toolCallId: 'first',
            state: 'approval-requested',
          },
        ],
      }),
      makeMsg({
        id: 'm2',
        parts: [
          {
            type: 'tool-ask_user',
            toolCallId: 'second',
            state: 'approval-requested',
          },
        ],
      }),
    ]
    const { result } = renderHook(() => useDerivedGate('sess'))
    expect(result.current?.id).toBe('first')
  })
})
