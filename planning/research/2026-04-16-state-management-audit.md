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

Duraclaw's state surface is large and partly implicit: a per-session Durable Object, a singleton registry DO, a dial-back WS to a VPS executor, and a React client that blends Zustand stores with TanStack DB collections. This audit maps the six surfaces, surfaces the highest-leverage risks, and lands on a target architecture that replaces the Cloudflare Agents SDK + Vercel AI SDK layers with a TanStack-shaped, owned-primitives stack.

Classification: **feature research** — read the codebase in full, map current state, identify gaps, recommend a target architecture and migration path.

The "Target architecture" section below is the decision, not one option among many. The tiered diagnostic findings are the basis for *why*; the migration path is the *how*.

## Scope

Six surfaces audited, each by a dedicated Explore agent reading the relevant files in full (`session-do.ts` alone is ~1670 lines / 60 KB):

1. **`SessionDO`** — per-session Durable Object (`apps/orchestrator/src/agents/session-do.ts`, `session-do-migrations.ts`, `session-do-helpers.ts`).
2. **`ProjectRegistry`** — singleton registry DO (`project-registry.ts`, `project-registry-migrations.ts`).
3. **Client stores** — `apps/orchestrator/src/stores/*` plus `context/*` providers.
4. **Client collections** — `apps/orchestrator/src/hooks/use-*-collection.ts` and `src/db/*-collection.ts`, powered by TanStack DB + OPFS SQLite.
5. **DO↔Client sync** — Cloudflare Agents SDK WebSocket subscription.
6. **DO↔VPS sync** — dial-back WebSocket protocol (`packages/agent-gateway/src/{server,dialback,session-channel,commands,auth}.ts`).

**Out of scope:** service-worker PWA cache (has its own tests and isn't load-bearing for correctness), router search-param state.

## Stack (as-built → target)

| Layer | As-built | Target |
|---|---|---|
| Client stores | Zustand 5 (5 stores) | Zustand 5 (UI-only; `auth-store` deleted, `status-bar` no longer mirrors `SessionState`) |
| Client data | TanStack DB 0.6 (OPFS SQLite) | TanStack DB (sole source of client-visible chat truth; React message state deleted) |
| Client chat state | Custom hook `useCodingAgent` + React state + WS events | TanStack AI chat hooks (one state machine for all LLM paths) |
| Client WS | Cloudflare Agents SDK `useAgent` (0.11) | PartySocket (native CF) |
| Client UI types | Vercel AI SDK types (`ai` package — `import type` only) | TanStack AI types |
| DO↔Client sync | Cloudflare Agents SDK `Agent` (0.11.0) + custom `{type: 'message'}` broadcast | `PartyServer` + TanStack AI chunk wire format + sidecar telemetry channel |
| DO message storage | Agents SDK `experimental/memory/session` | `MessageStore` wrapper class (SDK Session behind it, replaceable) |
| DO LLM calls | *(none today)* | TanStack AI (CF adapter) — router, classifier, titles, summaries, meta-agent |
| Session/project index | `ProjectRegistry` DO SQLite (singleton, bottleneck) | **D1** (shared, scalable). `ProjectRegistry` DO deleted; discovery alarm → scheduled Worker cron |
| User preferences | `ProjectRegistry` DO SQLite | **D1** (adjacent to Better Auth tables) |
| Per-session message log | Agents SDK `Session` tables (tree with branches) | **`SessionDO` SQLite** — append-only `messages` table + `sdk_sessions` fork tree. No row mutations |
| Server state decomposition | `SessionDO` god-object (1669 lines, 5 concerns) | `SessionDO` dissolved into: append-only log + broadcast + gateway adapter + direct LLM caller |
| VPS transport | Dial-back WS, bearer + one-shot 60s UUID, `ReconnectableChannel` | **Unchanged** — this is the cleanest part of the stack |
| VPS protocol | Custom `VpsCommand`/`GatewayEvent` | Same VPS side; DO side runs gateway events through a TanStack AI provider adapter |
| Auth | Better Auth + Drizzle + D1 | Unchanged |

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

**Heartbeat.** `HeartbeatEvent` type is **defined** in `shared-types` but **never emitted**. This is a leftover from the previous outbound-WS design; under the current dial-back model the `ReconnectableChannel` already keeps the session alive across WS drops, so heartbeats aren't needed. The type is dead code. The 5-minute watchdog threshold is a separate concern (see risks).

**Backpressure.** `messageQueue` is an unbounded array (`server.ts:506–520`). A client flooding `stream-input` can OOM the gateway. `partial_assistant` deltas trigger `session.updateMessage()` on every delta — SQLite write amplification under heavy streaming.

**Top risks:**
- (HIGH) No idempotency on `execute`/`resume`/`stream-input` → retries double-spawn or duplicate-send.
- (HIGH) Concurrent `resume` of the same `sdk_session_id` is not prevented → SDK file corruption.
- (MED) 5-minute watchdog threshold in `SessionDO` can false-trigger on legitimately long model thinks; threshold should probably be config-driven or scoped by session activity.

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

## Target architecture

Rather than patching the current stack surface by surface, the direction is to **change what the stack is** so most of the audit findings stop being possible by construction. The target is TanStack-shaped end-to-end, with Duraclaw owning the primitives it was previously renting from the Cloudflare Agents SDK, and list-shaped data moved to D1 where it belongs.

### Storage philosophy

| Data shape | Where | Why |
|---|---|---|
| List-shaped, cross-user, globally indexed (users, chat sessions index, projects, preferences, push subs) | **D1** | List queries, cross-user joins, no singleton bottleneck |
| Per-entity, live, high write-rate (one session's message log, live WS fanout, streaming state) | **`SessionDO` SQLite** | Per-object durability + broadcast locality |
| Client-visible materialized view of a session's message log | **TanStack DB on client (OPFS)** | Reactive UI, local-first reads, offline-capable |

**`ProjectRegistry` DO goes away.** Its data (sessions index, user preferences) moves to D1. Its discovery alarm moves to a scheduled Worker cron. Nothing it was doing requires singleton-DO semantics.

### Shape

```
Client
  TanStack DB (OPFS)  ← materialized view of one session's message log
  TanStack AI chat hooks  ← single chat state machine
    │
    ├─ provider: direct          ← first-party LLM calls (router, titles, summaries, meta-agent)
    └─ provider: duraclaw-gateway ← relayed VPS Claude Agent SDK sessions
  PartySocket (WS transport, reconnect, hibernation)
  Sidecar events channel  ← kata_state, context_usage, file_changed, rate_limit
      │  one-way sync: "give me rows since seq N"
      ▼
SessionDO  (extends PartyServer, one per Duraclaw session)
  ├─ Append-only message log (SQLite, seq-numbered)
  ├─ sdk_sessions table  ← fork tree: (sdk_session_id, parent, forked_from_turn, is_active)
  ├─ GatewayAdapter  ← VPS GatewayEvent → TanStack AI stream chunks + log append
  ├─ DirectLLM  ← TanStack AI (CF adapter) for first-party calls
  └─ Broadcast  ← one-way seq-numbered deltas to subscribed clients
      │        writes cross-cutting metadata
      ▼
D1 (AUTH_DB)  ← authoritative for list-shaped data
  ├─ users, auth sessions, accounts, verifications  (existing, Better Auth)
  ├─ chat_sessions  ← the Duraclaw session index (moved from ProjectRegistry)
  ├─ user_preferences  (moved from ProjectRegistry)
  ├─ push_subscriptions  (existing)
  └─ hidden_projects  (existing)
      │
      ▼
Scheduled Worker (cron)  ← replaces ProjectRegistry.alarm
  └─ Gateway session discovery sync → writes discovered sessions to D1

VPS Executor  (unchanged — dial-back WS, ReconnectableChannel, Claude Agent SDK)
```

**Write/read directions:**
- **Client → DO:** normal RPC calls (send message, stop, rewind, etc.). No sync involvement.
- **DO → Client:** one-way sync. Seq-numbered, append-only row deltas. No bidirectional CRDT.
- **DO → D1:** direct Drizzle writes for session metadata (status, costs, `sdk_session_id`, etc.). Replaces fire-and-forget `syncTo*Registry` RPCs.
- **Client → D1 (read):** via orchestrator HTTP endpoints that query D1 directly — no DO hop for session lists / prefs.
- **Client → D1 (write):** via orchestrator HTTP endpoints. No direct client access.

### Key moves

1. **Drop Cloudflare Agents SDK.** Extend PartyServer directly (the layer Agents SDK is built on). `useAgent` becomes `usePartySocket`. The experimental `Session` class stops being a required dependency.
2. **Drop Vercel AI SDK.** It's already runtime-dead in Duraclaw — every import is `import type` in `packages/ai-elements`. Replacing the type vocabulary with TanStack AI's shapes costs almost nothing.
3. **Adopt TanStack AI as real runtime.** The outer-layer direct-LLM path (router, classifier, titles, summaries) uses TanStack AI's CF adapter inside the DO. That's when the framework actually earns rent, not before.
4. **Shape the gateway stream to TanStack AI chunks.** The existing `gateway-event-mapper.ts` becomes a TanStack AI provider. Client gets one chat hook for both first-party calls and VPS-relayed sessions — provider is the only difference.
5. **Unify client storage.** TanStack DB is the source of truth for messages on the client. Delete the parallel React `messages` state in `useCodingAgent`. Chat components read from `useMessagesCollection(sessionId)` directly.
6. **Gates become synthetic tool calls.** `permission_request` and `ask_user` become tools the user "responds" to via TanStack AI's isomorphic tool system. Lives inside the chat stream. Natural fit.
7. **Telemetry stays sidecar.** `kata_state`, `context_usage`, `file_changed`, `rate_limit` are observational, not conversational. Separate typed event channel. Panels subscribe as needed.
8. **One-way sync, not bidirectional.** Client's TanStack DB is a **read-only materialized view** of the DO's append-only message log. "Give me rows since seq N" is the whole sync API. Writes are normal RPC calls; no client mutation log, no CRDT, no conflict resolution. Reconnect is the same code path as first-connect — just a different cursor value.
9. **Append-only everything.** The DO's message log never updates rows. Rewind is a Claude-SDK-level fork that produces a new `sdk_session_id`; the DO records it in the `sdk_sessions` fork table and keeps appending. UI filters by active branch; old branch rows stay in the log.
10. **Move list-shaped data to D1.** Chat session index and user preferences move out of `ProjectRegistry` DO into D1 tables adjacent to Better Auth's. `ProjectRegistry` DO is deleted. Discovery sync moves to a scheduled Worker cron.
11. **Own the wire protocol.** Seq-numbered events, idempotency keys, append-only deltas are designed in from day one — not retrofitted.

### What this architecture resolves by construction

Several audit findings stop being possible:

- **Dual client sync path (WS event + TanStack DB cache with divergence risk)** — collapses to one path. TanStack DB is the only client store; writes come from one-way sync.
- **Hydration ping-pong** — gone. Reconnect and first-connect are the same code path (cursor-based delta). No `{type: 'messages'}` bulk replay.
- **Turn-counter race across 4 paths + message-ID collisions** — gone. The log is append-only with monotonic seq; there's nothing to race on.
- **Partial state persistence (setState committed, appendMessage fails)** — gone. The log append is the commit; no secondary state to get out of sync.
- **SessionDO god-object (1669 lines, 5 concerns)** — dissolves: append + broadcast + gateway adapter + direct LLM caller. Each small.
- **Custom wire-event schema drift** — gone. TanStack AI chunk shape is the protocol end-to-end.
- **Vercel AI SDK and `@cloudflare/ai-chat` dead weight** — deleted.
- **`HeartbeatEvent` legacy type** — deleted; not modeled in the new wire format.
- **ProjectRegistry singleton bottleneck** — gone. D1 scales horizontally; no singleton DO in the hot path.
- **Two-phase DO↔Registry inconsistency / fire-and-forget `syncTo*Registry`** — gone. SessionDO writes directly to D1 (Drizzle, transactional); no cross-DO RPC, no silent divergence.
- **Registry failure modes (blocks reads, silent writes)** — gone. D1 is shared-read infrastructure with proper error semantics.
- **Fuzzy `syncDiscoveredSessions` 60-second match race** — gone. A scheduled Worker writing to D1 with proper unique constraints on `sdk_session_id` handles this cleanly.
- **Offline write queue as a feature to build** — gone. Chat writes are RPCs that only make sense when online (the VPS agent can't run offline anyway). Session/prefs RPCs need error handling, not a durable queue.

### What the architecture doesn't resolve — still needs explicit work

- **Concurrent `resume` of same `sdk_session_id`** — D1 unique constraint on an `active_sessions` lock table solves most of it, but the lease/release/recovery story still needs explicit design.
- **Idempotency keys on VPS commands** — gateway adapter passes them through, but VPS-side dedup cache is still work.
- **Streaming write amplification (`session.updateMessage` per partial delta)** — the append-only model helps (no row updates), but you still need to debounce/batch partial chunks so you're not writing per-token. Design decision: how often to snapshot the in-progress row into the log vs. keep it purely ephemeral.
- **SSR hazards in `tabs.ts` / `status-bar` domain leak / dead `auth-store`** — client-state cleanup still required.
- **Integration tests** — real TanStack DB + WS + D1 + OPFS coverage is independent of the framework choice.

## Migration path

### Phase 0 — validate the shape (1–2 days)

Throwaway spike. Build a minimal PartyServer-based DO with:
- Native CF WebSocket + PartyServer
- `usePartySocket` on the client
- One append-only message table with seq numbers
- One-way sync endpoint: "send me rows since seq N"
- Client TanStack DB receiving deltas, rendering a list
- TanStack AI chat hook with a toy provider streaming chunks into an in-progress row
- A "hello world" direct LLM call via TanStack AI's Anthropic adapter, inside the DO

No session resume, no branching, no rewind, no gateway, no D1. ~150 lines. The goal is to confirm that one-way sync + streaming chunks + TanStack AI composes cleanly and feels right. Develop an opinion about the chunk shape and the log row shape before committing.

If the spike feels wrong, back out cheaply.

### Phase 1 — migrate session index to D1 (1 week, low risk, independent win)

Shippable without touching anything else in the architecture. Kills the singleton bottleneck and most of the registry risks.

- Extend the Drizzle schema in `apps/orchestrator/src/db/schema.ts` with `chat_sessions` and `user_preferences` tables (mirror the `ProjectRegistry` columns — 30ish for sessions, 7 for prefs).
- Add a unique constraint on `(sdk_session_id)` in `chat_sessions` to block duplicate discoveries cleanly.
- Migrate existing registry data via a one-time D1 import script.
- Update API endpoints (`api/index.ts`) to query D1 instead of the registry DO.
- Replace the `syncTo*Registry` fire-and-forget calls in `SessionDO` with direct Drizzle writes to `AUTH_DB`. Transactional. No silent divergence.
- Move the 5-min discovery alarm to a scheduled Worker cron that writes to D1.
- Delete `ProjectRegistry` DO class + its migrations + its tests.

**Resolves by construction:** singleton bottleneck, two-phase inconsistency, fire-and-forget registry sync, fuzzy-match race on discovered sessions, registry failure blocking reads.

### Phase 2 — append-only message log + one-way sync (1–2 weeks)

Still inside the current stack. Swap the DO's message storage model.

- Replace `this.session.appendMessage/updateMessage` calls with direct writes to a new seq-numbered `messages` table in `SessionDO` SQLite. Append-only. No row mutations.
- Add `sdk_sessions(sdk_session_id, session_do_id, parent_sdk_session_id, forked_from_turn, is_active, created_at)` table for the fork tree.
- Build the one-way sync endpoint: WS `since` cursor; server responds with seq-numbered row deltas.
- On the client, replace the `{type: 'message'}` event dedup logic with a cursor-based subscription writing into `messagesCollection`.
- Keep the current UI reading path working against the collection.
- Delete `useCodingAgent`'s internal React `messages` state; components read from `useMessagesCollection(sessionId)` directly.

**Resolves by construction:** hydration ping-pong, turn-counter race, message-ID collisions, partial state persistence, dual client sync path.

### Phase 3 — gateway adapter + TanStack AI provider (1–2 weeks)

- Build `duraclaw-gateway-provider` as a TanStack AI provider. Internally, it receives `GatewayEvent` from the existing VPS dial-back channel and emits TanStack AI chunks into an in-progress row; the committed turn gets a single append to the log.
- On the client, introduce the TanStack AI chat hook for all sessions; old code paths delete.
- Model `permission_request` / `ask_user` as synthetic tool calls. Sidecar events (`kata_state`, `context_usage`, etc.) stay on a separate typed channel.

**At the end of this phase:** the entire VPS→client stream is TanStack-shaped.

### Phase 4 — direct LLM path + outer layer (1 week)

- Add TanStack AI CF adapter inside `SessionDO` for first-party LLM calls.
- Build the router/classifier/meta-agent that decides when to spawn a heavy gateway session vs. answer inline.
- Streaming path is the same as the gateway's — TanStack AI chunks through the DO's broadcast, committed turns appended to the log.

### Phase 5 — drop Agents SDK and Vercel AI types (1 week)

- Replace `Agent` base class with direct `PartyServer` extension on `SessionDO`.
- Replace `useAgent` with `usePartySocket` on the client.
- Swap `ai` type imports in `packages/ai-elements` for TanStack AI types. `ai` and `@cloudflare/ai-chat` leave `package.json`.
- The SDK's experimental `Session` class is no longer imported anywhere — Duraclaw's message storage is fully its own.

### Phase 6 — parallel hardening (ongoing, runs alongside)

Independent of the framework migration, these still need explicit work:

- **Distributed `sdk_session_id` lock** — unique constraint in D1 covers most of it; add lease/release/recovery for the edge cases.
- **Idempotency keys** on VPS commands (`execute`, `resume`, `stream-input`, `answer`) + short-lived dedup cache.
- **Partial-chunk debounce** — streaming deltas should not cause per-token SQLite writes. Either: (a) keep the in-progress row purely ephemeral until turn commit, (b) snapshot it into the log every N chunks / M ms, or (c) defer all persistence until the `result` event.
- **Client-state cleanup:** delete `auth-store.ts`; add `typeof window` guard to `tabs.ts:38`; move `SessionState` out of `status-bar`.
- **Watchdog tuning:** make `STALE_THRESHOLD_MS` env-configurable; scope it to activity state.
- **Metrics:** D1 query latency + error rate, broadcast queue depth per connection, WS reconnect rate.
- **Integration tests:** real TanStack DB + WS + D1 + OPFS (not mocks).

## Recommended next step

Run **Phase 0** this weekend. It's cheap, it's honest, and it tells you in a couple of hours whether the target architecture holds together. If it does, **Phase 1 (session index → D1)** is the right thing to land next — it's independent, shippable in a week, kills the biggest bottleneck, and doesn't require Phase 0 to have finished first. It's the unambiguous win you can ship while the rest of the plan matures.

Phases 2–5 are the real architectural migration and should only start once Phase 0's spike has validated the shape. The cost of discovering the sync protocol doesn't fit mid-migration is much higher than the cost of a 1–2 day spike.

## Open questions

- **Phase 0 spike** — what provider shape feels right for the gateway adapter? TanStack AI's provider interface is the hinge point; the spike should land opinions about chunk shape, tool-call round-trip for gates, and how sidecar telemetry is subscribed.
- **`MessageStore` surface** — what's the minimum interface? `append`, `update`, `rewind`, `getBranches`, `getMessage` from the current SDK usage, plus a seq-number emitter. Anything else?
- **Replacing vs keeping `Session`** — once `MessageStore` wraps it, is there a near-term reason to reimplement the tree, or is containment enough indefinitely?
- **Gate modeling** — `permission_request` and `ask_user` become synthetic tools. Does this break anything about the permission flow on the VPS side (where the SDK tracks the gate), or is it purely a wire format change?
- **Existing session migration** — when Phase 2 introduces the TanStack AI chat path, do in-flight sessions get upgraded, or do they finish on the old path? Probably the latter (flag-gated by session creation time).
- **`ProjectRegistry` sharding trigger** — what's the signal that says "now shard"? Request rate threshold? P95 latency? Defer until we have metrics.
- **Better Auth session flow** — `auth-store` is dead; is there any plan to cache tokens client-side, or is that fully delegated to Better Auth cookies?

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
