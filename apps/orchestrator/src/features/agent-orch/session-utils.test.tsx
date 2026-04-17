/**
 * @vitest-environment jsdom
 *
 * Tests for session-utils — shared formatting utilities and StatusDot component.
 */

import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  formatCost,
  formatTimeAgo,
  getPreviewText,
  getProjectInitials,
  StatusDot,
} from './session-utils'

afterEach(cleanup)

// ── formatTimeAgo ────────────────────────────────────────────────────

describe('formatTimeAgo', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-13T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns "just now" for dates less than a minute ago', () => {
    expect(formatTimeAgo('2026-04-13T11:59:30Z')).toBe('just now')
  })

  it('returns minutes ago for dates less than an hour ago', () => {
    expect(formatTimeAgo('2026-04-13T11:45:00Z')).toBe('15m ago')
  })

  it('returns hours ago for dates less than a day ago', () => {
    expect(formatTimeAgo('2026-04-13T09:00:00Z')).toBe('3h ago')
  })

  it('returns days ago for dates more than a day ago', () => {
    expect(formatTimeAgo('2026-04-11T12:00:00Z')).toBe('2d ago')
  })

  it('returns 0m for exactly one minute', () => {
    // 1 minute = 60000ms -> floor(1) = 1
    expect(formatTimeAgo('2026-04-13T11:59:00Z')).toBe('1m ago')
  })

  it('returns hours at exactly 60 minutes', () => {
    expect(formatTimeAgo('2026-04-13T11:00:00Z')).toBe('1h ago')
  })

  it('returns days at exactly 24 hours', () => {
    expect(formatTimeAgo('2026-04-12T12:00:00Z')).toBe('1d ago')
  })
})

// ── StatusDot ────────────────────────────────────────────────────────

describe('StatusDot', () => {
  it('renders blue pulsing dot for spawning (running + 0 turns)', () => {
    const { container } = render(<StatusDot status="running" numTurns={0} />)
    const span = container.querySelector('span')
    expect(span?.className).toContain('bg-blue-500')
    expect(span?.className).toContain('animate-pulse')
  })

  it('renders green dot for running with turns > 0', () => {
    const { container } = render(<StatusDot status="running" numTurns={5} />)
    const span = container.querySelector('span')
    expect(span?.className).toContain('bg-green-500')
    expect(span?.className).not.toContain('animate-pulse')
  })

  it('renders yellow dot for waiting_gate', () => {
    const { container } = render(<StatusDot status="waiting_gate" numTurns={3} />)
    const span = container.querySelector('span')
    expect(span?.className).toContain('bg-yellow-500')
  })

  it('renders yellow dot for waiting_input', () => {
    const { container } = render(<StatusDot status="waiting_input" numTurns={1} />)
    const span = container.querySelector('span')
    expect(span?.className).toContain('bg-yellow-500')
  })

  it('renders yellow dot for waiting_permission', () => {
    const { container } = render(<StatusDot status="waiting_permission" numTurns={1} />)
    const span = container.querySelector('span')
    expect(span?.className).toContain('bg-yellow-500')
  })

  it('renders gray-border default dot for failed (only aborted is red)', () => {
    const { container } = render(<StatusDot status="failed" numTurns={2} />)
    const span = container.querySelector('span')
    expect(span?.className).toContain('border-gray-400')
  })

  it('renders gray border dot for idle/unknown status', () => {
    const { container } = render(<StatusDot status="idle" numTurns={0} />)
    const span = container.querySelector('span')
    expect(span?.className).toContain('border-gray-400')
  })
})

// ── getPreviewText ───────────────────────────────────────────────────

describe('getPreviewText', () => {
  it('returns summary when available', () => {
    expect(getPreviewText({ summary: 'a summary', prompt: 'a prompt' })).toBe('a summary')
  })

  it('falls back to prompt when no summary', () => {
    expect(getPreviewText({ prompt: 'a prompt' })).toBe('a prompt')
  })

  it('returns undefined when neither is present', () => {
    expect(getPreviewText({})).toBeUndefined()
  })

  it('returns undefined for empty strings', () => {
    expect(getPreviewText({ summary: '', prompt: '' })).toBeUndefined()
  })
})

// ── formatCost ───────────────────────────────────────────────────────

describe('formatCost', () => {
  it('formats cost with two decimal places', () => {
    expect(formatCost(1.5)).toBe('$1.50')
  })

  it('formats zero cost', () => {
    expect(formatCost(0)).toBe('$0.00')
  })

  it('formats small cost', () => {
    expect(formatCost(0.03)).toBe('$0.03')
  })

  it('formats large cost', () => {
    expect(formatCost(123.456)).toBe('$123.46')
  })
})

// ── getProjectInitials ───────────────────────────────────────────────

describe('getProjectInitials', () => {
  it('returns first 2 chars of project when present', () => {
    expect(getProjectInitials('baseplane', 'Session Title')).toBe('ba')
  })

  it('falls back to title when project is null', () => {
    expect(getProjectInitials(null, 'My Session')).toBe('My')
  })

  it('falls back to title when project is undefined', () => {
    expect(getProjectInitials(undefined, 'Session')).toBe('Se')
  })

  it('returns ?? when both are null', () => {
    expect(getProjectInitials(null, null)).toBe('??')
  })

  it('returns ?? when both are undefined', () => {
    expect(getProjectInitials(undefined, undefined)).toBe('??')
  })
})
