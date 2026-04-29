// GH#122 P1.3 B-UI-7: getProjectIdByName join helper.

import { beforeEach, describe, expect, it } from 'vitest'
import { installFakeDb, makeFakeDb } from '~/api/test-helpers'
import { getProjectIdByName } from './projects'

describe('getProjectIdByName (B-UI-7)', () => {
  let fakeDb: ReturnType<typeof makeFakeDb>

  beforeEach(() => {
    fakeDb = makeFakeDb()
    installFakeDb(fakeDb.db)
  })

  it('returns the matching projectId when name exists with non-null projectId', async () => {
    fakeDb.data.queue.push([{ projectId: 'fedcba9876543210' }])
    const id = await getProjectIdByName(fakeDb.db as any, 'duraclaw')
    expect(id).toBe('fedcba9876543210')
  })

  it('returns null on unknown name (empty result set)', async () => {
    fakeDb.data.queue.push([])
    const id = await getProjectIdByName(fakeDb.db as any, 'nonexistent')
    expect(id).toBeNull()
  })

  it('returns null when name exists but projectId column is null', async () => {
    fakeDb.data.queue.push([{ projectId: null }])
    const id = await getProjectIdByName(fakeDb.db as any, 'local-only-clone')
    expect(id).toBeNull()
  })
})
