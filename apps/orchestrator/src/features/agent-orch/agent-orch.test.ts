/**
 * Tests for agent-orch feature — session hooks, event parsing, and migrations.
 *
 * @vitest-environment jsdom
 */

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { REGISTRY_MIGRATIONS } from '~/agents/project-registry-migrations'
import { runMigrations } from '~/lib/do-migrations'
import { DATE_GROUP_ORDER, getDateGroup } from './SessionSidebar'
import type { SessionRecord } from './use-agent-orch-sessions'
import { useAgentOrchSessions } from './use-agent-orch-sessions'

// ── SessionRecord type shape tests ────────────────────────────────────

describe('SessionRecord', () => {
  test('has expected fields from SessionSummary plus archived', () => {
    const record: SessionRecord = {
      id: 'sess-1',
      userId: null,
      project: 'test-project',
      status: 'idle',
      model: 'claude-sonnet-4-20250514',
      created_at: '2026-04-10T00:00:00Z',
      updated_at: '2026-04-10T00:00:00Z',
      archived: false,
    }
    expect(record.id).toBe('sess-1')
    expect(record.project).toBe('test-project')
    expect(record.status).toBe('idle')
    expect(record.archived).toBe(false)
    expect(record.model).toBe('claude-sonnet-4-20250514')
  })

  test('supports optional numeric fields', () => {
    const record: SessionRecord = {
      id: 'sess-2',
      userId: 'user-abc',
      project: 'proj',
      status: 'completed',
      model: null,
      created_at: '2026-04-10T00:00:00Z',
      updated_at: '2026-04-10T00:00:00Z',
      duration_ms: 12345,
      total_cost_usd: 0.05,
      num_turns: 7,
      prompt: 'do stuff',
      summary: 'did stuff',
      archived: true,
    }
    expect(record.duration_ms).toBe(12345)
    expect(record.total_cost_usd).toBe(0.05)
    expect(record.num_turns).toBe(7)
    expect(record.prompt).toBe('do stuff')
    expect(record.summary).toBe('did stuff')
    expect(record.archived).toBe(true)
  })
})

// ── useAgentOrchSessions hook tests ───────────────────────────────────

describe('useAgentOrchSessions', () => {
  const mockSessions = [
    {
      id: 's1',
      userId: null,
      project: 'proj-a',
      status: 'idle',
      model: 'test-model',
      created_at: '2026-04-10T00:00:00Z',
      updated_at: '2026-04-10T01:00:00Z',
      archived: false,
    },
    {
      id: 's2',
      userId: 'u1',
      project: 'proj-b',
      status: 'running',
      model: 'test-model',
      created_at: '2026-04-10T00:00:00Z',
      updated_at: '2026-04-10T00:30:00Z',
      archived: true,
    },
  ]

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('fetches sessions from /api/sessions on mount', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ sessions: mockSessions }),
      }),
    )

    const { result } = renderHook(() => useAgentOrchSessions())

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(fetch).toHaveBeenCalledWith('/api/sessions')
    expect(result.current.sessions).toHaveLength(2)
    expect(result.current.sessions[0].id).toBe('s1')
    expect(result.current.sessions[1].id).toBe('s2')
  })

  test('maps archived field to boolean', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            sessions: [
              {
                id: 's3',
                userId: null,
                project: 'p',
                status: 'idle',
                model: null,
                created_at: '2026-01-01T00:00:00Z',
                updated_at: '2026-01-01T00:00:00Z',
                archived: 1,
              },
              {
                id: 's4',
                userId: null,
                project: 'p',
                status: 'idle',
                model: null,
                created_at: '2026-01-01T00:00:00Z',
                updated_at: '2026-01-01T00:00:00Z',
              },
            ],
          }),
      }),
    )

    const { result } = renderHook(() => useAgentOrchSessions())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    // archived: 1 (truthy) => true, undefined => false
    expect(result.current.sessions[0].archived).toBe(true)
    expect(result.current.sessions[1].archived).toBe(false)
  })

  test('sets up polling interval with setInterval', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ sessions: [] }),
      }),
    )

    renderHook(() => useAgentOrchSessions())

    // The hook registers a 5000ms polling interval
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 5000)
    setIntervalSpy.mockRestore()
  })

  test('clears polling interval on unmount', () => {
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ sessions: [] }),
      }),
    )

    const { unmount } = renderHook(() => useAgentOrchSessions())
    unmount()

    expect(clearIntervalSpy).toHaveBeenCalled()
    clearIntervalSpy.mockRestore()
  })

  test('createSession posts to /api/sessions then refreshes', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ sessions: mockSessions }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useAgentOrchSessions())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await act(async () => {
      await result.current.createSession({
        id: 'new-1',
        project: 'proj',
        model: 'model',
        prompt: 'hello',
      })
    })

    const postCall = fetchMock.mock.calls.find(
      (c: unknown[]) => c[1] && (c[1] as RequestInit).method === 'POST',
    )
    expect(postCall).toBeTruthy()
    expect(postCall![0]).toBe('/api/sessions')
    const body = JSON.parse((postCall![1] as RequestInit).body as string)
    expect(body.id).toBe('new-1')
    expect(body.prompt).toBe('hello')
  })

  test('archiveSession patches with archived flag and optimistic update', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ sessions: mockSessions }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useAgentOrchSessions())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await act(async () => {
      await result.current.archiveSession('s1', true)
    })

    const patchCall = fetchMock.mock.calls.find(
      (c: unknown[]) => c[1] && (c[1] as RequestInit).method === 'PATCH',
    )
    expect(patchCall).toBeTruthy()
    expect(patchCall![0]).toBe('/api/sessions/s1')
    const body = JSON.parse((patchCall![1] as RequestInit).body as string)
    expect(body.archived).toBe(1)

    // Optimistic update
    expect(result.current.sessions.find((s) => s.id === 's1')?.archived).toBe(true)
  })

  test('archiveSession sends 0 when unarchiving', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ sessions: mockSessions }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useAgentOrchSessions())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await act(async () => {
      await result.current.archiveSession('s2', false)
    })

    const patchCall = fetchMock.mock.calls.find(
      (c: unknown[]) => c[1] && (c[1] as RequestInit).method === 'PATCH',
    )
    const body = JSON.parse((patchCall![1] as RequestInit).body as string)
    expect(body.archived).toBe(0)
    expect(result.current.sessions.find((s) => s.id === 's2')?.archived).toBe(false)
  })

  test('updateSession patches and does optimistic update', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ sessions: mockSessions }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useAgentOrchSessions())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await act(async () => {
      await result.current.updateSession('s1', { status: 'completed', summary: 'done' })
    })

    const patchCall = fetchMock.mock.calls.find(
      (c: unknown[]) =>
        c[0] === '/api/sessions/s1' && c[1] && (c[1] as RequestInit).method === 'PATCH',
    )
    expect(patchCall).toBeTruthy()
    const body = JSON.parse((patchCall![1] as RequestInit).body as string)
    expect(body.status).toBe('completed')
    expect(body.summary).toBe('done')

    // Optimistic update applied
    const updated = result.current.sessions.find((s) => s.id === 's1')
    expect(updated?.status).toBe('completed')
  })

  test('handles fetch failure gracefully', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')))

    const { result } = renderHook(() => useAgentOrchSessions())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.sessions).toEqual([])
  })

  test('handles non-ok response gracefully', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }))

    const { result } = renderHook(() => useAgentOrchSessions())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.sessions).toEqual([])
  })
})

// ── Gateway event parsing (streaming content accumulation) ────────────

/**
 * Extracted from use-coding-agent.ts onMessage handler.
 * This is the pure logic for extracting streaming text from content blocks.
 */
function extractStreamingDelta(content: unknown[]): string {
  let delta = ''
  for (const block of content) {
    const b = block as Record<string, unknown>
    if (typeof b.text === 'string') delta += b.text
    else if (typeof b.delta === 'string') delta += b.delta
    else if (b.delta && typeof (b.delta as Record<string, unknown>).text === 'string') {
      delta += (b.delta as Record<string, unknown>).text
    }
  }
  return delta
}

describe('Gateway event streaming content logic', () => {
  test('extracts text from partial_assistant content blocks with text field', () => {
    expect(extractStreamingDelta([{ text: 'hello ' }, { text: 'world' }])).toBe('hello world')
  })

  test('extracts text from delta field', () => {
    expect(extractStreamingDelta([{ delta: 'chunk1' }, { delta: 'chunk2' }])).toBe('chunk1chunk2')
  })

  test('extracts text from nested delta.text', () => {
    expect(
      extractStreamingDelta([{ delta: { text: 'nested1' } }, { delta: { text: 'nested2' } }]),
    ).toBe('nested1nested2')
  })

  test('handles mixed content block types', () => {
    expect(
      extractStreamingDelta([
        { text: 'direct' },
        { delta: '-delta' },
        { delta: { text: '-nested' } },
        { other: 'ignored' },
      ]),
    ).toBe('direct-delta-nested')
  })

  test('returns empty string for empty content array', () => {
    expect(extractStreamingDelta([])).toBe('')
  })

  test('ignores blocks with no text, delta, or delta.text', () => {
    expect(extractStreamingDelta([{ type: 'image', data: 'binary' }, { unknown: true }])).toBe('')
  })
})

// ── Gateway event type dispatch tests ─────────────────────────────────

describe('Gateway event type dispatch', () => {
  test('result event extracts cost and duration', () => {
    const event = { type: 'result', total_cost_usd: 0.042, duration_ms: 15000 }
    let sessionResult: { total_cost_usd: number; duration_ms: number } | null = null

    if (event.type === 'result') {
      const resultEvent = event as { total_cost_usd?: number; duration_ms?: number }
      if (resultEvent.total_cost_usd != null || resultEvent.duration_ms != null) {
        sessionResult = {
          total_cost_usd: resultEvent.total_cost_usd ?? 0,
          duration_ms: resultEvent.duration_ms ?? 0,
        }
      }
    }

    expect(sessionResult).not.toBeNull()
    expect(sessionResult!.total_cost_usd).toBe(0.042)
    expect(sessionResult!.duration_ms).toBe(15000)
  })

  test('result event with only cost defaults duration to 0', () => {
    const event = { type: 'result', total_cost_usd: 0.01 }
    let sessionResult: { total_cost_usd: number; duration_ms: number } | null = null

    if (event.type === 'result') {
      const resultEvent = event as { total_cost_usd?: number; duration_ms?: number }
      if (resultEvent.total_cost_usd != null || resultEvent.duration_ms != null) {
        sessionResult = {
          total_cost_usd: resultEvent.total_cost_usd ?? 0,
          duration_ms: resultEvent.duration_ms ?? 0,
        }
      }
    }

    expect(sessionResult!.total_cost_usd).toBe(0.01)
    expect(sessionResult!.duration_ms).toBe(0)
  })

  test('result event with neither cost nor duration yields null', () => {
    const event = { type: 'result' }
    let sessionResult: { total_cost_usd: number; duration_ms: number } | null = null

    if (event.type === 'result') {
      const resultEvent = event as { total_cost_usd?: number; duration_ms?: number }
      if (resultEvent.total_cost_usd != null || resultEvent.duration_ms != null) {
        sessionResult = {
          total_cost_usd: resultEvent.total_cost_usd ?? 0,
          duration_ms: resultEvent.duration_ms ?? 0,
        }
      }
    }

    expect(sessionResult).toBeNull()
  })

  test('file_changed event produces a tool message with path and tool name', () => {
    const event = { type: 'file_changed', path: '/src/foo.ts', tool: 'Write' }
    const fileEvent = event as { path?: string; tool?: string }
    const content = JSON.stringify({ path: fileEvent.path, tool: fileEvent.tool })

    const parsed = JSON.parse(content)
    expect(parsed.path).toBe('/src/foo.ts')
    expect(parsed.tool).toBe('Write')
  })

  test('assistant event with uuid builds message with event_uuid', () => {
    const event = {
      type: 'assistant',
      uuid: 'abc-123',
      content: [{ type: 'text', text: 'hello' }],
    }

    const message = {
      id: event.uuid as string,
      role: 'assistant' as const,
      type: 'text',
      content: JSON.stringify(event.content),
      event_uuid: event.uuid,
    }

    expect(message.id).toBe('abc-123')
    expect(message.role).toBe('assistant')
    expect(message.event_uuid).toBe('abc-123')
    const content = JSON.parse(message.content)
    expect(content[0].text).toBe('hello')
  })

  test('tool_result event with uuid builds tool message', () => {
    const event = {
      type: 'tool_result',
      uuid: 'tool-456',
      content: [{ type: 'text', text: 'file contents' }],
    }

    const message = {
      id: `tool-${event.uuid}`,
      role: 'tool' as const,
      type: 'tool_result',
      content: JSON.stringify(event.content),
      event_uuid: event.uuid,
    }

    expect(message.id).toBe('tool-tool-456')
    expect(message.role).toBe('tool')
    expect(message.type).toBe('tool_result')
    expect(message.event_uuid).toBe('tool-456')
  })
})

// ── Message dedup logic ───────────────────────────────────────────────

describe('Message dedup logic', () => {
  test('skips assistant message with already-known uuid', () => {
    const knownUuids = new Set(['uuid-1', 'uuid-2'])
    const event = { type: 'assistant', uuid: 'uuid-1', content: ['hello'] }
    const shouldSkip = knownUuids.has(event.uuid)
    expect(shouldSkip).toBe(true)
  })

  test('allows assistant message with new uuid', () => {
    const knownUuids = new Set(['uuid-1'])
    const event = { type: 'assistant', uuid: 'uuid-3', content: ['world'] }
    const shouldSkip = knownUuids.has(event.uuid)
    expect(shouldSkip).toBe(false)
  })

  test('dedup filter removes hydrated messages from realtime', () => {
    const hydrated = [
      { id: 1, role: 'assistant', type: 'text', content: 'a', event_uuid: 'e1' },
      { id: 2, role: 'user', type: 'text', content: 'q1', event_uuid: null },
    ]
    const realtime = [
      { id: 'rt1', role: 'assistant', type: 'text', content: 'a', event_uuid: 'e1' },
      { id: 'rt2', role: 'assistant', type: 'text', content: 'b', event_uuid: 'e2' },
      { id: 'rt3', role: 'user', type: 'text', content: 'q1', event_uuid: undefined },
    ]

    const hydratedIds = new Set(hydrated.map((m) => m.event_uuid).filter(Boolean))
    const hydratedUserContent = new Set(
      hydrated.filter((m) => m.role === 'user').map((m) => m.content),
    )

    const newRealtime = realtime.filter((m) => {
      if (m.event_uuid) return !hydratedIds.has(m.event_uuid)
      if (m.role === 'user') return !hydratedUserContent.has(m.content)
      return true
    })

    // e1 is duplicated and removed, q1 user message is duplicated and removed
    // only e2 remains
    expect(newRealtime).toHaveLength(1)
    expect(newRealtime[0].event_uuid).toBe('e2')
  })

  test('keeps tool messages without event_uuid (non-user, non-event-uuid)', () => {
    const hydrated = [{ id: 1, role: 'assistant', type: 'text', content: 'a', event_uuid: 'e1' }]
    const realtime = [
      {
        id: 'file-1',
        role: 'tool',
        type: 'file_changed',
        content: '{"path":"/a.ts"}',
        event_uuid: undefined,
      },
    ]

    const hydratedIds = new Set(hydrated.map((m) => m.event_uuid).filter(Boolean))
    const hydratedUserContent = new Set(
      hydrated.filter((m) => m.role === 'user').map((m) => m.content),
    )

    const newRealtime = realtime.filter((m) => {
      if (m.event_uuid) return !hydratedIds.has(m.event_uuid)
      if (m.role === 'user') return !hydratedUserContent.has(m.content)
      return true
    })

    expect(newRealtime).toHaveLength(1)
    expect(newRealtime[0].type).toBe('file_changed')
  })

  test('user_message broadcast dedup skips if optimistic ID matches', () => {
    const optimisticIds = new Set(['user-123'])
    const broadcastContent = JSON.stringify('hello from user')
    const existing = [
      { id: 'user-123', role: 'user' as const, type: 'text', content: broadcastContent },
    ]

    const isDuplicate = existing.some(
      (m) => m.role === 'user' && optimisticIds.has(String(m.id)) && m.content === broadcastContent,
    )

    expect(isDuplicate).toBe(true)
  })

  test('user_message broadcast is added when no optimistic match', () => {
    const optimisticIds = new Set<string>()
    const broadcastContent = JSON.stringify('new message')
    const existing = [{ id: 'user-old', role: 'user' as const, type: 'text', content: '"old"' }]

    const isDuplicate = existing.some(
      (m) => m.role === 'user' && optimisticIds.has(String(m.id)) && m.content === broadcastContent,
    )

    expect(isDuplicate).toBe(false)
  })
})

// ── ProjectRegistry migration tests ──────────────────────────────────

describe('ProjectRegistry migrations', () => {
  test('has 5 migration versions', () => {
    expect(REGISTRY_MIGRATIONS).toHaveLength(5)
  })

  test('migrations are ordered by version 1-5', () => {
    const versions = REGISTRY_MIGRATIONS.map((m) => m.version)
    expect(versions).toEqual([1, 2, 3, 4, 5])
  })

  test('v1 creates sessions table with expected columns', () => {
    const statements: string[] = []
    const mockSql = { exec: (q: string) => statements.push(q) }
    REGISTRY_MIGRATIONS[0].up(mockSql)
    expect(statements).toHaveLength(1)
    expect(statements[0]).toContain('CREATE TABLE')
    expect(statements[0]).toContain('sessions')
    expect(statements[0]).toContain('id TEXT PRIMARY KEY')
    expect(statements[0]).toContain('project TEXT NOT NULL')
    expect(statements[0]).toContain('status TEXT NOT NULL')
  })

  test('v1 table includes model, prompt, and summary columns', () => {
    const statements: string[] = []
    const mockSql = { exec: (q: string) => statements.push(q) }
    REGISTRY_MIGRATIONS[0].up(mockSql)
    expect(statements[0]).toContain('model TEXT')
    expect(statements[0]).toContain('prompt TEXT')
    expect(statements[0]).toContain('summary TEXT')
    expect(statements[0]).toContain('created_at TEXT NOT NULL')
    expect(statements[0]).toContain('updated_at TEXT NOT NULL')
  })

  test('v2 attempts to rename worktree to project', () => {
    const statements: string[] = []
    const mockSql = { exec: (q: string) => statements.push(q) }
    REGISTRY_MIGRATIONS[1].up(mockSql)
    expect(statements).toHaveLength(1)
    expect(statements[0]).toContain('RENAME COLUMN worktree TO project')
  })

  test('v3 adds summary and user_id columns', () => {
    const statements: string[] = []
    const mockSql = { exec: (q: string) => statements.push(q) }
    REGISTRY_MIGRATIONS[2].up(mockSql)
    expect(statements).toHaveLength(2)
    expect(statements[0]).toContain('summary')
    expect(statements[1]).toContain('user_id')
  })

  test('v4 adds archived column with INTEGER type and DEFAULT 0', () => {
    const statements: string[] = []
    const mockSql = { exec: (q: string) => statements.push(q) }
    REGISTRY_MIGRATIONS[3].up(mockSql)
    expect(statements).toHaveLength(1)
    expect(statements[0]).toContain('archived')
    expect(statements[0]).toContain('INTEGER')
    expect(statements[0]).toContain('DEFAULT 0')
  })

  test('v4 description mentions archived', () => {
    expect(REGISTRY_MIGRATIONS[3].description).toContain('archived')
  })

  test('each migration has a non-empty description', () => {
    for (const m of REGISTRY_MIGRATIONS) {
      expect(m.description.length).toBeGreaterThan(0)
    }
  })
})

// ── runMigrations integration tests ──────────────────────────────────

describe('runMigrations', () => {
  function createMockSql() {
    const calls: Array<{ query: string; bindings: unknown[] }> = []
    return {
      sql: {
        exec(query: string, ...bindings: unknown[]) {
          calls.push({ query, bindings })
          // Return version 0 for the SELECT MAX(version) query
          if (query.includes('SELECT MAX(version)')) {
            return { toArray: () => [{ version: null }] }
          }
          return undefined
        },
      },
      calls,
    }
  }

  test('creates _schema_version table', () => {
    const { sql, calls } = createMockSql()
    runMigrations(sql, [])
    expect(calls[0].query).toContain('CREATE TABLE IF NOT EXISTS _schema_version')
  })

  test('runs pending migrations in order', () => {
    const applied: number[] = []
    const { sql } = createMockSql()
    const migrations = [
      { version: 2, description: 'second', up: () => applied.push(2) },
      { version: 1, description: 'first', up: () => applied.push(1) },
    ]
    runMigrations(sql, migrations)
    expect(applied).toEqual([1, 2])
  })

  test('skips already-applied migrations', () => {
    const applied: number[] = []
    const calls: Array<{ query: string; bindings: unknown[] }> = []
    const sql = {
      exec(query: string, ...bindings: unknown[]) {
        calls.push({ query, bindings })
        if (query.includes('SELECT MAX(version)')) {
          return { toArray: () => [{ version: 2 }] }
        }
        return undefined
      },
    }
    const migrations = [
      { version: 1, description: 'old', up: () => applied.push(1) },
      { version: 2, description: 'old2', up: () => applied.push(2) },
      { version: 3, description: 'new', up: () => applied.push(3) },
    ]
    runMigrations(sql, migrations)
    expect(applied).toEqual([3])
  })

  test('inserts version record after each migration', () => {
    const { sql, calls } = createMockSql()
    const migrations = [{ version: 1, description: 'first', up: () => {} }]
    runMigrations(sql, migrations)
    const insertCall = calls.find((c) => c.query.includes('INSERT INTO _schema_version'))
    expect(insertCall).toBeTruthy()
    expect(insertCall!.bindings[0]).toBe(1)
  })
})

// ── updateSession field filtering logic ──────────────────────────────

describe('updateSession field filtering', () => {
  /**
   * Extracted from ProjectRegistry.updateSession -- the pure logic
   * that builds SET clauses from allowed fields only.
   */
  function buildSetClauses(updates: Record<string, unknown>) {
    const setClauses: string[] = ['updated_at = ?']
    const values: unknown[] = ['2026-04-10T00:00:00Z']
    const allowedFields = [
      'status',
      'model',
      'prompt',
      'summary',
      'duration_ms',
      'total_cost_usd',
      'num_turns',
      'archived',
    ]
    for (const field of allowedFields) {
      if (field in updates) {
        setClauses.push(`${field} = ?`)
        values.push(updates[field])
      }
    }
    return { setClauses, values }
  }

  test('includes only allowed fields in SET clause', () => {
    const { setClauses, values } = buildSetClauses({
      status: 'completed',
      archived: 1,
      malicious_field: 'DROP TABLE',
    })

    expect(setClauses).toContain('status = ?')
    expect(setClauses).toContain('archived = ?')
    expect(setClauses).not.toContain('malicious_field = ?')
    // updated_at + status + archived
    expect(values).toHaveLength(3)
    expect(values[1]).toBe('completed')
    expect(values[2]).toBe(1)
  })

  test('always includes updated_at as first clause', () => {
    const { setClauses } = buildSetClauses({})
    expect(setClauses).toHaveLength(1)
    expect(setClauses[0]).toBe('updated_at = ?')
  })

  test('handles all 8 allowed fields', () => {
    const { setClauses } = buildSetClauses({
      status: 'running',
      model: 'claude-sonnet-4-20250514',
      prompt: 'test',
      summary: 'done',
      duration_ms: 1000,
      total_cost_usd: 0.01,
      num_turns: 5,
      archived: 0,
    })
    // 1 (updated_at) + 8 allowed = 9
    expect(setClauses).toHaveLength(9)
  })

  test('produces correct SQL fragment', () => {
    const { setClauses } = buildSetClauses({ archived: 1 })
    const sql = `UPDATE sessions SET ${setClauses.join(', ')} WHERE id = ?`
    expect(sql).toBe('UPDATE sessions SET updated_at = ?, archived = ? WHERE id = ?')
  })
})

// ── Date grouping tests ─────────────────────────────────────────────

describe('getDateGroup', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // Pin "now" to 2026-04-11T12:00:00Z so date math is deterministic
    vi.setSystemTime(new Date('2026-04-11T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('returns Today for a date from today', () => {
    expect(getDateGroup('2026-04-11T08:00:00Z')).toBe('Today')
  })

  test('returns Today for the current moment', () => {
    expect(getDateGroup('2026-04-11T12:00:00Z')).toBe('Today')
  })

  test('returns Yesterday for a date from yesterday', () => {
    expect(getDateGroup('2026-04-10T15:00:00Z')).toBe('Yesterday')
  })

  test('returns This Week for a date 3 days ago', () => {
    expect(getDateGroup('2026-04-08T10:00:00Z')).toBe('This Week')
  })

  test('returns This Week for a date exactly 6 days ago (within 7-day window)', () => {
    expect(getDateGroup('2026-04-05T10:00:00Z')).toBe('This Week')
  })

  test('returns This Month for a date 2 weeks ago', () => {
    expect(getDateGroup('2026-03-28T10:00:00Z')).toBe('This Month')
  })

  test('returns Older for a date more than a month ago', () => {
    expect(getDateGroup('2026-02-01T00:00:00Z')).toBe('Older')
  })

  test('returns Older for a very old date', () => {
    expect(getDateGroup('2024-01-01T00:00:00Z')).toBe('Older')
  })
})

describe('DATE_GROUP_ORDER', () => {
  test('contains exactly 5 groups in chronological order', () => {
    expect(DATE_GROUP_ORDER).toEqual(['Today', 'Yesterday', 'This Week', 'This Month', 'Older'])
  })
})

describe('Session date grouping logic', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-11T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('groups sessions by date bucket', () => {
    const sessions: Pick<SessionRecord, 'id' | 'created_at' | 'project'>[] = [
      { id: 's1', created_at: '2026-04-11T08:00:00Z', project: 'proj-a' },
      { id: 's2', created_at: '2026-04-10T15:00:00Z', project: 'proj-a' },
      { id: 's3', created_at: '2026-04-08T10:00:00Z', project: 'proj-b' },
      { id: 's4', created_at: '2026-02-01T00:00:00Z', project: 'proj-b' },
    ]

    const groups = new Map<string, typeof sessions>()
    for (const session of sessions) {
      const key = getDateGroup(session.created_at)
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)?.push(session)
    }

    expect(groups.get('Today')).toHaveLength(1)
    expect(groups.get('Today')![0].id).toBe('s1')
    expect(groups.get('Yesterday')).toHaveLength(1)
    expect(groups.get('Yesterday')![0].id).toBe('s2')
    expect(groups.get('This Week')).toHaveLength(1)
    expect(groups.get('This Week')![0].id).toBe('s3')
    expect(groups.get('Older')).toHaveLength(1)
    expect(groups.get('Older')![0].id).toBe('s4')
  })

  test('sortedGroupKeys filters and orders by DATE_GROUP_ORDER', () => {
    const groups = new Map<string, unknown[]>()
    groups.set('Older', [{}])
    groups.set('Today', [{}, {}])
    // 'Yesterday', 'This Week', 'This Month' are absent

    const sortedGroupKeys = DATE_GROUP_ORDER.filter((k) => groups.has(k))
    expect(sortedGroupKeys).toEqual(['Today', 'Older'])
  })

  test('project grouping sorts keys alphabetically', () => {
    const groups = new Map<string, unknown[]>()
    groups.set('zeta-project', [{}])
    groups.set('alpha-project', [{}])
    groups.set('mid-project', [{}])

    const sortedGroupKeys = Array.from(groups.keys()).sort()
    expect(sortedGroupKeys).toEqual(['alpha-project', 'mid-project', 'zeta-project'])
  })
})
