---
type: research
classification: alignment-review
status: draft
created: 2026-04-19
workflow: RE-4ed3-0419
reviews:
  - planning/research/2026-04-17-yjs-tab-and-draft-sync-feasibility.md
  - planning/research/2026-04-18-yjs-tab-sync-design.md
related:
  - planning/specs/3-yjs-multiplayer-draft-collab.md
  - planning/specs/0008-yjs-blocknote-realtime-docs-sync.md
  - planning/research/2026-04-19-messages-transport-unification.md
---

# Yjs Doc-Sync Research — Alignment with Shipped Code

## Prompt

> "Review doc sync research and align with latest code state."

Two Yjs research docs were filed two days apart in April:

- `2026-04-17-yjs-tab-and-draft-sync-feasibility.md` — feasibility study
  that concluded "fix draft race now, migrate tabs to Yjs later when
  multiplayer chat becomes a goal". Added a §6 addendum flipping the
  recommendation to "migrate now" once multiplayer was confirmed.
- `2026-04-18-yjs-tab-sync-design.md` — implementation design that
  proposed `UserSettingsDO: YServer` with a `Y.Array<string> "openTabs"`
  and `Y.Map "workspace" { activeSessionId }` schema.

Since then, `SessionCollabDO`, `UserSettingsDO` (as `YServer`), and
`useTabSync` have all shipped. The shape that landed diverges from both
docs in ways worth recording so the next reader does not treat the older
docs as ground truth.

## TL;DR

1. **UserSettingsDO is a `YServer` now** — design doc §1.3 landed.
2. **Schema pivoted: `Y.Array<string> → Y.Map<string, JSON>`**. The risk
   the design doc flagged in §11 ("Y.Array allows duplicate sessionIds")
   was not hypothetical; push-before-IndexedDB-hydration produced real
   duplicates, so the collection type was switched. The DO carries a
   one-time `migrateArrayToMap()` helper for the transition.
3. **Active tab is local, not synced**. Design doc §1.2 put
   `activeSessionId` inside the Y.Doc. Shipped code keeps it in
   `localStorage` with `useSyncExternalStore`, because cross-device
   active-sync caused focus fights and deep-link ↔ URL ping-pong loops.
   Comment in `use-tab-sync.ts:8-13` documents the reversal.
4. **Tab entries are polymorphic (`kind: 'session' | 'chain'`)**. The
   design doc's "a tab IS a session reference, nothing else" rule was
   widened to support GitHub-issue chain tabs (§1.1 rule no longer
   holds). Entry shape is now
   `{ project?, order, kind?, issueNumber?, activeSessionId? }`
   serialised as a JSON string value. Insertion order uses a
   fractional-indexing helper (`computeInsertOrder`) so project/issue
   clusters "stay put" when a new tab joins them.
5. **Drafts split off into `SessionCollabDO`, one per session**. Neither
   research doc spelled this out — the feasibility doc's §6.4 sketch put
   draft `Y.Text` under the per-session `SessionAgent DO`. Shipped code
   uses a dedicated `SessionCollabDO` (also `YServer`), keeping the
   `SessionAgent`/`SessionDO` runner-owning concerns separate from the
   multiplayer-draft concern. Hook: `useSessionCollab`.
6. **"Agent as CRDT peer" was not adopted.** Feasibility §6.2 proposed
   piping agent streaming tokens through the session Y.Doc so everything
   rides one transport. Messages remained on the runner → DO WS +
   broadcast path and are now being unified onto TanStack DB instead
   (see `2026-04-19-messages-transport-unification.md` / issue #14). The
   CRDT-peer direction is effectively **closed**.
7. **`userTabsCollection`, `use-active-tab.ts`, `tab-utils.ts`, and the
   `/api/user-settings/tabs` CRUD routes are still on disk but have no
   live consumers** in the app code path (only self-references, tests,
   and a D1 seed read inside `UserSettingsDO.onLoad`). Phase 4 of the
   design doc ("Delete dead code") has not been executed; the files are
   stranded, not live. The D1 `user_tabs` table is still present and is
   read once by `seedFromD1()` to bootstrap fresh Y.Docs.

## Section-by-section delta

### Feasibility doc (2026-04-17)

| Section | Claim | Reality (2026-04-19) |
|---|---|---|
| §5.1 | "Fix bug now with a Lamport clock (~10 lines)." | Skipped; went straight to Yjs migration. The LWW compromise was not implemented. |
| §5.2 | "Revisit Yjs when spec 0008 starts." | Yjs was added for tabs first (issue #3 / #5), independent of spec 0008. Spec 0008 remains a separate BlockNote/mdsync initiative — not a shared-infra follow-up. |
| §6.2 | "Agent as CRDT peer — single transport." | Rejected. Messages stay on `broadcastToClients` + `messagesCollection`, with ongoing unification in issue #14 on TanStack DB, not Y.Doc. |
| §6.3 | "Awareness ('Alice is typing…'), free with Yjs." | Adopted — `useSessionCollab` publishes `user` and `typing` awareness fields on a per-session provider. |
| §6.4 | "Y.Doc 'session' on SessionAgent DO, with Y.Array<Y.Map> messages, Y.Text draft, Y.Map meta." | Only draft + meta landed, and on a separate `SessionCollabDO`, not on `SessionAgent`. Messages did not move. |
| §6.4 | "Y.Doc 'settings' on UserSettingsDO with Y.Array<Y.Map> tabs." | Became `Y.Map<string, JSON>` — see §3.2 below. |
| §6.5 | "Effort: ~3 weeks." | Core infra (SessionCollabDO + UserSettingsDO + useTabSync) landed in well under that. The scope that was cut is what made it small: no message migration, no preferences migration, no awareness-on-tabs. |

### Design doc (2026-04-18)

| Section | Claim | Reality |
|---|---|---|
| §1.2 schema | `Y.Array<string> "openTabs"` + `Y.Map "workspace" { activeSessionId }` | Replaced by `Y.Map<string> "tabs"` with polymorphic JSON values. `workspace` map does not exist. `activeSessionId` is local-only. |
| §1.3 server | `extends YServer`, clone of SessionCollabDO with `onLoad`/`onSave` | **Landed as described.** Auth `onConnect` matches §1.4. |
| §1.5 Wrangler migration | "`CREATE TABLE IF NOT EXISTS y_state` in `onLoad`" | Landed as described. |
| §2.1 hook shape | `{ openTabs, activeSessionId, openTab, closeTab, setActive, reorder, status }` | Superset landed: adds `tabProjects`, `tabEntries`, `replaceTab`, `findTabByIssue`, `hydrated`, `DRAFT_TAB_PREFIX`, `getTabSyncSnapshot()`. |
| §2.2 | "~100 lines total" | ~575 lines. Extra complexity comes from (a) chain tabs vs session tabs, (b) fractional-order cluster insertion, (c) draft tab prefix + `replaceTab` for draft→real rename, (d) one-tab-per-project dedup, (e) imperative snapshot for keyboard handlers. |
| §2.3 | IndexedDB via `y-indexeddb`, dynamic import for initial hydration | Landed as described, with `hydrated` state exposed to consumers. |
| §4 | Tab bar joins `openTabs` array against `agentSessionsCollection` map | Landed; `useLiveQuery` reads sessions, `useTabSync` provides the ordered ID list and entry metadata. |
| §5 | "Delete user-tabs-collection.ts, tab-utils.ts, use-active-tab.ts, tab CRUD endpoints" | **Not done.** All four still exist on disk. `user-tabs-collection.ts` is unreachable from live consumers; `tab-utils.ts` and `use-active-tab.ts` are stranded hooks with no consumers. API routes still route and still call `notifyInvalidation('user_tabs')` which `useInvalidationChannel` explicitly ignores. |
| §6 | One-time D1 → Y.Doc seed in `onLoad` | Landed as `seedFromD1()`. Additional code path `migrateArrayToMap()` handles the Y.Array → Y.Map pivot that the design doc didn't anticipate. |
| §7 F1 | "A tab IS a session." | True for session tabs, false for chain tabs (which are keyed by a chain key and carry an `activeSessionId` inside the entry — the chain tab's "active session" is a sub-selection within the chain). |
| §7 F5 | "Active lives in Y.Doc." | **Reversed.** Active is local, reactive via `useSyncExternalStore` on localStorage + `useTabSync`'s internal `activeState`. |
| §8 stays unchanged | "SessionCollabDO still owns multiplayer draft collaboration." | True. |
| §11 risk | "Y.Array duplicates on concurrent openTab." | Realised — but from a different cause (push-before-hydrate on a single device, not two devices racing). Fix was schema change (Y.Map), not a dedup sweep. |

## Why the active-tab reversal matters

This is the biggest architectural change from the design doc and it is
worth spelling out: the design doc argued "active in Y.Doc" unifies the
surface and kills the `selectedSessionId` drift bug. In practice:

1. **Focus fights** — if user is reading a message on Device A and
   opens a new tab on Device B, Device A's selection yanks to the new
   tab. For a multi-device user (desktop + phone), this was disorienting.
2. **Deep-link ping-pong** — the URL is the canonical "what tab am I on"
   on any given device. If URL sync writes `activeSessionId` to Y.Doc
   on navigation, and a Y.Doc observer writes URL on change, two devices
   ended up trading writes because each one's local navigation debounce
   was slightly different. Loop.
3. **Deep-link feature is per-device** — the "open this notification on
   my phone" flow is scoped to the device that got the push. Having
   "active" also scoped to device matches the UX.

The retained invariant: tab **list** syncs cross-device (you open a tab
on laptop, it appears on phone); tab **focus** does not.

## Chain tabs — a category neither doc anticipated

Shipped code supports `{ kind: 'chain', issueNumber }` tabs for
GitHub-issue-backed multi-session chains (see `useKanbanLanes`,
`ChainPage`, `nav-sessions.tsx`). The `useTabSync` API carries:

- `findTabByIssue(n)` — one-chain-per-issue dedup, independent of the
  one-tab-per-project dedup for session tabs.
- `tabEntries[tabId].activeSessionId` — which mode-session inside the
  chain is currently "live" for that chain tab.
- `computeInsertOrder` clusters by `issue:N` and `project:P` separately
  so chain tabs and session tabs can coexist on the bar without
  clobbering each other's neighbour-ordering.

This is the single biggest reason `useTabSync` is 575 lines rather than
the 100 the design doc predicted. It is not bloat — it is a product
category the spec didn't cover.

## Cleanup debt (action items, not research)

These are not research questions but they are the delta the next
implementer should clear before calling the Yjs tab migration "done":

1. **Delete `userTabsCollection`, `tab-utils.ts`, `use-active-tab.ts`.**
   Verify no live consumers (current Greps say none outside
   self-references + tests).
2. **Retire `/api/user-settings/tabs{,/:id,/reorder}` HTTP routes and
   the `notifyInvalidation('user_tabs')` call sites**, plus the
   `user_tabs` case in the notify type union and the matching tests.
3. **Drop the `user_tabs` D1 table** once `seedFromD1()` has been run
   long enough that no production user has an empty Y.Doc + unseeded
   tabs. Requires a one-shot migration; the seed code then becomes dead
   and can also be removed.
4. **Decide whether to move `activeSessionId` out of localStorage** into
   a more durable per-device store (IndexedDB? sessionStorage per PWA
   context?). Low priority — localStorage works, but it shares scope
   with draft-tab state.

## What to treat as current

For someone reading these three research docs now:

- `2026-04-17-yjs-tab-and-draft-sync-feasibility.md` — keep **§1, §2,
  §3** as architectural context; **§4's trade-off matrix** is fine;
  **§5's recommended path was abandoned**; **§6 addendum is partially
  accurate** (tabs + drafts + awareness landed; messages-as-CRDT did
  not).
- `2026-04-18-yjs-tab-sync-design.md` — §1.3, §1.4, §1.5, §2.3, §6, §9,
  §12 are accurate. §1.2 schema, §2.1/§2.2 hook shape/LOC, §5 deletion
  list, §7 F1/F5 resolutions are stale.
- **This doc** — the current synthesis.
- `2026-04-19-messages-transport-unification.md` — companion doc that
  explains why §6.4's messages-on-Y.Doc was not adopted; TanStack DB
  took that slot.

## Open questions

1. Should cleanup debt items 1–3 be a single PR ("retire D1 tabs") or
   split into "client dead-code" + "server dead-code + schema drop"?
2. Does `replaceTab` (draft → real session id) belong in `useTabSync`
   at all, or should draft tab IDs simply not exist and the "draft"
   tab be identified by absence-from-sessions? Re-read when the
   draft-session flow is next touched.
3. Should `user_preferences` also move into the `UserSettingsDO`
   Y.Doc (design doc §14 future work)? Non-urgent — D1 + invalidation
   channel work, but the two-sync-paths smell remains.

## Sources

- `apps/orchestrator/src/agents/user-settings-do.ts` (YServer, 193 L)
- `apps/orchestrator/src/agents/session-collab-do.ts` (YServer, 57 L)
- `apps/orchestrator/src/hooks/use-tab-sync.ts` (575 L)
- `apps/orchestrator/src/hooks/use-session-collab.ts`
- `apps/orchestrator/src/hooks/use-active-tab.ts` (stranded, no consumers)
- `apps/orchestrator/src/hooks/use-invalidation-channel.ts`
  (`user_tabs` dropped from collections map)
- `apps/orchestrator/src/db/user-tabs-collection.ts` (stranded)
- `apps/orchestrator/src/lib/tab-utils.ts` (stranded)
- `apps/orchestrator/src/api/index.ts` (tab CRUD routes still mounted)
- `planning/specs/3-yjs-multiplayer-draft-collab.md` (p1 shipped)
- `planning/specs/0008-yjs-blocknote-realtime-docs-sync.md` (separate initiative, not sequenced on top of this work)
- `planning/research/2026-04-19-messages-transport-unification.md`
