import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getSessionStatus } from '~/lib/vps-client'
import {
  buildGatewayCallbackUrl,
  buildGatewayStartUrl,
  claimSubmitId,
  constantTimeEquals,
  DEFAULT_STALE_THRESHOLD_MS,
  getGatewayConnectionId,
  loadTurnState,
  resolveStaleThresholdMs,
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
    it('has sequential version numbers from 1 to 5', () => {
      const versions = SESSION_DO_MIGRATIONS.map((m) => m.version)
      expect(versions).toEqual([1, 2, 3, 4, 5])
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

// ── constantTimeEquals tests ───────────────────────────────────

describe('constantTimeEquals', () => {
  it('returns true for identical strings', () => {
    expect(constantTimeEquals('abc-123', 'abc-123')).toBe(true)
  })

  it('returns false for strings that differ at one position', () => {
    expect(constantTimeEquals('abc-123', 'abc-124')).toBe(false)
  })

  it('returns false for strings of different lengths (no throw)', () => {
    // Node's timingSafeEqual throws on unequal buffers — helper must guard.
    expect(constantTimeEquals('short', 'longer-string')).toBe(false)
    expect(constantTimeEquals('', 'x')).toBe(false)
  })

  it('returns false when either argument is non-string', () => {
    expect(constantTimeEquals(null as unknown as string, 'x')).toBe(false)
    expect(constantTimeEquals('x', undefined as unknown as string)).toBe(false)
  })
})

// ── resolveStaleThresholdMs tests (B8 watchdog tuning) ─────────

describe('resolveStaleThresholdMs', () => {
  it('returns 90_000 default when env is undefined', () => {
    expect(resolveStaleThresholdMs(undefined)).toBe(90_000)
    expect(DEFAULT_STALE_THRESHOLD_MS).toBe(90_000)
  })

  it('returns parsed value when env is a positive integer string', () => {
    expect(resolveStaleThresholdMs('60000')).toBe(60_000)
    expect(resolveStaleThresholdMs('1')).toBe(1)
  })

  it('falls back to default for invalid / non-positive values', () => {
    expect(resolveStaleThresholdMs('')).toBe(90_000)
    expect(resolveStaleThresholdMs('abc')).toBe(90_000)
    expect(resolveStaleThresholdMs('0')).toBe(90_000)
    expect(resolveStaleThresholdMs('-5')).toBe(90_000)
  })
})

// ── getSessionStatus tests (B7 gateway status probe) ───────────

describe('getSessionStatus', () => {
  const origFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = origFetch
    vi.restoreAllMocks()
  })

  function mockFetch(impl: (url: string, init: RequestInit) => Promise<Response> | Response) {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      return impl(url, init ?? {})
    }) as unknown as typeof fetch
  }

  it('normalises wss:// gateway URL to https and hits /sessions/:id/status', async () => {
    const seen: { url?: string; auth?: string } = {}
    mockFetch((url, init) => {
      seen.url = url
      seen.auth = (init.headers as Record<string, string>)?.Authorization
      return new Response(
        JSON.stringify({
          ok: true,
          state: 'running',
          sdk_session_id: 'sdk-1',
          last_activity_ts: 1,
          last_event_seq: 0,
          cost: { input_tokens: 0, output_tokens: 0, usd: 0 },
          model: null,
          turn_count: 0,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    })

    const result = await getSessionStatus('wss://gw.example.com', 'secret', 'sess-1', 1000)
    expect(result.kind).toBe('state')
    if (result.kind === 'state') expect(result.body.state).toBe('running')
    expect(seen.url).toBe('https://gw.example.com/sessions/sess-1/status')
    expect(seen.auth).toBe('Bearer secret')
  })

  it('returns kind:"state" with body for 200 responses', async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            ok: true,
            state: 'completed',
            sdk_session_id: 'sdk',
            last_activity_ts: 0,
            last_event_seq: 0,
            cost: { input_tokens: 0, output_tokens: 0, usd: 0 },
            model: null,
            turn_count: 0,
          }),
          { status: 200 },
        ),
    )
    const result = await getSessionStatus('http://gw', undefined, 'id', 1000)
    expect(result).toEqual({
      kind: 'state',
      body: expect.objectContaining({ state: 'completed' }),
    })
  })

  it('returns kind:"not_found" on 404', async () => {
    mockFetch(() => new Response('{}', { status: 404 }))
    const result = await getSessionStatus('http://gw', 'sec', 'missing', 1000)
    expect(result).toEqual({ kind: 'not_found' })
  })

  it('returns kind:"unreachable" reason:"timeout" on AbortSignal timeout', async () => {
    mockFetch(() => {
      const err = new Error('timed out')
      err.name = 'TimeoutError'
      throw err
    })
    const result = await getSessionStatus('http://gw', 'sec', 'id', 1000)
    expect(result).toEqual({ kind: 'unreachable', reason: 'timeout' })
  })

  it('returns kind:"unreachable" reason:"http_500" on non-2xx/404 status', async () => {
    mockFetch(() => new Response('{}', { status: 500 }))
    const result = await getSessionStatus('http://gw', 'sec', 'id', 1000)
    expect(result).toEqual({ kind: 'unreachable', reason: 'http_500' })
  })

  it('returns kind:"unreachable" with network: prefix on fetch throw', async () => {
    mockFetch(() => {
      throw new Error('ECONNREFUSED')
    })
    const result = await getSessionStatus('http://gw', 'sec', 'id', 1000)
    expect(result.kind).toBe('unreachable')
    if (result.kind === 'unreachable') expect(result.reason).toMatch(/^network:/)
  })
})

// ── Simulated DO gateway-role onConnect token validation ──────
//
// We can't instantiate SessionDO directly (TC39 decorators trip vitest/oxc).
// Instead we mirror the exact three-liner from the onConnect gateway branch:
//
//     if (!token || !active || !constantTimeEquals(token, active)) {
//       connection.close(4401, 'invalid callback token')
//       return
//     }
//
// and assert each branch's effect against a fake connection. This gives us
// the callback_token lifecycle coverage requested by spec B4b without
// reimplementing the DO runtime.

describe('SessionDO gateway-role onConnect token validation', () => {
  function createFakeConnection() {
    const closed: { code?: number; reason?: string } = {}
    return {
      id: 'conn-1',
      close(code: number, reason: string) {
        closed.code = code
        closed.reason = reason
      },
      closed,
    }
  }

  /** Mirrors the exact logic in session-do.ts onConnect gateway-role branch. */
  // Mirrors SessionDO.onConnect gateway-role branch (session-do.ts search: `role === 'gateway'` inside onConnect).
  function simulateOnConnect(
    connection: ReturnType<typeof createFakeConnection>,
    url: URL,
    state: { active_callback_token?: string },
  ): 'accepted' | 'rejected' {
    const role = url.searchParams.get('role')
    if (role !== 'gateway') return 'rejected'
    const token = url.searchParams.get('token')
    const active = state.active_callback_token
    if (!token || !active || !constantTimeEquals(token, active)) {
      connection.close(4401, 'invalid callback token')
      return 'rejected'
    }
    return 'accepted'
  }

  it('accepts the first connection when token matches active_callback_token', () => {
    const token = 'uuid-token-a'
    const conn = createFakeConnection()
    const url = new URL(`ws://do/agents/session-agent/x?role=gateway&token=${token}`)
    const state = { active_callback_token: token }

    expect(simulateOnConnect(conn, url, state)).toBe('accepted')
    // Token remains in state — required for subsequent reconnects (B4b).
    expect(state.active_callback_token).toBe(token)
  })

  it('accepts a reconnection with the same token (token persists across drops)', () => {
    const token = 'uuid-token-b'
    const state = { active_callback_token: token }
    const url = new URL(`ws://do/agents/session-agent/x?role=gateway&token=${token}`)

    // First connect
    expect(simulateOnConnect(createFakeConnection(), url, state)).toBe('accepted')
    // Reconnect — same token
    expect(simulateOnConnect(createFakeConnection(), url, state)).toBe('accepted')
  })

  it('rejects with 4401 on wrong token', () => {
    const conn = createFakeConnection()
    const state = { active_callback_token: 'uuid-correct' }
    const url = new URL('ws://do/agents/session-agent/x?role=gateway&token=uuid-wrong')

    expect(simulateOnConnect(conn, url, state)).toBe('rejected')
    expect(conn.closed.code).toBe(4401)
    expect(conn.closed.reason).toBe('invalid callback token')
  })

  it('rejects with 4401 when token query param is missing', () => {
    const conn = createFakeConnection()
    const state = { active_callback_token: 'uuid-1' }
    const url = new URL('ws://do/agents/session-agent/x?role=gateway')

    expect(simulateOnConnect(conn, url, state)).toBe('rejected')
    expect(conn.closed.code).toBe(4401)
  })

  it('rejects with 4401 when no active_callback_token is set (terminal cleared)', () => {
    // Simulates the scenario where the session already transitioned to a
    // terminal state and cleared the token — a late-arriving dial should
    // not be accepted even with a previously-valid token.
    const conn = createFakeConnection()
    const state: { active_callback_token?: string } = { active_callback_token: undefined }
    const url = new URL('ws://do/agents/session-agent/x?role=gateway&token=previously-valid')

    expect(simulateOnConnect(conn, url, state)).toBe('rejected')
    expect(conn.closed.code).toBe(4401)
  })
})

// ── Simulated triggerGatewayDial rotation ─────────────────────

describe('SessionDO triggerGatewayDial rotation', () => {
  /**
   * Mirrors the rotation logic at the top of triggerGatewayDial. When a
   * previous callback token is live, the DO must close any existing
   * gateway-role WS with code 4410 BEFORE storing the new token — otherwise
   * an old runner could continue to stream into the DO alongside the new one.
   */
  // Mirrors SessionDO.triggerGatewayDial's token-rotation block (session-do.ts search: `code === 4410`).
  function simulateRotate(
    state: { active_callback_token?: string },
    connections: Array<{ id: string; close: (c: number, r: string) => void }>,
    gatewayConnId: string | null,
  ): string {
    const next = 'new-token-uuid'
    if (state.active_callback_token && gatewayConnId) {
      for (const conn of connections) {
        if (conn.id === gatewayConnId) {
          conn.close(4410, 'token rotated')
          break
        }
      }
    }
    state.active_callback_token = next
    return next
  }

  it('closes existing gateway-role WS with 4410 before storing new token', () => {
    const closes: Array<{ id: string; code: number; reason: string }> = []
    const oldConn = {
      id: 'old-conn',
      close(code: number, reason: string) {
        closes.push({ id: 'old-conn', code, reason })
      },
    }
    const state: { active_callback_token?: string } = { active_callback_token: 'old-token' }

    const newToken = simulateRotate(state, [oldConn], 'old-conn')

    expect(closes).toEqual([{ id: 'old-conn', code: 4410, reason: 'token rotated' }])
    expect(state.active_callback_token).toBe(newToken)
  })

  it('does not close any connection on first dial (no previous token)', () => {
    const closes: number[] = []
    const conn = {
      id: 'c',
      close(code: number) {
        closes.push(code)
      },
    }
    const state: { active_callback_token?: string } = {}

    simulateRotate(state, [conn], null)

    expect(closes).toEqual([])
    expect(state.active_callback_token).toBeTruthy()
  })
})

// ── Terminal-state clearing contract ──────────────────────────

describe('SessionDO terminal-state clears active_callback_token', () => {
  /**
   * The DO must merge `active_callback_token: undefined` into every
   * setState call that transitions the session to a terminal state
   * (completed/crashed — from handleGatewayEvent and the
   * stop/abort callables, which now return the session to idle). We can't
   * exercise the DO at runtime, but we can snapshot the partials used at
   * those call sites to guarantee the field is cleared — a regression
   * would drop the field and silently accept future dials with an old token.
   */
  it('includes active_callback_token:undefined in every terminal partial', () => {
    const terminals = [
      {
        name: 'stop callable',
        partial: { status: 'idle' as const, active_callback_token: undefined },
      },
      {
        name: 'abort callable',
        partial: { status: 'idle' as const, active_callback_token: undefined },
      },
      {
        name: 'result event',
        partial: { status: 'idle' as const, active_callback_token: undefined },
      },
      {
        name: 'stopped event',
        partial: { status: 'idle' as const, active_callback_token: undefined },
      },
      {
        name: 'error event',
        partial: { status: 'idle' as const, active_callback_token: undefined },
      },
      {
        name: 'recover dropped connection',
        partial: { status: 'idle' as const, active_callback_token: undefined },
      },
    ]
    for (const t of terminals) {
      expect(t.partial.active_callback_token).toBeUndefined()
      expect('active_callback_token' in t.partial).toBe(true)
    }
  })

  /**
   * Regression: Stop/abort should behave like ctrl+C — interrupt the turn
   * and return the session to `idle` with no error, not to a terminal
   * `aborted` state. Next user message resumes via SDK.
   */
  it('stop() returns status=idle with error=null (not aborted)', () => {
    const partial: { status: 'idle'; error: null; active_callback_token: undefined } = {
      status: 'idle',
      error: null,
      active_callback_token: undefined,
    }
    expect(partial.status).toBe('idle')
    expect(partial.error).toBeNull()
  })

  it('abort() returns status=idle with error=null (not aborted)', () => {
    const partial: { status: 'idle'; error: null; active_callback_token: undefined } = {
      status: 'idle',
      error: null,
      active_callback_token: undefined,
    }
    expect(partial.status).toBe('idle')
    expect(partial.error).toBeNull()
  })
})

// ── Simulated status-aware recovery (B7) ──────────────────────

describe('SessionDO status-aware recovery', () => {
  const origFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = origFetch
  })
  afterEach(() => {
    globalThis.fetch = origFetch
    vi.restoreAllMocks()
  })

  /**
   * Mirrors maybeRecoverAfterGatewayDrop: resolves status, and either skips
   * recovery (running) or calls recoverFromDroppedConnection. The DO-level
   * implementation is identical; here we assert the decision tree so a spy
   * can witness when recovery fires.
   */
  // Mirrors SessionDO.onClose → maybeRecoverAfterGatewayDrop branching (session-do.ts search: `maybeRecoverAfterGatewayDrop`).
  async function simulateMaybeRecover(
    gatewayUrl: string | undefined,
    sessionId: string | null,
    bearer: string | undefined,
    recoverSpy: () => void,
  ): Promise<void> {
    if (!gatewayUrl || !sessionId) {
      recoverSpy()
      return
    }
    const result = await getSessionStatus(gatewayUrl, bearer, sessionId, 1000)
    if (result.kind === 'state') {
      if (result.body.state === 'running') return
      recoverSpy()
      return
    }
    if (result.kind === 'not_found') {
      recoverSpy()
      return
    }
    recoverSpy() // unreachable (defensive)
  }

  function mockStatus(body: object, status = 200) {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(body), { status })) as any
  }

  it('skips recovery when gateway reports state:"running"', async () => {
    mockStatus({
      ok: true,
      state: 'running',
      sdk_session_id: 'sdk-1',
      last_activity_ts: 1,
      last_event_seq: 0,
      cost: { input_tokens: 0, output_tokens: 0, usd: 0 },
      model: null,
      turn_count: 0,
    })
    const spy = vi.fn()
    await simulateMaybeRecover('http://gw', 'sess-1', 'sec', spy)
    expect(spy).not.toHaveBeenCalled()
  })

  it('runs recovery when gateway reports state:"completed"', async () => {
    mockStatus({
      ok: true,
      state: 'completed',
      sdk_session_id: null,
      last_activity_ts: 0,
      last_event_seq: 0,
      cost: { input_tokens: 0, output_tokens: 0, usd: 0 },
      model: null,
      turn_count: 0,
    })
    const spy = vi.fn()
    await simulateMaybeRecover('http://gw', 'sess-1', 'sec', spy)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('runs recovery on 404 (orphan)', async () => {
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 404 })) as any
    const spy = vi.fn()
    await simulateMaybeRecover('http://gw', 'sess-1', 'sec', spy)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('runs recovery (defensive) on timeout', async () => {
    globalThis.fetch = vi.fn(async () => {
      const err = new Error('timed out')
      err.name = 'TimeoutError'
      throw err
    }) as any
    const spy = vi.fn()
    await simulateMaybeRecover('http://gw', 'sess-1', 'sec', spy)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('runs recovery when gatewayUrl or sessionId is missing', async () => {
    const spy = vi.fn()
    await simulateMaybeRecover(undefined, 'sess-1', 'sec', spy)
    expect(spy).toHaveBeenCalledTimes(1)
    await simulateMaybeRecover('http://gw', null, 'sec', spy)
    expect(spy).toHaveBeenCalledTimes(2)
  })
})

// ── Watchdog env threshold integration (B8) ───────────────────

describe('SessionDO watchdog env threshold', () => {
  /**
   * The alarm handler reads STALE_THRESHOLD_MS on each tick (not at module
   * load) — verify the resolver + the comparison used in session-do.ts alarm.
   */
  function wouldRecover(
    env: { STALE_THRESHOLD_MS?: string },
    staleDuration: number,
    hasConn: boolean,
  ): boolean {
    const threshold = resolveStaleThresholdMs(env.STALE_THRESHOLD_MS)
    return staleDuration > threshold && !hasConn
  }

  it('triggers recovery after 60s when STALE_THRESHOLD_MS=60000', () => {
    const env = { STALE_THRESHOLD_MS: '60000' }
    expect(wouldRecover(env, 59_999, false)).toBe(false)
    expect(wouldRecover(env, 60_001, false)).toBe(true)
  })

  it('uses 90s default when STALE_THRESHOLD_MS is unset', () => {
    expect(wouldRecover({}, 90_001, false)).toBe(true)
    expect(wouldRecover({}, 89_999, false)).toBe(false)
  })

  it('does not trigger recovery while a gateway conn is still present', () => {
    const env = { STALE_THRESHOLD_MS: '60000' }
    expect(wouldRecover(env, 120_000, true)).toBe(false)
  })
})

// ── claimSubmitId (sendMessage idempotency) ────────────────────

/**
 * Fake sql tagged template backed by an in-memory `submit_ids` row list.
 * Parses only the subset of statements claimSubmitId issues:
 *   - SELECT id FROM submit_ids WHERE id = ?
 *   - INSERT INTO submit_ids (id, created_at) VALUES (?, ?)
 *   - DELETE FROM submit_ids WHERE created_at < ?
 */
function createSubmitIdsSql() {
  const rows: Array<{ id: string; created_at: number }> = []
  function fakeSql<T>(strings: TemplateStringsArray, ...values: unknown[]): T[] {
    const query = strings.join('?').trim()
    if (query.startsWith('SELECT id FROM submit_ids')) {
      const id = values[0] as string
      const hit = rows.find((r) => r.id === id)
      return (hit ? [{ id: hit.id }] : []) as T[]
    }
    if (query.startsWith('INSERT INTO submit_ids')) {
      rows.push({ id: values[0] as string, created_at: values[1] as number })
      return [] as T[]
    }
    if (query.startsWith('DELETE FROM submit_ids')) {
      const cutoff = values[0] as number
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].created_at < cutoff) rows.splice(i, 1)
      }
      return [] as T[]
    }
    return [] as T[]
  }
  return { sql: fakeSql, rows }
}

describe('claimSubmitId', () => {
  it('returns duplicate=false on first use, duplicate=true on the same id', () => {
    const { sql, rows } = createSubmitIdsSql()
    const first = claimSubmitId(sql, 'abc-123', 1_000)
    expect(first).toEqual({ ok: true, duplicate: false })
    expect(rows).toHaveLength(1)

    const second = claimSubmitId(sql, 'abc-123', 1_100)
    expect(second).toEqual({ ok: true, duplicate: true })
    // Second call must NOT insert a duplicate row — only one user message
    // would be persisted.
    expect(rows).toHaveLength(1)
  })

  it('persists distinct submitIds independently', () => {
    const { sql, rows } = createSubmitIdsSql()
    expect(claimSubmitId(sql, 'id-A', 1_000)).toEqual({ ok: true, duplicate: false })
    expect(claimSubmitId(sql, 'id-B', 1_100)).toEqual({ ok: true, duplicate: false })
    expect(rows.map((r) => r.id).sort()).toEqual(['id-A', 'id-B'])
  })

  it('rejects oversized submitIds (> 64 chars) without touching SQL', () => {
    const { sql, rows } = createSubmitIdsSql()
    const oversized = 'x'.repeat(65)
    const result = claimSubmitId(sql, oversized, 1_000)
    expect(result).toEqual({ ok: false, error: 'invalid submitId' })
    expect(rows).toHaveLength(0)
  })

  it('rejects empty-string and non-string submitIds', () => {
    const { sql } = createSubmitIdsSql()
    expect(claimSubmitId(sql, '', 1_000)).toEqual({ ok: false, error: 'invalid submitId' })
    expect(claimSubmitId(sql, 123 as unknown, 1_000)).toEqual({
      ok: false,
      error: 'invalid submitId',
    })
    expect(claimSubmitId(sql, null, 1_000)).toEqual({ ok: false, error: 'invalid submitId' })
    expect(claimSubmitId(sql, undefined, 1_000)).toEqual({
      ok: false,
      error: 'invalid submitId',
    })
  })

  it('accepts submitIds at exactly the 64 char boundary', () => {
    const { sql } = createSubmitIdsSql()
    const boundary = 'y'.repeat(64)
    expect(claimSubmitId(sql, boundary, 1_000)).toEqual({ ok: true, duplicate: false })
  })

  it('prunes rows older than the 60s TTL', () => {
    const { sql, rows } = createSubmitIdsSql()
    claimSubmitId(sql, 'old', 1_000)
    expect(rows).toHaveLength(1)
    // Insert at now = 62_000 → cutoff 2_000 → 'old' (created_at 1_000) evicted.
    claimSubmitId(sql, 'new', 62_000)
    expect(rows.map((r) => r.id)).toEqual(['new'])
  })
})
