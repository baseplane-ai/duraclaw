/**
 * Projects SyncedCollection -- wraps GET /api/projects with TanStack DB
 * and subscribes to `projects` delta frames pushed by UserSettingsDO.
 *
 * Data flow (GH#32 phase p4):
 *
 *   agent-gateway → POST /api/gateway/projects/sync → D1 `projects`
 *        ↓                                          ↓
 *     cold-start                               user_presence fanout
 *     GET /api/projects                  broadcastSyncedDelta per user
 *        ↓                                          ↓
 *     queryFn (rehydrate)              WS 'projects' frames → begin/write/commit
 *
 * Read-only from the user's perspective — no optimistic onInsert/onUpdate/
 * onDelete handlers; authoritative writes happen gateway-side via the
 * writeback reconcile.
 */

import type { ProjectInfo } from '@duraclaw/shared-types'
import { apiUrl } from '~/lib/platform'
import { dbReady } from './db-instance'
import { createSyncedCollection } from './synced-collection'

const persistence = await dbReady

function createProjectsCollection() {
  return createSyncedCollection<ProjectInfo, string>({
    id: 'projects',
    queryKey: ['projects'] as const,
    syncFrameType: 'projects',
    queryFn: async () => {
      const resp = await fetch(apiUrl('/api/projects'))
      if (!resp.ok) return [] as ProjectInfo[]
      const json = (await resp.json()) as { projects: ProjectInfo[] }
      return json.projects
    },
    getKey: (item) => item.name,
    persistence,
    schemaVersion: 1,
  })
}

export const projectsCollection = createProjectsCollection()
