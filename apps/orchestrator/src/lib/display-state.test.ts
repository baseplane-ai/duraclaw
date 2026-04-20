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

  it('maps status="error" → error when ws is open', () => {
    const result = deriveDisplayStateFromStatus('error' as SessionStatus, 1)
    expect(result.status).toBe('error')
    expect(result.label).toBe('Error')
    expect(result.color).toBe('red')
    expect(result.icon).toBe('x-circle')
    expect(result.isInteractive).toBe(false)
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
