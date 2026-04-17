export interface MigrationSql {
  exec(query: string, ...bindings: unknown[]): { toArray(): unknown[] } | unknown
}

export interface Migration {
  version: number
  description: string
  up: (sql: MigrationSql) => void
}

function readRows(result: { toArray(): unknown[] } | unknown): unknown[] {
  if (
    result &&
    typeof result === 'object' &&
    'toArray' in result &&
    typeof result.toArray === 'function'
  ) {
    return result.toArray()
  }
  return []
}

export function runMigrations(sql: MigrationSql, migrations: Migration[]): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS _schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`)

  const rows = readRows(sql.exec(`SELECT MAX(version) AS version FROM _schema_version`))
  const currentVersion = Number((rows[0] as { version?: number | null } | undefined)?.version ?? 0)

  for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
    if (migration.version <= currentVersion) {
      continue
    }

    migration.up(sql)
    sql.exec(
      `INSERT INTO _schema_version (version, applied_at) VALUES (?, ?)`,
      migration.version,
      new Date().toISOString(),
    )
  }
}
