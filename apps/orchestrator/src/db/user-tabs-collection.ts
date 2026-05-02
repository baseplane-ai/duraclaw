/**
 * User Tabs QueryCollection -- the new D1-backed tab list (B-CLIENT-2).
 *
 * Built on `createSyncedCollection` (GH#32 phase p3) so WS-pushed
 * `user_tabs` delta frames and `onUserStreamReconnect` resyncs are
 * wired by the shared factory. REST handlers still POST/PATCH/DELETE
 * the D1 routes; broadcasts loop back through the user-stream.
 *
 * Row shape matches the D1 `user_tabs` table after p1 / p2 / p3:
 * `{id, userId, sessionId, position, createdAt, deletedAt?}` — the
 * `deletedAt` column is soft-delete bookkeeping (p3) and GET filters
 * deleted rows out, so clients see only live tabs.
 */

import type { Transaction } from '@tanstack/db'
import { apiUrl } from '~/lib/platform'
import type { UserTabRow } from '~/lib/types'
import { getResolvedPersistence } from './db-instance'
import { lazyCollection } from './lazy-collection'
import { createSyncedCollection } from './synced-collection'

export type TabRow = UserTabRow

export async function userTabsOnInsert({ transaction }: { transaction: Transaction<UserTabRow> }) {
  for (const m of transaction.mutations) {
    const resp = await fetch(apiUrl('/api/user-settings/tabs'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(m.modified),
    })
    if (!resp.ok) {
      // Observability guardrail: stuck-tab debug (2026-04-22). A silent
      // rollback of an optimistic insert is invisible from the UI — log
      // the response body so the next recurrence leaves breadcrumbs.
      const body = await resp.text().catch(() => '<unreadable>')
      console.warn(
        '[user-tabs] POST failed',
        JSON.stringify({ status: resp.status, body: body.slice(0, 200), sent: m.modified }),
      )
      throw new Error(`Tab insert failed: ${resp.status}`)
    }
  }
}

export async function userTabsOnUpdate({ transaction }: { transaction: Transaction<UserTabRow> }) {
  for (const m of transaction.mutations) {
    const resp = await fetch(apiUrl(`/api/user-settings/tabs/${m.key}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(m.changes),
    })
    if (!resp.ok) {
      // Stuck-tab debug: the draft→real swap is a PATCH to `sessionId`.
      // A 400/500 here rolls the optimistic change back and the tab
      // reverts to the draft id. Log before throwing so the root cause
      // is visible in console / adb logcat.
      const body = await resp.text().catch(() => '<unreadable>')
      console.warn(
        '[user-tabs] PATCH failed',
        JSON.stringify({
          status: resp.status,
          body: body.slice(0, 200),
          tabId: m.key,
          changes: m.changes,
        }),
      )
      throw new Error(`Tab update failed: ${resp.status}`)
    }
  }
}

export async function userTabsOnDelete({ transaction }: { transaction: Transaction<UserTabRow> }) {
  for (const m of transaction.mutations) {
    const resp = await fetch(apiUrl(`/api/user-settings/tabs/${m.key}`), { method: 'DELETE' })
    // HTTP DELETE is idempotent — a 404 means the row is already gone, which
    // is exactly the post-state we want. Throwing here would cause TanStack
    // DB to roll back the optimistic delete and resurrect the row, leaving
    // the user with a "zombie" tab they can't close. This matters now that
    // the server-side atomic dedup in POST /api/user-settings/tabs
    // soft-deletes the previous project tab as part of its db.batch — the
    // client's own optimistic dedup loop in `openTab` then fires a DELETE
    // against the same row and races the server's soft-delete. 404 is the
    // expected outcome of that race; treat it as success.
    if (!resp.ok && resp.status !== 404) {
      const body = await resp.text().catch(() => '<unreadable>')
      console.warn(
        '[user-tabs] DELETE failed',
        JSON.stringify({ status: resp.status, body: body.slice(0, 200), tabId: m.key }),
      )
      throw new Error(`Tab delete failed: ${resp.status}`)
    }
  }
}

function createUserTabsCollection() {
  return createSyncedCollection<UserTabRow, string>({
    id: 'user_tabs',
    queryKey: ['user_tabs'] as const,
    syncFrameType: 'user_tabs',
    queryFn: async () => {
      const resp = await fetch(apiUrl('/api/user-settings/tabs'))
      if (!resp.ok) return [] as UserTabRow[]
      const json = (await resp.json()) as { tabs: UserTabRow[] }
      return json.tabs
    },
    getKey: (item) => item.id,
    persistence: getResolvedPersistence(),
    schemaVersion: 1,

    onInsert: userTabsOnInsert,
    onUpdate: userTabsOnUpdate,
    onDelete: userTabsOnDelete,
  })
}

/**
 * GH#164: lifted top-level await for Hermes. Lazy proxy resolves on
 * first property access, which is always post-bootstrap.
 */
export const userTabsCollection = lazyCollection(createUserTabsCollection)
