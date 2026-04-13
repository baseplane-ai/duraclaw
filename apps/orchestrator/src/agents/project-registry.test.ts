import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('cloudflare:workers', () => ({
  DurableObject: class DurableObject {
    ctx: any
    env: any
    constructor(ctx: any, env: any) {
      this.ctx = ctx
      this.env = env
    }
  },
}))

// Must import after mock
const { ProjectRegistry } = await import('./project-registry')

/**
 * Minimal fake for DurableObjectStorage.sql that captures queries and returns
 * configurable rows based on query pattern matching.
 */
class FakeSql {
  calls: Array<{ query: string; bindings: unknown[] }> = []
  private handlers: Array<{ pattern: string; rows: unknown[] }> = []

  /** Register rows to return when a query contains the given pattern. */
  onQuery(pattern: string, rows: unknown[]) {
    this.handlers.push({ pattern, rows })
  }

  exec(query: string, ...bindings: unknown[]) {
    this.calls.push({ query, bindings })
    const handler = this.handlers.find((h) => query.includes(h.pattern))
    const rows = handler?.rows ?? []
    return { toArray: () => [...rows] }
  }
}

function createFakeRegistry(sql: FakeSql) {
  const fakeCtx = {
    storage: {
      sql,
      delete: async () => true,
      getAlarm: async () => null,
      setAlarm: async () => {},
    },
  }
  const fakeEnv = {}

  // Ensure migration queries get sensible defaults
  sql.onQuery('MAX(version)', [{ version: 999 }])

  return new (ProjectRegistry as any)(fakeCtx, fakeEnv) as InstanceType<typeof ProjectRegistry>
}

describe('ProjectRegistry.searchSessions', () => {
  let sql: FakeSql
  let registry: InstanceType<typeof ProjectRegistry>

  beforeEach(() => {
    sql = new FakeSql()
    registry = createFakeRegistry(sql)
  })

  it('includes summary in the LIKE search', async () => {
    sql.onQuery('prompt LIKE', [])

    await registry.searchSessions('user-1', 'test query')

    const searchCall = sql.calls.find((c) => c.query.includes('prompt LIKE'))
    expect(searchCall).toBeDefined()
    expect(searchCall!.query).toContain('summary LIKE ?')

    // Should have userId + 7 pattern bindings (prompt, project, id, title, summary, agent, sdk_session_id)
    const pattern = '%test query%'
    const patternBindings = searchCall!.bindings.filter((b) => b === pattern)
    expect(patternBindings).toHaveLength(7)
  })

  it('passes userId as first binding', async () => {
    sql.onQuery('prompt LIKE', [])

    await registry.searchSessions('user-42', 'foo')

    const searchCall = sql.calls.find((c) => c.query.includes('prompt LIKE'))
    expect(searchCall!.bindings[0]).toBe('user-42')
  })
})

describe('ProjectRegistry.listSessionsPaginated', () => {
  let sql: FakeSql
  let registry: InstanceType<typeof ProjectRegistry>

  beforeEach(() => {
    sql = new FakeSql()
    registry = createFakeRegistry(sql)
  })

  it('returns sessions and total count with default options', async () => {
    sql.onQuery('COUNT(*)', [{ cnt: 3 }])
    sql.onQuery('LIMIT', [
      { id: 's1', status: 'done' },
      { id: 's2', status: 'running' },
    ])

    const result = await registry.listSessionsPaginated('user-1', {})

    expect(result.total).toBe(3)
    expect(result.sessions).toHaveLength(2)

    const selectCall = sql.calls.find(
      (c) => c.query.includes('FROM sessions') && c.query.includes('LIMIT'),
    )
    expect(selectCall).toBeDefined()
    expect(selectCall!.query).toContain('ORDER BY updated_at DESC')
    expect(selectCall!.bindings).toContain(50) // default limit
    expect(selectCall!.bindings).toContain(0) // default offset
  })

  it('applies status, project, and model filters', async () => {
    sql.onQuery('COUNT(*)', [{ cnt: 1 }])
    sql.onQuery('LIMIT', [{ id: 's1' }])

    await registry.listSessionsPaginated('user-1', {
      status: 'done',
      project: 'myproj',
      model: 'opus',
    })

    const countCall = sql.calls.find((c) => c.query.includes('COUNT(*)'))
    expect(countCall).toBeDefined()
    expect(countCall!.query).toContain('status = ?')
    expect(countCall!.query).toContain('project = ?')
    expect(countCall!.query).toContain('model = ?')
    expect(countCall!.bindings).toEqual(['user-1', 'done', 'myproj', 'opus'])
  })

  it('uses custom sort, limit, and offset', async () => {
    sql.onQuery('COUNT(*)', [{ cnt: 100 }])
    sql.onQuery('LIMIT', [])

    await registry.listSessionsPaginated('user-1', {
      sortBy: 'total_cost_usd',
      sortDir: 'asc',
      limit: 10,
      offset: 20,
    })

    const selectCall = sql.calls.find(
      (c) => c.query.includes('FROM sessions') && c.query.includes('LIMIT'),
    )
    expect(selectCall).toBeDefined()
    expect(selectCall!.query).toContain('ORDER BY total_cost_usd ASC')
    expect(selectCall!.bindings).toContain(10)
    expect(selectCall!.bindings).toContain(20)
  })

  it('defaults sortDir to DESC when not specified', async () => {
    sql.onQuery('COUNT(*)', [{ cnt: 0 }])
    sql.onQuery('LIMIT', [])

    await registry.listSessionsPaginated('user-1', {
      sortBy: 'created_at',
    })

    const selectCall = sql.calls.find(
      (c) => c.query.includes('FROM sessions') && c.query.includes('LIMIT'),
    )
    expect(selectCall!.query).toContain('ORDER BY created_at DESC')
  })

  it('does not add filter clauses when options are omitted', async () => {
    sql.onQuery('COUNT(*)', [{ cnt: 5 }])
    sql.onQuery('LIMIT', [])

    await registry.listSessionsPaginated('user-1', {})

    const countCall = sql.calls.find((c) => c.query.includes('COUNT(*)'))
    expect(countCall!.query).not.toContain('status = ?')
    expect(countCall!.query).not.toContain('project = ?')
    expect(countCall!.query).not.toContain('model = ?')
    // Only userId binding
    expect(countCall!.bindings).toEqual(['user-1'])
  })
})
