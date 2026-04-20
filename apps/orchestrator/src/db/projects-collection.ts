/**
 * Projects QueryCollection -- wraps GET /api/gateway/projects/all with TanStackDB.
 *
 * - Collection id: 'projects'
 * - Persisted to OPFS SQLite (schemaVersion 1)
 * - Refetch interval: 30s
 * - Stale time: 30s
 * - Keyed on project `name`
 */

import type { ProjectInfo } from '@duraclaw/shared-types'
import { persistedCollectionOptions } from '@tanstack/browser-db-sqlite-persistence'
import { createCollection } from '@tanstack/db'
import { queryCollectionOptions } from '@tanstack/query-db-collection'
import { apiUrl } from '~/lib/platform'
import { dbReady, queryClient } from './db-instance'

const queryOpts = queryCollectionOptions({
  id: 'projects',
  queryKey: ['projects'] as const,
  queryFn: async () => {
    const resp = await fetch(apiUrl('/api/gateway/projects/all'))
    if (!resp.ok) return []
    return (await resp.json()) as ProjectInfo[]
  },
  queryClient,
  getKey: (item: ProjectInfo) => item.name,
  refetchInterval: 30_000,
  staleTime: 30_000,
})

const persistence = await dbReady

function createProjectsCollection() {
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

export const projectsCollection = createProjectsCollection()
