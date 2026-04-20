/**
 * Chains SyncedCollection — wraps GET /api/chains with TanStack DB and
 * subscribes to `chains` delta frames pushed by UserSettingsDO.
 *
 * Data flow (GH#32 phase p5):
 *
 *   SessionDO.syncKataToD1 → D1 agent_sessions
 *        ↓
 *     buildChainRow(db, userId, issueNumber) → ChainSummary | null
 *        ↓
 *     broadcastSyncedDelta(env, userId, 'chains', [op]) → WS frame
 *        ↓
 *     createSyncedCollection sync wrap → begin/write/commit
 *
 * Read-only from the user's perspective — no optimistic onInsert/onUpdate/
 * onDelete handlers; authoritative writes happen server-side via kata
 * state events and session lifecycle.
 *
 * Keys are string-encoded issue numbers so that delete ops (whose wire
 * `key` is always a string per SyncedCollectionOp) collate correctly
 * with inserts/updates keyed on the same value.
 */

import { apiUrl } from '~/lib/platform'
import type { ChainSummary } from '~/lib/types'
import { dbReady } from './db-instance'
import { createSyncedCollection } from './synced-collection'

const persistence = await dbReady

function createChainsCollection() {
  return createSyncedCollection<ChainSummary, string>({
    id: 'chains',
    queryKey: ['chains'] as const,
    syncFrameType: 'chains',
    queryFn: async () => {
      const resp = await fetch(apiUrl('/api/chains'))
      if (!resp.ok) throw new Error(`GET /api/chains ${resp.status}`)
      const json = (await resp.json()) as { chains: ChainSummary[] }
      return json.chains
    },
    getKey: (item) => String(item.issueNumber),
    persistence,
    schemaVersion: 1,
  })
}

export const chainsCollection = createChainsCollection()
