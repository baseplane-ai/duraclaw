---
initiative: synced-collections-pattern
type: project
issue_type: feature
status: draft
priority: high
github_issue: 32
created: 2026-04-20
updated: 2026-04-20
phases:
  - id: p1
    name: "createSyncedCollection factory + DO delta-frame protocol"
    depends_on: []
    tasks:
      - "Create apps/orchestrator/src/db/synced-collection.ts: factory wrapping queryCollectionOptions. Accepts {id, getKey, queryKey, queryFn (initial load), onInsert/onUpdate/onDelete (optimistic user writes), syncFrameType: string, persistence?, schemaVersion?}. Internally wires a custom SyncConfig.sync that subscribes to the shared user-stream WS and dispatches frames matching syncFrameType via begin() → write() → commit()."
      - "Define the delta-frame wire shape in packages/shared-types/src/index.ts as a discriminated union — `SyncedCollectionOp<Row> = {type: 'insert', value: Row} | {type: 'update', value: Row} | {type: 'delete', key: string}`, then `SyncedCollectionFrame<Row> = {type: 'synced-collection-delta', collection: string, ops: Array<SyncedCollectionOp<Row>>}`. The discriminated union prevents malformed frames (e.g., `delete` without `key`, `insert` without `value`) at compile time — no optional value/key fields. No seq field (full-fetch reconciliation on reconnect; hot incremental during connected session)."
      - "Add apps/orchestrator/src/hooks/use-user-stream.ts: single-WS connection to UserSettingsDO (replaces useInvalidationChannel). Exposes a subscribe(frameType, handler) API that the factory registers against. Reconnect: keep `partysocket` as the client-side WS wrapper (it handles exponential backoff + jitter already — rewriting that in p1 is out of scope and we already depend on it for useInvalidationChannel today). `partysocket` stays in package.json; p6's 'remove partysocket' task in the earlier draft is struck (the server-side y-partyserver is what goes away with Y.Doc, the client-side partysocket stays). On reconnect, each registered collection re-fires its queryFn (initial load path) to resync. See B7 for the full reconnect + in-flight optimistic semantics."
      - "Unit tests in apps/orchestrator/src/db/synced-collection.test.ts: (a) initial queryFn populates syncedData, (b) incoming delta frame routes to correct collection by name, (c) begin/write/commit emits IVM updates reactive to useLiveQuery, (d) reconnect triggers re-fetch."
    test_cases:
      - id: "factory-initial-load"
        description: "createSyncedCollection({queryFn: returns 3 rows}) populates syncedData with 3 rows on cold start. useLiveQuery observer sees all 3."
        type: "unit"
      - id: "delta-frame-routing"
        description: "User stream receives {type:'synced-collection-delta', collection:'user_tabs', ops:[{type:'insert', value:{id:'t1',…}}]}. Tabs collection gets the row; unrelated collections are unaffected."
        type: "unit"
      - id: "loopback-dedup"
        description: "Client does optimistic insert via tx.mutate(() => coll.insert(row)). Server echoes the same row back via delta frame. Collection state contains exactly one row with the final server-authoritative values; sync-layer write transactions fire exactly twice (optimistic apply + echo-settle) — no third transaction, no delete+insert churn. Verified by spying on SyncConfig.write() calls (deterministic) and deep-equality of the final row."
        type: "unit"
      - id: "reconnect-post-response-lost"
        description: "B7 case 1 — client starts an optimistic insert via onInsert/mutationFn. Stub fetch so the POST *reaches* the server (D1 gets the row) but the response is dropped (mutationFn's await never resolves to success). WS drops and reconnects; queryFn runs and returns the row from D1. Assert: exactly one row in the collection, SyncConfig.write() fires exactly twice (optimistic apply + sync-reconcile), no third write. The optimistic transaction eventually settles cleanly when its matching synced row arrives."
        type: "unit"
      - id: "reconnect-post-never-reached"
        description: "B7 case 2 — client starts an optimistic insert. Stub fetch to fail (network error). WS drops and reconnects; queryFn returns the current D1 state (without the optimistic row). Assert: mutationFn throws → TanStack DB rolls back the optimistic layer → the row disappears from useLiveQuery output. No stray row remains."
        type: "unit"
      - id: "reconnect-delete-lost"
        description: "B7 case 3 — client optimistically deletes a row. Stub the DELETE fetch to fail. WS drops and reconnects; queryFn returns D1 state (which still contains the row because the DELETE never reached the server). Assert: the row reappears in the UI after the optimistic tx rollback. This is the explicitly accepted behavior documented in B7 — verify the spec's expectation matches runtime."
        type: "unit"

  - id: p2a
    name: "UserSettingsDO: retire Y.Doc, DO rewrite + user_presence"
    depends_on: [p1]
    tasks:
      - "Scope boundary: this phase touches ONLY apps/orchestrator/src/agents/user-settings-do.ts. apps/orchestrator/src/agents/session-collab-do.ts (draft Y.Text collab DO extending YServer) is NOT touched — confirm via rg before editing that no shared imports, types, or state exist between the two files."
      - "In apps/orchestrator/src/agents/user-settings-do.ts: delete the Y.Doc subsystem (Y.Map tabs, y-partyserver YServer base class, yjs imports, onLoad/onSave/migrateArrayToMap/seedFromD1 methods, the `y_state` table DDL and reads). Data-loss audit confirms D1 `user_tabs` is authoritative: the existing `seedFromD1()` populates the Y.Doc FROM D1 on first load; writes go through the `/api/user-settings/tabs` REST handlers (at `api/index.ts` lines 748/800/829/846) which write D1. The `y_state` DO SQLite table becomes dead storage on the first post-deploy load — drop it in the same migration with `DROP TABLE IF EXISTS y_state`. No client user data lives only in Y.Doc."
      - "Replace YServer with `extends DurableObject` using the WebSocket Hibernation API: accept sockets via `this.ctx.acceptWebSocket(server)` (NOT `server.accept()` — hibernation requires the former) and implement `webSocketClose(ws, code, reason, wasClean)` / `webSocketError(ws, error)` lifecycle methods. Hibernation API guarantees webSocketClose fires even after the DO is evicted and reloaded — the user_presence row cleanup relies on this. If the DO is evicted with sockets still attached, they're persisted and close events are delivered on the next invocation. Authenticate in fetch() upgrade handler (cookie userId === room name — reuse existing onConnect logic). Maintain the in-memory Set<WebSocket> by repopulating from `this.ctx.getWebSockets()` on DO init (called by CF runtime after hibernation wake)."
      - "D1 migration: CREATE TABLE user_presence (user_id TEXT PRIMARY KEY, first_connected_at TEXT NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE). Drizzle schema.ts update."
      - "user_presence reference-counting rule: on ctx.acceptWebSocket, if `this.sockets.size === 0` BEFORE adding the new socket → `INSERT OR IGNORE INTO user_presence (user_id, first_connected_at) VALUES (?, ?)` (0→1 transition). On webSocketClose, remove from this.sockets FIRST, then if `this.sockets.size === 0` → `DELETE FROM user_presence WHERE user_id = ?` (N→0 transition). Intermediate opens and closes (size > 0 before/after) do not touch D1. The DO's in-memory socket set is the source of truth for the user's live connection count; D1 is a materialised active-user index."
    test_cases:
      - id: "yjs-retirement"
        description: "user-settings-do.ts has zero imports from 'yjs', 'y-partyserver', or 'y-protocols'. No Y.Doc, Y.Array, Y.Map references. The y_state table does not appear in DO storage after first post-deploy boot (DROP TABLE ran). session-collab-do.ts is unchanged (still imports y-partyserver for draft collab). Verified via `rg 'yjs|y-partyserver|Y\\.Doc|Y\\.Array|Y\\.Map' apps/orchestrator/src/agents/user-settings-do.ts` → 0 matches."
        type: "audit"
      - id: "user-presence-tracking"
        description: "Reference-counting behavior of user_presence. (a) First WS for user U → INSERT OR IGNORE fires, row exists. (b) Second WS for U (size 1→2) → no D1 write (in-memory only). (c) Close one of two WS for U (size 2→1) → no D1 DELETE (row still present). (d) Close the final WS for U (size 1→0) → DELETE fires, row gone. Verified via spies on the D1 prepare/bind calls from the DO in the integration test."
        type: "integration"

  - id: p2b
    name: "UserSettingsDO: /broadcast endpoint + API handler wiring"
    depends_on: [p2a]
    tasks:
      - "Add HTTP endpoint POST /broadcast on UserSettingsDO: accepts `SyncedCollectionFrame` body, authenticates via `SYNC_BROADCAST_SECRET` (new wrangler secret — scoped separately from CC_GATEWAY_SECRET so gateway compromise doesn't unlock fanout; see Implementation Hints § Secrets). Validates the discriminated-union shape before fanout (400 on malformed body). Calls broadcastSyncedDelta which iterates the socket set, `ws.send(JSON.stringify(frame))`, and deletes sockets that throw."
      - "Specify error-handling contract for /broadcast: API route callers use `ctx.waitUntil(fetch(broadcastUrl, ...))` (fire-and-forget via Cloudflare's waitUntil). The user's original POST returns 2xx to the browser as soon as the D1 write succeeds — broadcast latency does NOT block the response. On broadcast failure (DO unreachable, 5xx, network error), the server logs but does not retry; the next client reconnect triggers a full-fetch resync (B7) which closes the window. Cross-browser sync lag is bounded by the reconnect cycle (~10s worst case) if every broadcast in a window fails. Acceptable — the user's own write landed."
      - "Update the tab handlers at apps/orchestrator/src/api/index.ts lines 748 (POST), 800 (PATCH), 829 (DELETE), 846 (POST /reorder). After D1 write, build the delta op (`{type:'insert', value: row}` / `{type:'update', value: row}` / `{type:'delete', key: id}`) and use `ctx.waitUntil(env.USER_SETTINGS_DO.get(env.USER_SETTINGS_DO.idFromName(userId)).fetch('https://user-settings/broadcast', {method:'POST', headers:{Authorization:`Bearer ${env.SYNC_BROADCAST_SECRET}`}, body: JSON.stringify({type:'synced-collection-delta', collection:'user_tabs', ops:[op]})}))`. The /reorder endpoint emits N update ops in one frame."
      - "Update the preferences PUT handler at apps/orchestrator/src/api/index.ts line 918. After D1 upsert, broadcast `{collection:'user_preferences', ops:[{type:'update', value: row}]}` via ctx.waitUntil."
      - "Retire apps/orchestrator/src/api/notify.ts's {type:'invalidate', collection, keys} broadcast shape. The new delta-frame shape supersedes it. Delete the onRequest `/notify` handler on UserSettingsDO — the new `/broadcast` endpoint replaces it entirely."
      - "Retire apps/orchestrator/src/hooks/use-invalidation-channel.ts. Its one remaining consumer (user_preferences refetch) moves onto the new user-stream via createSyncedCollection."
    test_cases:
      - id: "do-delta-fanout"
        description: "Two WS clients connected to the same UserSettingsDO user room. Client A writes a tab via POST /api/user-settings/tabs. Both A and B receive a {type:'synced-collection-delta', collection:'user_tabs', ops:[{type:'insert', value:{id, …}}]} frame within 500ms. Verified via integration test with two WebSocket mocks."
        type: "integration"
      - id: "broadcast-failure-degrades-gracefully"
        description: "Stub the UserSettingsDO /broadcast endpoint to return 500. User A performs POST /api/user-settings/tabs and receives 201 — write succeeds despite broadcast failure. User B, already connected, does NOT see the new tab immediately. User B disconnects and reconnects (simulated by closing + reopening the WS); full-fetch queryFn returns the new tab; B's tab bar updates. Verifies that (a) broadcast is non-blocking, (b) degradation is bounded by reconnect cycle."
        type: "integration"
      - id: "broadcast-bad-request"
        description: "POST /broadcast with malformed body (missing `ops` field, or op with `{type:'delete', value:{…}}` shape) returns 400. POST with missing Authorization returns 401. POST with >256KiB body returns 413."
        type: "unit"
      - id: "invalidation-channel-retired"
        description: "No file apps/orchestrator/src/hooks/use-invalidation-channel.ts exists. No imports reference it. The /notify endpoint and api/notify.ts path are deleted. Verified via rg."
        type: "audit"

  - id: p3
    name: "Migrate user_tabs + user_preferences onto factory"
    depends_on: [p1, p2b]
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
    depends_on: [p1, p2b]
    tasks:
      - "D1 migration: `CREATE TABLE projects (name TEXT PRIMARY KEY, display_name TEXT, root_path TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT)`. Drizzle schema.ts update."
      - "New API route apps/orchestrator/src/api/gateway/projects/sync.ts: POST endpoint authenticated via CC_GATEWAY_SECRET. Body: {projects: ProjectInfo[]}. Performs a transactional reconcile: upsert every row from payload, soft-delete rows present in D1 but absent from payload. Returns 204 after D1 commit — fanout happens via ctx.waitUntil (see next task)."
      - "Cross-user fanout design (finalised): use the `user_presence` D1 table introduced in p2a as the target index. After /api/gateway/projects/sync commits, run `SELECT user_id FROM user_presence` to get the set of users with at least one active WS, then `ctx.waitUntil(Promise.allSettled(userIds.map(uid => env.USER_SETTINGS_DO.get(env.USER_SETTINGS_DO.idFromName(uid)).fetch('https://user-settings/broadcast', { method:'POST', headers:{Authorization:`Bearer ${env.SYNC_BROADCAST_SECRET}`}, body: JSON.stringify(frame)}))))`. NOTE: `allSettled`, not `all` — one unreachable DO must not abort the fanout for every other user. Log rejected entries for observability but don't retry; degraded users resync on next reconnect cycle. A disconnected user gets their update on next queryFn. No 'global room' DO, no new primitives. Rejected alternatives: (a) a global BroadcastDO with fan-in — adds a hop and a single-point-of-serialisation; (b) iterate all sessions from agent_sessions — not a presence signal, would spam idle tabs for signed-out users. The user_presence table is 1:1 with active WS sessions."
      - "Chunking for the 256 KiB /broadcast cap (B2 API Layer): before fanout, compute `JSON.stringify(frame).length`. If > 200 KiB (safety margin below the 256 KiB hard cap), split the ops array into N sub-frames of roughly equal JSON-serialised size and fire one /broadcast per sub-frame per user. Initial gateway project-sync of 100+ projects will trip this; incremental updates (single project added/removed) almost never will. Add a helper `chunkFrame(frame, maxBytes)` in apps/orchestrator/src/lib/chunk-frame.ts — pure function, unit-testable."
      - "Gateway change in packages/agent-gateway/src/server.ts: on project manifest scan (existing recurring discovery loop), POST to /api/gateway/projects/sync with the current project list instead of (or alongside — keep GET for operator debug) /api/gateway/projects/all. The push is the authoritative sync path once landed."
      - "Rewrite apps/orchestrator/src/db/projects-collection.ts: queryFn reads from /api/projects (new endpoint, reads D1), not /api/gateway/projects/all. Use createSyncedCollection with syncFrameType: 'projects'. Remove the 30s refetchInterval — delta frames replace polling."
      - "Add apps/orchestrator/src/api/projects.ts: GET handler reads D1 projects joined with user_preferences.hiddenProjects for visibility filtering. Returns {projects: ProjectInfo[]}."
      - "Update consumers: project sidebar, create-session dialog, session-card project chip. Replace reads of old projectsCollection.toArray with useLiveQuery on the new collection. Delete the duplicate fetch-from-gateway client-side paths."
    test_cases:
      - id: "gateway-to-d1-sync"
        description: "Gateway discovers a new project /data/projects/duraclaw-dev5. Within 30s, /api/projects returns it. Connected browsers receive a synced-collection-delta frame and their project sidebars update without page reload."
        type: "e2e"
      - id: "cross-user-fanout-via-presence"
        description: "Two users A and B, both connected. Gateway POSTs /api/gateway/projects/sync with a new project. Both A and B receive the projects delta frame via their respective UserSettingsDOs (verified via two mock WS clients in different user rooms). A third user C, signed up but no active WS connection, does NOT receive a broadcast — but when they sign in and the queryFn fires, they see the new project. Confirms user_presence drives fanout correctly."
        type: "integration"
      - id: "cross-user-fanout-partial-failure"
        description: "Three users A, B, C — all with active WS. Stub the broadcast fetch for user B's DO to throw/500. Gateway posts /api/gateway/projects/sync. A and C still receive the broadcast (verified via mock WS). B does not receive it but is logged. Confirms Promise.allSettled semantics — one failure does not abort the fanout for other users."
        type: "integration"
      - id: "hidden-project-filter"
        description: "User preferences has hiddenProjects=['legacy-project']. GET /api/projects does not return legacy-project. Other users unaffected."
        type: "integration"
      - id: "no-gateway-polling"
        description: "rg 'refetchInterval' apps/orchestrator/src/db/projects-collection.ts returns 0 matches. rg '/api/gateway/projects/all' apps/orchestrator/src/ returns 0 matches (endpoint retired or operator-only)."
        type: "audit"

  - id: p5
    name: "Chains migration + Zustand-free invalidation"
    depends_on: [p1, p2b]
    tasks:
      - "Rewrite apps/orchestrator/src/db/chains-collection.ts onto createSyncedCollection with syncFrameType: 'chains'. Source data still comes from /api/chains (reads D1 agent_sessions grouped by kataIssue). Remove the 30s refetchInterval — delta frames replace polling."
      - "Add the broadcast hook in apps/orchestrator/src/agents/session-do.ts at `syncKataToD1` (line 834 — verified via `rg syncKataToD1 apps/orchestrator/src/agents/session-do.ts`). After the D1 write commits, compute the affected `issueNumber` from the kataState, rebuild the chain row (group agent_sessions by kataIssue — extract a helper `buildChainRow(userId, issueNumber)` in apps/orchestrator/src/lib/chains.ts that both /api/chains and the broadcast path share), and ctx.waitUntil a broadcast with `{collection:'chains', ops:[{type:'update', value: chainRow}]}` to the session's owning user's UserSettingsDO. On session delete/archive: broadcast `{type:'delete', key: issueNumber}` if the removal empties the chain."
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
    depends_on: [p3, p4, p5]
    tasks:
      - "Update CLAUDE.md architecture section: document createSyncedCollection as the canonical pattern for user-scoped reactive collections. Reference the SyncConfig.sync TanStack DB primitive and the optimistic-layer + synced-layer split explicitly."
      - "Delete any remaining Zustand stores that duplicated synced-collection state (spot-check `apps/orchestrator/src/stores/*.ts` for dead references)."
      - "Verify partysocket is still the client-side WS wrapper (it is — used by use-user-stream.ts per p1). Server-side `y-partyserver` is removed along with Y.Doc in p2. The `partysocket` client dependency stays in apps/orchestrator/package.json."
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
- **Failure contract for queryFn:** inherits `queryCollectionOptions`
  retry semantics — `retry: 2, retryDelay: 500ms` (exponential handled
  by TanStack Query). `markReady` fires either on first successful
  response OR after all retries exhaust (so `useLiveQuery` exits its
  loading state even on persistent failure). The collection stays
  empty; incoming WS deltas still apply (they don't require initial
  load to succeed). Reconnect (see B7) re-fires queryFn — if it
  succeeds this time, the synced layer populates normally.
- **Mutation timeout contract:** `onInsert/onUpdate/onDelete` handlers
  use `fetch` with `AbortSignal.timeout(30_000)` (30s); no retries
  (TanStack DB's transaction semantics handle rollback on throw).
  This bounds the B7 case-1/case-2 resolution window for tests.
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

**Addressing:** DO-internal only. Callers route via the DO stub —
`env.USER_SETTINGS_DO.get(env.USER_SETTINGS_DO.idFromName(userId)).fetch(url, init)`.
The userId lives in the DO ID (via `idFromName`), NOT in the URL path.
The `url` passed to `.fetch()` needs any valid absolute URL
(`https://user-settings/broadcast` is idiomatic) — only the pathname
(`/broadcast`) matters to the DO's `fetch()` handler.

```
Path (inside the DO fetch handler): /broadcast
Method: POST
Auth: worker-internal — Authorization: Bearer $SYNC_BROADCAST_SECRET
Body: SyncedCollectionFrame<unknown> (discriminated union — see p1 task 2)
  {
    type: 'synced-collection-delta',
    collection: string,
    ops: Array<
      | { type: 'insert', value: Row }
      | { type: 'update', value: Row }
      | { type: 'delete', key: string }
    >
  }
Returns:
  204 No Content — broadcast dispatched to connected sockets (fire-and-forget; per-socket send failures are logged but not returned)
  400 Bad Request — body failed JSON.parse, `type` field mismatch, or ops array fails the discriminated-union shape check
  401 Unauthorized — missing or bad bearer token
  413 Payload Too Large — body exceeds the 256 KiB hard cap (enforced, not advisory; protects DO memory; ops should be per-row, not bulk). Gateway project-sync fanout in p4 respects this by chunking large reconcile sets across multiple /broadcast calls if the ops-count×per-row-size exceeds the cap.
```

Shape validation happens server-side before the socket fanout — the wire
type matches the p1 discriminated union byte-for-byte. No optional
`value`/`key` fields.

#### Data Layer

New D1 table for the active-user index (written by UserSettingsDO
connect/disconnect per the reference-counting rule in p2a):

```sql
CREATE TABLE user_presence (
  user_id TEXT PRIMARY KEY,
  first_connected_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
```

DO state: `Set<WebSocket>` per user room. `y_state` table in DO SQLite
is dropped in the p2a migration.

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
- **Expected:** Zero `yjs`, `y-partyserver`, or `y-protocols` imports in
  `apps/orchestrator/src/agents/user-settings-do.ts`. No `Y.Doc`,
  `Y.Array`, `Y.Map` references there. Package.json retains these
  dependencies — `session-collab-do.ts` and `use-session-collab.ts`
  continue to use them for draft Y.Text sync (out of scope for this
  spec; see Non-Goals).
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
  affected key. The collection's *sync-layer write transaction count*
  (observable via `collection.on('sync', …)` or by counting calls to
  the `write()` param in the SyncConfig) is exactly 2: one optimistic
  apply, one echo-settle. No delete+insert churn. TanStack DB's
  `deepEquals` check suppresses a third write.
- **Verify:** Unit test asserting on sync-transaction count (deterministic)
  rather than React render count (environment-sensitive under
  StrictMode / concurrent features). The visual guarantee — "no
  flicker" — is separately verified via scripts/axi snapshot diff.

#### UI Layer

No visible flicker on optimistic settle. Verified by scripts/axi snapshot
diff: no intermediate blank frame.

---

### B7: Reconnect + in-flight optimistic semantics

**Core:**
- **ID:** reconnect-inflight-optimistic
- **Trigger:** WS to UserSettingsDO drops while the client has one or
  more optimistic mutations whose `mutationFn` (POST/PATCH/DELETE) has
  NOT yet resolved.
- **Expected:**
  - The factory's `SyncConfig.sync` cleanup does NOT touch optimistic
    state — cleanup only tears down the delta subscription.
  - On reconnect, the subscribe handler re-fires `queryFn` (full fetch
    from the authoritative D1 view). Returned rows flow through
    `begin/write/commit` via the queryCollection's built-in
    `applySuccessfulResult` reconciler (see
    `@tanstack/query-db-collection/dist/esm/query.js:500-565`).
  - Three cases of in-flight optimistic mutations at reconnect time:
    1. **POST reached server, response lost:** D1 has the row. Full-fetch
       returns it. `deepEquals` finds it matches the optimistic row →
       no re-render. The optimistic tx eventually times out
       (mutationFn's own fetch timeout) and TanStack DB settles it as
       succeeded via echo-matched-key OR rolls back if mutationFn
       throws — either way, the synced row remains. Correct.
    2. **POST never reached server:** D1 does NOT have the row.
       Full-fetch doesn't return it. Optimistic tx's mutationFn
       (assuming a finite retry/timeout budget) eventually throws →
       TanStack DB rolls back the optimistic layer. Row disappears from
       the UI. Correct.
    3. **DELETE never reached server while offline:** D1 row still
       exists. Full-fetch returns it. The optimistic delete's
       `optimisticDeletes` entry keeps it hidden client-side until its
       mutationFn resolves. If mutationFn throws (offline) → rollback →
       row reappears. Accepted behavior — user can re-try the delete.
- **Verify:** Unit tests for each case (stub fetch + mock WS
  reconnect). Particularly the "DELETE lost, row reappears" case —
  explicitly accepted, not a bug.
- **Source:** new logic in `apps/orchestrator/src/db/synced-collection.ts`
  sync-fn cleanup path; leverages existing TanStack DB behavior for
  optimistic reconciliation.

#### Data Layer

No schema changes. Relies on TanStack DB's built-in optimistic layer
semantics (`optimisticUpserts`, `optimisticDeletes` maps in
`CollectionStateManager`).

---

## Non-Goals

- **Messages migration.** `messagesCollection` already uses the correct
  API after `bc57fcb`. Rewriting it onto `createSyncedCollection` is
  possible but out of scope — its per-session DO scope, seq-based
  ordering, and snapshot-on-gap protocol are purpose-built for hot event
  streams and don't map cleanly onto the user-scoped factory.
- **Yjs for draft collab.** `apps/orchestrator/src/agents/session-collab-do.ts`
  (extends `y-partyserver` YServer for draft `Y.Text` sync) and
  `apps/orchestrator/src/hooks/use-session-collab.ts` (uses
  `useYProvider` from `y-partyserver/react`) are a separate feature and
  stay untouched. `yjs`, `y-partyserver`, and `y-protocols` all remain
  in `apps/orchestrator/package.json` — only the `UserSettingsDO`'s
  YServer extension + `Y.Doc` usage is removed.
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

All resolved during spec review. Captured here for traceability.

- [x] **Cross-user project fanout mechanism.** Resolved: use the
  `user_presence` D1 table (written by UserSettingsDO on WS
  connect/disconnect in p2) as the active-user index. The
  `/api/gateway/projects/sync` route queries `SELECT DISTINCT userId
  FROM user_presence` and ctx.waitUntil's a broadcast to each user's
  DO. See p4 task "Cross-user fanout design (finalised)".
- [x] **Y.Doc → D1 migration risk.** Resolved: D1 `user_tabs` is
  already authoritative. The existing `UserSettingsDO.seedFromD1()`
  (line 131 of user-settings-do.ts) populates the Y.Doc FROM D1 on
  first load if empty; writes flow through `/api/user-settings/tabs`
  which writes D1 directly. The `y_state` DO-SQLite table holds only
  a cached Y.Doc snapshot — dead storage on first post-deploy boot.
  p2 drops the table in the same migration. No user data lives only
  in Y.Doc. No migration code needed.
- [x] **Secret scoping.** Resolved: introduce `SYNC_BROADCAST_SECRET`
  as a new wrangler secret separate from `CC_GATEWAY_SECRET`. Gateway
  compromise must not unlock worker→DO fanout, and fanout compromise
  must not unlock gateway→worker project sync. Two secrets, two
  rotation cycles.

## Implementation Phases

See YAML frontmatter `phases:` above. Rough estimates:

- p1: 1 day (factory + tests + delta-frame types)
- p2a: 1 day (Y.Doc deletion + DO class rewrite + user_presence table + reference-counting)
- p2b: 0.5-1 day (broadcast endpoint + 4 API handler updates + notify/invalidation retirement)
- p3: 0.5 day (tabs + prefs migration, both are straightforward)
- p4: 1-1.5 days (D1 table, gateway writeback, API changes, sidebar rewire)
- p5: 0.5 day (chains is thin)
- p6: 0.5 day (cleanup, docs)

Total: ~5-6 days of focused work. Dependency DAG: p1 → p2a → p2b → {p3, p4, p5} → p6. p3/p4/p5 can be parallelised by separate developers once p2b lands.

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
1. Instrument the factory's `SyncConfig.write()` with a call counter
   (wrap `write` in a unit test fixture to count invocations per tx
   id). This is the deterministic signal — render count is
   environment-sensitive under StrictMode and concurrent React.
2. `scripts/axi click @new-tab-button` — fires optimistic insert.
3. Wait for server echo (< 500ms).
4. Inspect write-transaction count: must be exactly 2 (optimistic apply
   + echo-settle). A third transaction indicates deep-equality dedup
   isn't working.
5. Visual verification (separate, via scripts/axi): snapshot diff
   between optimistic apply and echo-settle — the row's visual output
   must be identical (no flicker, no intermediate blank frame).

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

Removals: none from package.json. `yjs`, `y-partyserver`, and
`y-protocols` all stay — `session-collab-do.ts` and
`use-session-collab.ts` depend on them for draft Y.Text sync (confirmed
via grep). The Y.Doc retirement is scoped to `user-settings-do.ts`
only. `hocuspocus-*` was never installed (grep-verify).

### Secrets

| Name | Scope | Used for |
|------|-------|----------|
| `CC_GATEWAY_SECRET` | gateway → worker | Existing — gateway-authenticated endpoints (`/api/gateway/projects/sync` in p4) |
| `SYNC_BROADCAST_SECRET` | worker → UserSettingsDO | New in p2 — authenticates worker-internal POSTs to `/broadcast`. Scoped separately so gateway compromise cannot unlock fanout and vice versa. Add to `wrangler.toml` + rotate via `wrangler secret put` on deploy. |

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
      const frame = await req.json() as SyncedCollectionFrame
      // TODO: validate frame shape (discriminated union check); 400 on fail.
      const payload = JSON.stringify(frame)  // frame already carries `type: 'synced-collection-delta'`
      for (const ws of this.sockets) {
        try { ws.send(payload) } catch { this.sockets.delete(ws) }
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
