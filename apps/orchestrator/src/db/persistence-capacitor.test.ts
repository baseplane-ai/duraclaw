import { describe, expect, it, vi } from 'vitest'

const mockExecute = vi.fn()
const mockQuery = vi.fn().mockResolvedValue({ values: [{ id: 1 }] })
const mockOpen = vi.fn()

vi.mock('@capacitor-community/sqlite', () => ({
  CapacitorSQLite: {},
  SQLiteConnection: class {
    isConnection = vi.fn().mockResolvedValue({ result: false })
    retrieveConnection = vi.fn().mockResolvedValue({
      open: mockOpen,
      execute: mockExecute,
      query: mockQuery,
    })
    createConnection = vi.fn().mockResolvedValue({
      open: mockOpen,
      execute: mockExecute,
      query: mockQuery,
    })
  },
}))

vi.mock('@tanstack/capacitor-db-sqlite-persistence', () => ({
  createCapacitorSQLitePersistence: vi.fn(({ database }) => ({ database })),
}))

describe('createCapacitorPersistence', () => {
  it('opens a SQLite connection and wraps it in the TanStack persistence', async () => {
    const { createCapacitorPersistence } = await import('./persistence-capacitor')
    const persistence = await createCapacitorPersistence()
    expect(mockOpen).toHaveBeenCalled()
    expect(persistence).toBeDefined()
  })
})
