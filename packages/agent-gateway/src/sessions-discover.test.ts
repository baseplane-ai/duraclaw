import { describe, expect, it, vi } from 'vitest'
import { SessionSourceRegistry } from './session-sources/index.js'
import type { DiscoveredSession, ProjectInfo, SessionSource } from './types.js'

/**
 * Tests for the GET /sessions/discover endpoint contract.
 *
 * The endpoint discovers sessions from all registered SessionSources
 * across all discovered projects, returning merged results sorted by
 * last_activity descending with a per-source availability summary.
 */

function createMockSession(overrides: Partial<DiscoveredSession> = {}): DiscoveredSession {
  return {
    sdk_session_id: 'sess-001',
    agent: 'claude',
    project_dir: '/data/projects/myproject',
    project: 'myproject',
    branch: 'main',
    started_at: '2026-04-10T10:00:00Z',
    last_activity: '2026-04-10T12:00:00Z',
    summary: 'Fix the widget',
    tag: null,
    title: null,
    message_count: null,
    user: null,
    ...overrides,
  }
}

function createMockSource(
  agent: string,
  opts: {
    available?: boolean
    sessions?: DiscoveredSession[]
    discoverFn?: (
      projectPath: string,
      opts?: { since?: string; limit?: number },
    ) => Promise<DiscoveredSession[]>
    throwOnDiscover?: boolean
  } = {},
): SessionSource {
  const { available = true, sessions = [], discoverFn, throwOnDiscover = false } = opts
  return {
    agent,
    description: `${agent} sessions`,
    async available() {
      return available
    },
    async discoverSessions(projectPath, queryOpts) {
      if (throwOnDiscover) throw new Error(`${agent} exploded`)
      if (discoverFn) return discoverFn(projectPath, queryOpts)
      return sessions
    },
  }
}

function createMockProject(name: string, branch = 'main'): ProjectInfo {
  return {
    name,
    path: `/data/projects/${name}`,
    branch,
    dirty: false,
    active_session: null,
    repo_origin: null,
    ahead: 0,
    behind: 0,
    pr: null,
  }
}

/**
 * Simulate the route handler logic from server.ts:
 * - Discover projects, optionally filter by name
 * - Iterate sources, skip unavailable ones
 * - Collect sessions, build source summary
 * - Sort by last_activity descending
 */
async function simulateDiscoverRoute(
  projects: ProjectInfo[],
  sessionSources: SessionSourceRegistry,
  params: { since?: string; limit?: number; project?: string } = {},
): Promise<{
  sessions: DiscoveredSession[]
  sources: Record<string, { available: boolean; session_count: number }>
}> {
  const { since, limit = 50, project: projectFilter } = params

  const filtered = projectFilter ? projects.filter((p) => p.name === projectFilter) : projects

  const allSessions: DiscoveredSession[] = []
  const sourceSummary: Record<string, { available: boolean; session_count: number }> = {}

  for (const source of sessionSources.listSources()) {
    const avail = await source.available()
    sourceSummary[source.agent] = { available: avail, session_count: 0 }
  }

  for (const project of filtered) {
    for (const source of sessionSources.listSources()) {
      if (!sourceSummary[source.agent].available) continue
      try {
        const sessions = await source.discoverSessions(project.path, { since, limit })
        allSessions.push(...sessions)
        sourceSummary[source.agent].session_count += sessions.length
      } catch {
        // Errors are logged but do not fail the request
      }
    }
  }

  allSessions.sort((a, b) => (b.last_activity > a.last_activity ? 1 : -1))

  return { sessions: allSessions, sources: sourceSummary }
}

describe('GET /sessions/discover response shape', () => {
  it('returns { sessions, sources } envelope', async () => {
    const registry = new SessionSourceRegistry()
    registry.register(createMockSource('claude'))

    const result = await simulateDiscoverRoute([createMockProject('proj1')], registry)

    expect(result).toHaveProperty('sessions')
    expect(result).toHaveProperty('sources')
    expect(Array.isArray(result.sessions)).toBe(true)
  })

  it('returns empty sessions when no projects exist', async () => {
    const registry = new SessionSourceRegistry()
    registry.register(createMockSource('claude', { sessions: [createMockSession()] }))

    const result = await simulateDiscoverRoute([], registry)

    expect(result.sessions).toEqual([])
    expect(result.sources.claude.session_count).toBe(0)
  })

  it('returns empty sessions when no sources registered', async () => {
    const registry = new SessionSourceRegistry()

    const result = await simulateDiscoverRoute([createMockProject('proj1')], registry)

    expect(result.sessions).toEqual([])
    expect(result.sources).toEqual({})
  })
})

describe('sessions/discover source summary', () => {
  it('reports available and session_count per source', async () => {
    const registry = new SessionSourceRegistry()
    registry.register(
      createMockSource('claude', {
        sessions: [createMockSession({ agent: 'claude' })],
      }),
    )
    registry.register(createMockSource('codex', { available: false }))

    const result = await simulateDiscoverRoute([createMockProject('proj1')], registry)

    expect(result.sources.claude).toEqual({ available: true, session_count: 1 })
    expect(result.sources.codex).toEqual({ available: false, session_count: 0 })
  })

  it('skips unavailable sources entirely', async () => {
    const discoverFn = vi.fn().mockResolvedValue([])
    const registry = new SessionSourceRegistry()
    registry.register(createMockSource('codex', { available: false, discoverFn }))

    await simulateDiscoverRoute([createMockProject('proj1')], registry)

    expect(discoverFn).not.toHaveBeenCalled()
  })

  it('accumulates session_count across multiple projects', async () => {
    const registry = new SessionSourceRegistry()
    registry.register(
      createMockSource('claude', {
        discoverFn: async (path) => [
          createMockSession({ sdk_session_id: `sess-${path}`, agent: 'claude', project_dir: path }),
        ],
      }),
    )

    const result = await simulateDiscoverRoute(
      [createMockProject('proj1'), createMockProject('proj2')],
      registry,
    )

    expect(result.sessions).toHaveLength(2)
    expect(result.sources.claude.session_count).toBe(2)
  })
})

describe('sessions/discover sorting', () => {
  it('sorts sessions by last_activity descending', async () => {
    const registry = new SessionSourceRegistry()
    registry.register(
      createMockSource('claude', {
        sessions: [
          createMockSession({ sdk_session_id: 'old', last_activity: '2026-04-01T00:00:00Z' }),
          createMockSession({ sdk_session_id: 'new', last_activity: '2026-04-10T00:00:00Z' }),
          createMockSession({ sdk_session_id: 'mid', last_activity: '2026-04-05T00:00:00Z' }),
        ],
      }),
    )

    const result = await simulateDiscoverRoute([createMockProject('proj1')], registry)

    expect(result.sessions.map((s) => s.sdk_session_id)).toEqual(['new', 'mid', 'old'])
  })

  it('merges and sorts sessions from multiple sources', async () => {
    const registry = new SessionSourceRegistry()
    registry.register(
      createMockSource('claude', {
        sessions: [
          createMockSession({
            sdk_session_id: 'claude-1',
            agent: 'claude',
            last_activity: '2026-04-10T00:00:00Z',
          }),
        ],
      }),
    )
    registry.register(
      createMockSource('codex', {
        sessions: [
          createMockSession({
            sdk_session_id: 'codex-1',
            agent: 'codex',
            last_activity: '2026-04-11T00:00:00Z',
          }),
        ],
      }),
    )

    const result = await simulateDiscoverRoute([createMockProject('proj1')], registry)

    expect(result.sessions.map((s) => s.sdk_session_id)).toEqual(['codex-1', 'claude-1'])
  })
})

describe('sessions/discover project filter', () => {
  it('filters to a single project when project param is set', async () => {
    const registry = new SessionSourceRegistry()
    registry.register(
      createMockSource('claude', {
        discoverFn: async (path) => [
          createMockSession({
            sdk_session_id: `sess-${path.split('/').pop()}`,
            project_dir: path,
            project: path.split('/').pop()!,
          }),
        ],
      }),
    )

    const result = await simulateDiscoverRoute(
      [createMockProject('proj1'), createMockProject('proj2')],
      registry,
      { project: 'proj1' },
    )

    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0].project).toBe('proj1')
  })

  it('returns no sessions when project filter matches nothing', async () => {
    const registry = new SessionSourceRegistry()
    registry.register(
      createMockSource('claude', {
        sessions: [createMockSession()],
      }),
    )

    const result = await simulateDiscoverRoute([createMockProject('proj1')], registry, {
      project: 'nonexistent',
    })

    expect(result.sessions).toEqual([])
  })
})

describe('sessions/discover error handling', () => {
  it('continues when a source throws, with zero session_count', async () => {
    const registry = new SessionSourceRegistry()
    registry.register(createMockSource('claude', { throwOnDiscover: true }))
    registry.register(
      createMockSource('codex', {
        sessions: [createMockSession({ sdk_session_id: 'codex-ok', agent: 'codex' })],
      }),
    )

    const result = await simulateDiscoverRoute([createMockProject('proj1')], registry)

    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0].agent).toBe('codex')
    expect(result.sources.claude).toEqual({ available: true, session_count: 0 })
    expect(result.sources.codex).toEqual({ available: true, session_count: 1 })
  })

  it('passes since and limit options through to sources', async () => {
    const discoverFn = vi.fn().mockResolvedValue([])
    const registry = new SessionSourceRegistry()
    registry.register(createMockSource('claude', { discoverFn }))

    await simulateDiscoverRoute([createMockProject('proj1')], registry, {
      since: '2026-04-01T00:00:00Z',
      limit: 10,
    })

    expect(discoverFn).toHaveBeenCalledWith('/data/projects/proj1', {
      since: '2026-04-01T00:00:00Z',
      limit: 10,
    })
  })
})

describe('sessions/discover DiscoveredSession shape', () => {
  it('each session has all required fields', async () => {
    const session = createMockSession()
    const registry = new SessionSourceRegistry()
    registry.register(createMockSource('claude', { sessions: [session] }))

    const result = await simulateDiscoverRoute([createMockProject('proj1')], registry)

    const s = result.sessions[0]
    expect(s).toHaveProperty('sdk_session_id')
    expect(s).toHaveProperty('agent')
    expect(s).toHaveProperty('project_dir')
    expect(s).toHaveProperty('project')
    expect(s).toHaveProperty('branch')
    expect(s).toHaveProperty('started_at')
    expect(s).toHaveProperty('last_activity')
    expect(s).toHaveProperty('summary')
  })

  it('optional fields can be null', async () => {
    const session = createMockSession({
      tag: null,
      title: null,
      message_count: null,
      user: null,
    })
    const registry = new SessionSourceRegistry()
    registry.register(createMockSource('claude', { sessions: [session] }))

    const result = await simulateDiscoverRoute([createMockProject('proj1')], registry)

    const s = result.sessions[0]
    expect(s.tag).toBeNull()
    expect(s.title).toBeNull()
    expect(s.message_count).toBeNull()
    expect(s.user).toBeNull()
  })
})
