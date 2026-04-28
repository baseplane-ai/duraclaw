import { describe, expect, it } from 'vitest'
import type { SessionStatus } from '~/lib/types'
import { deriveDisplayStateFromStatus, deriveTabDisplayState } from './display-state'

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

  it('collapses status="pending" → running display (no separate "Thinking" surface)', () => {
    // `pending` (runner stamped, pre-first-event) folds into the RUNNING
    // display so StatusBar / tab / list badges show a single in-flight
    // state across the whole turn. The inline AwaitingBubble in the
    // thread distinguishes the pre-first-token phase; the chrome
    // surfaces don't re-represent it.
    const result = deriveDisplayStateFromStatus('pending', 1)
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

  // GH#119 P3 — failover / waiting_identity surfaces. The StatusBar /
  // sidebar / tab strip all read these labels; the spec specifically
  // calls for "Switching..." during failover and a "cooldown" /
  // "accounts" hint during waiting_identity.
  it('maps status="failover" → "Switching accounts…" (amber, non-interactive)', () => {
    const result = deriveDisplayStateFromStatus('failover', 1)
    expect(result.status).toBe('failover')
    expect(result.label.toLowerCase()).toContain('switching')
    expect(result.color).toBe('amber')
    expect(result.icon).toBe('spinner')
    expect(result.isInteractive).toBe(false)
  })

  it('maps status="waiting_identity" → "All accounts on cooldown" (red, non-interactive)', () => {
    const result = deriveDisplayStateFromStatus('waiting_identity', 1)
    expect(result.status).toBe('waiting_identity')
    const label = result.label.toLowerCase()
    // Spec says label should mention cooldown + the accounts/identities
    // concept. Match either word so a future copy tweak doesn't break the
    // test on a label rewrite that preserves the intent.
    expect(label).toContain('cooldown')
    expect(label).toMatch(/account|identit/)
    expect(result.color).toBe('red')
    expect(result.icon).toBe('alert')
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

describe('deriveTabDisplayState — completed_unseen promotion', () => {
  it('idle + background + session ahead of lastSeen → completed_unseen', () => {
    const result = deriveTabDisplayState({
      status: 'idle',
      wsReadyState: 1,
      isActive: false,
      sessionMessageSeq: 42,
      lastSeenSeq: 30,
    })
    expect(result.status).toBe('completed_unseen')
    expect(result.label).toBe('Done')
    expect(result.color).toBe('sky')
    expect(result.icon).toBe('check')
    expect(result.isInteractive).toBe(true)
  })

  it('idle + background + session == lastSeen → plain idle (no promotion)', () => {
    const result = deriveTabDisplayState({
      status: 'idle',
      wsReadyState: 1,
      isActive: false,
      sessionMessageSeq: 42,
      lastSeenSeq: 42,
    })
    expect(result.status).toBe('idle')
  })

  it('idle + ACTIVE tab → plain idle (active can never be unseen)', () => {
    const result = deriveTabDisplayState({
      status: 'idle',
      wsReadyState: 1,
      isActive: true,
      sessionMessageSeq: 42,
      lastSeenSeq: 30,
    })
    expect(result.status).toBe('idle')
  })

  it('running + background + session ahead → running (no promotion off of running)', () => {
    // Promotion is scoped to `idle`: a tab mid-turn isn't "done".
    const result = deriveTabDisplayState({
      status: 'running',
      wsReadyState: 1,
      isActive: false,
      sessionMessageSeq: 42,
      lastSeenSeq: 30,
    })
    expect(result.status).toBe('running')
  })

  it('waiting_gate + background + session ahead → waiting_gate (amber wins over sky)', () => {
    const result = deriveTabDisplayState({
      status: 'waiting_gate',
      wsReadyState: 1,
      isActive: false,
      sessionMessageSeq: 42,
      lastSeenSeq: 30,
    })
    expect(result.status).toBe('waiting_gate')
  })

  it('undefined lastSeenSeq is treated as -1 — never promotes from a fresh seq -1 session', () => {
    // Both default to -1 → sessionSeq > lastSeen is false, stay idle.
    const result = deriveTabDisplayState({
      status: 'idle',
      wsReadyState: 1,
      isActive: false,
      sessionMessageSeq: undefined,
      lastSeenSeq: undefined,
    })
    expect(result.status).toBe('idle')
  })

  it('unknown status (no server row yet) stays unknown, not promoted', () => {
    const result = deriveTabDisplayState({
      status: undefined as unknown as SessionStatus,
      wsReadyState: 1,
      isActive: false,
      sessionMessageSeq: 42,
      lastSeenSeq: 30,
    })
    expect(result.status).toBe('unknown')
  })
})
