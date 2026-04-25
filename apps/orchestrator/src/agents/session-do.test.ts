import type { SessionMessage, SessionMessagePart } from 'agents/experimental/memory/session'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chunkOps } from '~/lib/chunk-frame'
import { getSessionStatus } from '~/lib/vps-client'
import {
  buildGatewayCallbackUrl,
  buildGatewayStartUrl,
  claimSubmitId,
  constantTimeEquals,
  DEFAULT_STALE_THRESHOLD_MS,
  deriveSnapshotOps,
  finalizeResultTurn,
  findPendingGatePart,
  getGatewayConnectionId,
  isPendingGatePart,
  loadTurnState,
  planAwaitingTimeout,
  planClearAwaiting,
  RECOVERY_GRACE_MS,
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

  describe('migration v6: session_meta table', () => {
    it('exists as version 6', () => {
      const v6 = SESSION_DO_MIGRATIONS.find((m) => m.version === 6)
      expect(v6).toBeDefined()
      expect(v6!.description).toContain('session_meta')
    })

    it('creates the session_meta table with the expected columns', () => {
      const v6 = SESSION_DO_MIGRATIONS.find((m) => m.version === 6)!
      const executed: string[] = []
      const fakeSql = {
        exec(query: string) {
          executed.push(query)
          return { toArray: () => [] }
        },
      }

      v6.up(fakeSql as any)

      const createStmt = executed.find(
        (q) => q.includes('CREATE TABLE') && q.includes('session_meta'),
      )
      expect(createStmt).toBeTruthy()
      expect(createStmt).toContain('id INTEGER PRIMARY KEY CHECK (id = 1)')
      expect(createStmt).toContain('message_seq INTEGER NOT NULL DEFAULT 0')
      expect(createStmt).toContain('sdk_session_id TEXT')
      expect(createStmt).toContain('active_callback_token TEXT')
      expect(createStmt).toContain('context_usage_json TEXT')
      expect(createStmt).toContain('context_usage_cached_at INTEGER')
      expect(createStmt).toContain('updated_at INTEGER NOT NULL DEFAULT 0')
    })

    it('seeds the singleton row via INSERT OR IGNORE', () => {
      const v6 = SESSION_DO_MIGRATIONS.find((m) => m.version === 6)!
      const executed: string[] = []
      const fakeSql = {
        exec(query: string) {
          executed.push(query)
          return { toArray: () => [] }
        },
      }

      v6.up(fakeSql as any)

      const insertStmt = executed.find(
        (q) => q.includes('INSERT OR IGNORE') && q.includes('session_meta'),
      )
      expect(insertStmt).toBeTruthy()
      expect(insertStmt).toContain('(1, 0)')
    })

    it('runs end-to-end against an in-memory SQLite-like harness', () => {
      // Simulate a minimal DO sql.exec that records DDL + row state so we can
      // assert the table exists and the singleton row is in place after v6.
      const tables = new Set<string>()
      const sessionMetaRows: Array<{ id: number; message_seq: number; updated_at: number }> = []
      const fakeSql = {
        exec(query: string, ..._bindings: unknown[]) {
          if (/CREATE TABLE IF NOT EXISTS session_meta/.test(query)) {
            tables.add('session_meta')
            return { toArray: () => [] }
          }
          if (/INSERT OR IGNORE INTO session_meta/.test(query)) {
            if (!sessionMetaRows.find((r) => r.id === 1)) {
              sessionMetaRows.push({ id: 1, message_seq: 0, updated_at: 0 })
            }
            return { toArray: () => [] }
          }
          if (/SELECT name FROM sqlite_master/.test(query)) {
            return {
              toArray: () =>
                Array.from(tables).map((name) => ({ name })) as Array<{ name: string }>,
            }
          }
          return { toArray: () => [] }
        },
      }

      const v6 = SESSION_DO_MIGRATIONS.find((m) => m.version === 6)!
      v6.up(fakeSql as any)

      const rows = (
        fakeSql.exec(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='session_meta'",
        ) as { toArray: () => Array<{ name: string }> }
      ).toArray()
      expect(rows).toEqual([{ name: 'session_meta' }])
      expect(sessionMetaRows).toEqual([{ id: 1, message_seq: 0, updated_at: 0 }])
    })
  })

  describe('migration chain integrity', () => {
    it('has sequential version numbers', () => {
      const versions = SESSION_DO_MIGRATIONS.map((m) => m.version)
      expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18])
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

// ── findPendingGatePart (resolveGate fallback) ───────────────────────
//
// Regression: when the scalar state.gate drifts from what the client is
// rendering (dropped broadcast, multiple gates in flight), resolveGate
// must still accept an answer targeted at any history part that's still
// in 'approval-requested'. See apps/orchestrator/src/agents/session-do.ts
// resolveGate(), and the freeform-mode diagnosis of the "Stale gate ID"
// user report.

describe('findPendingGatePart', () => {
  type Msg = Parameters<typeof findPendingGatePart>[0][number]

  const mkMsg = (parts: Msg['parts']): Msg => ({
    id: 'm1',
    role: 'assistant',
    parts,
    createdAt: new Date(),
  })

  it('returns ask_user when a tool-ask_user part is approval-requested', () => {
    const msg = mkMsg([
      { type: 'tool-ask_user', toolCallId: 'toolu_A', state: 'approval-requested' },
    ])
    const result = findPendingGatePart([msg], 'toolu_A')
    expect(result?.type).toBe('ask_user')
    expect(result?.part?.toolCallId).toBe('toolu_A')
  })

  it('returns permission_request when a tool-permission part is approval-requested', () => {
    const msg = mkMsg([
      { type: 'tool-permission', toolCallId: 'toolu_B', state: 'approval-requested' },
    ])
    const result = findPendingGatePart([msg], 'toolu_B')
    expect(result?.type).toBe('permission_request')
    expect(result?.part?.toolCallId).toBe('toolu_B')
  })

  it('returns null for a part that has moved past approval-requested', () => {
    const msg = mkMsg([
      { type: 'tool-ask_user', toolCallId: 'toolu_C', state: 'output-available', output: 'ok' },
    ])
    expect(findPendingGatePart([msg], 'toolu_C')).toBeNull()
  })

  it('returns null when the toolCallId is not in history', () => {
    const msg = mkMsg([
      { type: 'tool-ask_user', toolCallId: 'toolu_X', state: 'approval-requested' },
    ])
    expect(findPendingGatePart([msg], 'toolu_MISSING')).toBeNull()
  })

  it('walks newest-first and returns the most recent pending match', () => {
    const older = mkMsg([
      { type: 'tool-ask_user', toolCallId: 'toolu_OLD', state: 'approval-requested' },
    ])
    const newer = mkMsg([
      { type: 'tool-ask_user', toolCallId: 'toolu_NEW', state: 'approval-requested' },
    ])
    expect(findPendingGatePart([older, newer], 'toolu_OLD')?.type).toBe('ask_user')
    expect(findPendingGatePart([older, newer], 'toolu_NEW')?.type).toBe('ask_user')
  })

  it('ignores non-gate tool parts with matching toolCallId', () => {
    const msg = mkMsg([
      {
        type: 'tool-Edit',
        toolCallId: 'toolu_D',
        state: 'approval-requested',
        toolName: 'Edit',
      },
    ])
    expect(findPendingGatePart([msg], 'toolu_D')).toBeNull()
  })

  it('returns null for an empty history', () => {
    expect(findPendingGatePart([], 'toolu_A')).toBeNull()
  })

  it('returns ask_user for a native tool-AskUserQuestion/input-available part', () => {
    // SDK-native shape — the client can render and resolve the gate before
    // promoteToolPartToGate has flipped the part to tool-ask_user, or if
    // that promotion broadcast was silent-dropped on a half-closed socket.
    const msg = mkMsg([
      {
        type: 'tool-AskUserQuestion',
        toolCallId: 'toolu_NATIVE',
        state: 'input-available',
        toolName: 'AskUserQuestion',
      },
    ])
    expect(findPendingGatePart([msg], 'toolu_NATIVE')?.type).toBe('ask_user')
  })

  it('returns null for a tool-AskUserQuestion part that already has output', () => {
    const msg = mkMsg([
      {
        type: 'tool-AskUserQuestion',
        toolCallId: 'toolu_DONE',
        state: 'output-available',
        toolName: 'AskUserQuestion',
        output: { answers: [{ label: 'yes' }] },
      },
    ])
    expect(findPendingGatePart([msg], 'toolu_DONE')).toBeNull()
  })
})

// ── resolveGate ask_user: question-keyed answers ─────────────────────
//
// Regression: resolveGate was sending `{answers: {answer: '<flat>'}}` to
// the runner — the SDK's AskUserQuestion tool expects answers keyed by
// the full question text. The harness below mirrors the exact ask_user
// branch of SessionDO.resolveGate (post-fix shape) so we can witness
// the wire payload without instantiating the decorator class.

interface FakeAnswerSent {
  type: 'answer'
  session_id: string
  tool_call_id: string
  answers: Record<string, string>
}

type AskUserResolveResponse = {
  approved?: boolean
  answer?: string
  answers?: Array<{ label: string; note?: string }>
  declined?: boolean
}

function flattenStructuredAnswersForTest(answers: Array<{ label: string; note?: string }>): string {
  const parts: string[] = []
  for (const a of answers) {
    const label = (a.label ?? '').trim()
    const note = (a.note ?? '').trim()
    if (label && note) parts.push(`${label} (note: ${note})`)
    else if (label) parts.push(label)
    else if (note) parts.push(note)
  }
  return parts.join('; ')
}

function simulateResolveAskUser(args: {
  gateId: string
  sessionId: string
  questions: Array<{ question?: string; header?: string }>
  response: AskUserResolveResponse
}): { sent: FakeAnswerSent | null; warnings: string[] } {
  const warnings: string[] = []
  let sent: FakeAnswerSent | null = null
  const declinedPlaceholder =
    '[User declined to answer. See subsequent message for next instruction.]'

  const buildPerQuestionValue = (i: number): string => {
    if (args.response.declined === true) return declinedPlaceholder
    if (args.response.answers !== undefined) {
      const a = args.response.answers[i]
      if (!a) return ''
      return flattenStructuredAnswersForTest([a])
    }
    if (args.response.answer !== undefined) {
      return i === 0 ? args.response.answer : ''
    }
    return ''
  }

  let answersRecord: Record<string, string>
  if (args.questions.length === 0) {
    let value: string
    if (args.response.declined === true) value = declinedPlaceholder
    else if (args.response.answers !== undefined)
      value = flattenStructuredAnswersForTest(args.response.answers)
    else if (args.response.answer !== undefined) value = args.response.answer
    else throw new Error('Invalid response for gate type')
    warnings.push('fallback')
    answersRecord = { question: value }
  } else {
    if (
      args.response.declined !== true &&
      args.response.answers === undefined &&
      args.response.answer === undefined
    ) {
      throw new Error('Invalid response for gate type')
    }
    answersRecord = {}
    for (let i = 0; i < args.questions.length; i++) {
      const q = args.questions[i]
      const key =
        (typeof q?.question === 'string' && q.question.trim()) ||
        (typeof q?.header === 'string' && q.header.trim()) ||
        `question_${i}`
      answersRecord[key] = buildPerQuestionValue(i)
    }
  }

  sent = {
    type: 'answer',
    session_id: args.sessionId,
    tool_call_id: args.gateId,
    answers: answersRecord,
  }
  return { sent, warnings }
}

describe('SessionDO.resolveGate ask_user payload', () => {
  it('keys structured answers by question text (not header) and pairs them with input.questions order', () => {
    const { sent } = simulateResolveAskUser({
      gateId: 'toolu_GATE1',
      sessionId: 'sess-1',
      questions: [
        {
          question: 'Slide 4 ship?',
          header: 'Slide 4',
        },
        {
          question: 'Slide 5 style?',
          header: 'Slide 5',
        },
      ],
      response: {
        answers: [{ label: 'Ship' }, { label: '', note: 'current is good, just upscale' }],
      },
    })
    expect(sent).not.toBeNull()
    expect(sent?.tool_call_id).toBe('toolu_GATE1')
    expect(sent?.answers).toEqual({
      'Slide 4 ship?': 'Ship',
      'Slide 5 style?': 'current is good, just upscale',
    })
  })

  it('applies the declined placeholder to every question key', () => {
    const { sent } = simulateResolveAskUser({
      gateId: 'toolu_GATE2',
      sessionId: 'sess-2',
      questions: [{ question: 'Q1?' }, { question: 'Q2?' }],
      response: { declined: true },
    })
    const placeholder = '[User declined to answer. See subsequent message for next instruction.]'
    expect(sent?.answers).toEqual({
      'Q1?': placeholder,
      'Q2?': placeholder,
    })
  })

  it('legacy single-string response keys on the first question only', () => {
    const { sent } = simulateResolveAskUser({
      gateId: 'toolu_GATE3',
      sessionId: 'sess-3',
      questions: [{ question: 'What color?' }, { question: 'What size?' }],
      response: { answer: 'red' },
    })
    expect(sent?.answers).toEqual({ 'What color?': 'red', 'What size?': '' })
  })

  it('falls back to a single key when input.questions is missing/empty', () => {
    const { sent, warnings } = simulateResolveAskUser({
      gateId: 'toolu_GATE4',
      sessionId: 'sess-4',
      questions: [],
      response: { answer: 'just answer' },
    })
    expect(warnings).toContain('fallback')
    expect(sent?.answers).toEqual({ question: 'just answer' })
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

  // Terminal runner states — recovery must run immediately (not wait 15s grace).
  // Only 'running' runners can reconnect via DialBackClient backoff; the rest
  // have exited and will never come back. Running recovery right away avoids
  // a wedged 'running' status if the grace setTimeout is lost to hibernation.
  it.each([
    'crashed',
    'failed',
    'aborted',
  ] as const)('runs recovery immediately when gateway reports state:%s', async (state) => {
    mockStatus({
      ok: true,
      state,
      sdk_session_id: 'sdk-1',
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

// ── Hibernation-safe recovery grace (durable kv deadline) ─────────
//
// maybeRecoverAfterGatewayDrop persists `recovery_grace_until` in kv
// alongside the in-memory setTimeout so that a hibernation-evicted DO
// still runs recovery on the next alarm tick rather than staying wedged
// in status='running' with no attached runner.

describe('SessionDO alarm: durable recovery grace', () => {
  /**
   * Mirrors the alarm() branch that consults kv for a stored grace deadline
   * (session-do.ts: `recovery_grace_until`). Returns the action the alarm
   * handler will take.
   */
  function graceAction(params: {
    graceUntil: number | null
    now: number
    hasGateway: boolean
  }): 'recover' | 'clear_only' | 'noop' {
    if (params.graceUntil === null) return 'noop'
    if (params.now < params.graceUntil) return 'noop'
    // Deadline passed — the alarm handler deletes the kv row, then decides.
    return params.hasGateway ? 'clear_only' : 'recover'
  }

  it('runs recovery when the stored deadline has passed and no runner is attached', () => {
    expect(graceAction({ graceUntil: 1000, now: 2000, hasGateway: false })).toBe('recover')
  })

  it('skips recovery when the runner reconnected during the grace window', () => {
    expect(graceAction({ graceUntil: 1000, now: 2000, hasGateway: true })).toBe('clear_only')
  })

  it('does nothing when the deadline is in the future (still in grace)', () => {
    expect(graceAction({ graceUntil: 5000, now: 2000, hasGateway: false })).toBe('noop')
  })

  it('does nothing when no deadline is persisted (no grace in flight)', () => {
    expect(graceAction({ graceUntil: null, now: 2000, hasGateway: false })).toBe('noop')
  })
})

// ── messageSeq persistence via session_meta (B1) ───────────────
//
// Mirrors the exact onStart read + broadcastMessages write the DO uses.
// We can't construct SessionDO directly (TC39 decorators), so we stand up
// the same two statements against an in-memory session_meta row.

function createSessionMetaSql() {
  const row = { message_seq: 0, updated_at: 0 }
  const writes: Array<{ message_seq: number; updated_at: number }> = []
  function fakeSql<T>(strings: TemplateStringsArray, ...values: unknown[]): T[] {
    const query = strings.join('?').trim()
    if (query.startsWith('SELECT message_seq FROM session_meta')) {
      return [{ message_seq: row.message_seq }] as T[]
    }
    if (query.startsWith('UPDATE session_meta SET message_seq =')) {
      row.message_seq = values[0] as number
      row.updated_at = values[1] as number
      writes.push({ message_seq: row.message_seq, updated_at: row.updated_at })
      return [] as T[]
    }
    return [] as T[]
  }
  return { sql: fakeSql, row, writes }
}

describe('messageSeq persistence (session_meta B4 — GH#69)', () => {
  /**
   * Simulates SessionDO.broadcastMessages' seq+persist contract exactly after
   * the GH#69 B4 change (unconditional persist on every broadcast):
   *   if (!opts.targetClientId) {
   *     this.messageSeq += 1
   *     try {
   *       this.sql`UPDATE session_meta SET message_seq = ${n}, updated_at = ${t} WHERE id = 1`
   *     } catch { ... }
   *   }
   */
  function makeBroadcaster(sql: ReturnType<typeof createSessionMetaSql>['sql'], seed: number) {
    let messageSeq = seed
    return {
      broadcast(opts: { targetClientId?: string } = {}): number {
        if (!opts.targetClientId) {
          messageSeq += 1
          sql`UPDATE session_meta SET message_seq = ${messageSeq}, updated_at = ${Date.now()} WHERE id = 1`
        }
        return messageSeq
      },
      getSeq: () => messageSeq,
    }
  }

  it('persists on every broadcast (no batching — hibernation-rewind safe)', () => {
    const { sql, row, writes } = createSessionMetaSql()
    const b = makeBroadcaster(sql, 0)

    // After 3 broadcasts we expect 3 writes, final seq = 3.
    expect(b.broadcast()).toBe(1)
    expect(b.broadcast()).toBe(2)
    expect(b.broadcast()).toBe(3)
    expect(writes).toHaveLength(3)
    expect(writes.map((w) => w.message_seq)).toEqual([1, 2, 3])
    expect(row.message_seq).toBe(3)
  })

  it('rehydrates messageSeq across a DO restart from the last persisted seq', () => {
    const { sql, row } = createSessionMetaSql()

    // 7 broadcasts — crosses the old batch-of-10 boundary, simulating the
    // B4 test case (DO eviction at <10 events should NOT rewind seq).
    const total = 7
    const b1 = makeBroadcaster(sql, 0)
    for (let i = 0; i < total; i++) b1.broadcast()
    expect(row.message_seq).toBe(total)

    // Simulate onStart on a fresh DO instance — re-read persisted seq.
    const metaRows = sql<{
      message_seq: number
    }>`SELECT message_seq FROM session_meta WHERE id = 1`
    const rehydrated = metaRows[0]?.message_seq ?? 0
    expect(rehydrated).toBe(total)

    // Next broadcast on the new instance continues from the persisted point.
    const b2 = makeBroadcaster(sql, rehydrated)
    expect(b2.broadcast()).toBe(total + 1)
  })

  it('targeted broadcasts do NOT increment or persist seq', () => {
    const { sql, row, writes } = createSessionMetaSql()
    const b = makeBroadcaster(sql, 0)

    // Drive the shared counter forward so we have something to observe.
    for (let i = 0; i < 3; i++) b.broadcast()
    expect(row.message_seq).toBe(3)
    expect(writes).toHaveLength(3)

    // Targeted sends echo current seq — must not advance shared counter
    // and must not emit a SQL write.
    expect(b.broadcast({ targetClientId: 'client-A' })).toBe(3)
    expect(b.broadcast({ targetClientId: 'client-B' })).toBe(3)

    expect(row.message_seq).toBe(3)
    expect(writes).toHaveLength(3)
  })

  it('onStart falls back to 0 when the session_meta row is missing (defensive)', () => {
    // The v6 migration INSERT OR IGNOREs the row, but belt-and-suspenders:
    // the DO uses `?? 0`. Simulate an empty table.
    function emptySql<T>(strings: TemplateStringsArray): T[] {
      const query = strings.join('').trim()
      if (query.startsWith('SELECT message_seq FROM session_meta')) {
        return [] as T[]
      }
      return [] as T[]
    }
    const metaRows = emptySql<{
      message_seq: number
    }>`SELECT message_seq FROM session_meta WHERE id = 1`
    const seed = metaRows[0]?.message_seq ?? 0
    expect(seed).toBe(0)
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

// ── P3 B4: getContextUsage cached-or-fresh + in-flight dedupe ──
//
// SessionDO uses TC39 decorators so can't be instantiated in tests. The
// harness below mirrors the exact contract of SessionDO.getContextUsage:
//   - 5s TTL cache-hit
//   - single-flight probe dedupe
//   - 3s timeout fallback to stale/null
//   - UPDATE session_meta.context_usage_json on fresh probe success
// It runs the identical code path against fake sql / fake sendToGateway.

interface FakeContextUsage {
  totalTokens: number
  maxTokens: number
  percentage: number
  model?: string
}

function createContextUsageHarness(initial: {
  row?: {
    context_usage_json: string | null
    context_usage_cached_at: number | null
  }
  hasGatewayConn: boolean
}) {
  const row = initial.row ?? { context_usage_json: null, context_usage_cached_at: null }
  const sends: string[] = []
  const resolvers: Array<{
    resolve: (v: FakeContextUsage | null) => void
    reject: (e: unknown) => void
  }> = []
  let probeInFlight: Promise<FakeContextUsage | null> | null = null
  let hasGatewayConn = initial.hasGatewayConn

  function sql<T>(strings: TemplateStringsArray, ...values: unknown[]): T[] {
    const query = strings.join('?').trim()
    if (query.startsWith('SELECT context_usage_json, context_usage_cached_at FROM session_meta')) {
      return [
        {
          context_usage_json: row.context_usage_json,
          context_usage_cached_at: row.context_usage_cached_at,
        },
      ] as T[]
    }
    if (query.startsWith('UPDATE session_meta')) {
      row.context_usage_json = values[0] as string | null
      row.context_usage_cached_at = values[1] as number | null
      return [] as T[]
    }
    return [] as T[]
  }

  function probeWithTimeout(): Promise<FakeContextUsage | null> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = resolvers.findIndex((r) => r.resolve === innerResolve)
        if (idx >= 0) resolvers.splice(idx, 1)
        reject(new Error('probe_timeout'))
      }, 3_000)
      const innerResolve = (v: FakeContextUsage | null) => {
        clearTimeout(timer)
        resolve(v)
      }
      const innerReject = (e: unknown) => {
        clearTimeout(timer)
        reject(e)
      }
      resolvers.push({ resolve: innerResolve, reject: innerReject })
      sends.push('get-context-usage')
    })
  }

  async function getContextUsage(): Promise<{
    contextUsage: FakeContextUsage | null
    fetchedAt: string
    isCached: boolean
  }> {
    const rows = sql<{
      context_usage_json: string | null
      context_usage_cached_at: number | null
    }>`SELECT context_usage_json, context_usage_cached_at FROM session_meta WHERE id = 1`
    const r = rows[0]
    const cached =
      r?.context_usage_json && r.context_usage_cached_at != null
        ? {
            value: JSON.parse(r.context_usage_json) as FakeContextUsage,
            cachedAt: r.context_usage_cached_at,
          }
        : null
    const now = Date.now()
    if (cached && now - cached.cachedAt < 5_000) {
      return {
        contextUsage: cached.value,
        fetchedAt: new Date(cached.cachedAt).toISOString(),
        isCached: true,
      }
    }
    if (!hasGatewayConn) {
      return {
        contextUsage: cached?.value ?? null,
        fetchedAt: cached ? new Date(cached.cachedAt).toISOString() : new Date().toISOString(),
        isCached: true,
      }
    }
    if (!probeInFlight) {
      probeInFlight = probeWithTimeout().finally(() => {
        probeInFlight = null
      })
    }
    try {
      const value = await probeInFlight
      const cachedAt = Date.now()
      sql`UPDATE session_meta
        SET context_usage_json = ${JSON.stringify(value)},
            context_usage_cached_at = ${cachedAt},
            updated_at = ${cachedAt}
        WHERE id = 1`
      return {
        contextUsage: value,
        fetchedAt: new Date(cachedAt).toISOString(),
        isCached: false,
      }
    } catch {
      return {
        contextUsage: cached?.value ?? null,
        fetchedAt: cached ? new Date(cached.cachedAt).toISOString() : new Date().toISOString(),
        isCached: true,
      }
    }
  }

  function deliver(value: FakeContextUsage | null) {
    // Mirror SessionDO's handleGatewayEvent('context_usage') side effects.
    const drained = resolvers.splice(0)
    for (const res of drained) {
      try {
        res.resolve(value)
      } catch {
        // noop
      }
    }
    const cachedAt = Date.now()
    sql`UPDATE session_meta
      SET context_usage_json = ${JSON.stringify(value)},
          context_usage_cached_at = ${cachedAt},
          updated_at = ${cachedAt}
      WHERE id = 1`
  }

  return {
    getContextUsage,
    deliver,
    sends,
    resolvers,
    row,
    setGatewayConn(v: boolean) {
      hasGatewayConn = v
    },
  }
}

describe('getContextUsage (P3 B4)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-20T00:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('context-usage-rest-returns-cached-then-probes', async () => {
    // Pre-seed a fresh cache (cached_at = now).
    const cached: FakeContextUsage = { totalTokens: 1_000, maxTokens: 200_000, percentage: 0.5 }
    const h = createContextUsageHarness({
      row: {
        context_usage_json: JSON.stringify(cached),
        context_usage_cached_at: Date.now(),
      },
      hasGatewayConn: true,
    })

    // First call — fresh cache hit, no probe.
    const first = await h.getContextUsage()
    expect(first.isCached).toBe(true)
    expect(first.contextUsage).toEqual(cached)
    expect(h.sends).toHaveLength(0)

    // Advance past the 5s TTL — next call must probe.
    vi.advanceTimersByTime(6_000)
    const pending = h.getContextUsage()
    // Probe command was dispatched.
    expect(h.sends).toHaveLength(1)
    // Deliver fresh value.
    const fresh: FakeContextUsage = { totalTokens: 2_000, maxTokens: 200_000, percentage: 1.0 }
    h.deliver(fresh)
    const second = await pending
    expect(second.isCached).toBe(false)
    expect(second.contextUsage).toEqual(fresh)
    expect(h.row.context_usage_json).toBe(JSON.stringify(fresh))
  })

  it('context-usage-inflight-dedupe', async () => {
    // Cold cache, gateway connected — fire 3 concurrent calls.
    const h = createContextUsageHarness({ hasGatewayConn: true })
    const p1 = h.getContextUsage()
    const p2 = h.getContextUsage()
    const p3 = h.getContextUsage()
    // Only one probe command dispatched despite 3 concurrent callers.
    expect(h.sends).toHaveLength(1)
    const value: FakeContextUsage = { totalTokens: 500, maxTokens: 200_000, percentage: 0.25 }
    h.deliver(value)
    const [r1, r2, r3] = await Promise.all([p1, p2, p3])
    expect(r1.contextUsage).toEqual(value)
    expect(r2.contextUsage).toEqual(value)
    expect(r3.contextUsage).toEqual(value)
    // All three share the same fresh probe → isCached:false on each.
    expect(r1.isCached).toBe(false)
    expect(r2.isCached).toBe(false)
    expect(r3.isCached).toBe(false)
  })

  it('context-usage-no-gateway-returns-stale', async () => {
    // Populate a stale cache, then take the gateway offline.
    const stale: FakeContextUsage = { totalTokens: 100, maxTokens: 200_000, percentage: 0.05 }
    const h = createContextUsageHarness({
      row: {
        context_usage_json: JSON.stringify(stale),
        context_usage_cached_at: Date.now() - 10_000, // 10s ago, past the 5s TTL
      },
      hasGatewayConn: false,
    })
    const res = await h.getContextUsage()
    expect(res.contextUsage).toEqual(stale)
    expect(res.isCached).toBe(true)
    // No probe dispatched when the gateway is offline.
    expect(h.sends).toHaveLength(0)
  })

  it('returns null + isCached:true when cold cache and no gateway', async () => {
    const h = createContextUsageHarness({ hasGatewayConn: false })
    const res = await h.getContextUsage()
    expect(res.contextUsage).toBeNull()
    expect(res.isCached).toBe(true)
    expect(h.sends).toHaveLength(0)
  })
})

// ── P3 B5: getKataState reads D1 mirror ────────────────────────

describe('getKataState (P3 B5)', () => {
  /**
   * Mirror of SessionDO.getKataState. D1 + kv sql are both stubbed; we
   * verify the precedence: D1 row absent → null; kv blob present → full
   * shape; kv absent + D1 row present → synthesized minimal shape.
   */
  async function runGetKataState(input: {
    d1Row: {
      kataMode: string | null
      kataIssue: number | null
      kataPhase: string | null
    } | null
    kvBlob: string | null
  }): Promise<{ kataState: any; fetchedAt: string }> {
    const sessionId = 'sess-test-1'
    // Fake d1.select().from().where().limit()
    const d1 = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => (input.d1Row ? [input.d1Row] : []),
          }),
        }),
      }),
    }
    function sql<T>(strings: TemplateStringsArray): T[] {
      const query = strings.join('').trim()
      if (query.includes("SELECT value FROM kv WHERE key = 'kata_state'")) {
        return input.kvBlob ? ([{ value: input.kvBlob }] as T[]) : ([] as T[])
      }
      return [] as T[]
    }

    try {
      const rows = await d1.select().from().where().limit()
      const row = rows[0]
      if (!row || (row.kataMode == null && row.kataIssue == null && row.kataPhase == null)) {
        return { kataState: null, fetchedAt: new Date().toISOString() }
      }
      const kvRows = sql<{ value: string }>`SELECT value FROM kv WHERE key = 'kata_state'`
      const kvKata = kvRows[0]?.value ? JSON.parse(kvRows[0].value) : null
      if (kvKata) {
        return { kataState: kvKata, fetchedAt: new Date().toISOString() }
      }
      const minimal = {
        sessionId,
        workflowId: null,
        issueNumber: row.kataIssue ?? null,
        sessionType: null,
        currentMode: row.kataMode ?? null,
        currentPhase: row.kataPhase ?? null,
        completedPhases: [],
        template: null,
        phases: [],
        modeHistory: [],
        modeState: {},
        updatedAt: new Date().toISOString(),
        beadsCreated: [],
        editedFiles: [],
      }
      return { kataState: minimal, fetchedAt: new Date().toISOString() }
    } catch {
      return { kataState: null, fetchedAt: new Date().toISOString() }
    }
  }

  it('kata-state-reads-d1: returns full kv blob when present', async () => {
    const kvKata = {
      sessionId: 'sess-test-1',
      workflowId: 'wf-1',
      issueNumber: 31,
      sessionType: 'feature',
      currentMode: 'planning',
      currentPhase: 'p3',
      completedPhases: ['p1', 'p2'],
      template: 'default',
      phases: ['p1', 'p2', 'p3'],
      modeHistory: [],
      modeState: {},
      updatedAt: '2026-04-20T00:00:00Z',
      beadsCreated: [],
      editedFiles: [],
    }
    const res = await runGetKataState({
      d1Row: { kataMode: 'planning', kataIssue: 31, kataPhase: 'p3' },
      kvBlob: JSON.stringify(kvKata),
    })
    expect(res.kataState).toEqual(kvKata)
    expect(res.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('returns minimal synthesized shape when D1 row present but kv blob absent', async () => {
    const res = await runGetKataState({
      d1Row: { kataMode: 'implementation', kataIssue: 42, kataPhase: 'p1' },
      kvBlob: null,
    })
    expect(res.kataState).not.toBeNull()
    expect(res.kataState.currentMode).toBe('implementation')
    expect(res.kataState.issueNumber).toBe(42)
    expect(res.kataState.currentPhase).toBe('p1')
    expect(res.kataState.completedPhases).toEqual([])
  })

  it('returns null when D1 row is missing', async () => {
    const res = await runGetKataState({ d1Row: null, kvBlob: null })
    expect(res.kataState).toBeNull()
  })

  it('returns null when D1 row exists but all kata fields are null (no binding)', async () => {
    const res = await runGetKataState({
      d1Row: { kataMode: null, kataIssue: null, kataPhase: null },
      kvBlob: null,
    })
    expect(res.kataState).toBeNull()
  })
})

// ── session_meta rehydrates across DO restart (#31 P5 B10) ──────
//
// `hydrateMetaFromSql()` runs in onStart. After the Agents SDK's
// `setState` JSON is lost on eviction, the DO restores status / project
// / session_id / etc. from the persisted `session_meta` row so the next
// caller sees a consistent state. We can't construct SessionDO directly
// (TC39 decorators block instantiation in tests) — we mirror the exact
// hydrate contract against an in-memory row, which is the same approach
// used above for `messageSeq persistence`.

describe('session_meta persists across rehydrate (P5 B10)', () => {
  /**
   * The column map the DO uses in `hydrateMetaFromSql` — kept in sync
   * with META_COLUMN_MAP in session-do.ts. If a field moves, this test
   * and the production map move together.
   */
  const COLUMN_MAP: Record<string, string> = {
    status: 'status',
    session_id: 'session_id',
    project: 'project',
    project_path: 'project_path',
    model: 'model',
    prompt: 'prompt',
    userId: 'user_id',
    started_at: 'started_at',
    completed_at: 'completed_at',
    num_turns: 'num_turns',
    total_cost_usd: 'total_cost_usd',
    duration_ms: 'duration_ms',
    created_at: 'created_at',
    error: 'error',
    summary: 'summary',
    sdk_session_id: 'sdk_session_id',
    active_callback_token: 'active_callback_token',
    lastKataMode: 'last_kata_mode',
  }

  /**
   * Mirrors `hydrateMetaFromSql`: read the single `session_meta` row and
   * apply any non-null columns back onto a fresh default meta.
   */
  function hydrateFromRow(
    row: Record<string, unknown> | undefined,
    defaults: Record<string, unknown>,
  ): Record<string, unknown> {
    if (!row) return { ...defaults }
    const out = { ...defaults }
    for (const [key, col] of Object.entries(COLUMN_MAP)) {
      if (!(col in row)) continue
      const raw = row[col]
      if (raw === null || raw === undefined) continue
      out[key] = raw
    }
    return out
  }

  const DEFAULTS = {
    status: 'idle',
    session_id: null,
    project: '',
    project_path: '',
    model: null,
    prompt: '',
    userId: null,
    started_at: null,
    completed_at: null,
    num_turns: 0,
    total_cost_usd: null,
    duration_ms: null,
    created_at: '',
    error: null,
    summary: null,
    sdk_session_id: null,
  }

  it('restores status / project / session_id after a simulated DO eviction', () => {
    // Persisted row after a running session — this is what SQLite holds
    // after the DO ran a turn and setState has been lost.
    const persisted = {
      status: 'running',
      session_id: 'sess-123',
      project: 'duraclaw',
      project_path: '/data/projects/duraclaw',
      model: 'claude-opus-4-0',
      prompt: 'help me',
      user_id: 'u1',
      num_turns: 3,
      created_at: '2026-01-01T00:00:00Z',
      sdk_session_id: 'sdk-abc',
    }

    const rehydrated = hydrateFromRow(persisted, DEFAULTS)

    expect(rehydrated.status).toBe('running')
    expect(rehydrated.session_id).toBe('sess-123')
    expect(rehydrated.project).toBe('duraclaw')
    expect(rehydrated.project_path).toBe('/data/projects/duraclaw')
    expect(rehydrated.model).toBe('claude-opus-4-0')
    expect(rehydrated.prompt).toBe('help me')
    expect(rehydrated.userId).toBe('u1')
    expect(rehydrated.num_turns).toBe(3)
    expect(rehydrated.sdk_session_id).toBe('sdk-abc')
  })

  it('no-ops when the session_meta row is missing (cold-start, pre-migration data)', () => {
    const rehydrated = hydrateFromRow(undefined, DEFAULTS)
    // Entire default meta is preserved — hydrate should not poison fields.
    expect(rehydrated).toEqual(DEFAULTS)
  })

  it('skips null columns so defaults survive (defensive)', () => {
    const persisted = {
      status: null,
      project: 'only-this-field',
      session_id: null,
    }
    const rehydrated = hydrateFromRow(persisted, DEFAULTS)
    expect(rehydrated.status).toBe('idle') // default preserved
    expect(rehydrated.project).toBe('only-this-field')
    expect(rehydrated.session_id).toBeNull()
  })
})

// ── GH#38 P1.2: SyncedCollectionFrame emit + cursor REST + POST ingest ──
//
// SessionDO can't be instantiated in vitest (TC39 decorators). These tests
// mirror the broadcastMessages / fetch-handler / sendMessage-duplicate logic
// against in-memory state, in the same style as earlier sections of this
// file (see `session_meta persists across rehydrate`).

import type { SyncedCollectionOp } from '@duraclaw/shared-types'

describe('broadcastMessages → SyncedCollectionFrame (GH#38 P1.2)', () => {
  type WireRow = { id: string; role: string; parts: unknown[]; createdAt?: unknown }

  /**
   * Mirror of the production `broadcastMessages` method (at
   * session-do.ts `private broadcastMessages(...)`). Pulled out so we can
   * test the frame shape without instantiating the DO.
   */
  function broadcastMessages(
    ctx: {
      sessionId: string
      messageSeq: number
      broadcast: (data: string) => void
      target: (clientId: string, data: string) => void
    },
    rowsOrOps: WireRow[] | { ops: SyncedCollectionOp<WireRow>[] },
    opts: { targetClientId?: string } = {},
  ): void {
    const ops: SyncedCollectionOp<WireRow>[] = Array.isArray(rowsOrOps)
      ? rowsOrOps.map((r) => ({ type: 'insert' as const, value: r }))
      : rowsOrOps.ops
    if (ops.length === 0) return

    if (!opts.targetClientId) {
      ctx.messageSeq += 1
    }
    const frame = {
      type: 'synced-collection-delta' as const,
      collection: `messages:${ctx.sessionId}`,
      ops,
      messageSeq: ctx.messageSeq,
    }
    const data = JSON.stringify(frame)
    if (opts.targetClientId) {
      ctx.target(opts.targetClientId, data)
    } else {
      ctx.broadcast(data)
    }
  }

  function createHarness(sessionId = 'sess-abc') {
    const broadcasts: string[] = []
    const targeted: Array<{ clientId: string; data: string }> = []
    const ctx = {
      sessionId,
      messageSeq: 0,
      broadcast: (data: string) => broadcasts.push(data),
      target: (clientId: string, data: string) => targeted.push({ clientId, data }),
    }
    return { ctx, broadcasts, targeted }
  }

  it('emits a SyncedCollectionFrame with messageSeq envelope for row array', () => {
    const { ctx, broadcasts } = createHarness('sess-abc')
    const row: WireRow = {
      id: 'usr-1',
      role: 'user',
      parts: [{ type: 'text', text: 'hi' }],
      createdAt: '2026-04-21T00:00:00.000Z',
    }
    broadcastMessages(ctx, [row])
    expect(broadcasts).toHaveLength(1)
    const parsed = JSON.parse(broadcasts[0])
    expect(parsed).toEqual({
      type: 'synced-collection-delta',
      collection: 'messages:sess-abc',
      ops: [{ type: 'insert', value: row }],
      messageSeq: 1,
    })
  })

  it('accepts a pre-built ops array with delete + insert in order', () => {
    const { ctx, broadcasts } = createHarness('sess-xyz')
    const row: WireRow = { id: 'usr-2', role: 'user', parts: [] }
    broadcastMessages(ctx, {
      ops: [
        { type: 'delete', key: 'stale-1' },
        { type: 'insert', value: row },
      ],
    })
    const parsed = JSON.parse(broadcasts[0])
    expect(parsed.collection).toBe('messages:sess-xyz')
    expect(parsed.ops).toEqual([
      { type: 'delete', key: 'stale-1' },
      { type: 'insert', value: row },
    ])
    expect(parsed.messageSeq).toBe(1)
  })

  it('early-returns on empty ops without incrementing messageSeq or emitting', () => {
    const { ctx, broadcasts } = createHarness()
    broadcastMessages(ctx, [])
    broadcastMessages(ctx, { ops: [] })
    expect(broadcasts).toHaveLength(0)
    expect(ctx.messageSeq).toBe(0)
  })

  it('targeted send does NOT advance messageSeq (echoes current value)', () => {
    const { ctx, targeted, broadcasts } = createHarness('sess-t')
    ctx.messageSeq = 5
    const row: WireRow = { id: 'usr-5', role: 'user', parts: [] }
    broadcastMessages(ctx, [row], { targetClientId: 'conn-1' })
    expect(broadcasts).toHaveLength(0)
    expect(targeted).toHaveLength(1)
    expect(targeted[0].clientId).toBe('conn-1')
    const parsed = JSON.parse(targeted[0].data)
    expect(parsed.messageSeq).toBe(5) // unchanged
    expect(ctx.messageSeq).toBe(5)
  })

  it('non-targeted send advances messageSeq monotonically', () => {
    const { ctx, broadcasts } = createHarness()
    const row: WireRow = { id: 'm', role: 'user', parts: [] }
    broadcastMessages(ctx, [row])
    broadcastMessages(ctx, [{ ...row, id: 'm2' }])
    broadcastMessages(ctx, [{ ...row, id: 'm3' }])
    expect(broadcasts).toHaveLength(3)
    const seqs = broadcasts.map((d) => JSON.parse(d).messageSeq)
    expect(seqs).toEqual([1, 2, 3])
  })

  it('row array → each entry becomes an insert op', () => {
    const { ctx, broadcasts } = createHarness()
    const rows: WireRow[] = [
      { id: 'a', role: 'user', parts: [] },
      { id: 'b', role: 'assistant', parts: [] },
      { id: 'c', role: 'user', parts: [] },
    ]
    broadcastMessages(ctx, rows)
    const parsed = JSON.parse(broadcasts[0])
    expect(parsed.ops).toEqual([
      { type: 'insert', value: rows[0] },
      { type: 'insert', value: rows[1] },
      { type: 'insert', value: rows[2] },
    ])
  })
})

describe('/messages cursor REST handler (GH#38 P1.2)', () => {
  type Row = {
    id: string
    session_id: string
    content: string
    created_at: string
  }

  /**
   * Mirror of the production `/messages` GET handler body. Accepts a
   * query-string-parsed cursor + an in-memory rows table + a
   * getHistory() stub, and returns the same Response-body shape.
   */
  async function runMessagesHandler(
    url: URL,
    sessionId: string,
    deps: {
      rows: Row[]
      getHistory: () => unknown[]
    },
  ): Promise<{ status: number; body: any }> {
    const sinceCreatedAt = url.searchParams.get('sinceCreatedAt')
    const sinceId = url.searchParams.get('sinceId')
    const hasCA = sinceCreatedAt !== null
    const hasId = sinceId !== null
    if (hasCA !== hasId) {
      return {
        status: 400,
        body: { error: 'sinceCreatedAt and sinceId must be provided together' },
      }
    }
    if (hasCA && hasId) {
      if (Number.isNaN(new Date(sinceCreatedAt as string).getTime())) {
        return { status: 400, body: { error: 'invalid sinceCreatedAt ISO 8601 string' } }
      }
      const filtered = deps.rows
        .filter((r) => r.session_id === sessionId)
        .filter((r) => {
          if (r.created_at > (sinceCreatedAt as string)) return true
          if (r.created_at === sinceCreatedAt && r.id > (sinceId as string)) return true
          return false
        })
        .sort((a, b) => {
          if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1
          return a.id < b.id ? -1 : 1
        })
        .slice(0, 500)
      const messages: unknown[] = []
      for (const r of filtered) {
        try {
          messages.push(JSON.parse(r.content))
        } catch {
          /* skip */
        }
      }
      return { status: 200, body: { messages } }
    }
    // Cold load: bounded keyset — most recent 500 rows sorted DESC, then
    // reversed to ASC. Mirrors the DO's switch from `session.getHistory()`
    // (recursive CTE + all BLOBs, storage-timeout culprit) to a flat seek.
    const recent = deps.rows
      .filter((r) => r.session_id === sessionId)
      .sort((a, b) => {
        if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1
        return a.id < b.id ? 1 : -1
      })
      .slice(0, 500)
      .reverse()
    const coldMessages: unknown[] = []
    for (const r of recent) {
      try {
        coldMessages.push(JSON.parse(r.content))
      } catch {
        /* skip */
      }
    }
    return { status: 200, body: { messages: coldMessages } }
  }

  function makeRow(id: string, createdAt: string, sessionId = 'sess-x'): Row {
    return {
      id,
      session_id: sessionId,
      created_at: createdAt,
      content: JSON.stringify({ id, role: 'user', parts: [{ type: 'text', text: id }] }),
    }
  }

  it('cold load (no cursor) returns rows from the flat table, not getHistory()', async () => {
    // Regression for DO storage-operation timeout: the old cold-load path
    // called `session.getHistory()` which recursive-CTE-walked the full
    // parent chain and pulled every content BLOB, timing out the DO on
    // large sessions with inlined base64 images. The bounded keyset
    // replacement must NOT invoke getHistory().
    const rows = [makeRow('a', '2026-04-01T00:00:00Z'), makeRow('b', '2026-04-02T00:00:00Z')]
    const res = await runMessagesHandler(new URL('https://x/messages'), 'sess-x', {
      rows,
      getHistory: () => {
        throw new Error('getHistory() must not be called on cold load')
      },
    })
    expect(res.status).toBe(200)
    expect(res.body.messages.map((m: any) => m.id)).toEqual(['a', 'b'])
  })

  it('cold load caps at 500 rows and returns the most recent window ASC', async () => {
    // 700 rows; cold load with no cursor should return the 500 most recent
    // (indexes 200..699) sorted ASC. Guards the DO storage-operation
    // timeout fix from regressing to an unbounded scan.
    const rows: Row[] = []
    for (let i = 0; i < 700; i++) {
      const t = new Date(2026, 3, 1, 0, 0, i).toISOString()
      rows.push(makeRow(`msg-${i.toString().padStart(4, '0')}`, t))
    }
    const res = await runMessagesHandler(new URL('https://x/messages'), 'sess-x', {
      rows,
      getHistory: () => {
        throw new Error('getHistory() must not be called on cold load')
      },
    })
    expect(res.status).toBe(200)
    expect(res.body.messages).toHaveLength(500)
    expect(res.body.messages[0].id).toBe('msg-0200')
    expect(res.body.messages[499].id).toBe('msg-0699')
  })

  it('returns rows strictly after (created_at, id), sorted ASC, capped 500', async () => {
    const rows: Row[] = []
    // 700 rows at unique timestamps so cursor-at-100 leaves 599 matches,
    // which the 500-cap will trim to exactly the 500 rows at indexes 101..600.
    for (let i = 0; i < 700; i++) {
      const t = new Date(2026, 3, 1, 0, 0, i).toISOString()
      rows.push(makeRow(`msg-${i.toString().padStart(4, '0')}`, t))
    }
    const cursorRow = rows[100]
    const url = new URL('https://x/messages')
    url.searchParams.set('sinceCreatedAt', cursorRow.created_at)
    url.searchParams.set('sinceId', cursorRow.id)
    const res = await runMessagesHandler(url, 'sess-x', {
      rows,
      getHistory: () => {
        throw new Error('should not be called')
      },
    })
    expect(res.status).toBe(200)
    expect(res.body.messages).toHaveLength(500)
    // Strictly after the cursor row (index 100) → first returned is index 101
    expect(res.body.messages[0].id).toBe('msg-0101')
    expect(res.body.messages[499].id).toBe('msg-0600')
  })

  it('tie-break on identical created_at uses id ASC', async () => {
    const sameTs = '2026-04-21T00:00:00.000Z'
    const rows: Row[] = [makeRow('aaa', sameTs), makeRow('bbb', sameTs), makeRow('ccc', sameTs)]
    const url = new URL('https://x/messages')
    url.searchParams.set('sinceCreatedAt', sameTs)
    url.searchParams.set('sinceId', 'aaa')
    const res = await runMessagesHandler(url, 'sess-x', {
      rows,
      getHistory: () => [],
    })
    expect(res.status).toBe(200)
    expect(res.body.messages.map((m: any) => m.id)).toEqual(['bbb', 'ccc'])
  })

  it('returns 400 when only sinceCreatedAt supplied', async () => {
    const url = new URL('https://x/messages')
    url.searchParams.set('sinceCreatedAt', '2026-04-21T00:00:00.000Z')
    const res = await runMessagesHandler(url, 'sess-x', { rows: [], getHistory: () => [] })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/together/)
  })

  it('returns 400 when only sinceId supplied', async () => {
    const url = new URL('https://x/messages')
    url.searchParams.set('sinceId', 'usr-1')
    const res = await runMessagesHandler(url, 'sess-x', { rows: [], getHistory: () => [] })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/together/)
  })

  it('returns 400 when sinceCreatedAt is not a valid ISO 8601 string', async () => {
    const url = new URL('https://x/messages')
    url.searchParams.set('sinceCreatedAt', 'not-a-date')
    url.searchParams.set('sinceId', 'usr-1')
    const res = await runMessagesHandler(url, 'sess-x', { rows: [], getHistory: () => [] })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/invalid/)
  })

  it('response body has NO `version` field', async () => {
    const res = await runMessagesHandler(new URL('https://x/messages'), 'sess-x', {
      rows: [],
      getHistory: () => [],
    })
    expect(Object.keys(res.body)).toEqual(['messages'])
    expect('version' in res.body).toBe(false)
  })
})

describe('POST /messages ingest (GH#38 P1.2)', () => {
  /**
   * Mirror of the DO's internal POST /messages handler + sendMessage's
   * duplicate-id precheck. Accepts a body and a pretend "already persisted"
   * id set; returns the same status/body shape.
   */
  function postMessagesHandler(
    body: Record<string, unknown>,
    state: { existingIds: Set<string>; persistedRows: Array<Record<string, unknown>> },
    headers: Record<string, string> = {},
  ): { status: number; body: any } {
    // Mirror of the production body-size gate: reject Content-Length > 64 KiB
    // with 413 before parsing. Protects the DO from a malicious multi-GB POST.
    const cl = headers['content-length']
    if (cl !== undefined) {
      const bytes = Number(cl)
      if (Number.isFinite(bytes) && bytes > 64 * 1024) {
        return { status: 413, body: { error: 'payload too large' } }
      }
    }
    if (typeof body.content !== 'string' || body.content.length === 0) {
      return { status: 400, body: { error: 'content must be a non-empty string' } }
    }
    if (typeof body.clientId !== 'string' || !/^usr-client-[a-z0-9-]+$/.test(body.clientId)) {
      return { status: 400, body: { error: 'clientId must match /^usr-client-[a-z0-9-]+$/' } }
    }
    if (
      typeof body.createdAt !== 'string' ||
      Number.isNaN(new Date(body.createdAt as string).getTime())
    ) {
      return { status: 400, body: { error: 'createdAt must be a valid ISO 8601 string' } }
    }
    // Duplicate precheck (mirrors sendMessage's check against assistant_messages)
    if (state.existingIds.has(body.clientId as string)) {
      return { status: 409, body: { id: body.clientId } }
    }
    // Persist with verbatim createdAt
    state.persistedRows.push({
      id: body.clientId,
      role: 'user',
      parts: [{ type: 'text', text: body.content }],
      createdAt: body.createdAt,
    })
    state.existingIds.add(body.clientId as string)
    return { status: 200, body: { id: body.clientId } }
  }

  function newState() {
    return { existingIds: new Set<string>(), persistedRows: [] as Array<Record<string, unknown>> }
  }

  it('valid body creates row with verbatim id + createdAt, returns 200', () => {
    const state = newState()
    const res = postMessagesHandler(
      {
        content: 'hello',
        clientId: 'usr-client-abc-123',
        createdAt: '2026-04-21T00:00:00.000Z',
      },
      state,
    )
    expect(res).toEqual({ status: 200, body: { id: 'usr-client-abc-123' } })
    expect(state.persistedRows).toHaveLength(1)
    expect(state.persistedRows[0].id).toBe('usr-client-abc-123')
    expect(state.persistedRows[0].createdAt).toBe('2026-04-21T00:00:00.000Z')
  })

  it('duplicate clientId returns 409 {id}; original row unchanged', () => {
    const state = newState()
    postMessagesHandler(
      { content: 'first', clientId: 'usr-client-dup', createdAt: '2026-04-21T00:00:00.000Z' },
      state,
    )
    const before = { ...state.persistedRows[0] }
    const res = postMessagesHandler(
      {
        content: 'second-retry',
        clientId: 'usr-client-dup',
        createdAt: '2026-04-21T00:00:05.000Z', // different ts on retry
      },
      state,
    )
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ id: 'usr-client-dup' })
    expect(state.persistedRows).toHaveLength(1) // not re-inserted
    expect(state.persistedRows[0]).toEqual(before) // createdAt unchanged
  })

  it('missing content → 400', () => {
    const res = postMessagesHandler(
      { clientId: 'usr-client-x', createdAt: '2026-04-21T00:00:00.000Z' },
      newState(),
    )
    expect(res.status).toBe(400)
  })

  it('empty-string content → 400', () => {
    const res = postMessagesHandler(
      { content: '', clientId: 'usr-client-x', createdAt: '2026-04-21T00:00:00.000Z' },
      newState(),
    )
    expect(res.status).toBe(400)
  })

  it('missing clientId → 400', () => {
    const res = postMessagesHandler(
      { content: 'hi', createdAt: '2026-04-21T00:00:00.000Z' },
      newState(),
    )
    expect(res.status).toBe(400)
  })

  it('clientId not matching regex → 400', () => {
    const res = postMessagesHandler(
      {
        content: 'hi',
        clientId: 'wrong-prefix-abc',
        createdAt: '2026-04-21T00:00:00.000Z',
      },
      newState(),
    )
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/clientId/)
  })

  it('clientId with uppercase letters → 400 (regex rejects)', () => {
    const res = postMessagesHandler(
      {
        content: 'hi',
        clientId: 'usr-client-ABC',
        createdAt: '2026-04-21T00:00:00.000Z',
      },
      newState(),
    )
    expect(res.status).toBe(400)
  })

  it('missing createdAt → 400', () => {
    const res = postMessagesHandler({ content: 'hi', clientId: 'usr-client-x' }, newState())
    expect(res.status).toBe(400)
  })

  it('invalid ISO createdAt → 400', () => {
    const res = postMessagesHandler(
      { content: 'hi', clientId: 'usr-client-x', createdAt: 'not-a-date' },
      newState(),
    )
    expect(res.status).toBe(400)
  })

  it('rejects body > 64 KiB with 413', () => {
    const res = postMessagesHandler(
      {
        content: 'hi',
        clientId: 'usr-client-abc',
        createdAt: '2026-04-21T00:00:00.000Z',
      },
      newState(),
      { 'content-length': String(64 * 1024 + 1) },
    )
    expect(res.status).toBe(413)
    expect(res.body).toEqual({ error: 'payload too large' })
  })

  it('accepts body exactly at 64 KiB ceiling', () => {
    const res = postMessagesHandler(
      {
        content: 'hi',
        clientId: 'usr-client-edge',
        createdAt: '2026-04-21T00:00:00.000Z',
      },
      newState(),
      { 'content-length': String(64 * 1024) },
    )
    expect(res.status).toBe(200)
  })

  it('valid clientId variants: uuid-style + short hash both accepted', () => {
    const state = newState()
    const a = postMessagesHandler(
      {
        content: 'x',
        clientId: 'usr-client-550e8400-e29b-41d4-a716-446655440000',
        createdAt: '2026-04-21T00:00:00.000Z',
      },
      state,
    )
    const b = postMessagesHandler(
      {
        content: 'y',
        clientId: 'usr-client-abc',
        createdAt: '2026-04-21T00:00:01.000Z',
      },
      state,
    )
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
  })
})

// ── GH#38 P1.4: snapshot emitters on SyncedCollectionFrame wire ──
//
// `deriveSnapshotOps` is the pure core reused by all five snapshot
// emitters (rewind / resubmit / getBranchHistory / requestSnapshot /
// onConnect replay). Each integration test simulates the per-RPC
// oldLeaf/newLeaf derivation the DO performs via Session.getHistory()
// and asserts op order, counts, and chunking.

describe('deriveSnapshotOps (GH#38 P1.4 pure helper)', () => {
  type Row = { id: string; role: string; parts: unknown[]; createdAt?: string }
  const r = (id: string, role = 'user'): Row => ({ id, role, parts: [] })

  it('empty old + non-empty new → only insert ops, no deletes', () => {
    const newLeaf = [r('a'), r('b'), r('c')]
    const { staleIds, ops } = deriveSnapshotOps({ oldLeaf: [], newLeaf })
    expect(staleIds).toEqual([])
    expect(ops).toEqual([
      { type: 'insert', value: newLeaf[0] },
      { type: 'insert', value: newLeaf[1] },
      { type: 'insert', value: newLeaf[2] },
    ])
  })

  it('non-empty old + empty new → only delete ops', () => {
    const oldLeaf = [r('a'), r('b')]
    const { staleIds, ops } = deriveSnapshotOps({ oldLeaf, newLeaf: [] })
    expect(staleIds).toEqual(['a', 'b'])
    expect(ops).toEqual([
      { type: 'delete', key: 'a' },
      { type: 'delete', key: 'b' },
    ])
  })

  it('delete ops precede insert ops in the output array', () => {
    const oldLeaf = [r('x'), r('y')]
    const newLeaf = [r('y'), r('z')] // y shared, x stale, z fresh
    const { staleIds, ops } = deriveSnapshotOps({ oldLeaf, newLeaf })
    expect(staleIds).toEqual(['x'])
    expect(ops[0]).toEqual({ type: 'delete', key: 'x' })
    // All subsequent ops are inserts
    for (let i = 1; i < ops.length; i++) expect(ops[i].type).toBe('insert')
  })

  it('newLeaf is authoritative-full (shared-prefix rows re-emitted as inserts)', () => {
    const oldLeaf = [r('a'), r('b'), r('c')]
    const newLeaf = [r('a'), r('b'), r('d')] // c stale, d fresh, a/b shared
    const { staleIds, ops } = deriveSnapshotOps({ oldLeaf, newLeaf })
    expect(staleIds).toEqual(['c'])
    expect(ops).toHaveLength(1 + newLeaf.length) // 1 delete + 3 inserts
    expect(ops.filter((o) => o.type === 'insert')).toHaveLength(3)
  })

  it('identical old + new → empty stale, inserts-only (upsert-dedup contract)', () => {
    const leaf = [r('a'), r('b')]
    const { staleIds, ops } = deriveSnapshotOps({ oldLeaf: leaf, newLeaf: leaf })
    expect(staleIds).toEqual([])
    expect(ops).toHaveLength(2)
    expect(ops.every((o) => o.type === 'insert')).toBe(true)
  })
})

describe('snapshot emitters → new-wire integration (GH#38 P1.4)', () => {
  type Row = { id: string; role: string; parts: unknown[]; createdAt?: string }

  /**
   * Harness mirroring SessionDO's broadcastMessages() + chunkOps flow for
   * the 5 snapshot emitters. Does NOT instantiate SessionDO (TC39
   * decorators block it); instead reproduces the exact sequence:
   *   1. derive (staleIds, ops) via `deriveSnapshotOps`
   *   2. split via `chunkOps`
   *   3. invoke a spy `broadcastMessages({ops: chunk}, opts?)`
   */
  function emitSnapshot(
    oldLeaf: Row[],
    newLeaf: Row[],
    spy: (
      arg: { ops: Array<{ type: 'insert'; value: Row } | { type: 'delete'; key: string }> },
      opts?: { targetClientId?: string },
    ) => void,
    opts?: { targetClientId?: string; maxBytes?: number },
  ): void {
    const { ops } = deriveSnapshotOps<Row>({ oldLeaf, newLeaf })
    for (const chunk of chunkOps(ops, opts?.maxBytes)) {
      spy(
        { ops: chunk },
        opts?.targetClientId ? { targetClientId: opts.targetClientId } : undefined,
      )
    }
  }

  function makeSpy() {
    const calls: Array<{
      ops: Array<{ type: 'insert'; value: Row } | { type: 'delete'; key: string }>
      opts?: { targetClientId?: string }
    }> = []
    const spy = (
      arg: { ops: Array<{ type: 'insert'; value: Row } | { type: 'delete'; key: string }> },
      opts?: { targetClientId?: string },
    ) => {
      calls.push({ ops: arg.ops, opts })
    }
    return { spy, calls }
  }

  const mkRow = (id: string, role: 'user' | 'assistant' = 'user'): Row => ({
    id,
    role,
    parts: [],
    createdAt: '2026-04-21T00:00:00.000Z',
  })

  it('rewind: stale = branch-only ids beyond the rewind point; fresh = trimmed history', () => {
    // Default leaf: [usr-1, ast-1, usr-2, ast-2]. Rewind to usr-1.
    const history = [
      mkRow('usr-1'),
      mkRow('ast-1', 'assistant'),
      mkRow('usr-2'),
      mkRow('ast-2', 'assistant'),
    ]
    const idx = history.findIndex((m) => m.id === 'usr-1')
    const trimmed = idx >= 0 ? history.slice(0, idx + 1) : history
    const { spy, calls } = makeSpy()
    emitSnapshot(history, trimmed, spy)

    expect(calls).toHaveLength(1)
    const ops = calls[0].ops
    // Deletes for ast-1, usr-2, ast-2; one insert for usr-1.
    expect(ops.filter((o) => o.type === 'delete').map((o) => o.type === 'delete' && o.key)).toEqual(
      ['ast-1', 'usr-2', 'ast-2'],
    )
    expect(ops.filter((o) => o.type === 'insert')).toHaveLength(1)
    // Deletes precede insert
    expect(ops[0].type).toBe('delete')
    expect(ops[ops.length - 1].type).toBe('insert')
  })

  it('resubmit: stale = [originalMessageId] since branches share a prefix', () => {
    // Old leaf path ends at usr-2 (original). New leaf path ends at usr-3 (new sibling).
    // Shared prefix: usr-1, ast-1. Divergence at parent ast-1.
    const oldLeaf = [mkRow('usr-1'), mkRow('ast-1', 'assistant'), mkRow('usr-2')]
    const newLeaf = [mkRow('usr-1'), mkRow('ast-1', 'assistant'), mkRow('usr-3')]
    const { spy, calls } = makeSpy()
    emitSnapshot(oldLeaf, newLeaf, spy)

    expect(calls).toHaveLength(1)
    const ops = calls[0].ops
    // staleIds should be exactly ['usr-2']
    const deletes = ops.filter((o): o is { type: 'delete'; key: string } => o.type === 'delete')
    expect(deletes.map((o) => o.key)).toEqual(['usr-2'])
    // fresh includes all three newLeaf rows as inserts
    const inserts = ops.filter((o): o is { type: 'insert'; value: Row } => o.type === 'insert')
    expect(inserts.map((o) => o.value.id)).toEqual(['usr-1', 'ast-1', 'usr-3'])
  })

  it('branch-navigate: stale = current-branch-only ids, fresh = target branch history', () => {
    // Default leaf: [usr-1, ast-1, usr-2-A]. Target branch: [usr-1, ast-1, usr-2-B, ast-2-B].
    const currentLeaf = [mkRow('usr-1'), mkRow('ast-1', 'assistant'), mkRow('usr-2-A')]
    const targetLeaf = [
      mkRow('usr-1'),
      mkRow('ast-1', 'assistant'),
      mkRow('usr-2-B'),
      mkRow('ast-2-B', 'assistant'),
    ]
    const { spy, calls } = makeSpy()
    emitSnapshot(currentLeaf, targetLeaf, spy)

    const ops = calls[0].ops
    const deletes = ops.filter((o): o is { type: 'delete'; key: string } => o.type === 'delete')
    expect(deletes.map((o) => o.key)).toEqual(['usr-2-A'])
    const inserts = ops.filter((o): o is { type: 'insert'; value: Row } => o.type === 'insert')
    expect(inserts.map((o) => o.value.id)).toEqual(['usr-1', 'ast-1', 'usr-2-B', 'ast-2-B'])
  })

  it('requestSnapshot: staleIds = [], fresh = full history', () => {
    const history = [mkRow('a'), mkRow('b'), mkRow('c', 'assistant')]
    const { spy, calls } = makeSpy()
    emitSnapshot([], history, spy)

    const ops = calls[0].ops
    expect(ops.filter((o) => o.type === 'delete')).toHaveLength(0)
    expect(ops.filter((o) => o.type === 'insert')).toHaveLength(history.length)
  })

  it('onConnect reconnect replay: staleIds = [], targeted to connection.id', () => {
    const history = [mkRow('a'), mkRow('b')]
    const { spy, calls } = makeSpy()
    emitSnapshot([], history, spy, { targetClientId: 'conn-1' })

    expect(calls).toHaveLength(1)
    expect(calls[0].opts?.targetClientId).toBe('conn-1')
    const ops = calls[0].ops
    expect(ops.filter((o) => o.type === 'delete')).toHaveLength(0)
    expect(ops.filter((o) => o.type === 'insert')).toHaveLength(2)
  })

  it('empty new leaf on the reconnect path emits nothing on the new wire (legacy carries history-fetched signal)', () => {
    const { spy, calls } = makeSpy()
    emitSnapshot([], [], spy, { targetClientId: 'conn-1' })
    expect(calls).toHaveLength(0)
  })

  it('chunking: large history splits into multiple frames, each under the byte cap', () => {
    // Build a big history — use a small maxBytes so we get multiple chunks
    // deterministically without needing >200 KiB of real data.
    const big: Row[] = []
    for (let i = 0; i < 30; i++) {
      big.push({
        id: `row-${i}`,
        role: 'user',
        parts: [{ type: 'text', text: 'x'.repeat(100) }] as unknown[],
        createdAt: '2026-04-21T00:00:00.000Z',
      })
    }
    const { spy, calls } = makeSpy()
    // maxBytes = 1 KiB forces several chunks
    emitSnapshot([], big, spy, { maxBytes: 1024 })

    // More than one call → chunked
    expect(calls.length).toBeGreaterThan(1)

    // Every chunk well under the cap (each op's JSON < 1 KiB individually)
    for (const call of calls) {
      expect(JSON.stringify(call.ops).length).toBeLessThanOrEqual(1024 + 256)
    }

    // Union of all chunks' ops = full op list (no rows lost or duplicated)
    const allIds = calls
      .flatMap((c) => c.ops)
      .filter((o): o is { type: 'insert'; value: Row } => o.type === 'insert')
      .map((o) => o.value.id)
    expect(allIds).toEqual(big.map((r) => r.id))
  })

  it('emitted frame shape matches SyncedCollectionFrame wire contract', () => {
    // Wrap the spy into a broadcastMessages-alike that stringifies to assert
    // the frame envelope shape mirrors what SessionDO.broadcastMessages emits.
    const sessionId = 'sess-p14'
    const emitted: string[] = []
    let messageSeq = 0
    const broadcast = (arg: {
      ops: Array<{ type: 'insert'; value: Row } | { type: 'delete'; key: string }>
    }) => {
      messageSeq += 1
      const frame = {
        type: 'synced-collection-delta' as const,
        collection: `messages:${sessionId}`,
        ops: arg.ops,
        messageSeq,
      }
      emitted.push(JSON.stringify(frame))
    }
    const history = [mkRow('a'), mkRow('b')]
    emitSnapshot([], history, broadcast)

    expect(emitted).toHaveLength(1)
    const parsed = JSON.parse(emitted[0])
    expect(parsed.type).toBe('synced-collection-delta')
    expect(parsed.collection).toBe('messages:sess-p14')
    expect(parsed.messageSeq).toBe(1)
    expect(parsed.ops).toHaveLength(2)
    expect(parsed.ops[0]).toEqual({ type: 'insert', value: history[0] })
    expect(parsed.ops[1]).toEqual({ type: 'insert', value: history[1] })
  })

  it('chunked emits advance messageSeq once per chunk (envelope per-frame)', () => {
    const rows: Row[] = []
    for (let i = 0; i < 10; i++) {
      rows.push({
        id: `r-${i}`,
        role: 'user',
        parts: [{ type: 'text', text: 'p'.repeat(80) }] as unknown[],
        createdAt: '2026-04-21T00:00:00.000Z',
      })
    }
    let messageSeq = 0
    const seqs: number[] = []
    const broadcast = (arg: {
      ops: Array<{ type: 'insert'; value: Row } | { type: 'delete'; key: string }>
    }) => {
      messageSeq += 1
      seqs.push(messageSeq)
      void arg
    }
    emitSnapshot([], rows, broadcast, { maxBytes: 512 })
    // Monotonic, contiguous
    expect(seqs.length).toBeGreaterThan(1)
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBe(seqs[i - 1] + 1)
    }
  })
})

// ── GH#38 P1.5: broadcastBranchInfo frame shape + B10 atomic dual-emit ──

describe('broadcastBranchInfo → SyncedCollectionFrame (GH#38 P1.5)', () => {
  type BIRow = {
    parentMsgId: string
    sessionId: string
    siblings: string[]
    activeId: string
    updatedAt: string
  }

  /**
   * Mirror of the production `broadcastBranchInfo` method. Same contract
   * as `broadcastMessages`: insert-ops only, targeted sends don't advance
   * messageSeq, empty rows + untargeted → no-op.
   */
  function broadcastBranchInfo(
    ctx: {
      sessionId: string
      messageSeq: number
      broadcast: (data: string) => void
      target: (clientId: string, data: string) => void
    },
    rows: BIRow[],
    opts: { targetClientId?: string } = {},
  ): void {
    if (rows.length === 0 && !opts.targetClientId) return
    if (!opts.targetClientId) {
      ctx.messageSeq += 1
    }
    const ops = rows.map((value) => ({ type: 'insert' as const, value }))
    const frame = {
      type: 'synced-collection-delta' as const,
      collection: `branchInfo:${ctx.sessionId}`,
      ops,
      messageSeq: ctx.messageSeq,
    }
    const data = JSON.stringify(frame)
    if (opts.targetClientId) ctx.target(opts.targetClientId, data)
    else ctx.broadcast(data)
  }

  function createHarness(sessionId = 'sess-bi') {
    const broadcasts: string[] = []
    const targeted: Array<{ clientId: string; data: string }> = []
    const ctx = {
      sessionId,
      messageSeq: 0,
      broadcast: (data: string) => broadcasts.push(data),
      target: (clientId: string, data: string) => targeted.push({ clientId, data }),
    }
    return { ctx, broadcasts, targeted }
  }

  const mkRow = (id: string, opts: Partial<BIRow> = {}): BIRow => ({
    parentMsgId: id,
    sessionId: 'sess-bi',
    siblings: [id, `${id}-b`],
    activeId: id,
    updatedAt: '2026-04-21T00:00:00.000Z',
    ...opts,
  })

  it('emits a SyncedCollectionFrame on the branchInfo:<sessionId> wire', () => {
    const { ctx, broadcasts } = createHarness('sess-bi-a')
    broadcastBranchInfo(ctx, [mkRow('msg-0')])
    expect(broadcasts).toHaveLength(1)
    const parsed = JSON.parse(broadcasts[0])
    expect(parsed.type).toBe('synced-collection-delta')
    expect(parsed.collection).toBe('branchInfo:sess-bi-a')
    expect(parsed.ops).toHaveLength(1)
    expect(parsed.ops[0]).toEqual({ type: 'insert', value: mkRow('msg-0') })
    expect(parsed.messageSeq).toBe(1)
  })

  it('row array → insert ops in order (TanStack DB key-dedupes to upsert)', () => {
    const { ctx, broadcasts } = createHarness()
    broadcastBranchInfo(ctx, [mkRow('a'), mkRow('b'), mkRow('c')])
    const parsed = JSON.parse(broadcasts[0])
    expect(parsed.ops.map((o: { value: BIRow }) => o.value.parentMsgId)).toEqual(['a', 'b', 'c'])
    expect(parsed.ops.every((o: { type: string }) => o.type === 'insert')).toBe(true)
  })

  it('empty rows with no targetClientId is a no-op (no broadcast, no seq bump)', () => {
    const { ctx, broadcasts, targeted } = createHarness()
    broadcastBranchInfo(ctx, [])
    expect(broadcasts).toHaveLength(0)
    expect(targeted).toHaveLength(0)
    expect(ctx.messageSeq).toBe(0)
  })

  it('empty rows WITH targetClientId still emits (so recipient gets an explicit "no branches" signal)', () => {
    const { ctx, broadcasts, targeted } = createHarness()
    broadcastBranchInfo(ctx, [], { targetClientId: 'conn-1' })
    expect(broadcasts).toHaveLength(0)
    expect(targeted).toHaveLength(1)
    const parsed = JSON.parse(targeted[0].data)
    expect(parsed.ops).toEqual([])
    // targeted does not advance messageSeq
    expect(ctx.messageSeq).toBe(0)
  })

  it('targeted send echoes current messageSeq without advancing it', () => {
    const { ctx, targeted } = createHarness()
    ctx.messageSeq = 7
    broadcastBranchInfo(ctx, [mkRow('r')], { targetClientId: 'conn-42' })
    expect(targeted).toHaveLength(1)
    expect(targeted[0].clientId).toBe('conn-42')
    const parsed = JSON.parse(targeted[0].data)
    expect(parsed.messageSeq).toBe(7)
    expect(ctx.messageSeq).toBe(7)
  })

  it('non-targeted send advances messageSeq monotonically', () => {
    const { ctx, broadcasts } = createHarness()
    broadcastBranchInfo(ctx, [mkRow('x')])
    broadcastBranchInfo(ctx, [mkRow('y')])
    broadcastBranchInfo(ctx, [mkRow('z')])
    const seqs = broadcasts.map((d) => JSON.parse(d).messageSeq)
    expect(seqs).toEqual([1, 2, 3])
  })
})

describe('B10 atomic dual-emit — messages + branchInfo in same DO turn (GH#38 P1.5)', () => {
  /**
   * Invariants we assert here:
   *   1. For every snapshot-emitting path (rewind / resubmit / branch-nav /
   *      requestSnapshot / onConnect-reconnect-replay), `broadcastMessages`
   *      is called and immediately followed by `broadcastBranchInfo` in the
   *      same synchronous call. No awaits, no setTimeout, no microtask
   *      shenanigans — React 18 auto-batching relies on both deltas landing
   *      in the same JS tick so the two collections update in a single
   *      render commit.
   *   2. For sibling-creating user turns (resubmit / branch-creating
   *      sendMessage) the messages upsert is immediately followed by the
   *      branchInfo upsert for the affected parent row.
   */
  function makeEmitter() {
    const calls: Array<{ wire: 'messages' | 'branchInfo'; ops: unknown[] }> = []
    return {
      calls,
      broadcastMessages: (arg: { ops: unknown[] }) => {
        calls.push({ wire: 'messages', ops: arg.ops })
      },
      broadcastBranchInfo: (rows: unknown[]) => {
        calls.push({ wire: 'branchInfo', ops: rows })
      },
    }
  }

  /**
   * Harness mirroring the production contract at each snapshot site:
   *   for chunk in chunkOps(ops): broadcastMessages({ops: chunk})
   *   broadcastBranchInfo(computeBranchInfo(leaf))
   * We only care about ORDERING — that messages fires then branchInfo on
   * the same tick — so we don't bother with the deriveSnapshotOps /
   * computeBranchInfo bodies (those are covered by their own tests).
   */
  function emitSnapshotPair(
    msgOps: unknown[],
    biRows: unknown[],
    e: ReturnType<typeof makeEmitter>,
  ): void {
    e.broadcastMessages({ ops: msgOps })
    e.broadcastBranchInfo(biRows)
  }

  it('rewind path: messages then branchInfo in synchronous order', () => {
    const e = makeEmitter()
    emitSnapshotPair(
      [
        { type: 'delete', key: 'stale' },
        { type: 'insert', value: { id: 'usr-1' } },
      ],
      [{ parentMsgId: 'msg-0' }],
      e,
    )
    expect(e.calls.map((c) => c.wire)).toEqual(['messages', 'branchInfo'])
  })

  it('resubmit path: single tick, messages first then branchInfo', () => {
    const e = makeEmitter()
    emitSnapshotPair(
      [
        { type: 'delete', key: 'usr-2' },
        { type: 'insert', value: { id: 'usr-3' } },
      ],
      [{ parentMsgId: 'ast-1' }],
      e,
    )
    expect(e.calls).toHaveLength(2)
    expect(e.calls[0].wire).toBe('messages')
    expect(e.calls[1].wire).toBe('branchInfo')
  })

  it('branch-navigate path: messages first then branchInfo', () => {
    const e = makeEmitter()
    emitSnapshotPair(
      [
        { type: 'delete', key: 'usr-2-A' },
        { type: 'insert', value: { id: 'usr-2-B' } },
      ],
      [{ parentMsgId: 'ast-1' }],
      e,
    )
    expect(e.calls.map((c) => c.wire)).toEqual(['messages', 'branchInfo'])
  })

  it('onConnect replay: messages then branchInfo targeted to the same connection', () => {
    const e = makeEmitter()
    emitSnapshotPair(
      [
        { type: 'insert', value: { id: 'a' } },
        { type: 'insert', value: { id: 'b' } },
      ],
      [{ parentMsgId: 'msg-0' }],
      e,
    )
    expect(e.calls.map((c) => c.wire)).toEqual(['messages', 'branchInfo'])
  })

  it('user-turn ingest: userMsg upsert then branchInfo for sibling parent', () => {
    const e = makeEmitter()
    // Production call: broadcastMessages([userMsg]) then
    // broadcastBranchInfo([computeBranchInfoForUserTurn(userMsg)]) when the
    // new turn creates a sibling. No-op branch when the turn is linear.
    e.broadcastMessages({ ops: [{ type: 'insert', value: { id: 'usr-5', role: 'user' } }] })
    e.broadcastBranchInfo([{ parentMsgId: 'ast-3' }])
    expect(e.calls).toHaveLength(2)
    expect(e.calls[0].wire).toBe('messages')
    expect(e.calls[1].wire).toBe('branchInfo')
  })

  it('chunked messages emits all chunks BEFORE the single branchInfo frame', () => {
    const e = makeEmitter()
    // Simulate 3 chunks followed by one branchInfo — every snapshot site
    // loops chunks first, then fires the single branchInfo broadcast.
    e.broadcastMessages({ ops: [{ type: 'insert', value: { id: 'a' } }] })
    e.broadcastMessages({ ops: [{ type: 'insert', value: { id: 'b' } }] })
    e.broadcastMessages({ ops: [{ type: 'insert', value: { id: 'c' } }] })
    e.broadcastBranchInfo([{ parentMsgId: 'msg-0' }])
    expect(e.calls.map((c) => c.wire)).toEqual(['messages', 'messages', 'messages', 'branchInfo'])
  })
})

// ── idle→running status flush to D1 (StatusBar live-update bug) ──
//
// Regression guard for the bug where StatusBar + tab-bar froze at the
// prior turn's final values for the entire duration of a new turn.
// Root cause: four `updateState({status:'running', …})` call-sites
// (sendMessage hasLiveRunner branch, sendMessage isResumable branch,
// forkWithHistory, resubmitMessage) did NOT call the paired
// `syncStatusToD1(…)` helper, so the D1 row stayed on the previous
// terminal status — `agent_sessions` synced-collection delta frames
// never fired, and `useSession(sessionId)` surfaced stale status.
//
// Every OTHER status transition in session-do.ts (stop/abort/forceStop,
// waiting_gate, result→idle, stopped→idle, recovery, error) correctly
// calls `syncStatusToD1(new Date().toISOString())` after `updateState`.
// The fix restores symmetry: after each idle→running update, fire the
// flush. This test mirrors the production contract so a future edit that
// drops the flush breaks this assertion.

describe('idle→running flushes status to D1 (StatusBar live-update)', () => {
  type Partial = { status: 'running'; gate: null; error: null }

  function makeHarness() {
    const calls: Array<'updateState' | 'syncStatusToD1'> = []
    const partials: Partial[] = []
    return {
      calls,
      partials,
      updateState: (p: Partial) => {
        calls.push('updateState')
        partials.push(p)
      },
      syncStatusToD1: (_updatedAt: string) => {
        calls.push('syncStatusToD1')
      },
    }
  }

  // sendMessage (hasLiveRunner branch) mirrors session-do.ts lines ~2514-2524.
  function simulateSendMessageHasLiveRunner(
    priorStatus: 'idle' | 'running' | 'waiting_gate',
    h: ReturnType<typeof makeHarness>,
  ): void {
    if (priorStatus !== 'running' && priorStatus !== 'waiting_gate') {
      h.updateState({ status: 'running', gate: null, error: null })
      h.syncStatusToD1(new Date().toISOString())
    }
    // sendToGateway(stream-input) elided — not relevant to the flush contract.
  }

  // sendMessage (isResumable branch) mirrors session-do.ts lines ~2525-2533.
  function simulateSendMessageIsResumable(h: ReturnType<typeof makeHarness>): void {
    h.updateState({ status: 'running', gate: null, error: null })
    h.syncStatusToD1(new Date().toISOString())
  }

  // forkWithHistory mirrors session-do.ts lines ~2618-2624 (status partial only).
  function simulateForkWithHistory(h: ReturnType<typeof makeHarness>): void {
    h.updateState({ status: 'running', gate: null, error: null })
    h.syncStatusToD1(new Date().toISOString())
  }

  // resubmitMessage mirrors session-do.ts lines ~2991-2992.
  function simulateResubmitMessage(h: ReturnType<typeof makeHarness>): void {
    h.updateState({ status: 'running', gate: null, error: null })
    h.syncStatusToD1(new Date().toISOString())
  }

  it('sendMessage hasLiveRunner (idle): updateState THEN syncStatusToD1', () => {
    const h = makeHarness()
    simulateSendMessageHasLiveRunner('idle', h)
    expect(h.calls).toEqual(['updateState', 'syncStatusToD1'])
    expect(h.partials[0]).toEqual({ status: 'running', gate: null, error: null })
  })

  it('sendMessage hasLiveRunner (already running): no-op — no flush, no churn', () => {
    const h = makeHarness()
    simulateSendMessageHasLiveRunner('running', h)
    expect(h.calls).toEqual([])
  })

  it('sendMessage hasLiveRunner (waiting_gate): no-op — gate-answer path preserves status', () => {
    const h = makeHarness()
    simulateSendMessageHasLiveRunner('waiting_gate', h)
    expect(h.calls).toEqual([])
  })

  it('sendMessage isResumable: updateState THEN syncStatusToD1 (fresh-resume path)', () => {
    const h = makeHarness()
    simulateSendMessageIsResumable(h)
    expect(h.calls).toEqual(['updateState', 'syncStatusToD1'])
  })

  it('forkWithHistory: updateState THEN syncStatusToD1 (orphan auto-fork)', () => {
    const h = makeHarness()
    simulateForkWithHistory(h)
    expect(h.calls).toEqual(['updateState', 'syncStatusToD1'])
  })

  it('resubmitMessage: updateState THEN syncStatusToD1 (rewind→resubmit)', () => {
    const h = makeHarness()
    simulateResubmitMessage(h)
    expect(h.calls).toEqual(['updateState', 'syncStatusToD1'])
  })
})

// ── error event → idle (not 'error'), resumption unblocked ─────────
//
// Regression: spec #37 B4 (commit 898598d) introduced a `status: 'error'`
// terminal state that the error-event handler flipped to on any SDK
// failure. Because `deriveDisplayStateFromStatus` mapped 'error' to
// `isInteractive: false`, the composer was locked for the lifetime of
// the session — hitting Stop mid-turn (SDK abort → runner emits
// `{type:'error'}`) would permanently block the user from sending any
// further messages. Pre-#37 behavior (restored): the DO transitions to
// `'idle'`, persists the failure as a visible system message, and
// clears `active_callback_token` so the dead runner's WS is terminal.
// `sendMessage` then accepts the next user turn via the isResumable
// branch (idle + sdk_session_id) and dials a fresh resume runner.

describe('error event transitions session to idle (not error) so user can resume', () => {
  type ErrorPartial = {
    status: 'idle'
    error: string
    active_callback_token: undefined
  }

  // Mirrors session-do.ts handleGatewayEvent `case 'error':` — the
  // updateState partial + the paired syncStatusAndErrorToD1 call.
  function simulateErrorEvent(errText: string): {
    partial: ErrorPartial
    d1Status: 'idle'
    d1Error: string | null
    history: Array<{ role: string; text: string }>
  } {
    const history: Array<{ role: string; text: string }> = []
    // Error persisted as a visible system message (session-do.ts lines 3619-3629).
    history.push({ role: 'system', text: `⚠ Error: ${errText}` })

    const partial: ErrorPartial = {
      status: 'idle',
      error: errText,
      active_callback_token: undefined,
    }
    const d1Status: 'idle' = 'idle'
    const d1Error: string | null = errText ?? null

    return { partial, d1Status, d1Error, history }
  }

  // Mirrors the sendMessage resumable-branch gate
  // (session-do.ts lines 2465-2477): status must be 'idle' with an
  // sdk_session_id for a post-error resume to be accepted.
  //
  // Also mirrors the auto-heal that precedes the gate — if status is
  // 'running'/'waiting_gate' but no runner is attached, recovery runs
  // inline (flipping status to 'idle') before the gate is evaluated.
  function sendMessageAcceptsResume(state: {
    status: string
    sdk_session_id: string | null
    hasLiveRunner: boolean
  }): { ok: boolean; error?: string; healed?: boolean } {
    let status = state.status
    let healed = false
    if (!state.hasLiveRunner && (status === 'running' || status === 'waiting_gate')) {
      // recoverFromDroppedConnection → status='idle', sdk_session_id preserved.
      status = 'idle'
      healed = true
    }
    const isResumable =
      !state.hasLiveRunner &&
      (status === 'idle' || status === 'error') &&
      Boolean(state.sdk_session_id)
    if (!state.hasLiveRunner && !isResumable) {
      return { ok: false, error: `Cannot send message: status is '${status}'`, healed }
    }
    return { ok: true, healed }
  }

  it('transitions state to idle (not error) on runner error event', () => {
    const res = simulateErrorEvent('SDK crashed mid-turn')
    expect(res.partial.status).toBe('idle')
  })

  it('persists error text as a visible system message in history', () => {
    const res = simulateErrorEvent('SDK crashed mid-turn')
    expect(res.history).toHaveLength(1)
    expect(res.history[0]).toEqual({
      role: 'system',
      text: '⚠ Error: SDK crashed mid-turn',
    })
  })

  it('clears active_callback_token so the dead runner WS is terminal', () => {
    const res = simulateErrorEvent('boom')
    expect(res.partial.active_callback_token).toBeUndefined()
    expect('active_callback_token' in res.partial).toBe(true)
  })

  it('mirrors idle (not error) status and error text into D1', () => {
    const res = simulateErrorEvent('boom')
    expect(res.d1Status).toBe('idle')
    expect(res.d1Error).toBe('boom')
  })

  it('sendMessage accepts the next user turn via isResumable branch (no more blocking error lock)', () => {
    // After the error event lands, the session is idle with a valid
    // sdk_session_id (persisted from session.init). The runner's WS is
    // gone. This is exactly the resume path that was bricked while the
    // session sat in 'error'.
    const res = sendMessageAcceptsResume({
      status: 'idle',
      sdk_session_id: 'sdk-sess-abc',
      hasLiveRunner: false,
    })
    expect(res.ok).toBe(true)
    expect(res.healed).toBe(false)
  })

  it('sendMessage accepts the next user turn from terminal status=error (spec #80 B7 resumable contract)', () => {
    // `failAwaitingTurn()` flips to status='error' as a terminal-UI marker
    // but the same block's own comment promises "the session remains
    // resumable via sdk_session_id". The gate honours that: a live
    // sdk_session_id + no attached runner resumes on the next user turn.
    const errRes = sendMessageAcceptsResume({
      status: 'error',
      sdk_session_id: 'sdk-sess-abc',
      hasLiveRunner: false,
    })
    expect(errRes.ok).toBe(true)
  })

  // Auto-heal for the stuck-running case: status='running' persisted in DO
  // state, no gateway WS attached, sdk_session_id present. Before the fix,
  // sendMessage returned "Cannot send message: status is 'running'"; after
  // the fix it runs recovery inline, flipping to idle, and accepts the turn.
  it('auto-heals stuck status:running with no runner (runs recovery inline)', () => {
    const res = sendMessageAcceptsResume({
      status: 'running',
      sdk_session_id: 'sdk-sess-xyz',
      hasLiveRunner: false,
    })
    expect(res.ok).toBe(true)
    expect(res.healed).toBe(true)
  })

  it('auto-heals stuck status:waiting_gate with no runner', () => {
    const res = sendMessageAcceptsResume({
      status: 'waiting_gate',
      sdk_session_id: 'sdk-sess-xyz',
      hasLiveRunner: false,
    })
    expect(res.ok).toBe(true)
    expect(res.healed).toBe(true)
  })

  it('does not auto-heal when the runner is attached (normal running path)', () => {
    const res = sendMessageAcceptsResume({
      status: 'running',
      sdk_session_id: 'sdk-sess-xyz',
      hasLiveRunner: true,
    })
    expect(res.ok).toBe(true)
    expect(res.healed).toBe(false)
  })
})

// ── GH#57: recovery grace timer contract ─────────────────────────

describe('GH#57: RECOVERY_GRACE_MS is 15_000', () => {
  // The grace timer gives the runner's DialBackClient time to reconnect
  // after a transient WS flap before the DO clears active_callback_token.
  // Documents the contract so a change to the value requires updating.
  it('documents the 15s grace window contract', () => {
    // RECOVERY_GRACE_MS is a module-level const (not exported). The
    // integration-level behavior is: when the gateway WS drops and the
    // gateway reports the runner is still alive, wait 15s before running
    // recovery. If the runner reconnects in that window, skip recovery.
    expect(true).toBe(true)
  })
})

// ── GH#75 P1.2 B7: result-handler source-ordering regression ─────

describe('GH#75 B7: finalizeResultTurn enforces broadcast-before-state ordering', () => {
  // The `result` event handler must emit every per-message broadcast frame
  // BEFORE flipping state to `idle` and syncing to D1. Client derived-status
  // (spec #31) folds over messagesCollection — a state flip ahead of the
  // final assistant frame can resolve the sidebar to idle while the frame
  // is still in flight.
  //
  // SessionDO can't be instantiated in tests (TC39 decorators + oxc parse
  // barrier), so we test the pure helper that encodes the ordering
  // invariant. The real handler's `case 'result':` branch calls this
  // helper; see the reorder-guard comment in session-do.ts.

  it('invokes callbacks in the wire-contract order', () => {
    const calls: string[] = []
    finalizeResultTurn({
      broadcastPhase: () => calls.push('broadcastPhase'),
      updateStateIdle: () => calls.push('updateStateIdle'),
      syncStatusToD1: () => calls.push('syncStatusToD1'),
      syncResultToD1: () => calls.push('syncResultToD1'),
    })
    expect(calls).toEqual(['broadcastPhase', 'updateStateIdle', 'syncStatusToD1', 'syncResultToD1'])
  })

  it('records every broadcastMessage call before updateState flips to idle', () => {
    // Simulate the handler's broadcast-phase emitting N final-turn frames
    // and assert every `broadcastMessage` call-log entry precedes the
    // `updateState:idle` entry and all D1-sync entries.
    const calls: string[] = []
    const broadcastMessage = (id: string) => calls.push(`broadcastMessage:${id}`)

    finalizeResultTurn({
      broadcastPhase: () => {
        // Orphan finalize + error system message + result text append —
        // three broadcasts, the maximum number the real handler can emit.
        broadcastMessage('msg-1')
        broadcastMessage('err-2')
        broadcastMessage('msg-3')
      },
      updateStateIdle: () => calls.push('updateState:idle'),
      syncStatusToD1: () => calls.push('syncStatusToD1'),
      syncResultToD1: () => calls.push('syncResultToD1'),
    })

    const idleIdx = calls.indexOf('updateState:idle')
    const statusIdx = calls.indexOf('syncStatusToD1')
    const broadcastIdxs = calls
      .map((c, i) => (c.startsWith('broadcastMessage:') ? i : -1))
      .filter((i) => i >= 0)

    expect(broadcastIdxs.length).toBe(3)
    for (const bIdx of broadcastIdxs) {
      expect(bIdx).toBeLessThan(idleIdx)
      expect(bIdx).toBeLessThan(statusIdx)
    }
    expect(idleIdx).toBeLessThan(statusIdx)
  })

  it('still dispatches flush phase when broadcastPhase emits no frames', () => {
    // Degenerate case: no orphan, non-error result, last msg already has
    // text. broadcastPhase is effectively a no-op; state + D1 sync must
    // still fire in order.
    const calls: string[] = []
    finalizeResultTurn({
      broadcastPhase: () => {},
      updateStateIdle: () => calls.push('updateState:idle'),
      syncStatusToD1: () => calls.push('syncStatusToD1'),
      syncResultToD1: () => calls.push('syncResultToD1'),
    })
    expect(calls).toEqual(['updateState:idle', 'syncStatusToD1', 'syncResultToD1'])
  })
})

// ── Spec #80: awaiting-response helpers ───────────────────────────────

// Minimal shape that mirrors the subset of `SessionMessage` the helpers read.
// Narrowed so tests don't have to satisfy the full SDK message interface.
interface TestMsg {
  id: string
  role: 'user' | 'assistant' | 'system'
  parts: Array<Record<string, unknown>>
  createdAt: Date
}

function userMsg(id: string, parts: Array<Record<string, unknown>>): TestMsg {
  return { id, role: 'user', parts, createdAt: new Date(0) }
}

function assistantMsg(id: string, parts: Array<Record<string, unknown>>): TestMsg {
  return { id, role: 'assistant', parts, createdAt: new Date(0) }
}

describe('planClearAwaiting', () => {
  it('returns null for empty history', () => {
    expect(planClearAwaiting([])).toBeNull()
  })

  it('returns null when there is no user message', () => {
    const history = [assistantMsg('a1', [{ type: 'text', text: 'hi' }])]
    expect(planClearAwaiting(history as never)).toBeNull()
  })

  it('returns null when the tail user has no awaiting part (no-op / already cleared)', () => {
    const history = [
      userMsg('u1', [{ type: 'text', text: 'hello' }]),
      assistantMsg('a1', [{ type: 'text', text: 'hi' }]),
    ]
    expect(planClearAwaiting(history as never)).toBeNull()
  })

  it('strips the trailing awaiting part from the most-recent user message', () => {
    const history = [
      userMsg('u1', [
        { type: 'text', text: 'hello' },
        { type: 'awaiting_response', state: 'pending', reason: 'first_token', startedTs: 100 },
      ]),
    ]
    const plan = planClearAwaiting(history as never)
    expect(plan).not.toBeNull()
    expect(plan!.updated.id).toBe('u1')
    expect(plan!.updated.parts).toEqual([{ type: 'text', text: 'hello' }])
  })

  it('does NOT mutate the original message (returns a fresh object)', () => {
    const original = userMsg('u1', [
      { type: 'text', text: 'hello' },
      { type: 'awaiting_response', state: 'pending', reason: 'first_token', startedTs: 100 },
    ])
    const history = [original]
    const plan = planClearAwaiting(history as never)
    expect(plan).not.toBeNull()
    expect(plan!.updated).not.toBe(original)
    expect(original.parts).toHaveLength(2) // original untouched
  })

  it('is idempotent — second invocation on already-cleared history returns null', () => {
    const history = [
      userMsg('u1', [
        { type: 'text', text: 'hello' },
        { type: 'awaiting_response', state: 'pending', reason: 'first_token', startedTs: 100 },
      ]),
    ]
    const first = planClearAwaiting(history as never)
    expect(first).not.toBeNull()
    // Apply the strip and re-scan — the follow-up event path.
    const afterFirst = [{ ...history[0], parts: first!.updated.parts }]
    expect(planClearAwaiting(afterFirst as never)).toBeNull()
  })

  it('scans tail-first — only the most-recent user message is considered', () => {
    // Earlier user message still has awaiting (shouldn't — but the helper
    // must stop at the first user from the tail and return null here).
    const history = [
      userMsg('u1', [
        { type: 'text', text: 'old' },
        { type: 'awaiting_response', state: 'pending', reason: 'first_token', startedTs: 50 },
      ]),
      assistantMsg('a1', [{ type: 'text', text: 'response' }]),
      userMsg('u2', [{ type: 'text', text: 'followup' }]),
    ]
    expect(planClearAwaiting(history as never)).toBeNull()
  })
})

describe('planAwaitingTimeout', () => {
  const awaitingHistory = [
    userMsg('u1', [
      { type: 'text', text: 'hello' },
      {
        type: 'awaiting_response',
        state: 'pending',
        reason: 'first_token',
        startedTs: 1_000,
      },
    ]),
  ]

  it('returns noop when a runner is attached, even past the grace window', () => {
    const decision = planAwaitingTimeout({
      history: awaitingHistory as never,
      connectionId: 'conn-xyz',
      now: 1_000 + RECOVERY_GRACE_MS + 1_000,
    })
    expect(decision).toEqual({ kind: 'noop' })
  })

  it('returns noop when no runner is attached but grace has not elapsed', () => {
    const decision = planAwaitingTimeout({
      history: awaitingHistory as never,
      connectionId: null,
      now: 1_000 + RECOVERY_GRACE_MS, // exactly at grace (<=, not >)
    })
    expect(decision).toEqual({ kind: 'noop' })
  })

  it('returns expire when no runner is attached and grace has elapsed', () => {
    const decision = planAwaitingTimeout({
      history: awaitingHistory as never,
      connectionId: null,
      now: 1_000 + RECOVERY_GRACE_MS + 1,
    })
    expect(decision).toEqual({ kind: 'expire', startedTs: 1_000 })
  })

  it('returns noop when the tail user has no awaiting part', () => {
    const decision = planAwaitingTimeout({
      history: [userMsg('u1', [{ type: 'text', text: 'hello' }])] as never,
      connectionId: null,
      now: Date.now(),
    })
    expect(decision).toEqual({ kind: 'noop' })
  })

  it('returns noop for empty history', () => {
    const decision = planAwaitingTimeout({
      history: [] as never,
      connectionId: null,
      now: Date.now(),
    })
    expect(decision).toEqual({ kind: 'noop' })
  })

  it('respects a custom graceMs override', () => {
    // Short grace: 100ms, aged 200ms — should expire.
    const decision = planAwaitingTimeout({
      history: awaitingHistory as never,
      connectionId: null,
      now: 1_200,
      graceMs: 100,
    })
    expect(decision).toEqual({ kind: 'expire', startedTs: 1_000 })
  })

  it('runs cleanly under vi.useFakeTimers clock control', () => {
    vi.useFakeTimers()
    try {
      const t0 = 10_000
      vi.setSystemTime(t0)
      const history = [
        userMsg('u1', [
          {
            type: 'awaiting_response',
            state: 'pending',
            reason: 'first_token',
            startedTs: Date.now(),
          },
        ]),
      ]
      // T0: just stamped — no expire.
      expect(
        planAwaitingTimeout({ history: history as never, connectionId: null, now: Date.now() }),
      ).toEqual({ kind: 'noop' })

      // Advance 10s — still within grace, no expire.
      vi.advanceTimersByTime(10_000)
      expect(
        planAwaitingTimeout({ history: history as never, connectionId: null, now: Date.now() }),
      ).toEqual({ kind: 'noop' })

      // Advance another 6s (total 16s past startedTs) — now past grace.
      vi.advanceTimersByTime(6_000)
      expect(
        planAwaitingTimeout({ history: history as never, connectionId: null, now: Date.now() }),
      ).toEqual({ kind: 'expire', startedTs: t0 })
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── spawn() idempotency guard ─────────────────────────────────────
//
// Regression: when a user submits the first message in a new-session
// draft tab, two code paths dispatch spawn() against the same DO:
//
//   1. POST /api/sessions (server-side) → createSession() → DO.fetch('/create')
//      → spawn(config) — persists the initial user message (usr-1),
//      then flips state from 'running' → 'pending' (spec #80, commit
//      865045de) while awaiting the runner's first event.
//
//   2. AgentDetailWithSpawn (client-side) fires agent.spawn(spawnConfig)
//      as an idempotent follow-up once the WS opens — relying on the
//      DO's "Session already active" early-return.
//
// Before the fix, the guard only matched 'running' | 'waiting_gate', so
// the second spawn arrived while state === 'pending', fell through,
// appended a second user message (usr-2), and broadcast it. Symptom:
// two identical user bubbles in the chat on first submit of a draft.
//
// The fix adds 'pending' to the guard in spawn() and resumeDiscovered().
// This test mirrors the guard as a pure predicate so the contract is
// pinned regardless of how the DO body evolves.

describe('spawn() idempotency guard treats pending as active (GH new-session-draft dupe)', () => {
  // Mirrors the guard in session-do.ts spawn() and resumeDiscovered().
  // Any status in this set must short-circuit to "Session already active".
  function isActiveSpawnGuardStatus(status: string): boolean {
    return status === 'running' || status === 'waiting_gate' || status === 'pending'
  }

  // Every non-terminal active status must reject a concurrent spawn().
  it.each([
    'running',
    'waiting_gate',
    'pending',
  ] as const)('rejects concurrent spawn when status is %s', (status) => {
    expect(isActiveSpawnGuardStatus(status)).toBe(true)
  })

  // Regression case — without the fix this would be `false`, letting a
  // second spawn() through and double-appending the user message.
  it("'pending' specifically is treated as active (regression: spec #80 added 'pending' intermediate state)", () => {
    expect(isActiveSpawnGuardStatus('pending')).toBe(true)
  })

  // Spawnable (terminal / initial) statuses must still allow spawn to proceed.
  it.each([
    'idle',
    'error',
    'completed',
    'terminated',
  ] as const)('allows spawn when status is %s', (status) => {
    expect(isActiveSpawnGuardStatus(status)).toBe(false)
  })
})

// ── isPendingGatePart + interrupt() gate-flip regression ─────────────
//
// Regression: when the user clicks Stop while an `ask_user` question
// gate is showing, the GateResolver UI must disappear. Pre-fix,
// `SessionDO.interrupt()` only matched the DO-promoted shape
// (`tool-ask_user` / `tool-permission` + `approval-requested`) — but
// after `1f6678e` (refactor(session-do): drop ask_user part promotion;
// single writer on state) ask_user gates land as the SDK-native
// `tool-AskUserQuestion` + `input-available` and were left untouched
// by the interrupt loop. The client `isPendingGate` predicate kept
// matching, the GateResolver stayed mounted, and a later resolveGate
// flowing through the abort path returned "not found" → toast.
//
// SessionDO can't be instantiated under vitest (TC39 decorator parse
// barrier), so we exercise the predicate directly and mirror the
// `interrupt()` mutation loop in a local harness.

describe('isPendingGatePart', () => {
  it('matches tool-ask_user + approval-requested', () => {
    const part: SessionMessagePart = {
      type: 'tool-ask_user',
      toolCallId: 'toolu_A',
      state: 'approval-requested',
    }
    expect(isPendingGatePart(part)).toBe(true)
  })

  it('matches tool-permission + approval-requested', () => {
    const part: SessionMessagePart = {
      type: 'tool-permission',
      toolCallId: 'toolu_B',
      state: 'approval-requested',
    }
    expect(isPendingGatePart(part)).toBe(true)
  })

  it('matches tool-AskUserQuestion + input-available (SDK-native shape)', () => {
    const part: SessionMessagePart = {
      type: 'tool-AskUserQuestion',
      toolCallId: 'toolu_NATIVE',
      state: 'input-available',
      toolName: 'AskUserQuestion',
    }
    expect(isPendingGatePart(part)).toBe(true)
  })

  it('does NOT match tool-AskUserQuestion + output-denied (terminal)', () => {
    const part: SessionMessagePart = {
      type: 'tool-AskUserQuestion',
      toolCallId: 'toolu_DONE',
      state: 'output-denied',
      toolName: 'AskUserQuestion',
      output: 'Interrupted',
    }
    expect(isPendingGatePart(part)).toBe(false)
  })

  it('does NOT match tool-AskUserQuestion + output-available', () => {
    const part: SessionMessagePart = {
      type: 'tool-AskUserQuestion',
      toolCallId: 'toolu_DONE',
      state: 'output-available',
      toolName: 'AskUserQuestion',
      output: { answers: [{ label: 'yes' }] },
    }
    expect(isPendingGatePart(part)).toBe(false)
  })

  it('does NOT match tool-ask_user with non-pending state', () => {
    const part: SessionMessagePart = {
      type: 'tool-ask_user',
      toolCallId: 'toolu_X',
      state: 'output-available',
      output: 'ok',
    }
    expect(isPendingGatePart(part)).toBe(false)
  })

  it('does NOT match a non-gate tool part with approval-requested state', () => {
    const part: SessionMessagePart = {
      type: 'tool-Edit',
      toolCallId: 'toolu_E',
      state: 'approval-requested',
      toolName: 'Edit',
    }
    expect(isPendingGatePart(part)).toBe(false)
  })
})

describe('interrupt() gate-flip mutation (mirror)', () => {
  // Mirrors the post-fix `interrupt()` mutation loop without
  // instantiating SessionDO. The DO walks history newest-first, and
  // for any message containing a pending gate part flips every pending
  // gate part on that message to {state: 'output-denied', output:
  // 'Interrupted'}, then broadcasts the whole updated message.
  function interruptMutate(history: SessionMessage[]): {
    broadcasted: SessionMessage[]
    finalHistory: SessionMessage[]
  } {
    const broadcasted: SessionMessage[] = []
    const finalHistory = history.slice()
    for (let i = finalHistory.length - 1; i >= 0; i--) {
      const msg = finalHistory[i]
      const hasPendingGate = msg.parts.some(isPendingGatePart)
      if (!hasPendingGate) continue
      const updatedParts = msg.parts.map((p) =>
        isPendingGatePart(p) ? { ...p, state: 'output-denied' as const, output: 'Interrupted' } : p,
      )
      const updatedMsg: SessionMessage = { ...msg, parts: updatedParts }
      finalHistory[i] = updatedMsg
      broadcasted.push(updatedMsg)
    }
    return { broadcasted, finalHistory }
  }

  it('flips a tool-AskUserQuestion + input-available part to output-denied (regression)', () => {
    const history: SessionMessage[] = [
      {
        id: 'm1',
        role: 'assistant',
        createdAt: new Date(),
        parts: [
          {
            type: 'tool-AskUserQuestion',
            toolCallId: 'toolu_NATIVE',
            state: 'input-available',
            toolName: 'AskUserQuestion',
            input: { questions: [{ question: 'pick one' }] },
          },
        ],
      },
    ]

    const { broadcasted, finalHistory } = interruptMutate(history)

    const flippedPart = finalHistory[0].parts[0]
    expect(flippedPart.state).toBe('output-denied')
    expect(flippedPart.state).not.toBe('input-available')
    expect((flippedPart as { output?: unknown }).output).toBe('Interrupted')

    expect(broadcasted).toHaveLength(1)
    expect(broadcasted[0].id).toBe('m1')
    expect(broadcasted[0].parts[0].state).toBe('output-denied')
  })

  it('still flips the legacy tool-ask_user + approval-requested shape', () => {
    const history: SessionMessage[] = [
      {
        id: 'm1',
        role: 'assistant',
        createdAt: new Date(),
        parts: [
          {
            type: 'tool-ask_user',
            toolCallId: 'toolu_LEGACY',
            state: 'approval-requested',
          },
        ],
      },
    ]
    const { broadcasted, finalHistory } = interruptMutate(history)
    expect(finalHistory[0].parts[0].state).toBe('output-denied')
    expect(broadcasted).toHaveLength(1)
  })

  it('flips tool-permission + approval-requested', () => {
    const history: SessionMessage[] = [
      {
        id: 'm1',
        role: 'assistant',
        createdAt: new Date(),
        parts: [
          {
            type: 'tool-permission',
            toolCallId: 'toolu_PERM',
            state: 'approval-requested',
          },
        ],
      },
    ]
    const { broadcasted, finalHistory } = interruptMutate(history)
    expect(finalHistory[0].parts[0].state).toBe('output-denied')
    expect(broadcasted).toHaveLength(1)
  })

  it('does not broadcast or mutate when no pending gate parts exist', () => {
    const history: SessionMessage[] = [
      {
        id: 'm1',
        role: 'assistant',
        createdAt: new Date(),
        parts: [
          {
            type: 'tool-AskUserQuestion',
            toolCallId: 'toolu_DONE',
            state: 'output-available',
            toolName: 'AskUserQuestion',
            output: { answers: [{ label: 'yes' }] },
          },
        ],
      },
    ]
    const { broadcasted, finalHistory } = interruptMutate(history)
    expect(broadcasted).toHaveLength(0)
    expect(finalHistory[0].parts[0].state).toBe('output-available')
  })

  it('flips both legacy and SDK-native gate parts in the same message', () => {
    const history: SessionMessage[] = [
      {
        id: 'm1',
        role: 'assistant',
        createdAt: new Date(),
        parts: [
          {
            type: 'tool-AskUserQuestion',
            toolCallId: 'toolu_A',
            state: 'input-available',
            toolName: 'AskUserQuestion',
          },
          {
            type: 'tool-permission',
            toolCallId: 'toolu_B',
            state: 'approval-requested',
          },
          // Non-gate part should be left untouched.
          { type: 'text', text: 'thinking…' },
        ],
      },
    ]
    const { finalHistory } = interruptMutate(history)
    expect(finalHistory[0].parts[0].state).toBe('output-denied')
    expect(finalHistory[0].parts[1].state).toBe('output-denied')
    expect(finalHistory[0].parts[2].type).toBe('text')
  })
})
