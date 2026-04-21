---
initiative: messages-synced-collection-migration
type: project
issue_type: feature
status: approved
priority: medium
github_issue: 38
created: 2026-04-21
updated: 2026-04-21
rebased_against: "PR #39 (commit 898598d) — R1 status collapse"
phases:
  - id: p1
    name: "Factory abstraction + wire shape"
    tasks:
      - "Add two injection params to `createSyncedCollection` in apps/orchestrator/src/db/synced-collection.ts: `subscribe: (handler) => unsubscribe` (replaces the hardcoded `subscribeUserStream` call at L76) and `onReconnect: (handler) => unsubscribe` (replaces the hardcoded `onUserStreamReconnect` call at L95). Default both to the existing user-stream bindings so no current caller changes behavior"
      - "Confirm SyncedCollectionFrame in packages/shared-types/src/index.ts already supports `collection: string` with arbitrary value (it does) and document the `messages:<sessionId>` convention in the TSDoc"
      - "Add `subscribeSessionStream(sessionId, handler)` and `onSessionStreamReconnect(sessionId, handler)` registrars to apps/orchestrator/src/features/agent-orch/use-coding-agent.ts, mirroring the `subscribeUserStream` / `onUserStreamReconnect` pair in apps/orchestrator/src/hooks/use-user-stream.ts. `subscribeSessionStream` fires for EVERY `SyncedCollectionFrame` routed over THIS session's WS — it does NOT pre-filter by `collection` prefix. Consumers (messagesCollection factory, branchInfoCollection factory) filter by `frame.collection` internally inside their own subscribe callback. Each returns an unsubscribe fn"
      - "Ensure the createSyncedCollection factory's injected subscribe callback filters `frame.collection === opts.collection` at the top of the handler (messagesCollection receives ALL session frames, ignores anything that isn't `messages:<sessionId>`)"
    test_cases:
      - "Existing user-scoped collections (user_tabs, user_preferences, projects, chains) still compile and pass their current tests with the new factory signature"
      - "`subscribeSessionStream('abc', fn)` is called with BOTH `messages:abc` and `branchInfo:abc` frames (primitive passes all session-scoped frames); does NOT fire for other sessions' frames"
      - "messagesCollection factory's internal subscribe callback filters: only `collection==='messages:abc'` frames drive `begin/write/commit`; `branchInfo:abc` frames delivered to the same callback are ignored"
      - "`onSessionStreamReconnect('abc', fn)` fires after a dropped + resumed session WS (not on initial connect), mirroring `onUserStreamReconnect` semantics"
  - id: p2
    name: "Server: emit SyncedCollectionFrame + cursor REST + clientId ingest"
    tasks:
      - "Rewrite SessionDO.broadcastMessages (apps/orchestrator/src/agents/session-do.ts — grep for the method name; line offsets drift, around L950 at time of writing) to emit `SyncedCollectionFrame` with `collection: 'messages:<sessionId>'`, `ops: [{type:'insert'|'update', value: SessionMessage}]` and envelope `messageSeq`"
      - "Extend SessionDO internal `/messages` fetch handler to accept `sinceCreatedAt` and `sinceId` query params; query SQLite with `WHERE (created_at > ?) OR (created_at = ? AND id > ?) ORDER BY created_at ASC, id ASC LIMIT 500`. Cold-load (no cursor) returns full history without a LIMIT clause — preserves existing behavior; long sessions already load the whole history today"
      - "Analyze the cursor query's plan on a seeded session (≥500 rows) via `EXPLAIN QUERY PLAN`; if the composite `WHERE / ORDER BY` triggers a full table scan, add a `(created_at, id)` composite index to the `messages` table in SessionDO's SQLite migration v8. If the existing `created_at` index suffices (plan uses index), note the decision inline in B4's Data Layer section and skip the migration change"
      - "Update the `/api/sessions/:id/messages` GET route in apps/orchestrator/src/api/index.ts L1675-1709 to forward `sinceCreatedAt` + `sinceId` query params and drop the `version` field from the response body"
      - "Extend SessionDO's message-ingest RPC (the path called by POST `/api/sessions/:id/messages`) to require `{content, clientId, createdAt}`. `clientId` MUST match `/^usr-client-[a-z0-9-]+$/` (400 otherwise). `createdAt` MUST be a valid ISO 8601 string (400 otherwise); server adopts the client-supplied `createdAt` verbatim as the row's `createdAt` so loopback reconciliation sees identical rows. Use `clientId` as the row's primary `id`. Reject 409 on duplicate clientId. Missing either field is a 400"
      - "Add the POST `/api/sessions/:id/messages` route if not already present in apps/orchestrator/src/api/index.ts; forward to SessionDO's ingest RPC. Response: `{id: string}` echoing the effective row id"
      - "Keep `messageSeq` on frame envelope; remove `seq` field from the runtime-augmented row in `ops[].value` (server currently does NOT stamp seq on rows — verify no regression)"
    test_cases:
      - "DO broadcast emits `{type:'synced-collection-delta', collection:'messages:<id>', ops:[...], messageSeq:N}` verifiable via a unit test on broadcastMessages"
      - "GET /api/sessions/<id>/messages?sinceCreatedAt=<iso>&sinceId=<id> returns rows strictly after (created_at, id), sorted ASC, capped at 500 rows"
      - "GET response body does NOT include a `version` field"
      - "POST /api/sessions/<id>/messages with `{content:'hi', clientId:'usr-client-abc', createdAt:'2026-04-21T00:00:00.000Z'}` creates a row with `id='usr-client-abc'` AND `createdAt='2026-04-21T00:00:00.000Z'` (verbatim, server does NOT re-stamp); response is `{id:'usr-client-abc'}`"
      - "POST with duplicate clientId returns 409"
      - "POST with missing `clientId`, missing `createdAt`, invalid clientId shape, or invalid ISO createdAt returns 400"
      - "GET /api/sessions/<id>/messages?sinceId=msg-x (without `sinceCreatedAt`) returns 400"
      - "GET /api/sessions/<id>/messages?sinceCreatedAt=<iso> (without `sinceId`) returns 400 — both cursor params are required together or both absent"
  - id: p3
    name: "Client: rewrite messagesCollection on new factory + reconnect"
    tasks:
      - "Rewrite apps/orchestrator/src/db/messages-collection.ts to call `createSyncedCollection({id, collection: 'messages:<sessionId>', subscribe: (h) => subscribeSessionStream(sessionId, h), onReconnect: (h) => onSessionStreamReconnect(sessionId, h), queryFn, onInsert})`"
      - "queryFn computes cursor from `collection.state` (max `created_at` with `id` tie-break) and calls `GET /api/sessions/:id/messages?sinceCreatedAt=&sinceId=`; on cold start both params are **omitted entirely** from the query string (not passed as empty strings — empty-string values would trip B4's 400 validation for asymmetric-cursor requests)"
      - "Keep the existing per-sessionId memoisation map. **P3 is the canonical owner of the seq-stamping removal** — delete the `seq: version` stamping at messages-collection.ts L104-108 (client-side augmentation of REST rows) and the `row.seq ?? Number.POSITIVE_INFINITY` read at use-messages-collection.ts L58. P5 re-verifies via grep but does NOT re-touch these lines"
      - "Rewrite the current message-send action (in apps/orchestrator/src/features/agent-orch/use-coding-agent.ts — search for the existing POST flow to /api/sessions/:id/messages or the `sendMessage` export) to call `messagesCollection(sessionId).insert({id: 'usr-client-' + crypto.randomUUID(), role:'user', content, parts: [{type:'text', text: content}], createdAt: new Date().toISOString()})` instead of invoking fetch directly. The `parts` field is pre-computed on the optimistic row so deepEquals reconciles byte-identically with the server echo (B7/B14) — do NOT omit it. The factory's onInsert mutationFn then owns the network call"
      - "Ensure the subscribe callback routed into createSyncedCollection handles `{type:'delete', key}` ops by calling `params.write({type:'delete', key, value: undefined as never})` — this is what makes B11 (delete-op contract) functional and is required for B9 rewind-as-delete+insert semantics"
      - "Implement optimistic user turn via `onInsert` mutationFn: POST /api/sessions/:id/messages with `{content, clientId}`; server echo reconciles via deep-equal"
      - "Reconnect wiring: `onReconnect` handler (injected into factory) calls `queryClient.invalidateQueries({queryKey: ['messages', sessionId]})`; this is handled by the factory's existing reconnect plumbing once `onReconnect` is parameterised in P1"
    test_cases:
      - "Fresh session: collection populates via cold queryFn with empty cursor"
      - "Delta frame applied: new row is visible via useLiveQuery without a queryFn refetch"
      - "Optimistic insert: `usr-client-<uuid>` appears immediately; server echo with same id reconciles (no delete+insert)"
      - "No seq gating: a frame whose `messageSeq` is older than the last-seen seq still applies (seq is observability-only)"
      - "WS drop + reconnect: cursor-param GET is fired after reconnect (verify via resource-timing); collection converges with no duplicates"
  - id: p4
    name: "Snapshot semantics migration (rewind/resubmit/branch-navigate)"
    tasks:
      - "Rewrite SessionDO.rewind / resubmitMessage / getBranchHistory / requestSnapshot to emit `SyncedCollectionFrame` ops: delete ops for stale rows (by id) followed by insert ops for the new branch, all in one frame"
      - "Verify `chunkOps` signature at apps/orchestrator/src/lib/chunk-frame.ts is compatible with `SyncedCollectionOp[]` input and a byte-size cap. If the existing signature was specialised for a different op shape, widen to `<T>(ops: SyncedCollectionOp<T>[], byteCap: number): SyncedCollectionOp<T>[][]` so it supports both user-scoped and session-scoped collections"
      - "If the batched ops exceed 256 KiB, split via the verified `chunkOps`; accept loss of single-render atomicity for navigation events (documented in commit message). B8 reconnect-cursor-catchup recovers if a WS drop interrupts mid-chunk-sequence"
      - "Delete the `kind:'snapshot'` / `kind:'delta'` discriminator path in the server; the whole wire is SyncedCollectionFrame now"
    test_cases:
      - "Rewind from leaf A to ancestor X: client collection ends up with exactly the messages on X's linear history; no rows from A's branch remain"
      - "Resubmit at message M: client collection replaces the post-M tail with the new branch's tail"
      - "Frame > 256 KiB: chunked into multiple SyncedCollectionFrames; client applies them in order and converges correctly"
      - "NOTE: B10 (messages + branchInfo single-render atomicity) is NOT tested here — branchInfo emit doesn't exist until P5. B10's RTL test lives in P5's test_cases"
  - id: p5
    name: "Cleanup + migration"
    tasks:
      - "Delete MessagesFrame type and DeltaPayload/SnapshotPayload from packages/shared-types/src/index.ts L634-682"
      - "Delete handleMessagesFrame (apps/orchestrator/src/features/agent-orch/use-coding-agent.ts L221-409) and the lastSeq ref lifecycle; replace with the subscribe-based factory wire-through"
      - "Verify (grep-only — no code changes here) that P3 removed the seq stamping at messages-collection.ts L104-108 and the seq read at use-messages-collection.ts L58. P3 is the canonical owner of this change; P5 just audits. The server-side `SessionMessage` type in shared-types does NOT currently carry seq (confirmed — grep returned only test fixtures and the MessagesFrame envelope)"
      - "Add SessionDO SQLite migration v8 dropping any `seq`-named column on the `messages` table if present. Audit current migrations (apps/orchestrator/src/agents/*-migrations.ts) first: if no seq column exists, migration is a no-op documentation entry; if it exists, DROP COLUMN via the standard migration pattern"
      - "Bump OPFS store version for messages-collection (force fresh cold-load on first post-deploy session open) to clear any dead `seq` field stamped onto cached rows by the pre-migration client code"
      - "Migrate branchInfoCollection (apps/orchestrator/src/db/branch-info-collection.ts) to route its WS deltas through `subscribeSessionStream` filtered on `collection: 'branchInfo:<sessionId>'` — this is a minimal change needed because handleMessagesFrame (which currently dispatches branchInfo) is being deleted. Keep all other branchInfo logic (factory shape, consumers, UI) unchanged. Add a corresponding server-side emit of `{type:'synced-collection-delta', collection:'branchInfo:<id>', ops:[...]}` in the same DO turns that previously piggy-backed branchInfo onto the messages frame"
      - "Remove debug-only globals (e.g. any `window.__testEmitFrame`-style hooks) added during development; keep only affordances already present in the codebase"
    test_cases:
      - "Project builds and typechecks clean after MessagesFrame and seq field are removed"
      - "Fresh install (cleared OPFS) and upgrade install (with dead `seq` in cache) both arrive at functional state on first load"
      - "useDerivedGate(sessionId) still computes correct pending-gate value from messagesCollection post-migration (useDerivedStatus was deleted in PR #39 — status now reads from sessionsCollection, which is orthogonal to this migration)"
      - "useSession(sessionId).status (the post-#39 D1-mirrored status, driven by broadcastSessionRow) is unaffected by the messages wire migration; StatusBar, sidebar, tab bar still agree"
      - "branchInfoCollection continues to drive the branch arrows UI with no regressions; branch navigation across siblings works end-to-end"
      - "Grep for `row.seq`, `msg.seq`, `message.seq` in apps/orchestrator/src returns zero hits outside of test fixtures for pre-migration wire-format tests that are themselves deleted or rewritten"
      - "B10 atomicity: DO unit test asserts `this.broadcast` is called twice synchronously in the same tick (messages frame then branchInfo frame) with no microtask yield between; RTL integration test asserts that the user message bubble and branch chevron become visible in the same React commit"
      - "B15 branchInfo wire: DO emits `{collection:'branchInfo:<id>', ops:[...]}` as a separate SyncedCollectionFrame; `subscribeSessionStream` filter correctly routes messages frames to messages consumers and branchInfo frames to branchInfo consumers with no cross-delivery"
---

# Migrate messagesCollection onto createSyncedCollection

> **Rebase note (2026-04-21):** This spec was approved on 2026-04-21 at 91/100 against pre-#39 `main`. PR #39 (spec #37, R1 status collapse) landed at commit `898598d` later the same day, deleting `useDerivedStatus`, `sessionLiveStateCollection`, and `useSessionLiveState`, and introducing `sessionsCollection` / `sessionLocalCollection` / `broadcastSessionRow`. The rebase touched three sites — V7 (verification plan), the R1/R2 Non-Goals bullets, and the P5 status-assertion test case — and introduced **zero** changes to the wire protocol, phase structure, behavior IDs, or implementation hints. The messages-collection migration and the sessions-collection migration ride on **independent broadcast channels** (session-scoped WS vs user-scoped WS via `broadcastSessionRow`) and do not intersect at the wire layer. Search for `PR #39` in this doc to locate all rebase touchpoints.

## Overview

Move the per-session `messagesCollection` off the hand-spun `{type:'messages', kind:'delta'|'snapshot', seq, payload}` WS channel onto the shared `createSyncedCollection` factory. Extracts a subscriber-injection abstraction so the factory is routing-agnostic (user-scoped vs session-scoped WS), unifies the wire shape with existing synced collections, and deletes ~200 lines of bespoke gap-detection and snapshot-reconciliation code in `use-coding-agent.ts`. Replaces the current per-message `seq` reconciliation with a `created_at + id` cursor for cold load and reconnect catch-up.

## Feature Behaviors

### B1: Factory accepts injected WS subscriber

**Core:**
- **ID:** factory-subscriber-injection
- **Trigger:** Any caller invokes `createSyncedCollection({..., subscribe})`
- **Expected:** Factory uses the injected `subscribe(handler) => unsubscribe` to receive delta frames; no hardcoded reference to `onUserStreamMessage` inside the factory body
- **Verify:** Unit test — a fake subscriber that emits a synthetic `SyncedCollectionFrame` drives `begin/write/commit` on the collection's sync layer; collection state reflects the ops
- **Source:** apps/orchestrator/src/db/synced-collection.ts (modify factory signature)

#### API Layer
N/A (internal refactor; wire protocol unchanged)

#### Data Layer
No schema change. Factory signature gains `subscribe` param; backwards compat via default that wires `onUserStreamMessage` for existing callers.

---

### B2: Session WS exposes per-session message subscriber + reconnect

**Core:**
- **ID:** session-stream-primitives
- **Trigger:** `subscribeSessionStream(sessionId, handler)` or `onSessionStreamReconnect(sessionId, handler)` is called
- **Expected:**
  - `subscribeSessionStream(sessionId, handler)` fires for EVERY `SyncedCollectionFrame` routed over THIS session's WS — the primitive does NOT pre-filter by `collection`. This mirrors `subscribeUserStream` which fanouts all user-WS frames. Consumers (messagesCollection, branchInfoCollection) filter by `frame.collection` inside their own callback
  - Frames for OTHER sessions' WS connections do not fire this handler (session isolation is the primitive's sole routing responsibility)
  - `onSessionStreamReconnect(sessionId, handler)` is invoked after a dropped + resumed session WS (not on initial connect), mirroring `onUserStreamReconnect` semantics at apps/orchestrator/src/hooks/use-user-stream.ts L195
  - Both return an unsubscribe function
- **Verify:** Unit test —
  - Register via both APIs for sessionId `abc`
  - Mock emits `{collection:'messages:abc', ...}` → `subscribeSessionStream` handler fires
  - Mock emits `{collection:'branchInfo:abc', ...}` → handler ALSO fires (consumer filters internally)
  - Frame on a different session's WS → handler does NOT fire (session isolation)
  - Mock reconnect → `onSessionStreamReconnect` handler fires
  - After unsubscribe: neither fires again
- **Source:** apps/orchestrator/src/features/agent-orch/use-coding-agent.ts (new exports). Both messagesCollection and branchInfoCollection call `subscribeSessionStream(sessionId, handler)` in P3 and P5 respectively, and each filters `frame.collection` inside its own handler

#### UI Layer
N/A (hook-layer primitive)

#### API Layer
N/A (consumes existing session WS path `/agents/session-agent/<do-id>`)

---

### B3: messagesCollection uses createSyncedCollection

**Core:**
- **ID:** messages-on-synced-factory
- **Trigger:** `createMessagesCollection(sessionId)` is called
- **Expected:** Returns a collection built via `createSyncedCollection` with `collection: 'messages:<sessionId>'`, `subscribe: (h) => onSessionStreamMessage(sessionId, h)`, queryFn using sinceCreatedAt+sinceId cursor, OPFS persistence via `persistedCollectionOptions`; memoised per sessionId as today
- **Verify:** `messagesCollection(id)` twice returns the same instance; insert via WS frame appears via `useLiveQuery`; no `seq` field on collection rows
- **Source:** apps/orchestrator/src/db/messages-collection.ts L65-141 (full rewrite)

#### Data Layer
`SessionMessage` row loses `seq: number` field. OPFS store version bump so existing cached rows are dropped on next load.

---

### B4: Cursor-based REST endpoint

**Core:**
- **ID:** messages-cursor-rest
- **Trigger:** `GET /api/sessions/:id/messages?sinceCreatedAt=<iso>&sinceId=<id>`
- **Expected:** Returns `{messages: SessionMessage[]}` containing rows strictly after the cursor, ordered by `(created_at ASC, id ASC)`, capped at **500 rows** (the incremental catch-up window); omitted cursor params return the full history without a LIMIT clause (preserves existing cold-load behavior). Response body does NOT include a `version` field (see B13)
- **Verify:** curl with `sinceCreatedAt=2026-01-01T00:00:00Z&sinceId=msg-x` returns only rows where `(created_at > that-iso) OR (created_at = that-iso AND id > 'msg-x')`; response size bounded at 500 rows; `Object.keys(responseBody)` equals `['messages']`
- **Source:** apps/orchestrator/src/api/index.ts L1675-1709 and corresponding SessionDO handler

#### API Layer
- **Endpoint:** `GET /api/sessions/:id/messages`
- **Query params:** `sinceCreatedAt` (ISO 8601 string, optional), `sinceId` (string, optional — MUST accompany `sinceCreatedAt`)
- **Response:** `{messages: SessionMessage[]}` — 500-row LIMIT applies only when cursor is provided; cold-load returns full history
- **Errors:** 404 session not found, 403 forbidden, 400 if `sinceId` supplied without `sinceCreatedAt` (or vice versa), 400 if `sinceCreatedAt` is not a valid ISO 8601 string

#### Data Layer
No schema change; query adds `(created_at, id)` composite sort clause. Existing index on `created_at` sufficient; add `(created_at, id)` composite if query plan shows scan.

---

### B5: SessionDO emits SyncedCollectionFrame

**Core:**
- **ID:** do-emits-synced-frame
- **Trigger:** Any server-side mutation that previously called `broadcastMessages(frame)` (user turn received, assistant turn received, tool call, rewind, resubmit, branch-navigate)
- **Expected:** DO emits `{type:'synced-collection-delta', collection:'messages:<sessionId>', ops: [...], messageSeq: N}` over all attached session WS sockets; `messageSeq` monotonically increments per session (envelope-only, observability)
- **Verify:** Unit test on broadcastMessages — given a SessionMessage input, emitted JSON matches the expected SyncedCollectionFrame shape with `messageSeq` > previous
- **Source:** apps/orchestrator/src/agents/session-do.ts L921-989

#### Data Layer
`messageSeq` counter at L188 continues to increment (persisted every 10th increment per existing policy). No change to storage.

---

### B6: Drop seq from row-level augmentation

**Core:**
- **ID:** drop-seq-from-row
- **Trigger:** Code compiles and runs after P5 cleanup
- **Expected:**
  - The server-side `SessionMessage` type in packages/shared-types/src/index.ts remains without a `seq` field (it already lacks it today — verified: type has `{id, sessionId, role, parts, createdAt, canonical_turn_id}`)
  - The client-side queryFn at apps/orchestrator/src/db/messages-collection.ts L104-108 no longer stamps `seq: version` onto REST-loaded rows
  - The `row.seq ?? Number.POSITIVE_INFINITY` read at apps/orchestrator/src/hooks/use-messages-collection.ts L58 is removed (collection no longer needs seq-based ordering — cursor-based ordering by `createdAt` ASC + `id` tie-break replaces it)
  - The SessionDO SQLite `messages` table has no `seq` column (audit migrations first; drop via v8 migration if present, else document as no-op)
  - The frame envelope `messageSeq` remains the only seq surface
- **Verify:**
  - `tsc --noEmit` passes
  - Grep for `row.seq`, `msg.seq`, `message.seq`, `\.seq\s*=` in apps/orchestrator/src returns zero hits outside of tests that specifically test pre-migration wire format (and those tests are deleted or rewritten)
  - SessionDO storage introspection (`.dump` on the dev SQLite) shows no `seq` column on `messages`
- **Source:** apps/orchestrator/src/db/messages-collection.ts L104-108, apps/orchestrator/src/hooks/use-messages-collection.ts L58, apps/orchestrator/src/agents/session-do.ts L188+L965 (server `messageSeq` counter remains, stops being stamped onto rows)

#### Data Layer
Migration v8 on SessionDO SQLite: `ALTER TABLE messages DROP COLUMN seq` if column exists; else no-op with a version bump stub. The frame envelope `messageSeq` is the only seq surface post-migration.

---

### B7: Optimistic user turn via mutationFn (client half)

**Core:**
- **ID:** optimistic-user-turn-client
- **Trigger:** User submits a message; `messagesCollection.insert({id: 'usr-client-<uuid>', role: 'user', content, parts: [{type: 'text', text: content}], createdAt})` is called with the client-stamped `createdAt` (ISO string from `new Date().toISOString()`). The `parts` field MUST be pre-computed on the optimistic row to match the server's `content → parts` transform (see B14) so TanStack DB's `deepEquals` reconciles the echo with update-in-place rather than delete+insert. Inheriting the same transform keeps the optimistic shape and the canonical shape byte-identical — which is what preserves DOM node identity across the echo
- **Expected:**
  - Row appears immediately in the UI (optimistic layer)
  - mutationFn POSTs `/api/sessions/:id/messages` with `{content, clientId: 'usr-client-<uuid>', createdAt: <client-iso>}` — client-stamped `createdAt` is included so the server can adopt it verbatim (B14)
  - Server responds 200 `{id: 'usr-client-<uuid>'}`; server echo via WS delta upserts the canonical row with the SAME `id` AND `createdAt` as the optimistic row
  - TanStack DB's update-in-place reconciles keyed by `id`: the collection row is replaced atomically; DOM node identity for the React component rendering that row is preserved (React re-uses the same fiber because the key is stable); no delete+insert churn
- **Verify:** RTL integration —
  - Send a message; capture the DOM node via `screen.getByText(content)` immediately (pre-echo)
  - Wait for `mutationFn` to resolve (echo arrives via WS)
  - Assert `screen.getByText(content)` returns the SAME DOM node reference (`toBe`)
  - Assert via React DevTools Profiler (or `render` mock) that the bubble component committed at most once after the initial mount (re-render is acceptable if props changed, but the component is not unmounted+remounted)
- **Source:** apps/orchestrator/src/db/messages-collection.ts (new `onInsert` handler)

#### API Layer (client-side contract only — server half is B14)
- **Endpoint:** `POST /api/sessions/:id/messages`
- **Request:** `{content: string, clientId: string, createdAt: string}` — all three fields required and always present from messagesCollection
- **Response:** `{id: string}` — echoes clientId on success
- **Error responses and client handling:**
  - 409 (duplicate clientId) — client treats as reconciled no-op; mutationFn resolves successfully (returns rather than throws)
  - 400 (invalid clientId shape, missing/invalid createdAt, missing content) — mutationFn throws; optimistic row rolls back; UI surfaces a transient error toast (reuse existing toast pattern)
  - 5xx or network error — mutationFn throws; optimistic row rolls back; UI surfaces a retry-able error toast. No automatic retry at the mutationFn layer — users re-submit manually; this avoids runaway writes during a backend outage
  - 403 / 404 — mutationFn throws; optimistic row rolls back; treated as a terminal error (session gone / forbidden); surface a hard error message

---

### B14: Server accepts clientId + createdAt on POST

**Core:**
- **ID:** optimistic-user-turn-server
- **Trigger:** `POST /api/sessions/:id/messages` with `{content, clientId, createdAt}` body
- **Expected:**
  - All three body fields required. Missing any one returns 400.
  - `clientId` MUST match `/^usr-client-[a-z0-9-]+$/` (400 otherwise)
  - `createdAt` MUST be a valid ISO 8601 string parseable by `new Date()` (400 otherwise)
  - `content` MUST be a non-empty string; additional content rules (max length, sanitization) inherit from the existing SessionDO ingest path (do not re-implement — call the same validation helper the current `sendMessage` RPC uses). 400 if content fails validation
  - If `clientId` is not already present in the session's message log, SessionDO creates a row with `id === clientId`, `createdAt === body.createdAt` (server adopts client timestamp verbatim — this is what makes B7's loopback reconciliation work), and `parts` derived from `content` via the existing user-message `content → parts` transform already used by SessionDO's ingest path (single-element text part array). The WS echo carries this exact row shape so `deepEquals` against the optimistic row succeeds only if the client's optimistic row ALSO pre-computes `parts` matching this transform — or if the collection's deep-equal reconciliation is keyed on `id + createdAt` with update-in-place tolerance for `parts` divergence. Spec decision: client's optimistic insert writes the same `parts` shape the server will produce (single text part), keeping reconciliation strictly deep-equal
  - If `clientId` is already present in the log (retry scenario), return 409 with `{id: clientId}` — treated as idempotent-success by the client; DO does NOT overwrite the existing row
  - Echo the effective row id in the response body: `{id: string}`
- **Verify:** Unit test on SessionDO ingest RPC + integration curl:
  - `POST {content:'hi', clientId:'usr-client-abc', createdAt:'2026-04-21T00:00:00.000Z'}` → 200 `{id:'usr-client-abc'}`; DO storage contains a row with `id='usr-client-abc'` AND `createdAt='2026-04-21T00:00:00.000Z'` (exact string match, no server re-stamp)
  - `POST {content:'bye', clientId:'usr-client-abc', createdAt:'2026-04-21T00:00:01.000Z'}` (same clientId, different createdAt) → 409 `{id:'usr-client-abc'}`; no duplicate row; existing row's createdAt unchanged
  - `POST {content:'x', clientId:'not-a-valid-shape', createdAt:'2026-04-21T00:00:00.000Z'}` → 400
  - `POST {content:'x', clientId:'usr-client-x'}` (no createdAt) → 400
  - `POST {content:'x', clientId:'usr-client-x', createdAt:'not-iso'}` → 400
- **Source:** SessionDO message-ingest RPC (apps/orchestrator/src/agents/session-do.ts) + apps/orchestrator/src/api/index.ts (ensure POST route forwards body intact)

#### API Layer
- **Endpoint:** `POST /api/sessions/:id/messages`
- **Request:** `{content: string, clientId: string, createdAt: string}` — all required
- **Response:** `{id: string}` on 200 or 409
- **Errors:** 400 (missing/invalid field), 404 session not found, 403 forbidden, 409 duplicate clientId (idempotent-safe)

---

### B8: Reconnect resync via cursor catch-up

**Core:**
- **ID:** reconnect-cursor-catchup
- **Trigger:** Session WS reconnects after a drop (handled by the existing dial-back client in apps/orchestrator/src/hooks/use-user-stream.ts — session equivalent to be added in P1)
- **Expected:** Factory's sync layer detects reconnect via the injected `onReconnect` callback (the replacement for the hardcoded `onUserStreamReconnect` binding at synced-collection.ts L95); handler calls `queryClient.invalidateQueries({queryKey: ['messages', sessionId]})`; queryFn re-fires with the collection's current max (`created_at`, `id`) cursor; returned rows are upserted; in-flight WS deltas continue to apply
- **Verify:** Integration — disconnect WS for 10s while DO receives 3 new messages via an out-of-band curl POST; reconnect; assert via resource-timing that a GET to `/api/sessions/<id>/messages?sinceCreatedAt=&sinceId=` fired within 1s of reconnect; collection converges to all 3 rows; no duplicate rows (upsert keyed by id is idempotent)
- **Source:** apps/orchestrator/src/db/synced-collection.ts L95 (onReconnect injection point), apps/orchestrator/src/features/agent-orch/use-coding-agent.ts (new `onSessionStreamReconnect` — see B2)

#### API Layer
Reuses B4's cursor-based GET endpoint.

**B8 also covers partial-chunk recovery (see B9):** if a chunked rewind frame sequence is interrupted by a WS drop (chunk 1 applied, chunk 2 lost), the reconnect cursor catch-up re-fires the queryFn which returns the full post-rewind history from the cursor point, restoring convergence.

---

### B9: Snapshot events as delete+insert ops

**Core:**
- **ID:** snapshot-as-ops
- **Trigger:** Server-authored navigation event (rewind, resubmit, branch-navigate, or reconnect-requested full resync)
- **Expected:** Server emits one `SyncedCollectionFrame` containing `delete` ops for every stale row id followed by `insert` ops for every new-branch row; no `kind:'snapshot'` discriminator on the wire. Client applies in order; React 18 auto-batches the re-render
- **Verify:** Integration — rewind from leaf A to ancestor X; the frame's op list contains `delete` for each of A's branch-only message ids and `insert` ops for the full post-rewind history (`getHistory(X)` — including shared-prefix rows the client already has; TanStack DB's key-based upsert dedupes these at apply time, so the wire is authoritative-full, not diff-minimal). Final state matches `getHistory(X)` on the server. **DO-side test asserts op count = `|stale|` deletes + `|fresh|` inserts**, not a minimised diff
- **Source:** apps/orchestrator/src/agents/session-do.ts (rewrite rewind/resubmit/getBranchHistory/requestSnapshot RPCs)

#### Data Layer
No change — derivation from `session.getHistory(leafId)` unchanged.

---

### B10: Cross-collection atomicity via DO batch-emit + React auto-batching

**Core:**
- **ID:** messages-branchinfo-batching
- **Trigger:** Server mutation affects both `messages` and `branchInfo` (e.g., user turn that introduces a sibling)
- **Expected:** DO emits both `SyncedCollectionFrame` objects in the same DO turn (same synchronous `this.broadcast` calls, back-to-back). Client subscriber applies messages delta then branchInfo delta back-to-back on the microtask queue. React 18 auto-batches state updates into a single render pass. No `createTransaction` wrapping on the client (explicitly rejected per interview)
- **Verify:** Deterministic behavioral verification (render-count-free):
  - Unit test on the DO: assert `this.broadcast` is called twice synchronously within the same tick — once with `collection:'messages:<id>'` followed immediately by `collection:'branchInfo:<id>'`; assert no microtask yield between the two via a synchronous spy
  - RTL integration test: submit a user turn that introduces a sibling; within a single `act()` wrapper, both the new user message bubble AND the branch-arrow chevron become visible; no intermediate state where the message is present but the branch chevron is missing is observable via a synchronous DOM snapshot taken between React commits (`useEffectEvent` hook or a React test-renderer commit callback)
- **Source:** apps/orchestrator/src/agents/session-do.ts (broadcast path keeps sequential `this.broadcast(messagesFrame); this.broadcast(branchInfoFrame)` in one DO turn)

#### Data Layer
N/A

---

### B11: Delete op supported on wire, not emitted today

**Core:**
- **ID:** delete-op-contract
- **Trigger:** Wire contract parsing
- **Expected:** `SyncedCollectionFrame.ops` supports `{type:'delete', key: string}`; client subscribe path routes `delete` ops through `params.write({type:'delete', key})`. Server NEVER emits a delete op for a `messages:*` collection in this PR (append-only per 2026-04-16 audit); the op exists only for future tombstone use
- **Verify:** Manual wire inspection — grep the server for `type:'delete'` emissions; confirm none for `messages:`. Client unit test: a synthetic frame with `{type:'delete', key:'x'}` removes row `x` from the collection
- **Source:** packages/shared-types/src/index.ts L731-740 (contract already exists), apps/orchestrator/src/db/synced-collection.ts (wire-through in subscribe handler)

---

### B15: BranchInfo wire-rewire (minimal)

**Core:**
- **ID:** branch-info-wire-rewire
- **Trigger:** A DO mutation that previously piggy-backed branchInfo onto a messages frame now emits branchInfo separately (P5 cleanup)
- **Expected:**
  - Server emits `{type:'synced-collection-delta', collection:'branchInfo:<sessionId>', ops: [{type:'insert'|'update', value: BranchInfoRow}, ...], messageSeq: N}` as a separate frame in the same DO turn as the messages frame (sequential synchronous `this.broadcast` calls — no microtask yield between them; see B10)
  - `messageSeq` continues to use the same per-session counter as messages (shared envelope counter across session-scoped collections; observability only)
  - Client branchInfo WS subscription moves off the deleted `handleMessagesFrame` dispatch; new subscription uses `subscribeSessionStream(sessionId, handler)` with an internal filter on `frame.collection === 'branchInfo:<sessionId>'`
  - BranchInfo factory shape, consumers (`useBranchInfo` hook), UI (branch arrows), server-side `computeBranchInfo` + `session.getBranches` + `getBranchHistory` RPC all remain unchanged
- **Verify:**
  - Unit test on the DO's branch-info-emitting code path: assert emitted JSON has shape `{type:'synced-collection-delta', collection:'branchInfo:<id>', ops:[...]}`
  - Unit test: `subscribeSessionStream(sessionId, handler)` filters deliver branchInfo frames to a branchInfo-scoped handler only; messages frames do NOT reach the branchInfo handler and vice versa
  - Integration: create a branch via rewind-then-send; branch arrows render correctly on the shared parent message; clicking a chevron switches active branch (existing UI behavior unchanged)
- **Source:** apps/orchestrator/src/agents/session-do.ts (branchInfo emit path), apps/orchestrator/src/db/branch-info-collection.ts (swap WS subscription source)

#### API Layer
N/A (WS-only wire change)

#### Data Layer
N/A

---

### B13: Drop `version` field from GET response

**Core:**
- **ID:** drop-version-from-get-response
- **Trigger:** Any client consumer calls `GET /api/sessions/:id/messages` (with or without cursor)
- **Expected:** Response body shape is `{messages: SessionMessage[]}` — no `version` field. This is a wire-breaking change relative to the current L1707-1708 handler (`{messages: body.messages, version: body.version}`)
- **Verify:**
  - curl the endpoint; assert `Object.keys(responseBody)` equals `['messages']` exactly
  - Grep for `response.version`, `body.version`, `json.version` in apps/orchestrator/src and apps/mobile (if present) — all call sites removed or refactored
  - `tsc --noEmit` passes after the response type is narrowed to `{messages: SessionMessage[]}`
- **Source:** apps/orchestrator/src/api/index.ts L1707-1708 (drop the `version` key from the response builder); SessionDO internal `/messages` handler (stop returning `version` in the body)

#### API Layer
See B4.

---

### B12: OPFS store version bump clears dead seq field

**Core:**
- **ID:** opfs-store-bump
- **Trigger:** First client load after deploy on a browser with prior OPFS cache
- **Expected:** Bumped store version causes the persistence layer to discard the old IndexedDB/OPFS cache for messages and start fresh; no dead `seq` field on any cached row
- **Verify:** Manual — load pre-deploy build, populate messages cache, deploy new build, reload; OPFS inspector shows no rows for the old store version; new store populated via queryFn
- **Source:** apps/orchestrator/src/db/messages-collection.ts (bump `storeName` or version per `persistedCollectionOptions` convention)

---

## Phase Sizing Note

P2 and P5 are the heaviest phases (6–8 tasks each) because they straddle the server wire migration and the cleanup respectively. Both are feasible in a single implementation session for a contributor familiar with `SessionDO`, but budget ~3–4h for each — they are **not** 1h drop-ins. P1, P3, P4 are lighter (1–3 tasks of focused scope) and should complete in 1–2h each.

## Non-Goals

Explicit exclusions from this PR (pulled from P1 interview):

- **Branching collapse (fork-to-new-session).** The 2026-04-16 state-management audit (L47, L288, L300) commits to "append-only linear log; rewind = new Duraclaw session with copied prefix + D1 metadata link." This PR does NOT implement that collapse. `branchInfoCollection`, `computeBranchInfo`, `session.getBranches`, and rewind-as-branch semantics stay as today. Fork-based rewind is a separate future issue.
- **R1 status collapse (GH#37).** Landed in PR #39 (commit `898598d`). `useDerivedStatus` is **deleted**; status now comes from `sessionsCollection` via the D1-mirrored `agent_sessions.status` column (driven by `broadcastSessionRow`). `useDerivedGate` is retained — it still folds over `messagesCollection` for the pending-gate field. This PR changes **the wire protocol feeding `messagesCollection`** and nothing about status derivation; `useDerivedGate`'s input surface is unchanged (same row shape, minus the `seq` field which is unused by gate derivation).
- **R2 sessionLiveStateCollection retirement.** Already landed in PR #39 — `sessionLiveStateCollection` and `useSessionLiveState` are gone, replaced by `sessionsCollection` + `sessionLocalCollection` and the `useSession(id)` / `useSessionLocalState(id)` selectors. This PR does not touch either.
- **R3 D1-mirror result/error/gate.** Partially landed in PR #39 (migration 0016 added `error`, `error_code`, `kata_state_json`, `context_usage_json`, `worktree_info_json` to `agent_sessions`). Not touched further here.
- **Unifying the two DOs.** SessionDO and UserSettingsDO remain separate; live broadcast stays on the DO that owns the data.
- **Client-side cross-collection transactions.** `createTransaction` is client-optimistic-only in TanStack DB; no primitive exists for cross-collection sync atomicity. B10 explicitly uses DO batch-emit + React 18 auto-batching instead.
- **Server-side message deletion / tombstones.** The wire supports it (B11); no server code emits it.
- **Feature flag / phased rollout.** Single migration, single PR per interview decision.
- **Full migration of `branchInfoCollection` onto the new factory.** P5 does the minimum rewiring needed to keep branchInfo functional after handleMessagesFrame is deleted — specifically, branchInfo's WS subscription moves to `subscribeSessionStream` filtered on `collection: 'branchInfo:<sessionId>'`, and SessionDO emits a matching `SyncedCollectionFrame` for branchInfo in the same DO turn as the messages frame. BranchInfo factory shape, consumers, UI, `computeBranchInfo`, `session.getBranches`, `getBranchHistory` RPC, and the overall branch-tree semantics are all unchanged. A full refactor of branchInfo onto `createSyncedCollection` (with its own cursor, queryFn, persistence) is deferred.

## Verification Plan

Pre-flight: local dev stack running via `scripts/verify/dev-up.sh`; OPFS cleared (`scripts/axi eval 'indexedDB.deleteDatabase("duraclaw")'`); logged in as `agent.verify+duraclaw@example.com`.

### V1 — cold load populates via cursor REST

```bash
scripts/axi open http://localhost:$VERIFY_ORCH_PORT/sessions/<existing-session-id>
scripts/axi eval 'window.performance.getEntriesByType("resource").map(e=>e.name).filter(n=>n.includes("/messages"))'
```

**Expected:** One GET to `/api/sessions/<id>/messages` with no `sinceCreatedAt` query param (cold load). Response body contains `{messages: [...]}` without a `version` field.

### V2 — delta apply without seq gating (unit test)

Run the messages-collection unit suite:

```bash
cd apps/orchestrator
pnpm test src/db/messages-collection.test.ts
```

The suite must include a test that (a) drives a collection instance by invoking the injected `subscribe` handler directly with a synthetic `SyncedCollectionFrame` carrying `messageSeq: 1` (stale), and (b) asserts the row is present in the collection's state afterward — proving apply is not gated on seq. Any console warning about gap must be observable but non-blocking (test inspects `console.warn` calls if the hook emits one).

**Expected:** Test passes; collection contains the synthetic row; no thrown error on a backwards-seq frame.

### V3 — optimistic insert + server echo reconciliation

Type a message and send. Watch the DOM node for the user bubble.

**Expected:**
- Bubble appears immediately with element key containing `usr-client-<uuid>`
- When the server echo arrives (~200ms), the same DOM node persists (no remove+mount flicker)
- React DevTools Profiler shows no key change on the bubble component

### V4 — reconnect cursor catch-up

Use Chrome DevTools Network throttling to force a WS disconnect, then inject a row via an out-of-band HTTP call and observe resync:

```bash
# 1. Open session in one browser; capture cookie via scripts/axi login
scripts/axi open http://localhost:$VERIFY_ORCH_PORT/sessions/<session-id>

# 2. In DevTools: Network tab → Offline mode (forces WS drop after ~30s)
# 3. While offline, from another terminal:
curl -X POST http://localhost:$VERIFY_ORCH_PORT/api/sessions/<session-id>/messages \
  -H 'Cookie: <session-cookie>' \
  -H 'Content-Type: application/json' \
  -d "{\"content\":\"injected-while-offline\",\"clientId\":\"usr-client-offline-1\",\"createdAt\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\"}"

# 4. DevTools → Network → Online mode (triggers reconnect)
# 5. After reconnect settles:
scripts/axi eval 'window.performance.getEntriesByType("resource").map(e=>e.name).filter(n=>n.includes("/messages"))'
```

**Expected:** After reconnect (step 4), one new GET to `/api/sessions/<id>/messages?sinceCreatedAt=<iso>&sinceId=<id>` appears in the resource list, with the cursor derived from the collection's current max row. The "injected-while-offline" message appears in the UI within 2s of reconnect. No duplicate rows.

### V5 — rewind emits delete+insert ops

Trigger rewind to an earlier user turn via the UI.

**Expected:** In DevTools Network → WS frames, the frame sent by the DO is a single `{type:'synced-collection-delta', collection:'messages:<id>', ops:[...]}` containing `delete` ops for each post-rewind row id and `insert` ops for any new-branch rows the client didn't have. No `{type:'messages', kind:'snapshot'}` frame.

### V6 — branchInfo unchanged

Create a branch (rewind + send different message). The branch arrows UI should still appear on the shared parent message.

**Expected:** `branchInfoCollection` still populates; `useBranchInfo(parentId)` returns `{siblings, activeId, total}` with `total > 1`; UI chevrons navigate between branches.

### V7 — useDerivedGate + sessionsCollection status unaffected

Run a session that hits `ask_user`, `permission_request`, and `result`. `useDerivedStatus` was deleted in PR #39 — status now comes from `sessionsCollection` (D1-mirrored `agent_sessions.status` via `broadcastSessionRow`), and `useDerivedGate` is the only consumer of `messagesCollection` for status-like derivation.

**Expected (two independent derivations both healthy):**
- `useDerivedGate(sessionId)` returns the correct pending gate (`ask_user` or `permission_request`) while the gate is unresolved and `null` after `resolve-gate` / `result` — proving the messages-collection wire migration didn't break the gate-fold
- `useSession(sessionId).status` transitions through `thinking → gate-pending → idle` (driven by `broadcastSessionRow` on the user-scoped WS, NOT by this PR's session-scoped messages frames) — proving the two broadcast channels remain independent
- StatusBar, sidebar, tab bar all agree (they all read from `useSession(id).status` per post-#39 rewire)

### V8 — OPFS upgrade path

1. Load pre-deploy build, populate cache with 50+ messages
2. Deploy new build, reload
3. Open Chrome DevTools → Application → Storage → OPFS

**Expected:** Old store removed; new store present with freshly loaded rows; no `seq` field on any row inspected via `indexedDB` API.

### V9 — typecheck + build

```bash
cd /data/projects/duraclaw-dev2
pnpm typecheck
pnpm build
pnpm test
```

**Expected:** All pass.

## Implementation Hints

### Key Imports

```typescript
// Factory
import {createSyncedCollection} from '~/db/synced-collection'
// Query collection primitives
import {queryCollectionOptions} from '@tanstack/query-db-collection'
import {persistedCollectionOptions} from '@tanstack/react-db' // OPFS wrapper
// Wire type
import type {SyncedCollectionFrame, SyncedCollectionOp} from '@duraclaw/shared-types'
// Hook primitives (new exports added in P1)
import {
  subscribeSessionStream,
  onSessionStreamReconnect,
} from '~/features/agent-orch/use-coding-agent'
```

### Code patterns (copy-paste from existing features)

**Pattern 1 — factory call site** (mirror the existing `createUserTabsCollection`):

```typescript
export const createMessagesCollection = (sessionId: string) => {
  if (cache.has(sessionId)) return cache.get(sessionId)!
  const collection = createSyncedCollection<SessionMessage>({
    id: `messages:${sessionId}`,
    collection: `messages:${sessionId}`,
    queryKey: ['messages', sessionId],
    getKey: (row) => row.id,
    subscribe: (handler) => subscribeSessionStream(sessionId, handler),
    onReconnect: (handler) => onSessionStreamReconnect(sessionId, handler),
    queryFn: async ({collection}) => {
      const rows = [...collection.values()]
      const last = rows.reduce<{createdAt: string; id: string} | null>(
        (max, r) =>
          !max || r.createdAt > max.createdAt ||
          (r.createdAt === max.createdAt && r.id > max.id)
            ? {createdAt: r.createdAt, id: r.id}
            : max,
        null,
      )
      const qs = last
        ? `?sinceCreatedAt=${encodeURIComponent(last.createdAt)}&sinceId=${encodeURIComponent(last.id)}`
        : ''
      const resp = await fetch(`/api/sessions/${sessionId}/messages${qs}`)
      if (!resp.ok) throw new Error(`messages fetch ${resp.status}`)
      const body = (await resp.json()) as {messages: SessionMessage[]}
      return body.messages
    },
    onInsert: async ({transaction}) => {
      const row = transaction.mutations[0].modified
      // NOTE: the caller that invokes `collection.insert(...)` for a user
      // turn MUST pre-compute `parts: [{type:'text', text: content}]` on
      // the optimistic row so deepEquals reconciles the server echo with
      // update-in-place (B7/B14). `onInsert` itself only forwards content
      // to the server — the server re-derives `parts` via the same
      // transform, yielding an identical row shape for loopback compare.
      const resp = await fetch(`/api/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({
          content: row.content,
          clientId: row.id,           // e.g. 'usr-client-<uuid>'
          createdAt: row.createdAt,    // client-stamped ISO; server adopts verbatim
        }),
      })
      if (resp.status === 409) return // idempotent retry — server already has this clientId
      if (!resp.ok) throw new Error(`send ${resp.status}`)
    },
  })
  cache.set(sessionId, collection)
  return collection
}
```

**Pattern 2 — subscribe handler in factory** (add to `createSyncedCollection`):

```typescript
// Inside SyncConfig.sync — replace the hardcoded `subscribeUserStream` call
// at synced-collection.ts L76 and the hardcoded `onUserStreamReconnect` at L95
// with the injected `opts.subscribe` / `opts.onReconnect` callbacks.
const unsub = opts.subscribe((frame: SyncedCollectionFrame) => {
  if (frame.collection !== opts.collection) return
  params.begin()
  for (const op of frame.ops) {
    if (op.type === 'delete') {
      params.write({type: 'delete', key: op.key, value: undefined as never})
    } else {
      params.write({type: op.type, value: op.value})
    }
  }
  params.commit()
})
return () => { unsub(); queryCleanup?.() }
```

**Pattern 3 — server-side broadcastMessages** (replace existing):

```typescript
private broadcastMessages(rows: SessionMessage[]) {
  if (!rows.length) return
  const frame: SyncedCollectionFrame<SessionMessage> = {
    type: 'synced-collection-delta',
    collection: `messages:${this.name}`,
    ops: rows.map((r) => ({type: 'insert', value: r})),
    messageSeq: ++this.messageSeq,
  }
  this.broadcast(JSON.stringify(frame))
}
```

**Pattern 4 — rewind emits delete+insert** (server):

```typescript
async rewind(toMsgId: string) {
  const stale = this.session.getHistory(this.activeLeafId)
    .filter((m) => m.created_at > /* toMsg.created_at */)
    .map((m) => m.id)
  this.activeLeafId = /* new leaf */
  const fresh = this.session.getHistory(this.activeLeafId)

  const ops: SyncedCollectionOp<SessionMessage>[] = [
    ...stale.map((id) => ({type: 'delete' as const, key: id})),
    ...fresh.map((value) => ({type: 'insert' as const, value})),
  ]
  const frames = chunkOps(ops, 256 * 1024)
  for (const opsChunk of frames) {
    this.broadcast(JSON.stringify({
      type: 'synced-collection-delta',
      collection: `messages:${this.name}`,
      ops: opsChunk,
      messageSeq: ++this.messageSeq,
    }))
  }
}
```

### Gotchas

- **`persistedCollectionOptions` store version.** Bump the version number (or `storeName`) in the options call, otherwise existing OPFS rows with stale `seq` field will surface. The persistence layer keys by store name — renaming or bumping works equivalently.
- **TanStack DB `queryCollectionOptions.queryFn` contract.** Receives `{signal, meta, collection}` as arg. The `collection` here is the collection itself (reactive) — read `.values()` or `.state` for current rows. Do NOT call `.values()` inside a React render (this is a queryFn, runs async).
- **Loopback reconciliation requires `deepEquals`.** TanStack DB compares the server-echoed row against the optimistic row; if the shape has extra fields (e.g., transient client-only metadata), it will trigger delete+insert. Keep the optimistic row shape IDENTICAL to the server canonical shape (same id, same createdAt to the millisecond — use `new Date().toISOString()` consistently on both sides).
- **`SyncedCollectionFrame.collection` is a free-form string.** Prefix convention (`messages:<id>`, `branchInfo:<id>`, `user_tabs`, `projects`) is enforced only by callers and subscribers. Document the convention in TSDoc; no runtime check.
- **`messageSeq` envelope field.** Clients may log warnings on backward jumps but MUST NOT gate apply. Forward jumps (gap) are benign — cursor resync covers any missed row.
- **React 18 auto-batching requires concurrent-mode-compatible updaters.** `begin/write/commit` on TanStack DB triggers its own notify; if notify runs synchronously per-write, multiple ops in a single frame may cause multiple renders. Confirm the factory batches internally (the existing user-scoped path does).
- **256 KiB fanout cap.** `UserSettingsDO./broadcast` enforces this today; confirm `SessionDO.broadcast` matches. For rewind events on long sessions (many stale ids) chunk via `chunkOps` in apps/orchestrator/src/lib/chunk-frame.ts.
- **SessionMessage `createdAt` precision.** SQLite stores ISO strings; verify millisecond precision is retained across the server round-trip. Lower precision forces more id-tie-break hits (harmless but wastes rows in pagination windows).
- **OPFS eviction during migration.** Safari and some Chromium builds may evict OPFS under storage pressure before the upgrade code runs. `queryFn` cold-load covers this — no manual recovery needed.

### Reference Docs

- **TanStack DB pluggable sync** — https://tanstack.com/db/latest/docs/collection-options — `createCollection({sync})` contract, `begin/write/commit/markReady/truncate`
- **TanStack Query DB collection** — https://tanstack.com/db/latest/docs/collection-options/query-db-collection — `queryCollectionOptions`, queryFn signature, reconciliation semantics
- **Existing createSyncedCollection JSDoc** — `apps/orchestrator/src/db/synced-collection.ts` file-level comment block covers two-layer model and reconnect semantics
- **Prior research** — `planning/research/2026-04-21-gh38-messages-synced-collection-migration.md` (P0 output — tangle inventory, routing options, open questions)
- **Prior research** — `planning/research/2026-04-19-messages-transport-unification.md` (GH#14 predecessor — why the hand-spun path exists today)
- **Source of truth for append-only** — `planning/research/2026-04-16-state-management-audit.md` L47, L288, L300
- **SyncedCollectionFrame wire protocol** — `packages/shared-types/src/index.ts` L731-740 + the JSDoc block in `CLAUDE.md` under "Synced collections"
