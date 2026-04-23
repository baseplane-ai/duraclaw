---
date: 2026-04-23
topic: Session-state tracking — subtract complexity (collapse 4 status signals → 1)
type: feature
status: complete
github_issue: 76
items_researched: 7
---

# Research: Session-state tracking subtraction (GH#76)

## Context

GH#76 is a "subtract complexity" epic. After five patches in eleven days
(`ed9c673`, `54ae9db`, `c3d8288`, `8dc04ea`, `2761a82`) each fixing a
distinct asymmetry between four overlapping session-status signals, the
working hypothesis is that the **model is over-articulated**, not that the
implementations were wrong. Before writing a spec, we need a crisp map of
the current topology so deletion targets are unambiguous and regression
risks are named.

## Scope

Seven Explore agents ran in parallel, each mapping one dimension of the
current stack:

1. Status signal topology (the 4 signals end-to-end)
2. Temporal constants audit (the 7 timeouts)
3. DO → client wire protocol (every frame shape)
4. Adjacent state signals (gate, kataState, contextUsage, branchInfo, worktreeInfo)
5. Runner-liveness signals (lastEventTs, gateway `/sessions/:id/status`, RECOVERY_GRACE_MS)
6. Prior patch archaeology (5-commit chain + earlier foundation patches)
7. Agents SDK coupling (`shouldSendProtocolMessages` + spec #31 invariants)

Field list per item: writers / readers / derivation / persistence /
lifecycle / overlap / tag.

## Findings

### 1. Status signal topology — confirmed 4-signal chain with file:line

The current per-session render fold is, in `apps/orchestrator/src/components/status-bar.tsx:264`:

```
status = liveStatus
      ?? (wsReadyState !== 1 ? rawD1Status : undefined)
      ?? d1Status
```

| Signal | Source | Persistence | Lifecycle |
|--------|--------|-------------|-----------|
| `liveStatus` | `session-do.ts:1547` `broadcastSessionStatus()`, frame `{type:'session_status'}` | `sessionLocalCollection` (RAM only) | written on every DO state diff + on `onConnectInner`; cleared on WS close |
| `rawD1Status` | D1 `agent_sessions.status` via `syncStatusToD1()` @ 2179 + synced-collection-delta | D1 + OPFS | written on every lifecycle transition |
| `d1Status` | `derive-status.ts:71` `deriveStatus()` — TTL override when `lastEventTs` stale >45s | derived (no persistence; depends on D1 `last_event_ts`) | computed every render against `useNow()` 10s tick |
| `wsReadyState` | `use-coding-agent.ts:477` mirror of PartySocket readyState | `sessionLocalCollection` (RAM only) | 0–3 values; gates which of above to trust + drives DISCONNECTED label |

Priority chain is replicated in **four render surfaces**: `status-bar.tsx:246-296`,
`tab-bar.tsx:372-380`, `AgentDetailView.tsx:115-124`, `disconnected-banner.tsx:44-50`.

A post-hoc tripwire lives in `status-bar.tsx:246-287` (GH#69 B6) that
warns when `deriveStatus()` shadows a healthy-WS `running` to `idle` —
indicating the 45s TTL boundary is known-fragile and already
instrumented for diagnostics rather than fixed.

### 2. Temporal constants — 7 timeouts, 3 deletable under subtraction

| Constant | Value | File:Line | Introduced | Fate |
|----------|-------|-----------|------------|------|
| `LAST_EVENT_FLUSH_DEBOUNCE_MS` | 10s | `session-do.ts:254` | fa2845c (GH#50, 2026-04-22) | **DELETE** |
| `LAST_EVENT_FLUSH_MAX_INTERVAL_MS` | 20s | `session-do.ts:266` | 2761a82 (today) | **DELETE** |
| `WATCHDOG_INTERVAL_MS` | 30s | `session-do.ts:177` | f3d2663 (2026-04-15) | **KEEP + rename** — hibernation-safe keepalive + recovery-grace check; drop the `lastEventTs` flush piggyback |
| `TTL_MS` | 45s | `derive-status.ts:40` | fa2845c (GH#50) | **DELETE** (whole file) |
| `STALE_THRESHOLD_MS` | 5s | `connection-manager/manager.ts:5` | e3bfdee (GH#42) | **KEEP** — reconnect-skip gate, orthogonal |
| `WS_GRACE_MS` | 5s | `display-state.ts:88` | aeb9209 (GH#69 B5) | **KEEP** — UI-only DISCONNECTED suppression |
| `RECOVERY_GRACE_MS` | 15s | `session-do.ts:182` | 0be422f / 8dc04ea | **KEEP** — runner re-dial grace, load-bearing |

Overlap pattern confirmed: 10s + 20s + 30s all exist because D1 flush
lag gates the 45s TTL. When TTL goes, the flush-management
infrastructure becomes dead code. 5s × 2 are orthogonal (reconnect gate
vs. display suppression). 15s is independent (runner recovery).

### 3. Wire protocol — 4 frame types on `agent:` channel, messages already seq'd

| Frame type | Seq? | Emitters | Consumer | Fate |
|-----------|------|----------|----------|------|
| `synced-collection-delta` (messages, branchInfo) | yes (`messageSeq`) | `broadcastMessages()` 1931, `broadcastBranchInfo()` 1990 | messagesCollection, branchInfoCollection | **KEEP** — already canonical |
| `synced-collection-delta` (agent_sessions) | no | `broadcastSessionRow()` 2457 → `broadcastSyncedDelta()` | sessionsCollection | **KEEP and BECOME sole status carrier**; consider adding seq |
| `session_status` | no | `broadcastSessionStatus()` 1547 | `sessionLocalCollection.liveStatus` | **DELETE** — frame type disappears with the `live*` fields |
| `gateway_event` | no | `broadcastGatewayEvent()` 1667 | type-discriminated handler in `use-coding-agent.ts:426` | **Trim** — `kata_state` / `context_usage` already duplicate the synced-collection-delta payload; consumer migration deferred per spec #37 |
| `raw_event` (fallback) | no | persist-failure catch blocks at 4320, 4342, 4387, 4428, 4446 | **no handler** found in client | **DELETE** — lossy fallback with no receiver |

### 4. Adjacent signals — only `gate` shares status's pathology

| Signal | Verdict | Note |
|--------|---------|------|
| `gate` | **same-pathology-as-status** | Dual-channel (`session_status` + `gateway_event` re-emit) + client-side `useDerivedGate(messagesCollection)`. Same deletion pattern applies. |
| `kataState` | clean | Single writer (runner → DO → D1), single consumer (synced-collection) |
| `contextUsage` | clean | Single writer w/ 5s debounce; gateway_event broadcast is vestigial (consumer-migration deferred per spec #37 B5) |
| `branchInfo` | clean | Pure derivation, no scalar replication, rides messages protocol |
| `worktreeInfo` | clean (not yet implemented) | |
| `numTurns` / `totalCostUsd` / `durationMs` | clean | Write-once result aggregates |

### 5. Runner-liveness — gateway already authoritative

| Mechanism | Role | Post-subtraction |
|-----------|------|------------------|
| `lastEventTs` (D1 + DO SQLite) | Client TTL input | **DELETE** with `derive-status.ts` |
| 30s alarm watchdog | Hibernation-safe flush + stale check + recovery-grace alarm | **KEEP** — drop `lastEventTs` flush, keep `messageSeq` flush + recovery-grace kv deadline check |
| `active_callback_token` + 15s RECOVERY_GRACE | Runner re-dial auth | **KEEP** unchanged (8dc04ea) |
| Gateway `GET /sessions/:id/status` | Authoritative process state, called only on WS drop | **KEEP** — already only called in `maybeRecoverAfterGatewayDrop()` @ 1172 |
| Preflight `GET /sessions` orphan check | Detects runner alive but DO-unreachable | **KEEP** |
| Gap-sentinel from BufferedChannel | Informational overflow marker | **KEEP** — not a liveness signal |
| Heartbeat events | Legacy, dropped (GH#50) | **KEEP dropped** |
| `wsReadyState` on client | UI gate for DISCONNECTED label | **KEEP** — becomes UI-only, no longer a truth-gate |

### 6. Prior patch archaeology — net LOC accounting

| Commit | LOC added | Category | Net if deleted |
|--------|-----------|----------|----------------|
| `ed9c673` (push live status over agent WS) | +145 | **no-op under subtraction** | -119 |
| `54ae9db` (co-flush lastEventTs on every running promotion) | +18 | **no-op** | -18 |
| `c3d8288` (suppress TTL before per-session WS connects) | +26 | **ported** (3-tier → 1-tier) | -18 |
| `8dc04ea` (heal stuck running on WS drop during hibernation) | +219 | **regression-risk — KEEP** | 0 |
| `2761a82` (bound D1 lastEventTs lag) | +115 | **no-op** | -115 |
| `fa2845c` (feat(status): derive from liveness TTL GH#50) | ~200 | **the thing being subtracted** | -~200 |
| `aeb9209` (persist lastEventTs through hibernation GH#69) | ~80 | **ported** (persistence moves with whatever replaces lastEventTs, or also deletes) | -~60 |

**Total net deletion estimate: ~400+ LOC** across `session-do.ts`,
`derive-status.ts` (whole file), `display-state.ts` (keep only
`WS_GRACE_MS`), `session-local-collection.ts` (drop `liveStatus` /
`liveGate` / `liveError`), `use-coding-agent.ts` frame handler, and the
4-tier priority chain in 4 render surfaces.

Regression-contract tests (must continue to pass):

- **Keep** `session-do.test.ts:1229-1262` (grace-action predicate)
- **Keep** `session-do.test.ts:1276-1316` (grace deadline + alarm)
- **Keep** `session-do.test.ts:3338-3372` (auto-heal on sendMessage)
- **Delete** `session-do.test.ts:3488-3542` (`shouldForceFlushLastEventTs`)
- **Rewrite or delete** `features/agent-orch/__tests__/ws-bridge.test.ts:108-127` (live* collection shape contract)

### 7. Agents SDK coupling — `shouldSendProtocolMessages() => false` is the correct steady state

Spec #31 already deleted all `setState` calls (P5 B10), replacing them
with direct typed writes to `session_meta` SQLite + D1 mirror. With no
`setState` calls, there is nothing for the SDK to broadcast. Removing
the suppression does nothing today; it is not a mechanical opportunity.

**Load-bearing SDK affordances** (must keep working):
- `onConnect(connection, ctx)` — synchronous auth + route handling
- `onClose(connection, code, reason)` — drives `maybeRecoverAfterGatewayDrop`
- `onMessage` that delegates to `super.onMessage` — needed for `@callable` RPC plumbing (spawn, stop, abort, etc.)
- `this.ctx.getWebSockets()` — socket registry survives hibernation; used for targeted sends + observability
- `Session.create(this)` in `onStart()` — rehydrates SDK-managed message history

**Key re-framing**: Spec #31's comment at `session-do.ts:980-986`
already enumerates the collapse. Epic #76 is not a new refactor —
it's the completion of spec #31, deleting scaffolding that spec #31
left in place during migration.

## Comparison

Four-signal priority chain, current vs. proposed:

```
# Current (4 signals)
status = liveStatus ?? (wsReadyState !== 1 ? rawD1Status : undefined) ?? d1Status
display = deriveDisplayStateFromStatus(status, wsReadyState, wsCloseTs, nowTs)

# Proposed (1 signal)
status = useDerivedStatus(sessionId) ?? session?.status
display = deriveDisplayStateFromStatus(status, wsReadyState, wsCloseTs, nowTs)
         // wsReadyState only drives the DISCONNECTED label, no longer a truth-gate
```

## Recommendations

**Primary path** (recommended; confirms epic's net-deletion thesis):

1. **Delete `derive-status.ts`** entirely; remove all call sites in
   `status-bar.tsx`, `tab-bar.tsx`, `AgentDetailView.tsx`,
   `disconnected-banner.tsx`, `session-list-item.tsx` etc.
2. **Delete `last_event_ts`** column from D1 schema + DO SQLite
   `session_meta`; drop migration code paths; delete
   `bumpLastEventTs()` / `flushLastEventTsToD1()` /
   `shouldForceFlushLastEventTs()` and tests.
3. **Delete `liveStatus` / `liveGate` / `liveError`** fields from
   `sessionLocalCollection`; delete `broadcastSessionStatus()` and
   `{type:'session_status'}` frame handler in `use-coding-agent.ts`.
4. **Collapse render priority chain** in all 4 surfaces to
   `useDerivedStatus(sessionId) ?? session?.status`.
5. **Rename / refocus `WATCHDOG_INTERVAL_MS`** to clarify its remaining
   role (messageSeq flush + recovery-grace kv deadline check). Drop the
   `lastEventTs` flush piggyback.
6. **Keep everything in 8dc04ea** (durable recovery grace, terminal
   fast-path, inline auto-heal on `sendMessage`).
7. **Keep `WS_GRACE_MS` (5s)** for DISCONNECTED-label suppression and
   `STALE_THRESHOLD_MS` (5s) in ConnectionManager — both orthogonal.

**Secondary scope decisions (for interview):**

- Include **gate** in this epic? Same pathology, ~200 additional LOC
  deletable across the ask_user / permission_request path. Recommend:
  yes — same commit; the derivation-from-messages pattern is identical.
- **Deploy as single commit** (~400+ LOC net delete, one reviewable
  PR) vs. **phased**? Recommend: single commit — the pieces are
  tightly coupled, partial deletion is harder to reason about than
  total deletion.
- Add `messageSeq` to `agent_sessions` synced-collection-delta?
  Recommend: **defer** — not blocking, not on the critical path of the
  subtraction.

## Open Questions

1. **Derivation vs. raw D1** — is the target `useDerivedStatus ?? session?.status` (hybrid: active sessions derive from messages, idle ones read D1) or pure `session?.status`? The issue says "make the per-session WS the only live source", which sounds like "delete even the messages-derived path". But `useDerivedStatus` is the cleaner outcome per spec #31.
2. **Gate in or out of scope?**
3. **Single commit or phased rollout?**
4. **Test strategy** — rewrite the `ws-bridge.test.ts` suite to validate the 1-signal render, or delete outright?
5. **Rollout guard** — any deploy-window rollback concern worth pinning behind a flag, or is this "git-bisect and revert" territory?

## Next Steps

1. **P1 (interview)** — resolve Open Questions 1–5 with the user via
   `/kata-interview`.
2. **P2 (spec writing)** — write numbered spec `planning/specs/76-*.md`
   with phases reflecting the deletion surface: (phase 1) delete
   `derive-status.ts` + callers; (phase 2) delete `lastEventTs`
   plumbing; (phase 3) delete `liveStatus` / `session_status` frame;
   (phase 4) collapse render priority chain; (phase 5) rename
   watchdog + docs cleanup.
3. **P3 (spec review)** — invoke `/kata-spec-review` external agent.
4. **P4 (close)** — commit research doc + spec, push to main.

## Source Reports

Full per-agent reports archived at `/tmp/kata-76-research/`:
- `a468ee59bbafcc329.md` — Status signal topology
- `ae60b32988b5b44fa.md` — Temporal constants audit
- `a3107526d2167a719.md` — DO → client wire protocol
- `aa35e815753e0d762.md` — Adjacent state signals
- `aa844e7ef099a3343.md` — Runner-liveness signals
- `a49d28f2bdeae3c98.md` — Prior patch archaeology
- `adbe2189e8c112653.md` — Agents SDK coupling
