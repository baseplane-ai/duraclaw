---
initiative: synced-collections-pattern
type: project
issue_type: feature
status: draft
priority: high
github_issue: null
created: 2026-04-20
updated: 2026-04-20
phases:
  - id: p1
    name: "createSyncedCollection factory + DO delta-frame protocol"
    tasks:
      - "Create apps/orchestrator/src/db/synced-collection.ts: factory wrapping queryCollectionOptions. Accepts {id, getKey, queryKey, queryFn (initial load), onInsert/onUpdate/onDelete (optimistic user writes), syncFrameType: string, persistence?, schemaVersion?}. Internally wires a custom SyncConfig.sync that subscribes to the shared user-stream WS and dispatches frames matching syncFrameType via begin() → write() → commit()."
      - "Define the delta-frame wire shape in packages/shared-types/src/index.ts: `SyncedCollectionFrame = {type: 'synced-collection-delta', collection: string, ops: Array<{type: 'insert'|'update'|'delete', value?: Row, key?: string}>}`. No seq field (full-fetch reconciliation on reconnect; hot incremental during connected session)."
      - "Add apps/orchestrator/src/hooks/use-user-stream.ts: single-WS connection to UserSettingsDO (replaces useInvalidationChannel). Exposes a subscribe(frameType, handler) API that the factory registers against. Auto-reconnects via partysocket; on reconnect, each registered collection re-fires its queryFn (initial load path) to resync."
      - "Unit tests in apps/orchestrator/src/db/synced-collection.test.ts: (a) initial queryFn populates syncedData, (b) incoming delta frame routes to correct collection by name, (c) begin/write/commit emits IVM updates reactive to useLiveQuery, (d) reconnect triggers re-fetch."
    test_cases:
      - id: "factory-initial-load"
        description: "createSyncedCollection({queryFn: returns 3 rows}) populates syncedData with 3 rows on cold start. useLiveQuery observer sees all 3."
        type: "unit"
      - id: "delta-frame-routing"
        description: "User stream receives {type:'synced-collection-delta', collection:'user_tabs', ops:[{type:'insert', value:{id:'t1',…}}]}. Tabs collection gets the row; unrelated collections are unaffected."
        type: "unit"
      - id: "loopback-dedup"
        description: "Client does optimistic insert via tx.mutate(() => coll.insert(row)). Server echoes the same row back via delta frame. Collection state contains exactly one row with the final server-authoritative values; useLiveQuery fires exactly twice (optimistic, echo-settle) — no third update, no delete+insert churn. Verified via deep-equality assertions in the test."
        type: "unit"

  - id: p2
    name: "UserSettingsDO: retire Y.Doc, add delta-frame fanout"
    tasks:
      - "In apps/orchestrator/src/agents/user-settings-do.ts: delete the Y.Doc subsystem (Y.Array tabs, Y.Map prefs, yjs imports, Y observer callbacks, Hocuspocus integration if present). Replace with a thin WebSocketHibernate-backed fanout that holds a Set<WebSocket> for the user and a dispatch method broadcastSyncedDelta(frame: SyncedCollectionFrame) that JSON.stringify's and ws.send()s to every connected session."
      - "Add HTTP endpoint POST /broadcast on UserSettingsDO: accepts {collection, ops} in body, authenticates via a worker-internal shared secret (reuse CC_GATEWAY_SECRET or add SYNC_BROADCAST_SECRET), calls broadcastSyncedDelta. Invoked by the API-route layer after each D1 write."
      - "Update apps/orchestrator/src/api/user-settings/tabs.ts POST/PATCH/DELETE handlers: after the D1 write, fetch the authoritative row(s) and POST to the UserSettingsDO /broadcast endpoint with {collection:'user_tabs', ops:[{type:'insert'|'update'|'delete', value|key}]}. Use the same worker-internal fetch pattern used elsewhere for DO→DO RPC."
      - "Update apps/orchestrator/src/api/preferences.ts PUT handler: same pattern — after D1 upsert, broadcast {collection:'user_preferences', ops:[{type:'update', value: row}]}."
      - "Retire apps/orchestrator/src/api/notify.ts's {type:'invalidate', collection, keys} broadcast shape. The new delta-frame shape supersedes it. Keep the /notify HTTP endpoint as a transport but repurpose its body to carry {collection, ops} directly."
      - "Retire apps/orchestrator/src/hooks/use-invalidation-channel.ts. Its one remaining consumer (user_preferences refetch) moves onto the new user-stream."
    test_cases:
      - id: "do-delta-fanout"
        description: "Two WS clients connected to the same UserSettingsDO user room. Client A writes a tab via POST /api/user-settings/tabs. Both A and B receive a {type:'synced-collection-delta', collection:'user_tabs', ops:[{type:'insert', value:{id, …}}]} frame within 500ms. Verified via integration test with two WebSocket mocks."
        type: "integration"
      - id: "yjs-retirement"
        description: "user-settings-do.ts has zero imports from 'yjs' or 'y-protocols'. No Y.Doc, Y.Array, Y.Map references. Verified via rg 'yjs|Y\\.' apps/orchestrator/src/agents/user-settings-do.ts → 0 matches."
        type: "audit"
      - id: "invalidation-channel-retired"
        description: "No file apps/orchestrator/src/hooks/use-invalidation-channel.ts exists. No imports reference it. Verified via rg."
        type: "audit"

  - id: p3
    name: "Migrate user_tabs + user_preferences onto factory"
    tasks:
      - "D1 migration: ALTER TABLE user_tabs ADD COLUMN deleted_at TEXT. Update agent-orch drizzle schema.ts to reflect. Update queries in /api/user-settings/tabs to filter `WHERE deleted_at IS NULL` on reads, and set deleted_at via UPDATE on DELETE endpoint (soft delete). The broadcast fanout still emits a {type:'delete', key} op for the client — soft-delete is an internal audit detail, not a wire-protocol concern."
      - "Rewrite apps/orchestrator/src/db/user-tabs-collection.ts using createSyncedCollection. Retain onInsert/onUpdate/onDelete handlers (POST/PATCH/DELETE to /api/user-settings/tabs) — they're the optimistic-layer user-write path. Remove all persistence-behind custom code that's now in the factory."
      - "Rewrite apps/orchestrator/src/db/user-preferences-collection.ts using createSyncedCollection. Single-row shape preserved (keyed on userId). onInsert/onUpdate handlers point at /api/preferences PUT as today."
      - "Delete apps/orchestrator/src/lib/tab-utils.ts if the factory's consumer API supersedes it, else trim to just the tab-ordering helpers that don't touch the collection directly."
      - "Verify tab-bar renders correctly during a cross-browser scenario: browser A opens a new tab → browser B (same user) sees the tab within 500ms. Confirmed via scripts/verify/axi-both."
    test_cases:
      - id: "cross-browser-tab-sync"
        description: "Two browsers signed in as the same user. Browser A opens a new session tab. Browser B's tab bar shows the new tab within 1s without manual refresh. scripts/verify/axi-both snapshot confirms tab presence on both."
        type: "e2e"
      - id: "soft-delete-filters"
        description: "DELETE /api/user-settings/tabs/X sets deleted_at. Subsequent GET /api/user-settings/tabs does not return X. Database row still exists (verified via D1 SELECT *)."
        type: "integration"
      - id: "optimistic-tab-open"
        description: "Open a new tab: new tab appears in UI instantly (optimistic). If POST fails (stubbed 500), the optimistic tab disappears via TanStack DB rollback. If POST succeeds, the server echo reconciles via deep-equality — no visible flash or flicker."
        type: "e2e"

  - id: p4
    name: "Projects → D1 via gateway writeback"
    tasks:
      - "D1 migration: create `projects` table {name TEXT PRIMARY KEY, display_name TEXT, root_path TEXT, updated_at TEXT, deleted_at TEXT}. Drizzle schema.ts update."
      - "New API route apps/orchestrator/src/api/gateway/projects/sync.ts: POST endpoint authenticated via CC_GATEWAY_SECRET. Body: {projects: ProjectInfo[]}. Performs a transactional reconcile: upsert every row from payload, soft-delete rows present in D1 but absent from payload. After write, POST {collection:'projects', ops:[…]} to every connected user's UserSettingsDO /broadcast endpoint — or better, broadcast to a new 'global' room that user DOs subscribe to. (Design decision in p4 subtask.)"
      - "Gateway change in packages/agent-gateway/src/server.ts: on project manifest scan (existing recurring discovery loop), POST to /api/gateway/projects/sync with the current project list instead of just exposing them via GET. Retain the GET endpoint for operators but make the push the authoritative sync path."
      - "Rewrite apps/orchestrator/src/db/projects-collection.ts: queryFn reads from /api/projects (new endpoint, reads D1), not /api/gateway/projects/all. Use createSyncedCollection. Remove the 30s refetchInterval — delta frames replace polling."
      - "Add apps/orchestrator/src/api/projects.ts: GET handler reads D1 projects joined with user_preferences.hiddenProjects for visibility filtering. Returns {projects: ProjectInfo[]}."
      - "Update consumers: project sidebar, create-session dialog, session-card project chip. Replace reads of old projectsCollection.toArray with useLiveQuery on the new collection. Delete the duplicate fetch-from-gateway client-side paths."
    test_cases:
      - id: "gateway-to-d1-sync"
        description: "Gateway discovers a new project /data/projects/duraclaw-dev5. Within 30s, /api/projects returns it. Connected browsers receive a synced-collection-delta frame and their project sidebars update without page reload."
        type: "e2e"
      - id: "hidden-project-filter"
        description: "User preferences has hiddenProjects=['legacy-project']. GET /api/projects does not return legacy-project. Other users unaffected."
        type: "integration"
      - id: "no-gateway-polling"
        description: "rg 'refetchInterval' apps/orchestrator/src/db/projects-collection.ts returns 0 matches. rg '/api/gateway/projects/all' apps/orchestrator/src/ returns 0 matches (endpoint retired)."
        type: "audit"

  - id: p5
    name: "Chains migration + Zustand-free invalidation"
    tasks:
      - "Rewrite apps/orchestrator/src/db/chains-collection.ts onto createSyncedCollection. Source data still comes from /api/chains (reads D1 agent_sessions grouped by kataIssue). Delta frames fire when any agent_session row with a kata_issue changes — add the broadcast hook to wherever ProjectRegistry updates kata state today."
      - "Confirm: chains consumers (kata sidebar, chain-preconditions hooks) continue to work. useLiveQuery on the new collection replaces any imperative refetch."
      - "Run full test suite and scripts/axi end-to-end smoke: open chain sidebar, create a kata-linked session, verify chain card appears within 1s."
    test_cases:
      - id: "chain-live-update"
        description: "Create a kata session with --issue=27. Chain sidebar's card for issue 27 updates status in real-time (running → idle) without polling. Verified via scripts/axi snapshot before + after session stop."
        type: "e2e"
      - id: "chains-no-poll"
        description: "rg 'refetchInterval' apps/orchestrator/src/db/chains-collection.ts returns 0 matches."
        type: "audit"

  - id: p6
    name: "Cleanup + docs"
    tasks:
      - "Update CLAUDE.md architecture section: document createSyncedCollection as the canonical pattern for user-scoped reactive collections. Reference the SyncConfig.sync TanStack DB primitive and the optimistic-layer + synced-layer split explicitly."
      - "Delete any remaining Zustand stores that duplicated synced-collection state (spot-check `apps/orchestrator/src/stores/*.ts` for dead references)."
      - "Remove partysocket dependency if no longer used (grep imports first). UserSettingsDO WS is hibernatable / plain CF Durable Object WebSocket API."
      - "Update planning/research/2026-04-20-streamdb-pattern-adoption.md: mark the forward-looking sections as 'implemented' with a link back to this spec."
    test_cases:
      - id: "docs-up-to-date"
        description: "CLAUDE.md contains a 'Synced collections' section describing the factory and the optimistic/synced-layer split. References are accurate against the shipped code."
        type: "review"
      - id: "no-dead-stores"
        description: "No Zustand stores hold server-state fields that now live in a synced collection. Verified via file-by-file audit."
        type: "audit"
---

# GH#28: Unified Synced-Collection Pattern for User-Scoped Data

## Overview

Four user-scoped TanStack DB collections (`user_tabs`, `user_preferences`,
`projects`, `chains`) each hand-roll their own sync story: REST polling,
invalidation-then-refetch, Y.Doc CRDT, or nothing. The Y.Doc layer in
`UserSettingsDO` was adopted because the team hit walls with TanStack DB's
API; GH#14 (messages) proved the library's actual sync primitive
(`SyncConfig.sync` + `begin/write/commit`) is the right fit. This spec
retires the ad-hoc paths, retires Y.Doc, and lands a single
`createSyncedCollection` factory that drives all four collections off a
unified WS delta stream from a slimmed-down `UserSettingsDO`.

Messages (`messagesCollection`) is NOT in scope — it already uses the
sync-write API directly from `useCodingAgent`'s WS handler (GH#14, commit
`bc57fcb`). Its per-session DO + `seq`+`snapshot`+`delta` wire protocol is
a separate pattern appropriate for hot event streams.

## Background

### Why this now

- Commit `bc57fcb` ("use queryCollection sync-write API for WS-pushed
  messages") proved TanStack DB's `SyncConfig.sync` primitive works when
  used correctly — writes on the synced layer drive IVM / `useLiveQuery`.
- `UserSettingsDO`'s Y.Doc subsystem exists because earlier attempts hit
  the same optimistic-vs-synced-layer confusion. It's now dead weight.
- New user-scoped collections (chains, projects) lack a template. Without
  a canonical pattern, every new collection reinvents.

### What TanStack DB actually gives us

- `SyncConfig.sync({begin, write, commit, markReady, truncate})` — the
  real incremental sync primitive. Write a custom sync fn that
  subscribes to a WS and calls `begin/write/commit` per delta frame.
- `collection.utils.writeBatch / writeUpsert / writeDelete` — external
  wrappers around the same `begin/write/commit` (implementation in
  `@tanstack/query-db-collection/manual-sync.js`).
- Loopback handled by deep-equality in `applySuccessfulResult` (and
  analogous paths for external writes). Optimistic + synced layers
  reconcile automatically — no watermark tracking, no tombstone table,
  no client-side dedup required.
- `onInsert / onUpdate / onDelete` — the optimistic-layer user-write
  path. Fires `mutationFn`, reconciles on echo. Stays.

## Feature Behaviors

### B1: createSyncedCollection factory

**Core:**
- **ID:** synced-collection-factory
- **Trigger:** A collection file calls `createSyncedCollection({...})`.
- **Expected:** Returns a `Collection` whose synced layer is driven by a
  custom `SyncConfig.sync` that (a) fires `queryFn` once on cold start to
  populate initial rows via `begin → write(insert) → commit → markReady`,
  (b) subscribes to the user-stream WS, (c) on each frame matching
  `syncFrameType`, applies ops via `begin → write → commit`. Optimistic
  user writes via `onInsert/onUpdate/onDelete` continue to work unchanged.
- **Verify:** Unit test in `synced-collection.test.ts` — see `p1.test_cases`.
- **Source:** new file `apps/orchestrator/src/db/synced-collection.ts`.

#### Data Layer

```typescript
// apps/orchestrator/src/db/synced-collection.ts
export interface SyncedCollectionConfig<TRow, TKey extends string> {
  id: string
  getKey: (row: TRow) => TKey
  queryKey: readonly unknown[]
  /** Initial cold-start fetch. Called once on sync() start. */
  queryFn: () => Promise<TRow[]>
  /** Wire-protocol discriminator — matches frames from UserSettingsDO. */
  syncFrameType: string
  /** Optional optimistic handlers for user writes. */
  onInsert?: (ctx: { transaction: Transaction<TRow> }) => Promise<unknown>
  onUpdate?: (ctx: { transaction: Transaction<TRow> }) => Promise<unknown>
  onDelete?: (ctx: { transaction: Transaction<TRow> }) => Promise<unknown>
  persistence?: OPFSPersistence
  schemaVersion?: number
}

export function createSyncedCollection<TRow extends object, TKey extends string>(
  config: SyncedCollectionConfig<TRow, TKey>,
): Collection<TRow, TKey>
```

#### API Layer

N/A — consumers only.

---

### B2: UserSettingsDO delta-frame fanout

**Core:**
- **ID:** user-settings-do-fanout
- **Trigger:** API route writes data (POST/PATCH/DELETE to D1) AND posts
  `{collection, ops}` to the DO's `/broadcast` endpoint.
- **Expected:** DO iterates its connected WS set and broadcasts
  `{type:'synced-collection-delta', collection, ops}` JSON-encoded to
  each session. Y.Doc subsystem is gone.
- **Verify:** Integration test — two mock WS clients, POST to one DO,
  observe frames on both.

#### API Layer

```
POST /agents/user-settings/:userId/broadcast
Auth: worker-internal (SYNC_BROADCAST_SECRET or reuse CC_GATEWAY_SECRET)
Body: {collection: string, ops: Array<{type:'insert'|'update'|'delete', value?: object, key?: string}>}
Returns: 204 No Content on success
```

#### Data Layer

No D1 changes for this behavior. DO state: `Set<WebSocket>` per user
room, no Y.Doc storage.

---

### B3: Soft-delete for user_tabs

**Core:**
- **ID:** user-tabs-soft-delete
- **Trigger:** DELETE `/api/user-settings/tabs/:id`.
- **Expected:** D1 row updated with `deleted_at = CURRENT_TIMESTAMP`.
  GET endpoint filters `WHERE deleted_at IS NULL`. Broadcast fanout
  emits `{type:'delete', key: id}` op — wire protocol sees a normal
  delete, soft-delete is an internal audit-trail detail.
- **Verify:** Integration test — DELETE an id, verify GET doesn't return
  it but D1 row persists with `deleted_at` set.

#### Data Layer

```sql
ALTER TABLE user_tabs ADD COLUMN deleted_at TEXT;
```

Drizzle schema update in `apps/orchestrator/src/db/schema.ts`.

---

### B4: Projects → D1 via gateway writeback

**Core:**
- **ID:** projects-d1-writeback
- **Trigger:** Agent gateway's project manifest scan (recurring, ~30s)
  detects a change.
- **Expected:** Gateway POSTs current project list to
  `/api/gateway/projects/sync`. CF worker reconciles D1 (upsert present,
  soft-delete absent), then broadcasts `{collection:'projects', ops:[…]}`
  to every connected UserSettingsDO. Clients receive the delta and
  update reactively.
- **Verify:** E2E — add a project directory, observe the sidebar within
  30s without page reload.

#### API Layer

```
POST /api/gateway/projects/sync
Auth: Bearer CC_GATEWAY_SECRET
Body: {projects: ProjectInfo[]}
Returns: 204 No Content

GET /api/projects
Auth: session cookie
Returns: {projects: ProjectInfo[]} — joined with user_preferences.hiddenProjects for the caller
```

#### Data Layer

```sql
CREATE TABLE projects (
  name TEXT PRIMARY KEY,
  display_name TEXT,
  root_path TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
```

Drizzle schema update.

---

### B5: Y.Doc retirement

**Core:**
- **ID:** yjs-retirement
- **Trigger:** Code audit.
- **Expected:** Zero `yjs` or `y-protocols` imports in
  `apps/orchestrator/src/agents/user-settings-do.ts`. No `Y.Doc`,
  `Y.Array`, `Y.Map` references. Package.json may retain `yjs` if used
  elsewhere (check `apps/orchestrator/src/lib/yjs-client.ts` for draft
  collab — that's a separate concern).
- **Verify:** `rg 'yjs|Y\\.' apps/orchestrator/src/agents/user-settings-do.ts`
  returns 0 matches.

#### Data Layer

Deletion only. No schema change.

---

### B6: Optimistic write loopback reconciles cleanly

**Core:**
- **ID:** optimistic-loopback-deep-equality
- **Trigger:** User-initiated write triggers `onInsert/onUpdate/onDelete`
  mutationFn POST. Server processes, writes D1, broadcasts delta frame.
  Client receives its own write back via the sync path.
- **Expected:** Collection state contains exactly one row for the
  affected key. `useLiveQuery` observer fires exactly twice (once for
  optimistic apply, once for echo-settle). No flicker. No delete+insert
  churn. TanStack DB's `deepEquals` check suppresses the third update.
- **Verify:** Unit test with a spy on `useLiveQuery` render count.

#### UI Layer

No visible flicker on optimistic settle. Verified by scripts/axi snapshot
diff: no intermediate blank frame.

---

## Non-Goals

- **Messages migration.** `messagesCollection` already uses the correct
  API after `bc57fcb`. Rewriting it onto `createSyncedCollection` is
  possible but out of scope — its per-session DO scope, seq-based
  ordering, and snapshot-on-gap protocol are purpose-built for hot event
  streams and don't map cleanly onto the user-scoped factory.
- **Yjs for draft collab.** `apps/orchestrator/src/lib/yjs-client.ts`
  (draft `Y.Text` for composer) is a separate feature and stays.
- **Offline write queue.** Optimistic writes still fail-fast when the
  network is down. Durable offline support is a separate spec.
- **Watermark / since= incremental sync.** Rejected during design —
  TanStack DB's deep-equality reconciler handles loopback for free; for
  the collections in scope, the DO always has current state so delta-
  push is sufficient, and on reconnect the factory re-fires `queryFn`
  (full fetch) to resync.
- **Per-key invalidation optimization.** Frames carry ops directly;
  there's no "invalidate, then refetch by key" dance.

## Open Questions

- [ ] **Global room for cross-user project broadcasts?** Projects are
  gateway-global. One design: UserSettingsDO instances subscribe to a
  shared "global" DO that fans out project deltas. Simpler: API route
  iterates all active UserSettingsDO instances (tracked via a session
  index) and POSTs `/broadcast` to each. The second is fine at our
  scale and avoids a new DO. Default to that unless load tests say
  otherwise.
- [ ] **Migration from existing user_tabs Yjs state.** On first boot
  after p2 ships, existing tabs are in the Y.Doc (if any persisted
  server-side — verify). We need either (a) a one-shot migration that
  drains Y.Doc state into D1 if missing, or (b) confirmation that D1 is
  already the source of truth and Y.Doc was only client-shared-state.
  Inspect `user-settings-do.ts` during p2 to confirm.
- [ ] **CC_GATEWAY_SECRET vs SYNC_BROADCAST_SECRET.** Using one secret
  for two concerns (gateway→worker and worker→DO broadcast) reduces
  config surface but couples compromise scopes. Decide during p2 impl;
  start with one shared secret, split only if audit requires.

## Implementation Phases

See YAML frontmatter `phases:` above. Rough estimates:

- p1: 1 day (factory + tests + delta-frame types)
- p2: 1 day (DO refactor, delete Y.Doc, add /broadcast)
- p3: 0.5 day (tabs + prefs migration, both are straightforward)
- p4: 1-1.5 days (D1 table, gateway writeback, API changes, sidebar rewire)
- p5: 0.5 day (chains is thin)
- p6: 0.5 day (cleanup, docs)

Total: ~5 days of focused work.

## Verification Strategy

### Test Infrastructure

- `vitest` with `jsdom` — existing config at
  `apps/orchestrator/vitest.config.ts`. All new unit tests land here.
- `scripts/verify/axi-both` for cross-browser tab sync (B3 e2e test).
- `scripts/verify/dev-up.sh` local stack for end-to-end verification.

### Build Verification

- `pnpm typecheck` at repo root — must pass across all packages.
- `pnpm test` at `apps/orchestrator/` — all 697+ tests pass (no
  regressions). New tests in p1-p5 add ~30-50 cases.
- Local D1 migration: `pnpm --filter @duraclaw/orchestrator drizzle:migrate`.

## Verification Plan

### VP1: Cross-browser tab sync (B3)

Steps:
1. `scripts/verify/dev-up.sh` — local stack up.
2. `scripts/verify/axi-dual-login.sh` — both browsers logged in as same user.
3. In browser A: `scripts/verify/axi-a click @new-tab-button`.
   Expected: new tab appears in A's tab bar immediately (optimistic).
4. `scripts/verify/axi-b snapshot` within 1s.
   Expected: new tab appears in B's tab bar.
5. D1 query: `SELECT * FROM user_tabs WHERE user_id = ?`.
   Expected: row with `deleted_at IS NULL`.
6. In browser A: click close-tab on the new tab.
   Expected: removed from both A and B's tab bars within 1s.
7. D1 query again.
   Expected: row still present with `deleted_at` set.

### VP2: Projects live-update from gateway (B4)

Steps:
1. `scripts/verify/dev-up.sh` — stack up including agent-gateway.
2. Open browser, sidebar shows N projects.
3. `mkdir /data/projects/duraclaw-dev99 && cd /data/projects/duraclaw-dev99 && git init`.
4. Wait up to 30s for gateway's next discovery pass.
5. `scripts/axi snapshot` on the sidebar.
   Expected: sidebar now shows N+1 projects including `duraclaw-dev99`.
6. Check D1: `SELECT * FROM projects`.
   Expected: row with `name='duraclaw-dev99'`, `deleted_at IS NULL`.
7. `rm -rf /data/projects/duraclaw-dev99` and wait 30s.
8. Sidebar: project disappears. D1 row persists with `deleted_at` set.

### VP3: Y.Doc retirement audit (B5)

Steps:
1. `rg -n 'yjs|Y\\.Doc|Y\\.Array|Y\\.Map' apps/orchestrator/src/agents/user-settings-do.ts`.
   Expected: 0 matches.
2. `rg -n 'useInvalidationChannel' apps/orchestrator/src/`.
   Expected: 0 matches (file deleted + no imports).
3. `grep -c '"hocuspocus' apps/orchestrator/package.json`.
   Expected: 0 (if hocuspocus was only for user-settings; otherwise verify
   no user-settings-do references).

### VP4: Optimistic loopback (B6)

Steps:
1. Add a console.count spy into a test component wrapping
   `useLiveQuery(userTabsCollection)` — instruments render count.
2. `scripts/axi click @new-tab-button` — fires optimistic insert.
3. Wait for server echo (< 500ms).
4. Inspect render count: must be exactly 2 (optimistic apply + echo
   settle). A third render indicates deep-equality dedup isn't working
   and would cause UI flicker.

### VP5: No regressions in existing collections

Steps:
1. `pnpm test` at `apps/orchestrator/`.
   Expected: all tests pass. No count drop from current 697.
2. `pnpm typecheck` at repo root.
   Expected: 0 errors.
3. `scripts/verify/dev-up.sh && scripts/axi open http://localhost:$VERIFY_ORCH_PORT`.
4. Send a chat message in an open session.
   Expected: message streams live (GH#14 regression check — the messages
   path we fixed in `bc57fcb` must still work).

## Implementation Hints

### Dependencies

No new npm dependencies. All primitives exist in:
- `@tanstack/db@0.6.4`
- `@tanstack/query-db-collection@1.0.35`
- `@tanstack/browser-db-sqlite-persistence@0.1.8`

Removals (possibly):
- `yjs` / `y-protocols` / `hocuspocus-*` — verify no other consumers
  before uninstalling.

### Key Imports

| Module | Import | Used For |
|--------|--------|----------|
| `@tanstack/db` | `createCollection`, `SyncConfig` | Factory internals |
| `@tanstack/query-db-collection` | `queryCollectionOptions` | Still used — wraps the queryFn + onInsert/onUpdate/onDelete plumbing |
| `@tanstack/browser-db-sqlite-persistence` | `persistedCollectionOptions` | OPFS persistence |
| `@duraclaw/shared-types` | `SyncedCollectionFrame` (new) | Wire protocol types |

### Code Patterns

**Factory skeleton:**

```typescript
// apps/orchestrator/src/db/synced-collection.ts
import { createCollection } from '@tanstack/db'
import { queryCollectionOptions } from '@tanstack/query-db-collection'
import { persistedCollectionOptions } from '@tanstack/browser-db-sqlite-persistence'
import { subscribeUserStream } from '~/hooks/use-user-stream'
import { dbReady, queryClient } from './db-instance'

export function createSyncedCollection<TRow extends object, TKey extends string>(
  config: SyncedCollectionConfig<TRow, TKey>,
) {
  const baseOpts = queryCollectionOptions({
    id: config.id,
    queryKey: config.queryKey,
    queryFn: config.queryFn,
    queryClient,
    getKey: config.getKey,
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: false,
    onInsert: config.onInsert,
    onUpdate: config.onUpdate,
    onDelete: config.onDelete,
  })

  // Wrap sync: preserve queryCollection's initial-load behavior, then
  // subscribe to the user-stream for incremental deltas.
  const originalSync = baseOpts.sync.sync
  baseOpts.sync.sync = (params) => {
    const queryCleanup = originalSync(params)  // fires queryFn, markReady
    const unsub = subscribeUserStream(config.syncFrameType, (frame) => {
      params.begin()
      for (const op of frame.ops) {
        if (op.type === 'delete') params.write({ type: 'delete', key: op.key, value: undefined as never })
        else params.write({ type: op.type, value: op.value })
      }
      params.commit()
    })
    return () => {
      unsub()
      if (typeof queryCleanup === 'function') queryCleanup()
    }
  }

  const persistence = config.persistence
  if (persistence) {
    return createCollection(persistedCollectionOptions({
      ...baseOpts, persistence, schemaVersion: config.schemaVersion ?? 1,
    }) as never)
  }
  return createCollection(baseOpts)
}
```

**Consumer example (user_tabs):**

```typescript
// apps/orchestrator/src/db/user-tabs-collection.ts (rewritten)
export const userTabsCollection = createSyncedCollection<UserTabRow, string>({
  id: 'user_tabs',
  queryKey: ['user_tabs'] as const,
  getKey: (row) => row.id,
  syncFrameType: 'user_tabs',
  queryFn: async () => {
    const resp = await fetch('/api/user-settings/tabs')
    const json = (await resp.json()) as { tabs: UserTabRow[] }
    return json.tabs
  },
  onInsert: async ({ transaction }) => {
    for (const m of transaction.mutations) {
      await fetch('/api/user-settings/tabs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(m.modified),
      })
    }
  },
  onUpdate: /* PATCH */,
  onDelete: /* DELETE */,
  persistence: await dbReady,
})
```

**DO broadcast:**

```typescript
// apps/orchestrator/src/agents/user-settings-do.ts (after Y.Doc deletion)
export class UserSettingsDO extends DurableObject {
  private sockets = new Set<WebSocket>()

  async fetch(req: Request) {
    if (req.headers.get('Upgrade') === 'websocket') {
      const [client, server] = Object.values(new WebSocketPair())
      this.ctx.acceptWebSocket(server)
      this.sockets.add(server)
      return new Response(null, { status: 101, webSocket: client })
    }
    if (new URL(req.url).pathname.endsWith('/broadcast')) {
      // Auth check
      const auth = req.headers.get('Authorization')
      if (auth !== `Bearer ${this.env.SYNC_BROADCAST_SECRET}`) return new Response(null, { status: 401 })
      const body = await req.json() as SyncedCollectionFrame
      const frame = JSON.stringify({ type: 'synced-collection-delta', ...body })
      for (const ws of this.sockets) {
        try { ws.send(frame) } catch { this.sockets.delete(ws) }
      }
      return new Response(null, { status: 204 })
    }
    return new Response('not found', { status: 404 })
  }

  webSocketClose(ws: WebSocket) { this.sockets.delete(ws) }
}
```

### Gotchas

- **`begin/write/commit` must be synchronous within a single frame.**
  Mixing async work between `begin` and `commit` wedges the sync
  transaction. If you need to fetch something, fetch first, then wrap
  the writes in `begin/commit`.
- **`write({type:'delete', key})` shape differs from insert/update.**
  Delete takes `key`, not `value`. TypeScript will let you get this
  wrong — double-check against
  `@tanstack/db/dist/esm/types.d.ts` `ChangeMessageOrDeleteKeyMessage`.
- **`deepEquals` loopback protection compares *values*.** If the server
  echoes a row with a different `updated_at` than the optimistic row
  carries, it will fire an update. This is correct behavior — the
  server-authoritative `updated_at` should replace the optimistic
  client-set one. But make sure optimistic rows don't carry a
  client-set `updated_at` that's guaranteed to mismatch, or you'll
  eat an unnecessary render per write.
- **OPFS persistence + `syncConfig.sync`.** `persistedCollectionOptions`
  wraps the config; confirm that our sync-fn wrapping survives that
  layer. If it doesn't, the factory needs to apply persistence AFTER
  the sync-wrap.
- **Reconnect behavior.** When the WS disconnects and reconnects, the
  `subscribeUserStream` hook re-fires. The collection should re-fire
  `queryFn` on reconnect to resync (not just resume deltas — they might
  have been missed). Build this into the factory.

### Reference Docs

- [`@tanstack/db` SyncConfig](https://tanstack.com/db/latest/docs/reference/type-aliases/syncconfig) — the primitive we're building on.
- `packages/shared-transport/` — our existing dial-back WS pattern for
  messages. Don't reuse, but the reconnect + buffer semantics are a
  reference.
- `planning/research/2026-04-20-streamdb-pattern-adoption.md` — root-
  cause analysis and design rationale leading to this spec.
- `apps/orchestrator/node_modules/@tanstack/query-db-collection/dist/esm/query.js` line 500-565 (`applySuccessfulResult`) — shows the built-in diff-reconcile path and the `deepEquals` loopback guard.
