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
| Server state | `SessionDO` + `ProjectRegistry` (singleton, SQLite) | Same DOs; god-object dissolved into `MessageStore + GatewayAdapter + DirectLLM + Broadcast` |
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

Rather than patching the current stack surface by surface, the direction is to **change what the stack is** so most of the audit findings stop being possible by construction. The target is TanStack-shaped end-to-end, with Duraclaw owning the primitives it was previously renting from the Cloudflare Agents SDK.

### Shape

```
Client
  TanStack DB (OPFS)  ← source of truth for client-visible chat state
  TanStack AI chat hooks  ← single chat state machine
    │
    ├─ provider: direct          ← first-party LLM calls (router, titles, summaries, meta-agent)
    └─ provider: duraclaw-gateway ← relayed VPS Claude Agent SDK sessions
  PartySocket (WS transport, reconnect, hibernation)
  Sidecar events channel  ← kata_state, context_usage, file_changed, rate_limit
      │
      ▼
SessionDO  (extends PartyServer)
  ├─ MessageStore  ← thin class; wraps SDK Session initially, replaceable later
  ├─ GatewayAdapter  ← VPS GatewayEvent → TanStack AI stream chunks
  ├─ DirectLLM  ← TanStack AI (CF adapter) for first-party calls
  └─ Broadcast  ← seq-numbered, owned wire protocol
      │
      ▼
VPS Executor  (unchanged — dial-back WS, ReconnectableChannel, Claude Agent SDK)
```

### Key moves

1. **Drop Cloudflare Agents SDK.** Extend PartyServer directly (the layer Agents SDK is built on). `useAgent` becomes `usePartySocket`. The experimental `Session` class stops being a required dependency; it lives *inside* a `MessageStore` wrapper we control, and can be replaced without touching the rest of the DO.
2. **Drop Vercel AI SDK.** It's already runtime-dead in Duraclaw — every import is `import type` in `packages/ai-elements`. Replacing the type vocabulary with TanStack AI's shapes costs almost nothing.
3. **Adopt TanStack AI as real runtime.** The outer-layer direct-LLM path (router, classifier, titles, summaries) uses TanStack AI's CF adapter inside the DO. That's when the framework actually earns rent, not before.
4. **Shape the gateway stream to TanStack AI chunks.** The existing `gateway-event-mapper.ts` becomes a TanStack AI provider. Client gets one chat hook for both first-party calls and VPS-relayed sessions — provider is the only difference.
5. **Unify client storage.** TanStack DB is the source of truth for messages (already is, partially). Delete the parallel React `messages` state in `useCodingAgent`. Chat components read from `useMessagesCollection(sessionId)` directly.
6. **Gates become synthetic tool calls.** `permission_request` and `ask_user` become tools the user "responds" to via TanStack AI's isomorphic tool system. Lives inside the chat stream. Natural fit.
7. **Telemetry stays sidecar.** `kata_state`, `context_usage`, `file_changed`, `rate_limit` are observational, not conversational. Separate typed event channel. Panels subscribe as needed.
8. **Own the wire protocol.** Seq-numbered events, idempotency keys, partial replay are designed in from day one — not retrofitted.

### What this architecture resolves by construction

Several audit findings stop being possible:

- **Dual client sync path (WS event + TanStack DB cache with divergence risk)** — collapses to one path. Only TanStack DB.
- **SessionDO god-object (1669 lines, 5 concerns)** — dissolves naturally: broadcaster + gateway adapter + direct LLM caller + message store. Each small. Mutation funneling falls out of the new shape.
- **Custom wire-event schema drift** — gone. TanStack AI chunk shape is the protocol; chat UI and chat store speak the same types.
- **Vercel AI SDK and `@cloudflare/ai-chat` dead weight** — deleted.
- **Experimental SDK lock-in risk** — contained behind `MessageStore`. One file to rewrite if upstream breaks.
- **`HeartbeatEvent` legacy type** — deleted; not modeled in the new wire format.

### What the architecture doesn't resolve — still needs explicit work

- **Concurrent `resume` of same `sdk_session_id`** — still needs a distributed lock in `ProjectRegistry`, regardless of stack.
- **Offline write queue** — TanStack DB provides the store, but the durable "replay on reconnect" queue for optimistic mutations is still code to write.
- **Idempotency keys on VPS commands** — gateway adapter passes them through, but VPS-side dedup cache is still needed.
- **`ProjectRegistry` singleton bottleneck** — orthogonal. Shard + KV cache story is the same in either architecture.
- **SSR hazards in `tabs.ts` / `status-bar` domain leak / dead `auth-store`** — client-state cleanup still required.
- **Integration tests** — real TanStack DB + WS + OPFS coverage is independent of the framework choice.

## Migration path

### Phase 0 — validate the shape (1–2 days)

Throwaway spike. Build a minimal PartyServer-based DO with:
- Native CF WebSocket + PartyServer
- `usePartySocket` on the client
- TanStack AI chat hook pointed at one toy provider
- TanStack DB collection receiving streamed chunks
- A "hello world" direct LLM call via TanStack AI's Anthropic adapter, inside the DO

No session resume, no branching, no rewind, no gateway. ~150 lines of real code. The goal is to confirm the pieces snap together the way the target diagram claims, and to develop an opinion about the message chunk shape before committing.

If the spike feels wrong, back out cheaply.

### Phase 1 — carve out `MessageStore` (1 week, low risk)

Still inside the current stack (Agents SDK + Vercel AI types). Pure containment:

- Introduce `MessageStore` class inside `SessionDO`. Initially, it just delegates to `this.session` (the SDK's experimental `Session`).
- Every call site in `session-do.ts` that touches `this.session.*` moves to `this.messageStore.*`.
- Single funnel for message mutations. This alone pays down:
  - **`turnCounter` race across 4 paths** — now one path.
  - **Partial state persistence** — `MessageStore.append` can enforce the setState + appendMessage ordering as one transaction.
  - **God-object decomposition** — first real seam extracted.

Shippable independently of the rest of the migration. Buys time.

### Phase 2 — gateway adapter + TanStack AI provider (1–2 weeks)

- Build `duraclaw-gateway-provider` as a TanStack AI provider. Internally, it receives `GatewayEvent` from the existing VPS dial-back channel and emits TanStack AI chunks.
- On the DO side, wire it as an alternative broadcast path. Keep the existing `{type: 'message'}` broadcast alive for now — run both in parallel behind a flag.
- On the client, introduce the TanStack AI chat hook for new sessions; old path continues for existing ones.
- Model `permission_request` / `ask_user` as synthetic tool calls. Sidecar events (`kata_state`, `context_usage`, etc.) stay on a separate typed channel.

At the end of this phase: the entire VPS→client stream is TanStack-shaped. Client UX unified.

### Phase 3 — direct LLM path + outer layer (1 week)

- Add TanStack AI CF adapter inside `SessionDO` for first-party LLM calls.
- Build the router/classifier/meta-agent that decides when to spawn a heavy gateway session vs. answer inline.
- Streaming path is the same as the gateway's — TanStack AI chunks through the DO's broadcast. Client can't tell which provider served a given message except by metadata.

### Phase 4 — drop Agents SDK and Vercel AI types (1 week)

- Replace `Agent` base class with direct `PartyServer` extension on `SessionDO`.
- Replace `useAgent` with `usePartySocket` on the client.
- Swap `ai` type imports in `packages/ai-elements` for TanStack AI types. `ai` and `@cloudflare/ai-chat` leave `package.json`.
- Decide whether to replace `Session` (the experimental class still inside `MessageStore`) or keep it. The wrapper means either choice is isolated.

### Phase 5 — parallel hardening (ongoing, runs alongside)

Independent of the framework migration, these still need explicit work:

- **Distributed `sdk_session_id` lock** in `ProjectRegistry` (atomic CAS + TTL lease + heartbeat release). Blocks concurrent resume corruption.
- **Persistent client write queue** in OPFS for optimistic mutations (sessions, prefs, sends). Replays on reconnect.
- **Idempotency keys** on VPS commands (`execute`, `resume`, `stream-input`, `answer`) + short-lived dedup cache.
- **Outbox pattern** for DO→Registry syncs (replaces fire-and-forget).
- **Client-state cleanup:** delete `auth-store.ts`; add `typeof window` guard to `tabs.ts:38`; move `SessionState` out of `status-bar`.
- **Watchdog tuning:** make `STALE_THRESHOLD_MS` env-configurable; scope it to activity state.
- **Metrics:** registry sync success rate, broadcast queue depth per connection, WS reconnect rate, pending-optimistic-writes count.
- **Integration tests:** real TanStack DB + WS + OPFS (not mocks).
- **`ProjectRegistry` sharding + KV cache** — parked until scale demands it; design decision tracked separately.

## Recommended next step

Run **Phase 0** this weekend. It's cheap, it's honest, and it tells you in a couple of hours whether the target architecture holds together. If it does, **Phase 1 (`MessageStore` carve-out)** is the right thing to land next — it's pure containment, pays down risk inside the current stack, and sets up everything after it.

Don't start Phase 2 until Phase 0 has validated the shape. The cost of discovering the provider abstraction doesn't fit mid-migration is much higher than the cost of a spike.

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
