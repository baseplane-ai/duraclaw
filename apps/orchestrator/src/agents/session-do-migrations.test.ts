import type { TitleUpdateEvent } from '@duraclaw/shared-types'
import { describe, expect, it } from 'vitest'
import { type MigrationSql, runMigrations } from '~/lib/do-migrations'
import { SESSION_DO_MIGRATIONS } from './session-do-migrations'

class FakeSql implements MigrationSql {
  statements: Array<{ query: string; bindings: unknown[] }> = []
  appliedVersions = new Set<number>()
  // Per-table column registry so we can simulate ALTER TABLE ADD COLUMN
  // and reject duplicate-column adds with the same message SQLite emits.
  // Tables in this set are treated as "exists"; columns are tracked in
  // `columns`.
  tables = new Set<string>(['session_meta'])
  columns = new Map<string, Set<string>>([
    ['session_meta', new Set(['id', 'message_seq', 'updated_at'])],
  ])

  exec(query: string, ...bindings: unknown[]) {
    this.statements.push({ query, bindings })

    if (query.includes('SELECT MAX(version)')) {
      const version = this.appliedVersions.size > 0 ? Math.max(...this.appliedVersions) : null
      return { toArray: () => [{ version }] }
    }

    if (query.includes('INSERT INTO _schema_version')) {
      this.appliedVersions.add(Number(bindings[0]))
      return { toArray: () => [] }
    }

    // Crude ALTER TABLE ADD COLUMN parser — enough for the migration
    // assertions, intentionally not a SQLite reimplementation.
    const alter = /ALTER TABLE (\w+) ADD COLUMN (\w+)/i.exec(query)
    if (alter) {
      const [, table, col] = alter
      const cols = this.columns.get(table)
      if (cols?.has(col)) {
        const err = new Error(`duplicate column name: ${col}`)
        throw err
      }
      if (!cols) this.columns.set(table, new Set([col]))
      else cols.add(col)
    }

    return { toArray: () => [] }
  }
}

describe('SESSION_DO_MIGRATIONS', () => {
  it('includes a v16 migration that adds the GH#86 titler columns to session_meta', () => {
    const v16 = SESSION_DO_MIGRATIONS.find((m) => m.version === 16)
    expect(v16).toBeDefined()
    expect(v16!.description.toLowerCase()).toContain('titler')
  })

  it('applies cleanly on a fresh session_meta and adds title_* columns', () => {
    const sql = new FakeSql()
    runMigrations(sql, SESSION_DO_MIGRATIONS)
    expect(sql.appliedVersions.has(16)).toBe(true)
    const cols = sql.columns.get('session_meta')!
    expect(cols.has('title')).toBe(true)
    expect(cols.has('title_confidence')).toBe(true)
    expect(cols.has('title_set_at_turn')).toBe(true)
    expect(cols.has('title_source')).toBe(true)
  })

  it('is idempotent — re-running with v16 already applied is a no-op', () => {
    const sql = new FakeSql()
    sql.appliedVersions.add(16)
    runMigrations(sql, SESSION_DO_MIGRATIONS)
    // Should not have re-issued the title column ALTERs
    const titleAlters = sql.statements.filter(
      (s) => s.query.includes('ADD COLUMN title') || s.query.includes('ADD COLUMN title_'),
    )
    expect(titleAlters).toHaveLength(0)
  })
})

describe('TitleUpdateEvent (GH#86)', () => {
  it('accepts the documented shape', () => {
    // Compile-time + runtime structural check for the wire shape — keeps
    // the spec's GatewayEvent contract from drifting. If a field is
    // renamed without updating consumers, this test fails to compile.
    const event: TitleUpdateEvent = {
      type: 'title_update',
      session_id: 'sess_abc',
      title: 'Verify 2128',
      confidence: 0.92,
      did_pivot: false,
      turn_stamp: 3,
    }
    expect(event.type).toBe('title_update')
    expect(typeof event.title).toBe('string')
    expect(typeof event.confidence).toBe('number')
    expect(typeof event.did_pivot).toBe('boolean')
    expect(typeof event.turn_stamp).toBe('number')
  })
})
