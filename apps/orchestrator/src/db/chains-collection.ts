/**
 * Chains QueryCollection — wraps GET /api/chains with TanStackDB.
 *
 * One entry per kata-linked GitHub issue (see ChainSummary in lib/types).
 * Mirrors agentSessionsCollection: OPFS-persisted, 30s refetch, 15s stale.
 */

import { persistedCollectionOptions } from '@tanstack/browser-db-sqlite-persistence'
import { createCollection } from '@tanstack/db'
import { queryCollectionOptions } from '@tanstack/query-db-collection'
import type { ChainSummary } from '~/lib/types'
import { dbReady, queryClient } from './db-instance'

const queryOpts = queryCollectionOptions({
  id: 'chains',
  queryKey: ['chains'] as const,
  queryFn: async () => {
    const resp = await fetch('/api/chains')
    const json = (await resp.json()) as { chains: ChainSummary[] }
    return json.chains
  },
  queryClient,
  getKey: (item: ChainSummary) => item.issueNumber,
  refetchInterval: 30_000,
  staleTime: 15_000,
})

const persistence = await dbReady

function createChainsCollection() {
  if (persistence) {
    const opts = persistedCollectionOptions({
      ...queryOpts,
      persistence,
      schemaVersion: 1,
    })
    // TanStackDB beta: persistedCollectionOptions adds a schema type that
    // conflicts with createCollection overloads. Runtime behavior is correct.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return createCollection(opts as any)
  }

  return createCollection(queryOpts)
}

export const chainsCollection = createChainsCollection()
