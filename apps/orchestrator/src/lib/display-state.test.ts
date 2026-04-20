import { describe, expect, it } from 'vitest'
import type { SessionState } from '~/lib/types'
import { deriveDisplayState } from './display-state'

function makeState(status: string): SessionState {
  return {
    status: status as SessionState['status'],
    session_id: null,
    project: 'proj',
    project_path: '/tmp/proj',
    model: null,
    prompt: '',
    userId: null,
    started_at: null,
    completed_at: null,
    num_turns: 0,
    total_cost_usd: null,
    duration_ms: null,
    gate: null,
    created_at: '2026-04-19T00:00:00Z',
    updated_at: '2026-04-19T00:00:00Z',
    result: null,
    error: null,
    summary: null,
    sdk_session_id: null,
  }
}

describe('deriveDisplayState', () => {
  it('returns unknown when state is null (regardless of wsReadyState)', () => {
    expect(deriveDisplayState(null, 1).status).toBe('unknown')
    expect(deriveDisplayState(null, 0).status).toBe('unknown')
    expect(deriveDisplayState(null, 3).status).toBe('unknown')
  })

  it('returns disconnected when wsReadyState !== 1 (CONNECTING)', () => {
    const result = deriveDisplayState(makeState('running'), 0)
    expect(result.status).toBe('disconnected')
    expect(result.label).toBe('Reconnecting…')
    expect(result.color).toBe('gray')
    expect(result.icon).toBe('wifi-off')
    expect(result.isInteractive).toBe(false)
  })

  it('returns disconnected when wsReadyState !== 1 (CLOSING)', () => {
    expect(deriveDisplayState(makeState('running'), 2).status).toBe('disconnected')
  })

  it('returns disconnected when wsReadyState !== 1 (CLOSED)', () => {
    expect(deriveDisplayState(makeState('running'), 3).status).toBe('disconnected')
  })

  it('maps SessionState.status="running" → running when ws is open', () => {
    const result = deriveDisplayState(makeState('running'), 1)
    expect(result.status).toBe('running')
    expect(result.label).toBe('Running')
    expect(result.color).toBe('green')
    expect(result.icon).toBe('spinner')
    expect(result.isInteractive).toBe(true)
  })

  it('maps SessionState.status="idle" → idle when ws is open', () => {
    const result = deriveDisplayState(makeState('idle'), 1)
    expect(result.status).toBe('idle')
    expect(result.label).toBe('Idle')
    expect(result.color).toBe('gray')
    expect(result.icon).toBe('circle')
    expect(result.isInteractive).toBe(true)
  })

  it('maps SessionState.status="waiting_gate" → waiting_gate when ws is open', () => {
    const result = deriveDisplayState(makeState('waiting_gate'), 1)
    expect(result.status).toBe('waiting_gate')
    expect(result.label).toBe('Needs Attention')
    expect(result.color).toBe('amber')
    expect(result.icon).toBe('alert')
    expect(result.isInteractive).toBe(true)
  })

  it('maps legacy waiting_input / waiting_permission → waiting_gate', () => {
    expect(deriveDisplayState(makeState('waiting_input'), 1).status).toBe('waiting_gate')
    expect(deriveDisplayState(makeState('waiting_permission'), 1).status).toBe('waiting_gate')
  })

  it('maps status="error" → error when ws is open', () => {
    const result = deriveDisplayState(makeState('error'), 1)
    expect(result.status).toBe('error')
    expect(result.label).toBe('Error')
    expect(result.color).toBe('red')
    expect(result.icon).toBe('x-circle')
    expect(result.isInteractive).toBe(false)
  })

  it('maps status="archived" → archived when ws is open', () => {
    const result = deriveDisplayState(makeState('archived'), 1)
    expect(result.status).toBe('archived')
    expect(result.label).toBe('Archived')
    expect(result.color).toBe('gray')
    expect(result.icon).toBe('archive')
    expect(result.isInteractive).toBe(false)
  })

  it('returns unknown for unexpected status values when ws is open', () => {
    const result = deriveDisplayState(makeState('nonsense'), 1)
    expect(result.status).toBe('unknown')
    expect(result.label).toBe('Unknown')
    expect(result.color).toBe('gray')
    expect(result.icon).toBe('circle')
    expect(result.isInteractive).toBe(false)
  })
})
