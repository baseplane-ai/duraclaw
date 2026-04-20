/**
 * SessionRecord — the SessionSummary-shaped projection session-list readers
 * consume (tab-bar, SessionHistory, kanban, chain timeline, etc.).
 *
 * Previously co-located with the session query-collection that was
 * deleted in GH#14 P5 Unit C. Lives here so consumers have a stable
 * type-only import target that does not pull in any TanStackDB
 * collection runtime.
 */

import type { SessionSummary } from '~/lib/types'

export interface SessionRecord extends SessionSummary {
  archived: boolean
}
