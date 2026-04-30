/**
 * GH#27 P1.1: smoke test for the projectMetadata table.
 *
 * Asserts that the Drizzle table is exported with the expected column
 * shape so a future refactor that drops or renames a column fails
 * loudly here rather than at runtime against D1.
 */

import { getTableColumns } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'

import { projectMetadata } from '../schema'

describe('projectMetadata schema', () => {
  it('exports the table with the expected column names', () => {
    const cols = Object.keys(getTableColumns(projectMetadata)).sort()
    expect(cols).toEqual(
      [
        'projectId',
        'projectName',
        'originUrl',
        'docsWorktreePath',
        'tombstoneGraceDays',
        'createdAt',
        'updatedAt',
        // GH#122 B-SCHEMA-2: single-owner ACL handle (ON DELETE SET NULL).
        'ownerId',
      ].sort(),
    )
  })

  it('marks projectId as the primary key', () => {
    const cols = getTableColumns(projectMetadata)
    expect(cols.projectId.primary).toBe(true)
  })

  it('makes optional columns nullable and required columns NOT NULL', () => {
    const cols = getTableColumns(projectMetadata)
    expect(cols.originUrl.notNull).toBe(false)
    expect(cols.docsWorktreePath.notNull).toBe(false)
    expect(cols.projectName.notNull).toBe(true)
    expect(cols.tombstoneGraceDays.notNull).toBe(true)
    expect(cols.createdAt.notNull).toBe(true)
    expect(cols.updatedAt.notNull).toBe(true)
  })

  it('defaults tombstoneGraceDays to 7', () => {
    const cols = getTableColumns(projectMetadata)
    expect(cols.tombstoneGraceDays.default).toBe(7)
  })
})
