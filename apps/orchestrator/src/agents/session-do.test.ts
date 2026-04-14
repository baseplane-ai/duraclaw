import { describe, expect, it } from 'vitest'
import { SESSION_DO_MIGRATIONS } from './session-do-migrations'

/**
 * SessionDO tests.
 *
 * The SessionDO class uses TC39 decorators (@callable) which vitest/oxc
 * cannot parse. The core event-to-message mapping logic is tested via
 * gateway-event-mapper.test.ts. These tests cover the migration and
 * schema-level concerns.
 */

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
