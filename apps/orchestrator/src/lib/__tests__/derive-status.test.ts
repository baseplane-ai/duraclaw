/**
 * GH#50 — branch coverage for the TTL status predicate.
 *
 * Five branches × explicit boundary case at TTL_MS so a regression
 * shows up as a single failing assertion rather than a vague drift.
 */

import { describe, expect, it } from 'vitest'
import { type DeriveStatusRow, deriveStatus, TTL_MS } from '../derive-status'

const NOW = 1_777_600_000_000

function row(overrides: Partial<DeriveStatusRow> = {}): DeriveStatusRow {
  return {
    status: 'running',
    archived: false,
    error: null,
    lastEventTs: NOW,
    ...overrides,
  }
}

describe('deriveStatus', () => {
  it('archived rows always render as archived (highest priority)', () => {
    expect(deriveStatus(row({ archived: true, status: 'running' }), NOW)).toBe('archived')
    // Even with a stuck-running TTL, archived wins.
    expect(
      deriveStatus(row({ archived: true, status: 'running', lastEventTs: NOW - 10 * TTL_MS }), NOW),
    ).toBe('archived')
  })

  it('error rows pass through to row.status (DO already wrote idle alongside the error)', () => {
    expect(deriveStatus(row({ status: 'idle', error: 'boom' }), NOW)).toBe('idle')
    // TTL is intentionally NOT applied when an error is present.
    expect(
      deriveStatus(row({ status: 'running', error: 'boom', lastEventTs: NOW - 10 * TTL_MS }), NOW),
    ).toBe('running')
  })

  it('null lastEventTs falls through to server status (pre-migration rows)', () => {
    expect(deriveStatus(row({ status: 'running', lastEventTs: null }), NOW)).toBe('running')
    expect(deriveStatus(row({ status: 'idle', lastEventTs: null }), NOW)).toBe('idle')
  })

  it('overrides stuck running → idle once TTL elapses', () => {
    expect(deriveStatus(row({ lastEventTs: NOW - TTL_MS - 1 }), NOW)).toBe('idle')
  })

  it('treats the boundary case (now - lastEventTs === TTL_MS) as still-fresh', () => {
    // `<= TTL_MS` returns server status; `> TTL_MS` returns idle.
    expect(deriveStatus(row({ lastEventTs: NOW - TTL_MS }), NOW)).toBe('running')
    expect(deriveStatus(row({ lastEventTs: NOW - TTL_MS - 1 }), NOW)).toBe('idle')
  })

  it('passes through non-running statuses unchanged when fresh', () => {
    expect(deriveStatus(row({ status: 'idle' }), NOW)).toBe('idle')
    expect(deriveStatus(row({ status: 'waiting_gate' }), NOW)).toBe('waiting_gate')
    expect(deriveStatus(row({ status: 'waiting_input' }), NOW)).toBe('waiting_input')
  })

  it('does NOT apply TTL override to waiting_gate / waiting_input when stale', () => {
    // A pending gate is a user-decision state — no events flow while the
    // user is thinking. TTL MUST NOT flip these to 'idle' or the pending
    // prompt disappears from the UI after 45s.
    expect(deriveStatus(row({ status: 'waiting_gate', lastEventTs: NOW - 10 * TTL_MS }), NOW)).toBe(
      'waiting_gate',
    )
    expect(
      deriveStatus(row({ status: 'waiting_input', lastEventTs: NOW - 10 * TTL_MS }), NOW),
    ).toBe('waiting_input')
    // Stale 'idle' also passes through unchanged — TTL only overrides 'running'.
    expect(deriveStatus(row({ status: 'idle', lastEventTs: NOW - 10 * TTL_MS }), NOW)).toBe('idle')
  })
})
