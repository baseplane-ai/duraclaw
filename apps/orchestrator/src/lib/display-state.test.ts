import { describe, expect, it } from 'vitest'
import type { SessionStatus } from '~/lib/types'
import { deriveDisplayStateFromStatus } from './display-state'

describe('deriveDisplayStateFromStatus', () => {
  it('returns unknown when status is undefined (regardless of wsReadyState)', () => {
    expect(deriveDisplayStateFromStatus(undefined, 1).status).toBe('unknown')
    expect(deriveDisplayStateFromStatus(undefined, 0).status).toBe('unknown')
    expect(deriveDisplayStateFromStatus(undefined, 3).status).toBe('unknown')
  })

  it('returns disconnected when wsReadyState !== 1 (CONNECTING)', () => {
    const result = deriveDisplayStateFromStatus('running', 0)
    expect(result.status).toBe('disconnected')
    expect(result.label).toBe('Reconnecting…')
    expect(result.color).toBe('gray')
    expect(result.icon).toBe('wifi-off')
    expect(result.isInteractive).toBe(false)
  })

  it('returns disconnected when wsReadyState !== 1 (CLOSING)', () => {
    expect(deriveDisplayStateFromStatus('running', 2).status).toBe('disconnected')
  })

  it('returns disconnected when wsReadyState !== 1 (CLOSED)', () => {
    expect(deriveDisplayStateFromStatus('running', 3).status).toBe('disconnected')
  })

  it('maps status="running" → running when ws is open', () => {
    const result = deriveDisplayStateFromStatus('running', 1)
    expect(result.status).toBe('running')
    expect(result.label).toBe('Running')
    expect(result.color).toBe('green')
    expect(result.icon).toBe('spinner')
    expect(result.isInteractive).toBe(true)
  })

  it('maps status="idle" → idle when ws is open', () => {
    const result = deriveDisplayStateFromStatus('idle', 1)
    expect(result.status).toBe('idle')
    expect(result.label).toBe('Idle')
    expect(result.color).toBe('gray')
    expect(result.icon).toBe('circle')
    expect(result.isInteractive).toBe(true)
  })

  it('maps status="waiting_gate" → waiting_gate when ws is open', () => {
    const result = deriveDisplayStateFromStatus('waiting_gate', 1)
    expect(result.status).toBe('waiting_gate')
    expect(result.label).toBe('Needs Attention')
    expect(result.color).toBe('amber')
    expect(result.icon).toBe('alert')
    expect(result.isInteractive).toBe(true)
  })

  it('maps legacy waiting_input / waiting_permission → waiting_gate', () => {
    expect(deriveDisplayStateFromStatus('waiting_input', 1).status).toBe('waiting_gate')
    expect(deriveDisplayStateFromStatus('waiting_permission', 1).status).toBe('waiting_gate')
  })

  it('maps status="archived" → archived when ws is open', () => {
    const result = deriveDisplayStateFromStatus('archived' as SessionStatus, 1)
    expect(result.status).toBe('archived')
    expect(result.label).toBe('Archived')
    expect(result.color).toBe('gray')
    expect(result.icon).toBe('archive')
    expect(result.isInteractive).toBe(false)
  })

  it('returns unknown for unexpected status values when ws is open', () => {
    const result = deriveDisplayStateFromStatus('nonsense' as SessionStatus, 1)
    expect(result.status).toBe('unknown')
    expect(result.label).toBe('Unknown')
    expect(result.color).toBe('gray')
    expect(result.icon).toBe('circle')
    expect(result.isInteractive).toBe(false)
  })
})

describe('deriveDisplayStateFromStatus — WS grace period (GH#69 B5)', () => {
  it('(a) WS closed <5s ago returns server status, not DISCONNECTED', () => {
    const now = 10_000
    const wsCloseTs = now - 3_000
    const result = deriveDisplayStateFromStatus('running', 3, wsCloseTs, now)
    expect(result.status).toBe('running')
  })
  it('(b) WS closed >5s ago returns DISCONNECTED', () => {
    const now = 10_000
    const wsCloseTs = now - 6_000
    expect(deriveDisplayStateFromStatus('running', 3, wsCloseTs, now).status).toBe('disconnected')
  })
  it('(c) WS reopened (wsCloseTs=null) returns server status', () => {
    const result = deriveDisplayStateFromStatus('running', 1, null, 10_000)
    expect(result.status).toBe('running')
  })
  it('(d) transitions to DISCONNECTED at exactly 5s boundary', () => {
    const now = 10_000
    // <5000ms inside grace
    expect(deriveDisplayStateFromStatus('running', 3, now - 4_999, now).status).toBe('running')
    // exactly 5000ms → grace expired (strict less-than)
    expect(deriveDisplayStateFromStatus('running', 3, now - 5_000, now).status).toBe('disconnected')
  })
  it('wsCloseTs omitted → existing behavior unchanged', () => {
    // No 3rd arg at all — default `null` → immediate DISCONNECTED.
    expect(deriveDisplayStateFromStatus('running', 3).status).toBe('disconnected')
  })
})
