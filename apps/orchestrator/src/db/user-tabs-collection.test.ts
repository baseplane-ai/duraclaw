/**
 * @vitest-environment jsdom
 *
 * Regression tests for the user-tabs collection mutation handlers.
 *
 * Bug context (2026-04-29, regression from 933f9a0): the atomic server-side
 * dedup in `POST /api/user-settings/tabs` now soft-deletes the previous
 * project tab as part of its db.batch. The client's `openTab` ALSO fires an
 * optimistic `tabs.delete(oldRow.id)` for the same row (long-standing dedup
 * loop in `useTabSync.openTab`). When the collection's `onDelete` then
 * issues `DELETE /api/user-settings/tabs/{id}`, the server returns 404 (the
 * row is already soft-deleted). The handler used to throw on 404 →
 * TanStack DB rolled back the optimistic delete → row resurrected. Symptom:
 * the X button no longer closes the tab — every click hits the same loop.
 *
 * Fix: HTTP DELETE is idempotent. 404 means "already gone" — exactly the
 * post-state we want. Treat it as success.
 */

import type { Transaction } from '@tanstack/db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UserTabRow } from '~/lib/types'

// GH#164: collection modules now read persistence synchronously via
// `getResolvedPersistence()` (the legacy top-level-await of dbReady was
// lifted to unblock Hermes). Stub both: dbReady for any code path still
// awaiting it, getResolvedPersistence for the synchronous read inside
// the lazy factory. We also mock the @tanstack/db boundary so
// constructing the live `userTabsCollection` doesn't require a real
// persistence layer or a query client.
vi.mock('./db-instance', () => ({
  dbReady: Promise.resolve(null),
  getResolvedPersistence: () => null,
  queryClient: { invalidateQueries: vi.fn() },
}))

vi.mock('@tanstack/browser-db-sqlite-persistence', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  persistedCollectionOptions: vi.fn((opts: any) => opts),
}))

vi.mock('@tanstack/db', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createCollection: vi.fn((config: any) => ({ __config: config })),
}))

vi.mock('~/hooks/use-user-stream', () => ({
  subscribeUserStream: vi.fn(() => () => {}),
  onUserStreamReconnect: vi.fn(() => () => {}),
}))

// Build a minimal Transaction whose `mutations` carry just enough fields
// for the handlers to read. The handlers only ever touch `m.key`,
// `m.modified`, and `m.changes`.
function makeDeleteTransaction(tabId: string): Transaction<UserTabRow> {
  return {
    mutations: [
      {
        key: tabId,
        modified: { id: tabId } as UserTabRow,
        changes: {},
      },
    ],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

describe('user-tabs-collection onDelete (404 idempotence regression)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does NOT throw when the server returns 404 (row already soft-deleted server-side)', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response('Not Found', { status: 404, statusText: 'Not Found' }),
    )

    const { userTabsOnDelete } = await import('./user-tabs-collection')
    await expect(userTabsOnDelete({ transaction: makeDeleteTransaction('tab-1') })).resolves.toBe(
      undefined,
    )

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(String(url)).toContain('/api/user-settings/tabs/tab-1')
    expect((init as RequestInit).method).toBe('DELETE')

    // 404 is the normal post-dedup outcome now — must NOT log a warning.
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('does NOT throw on a successful 200/204 delete', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 204 }))

    const { userTabsOnDelete } = await import('./user-tabs-collection')
    await expect(userTabsOnDelete({ transaction: makeDeleteTransaction('tab-2') })).resolves.toBe(
      undefined,
    )
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('STILL throws on a non-404 server error (500) — legitimate-error path preserved', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response('boom', { status: 500, statusText: 'Internal Server Error' }),
    )

    const { userTabsOnDelete } = await import('./user-tabs-collection')
    await expect(userTabsOnDelete({ transaction: makeDeleteTransaction('tab-3') })).rejects.toThrow(
      /Tab delete failed: 500/,
    )

    // 500 is a legitimate failure — we still want the breadcrumb log.
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0][0]).toBe('[user-tabs] DELETE failed')
  })

  it('STILL throws on a 400-class error other than 404 (e.g. 403)', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response('forbidden', { status: 403, statusText: 'Forbidden' }),
    )

    const { userTabsOnDelete } = await import('./user-tabs-collection')
    await expect(userTabsOnDelete({ transaction: makeDeleteTransaction('tab-4') })).rejects.toThrow(
      /Tab delete failed: 403/,
    )
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })
})
