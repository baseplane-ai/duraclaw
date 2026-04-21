---
date: 2026-04-20
topic: Session state surface inventory — post-migration gap analysis
type: feature
status: complete
github_issue: null
items_researched: 6
supersedes: null
extends: 2026-04-16-state-management-audit.md
workflow: RE-acb9-0420
---

# Research: Session State Surface Inventory — Post-Migration Gap Analysis

## Context

Over the last two weeks we shipped three unification bets:

- **Spec #31** (`40f5f62`) — unified sync channel, messages as sole live-state source. Deleted `SessionState` blob; derived status/gate from `messagesCollection`; added typed `session_meta` DO SQLite table (migrations v6/v7).
- **Spec #32 / #33** (`0c1e011`) — `createSyncedCollection` factory for user-scoped data (`user_tabs`, `user_preferences`, `projects`, `chains`). Dual-layer optimistic + synced model, WS delta fanout via `UserSettingsDO`.
- **Spec #35** (effectively done, not closed — landed via `4293e78` + `1b21f1f` + retro-spec `dfb1413`) — `agent_sessions` wired onto the synced-collection delta channel.

Since those landed, the commit log shows a fix tail focused almost entirely on derived-status edge cases and bespoke-collection write paths: `3a8169c`, `9b80143`, `17deb02`, `e9b5177`, `b37cd6e`, `1f41a52`, `374a52f`, `181edfc`, `fc53a4a` — plus four more that landed on `origin/main` *during this research session*: `d26aa66`, `fab1cf0`, `ad5f548`, `5952e94`. Fourteen fixes in eleven days, all clustered on status / live-state / derivation.

The question this research answers: **are those fixes the normal shakedown tail of a large migration, or do they point at residual architectural gaps we should unify on purpose?**

The four in-flight commits are particularly direct evidence. `d26aa66`'s commit message explicitly names the root cause: "Our SessionDO suppresses the Agents SDK protocol messages (`shouldSendProtocolMessages() => false`, Spec #31 P5 B9). That means after the socket opens, `useAgent`'s internal `setIdentity` / `setAgentState` never fire — no re-render happens." The mitigation was a hand-wired PartySocket event subscription mirroring readyState through `useState`. That's the cost of the #31 design choice surfacing in a non-obvious place three weeks later. `5952e94` is even more telling: it introduces a **new bespoke WS frame** (`session_summary`) carrying `numTurns` / `totalCostUsd` / `durationMs` directly into `sessionLiveStateCollection` — because the spec-#31 assumption that REST backfill would keep those fresh "didn't fire during an active session." New frame type, new handler, new bespoke upsert into the bespoke collection. Exactly the pattern this research flags as the anti-pattern.

Classification: **feature research** (map current state, identify gaps) with **feasibility study** elements (evaluate unification paths against migration cost and failure modes).

This doc is a **post-migration delta** on `2026-04-16-state-management-audit.md`. That prior audit is a strategic roadmap *away from* the Cloudflare Agents SDK; this one operates inside the current stack and asks "given what we just shipped, what's the next unification worth taking?"

## Scope

**In scope:** per-session state — status, gate, messages, context usage, kata state, result, branch info, worktree info, connection state.

**Out of scope:** user-scoped state (`user_tabs`, `user_preferences`, `projects`, `chains`) — these are on `createSyncedCollection` and working correctly; not generating fix-commits.

**Sources:** three parallel Explore agents cited the surfaces below with `file:line`; a direct Read confirmed the three distinct client collection patterns.

---

## Part 1 — Surface Inventory

### A. Client collections (TanStack DB)

| Collection | Factory | Pattern | Cold load | Hot updates | OPFS |
|---|---|---|---|---|---|
| `messagesCollection:{agentName}` | `apps/orchestrator/src/db/messages-collection.ts:89` | **`queryCollectionOptions`** + `persistedCollectionOptions` | REST `GET /api/sessions/:id/messages` via `queryFn` (line 96–110) | `{type:'messages'}` WS frame, handled in `use-coding-agent.ts:221–409` | v4 |
| `sessionLiveStateCollection` | `apps/orchestrator/src/db/session-live-state-collection.ts:75–99` | **`localOnlyCollectionOptions`** + `persistedCollectionOptions` | None. Seeded from D1 summary via `seedSessionLiveStateFromSummary` | Direct `gateway_event` handlers in `use-coding-agent.ts:485–521` (kata_state, context_usage, wsReadyState mirror) | v3 |
| `branchInfoCollection:{agentName}` | `apps/orchestrator/src/db/branch-info-collection.ts:42–69` | **`localOnlyCollectionOptions`** + `persistedCollectionOptions` | None (DO-push only) | Piggybacked on `{type:'messages'}` delta/snapshot frames (`use-coding-agent.ts:270–313`, `341–382`) | v1 |
| `user_tabs`, `user_preferences`, `projects`, `chains` | `apps/orchestrator/src/db/synced-collection.ts` | **`createSyncedCollection`** | REST `queryFn` on mount + reconnect | `{type:'synced-collection-delta', collection:...}` via `use-user-stream.ts:111–131` | v1 each |

**Three distinct patterns.** Only `user_*` data uses the factory. Messages uses query-collection with a hand-wired WS push path. Live-state and branch-info are `localOnly` and receive writes from event handlers with no server pull channel. This tri-furcation is the root cause of the recent fix cluster — every collection pattern has its own failure modes, its own upsert semantics, and its own reconnect story.

### B. WebSocket frame types reaching the browser

| Frame type | Originator | Consumer | Target collection | Seq'd |
|---|---|---|---|---|
| `{type:'messages', kind:'delta'\|'snapshot'}` | `SessionDO.broadcastMessages` (`session-do.ts:921–945`) and `broadcastMessage` (`:837`) | `use-coding-agent.ts:441–478` switch → `handleMessagesFrame` (`:221`) | `messagesCollection` + `branchInfoCollection` piggyback | **Yes** (per-session monotonic `frame.seq` / `frame.payload.version`) |
| `{type:'synced-collection-delta', collection, ops}` | `UserSettingsDO.handleBroadcast` (`user-settings-do.ts:99–133`) via `broadcastSyncedDelta` helper (`broadcast-synced-delta.ts:13–44`) | `use-user-stream.ts:122` discriminator | `user_tabs` \| `user_preferences` \| `projects` \| `chains` \| `agent_sessions` | No (reconnect → `queryClient.invalidateQueries` full refetch) |
| `{type:'gateway_event', event:{type,...}}` | `SessionDO.broadcastGatewayEvent` (`session-do.ts:833–835`) | `use-coding-agent.ts:481–510` | `sessionLiveStateCollection` (for `context_usage`, `kata_state`) | **No** |
| `{type:'session_summary', ...}` (**added `5952e94`**) | `SessionDO` on `num_turns` mutation (assistant turn bump + result aggregation) | `use-coding-agent.ts` session_summary handler | `sessionLiveStateCollection` (`numTurns`, `totalCostUsd`, `durationMs`) | **No** |
| `{type:'raw_event', event}` | `SessionDO` tool-permission transitions (`session-do.ts:1006, 2719, 2741, 2786, 2827, 2845`) | `use-coding-agent.ts` ~line 700 (metadata only) | None — in-memory UI state | **No** |
| `{type:'mode_transition', ...}` | `SessionDO:1195–1202` (kata telemetry) | Not directly consumed | None | No |

**Three seq regimes.** Messages have a monotonic per-session seq with gap detection and `requestSnapshot` recovery. Synced-collection-delta uses reconnect-triggered full refetch. Gateway-events and raw-events have no sequencing at all — if the client tab is backgrounded and misses a `context_usage` event, there is no replay. Today that's acceptable because context usage is "nice to have" UX; if status ever rode this channel (which it partially does via B10 narrowing — see Gap #1) that assumption breaks.

### C. Server-side state

| Source | Location | Schema | Writes | Reads |
|---|---|---|---|---|
| `session_meta` (DO SQLite) | `session-do-migrations.ts:70–119` (v6+v7) | 26 cols: `status`, `session_id`, `project`, `project_path`, `model`, `prompt`, `user_id`, `started_at`, `completed_at`, `num_turns`, `total_cost_usd`, `duration_ms`, `gate_json`, `error`, `summary`, `last_kata_mode`, `created_at`, `message_seq`, `sdk_session_id`, `active_callback_token`, `context_usage_json`, `context_usage_cached_at`, `updated_at`, plus base meta | `persistMetaPatch` (`session-do.ts:752–779`) on every state transition | `hydrateMetaFromSql` on `onStart` (`session-do.ts:223, 788–819`) |
| `agent_sessions` (D1) | `apps/orchestrator/src/db/schema.ts:128–165` | `id`, `createdAt`, `updatedAt`, `lastActivity`, `project`, `model`, `prompt`, `status` (default `'running'`), `userId`, `sdkSessionId` (unique partial idx), `summary`, `durationMs`, `totalCostUsd`, `messageCount`, `kataMode`, `kataIssue`, `kataPhase`, `title`, `tag`, `origin`, `agent`, `archived` | `syncStatusToD1` (`session-do.ts:1062`), `syncResultToD1` (`:1074`), `syncSdkSessionIdToD1` (`:1093`), `syncKataToD1` (`:1105`) — fire-and-forget, immediate | REST `/api/sessions/*`, synced-collection `queryFn` |
| SDK-internal `messages` | DO SQLite via agents SDK `Session` class | Opaque Yjs-backed tree | `appendMessage` / `updateMessage` (SDK internal) | `onConnect` snapshot (`session-do.ts:393`), REST `/messages` (`:310`, emits `messageSeq` watermark) |
| `_deprecated_messages` / `_deprecated_events` | DO SQLite | Pre-v4 schema | None | None — dead tables |
| `kv` | DO SQLite | `key`/`value` | `kata_state` cache (`:3102`), gateway token + TTL | `getKataStatus` callable (`:2673`), broadcast handlers |
| `UserSettingsDO` | Ephemeral WS set | No storage — socket set rehydrated from `this.ctx.getWebSockets()` | `handleBroadcast` accepts inbound `broadcastSyncedDelta` requests | Broadcasts to its socket set |
| `user_presence` (D1) | `schema.ts` | `userId`, `firstConnectedAt` | `UserSettingsDO` 0↔1 ref-count transitions | Cross-user fanout target selection (`/api/gateway/projects/sync`) |

**Fields NOT in D1** (DO-only, lost if DO SQLite is wiped): `error`, `result` (beyond summary/cost), `gate`, `context_usage`, `message_seq`, `branch_info`, `sdk_session_id` reliability metadata, `active_callback_token`.

**Fields NOT anywhere on the server** (client-only): `wsReadyState`, `worktreeInfo` (hydrated from gateway events, not persisted DO-side either).

### D. Derived state

| Hook / fn | Location | Inputs | Output | Consumers |
|---|---|---|---|---|
| `useDerivedStatus(sessionId)` | `apps/orchestrator/src/hooks/use-derived-status.ts:29–56` | Last ~10 rows of `messagesCollection` | `SessionStatus` (`'running'` \| `'idle'` \| `'waiting_gate'`) | Active-tab `use-coding-agent`, `AgentDetailView`, `ChatThread` |
| `useDerivedGate(sessionId)` | `apps/orchestrator/src/hooks/use-derived-gate.ts:24–49` | Last ~20 rows of `messagesCollection` | `DerivedGatePayload \| null` | `use-coding-agent`, `GateResolver` |
| `deriveDisplayStateFromStatus(status, wsReadyState)` | `apps/orchestrator/src/lib/display-state.ts:103–133` | `SessionStatus \| undefined` + `WebSocket.readyState` | `DisplayState` (7 variants) | `StatusBar`, `SessionListItem`, `TabBar` |

**Two-tier status readers.** Active-tab callers mount `useCodingAgent` and get `useDerivedStatus(sessionId)`. Non-active callers (sidebar, card list, history, chain page) can't mount `useCodingAgent` for every session in the list, so they read the D1-mirrored `status` field on `sessionLiveStateCollection`. The doc comment on `SessionLiveState.status` (`session-live-state-collection.ts:67–70`) acknowledges this explicitly:

> "D1-mirrored session status for non-active sidebar readers. Live (active-session) callers derive status from `useDerivedStatus` over `messagesCollection` instead."

This is the gap that matters most — it is *intentional* but its cost is real (see Gap #1).

---

## Part 2 — Gap Analysis (ranked by pain)

### Gap #1 — Session status has two client readers with different sources

**Current state:**
- Authoritative value: `session_meta.status` in DO SQLite (one session at a time).
- D1 mirror: `agent_sessions.status`, written fire-and-forget on every DO state transition (`syncStatusToD1`, `session-do.ts:1062`).
- **Client reader A** (active tab, one at a time): `useDerivedStatus(sessionId)` over `messagesCollection`.
- **Client reader B** (sidebar, history, card list, chain page): `sessionLiveStateCollection[id].status`, seeded from `SessionSummary` which is sourced from D1.

**Observed bugs tied to this split:**
- `3a8169c` — optimistic user row missing `seq` stamp ⇒ `useDerivedStatus` saw a row it couldn't rank ⇒ status never transitioned to idle.
- `9b80143` — backwards seq from a reconnect caused `useDerivedStatus` to silently drop the update instead of requesting a snapshot; status froze.
- `17deb02` — `StatusBar` read `status` directly and rendered "idle" while `deriveDisplayStateFromStatus` said "error" ⇒ "idle + red dot."
- `e9b5177` — initial-load ordering between REST queryFn (stamped with `version`) and WS snapshot (stamped with `frame.seq`) caused user turns to appear above assistant turns momentarily, which recomputed `useDerivedStatus` incorrectly for the flash window.
- `fc53a4a` (force-stop) — the composer needed to relabel based on status, and the derived-status path didn't fire until the next message, so the composer missed the transition.

**Failure mode:** any quirk in the message stream (missing seq, out-of-order, optimistic row timing, reconnect gap) manifests as a status bug. The class is not exhausted — it is an open-ended surface because derivation is a compounding function.

**Cost of status quo:** ~1 status-related fix per week, indefinitely. The fixes are small but each one is a correctness trap that had to ship before someone noticed.

**Priority:** P0.

### Gap #2 — `sessionLiveStateCollection` is bespoke

**Current state:**
- `localOnlyCollectionOptions` + direct event-handler upserts. No `queryFn`, no WS delta reconciliation pattern.
- Writes happen in `use-coding-agent.ts:485–521` on `gateway_event` frames: `context_usage` writes `contextUsage`, `kata_state` writes `kataState`, connection-state changes write `wsReadyState`.
- `upsertSessionLiveState` (`session-live-state-collection.ts:107–147`) is a hand-rolled "update-first, insert-fallback" function.

**Observed bugs:**
- `1f41a52` — `upsertSessionLiveState` silently dropped updates after first insert because the update-first branch treated a collection miss as "already handled" and swallowed the write. With `createSyncedCollection`'s `begin/write/commit` discipline this class is impossible.
- `b37cd6e` — branchInfo snapshots had to add a "robust upsert fallback" for the same reason.

**Failure mode:** every field added to `SessionLiveState` requires a bespoke handler path and its own upsert contract. There are now ~20 fields on the type (see B8 expansion, `session-live-state-collection.ts:35–71`) and each one is a potential write-path bug.

**Cost of status quo:** every new live field adds a hand-wired event handler. The collection has already accumulated D1-summary fields (`project`, `model`, `prompt`, `title`, `tag`, etc.) that are now doubly sourced — once via summary seed, once via synced-collection mirror. That double-sourcing is how `1b21f1f` (sync session list from REST on mount) and `4293e78` (wire sessions into synced-collection delta channel) came to be needed.

**Priority:** P0 (enables fixing Gap #1 via Path A).

### Gap #3 — Session result / error not D1-mirrored

**Current state:**
- `session_meta.error` (TEXT), `session_meta.gate_json` (TEXT), `session_meta.context_usage_json` (TEXT), `session_meta.message_seq` (INTEGER) live only in DO SQLite.
- `agent_sessions` D1 has `status`, `summary`, `durationMs`, `totalCostUsd`, `messageCount` but no `error`, no structured `result`, no `gate`.

**Observed failure mode:** when a session errors while backgrounded, the sidebar can show only "idle" or "error" at the level of the `status` enum — no error message, no trace, no reason. The user has to open the session to see `Result.error`. If the DO is evicted before the user opens it, `session_meta.error` is rehydrated from DO SQLite on next access, but any UI that doesn't mount `useCodingAgent` can't surface it.

**Observed bugs:** no specific recent commit, but the pattern shows up in the recent force-stop work (`fc53a4a`): the composer relabel for "error / force-stopped" needed to know the reason, and the only path was waiting for `useCodingAgent` to mount and read `session_meta`.

**Priority:** P1 — user-visible gap but not causing daily fix commits.

### Gap #4 — `branch_info` has no server persistence

**Current state:**
- DO computes branch info on the fly (`computeBranchInfo`, `session-do.ts:845–912`) and piggybacks it onto every `{type:'messages'}` frame (`:405, 1129, 2232, 2640, 2659`).
- Client upserts into OPFS-persisted `branchInfoCollection`.
- No D1 table, no DO SQLite table for branch_info.

**Observed failure mode:** after a DO eviction + cold reconnect with no local OPFS cache (fresh device, cleared storage), branch arrows are absent until the user triggers a rewind/resubmit/branch-navigate that computes a fresh snapshot. On the happy path (warm OPFS) this is invisible; on a genuinely cold client, branches disappear.

**Observed bugs:** `b37cd6e` (reconcile branchInfo snapshots + robust upsert fallback) is an adjacent fix — not for missing data but for the reconcile logic.

**Cost of status quo:** low. Branch info is computable from message history; the DO can always regenerate it. The gap is only that the regenerate-and-push path fires on message events, not on plain reconnect.

**Priority:** P2.

### Gap #5 — Projects endpoint has a gateway-vs-D1 split

**Current state:**
- `GET /api/projects` returns D1 rows (static metadata).
- `GET /api/gateway/projects` hits the VPS gateway and returns live git fields (branch, dirty, ahead/behind).
- Synced-collection `queryFn` for `projects` tries gateway first, falls back to D1.

**Observed failure mode:** cold start shows D1 data (no live git fields) until the next `synced-collection-delta` frame arrives with a gateway-sourced row.

**Observed bugs:** not recent — the pattern is baked in, mostly working.

**Priority:** P3. Cosmetic; the synced-collection reconcile makes it eventually-consistent.

### Gap #6 — Messages have no D1 backup

**Current state:**
- DO SQLite (via agents SDK `Session` class) is the sole server-side message store.
- Client OPFS is the only other copy.
- `messageSeq` is persisted in `session_meta` every 10 frames as a watermark.

**Observed failure mode:** if DO storage is wiped (class rename without migration, manual `ctx.storage.deleteAll`, DO-level data loss) the only remaining copy is each client's OPFS. No authoritative recovery path.

**Priority:** P4 (out of scope for this research — addressed by the prior `2026-04-16-state-management-audit.md` migration-to-PartyServer plan).

---

## Part 3 — Unification Tradeoffs

Three viable paths for closing Gaps #1 and #2 (which are the high-pain pair). Gaps #3–#6 are independent and resolved after picking a path for #1/#2.

### Path A — Collapse derivation; make status an authoritative `agent_sessions` column

**Shape:**
- Delete `useDerivedStatus`, `useDerivedGate` (or keep gate; it's more legitimately derived since it only surfaces during specific message states).
- Add `status` as a first-class column on `agent_sessions` synced-collection row — active-tab and sidebar both read `agentSessionsCollection[id].status`.
- DO writes status transitions to D1 via the existing `syncStatusToD1` path; D1 write triggers `broadcastSyncedDelta` to every connected user-session; all readers converge.
- `sessionLiveStateCollection` is retired — its remaining live-only fields (`contextUsage`, `kataState`, `wsReadyState`, `worktreeInfo`) either move to a new dedicated synced collection or become ephemeral React context on the active tab only (they don't need to fan out to sidebars).

**Pros:**
- **One source of truth** for status. Sidebar and active tab read the same collection row.
- Kills the 4-sources-of-truth problem structurally. No derivation means no seq-stamp-missing, backwards-seq, or ordering-flash bugs.
- Piggybacks on a battle-tested factory (`createSyncedCollection`) that already handles reconcile, reconnect invalidation, optimistic loopback.
- Unifies the write path: D1 is authoritative; every other surface is a mirror.

**Cons:**
- Status lag bounded by D1 write latency + fanout — messages stream faster than DO→D1 writes. If a turn finishes and status goes idle, the user might see "idle" ~50–100 ms after the final message hits the collection.
- `waiting_gate` is derived from message part types, not a DO lifecycle event. Making it authoritative requires the DO to emit an explicit status transition on `permission_request` / `ask_user` — new wire contract between runner and DO.
- Retiring `useDerivedStatus` invalidates some of the elegant work in `40f5f62` (spec #31). Politically awkward to walk back a just-shipped design.

**Migration cost:** Medium. ~3–5 files touched:
- `session-do.ts` — emit status transitions on gate open/close (new branches in tool-permission handlers).
- `agent_sessions` schema bump (no-op; `status` already exists).
- `use-derived-status.ts`, `use-derived-gate.ts` — delete or narrow.
- `StatusBar` / `SessionListItem` / `ChatThread` — read from `agentSessionsCollection`.
- `session-live-state-collection.ts` — retire + migration path for `contextUsage`/`kataState`.

**Perf:** slightly worse (one extra D1 round-trip per transition) but fanout is free (already broadcast). Negligible for human-perceptible status changes.

### Path B — Embrace derivation; kill the D1 status mirror; make derivation universal

**Shape:**
- `useDerivedStatus` becomes the only reader. Sidebar cards each subscribe to `messagesCollection:{id}` and derive status locally.
- `agent_sessions.status` is dropped from D1 (or kept for offline / cold-start only, with a clear "authoritative = derivation" comment).
- `session_meta.status` in DO is also dropped, or kept purely for REST snapshot seeding.
- Fix seq protocol edge cases one-by-one until exhausted.

**Pros:**
- Honors the spec #31 design intent — messages *are* the session. No parallel status machinery.
- Zero migration churn on the write path.
- The "can the sidebar see the status" problem becomes "does the sidebar have a messages collection for this session" — answer: yes, it subscribes lazily.

**Cons:**
- **Cost: N message collections mounted for N sidebar rows.** If the sidebar shows 50 sessions, that's 50 `useLiveQuery` subscriptions reading the last 10 messages each. Memory + query overhead proportional to sidebar size.
- Cold-start sidebar requires loading messages for every session before deriving status. Today it reads the status field instantly from `sessionLiveStateCollection` seeded from `SessionSummary`. Path B means either (a) pre-load messages for all sessions (bandwidth), (b) show "unknown" until messages arrive (UX regression), or (c) add a redundant seed (reintroduces the thing we're trying to delete).
- Does not fix Gap #2 (`sessionLiveStateCollection` bespoke). Orthogonal.
- Does not fix Gap #3 (result/error D1 mirroring). Orthogonal.
- Every new edge case in the seq stream is still a status bug. The long tail continues.

**Migration cost:** Low-to-medium — deletion is simple, but the sidebar loading behavior needs careful thought.

**Perf:** strictly worse than Path A for sidebars. Active-tab unchanged.

### Path C — Hybrid: authoritative D1 column + seq'd stream as realtime hint

**Shape:**
- `agent_sessions.status` remains the authoritative, sidebar-visible column.
- Active tab continues to derive from messages (keeps sub-message-latency status updates for the foreground session).
- Active tab also writes its derived status back to the collection via an optimistic mutation; server echo reconciles (deep-equal loopback).
- On disagreement (derivation says "idle" but D1 still says "running"), derivation wins for the active tab; on conflict resolution at D1, derivation is the source.

**Pros:**
- Keeps the best of both worlds: instant foreground status + authoritative background status.
- No wire-contract change between runner and DO.

**Cons:**
- **Doubles the surface area.** Two readers, two writers, two reconcile paths. If Path A has "one source of truth" as its selling point, Path C has "two sources of truth, reconciled lazily" — the thing we're trying to get away from.
- Optimistic status writes from every active tab fanning out to every other tab is a new correctness surface — what if two tabs are both active on the same session in different windows?
- "Derivation wins for active tab" means there is no single answer to `agentSessionsCollection[id].status` — it depends on who's reading.

**Migration cost:** High. All the surface area of Path A + all the surface area of Path B + new reconcile logic.

**Perf:** Same as Path A for sidebar, same as Path B for active tab. Best-case perf, worst-case complexity.

### Comparison matrix

| Criterion | Path A (collapse) | Path B (embrace) | Path C (hybrid) |
|---|---|---|---|
| Sources of truth | **1** | **1** | 2 |
| Fixes Gap #1 | **Yes** | Partial (one reader, but class of bugs persists) | Yes |
| Fixes Gap #2 | **Yes** (retires `sessionLiveStateCollection`) | No | No |
| Sidebar perf (50 sessions) | **O(1)** (one collection subscription) | O(N) (N message collection subscriptions) | **O(1)** |
| Active-tab latency | ~50–100 ms D1 round-trip | **<10 ms** (message-driven) | **<10 ms** (message-driven) |
| Wire-contract changes | DO emits explicit status transitions on gate events | None | None |
| Migration cost | Medium (5 files) | Low-medium (cleanup + sidebar loading rework) | **High** |
| Walks back spec #31? | Partially | No | No |
| Long tail of status bugs | Eliminated | Continues | Continues (for active tab) |
| Future-proofing for Gap #3 (result/error D1 mirror) | Natural extension | Separate effort | Separate effort |

**Verdict: Path A.**

The single-source-of-truth property plus the O(1) sidebar win plus the structural elimination of the seq-derivation bug class outweigh the "walks back part of spec #31" political cost. The derivation work in #31 isn't wasted — it became the *specification* for what status transitions the DO must emit. The runner/DO contract gets marginally more verbose (explicit gate-open / gate-close events) but the client side gets dramatically simpler.

The ~100 ms active-tab latency regression is the only real tradeoff, and it's below perceptual threshold for status changes. Message streaming itself stays on the messages channel, un-regressed.

---

## Part 4 — Recommended follow-up specs

Ranked by ROI (pain eliminated per unit effort). Each is independently shippable.

### Spec R1 — Collapse session status onto `agent_sessions` (Path A)

**Estimated effort:** ~3–5 day spec + impl. Medium risk (status is load-bearing).

**Behaviors:**
- DO emits explicit `status` transitions on lifecycle events (spawn → running, gate-open → waiting_gate, gate-resolve → running, result → idle, error → error).
- `syncStatusToD1` fires on every transition (already does; just formalize the set of transitions covered).
- Broadcast path: D1 write → `broadcastSyncedDelta(userId, 'agent_sessions', [{type:'update', value: row}])` → all connected clients converge.
- Active tab + sidebar both read `agentSessionsCollection[id].status`.
- `useDerivedStatus` deleted. `useDerivedGate` kept or narrowed (gate is more naturally derived from message parts).

**Verification:** the 10 fix commits from 2026-04-17 onward become regression tests — each one is a scenario that Path A eliminates structurally.

**Depends on:** nothing (Spec #35 already landed the agent_sessions synced collection).

### Spec R2 — Retire `sessionLiveStateCollection`; move live fields to dedicated surface

**Estimated effort:** ~2–3 day spec + impl.

**Behaviors:**
- `contextUsage`, `kataState`, `worktreeInfo` become either:
  - (option a) columns on `agent_sessions` row, written by the DO on relevant gateway events, broadcast via the synced-collection delta channel; or
  - (option b) per-session ephemeral React context provided by `useCodingAgent` only — sidebar doesn't see them, which is fine because sidebar doesn't show context usage or kata state.
- `wsReadyState` — always ephemeral, stays in React state (never belonged on the collection).
- Summary fields currently on `SessionLiveState` (`project`, `model`, `prompt`, `title`, `tag`, etc.) already exist on `agent_sessions`; migrate readers to use that directly.
- Delete `session-live-state-collection.ts`.

**Verification:** fix commits `1f41a52`, `b37cd6e` become structural non-issues.

**Depends on:** Spec R1 (status needs to have moved before live-state can be retired).

### Spec R3 — D1-mirror result / error / gate for background visibility

**Estimated effort:** ~1–2 day spec + impl.

**Behaviors:**
- Add `errorMessage`, `errorCode`, `lastGateReason` columns to `agent_sessions`.
- DO writes on error, permission_request open/close.
- Sidebar can now render "errored: rate limit" or "awaiting permission: Bash(rm -rf /)" without opening the session.

**Verification:** new UI behavior — sidebar shows error reasons on idle sessions; currently impossible.

**Depends on:** nothing, but cleanest to land after R1 (D1 is already the status hub by then).

### Spec R4 — Seq-stamped gateway events (optional, lower priority)

Deferred — only worth doing if Path A is *not* taken. Under Path A, gateway_event contents become hints for ephemeral UI only; dropping one on tab background is acceptable.

### Spec R5 — Message D1 backup

Out of scope for this research; addressed by the prior `2026-04-16-state-management-audit.md` which proposes moving messages to `SessionDO` append-only SQLite (not D1 per se, but a replaceable `MessageStore` wrapper). Revisit after R1–R3 ship.

---

## Part 5 — Open questions

1. **Gate derivation — derive or authoritative?** Gate is more naturally derived than status because it's a transient "waiting for user input" state tied to specific message parts (`tool-permission`, `tool-ask_user` with `state: 'approval-requested'`). Path A's recommendation is "keep `useDerivedGate`, collapse only `useDerivedStatus`." Worth confirming with the spec author that this partial walk-back is acceptable.

2. **Active-tab status latency** — the ~100 ms D1 round-trip regression on status transitions: is that perceptible? Empirical check: time the transition delta today (messages-derived) vs. prototype Path A (D1-synced). Run on a throttled connection.

3. **`sessionLiveStateCollection` summary fields** — who actually needs `title` / `tag` / `archived` on the live-state collection vs. reading them from `agentSessionsCollection`? If the answer is "nobody unique," R2 is a straightforward consolidation; if there's a use case for OPFS-persisted summary (offline tab restore), R2 needs to preserve that.

4. **Gateway-event seq'ing** — Gap #1's fix eliminates most of the reason to seq-stamp `gateway_event` frames, but `context_usage` drift on mobile tab-background is a known UX paper-cut. Worth a minor follow-up (R4) or leave.

5. **Cold-start sidebar source** — under Path A, the sidebar reads `agentSessionsCollection` which is REST-hydrated via `queryFn`. Confirm the cold-start story is good — how long between mount and first status value?

---

## Next Steps

1. **Review this doc with spec #31 author** — the Path A recommendation partially walks back the derive-from-messages decision. Get agreement before drafting R1.
2. **Draft Spec R1** (`planning/specs/36-session-status-on-agent-sessions.md`) using the B-ID / verification-plan template. Link to the 10 fix commits from 2026-04-17 onward as regression cases.
3. **Prototype Path A in a spike branch** to measure the ~100 ms latency concern empirically before committing.
4. **File GitHub issues for R2 / R3** so they're tracked even if not yet scheduled.
5. **Close issue #35** (spec #35 is done, just not closed per user note on 2026-04-20).

## Appendix — Commit references (the 10 fixes that motivated this research)

| Commit | Message | Gap |
|---|---|---|
| `3a8169c` | fix(client): stamp optimistic user row with seq so status transitions to idle | #1 |
| `9b80143` | fix(client): backwards seq now triggers requestSnapshot instead of silent drop | #1 |
| `17deb02` | fix(orchestrator): StatusBar label reads display.label — no more "idle + red dot" | #1 |
| `e9b5177` | fix(messages): kill initial-load + send-time ordering flashes | #1 |
| `374a52f` | fix(orchestrator): stop tearing down shared user-stream WS on every Root cleanup | infra |
| `1f41a52` | fix(client): upsertSessionLiveState silently dropped updates after first insert | #2 |
| `b37cd6e` | fix(client): reconcile branchInfo snapshots + robust upsert fallback | #2 / #4 |
| `fc53a4a` | feat(force-stop): gateway kill endpoint + state-driven composer relabel | #1 |
| `181edfc` | fix(orchestrator): don't hijack fresh sessions with initial kata_state | #1 |
| `4293e78` | fix(orchestrator): wire sessions into synced-collection delta channel | #35 (landed) |
| `1b21f1f` | fix(orchestrator): sync session list from REST on mount, reconnect, and focus | #35 (landed) |
| `d26aa66` | fix(orchestrator): mirror session WS readyState through React state | #1 (direct cite of #31 P5 B9 as root cause) |
| `fab1cf0` | fix(status-bar): anchor label to session status; yellow dot for any non-OPEN | #1 (undoing part of `17deb02` — derivation compounding again) |
| `ad5f548` | fix(derived-status): treat tool input-available as running | #1 (`useDerivedStatus` missed a canonical mid-turn wedge) |
| `5952e94` | fix(status-bar): live turn counter via session_summary WS frame | #2 (new bespoke frame type + new bespoke `sessionLiveStateCollection` upsert to compensate for a #31 assumption that didn't hold) |

Thirteen out of fifteen map to Gaps #1 and #2. That is the shape of the problem.
