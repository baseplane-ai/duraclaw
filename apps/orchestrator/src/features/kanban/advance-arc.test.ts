/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ArcSummary } from '~/lib/types'
import { advanceArc } from './advance-arc'

function arc(overrides: Partial<ArcSummary> = {}): ArcSummary {
  return {
    id: 'arc_test',
    title: 'test arc',
    externalRef: { provider: 'github', id: 82, url: 'https://example/82' },
    status: 'open',
    createdAt: '2026-04-24T00:00:00Z',
    updatedAt: '2026-04-24T00:00:00Z',
    sessions: [],
    lastActivity: '2026-04-24T00:00:00Z',
    ...overrides,
  }
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('advanceArc', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('POSTs /api/arcs/:id/sessions with the next mode + kata-enter prompt', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(201, { sessionId: 'new-session-id', arcId: 'arc_test' }))

    const res = await advanceArc(arc({ status: 'open' }), 'research')

    expect(res).toEqual({ ok: true, sessionId: 'new-session-id', arcId: 'arc_test' })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/arcs/arc_test/sessions',
      expect.objectContaining({ method: 'POST' }),
    )
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string)
    // GH-linked arc: prompt carries the `--issue=` flag for kata mode entry.
    expect(body).toEqual({ mode: 'research', prompt: 'enter research --issue=82' })
  })

  it('omits --issue= for non-GH arcs', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(201, { sessionId: 'sid', arcId: 'arc_orphan' }))

    await advanceArc(arc({ id: 'arc_orphan', externalRef: null }), 'planning')

    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string)
    expect(body.prompt).toBe('enter planning')
  })

  it('returns error on non-2xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(400, { error: 'no_project_for_arc' }),
    )
    const res = await advanceArc(arc(), 'implementation')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toBe('no_project_for_arc')
  })

  it('returns error when response lacks sessionId', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(201, {}))
    const res = await advanceArc(arc(), 'research')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('no sessionId')
  })
})
