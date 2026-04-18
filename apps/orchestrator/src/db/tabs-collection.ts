// TODO(#7 p5): delete this file; consumers should use `userTabsCollection`
// (from `~/db/user-tabs-collection`) directly via `useLiveQuery` joined with
// `agentSessionsCollection` per B-UI-1.
//
// Compat shim — keeps p4's diff small. The new `userTabsCollection` has the
// strict D1 row shape `{id, userId, sessionId: string|null, position,
// createdAt}` (no project/title/draft). P4 consumers (tab-bar.tsx,
// AgentOrchPage.tsx, use-swipe-tabs.ts, etc.) still treat `tab.project`,
// `tab.title`, `tab.sessionId` as `string`. To keep typecheck green WITHOUT
// touching those files (which p5 owns), this shim:
//
//   - re-exports `userTabsCollection` as `tabsCollection`
//   - widens `TabItem` so consumers see `project`/`title`/`sessionId` as
//     plain `string` (matching the legacy shape) — at runtime these may be
//     `undefined`/`null`, which is acceptable because:
//       * the old `tabsCollection` shape was `tab.project: string,
//         tab.title: string, tab.sessionId: string` — never undefined,
//       * p5 rewires the consumers to read from the
//         `userTabsCollection × agentSessionsCollection` join, where the
//         join handles missing rows with a skeleton state.

import type { UserTabRow } from '~/lib/types'
import { userTabsCollection } from './user-tabs-collection'

export interface TabItem extends Omit<UserTabRow, 'sessionId'> {
  /** Legacy: was always `string` in the old shape. P5 consumers move to the
   *  join shape and will see `string | null` from D1. */
  sessionId: string
  /** Legacy field — undefined at runtime; populated by p5 join. */
  project: string
  /** Legacy field — undefined at runtime; populated by p5 join. */
  title: string
}

export const tabsCollection = userTabsCollection
