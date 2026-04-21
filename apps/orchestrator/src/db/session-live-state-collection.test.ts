/**
 * @vitest-environment jsdom
 */
import type { SessionSummary } from '@duraclaw/shared-types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Captured collection row state — a hand-rolled stand-in for the
// TanStackDB collection so we can assert the final written state after
// the insert / update path runs through `upsertSessionLiveState`.
const rows = new Map<string, Record<string, unknown>>()

const mockCollection = {
  has: vi.fn((id: string) => rows.has(id)),
  insert: vi.fn((row: Record<string, unknown>) => {
    // DB-cbb1-0420: match real TanStack DB Collection.insert — throw on
    // duplicate key so the update-first-insert-fallback path is exercised.
    if (rows.has(row.id as string)) {
      throw new Error(`duplicate key: ${row.id}`)
    }
    rows.set(row.id as string, { ...row })
  }),
  update: vi.fn((id: string, mutator: (draft: Record<string, unknown>) => void) => {
    // DB-cbb1-0420: throw on missing key so the fallback path falls
    // through to insert — mirrors TanStack DB Collection.update semantics.
    const draft = rows.get(id)
    if (!draft) throw new Error(`not found: ${id}`)
    mutator(draft)
  }),
}

vi.mock('@tanstack/db', () => ({
  createCollection: vi.fn(() => mockCollection),
  localOnlyCollectionOptions: vi.fn((opts) => opts),
}))

vi.mock('@tanstack/browser-db-sqlite-persistence', () => ({
  persistedCollectionOptions: vi.fn((opts) => opts),
}))

vi.mock('./db-instance', () => ({
  dbReady: Promise.resolve(null),
}))

async function loadModule() {
  vi.resetModules()
  return await import('./session-live-state-collection')
}

function makeSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 's-1',
    userId: 'u-1',
    project: 'proj',
    model: null,
    prompt: 'hi',
    archived: false,
    createdAt: '2026-01-01T00:00:00Z',
    status: 'idle',
    ...overrides,
  } as SessionSummary
}

describe('session-live-state-collection', () => {
  beforeEach(() => {
    rows.clear()
    vi.clearAllMocks()
  })

  it('upsertSessionLiveState insert defaults wsReadyState to 3', async () => {
    const { upsertSessionLiveState } = await loadModule()

    upsertSessionLiveState('s-1', { project: 'proj' })

    expect(mockCollection.insert).toHaveBeenCalledTimes(1)
    expect(rows.get('s-1')).toMatchObject({ id: 's-1', wsReadyState: 3, project: 'proj' })
  })

  it('upsertSessionLiveState update preserves fields omitted from the patch', async () => {
    const { upsertSessionLiveState } = await loadModule()

    // Simulate an active session: useCodingAgent writes wsReadyState: 1.
    upsertSessionLiveState('s-1', { wsReadyState: 1 })
    expect(rows.get('s-1')?.wsReadyState).toBe(1)

    // A later patch that omits wsReadyState must NOT clobber the live value.
    upsertSessionLiveState('s-1', { project: 'new-proj' })

    expect(rows.get('s-1')).toMatchObject({ wsReadyState: 1, project: 'new-proj' })
  })

  it('seedSessionLiveStateFromSummary does not clobber a live wsReadyState', async () => {
    // Regression: `backfillFromRest` fires `seedSessionLiveStateFromSummary`
    // on every window focus event. Before the fix, the seed patch
    // explicitly included `wsReadyState: 3`, which stomped the OPEN state
    // that useCodingAgent wrote and pinned the UI dot red even while the
    // socket was fine.
    const { upsertSessionLiveState, seedSessionLiveStateFromSummary } = await loadModule()

    upsertSessionLiveState('s-1', { wsReadyState: 1 })
    expect(rows.get('s-1')?.wsReadyState).toBe(1)

    seedSessionLiveStateFromSummary(makeSummary({ id: 's-1' }))

    expect(rows.get('s-1')?.wsReadyState).toBe(1)
  })

  it('seedSessionLiveStateFromSummary on a fresh row still gets the CLOSED default', async () => {
    const { seedSessionLiveStateFromSummary } = await loadModule()

    seedSessionLiveStateFromSummary(makeSummary({ id: 's-new' }))

    // Insert path: no prior row → upsert fills wsReadyState: 3 as the
    // default. Sidebar / history entries for never-opened sessions still
    // render as disconnected, which is correct.
    expect(rows.get('s-new')?.wsReadyState).toBe(3)
  })
})
