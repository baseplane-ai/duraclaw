---
date: 2026-04-16
topic: State management audit — six surfaces, strengths, risks, foundations
type: feature
status: complete
github_issue: null
items_researched: 6
---

# Research: State Management Audit

## Context

Duraclaw's state surface is large and partly implicit: a per-session Durable Object, a singleton registry DO, a dial-back WS to a VPS executor, and a React client that blends Zustand stores with TanStack DB collections. This audit maps the six surfaces, surfaces the highest-leverage risks, and proposes a ranked set of foundations to invest in.

Classification: **feature research** — read the codebase in full, map current state, identify gaps, recommend.

## Scope

Six surfaces audited, each by a dedicated Explore agent reading the relevant files in full (`session-do.ts` alone is ~1670 lines / 60 KB):

1. **`SessionDO`** — per-session Durable Object (`apps/orchestrator/src/agents/session-do.ts`, `session-do-migrations.ts`, `session-do-helpers.ts`).
2. **`ProjectRegistry`** — singleton registry DO (`project-registry.ts`, `project-registry-migrations.ts`).
3. **Client stores** — `apps/orchestrator/src/stores/*` plus `context/*` providers.
4. **Client collections** — `apps/orchestrator/src/hooks/use-*-collection.ts` and `src/db/*-collection.ts`, powered by TanStack DB + OPFS SQLite.
5. **DO↔Client sync** — Cloudflare Agents SDK WebSocket subscription.
6. **DO↔VPS sync** — dial-back WebSocket protocol (`packages/agent-gateway/src/{server,dialback,session-channel,commands,auth}.ts`).

**Out of scope:** service-worker PWA cache (has its own tests and isn't load-bearing for correctness), router search-param state.

## Stack (as-built)

| Layer | Tech | Version |
|---|---|---|
| Client stores | Zustand | 5.0.12 |
| Client collections | TanStack DB + react-db + query-db-collection + browser-db-sqlite-persistence (OPFS) | 0.6.4 / 0.1.82 / 1.0.35 / 0.1.8 |
| DO↔Client sync | Cloudflare Agents SDK (`agents`) | 0.11.0 *(CLAUDE.md says 0.7 — stale)* |
| Server state | `SessionDO` (SQLite-backed) + `ProjectRegistry` (singleton, SQLite-backed) | wrangler v1 (fresh migrations) |
| VPS transport | Dial-back WS, bearer + one-shot 60s UUID | — |
| Auth | Better Auth + Drizzle + D1 | 1.5.6 / 0.41.0 |

## Findings

### 1. `SessionDO` — per-session Durable Object

**State shape.** Three-tier:
- Agents-SDK-managed `SessionState` (status, session_id, project, model, gate, costs, `sdk_session_id`).
- Private in-memory: `turnCounter`, `currentTurnMessageId`, `cachedGatewayConnId`, `lastGatewayActivity`.
- SQLite: `kv` table (gateway token + TTL, `kata_state`), plus Session-class-managed `messages`/`branches`/`parents`/`assistant_config` tables (opaque, Agents SDK `experimental/memory/session`). Two deprecated tables (`_deprecated_messages`, `_deprecated_events`) left in place from the v4 rename.

**Migrations.** Forward-only, v1→v4, via `do-migrations.ts:18` pattern (same as registry). Exception-safe ALTERs; `_schema_version` version tracking. No rollback, no cleanup of deprecated tables.

**Mutation flow.** **Five entry points** converging on `setState` / `session.appendMessage` / raw SQL: HTTP handler, WS handlers, 59 `@callable` RPCs, gateway-event dispatcher (`handleGatewayEvent`, ~500 lines handling 15+ event types), watchdog alarm. **Not funneled** through a single path.

**Concurrency hazards identified:**
- `turnCounter` is incremented in 4+ async paths (`spawn`, `hydrateFromGateway`, `sendMessage`, result-event handler at `session-do.ts:592,620,998,1491,1522,1629`). No lock. Collisions produce overwritten messages in the Session tree.
- `this.currentTurnMessageId` shared between `partial_assistant` handler and `resubmitMessage` RPC → if a delta arrives mid-resubmit, orphaned finalization operates on the wrong ID.
- `void this.triggerGatewayDial(cmd)` at `session-do.ts:799,869,1022,1164` — fire-and-forget. If the dial fails, session is already in `running` status; user sees a 5-min freeze before the watchdog kicks in.
- `session.appendMessage` failures are caught and logged (`session-do.ts:791–797,1237–1241,1499`), but `setState` has already committed → message missing from tree while state shows message sent.

**Coupling.** Tightly coupled to `ProjectRegistry` (5 scattered `syncTo*Registry` methods, fire-and-forget), VPS (direct `fetch` + `sendToGateway` inline), and the Agents SDK `Session` experimental API. No abstraction boundaries; no DI.

**Complexity.** 1669 lines / 60 KB, five overlapping responsibilities: bidirectional relay, session lifecycle, gateway event handling, recovery/watchdog, registry sync, push notifications. God-object.

**Top risks:**
- (HIGH) `turnCounter` race → message-ID collision → silent overwrites in Session tree (`session-do.ts:592,620,998`).
- (HIGH) Partial state persistence — `setState` commits before `session.appendMessage`, which swallows errors (`session-do.ts:791–797`).
- (MED-HIGH) Fire-and-forget `triggerGatewayDial` → user-visible 5-min hang on dial failure (`session-do.ts:799`).

### 2. `ProjectRegistry` — singleton registry DO

**Purpose.** Session index (30-column `sessions` table) + user preferences (`user_preferences`) + periodic discovery sync from gateway (5-min alarm). **No worktree locks exist** — the comment at line 15 refers to deleted legacy state, not current functionality. This is a pure read-optimized catalog.

**Singleton.** Hard-coded `idFromName('default')` at every call site (`api/index.ts:30`, `session-do.ts:428,441,457,470,495,1072`). Impossible to fan out; also impossible to shard.

**Schema.** 12-version migration chain (vs 4 in SessionDO), same forward-only framework. One UNIQUE partial index on `sdk_session_id`. No foreign keys, no activity log.

**Consistency with SessionDO.** Two-phase fire-and-forget: SessionDO updates local state, then `await registry.updateSessionStatus(...)` inside a try/catch that only `console.error`s on failure. **State divergence is silent.** If the registry is unreachable for even a few seconds, UI shows stale status until the client refetches.

**Concurrency.** All reads and writes funnel through the singleton. Estimated ~50 req/s for 10 concurrent users (mostly reads), no read/write separation, no cache layer. Full-table scan in `listSessions` (`project-registry.ts:239–271`). Not currently a bottleneck — will become one.

**Failure modes.** No retry, no queue, no circuit breaker on the registry client side. Writes fail silently; reads block callers until timeout (30s).

**`syncDiscoveredSessions` (`project-registry.ts:560–599`).** Matches discovered sessions to existing DO-created sessions using a 60-second `created_at` fuzzy window, because `sdk_session_id` isn't known at create time. If the gateway's 5-min discovery alarm runs late (network jitter, VPS restart), the window misses → duplicate sessions in the registry, split cost tracking, confused resume. Repeated `last_activity` backfill-clears in v10 and v12 migrations hint at ongoing trust issues with this data.

**Top risks:**
- (HIGH) Singleton bottleneck + no failover — one path for all session reads/writes, no retry, no cache.
- (MED) Two-phase inconsistency — SessionDO ↔ Registry diverge on any transient registry outage.
- (MED) Fuzzy-match race in `syncDiscoveredSessions` → duplicate sessions under load.

### 3. Client stores (Zustand + context providers)

**Consistency.** All five stores use Zustand 5 uniformly. Context providers are used only for passive UI preferences (theme, direction, font, layout, search) that persist to cookies via a shared SSR-safe helper.

**Per-store verdict:**
| Store | Classification | Verdict |
|---|---|---|
| `auth-store.ts` | Dead code | Never imported; duplicates Better Auth session. Delete. |
| `notifications.ts` | UI ephemera | Clean — Zustand `persist` middleware + 30-day prune. |
| `status-bar.ts` | **Domain leak** | Mirrors `SessionState` into a Zustand store (`AgentDetailView.tsx:42–51`). Fine while visible, divergent if DO state updates off-screen. |
| `tabs.ts` | UI navigation | Calls `localStorage.getItem()` without a `typeof window` guard (`tabs.ts:38`) → **SSR crash hazard** on first hydration. |
| `workspace.ts` | UI navigation | Guards properly; uses manual localStorage (no `persist` middleware). |

**Persistence.** Mixed — Zustand `persist` middleware (notifications), manual `localStorage` (tabs, workspace), cookie-backed (auth-store, all providers). Inconsistent.

**Auth.** `auth-store` is unused; Better Auth's `useSession()` hook is the actual source of truth for the client. The existence of a parallel token-holding store invites future bugs.

**Top risks:**
- (HIGH) `tabs.ts` SSR crash on first hydration.
- (MED) `status-bar` mirrors domain state — will diverge from the DO if a background tab reads it.
- (MED) `auth-store` dead code; confuses the auth story for new contributors.

### 4. Client collections (TanStack DB + OPFS)

**Stack.** TanStack DB 0.6.4 + `@tanstack/react-db` + `@tanstack/query-db-collection` + `@tanstack/browser-db-sqlite-persistence` (OPFS). Two collection types in use:
- **`sessionsCollection`** — query-backed, 30s refetch + 15s stale, persisted to OPFS.
- **`messagesCollection`** — local-only, cache-behind-WS, persisted to OPFS.

**Sync model.**
- **Sessions:** HTTP pull every 30s + manual refresh. DO state updates also flow in via WS (`useCodingAgent`'s `onStateUpdate` patches `sessionsCollection` at `use-coding-agent.ts:156–163`), but only if the record already exists.
- **Messages:** WS-only. Cache-first from OPFS on mount, then `hydrateMessages` RPC on WS connect, then `{ type: 'message' | 'messages' }` broadcasts. **No HTTP fallback** if the WS stalls.

**Optimistic updates.** Explicit pattern: `optimisticIdsRef` for user messages (`use-coding-agent.ts:452–476`), TanStack `createTransaction` for session CRUD (`use-sessions-collection.ts:52–86`). Server echo replaces optimistic on success; deletion on server error. **Preferences** PUT is pure fire-and-forget (no error path at all, `use-user-defaults.ts:41–51`).

**Offline.** Not handled. No write queue, no HTTP fallback for messages, no reconnect replay. OPFS caches survive offline reads but writes dropped on the floor never reach the server.

**Conflict handling.** Naive LWW everywhere. No `version`/`etag` on `SessionRecord` or `UserPreferences`. If the DO broadcasts a status update concurrently with a UI rename, one silently overwrites the other (`use-coding-agent.ts:156–163` vs `use-sessions-collection.ts:89–112`).

**Testing.** Good unit coverage with mocks; **zero integration tests** against real TanStack + WS + OPFS, no flaky-network scenarios, no concurrent-mutation tests.

**Top risks:**
- (HIGH) Offline write loss — optimistic mutations for sessions/prefs have no durability queue.
- (HIGH) WS-only message delivery — if the WS stalls, user sees frozen UI with no timeout/fallback.
- (MED) LWW overwrites — no versioning on session records or prefs.

### 5. DO↔Client sync channel

**Transport.** Agents SDK v0.11 WebSocket. Browser connects via `/agents/session-agent/{doId}`; gateway connects via the same URL with `?role=gateway&token={uuid}` (session-do.ts:147–149). Two distinct connection classes on one DO.

**Wire messages (from DO → client):** `{type: 'message', ...}`, `{type: 'messages', ...}` (bulk replay), `{type: 'gateway_event', ...}` covering `session.init`, `partial_assistant`, `assistant`, `tool_result`, `ask_user`, `permission_request`, `file_changed`, `result`, `stopped`, `error`, `kata_state`, `heartbeat`, `context_usage`, `rewind_result`, etc. **Plus** Agents SDK native state-sync via `onStateUpdate`.

**Hydration.** Two-phase:
1. On WS connect (`onConnect`, `session-do.ts:145`): send full persisted message list.
2. If `sdk_session_id` is set (resumed session): HTTP GET to gateway for transcript, incremental merge (`hydrateFromGateway`, `session-do.ts:520–652`).

**Ordering.** Message IDs are `usr-{turnCounter}` / `msg-{turnCounter}` / `err-{turnCounter}`. `turnCounter` is persisted atomically, **but no seq-no on the wire.** Clients can't detect gaps. Tool results are applied to the *current* assistant message (no `tool_call_id` match) — out-of-order results silently lose earlier ones.

**Reconnection.** Client gets full replay every time. No resume-from-last-seen. If the gateway produces events while the browser is disconnected *and* those events are not persisted to the Session tree before disconnect, they are lost on reconnect — only persisted history is replayed. Streaming parts are finalized via `finalizeStreamingParts` (`gateway-event-mapper.ts:92–99`) which marks them `done` / `output-error`.

**Backpressure.** None. `connection.send(JSON.stringify(...))` regardless of `readyState` or queue depth (`session-do.ts:400–404`). Unbounded OS-level buffering. A slow tab can pressure the DO.

**Auth.** Browser via session cookie on upgrade. Gateway via one-shot 60s-TTL UUID token stored in SQLite `kv`; validated on `onConnect` (`session-do-helpers.ts:45–65`). Token **not consumed** on use — valid for the full 60s window, which supports reconnects but widens the leak window.

**Multi-tab.** Yes. Each tab is a separate Connection; broadcast fans out to all. Same send is seen by all. Client-side dedup only.

**Top risks:**
- (HIGH) Unbounded broadcast buffering → slow tab can push the DO toward OOM / eviction.
- (MED) No gap detection / no partial replay → silent loss on transient disconnect.
- (MED) Gateway token valid for 60s, not consumed on use.

### 6. DO↔VPS sync channel

**Who dials whom.** DO posts to `/sessions/start` on the gateway → gateway dials **back** to DO on a callback URL (one-shot token). Hence "dial-back." Implemented in `dialback.ts:141–228`.

**Reconnection.** Exponential backoff 1s / 3s / 9s (3 attempts). On reconnect, the `ReconnectableChannel` swaps the underlying WS in-place — the adapter keeps running against the same channel reference, so the session survives a WS drop (`dialback.ts:198–223`). This is the most resilient part of the whole system.

**Commands (VpsCommand):** `execute`, `resume`, `stream-input`, `permission-response`, `abort`, `stop`, `answer`, `rewind`, `interrupt`, `get-context-usage`, `set-model`, `set-permission-mode`, `stop-task`, `ping`.

**Events (GatewayEvent):** `session.init`, `partial_assistant`, `assistant`, `tool_result`, `ask_user`, `permission_request`, `file_changed`, `result`, `stopped`, `error`, `kata_state`, `context_usage`, `rewind_result`, `session_state_changed`, `rate_limit`, task events, `heartbeat`.

**Executor-side state.** Pure in-memory `GatewaySessionContext` per WS (abortController, pendingAnswer/Permission Promises, messageQueue, SDK Query). **Nothing persisted** on VPS — the SDK adapter writes transcripts to disk under `.claude/sessions/{sdk_session_id}/`. VPS is a relay + executor.

**Resume semantics.** `sdk_session_id` is the durability key, persisted on disk by the SDK. DO stores it in the registry. Resume spawns a new `SessionDO` → dials gateway with `type: 'resume'` → SDK re-opens the same on-disk session. **No lock** prevents two DO instances from resuming the same `sdk_session_id` concurrently → both VPS adapters write to the same `.claude/sessions/{id}/` dir → corruption.

**Idempotency.** **None.** No `idempotency_id` on commands. A retry of `execute` double-spawns; a retry of `stream-input` double-sends. There's no dedup cache.

**Auth.** Bearer token from env (`CC_GATEWAY_API_TOKEN`), timing-safe compared at `auth.ts:3–11`. Static — no rotation.

**Heartbeat.** `HeartbeatEvent` type is **defined** in `shared-types` but **never emitted** (verified in `dialback.ts`). The DO watchdog treats 5 minutes without any gateway message as stale → recovery fires. A legitimate long model think exceeding 5 min will trigger false recovery.

**Backpressure.** `messageQueue` is an unbounded array (`server.ts:506–520`). A client flooding `stream-input` can OOM the gateway. `partial_assistant` deltas trigger `session.updateMessage()` on every delta — SQLite write amplification under heavy streaming.

**Top risks:**
- (HIGH) No idempotency on `execute`/`resume`/`stream-input` → retries double-spawn or duplicate-send.
- (HIGH) Concurrent `resume` of the same `sdk_session_id` is not prevented → SDK file corruption.
- (MED) `HeartbeatEvent` unused → false stale detection on long-running turns.

## Cross-cutting observations

One theme runs through every layer: **optimistic, fire-and-forget, last-write-wins, full replay.**

- **No sequence numbers or idempotency keys** on messages, commands, or syncs at any layer.
- **No transactional boundaries** — mutations commit in steps; partial failures leave silent divergence (SessionDO setState vs appendMessage; DO state vs registry state; client optimistic vs server state).
- **No backpressure** on DO broadcast, VPS `messageQueue`, or streaming deltas.
- **No distributed lock** despite comments/naming suggesting worktree locks used to exist.
- **No persistent write queue** on the client — optimistic mutations evaporate if the tab closes before server ack.
- **Full replay** on every reconnect; no partial/incremental resume.

What's actually good and worth preserving:

- Consistent migration framework (forward-only, exception-safe) across both DOs.
- Consistent Zustand adoption for UI state.
- Modern local-first stack (TanStack DB + OPFS SQLite) — correct primitive for optimistic + offline.
- Dial-back reconnect with in-place WS swap in `dialback.ts` — the cleanest piece of the codebase.
- Timing-safe bearer compare on VPS.
- Watchdog alarm — crude, but a real safety net.
- Optimistic UI + `optimisticIdsRef` dedup — right pattern, just needs durability behind it.

## Recommendations (ranked)

### Tier 1 — stop silent data loss

1. **Seq-numbered events + partial replay on DO↔Client.** Client tracks `lastSeq`; DO replays the delta on reconnect. Enables gap detection; fixes mobile/flaky-network. Touches `session-do.ts` broadcast/onConnect and `use-coding-agent.ts` hydration.
2. **Persistent client write queue** in OPFS. Session CRUD, preferences, and user-message sends all go through a durable queue that replays on reconnect. Surfaces a "pending writes" indicator.
3. **Idempotency keys on VPS commands** (`execute`, `resume`, `stream-input`, `answer`). Short-lived dedup cache on VPS and DO. Eliminates double-spawn on retry.

### Tier 2 — stop silent corruption

4. **Distributed lock on `sdk_session_id`** in `ProjectRegistry` — atomic CAS with TTL lease + force-release by heartbeat. Blocks concurrent resume.
5. **Transactional mutations in `SessionDO`** — wrap `setState + session.appendMessage + persistTurnState` as one unit. On failure, revert in-memory state or escalate to client.
6. **Outbox pattern for DO→Registry syncs** — SessionDO writes events to a local table; a pump flushes them with retry. Replaces fire-and-forget at `session-do.ts:426–505`.

### Tier 3 — structural

7. **Break up `SessionDO` (1669 lines / 5 concerns).** Extract `GatewayClient` (dial/send/token), `EventDispatcher` (handleGatewayEvent), `RecoveryManager` (watchdog + hydrate), `RegistrySync` (5 sync methods). Eliminates several concurrency hazards as a side effect.
8. **Emit `HeartbeatEvent` from VPS** (type already defined). Bump `STALE_THRESHOLD_MS` into env config. Fixes false stale detection.
9. **Client-state cleanup:**
   - Delete `auth-store.ts`.
   - Add `typeof window` guard to `tabs.ts:38`.
   - Move `SessionState` out of `status-bar` — derive from WS/Query instead.
10. **Plan sharding + KV read cache for `ProjectRegistry`.** Not urgent, but the singleton is load-bearing and has no escape hatch today.

### Tier 4 — observability / testing

11. **Metrics:** registry sync success rate, per-connection broadcast queue depth, WS reconnect rate, pending-optimistic-writes count.
12. **Integration tests** with real TanStack DB + WS + OPFS — current coverage is all-mocked, so flaky-network and concurrent-mutation bugs won't show up.

## Recommended next step

If the goal is one initiative that buys the most reliability, bundle **Tier 1 as a single epic**. Seq-numbers + persistent write queue + idempotency keys are the same pattern applied at three layers — and together they make the system actually reliable under the flaky networks and retries where most of the current latent bugs live.

Tier 2 is where correctness (not just reliability) lives — if a session can get silently corrupted by a concurrent resume or a half-committed mutation, that's worth fixing even before perf/scale work.

## Open questions

- **Better Auth session flow** — `auth-store` is dead, but is there a plan to cache tokens client-side at all, or is that fully delegated to Better Auth cookies?
- **Agents SDK `Session` experimental API** — how stable is this? The DO is tightly coupled to it and the surface isn't versioned.
- **Gateway HTTP fallback** — the DO-side `hydrateFromGateway` already speaks HTTP to the gateway. Is adding a message-fetch HTTP endpoint for the client's WS-stall fallback a natural extension?
- **Scope of Tier 1** — is this scoped as a single epic, or should seq-numbers ship first (smallest unit, biggest unlock), write queue second, idempotency third?

## Sources

- `apps/orchestrator/src/agents/session-do.ts` (1669 lines, read in full)
- `apps/orchestrator/src/agents/session-do-migrations.ts`, `session-do-helpers.ts`, `gateway-event-mapper.ts`
- `apps/orchestrator/src/agents/project-registry.ts`, `project-registry-migrations.ts`
- `apps/orchestrator/src/stores/*.ts`, `context/*.tsx`
- `apps/orchestrator/src/hooks/use-*-collection.ts`, `use-coding-agent.ts`, `db/*-collection.ts`, `db/db-instance.ts`
- `apps/orchestrator/src/api/index.ts`
- `apps/orchestrator/wrangler.toml`, `apps/orchestrator/package.json`
- `packages/agent-gateway/src/{server,dialback,session-channel,commands,auth,types,sessions,sessions-list}.ts`
- `packages/shared-types/src/index.ts`
