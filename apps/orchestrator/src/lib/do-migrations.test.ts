import { describe, expect, it } from 'vitest'
import { runMigrations, type MigrationSql, type Migration } from './do-migrations'

class FakeSql implements MigrationSql {
  statements: Array<{ query: string; bindings: unknown[] }> = []
  appliedVersions = new Set<number>()

  exec(query: string, ...bindings: unknown[]) {
    this.statements.push({ query, bindings })

    if (query.includes('SELECT MAX(version)')) {
      const version = this.appliedVersions.size > 0 ? Math.max(...this.appliedVersions) : null
      return {
        toArray: () => [{ version }],
      }
    }

    if (query.includes('INSERT INTO _schema_version')) {
      this.appliedVersions.add(Number(bindings[0]))
    }

    return {
      toArray: () => [],
    }
  }
}

describe('runMigrations', () => {
  const migrations: Migration[] = [
    {
      version: 1,
      description: 'first',
      up: (sql) => {
        sql.exec('CREATE TABLE one (id INTEGER)')
      },
    },
    {
      version: 2,
      description: 'second',
      up: (sql) => {
        sql.exec('ALTER TABLE one ADD COLUMN name TEXT')
      },
    },
  ]

  it('applies migrations in order and records versions', () => {
    const sql = new FakeSql()

    runMigrations(sql, migrations)

    expect(sql.appliedVersions).toEqual(new Set([1, 2]))
    expect(sql.statements.map((statement) => statement.query)).toContain('CREATE TABLE one (id INTEGER)')
    expect(sql.statements.map((statement) => statement.query)).toContain('ALTER TABLE one ADD COLUMN name TEXT')
  })

  it('skips migrations that are already applied', () => {
    const sql = new FakeSql()
    sql.appliedVersions.add(2)

    runMigrations(sql, migrations)

    expect(sql.statements.map((statement) => statement.query)).not.toContain('CREATE TABLE one (id INTEGER)')
    expect(sql.statements.map((statement) => statement.query)).not.toContain('ALTER TABLE one ADD COLUMN name TEXT')
  })

  it('handles an empty migration list', () => {
    const sql = new FakeSql()

    runMigrations(sql, [])

    expect(sql.statements[0]?.query).toContain('CREATE TABLE IF NOT EXISTS _schema_version')
    expect(sql.appliedVersions.size).toBe(0)
  })
})
