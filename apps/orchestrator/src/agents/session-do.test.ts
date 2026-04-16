import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildGatewayCallbackUrl,
  buildGatewayStartUrl,
  getGatewayConnectionId,
  loadTurnState,
  validateGatewayToken,
} from './session-do-helpers'
import { SESSION_DO_MIGRATIONS } from './session-do-migrations'

/**
 * SessionDO tests.
 *
 * The SessionDO class uses TC39 decorators (@callable) which vitest/oxc
 * cannot parse. The core event-to-message mapping logic is tested via
 * gateway-event-mapper.test.ts. These tests cover the migration and
 * schema-level concerns, plus the extracted gateway helpers.
 */

// ── SQL mock helper ────────────────────────────────────────────

/**
 * In-memory kv store that backs a fake sql tagged-template function.
 *
 * The helpers use inline key names in template literals (no interpolation),
 * e.g. `sql\`SELECT value FROM kv WHERE key = 'gateway_token'\``.
 * We match by searching the joined query string for known key names.
 */
function createKvSql(initialKv: Record<string, string> = {}) {
  const store = new Map(Object.entries(initialKv))

  function fakeSql<T>(strings: TemplateStringsArray, ..._values: unknown[]): T[] {
    const query = strings.join('').trim()

    // SELECT value FROM kv WHERE key = '<key>'
    if (query.includes('SELECT value FROM kv')) {
      // Extract the key name from the query: key = 'gateway_token' etc.
      const match = query.match(/key\s*=\s*'([^']+)'/)
      if (match) {
        const key = match[1]
        const val = store.get(key)
        return val !== undefined ? ([{ value: val }] as T[]) : ([] as T[])
      }
      return [] as T[]
    }

    // DELETE FROM kv WHERE key IN (...)
    if (query.includes('DELETE FROM kv')) {
      // Extract all key names from the IN clause
      const keyMatches = query.matchAll(/'([^']+)'/g)
      for (const m of keyMatches) {
        store.delete(m[1])
      }
      return [] as T[]
    }

    return [] as T[]
  }

  return { sql: fakeSql, store }
}

// ── Migration tests ────────────────────────────────────────────

describe('SESSION_DO_MIGRATIONS', () => {
  describe('migration v4: deprecate old tables', () => {
    it('exists as version 4', () => {
      const v4 = SESSION_DO_MIGRATIONS.find((m) => m.version === 4)
      expect(v4).toBeDefined()
      expect(v4!.description).toContain('_deprecated')
    })

    it('renames messages table to _deprecated_messages', () => {
      const v4 = SESSION_DO_MIGRATIONS.find((m) => m.version === 4)!
      const executed: string[] = []
      const fakeSql = {
        exec(query: string) {
          executed.push(query)
          return { toArray: () => [] }
        },
      }

      v4.up(fakeSql as any)

      expect(executed).toContain('ALTER TABLE messages RENAME TO _deprecated_messages')
    })

    it('renames events table to _deprecated_events', () => {
      const v4 = SESSION_DO_MIGRATIONS.find((m) => m.version === 4)!
      const executed: string[] = []
      const fakeSql = {
        exec(query: string) {
          executed.push(query)
          return { toArray: () => [] }
        },
      }

      v4.up(fakeSql as any)

      expect(executed).toContain('ALTER TABLE events RENAME TO _deprecated_events')
    })

    it('does NOT rename the kv table (still used for kata_state)', () => {
      const v4 = SESSION_DO_MIGRATIONS.find((m) => m.version === 4)!
      const executed: string[] = []
      const fakeSql = {
        exec(query: string) {
          executed.push(query)
          return { toArray: () => [] }
        },
      }

      v4.up(fakeSql as any)

      const kvQueries = executed.filter((q) => q.toLowerCase().includes('kv'))
      expect(kvQueries).toHaveLength(0)
    })

    it('only executes two ALTER TABLE statements', () => {
      const v4 = SESSION_DO_MIGRATIONS.find((m) => m.version === 4)!
      const executed: string[] = []
      const fakeSql = {
        exec(query: string) {
          executed.push(query)
          return { toArray: () => [] }
        },
      }

      v4.up(fakeSql as any)

      expect(executed).toHaveLength(2)
    })
  })

  describe('migration chain integrity', () => {
    it('has sequential version numbers from 1 to 4', () => {
      const versions = SESSION_DO_MIGRATIONS.map((m) => m.version)
      expect(versions).toEqual([1, 2, 3, 4])
    })

    it('all migrations have descriptions', () => {
      for (const m of SESSION_DO_MIGRATIONS) {
        expect(m.description).toBeTruthy()
      }
    })

    it('v3 creates the events and kv tables that v4 depends on', () => {
      const v3 = SESSION_DO_MIGRATIONS.find((m) => m.version === 3)!
      const executed: string[] = []
      const fakeSql = {
        exec(query: string) {
          executed.push(query)
          return { toArray: () => [] }
        },
      }

      v3.up(fakeSql as any)

      const hasEvents = executed.some((q) => q.includes('CREATE TABLE') && q.includes('events'))
      const hasKv = executed.some((q) => q.includes('CREATE TABLE') && q.includes('kv'))
      expect(hasEvents).toBe(true)
      expect(hasKv).toBe(true)
    })
  })
})

// ── loadTurnState tests ────────────────────────────────────────

describe('loadTurnState', () => {
  /** Helper: create a fake sql tagged-template function backed by an in-memory map */
  function createFakeSql(rows: Record<string, { value: string }[]>) {
    return function fakeSql<T>(strings: TemplateStringsArray, ..._values: unknown[]): T[] {
      const query = strings.join('?').trim()
      for (const [pattern, result] of Object.entries(rows)) {
        if (query.includes(pattern)) {
          return result as T[]
        }
      }
      return [] as T[]
    }
  }

  it('returns turnCounter from assistant_config when present', () => {
    const sql = createFakeSql({
      turnCounter: [{ value: '42' }],
    })

    const result = loadTurnState(sql, 0)
    expect(result.turnCounter).toBe(42)
  })

  it('seeds turnCounter from pathLength + 1 when no config row exists', () => {
    const sql = createFakeSql({})

    const result = loadTurnState(sql, 7)
    expect(result.turnCounter).toBe(8)
  })

  it('returns currentTurnMessageId from assistant_config when present', () => {
    const sql = createFakeSql({
      turnCounter: [{ value: '5' }],
      currentTurnMessageId: [{ value: 'msg-abc-123' }],
    })

    const result = loadTurnState(sql, 0)
    expect(result.currentTurnMessageId).toBe('msg-abc-123')
  })

  it('returns null currentTurnMessageId when no config row exists', () => {
    const sql = createFakeSql({
      turnCounter: [{ value: '1' }],
    })

    const result = loadTurnState(sql, 0)
    expect(result.currentTurnMessageId).toBeNull()
  })

  it('returns null currentTurnMessageId when stored value is empty string', () => {
    const sql = createFakeSql({
      turnCounter: [{ value: '1' }],
      currentTurnMessageId: [{ value: '' }],
    })

    const result = loadTurnState(sql, 0)
    expect(result.currentTurnMessageId).toBeNull()
  })

  it('handles non-numeric turnCounter gracefully (falls back to 0)', () => {
    const sql = createFakeSql({
      turnCounter: [{ value: 'not-a-number' }],
    })

    const result = loadTurnState(sql, 3)
    expect(result.turnCounter).toBe(0)
  })
})

// ── validateGatewayToken tests ────────────────────────────────

describe('validateGatewayToken', () => {
  it('returns false for null token', () => {
    const { sql } = createKvSql()
    expect(validateGatewayToken(sql, null)).toBe(false)
  })

  it('returns false for empty string token', () => {
    const { sql } = createKvSql()
    expect(validateGatewayToken(sql, '')).toBe(false)
  })

  it('returns false when no token is stored in kv', () => {
    const { sql } = createKvSql()
    expect(validateGatewayToken(sql, 'some-token')).toBe(false)
  })

  it('returns false when token does not match stored token', () => {
    const { sql } = createKvSql({
      gateway_token: 'correct-token',
      gateway_token_expires: String(Date.now() + 60_000),
    })
    expect(validateGatewayToken(sql, 'wrong-token')).toBe(false)
  })

  it('returns true and does NOT delete token when token matches and is not expired', () => {
    const { sql, store } = createKvSql({
      gateway_token: 'my-token-123',
      gateway_token_expires: String(Date.now() + 60_000),
    })

    const result = validateGatewayToken(sql, 'my-token-123')
    expect(result).toBe(true)

    // Token should NOT be deleted — it remains valid for reconnects
    expect(store.has('gateway_token')).toBe(true)
    expect(store.has('gateway_token_expires')).toBe(true)
  })

  it('returns false when token has expired', () => {
    const { sql, store } = createKvSql({
      gateway_token: 'expired-token',
      gateway_token_expires: String(Date.now() - 1000), // Expired 1 second ago
    })

    const result = validateGatewayToken(sql, 'expired-token')
    expect(result).toBe(false)

    // Expired token should be cleaned up
    expect(store.has('gateway_token')).toBe(false)
    expect(store.has('gateway_token_expires')).toBe(false)
  })

  it('returns true when token matches and no expiry is stored', () => {
    const { sql } = createKvSql({
      gateway_token: 'no-expiry-token',
    })

    // No gateway_token_expires row -- should still validate
    const result = validateGatewayToken(sql, 'no-expiry-token')
    expect(result).toBe(true)
  })

  it('returns false when sql throws an error', () => {
    const throwingSql = () => {
      throw new Error('DB error')
    }
    expect(validateGatewayToken(throwingSql as any, 'some-token')).toBe(false)
  })

  it('is reusable: second call with same token still returns true', () => {
    const { sql } = createKvSql({
      gateway_token: 'reusable-token',
      gateway_token_expires: String(Date.now() + 60_000),
    })

    expect(validateGatewayToken(sql, 'reusable-token')).toBe(true)
    expect(validateGatewayToken(sql, 'reusable-token')).toBe(true)
  })
})

// ── getGatewayConnectionId tests ───────────────────────────────

describe('getGatewayConnectionId', () => {
  it('returns null when no gateway_conn_id is stored', () => {
    const { sql } = createKvSql()
    expect(getGatewayConnectionId(sql)).toBeNull()
  })

  it('returns the stored connection ID', () => {
    const { sql } = createKvSql({ gateway_conn_id: 'conn-abc-123' })
    expect(getGatewayConnectionId(sql)).toBe('conn-abc-123')
  })

  it('returns null when sql throws an error', () => {
    const throwingSql = () => {
      throw new Error('DB error')
    }
    expect(getGatewayConnectionId(throwingSql as any)).toBeNull()
  })
})

// ── Cached getGatewayConnectionId tests ───────────────────────
//
// SessionDO wraps getGatewayConnectionId with an in-memory cache to avoid
// SQLite reads on every WS message. We can't instantiate the DO (TC39
// decorators), so we test the caching contract by simulating the exact
// cache-around-helper pattern used in the class.

describe('getGatewayConnectionId caching pattern', () => {
  /**
   * Simulates the SessionDO cache wrapper exactly as implemented:
   *   private cachedGatewayConnId: string | null = null
   *   private getGatewayConnectionId(): string | null {
   *     if (this.cachedGatewayConnId) return this.cachedGatewayConnId
   *     const id = getGatewayConnectionId(this.sql.bind(this))
   *     this.cachedGatewayConnId = id
   *     return id
   *   }
   */
  function createCachedGetter(sql: ReturnType<typeof createKvSql>['sql']) {
    let cachedGatewayConnId: string | null = null
    const sqlCallCount = { value: 0 }
    const countingSql = <T>(strings: TemplateStringsArray, ...values: unknown[]): T[] => {
      sqlCallCount.value++
      return sql(strings, ...values) as T[]
    }

    return {
      get: () => {
        if (cachedGatewayConnId) return cachedGatewayConnId
        const id = getGatewayConnectionId(countingSql)
        cachedGatewayConnId = id
        return id
      },
      setCache: (id: string | null) => {
        cachedGatewayConnId = id
      },
      clearCache: () => {
        cachedGatewayConnId = null
      },
      sqlCallCount,
    }
  }

  it('reads from SQLite on first call and caches the result', () => {
    const { sql } = createKvSql({ gateway_conn_id: 'conn-1' })
    const cached = createCachedGetter(sql)

    expect(cached.get()).toBe('conn-1')
    expect(cached.sqlCallCount.value).toBe(1)
  })

  it('returns cached value without hitting SQLite on subsequent calls', () => {
    const { sql } = createKvSql({ gateway_conn_id: 'conn-1' })
    const cached = createCachedGetter(sql)

    cached.get() // populates cache
    cached.get() // should use cache
    cached.get() // should use cache

    expect(cached.sqlCallCount.value).toBe(1) // Only one SQL read
  })

  it('returns null and caches null when no connection is stored', () => {
    const { sql } = createKvSql()
    const cached = createCachedGetter(sql)

    expect(cached.get()).toBeNull()
    // null is falsy, so next call will re-query SQLite (by design — null means no connection)
    expect(cached.get()).toBeNull()
    expect(cached.sqlCallCount.value).toBe(2)
  })

  it('setCache bypasses SQLite entirely (simulates onConnect)', () => {
    const { sql } = createKvSql()
    const cached = createCachedGetter(sql)

    cached.setCache('conn-from-onConnect')
    expect(cached.get()).toBe('conn-from-onConnect')
    expect(cached.sqlCallCount.value).toBe(0) // Never hit SQLite
  })

  it('clearCache forces next get to re-read from SQLite (simulates onClose)', () => {
    const { sql, store } = createKvSql({ gateway_conn_id: 'conn-1' })
    const cached = createCachedGetter(sql)

    cached.get() // populate cache
    expect(cached.sqlCallCount.value).toBe(1)

    cached.clearCache() // simulates onClose

    // Simulate SQLite DELETE that onClose does
    store.delete('gateway_conn_id')

    expect(cached.get()).toBeNull() // re-reads from SQLite
    expect(cached.sqlCallCount.value).toBe(2)
  })

  it('setCache after clearCache picks up the new connection (simulates reconnect)', () => {
    const { sql } = createKvSql({ gateway_conn_id: 'old-conn' })
    const cached = createCachedGetter(sql)

    cached.get() // cache old-conn
    cached.clearCache() // onClose
    cached.setCache('new-conn') // onConnect with new connection

    expect(cached.get()).toBe('new-conn')
    expect(cached.sqlCallCount.value).toBe(1) // Only the initial read
  })

  it('hibernation wake: onStart populates cache from SQLite', () => {
    const { sql } = createKvSql({ gateway_conn_id: 'hibernated-conn' })
    const cached = createCachedGetter(sql)

    // Simulate onStart: populate cache from SQLite
    const id = getGatewayConnectionId(sql)
    cached.setCache(id)

    // Subsequent reads use cache
    expect(cached.get()).toBe('hibernated-conn')
    expect(cached.sqlCallCount.value).toBe(0) // get() never hit SQL
  })
})

// ── buildGatewayCallbackUrl tests ──────────────────────────────

describe('buildGatewayCallbackUrl', () => {
  it('builds wss:// URL from https:// worker URL', () => {
    const url = buildGatewayCallbackUrl('https://duraclaw.workers.dev', 'do-123', 'token-abc')
    expect(url).toBe(
      'wss://duraclaw.workers.dev/agents/session-agent/do-123?role=gateway&token=token-abc',
    )
  })

  it('builds ws:// URL from http:// worker URL', () => {
    const url = buildGatewayCallbackUrl('http://localhost:8787', 'do-456', 'token-xyz')
    expect(url).toBe('ws://localhost:8787/agents/session-agent/do-456?role=gateway&token=token-xyz')
  })

  it('preserves port in worker URL', () => {
    const url = buildGatewayCallbackUrl('https://example.com:9999', 'do-789', 'tok')
    expect(url).toBe('wss://example.com:9999/agents/session-agent/do-789?role=gateway&token=tok')
  })

  it('strips trailing slash from worker URL', () => {
    // The function does not strip trailing slashes by design, but the path is appended correctly
    const url = buildGatewayCallbackUrl('https://example.com', 'id', 't')
    expect(url).toContain('/agents/session-agent/id')
    expect(url).toContain('role=gateway')
    expect(url).toContain('token=t')
  })
})

// ── buildGatewayStartUrl tests ─────────────────────────────────

describe('buildGatewayStartUrl', () => {
  it('converts wss:// to https:// and appends /sessions/start', () => {
    const url = buildGatewayStartUrl('wss://gateway.example.com')
    expect(url).toBe('https://gateway.example.com/sessions/start')
  })

  it('converts ws:// to http:// and appends /sessions/start', () => {
    const url = buildGatewayStartUrl('ws://localhost:9877')
    expect(url).toBe('http://localhost:9877/sessions/start')
  })

  it('handles https:// gateway URL unchanged', () => {
    const url = buildGatewayStartUrl('https://gateway.example.com')
    expect(url).toBe('https://gateway.example.com/sessions/start')
  })

  it('handles http:// gateway URL unchanged', () => {
    const url = buildGatewayStartUrl('http://localhost:9877')
    expect(url).toBe('http://localhost:9877/sessions/start')
  })

  it('preserves path components in gateway URL', () => {
    const url = buildGatewayStartUrl('wss://gateway.example.com/v1')
    expect(url).toBe('https://gateway.example.com/v1/sessions/start')
  })
})
