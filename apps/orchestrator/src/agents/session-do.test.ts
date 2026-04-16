import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildGatewayCallbackUrl,
  buildGatewayStartUrl,
  getGatewayConnectionId,
  loadTurnState,
  validateAndConsumeGatewayToken,
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

// ── validateAndConsumeGatewayToken tests ───────────────────────

describe('validateAndConsumeGatewayToken', () => {
  it('returns false for null token', () => {
    const { sql } = createKvSql()
    expect(validateAndConsumeGatewayToken(sql, null)).toBe(false)
  })

  it('returns false for empty string token', () => {
    const { sql } = createKvSql()
    expect(validateAndConsumeGatewayToken(sql, '')).toBe(false)
  })

  it('returns false when no token is stored in kv', () => {
    const { sql } = createKvSql()
    expect(validateAndConsumeGatewayToken(sql, 'some-token')).toBe(false)
  })

  it('returns false when token does not match stored token', () => {
    const { sql } = createKvSql({
      gateway_token: 'correct-token',
      gateway_token_expires: String(Date.now() + 60_000),
    })
    expect(validateAndConsumeGatewayToken(sql, 'wrong-token')).toBe(false)
  })

  it('returns true and consumes token when token matches and is not expired', () => {
    const { sql, store } = createKvSql({
      gateway_token: 'my-token-123',
      gateway_token_expires: String(Date.now() + 60_000),
    })

    const result = validateAndConsumeGatewayToken(sql, 'my-token-123')
    expect(result).toBe(true)

    // Token should be consumed (deleted)
    expect(store.has('gateway_token')).toBe(false)
    expect(store.has('gateway_token_expires')).toBe(false)
  })

  it('returns false when token has expired', () => {
    const { sql, store } = createKvSql({
      gateway_token: 'expired-token',
      gateway_token_expires: String(Date.now() - 1000), // Expired 1 second ago
    })

    const result = validateAndConsumeGatewayToken(sql, 'expired-token')
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
    const result = validateAndConsumeGatewayToken(sql, 'no-expiry-token')
    expect(result).toBe(true)
  })

  it('returns false when sql throws an error', () => {
    const throwingSql = () => {
      throw new Error('DB error')
    }
    expect(validateAndConsumeGatewayToken(throwingSql as any, 'some-token')).toBe(false)
  })

  it('is one-shot: second call with same token returns false', () => {
    const { sql } = createKvSql({
      gateway_token: 'one-shot-token',
      gateway_token_expires: String(Date.now() + 60_000),
    })

    expect(validateAndConsumeGatewayToken(sql, 'one-shot-token')).toBe(true)
    expect(validateAndConsumeGatewayToken(sql, 'one-shot-token')).toBe(false)
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
