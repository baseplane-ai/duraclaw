---
date: 2026-04-20
topic: Unified sync channel — messages stream as sole live-state source
type: feature
status: complete
github_issue: null
items_researched: 7
---

# Research: Unified Sync Channel — Messages Stream as Sole Live-State Source

## Context

After GH#14 landed the seq'd `{type:'messages'}` wire protocol (delta/snapshot frames,
per-session monotonic seq, gap-detection + snapshot recovery), three user-visible bugs
persist:

1. **User messages not reliably ordered** — sometimes inline, sometimes grouped at top.
2. **Stop/Send button out of sync** — stop button sometimes missing while agent is clearly running.
3. **`ask_user` prompt not hiding after submit** — prompt stays visible after resolution.

Diagnosis traces all three to the same architectural pattern: the client assembles live
UI state from **three independent push channels** (messages frames, `gateway_event`
frames, SDK `onStateUpdate`), only one of which (messages) has seq'd reliability. When
channels race, composition breaks:

- **Bug 1:** unstable sort key — optimistic `createdAt` (client) vs server `createdAt`
  overwrite on echo.
- **Bug 2:** gateway events that should transition `status` don't mirror to
  `sessionLiveStateCollection`; only `kata_state` / `context_usage` / `result` are
  captured.
- **Bug 3:** gate represented in two places (message part `state` + `SessionState.gate`);
  dual-signal OR-logic stays stale when either source is delayed.

This research evaluates a refactor: **make the messages stream the sole live-state
source**, collapse the three channels to one, and eliminate the composition races.

## Scope

**Items researched (7 parallel Explore deep-dives):**

- R1: `SessionState` full field inventory + write/read sites + derivability
- R2: Every `GatewayEvent` type's current server handling + client consumption + proposed
  unified representation
- R3: Client derivation feasibility — selectors over `messagesCollection` for `status`,
  `gate`, `contextUsage`, `kataState`
- R4: External readers of `SessionState` (sidebar, cross-DO, REST) — decide whether to
  keep DO projection or delete
- R5: GH#25 (`messageSeq` rehydrate-drop) scope — prerequisite
- R6: `branchInfo` delta-capability (today: snapshot-only)
- R7: Agents SDK state auto-broadcast — how to stop without forking

**Sources:** `apps/orchestrator/src/agents/session-do.ts`,
`features/agent-orch/use-coding-agent.ts`, `db/*-collection.ts`,
`packages/session-runner/src/main.ts`, `packages/shared-transport/*`,
`packages/shared-types/src/index.ts`, agents SDK (`@cloudflare/agents` v0.11.0), git log,
GH#14 / GH#25.

## Findings

### R1 — `SessionState` field inventory

`SessionState` carries ~20 fields. Categorized:

- **Derivable from messages (14):** `status`, `session_id`, `project`, `model`, `prompt`,
  `started_at`, `completed_at`, `num_turns`, `total_cost_usd`, `duration_ms`, `gate`,
  `error`, `result`, `lastKataMode`.
- **Not derivable (3):** `userId` (auth metadata), `summary` (user-edited narrative),
  `active_callback_token` (DO-internal, already sanitized from client snapshots at
  `session-live-state-collection.ts:91-98`).
- **Dead / unused (1):** `project_path` — never read client-side.
- **D1-mirrored already:** `status`, `model`, `project`, `prompt`, `createdAt`,
  `updatedAt`, `numTurns`, `durationMs`, `totalCostUsd`, `messageCount`, `kataMode`,
  `kataIssue`, `kataPhase` (see `schema.ts:111-148`).

**Client-side components reading `sessionLiveStateCollection`:** `status-bar.tsx`,
`SessionCardList.tsx:95`, `SessionListItem.tsx:68`, `SessionHistory.tsx`,
`use-coding-agent.ts:300-310` (writer).

**Server write sites:** 15+ `updateState` call sites across `session-do.ts` — primary
sources: lines 402, 468, 492, 559, 1346, 1411, 1594, 1705, 1714, 1801, 1860, 2018, 2277,
2309, 2439, 2500, 2570.

### R2 — GatewayEvent → MessagesFrame mapping

22 `GatewayEvent` variants. Categorized for refactor:

- **Already flow through messages channel (8):** `partial_assistant`, `assistant`,
  `tool_result`, `ask_user`, `permission_request`, `file_changed`, `result`, `error` —
  these call `broadcastMessage()` via `handleGatewayEvent()` and persist to Session
  SQLite.
- **State-only (problem children):** `kata_state` (session-do.ts:2509-2540, stored in kv
  + D1), `context_usage` (commands.ts:60-68, on-demand) — these broadcast via
  `broadcastGatewayEvent` only; they are the gap that prevents "messages = sole source."
- **Sidecar-candidate (4):** `rewind_result`, `task_started`, `task_progress`,
  `mode_transition` — metadata tied to turn boundaries.
- **Dead code (client never consumes; 10+):** `heartbeat`, `stopped`,
  `session_state_changed`, `task_notification`, `mode_transition_timeout`,
  `mode_transition_preamble_degraded`, `mode_transition_flush_timeout` (defined but
  never emitted), plus the 8 "already flow through messages" events whose
  `gateway_event` broadcasts are redundant.
- **Client handler today:** only `kata_state`, `context_usage`, `result` (cost/duration
  extraction) — `use-coding-agent.ts:359-392`.

**Sidecar precedent:** `SnapshotPayload.branchInfo?: BranchInfoRow[]`
(shared-types.ts:684) — proves optional payload fields work for auxiliary state.

### R3 — Client derivation feasibility

| Field | Verdict | Mechanism |
|-------|---------|-----------|
| `status` | ✅ trivial | Backward scan 5-10 messages: last `assistant` part with `state:'streaming'` → `running`; unresolved gate part → `waiting_gate`; last message `role:'user'` → `running`; else `idle`. O(1) typical, O(n) worst. |
| `gate` | ✅ no protocol change | Find last `tool-permission` / `tool-ask_user` part with `state:'approval-requested'`. Part state transition to `approval-given` / `approval-denied` / replaced-by-tool-result resolves the gate. **Directly solves Bug 3.** |
| `contextUsage` | ⚠️ needs sidecar | Not persisted as message part today; requires landing on messages channel via sidecar field or new part type. |
| `kataState` | ⚠️ needs sidecar | Same as `contextUsage`. |

**Recompute cost:** TanStack DB `useLiveQuery` memoizes; selector only re-runs when
underlying collection changes. 1000-message thread backward-scan costs ~O(5) typical.

### R4 — External readers & server-side decision

**External reader inventory:**

| Reader | Reads | Freshness | Current path |
|--------|-------|-----------|--------------|
| Sidebar / tab-bar (non-active sessions) | status, num_turns, cost, kata fields | minute-level OK | **D1 REST** (`agent_sessions` table) |
| SessionHistory page | list summaries | minute-level OK | D1 REST |
| REST `GET /api/sessions/:id` | single session summary | seconds (gateway probe fallback) | D1 row |
| REST `GET /api/sessions` | session list, filterable | minute-level | D1 |
| ProjectRegistry | session index, worktree locks | its own DO state | unrelated |
| Active chat UI | everything live | sub-second | **WS (SessionState broadcast)** — the one we're deleting |

**Finding:** no WebSocket subscriptions exist outside the active-session chat.
Sidebars / tab-bar / history are already eventually consistent via D1 REST, fed by
`syncStatusToD1()` / `syncResultToD1()` / `syncKataToD1()` (session-do.ts:791-868).

**Verdict:** `SessionState` is a **redundant duplicate** of D1 fields. The only reader
relying on its real-time push is the active-session chat UI — which the refactor
replaces with client-side derivation over messages.

**Recommendation (adopted):** **Delete `SessionState` entirely** from the DO. Keep
operational fields in SQLite kv (`active_callback_token`, `sdk_session_id`,
`messageSeq`, `turnCounter`, `gateway_conn_id` — already there).

### R5 — GH#25 scope

**Root cause:** `messageSeq` declared in-memory at `session-do.ts:113`. Resets to 0 on
DO rehydrate. Client's `lastSeq` is ahead → next delta fails `seq <= lastSeq` check
(use-coding-agent.ts:287), silently dropped (no `onGap` fires).

**Current mitigation:** commit `ee08782` made client unconditionally reset `lastSeq`
to `frame.payload.version` on snapshot. Sufficient for new connections; stale OPFS
cache handled by DO always emitting snapshot on `onConnect`.

**Storage options ranked:**

1. **kv table** (recommended) — `INSERT OR REPLACE` in existing `persistTurnState()`;
   reuses existing pattern (`turnCounter`, `gateway_conn_id`); ~1ms per broadcast; zero
   schema change.
2. Derive from Session SQLite `SELECT MAX(seq) FROM messages` — always fresh but adds
   boot-time scan.
3. D1 column — 50ms network hop, worst option.

**Effort:** 2-3 hours (4-6 with verify).

### R6 — `branchInfo` delta-capability

**Current:** `branchInfo` is piggybacked on `{kind:'snapshot'}` payloads only (reconnect,
rewind, resubmit, branch-navigate). Delta frames never carry it.

**Mutation gaps:** `sendMessage` (line 607) and `forkWithHistory` (line 1794) create
branch mutations but emit deltas without branchInfo → client sees stale sibling counts
between snapshots.

**Recommendation:** Option (a) — extend `DeltaPayload` with optional
`branchInfo?: { upsert?: BranchInfoRow[]; remove?: string[] }`. Scoped recomputation via
`session.getBranches(parentId)` per affected parent → O(1) per message. Backward compat:
optional field, old clients ignore.

**Effort:** ~2 days (1 server, 0.5 client, 0.5 test).

### R7 — Agents SDK state mechanism

**Mechanism:** `SessionDO extends Agent<Env, SessionState>` from `agents` v0.11.0.
`setState()` auto-broadcasts via SDK protocol to all connected WS clients. Client
subscribes via `useAgent({ onStateUpdate })` from `agents/react`.

**Bypass options:**

- **Option A — override broadcast:** not possible without forking SDK.
- **Option B — stop calling setState(), use SQLite kv:** cleaner long-term, 5-7 days.
- **Option C — `shouldSendProtocolMessages()` filter:** already overridden in
  `SessionDO` (line 288) to suppress SDK frames for `role=gateway` connections.
  Extending to browsers is a one-liner. Empirically proven mechanism.

**Recommendation (adopted):** Option **C** immediate (Phase 4), then delete `setState`
calls as part of Phase 5 (when `SessionState` is deleted).

## Comparison matrix

### Decision summary

| Question | Decision | Rationale |
|----------|----------|-----------|
| DO `SessionState` fate | **Delete entirely** | R4: sidebars already read D1 REST; `SessionState` is redundant duplicate of D1 mirror. |
| `contextUsage` / `kataState` wire path | **Sidecar field on MessagesFrame** (Option B) | Matches existing `branchInfo` precedent; no schema churn; still seq'd. |
| Suppress SDK state broadcast | **`shouldSendProtocolMessages()` filter** (Option C) | One-liner; already proven for gateway role; reversible via flag. |
| GH#25 | **Fold in as Phase 1** | Prerequisite; 2-3 hour kv-table persistence. |
| Gate representation | **Pure derivation from `permission_request` part** | R3: no protocol change; directly fixes Bug 3. |
| `branchInfo` deltas | **Add optional delta field** | R6: scoped recomputation is O(1); backward-compat. |

## Recommendations

### Proposed spec phasing

**Phase 1 — GH#25 fix (prerequisite)**
Persist `messageSeq` in kv table alongside `turnCounter`. Load in `onStart`. No client
changes. ~2-3h.

**Phase 2 — Unified channel wire changes**
- Add optional `contextUsage?: ContextUsage` and `kataState?: KataState` to both
  `DeltaPayload` and `SnapshotPayload`.
- Add optional `branchInfo?: {upsert, remove}` to `DeltaPayload`.
- Stop emitting `gateway_event` frames for events that are already persisted as
  messages (remove dead re-broadcast paths).
- Keep `gateway_event` emission for `context_usage` and `kata_state` temporarily
  (dual-write) during migration.

**Phase 3 — Client derivations**
- Write `useLiveQuery` selectors: `useDerivedStatus()`, `useDerivedGate()`,
  `useContextUsage()` (reads frame sidecar), `useKataState()` (reads frame sidecar).
- Rewrite `deriveDisplayState()` to take messages + wsReadyState instead of state.
- Rewrite `isPendingGate()` in `ChatThread.tsx` to pure-derivation (drop OR logic).
- Fix sort in `use-messages-collection.ts` — sort by `seq` (from delta frames), not
  `createdAt`. **Directly fixes Bug 1.**

**Phase 4 — Suppress SDK state broadcast**
- Extend `shouldSendProtocolMessages()` to return `false` for browser connections
  (behind feature flag initially).
- `onStateUpdate` callback on client becomes no-op (already defensive).
- `sessionLiveStateCollection` stops receiving updates; deleted from active-session
  chat read paths.

**Phase 5 — Delete `SessionState`**
- Remove `DEFAULT_STATE`, `updateState()`, `Agent<Env, SessionState>` generic param.
- Move operational fields (`active_callback_token`, `sdk_session_id`) that still used
  `SessionState` to explicit SQLite kv.
- Delete `sessionLiveStateCollection` from the client entirely.
- Keep `syncStatusToD1()` / `syncResultToD1()` / `syncKataToD1()` as the D1 mirror
  pipeline — unchanged.
- Verify sidebars still render from D1 REST.

### Bugs resolved by each phase

| Bug | Resolved in | How |
|-----|-------------|-----|
| 1. User messages not reliably ordered | Phase 3 | Sort by `seq`, not `createdAt`. |
| 2. Stop/Send button desync | Phase 3 | `status` derived from messages (not coarse state broadcast). |
| 3. `ask_user` not hiding | Phase 3 | Gate derived from message part state; OR-logic dropped. |

## Open questions

- Exact sidecar shape for `contextUsage` and `kataState` — field name, whether
  they land on both delta and snapshot payloads, or only deltas. **→ P1 interview.**
- Feature flag naming and rollout (gradual per-session vs global). **→ P2 spec.**
- Whether to keep `onStateUpdate` in the client hook at all (callable no-op vs
  removed). **→ P2 spec.**
- Do we need a transitional "shadow mode" where derivations run alongside the old
  state reads to verify parity before flipping? **→ P1 interview.**

## Next Steps

1. Open GH issue: `refactor: unified sync channel — messages as sole live-state source`.
2. Run P1 interview (kata-interview) to nail down the open questions above.
3. Write spec in `planning/specs/NN-unified-sync-channel.md` with behaviors (B-IDs)
   and phases P1-P5.
4. Code review + fix loop (P3), then close + commit (P4).
