---
date: 2026-04-22
topic: "Session state UI shows idle while streaming; refresh reveals full dump (GH#69)"
type: feasibility
status: complete
github_issue: 69
items_researched: 6
related:
  - planning/research/2026-04-22-silent-session-closures-post-ttl.md
  - planning/research/2026-04-22-gh50-status-ttl.md
  - planning/research/2026-04-21-gh38-messages-synced-collection-migration.md
  - planning/specs/50-status-ttl.md
  - planning/specs/14-session-ws-delta-snapshot.md
---

# Research: GH#69 session state drift

## Context

User report: "we're still getting unreliable session state tracking — sometimes
it says idle while streaming is still coming in, or the stream shouldn't have
ended but it says idle, and then on refresh we get the full dump. Especially on
mobile." Confirmed during P1 scoping that it also reproduces on web.

## TL;DR

The symptom is **two distinct defect clusters** whose superposition produces the
observed behavior. One is a **regression introduced by spec #50** (status TTL +
heartbeat removal) — already characterized in detail in
`2026-04-22-silent-session-closures-post-ttl.md`. The other is a **pre-existing
client-side sync-protocol gap** that spec #14 planned but only partially shipped
— uncovered by this research pass.

- **Cluster 1 — premature idle label.** Any gateway-WS idle close during a
  quiet-but-alive runner phase triggers unconditional
  `recoverFromDroppedConnection` → `status:'idle'` broadcast + token clear,
  killing the runner on reconnect with `4401`. No app-level heartbeat exists
  since commit `fa2845c`; CF's ~70s idle-close now lands in this path routinely.
- **Cluster 2 — stale client message state.** `messages-collection.ts` ignores
  `SyncedCollectionFrame.snapshot`, has no `lastSeq` watermark, and never
  requests a gap-triggered snapshot. `broadcastToClients` silently swallows
  send errors on closed sockets with no replay path. `messageSeq` is
  persisted only every 10 frames (non-atomic with broadcast). The result: when
  the WS flaps, deltas go missing and stay missing until the user hard-refreshes
  and the REST fallback (`GET /api/sessions/:id/messages`) re-hydrates from
  server truth.

The "idle while streaming, refresh reveals the full dump" symptom is the
**composition** of both clusters: Cluster 1 broadcasts premature idle AND
decorates a synthetic `result` event into the stream; Cluster 2 ensures any
real runner events that landed after that broadcast (before the `4401` kill)
stay stuck in DO SQLite / D1 and only surface on refresh.

## Scope

**Items researched (6, each by a parallel Explore agent):**

| # | Item | Outcome |
|---|------|---------|
| A | Derived-status fold (`useDerivedStatus`, `deriveDisplayStateFromStatus`) | `useDerivedStatus` does not exist — spec #37 retired message-fold path. Authoritative derivation is `deriveStatus(row, nowTs)` + `deriveDisplayStateFromStatus(status, wsReadyState)`. |
| B | Client seq/delta/snapshot protocol | **Spec #14 P1 partially unshipped.** Missing: `lastSeq` watermarking, `frame.snapshot` merge branch, gap-triggered `requestSnapshot` RPC. |
| C | SessionDO broadcast + status persistence | Silent-drop in `broadcastToClients`; non-atomic `messageSeq` persistence; fire-and-forget `syncStatusToD1`; unconditional-recovery regression (confirmed per prior doc). |
| D | ConnectionManager foreground reconnect + hydrate race | `open` fires per reconnect; `onOpen` sends `subscribe:messages` with cursor; no explicit `lastSeq` reset window. 5s `lastSeenTs` stale gate is wider than CF's idle-close cadence. |
| E | Status consumer audit | All consumers converge on `deriveStatus() → deriveDisplayStateFromStatus()` reading the same D1 row. No divergence-class bug. StatusBar pins `wsReadyState=1` (no flicker); sidebar/tabs pass real readyState. |
| F | Backgrounding / visibility (mobile + web) | `visibilitychange` does NOT close sockets; ConnectionManager only reconnects on `foreground`/`online`. Browser CPU throttling stalls delta application during background (delivery, not transport). Runner↔DO WS survives client tab eviction. |

## Findings

### A. Derived-status fold (AUTH: `deriveStatus` + `deriveDisplayStateFromStatus`)

- `deriveDisplayStateFromStatus(status, wsReadyState)` in
  `apps/orchestrator/src/lib/display-state.ts:95-123` is pure; returns
  `DISCONNECTED` whenever `wsReadyState !== 1`, else maps raw `SessionStatus`.
- `deriveStatus(row, nowTs)` in `apps/orchestrator/src/lib/derive-status.ts:71-87`
  applies a 45s TTL override ONLY to `status === 'running'` — if the row's
  `last_event_ts` is older than 45s, it coerces to `'idle'` locally. Does NOT
  consult WS state.
- Spec #37 (`apps/orchestrator/src/lib/display-state.ts:11-12`) explicitly
  retired the message-derived status path from spec #31. **CLAUDE.md still
  describes the old world — the relevant section is stale.**
- `useDerivedStatus` / `useDerivedGate` hooks no longer exist for status;
  `useDerivedGate` survives only for gate-dialog rendering (scans messages for
  `approval-requested` tool gates) and does not feed status.

### B. Client seq/delta/snapshot protocol (GAP)

`apps/orchestrator/src/db/messages-collection.ts:90-120`:

- Treats ALL `SyncedCollectionFrame` frames as linear deltas.
- Ignores the documented `frame.snapshot?: boolean` flag
  (`packages/shared-types/src/index.ts:758`). Compare to
  `apps/orchestrator/src/db/synced-collection.ts:122-189`, which correctly
  diff-merges (upsert known keys, implicit-delete unknowns).
- `use-coding-agent.ts:357-434` onMessage path has NO seq tracking, NO
  `lastSeq` watermark, NO gap detection, NO `requestSnapshot()` RPC trigger.
  The handler assumes frames arrive in order and always apply.
- **Consequence:** A dropped delta is never recovered. The streaming
  `partial_assistant` row sits with stale text until a hard refresh re-fetches
  via REST fallback (`GET /api/sessions/:id/messages`).

Spec #14 P1 explicitly required this; the spec's server-side snapshot-on-
reconnect was shipped (see `session-do.ts` cursor replay), the client-side
watermark + merge never was. `CLAUDE.md` description of spec #14 ("DO-pushed
snapshots … replaces the collection contents for that session and resets
`lastSeq`") describes an intended design, not the shipped code.

### C. SessionDO broadcast + status persistence

(Server-side findings — primary overlap with
`2026-04-22-silent-session-closures-post-ttl.md`, extended here.)

1. **Silent drop in `broadcastToClients`** —
   `apps/orchestrator/src/agents/session-do.ts:1237-1242`:
   iterates active WS, calls `.send(data)`, wraps each in
   `try { … } catch { /* Connection already closed */ }`. No retry, no buffer,
   no queue-for-reconnect. If the client WS is CLOSING/CLOSED at the instant a
   frame is emitted, the frame is lost. Cursor replay on reconnect can cover
   *persisted* frames; nothing covers the gap between "broadcast attempt" and
   "SQLite persist."
2. **Non-atomic `messageSeq`** — `session-do.ts:1499-1506`:
   `messageSeq` is incremented in-memory per broadcast but persisted to SQLite
   only every 10 frames (`MESSAGE_SEQ_PERSIST_EVERY = 10`). The DO being
   evicted between increment and persist leaves the seq cursor behind — reorder
   detection relies on it.
3. **Fire-and-forget D1 status sync** — `session-do.ts:4078-4079` in the
   `result` handler: `syncStatusToD1()` + `syncResultToD1()` are called as
   `void` with no await. An error or latency spike on D1 means clients see
   stale `running` for longer than the runner's in-memory state is in that
   state, contributing to perceived drift.
4. **Eager unconditional recovery** — `session-do.ts:787-820` (regression from
   `fa2845c`). Full analysis in
   `2026-04-22-silent-session-closures-post-ttl.md` §2. Re-summarised here
   because it is the dominant cause of Cluster 1 in this defect.

### D. ConnectionManager reconnect

- `open` fires on every reconnect (not just first) —
  `lib/connection-manager/adapters/partysocket-adapter.ts:44-45`.
- `onOpen` in `use-coding-agent.ts:540-554` calls `connection.call('getMessages')`
  RPC, then sends `subscribe:messages` frame with `computeTailCursor(...)`.
- No `lastSeq` because (B) — cursor-based replay is the only resync.
- 5s `lastSeenTs` stale threshold (`manager.ts:83-85`) is WIDER than CF's ~70s
  idle-close cadence only in principle; in practice a CF-closed socket lands
  in state 3 (CLOSED), which triggers reconnect immediately via the `close`
  event, not the stale-gate path. The 5s gate is the TCP-zombie guard, not the
  normal close path.
- Random 0-500ms stagger on reconnect is unrelated to this bug.

### E. Status consumer audit

All status-reading UI reads the same D1 row and passes it through the same
two pure functions. **No divergence-class bug between consumers exists.** The
only surface difference: StatusBar pins `wsReadyState=1` (forced OPEN) to
prevent label flicker, while sidebar/tab bar pass real `wsReadyState` so they
*do* flip to "Reconnecting…" on brief WS close. This is intentional (cosmetic
separation between active-pane and peripheral UI).

Implication for the bug: the user's "says idle" surfaces on StatusBar mean the
server-authoritative `status` was actually `idle` or the 45s TTL predicate
tripped. It is NOT a wsReadyState flicker on StatusBar (which would render
"Reconnecting…" anyway, not "Idle").

### F. Backgrounding / visibility

- Tab backgrounding does NOT close the WS. `visibilitychange` emits `hidden`
  into `lifecycleEventSource`, but `manager.onLifecycleEvent` only acts on
  `foreground`/`online` (reconnect-if-stale) and `offline` (nothing). Confirmed
  `lib/connection-manager/manager.ts:64-86`.
- Browser throttles background-tab timers/JS but WS frames continue arriving
  into the receive queue; foreground flushes them without message loss at the
  transport layer.
- Runner↔DO WS is independent of client WS — a client-side suspension does not
  cause runner exit or DO idle transition by itself.
- Mobile (Capacitor) gets its own `App.appStateChange` foreground event which
  goes through the same manager — no platform-specific bug here. CLAUDE.md's
  "Capacitor WebView throttles" hypothesis is not exclusive to mobile.

## Hypothesis mapping (issue #69, 1-5)

| # | Hypothesis | Verdict | Notes |
|---|-----------|---------|-------|
| 1 | Gap/seq handling — snapshot clobbers in-flight `partial_assistant` | **PARTIALLY CONFIRMS** | The worse truth is: snapshot path isn't wired at all on client. No clobbering happens, but no recovery happens either. |
| 2 | ConnectionManager foreground reconnect race with hydrate | **REJECTS** for this bug's primary symptom; **UNCERTAIN** as contributing factor | Cursor-based; no `lastSeq` to drift. May still lose a frame if DO broadcast races the close (see C.1) but that's Cluster 2, not a CM bug. |
| 3 | Derived status treats `partial_assistant` tail as done | **REJECTS** | Spec #37 retired the message-fold path; derived status reads D1 row, not messages. |
| 4 | Capacitor WebView throttles | **REJECTS as sole cause** | User confirms web repro. Background throttling exists but doesn't close sockets or synthesize idle. |
| 5 | `SessionMeta` vs derived-status divergence | **REJECTS** | Unified on D1 row since spec #37. Consumer audit shows no disagreement class. |

## Real root causes (newly identified)

1. **Server: eager unconditional recovery (REGRESSION, spec #50 / fa2845c)** —
   dominant cause of "idle while streaming." Any CF idle-WS close during a
   quiet-but-alive runner phase triggers `recoverFromDroppedConnection()`,
   which broadcasts `status:'idle'` + synthesized `result`, clears
   `active_callback_token`, and kills the runner on its next re-dial with
   `4401`.
2. **Server: no keepalive (REGRESSION, spec #50)** — ensures cause #1 fires
   routinely, because no-traffic phases hit CF's ~70s idle-close.
3. **Client: `messages-collection.ts` missing snapshot-merge (SHIPPING GAP,
   pre-spec-#50)** — dominant cause of "refresh reveals full dump." Messages
   that did make it to DO SQLite but whose broadcast frame was dropped (see 4)
   or arrived out-of-order are never client-repaired until hard refresh +
   REST fallback.
4. **Server: silent-drop in `broadcastToClients`** — ensures cause #3 actually
   has frames to miss. Closed-WS send errors are swallowed; cursor replay only
   covers SQLite-persisted frames.
5. **Server: fire-and-forget D1 status sync** — cosmetic lag between DO
   in-memory state and D1 mirror; manifests as sidebar/tab-bar showing stale
   `running` or lagging `idle` transitions by hundreds of ms.
6. **Server: non-atomic `messageSeq` persistence** — worst-case data-loss
   window if the DO is evicted mid-window (rare; lower priority).

## Recommendations (ranked)

### P0 — highest impact, direct regression fix
1. **Restore skip-path in `maybeRecoverAfterGatewayDrop`** for
   `result.kind === 'state' && result.body.state === 'running'`: wait N
   seconds (15-30s) for the runner to re-dial before running recovery.
   Preserves spec #50's "don't stick in running forever" goal.
2. **Add WS-layer keepalive to `DialBackClient`** — 25s ping frame (either
   native WS ping or zero-byte JSON the DO drops on floor). MUST NOT be a
   `GatewayEvent` (would defeat `last_event_ts` semantics). Kills both
   Cluster-1 causes cleanly.

### P1 — ship the sync protocol that CLAUDE.md already documents as-if-shipped
3. **Implement `frame.snapshot` merge in `messages-collection.ts`** — port
   the `synced-collection.ts:122-189` pattern (upsert present keys,
   implicit-delete unknowns).
4. **Add `lastSeq` watermark + gap-triggered `requestSnapshot` RPC** — finish
   spec #14 P1's client-side contract; server snapshot path already exists.
5. **DO `broadcastToClients`: on send error, enqueue for cursor-replay**
   (trivial: the frame is already seq'd and in SQLite if we persisted first).

### P2 — consistency / polish
6. **Await `syncStatusToD1` on idle/terminal transitions** so sidebar doesn't
   briefly show stale `running` after `result`.
7. **Persist `messageSeq` atomically** with broadcast (or before send).
8. **`wsReadyState` hysteresis** in peripheral consumers (2-3s debounce on
   CLOSED) so sidebar/tabs don't flicker on brief reconnects.

### P3 — observability
9. **Tripwire log** when local TTL override fires while a WS is `OPEN` — a
   strong signal that the server *should* have sent an event within 45s and
   didn't.
10. **Update CLAUDE.md** to reflect spec #37 + spec #50 reality (message-fold
    retired, D1-mirrored status with TTL, heartbeat removed). The stale
    description directly led this research to spend effort on non-existent
    code paths.

## Open questions

- What's the exact close code CF emits on idle-close after
  `web_socket_auto_reply_to_close`? Need `wrangler tail` evidence before
  deciding whether specific codes should skip recovery entirely.
- Can we rely on CF's native WS ping/pong or do we need an app-frame? The
  compat-date pin on `2026-03-31` (commit `a9936fe`) suggests native ping may
  not be reliable on the current runtime.
- Is the P1 fix enough, or does the DO also need to stop unconditionally
  finalizing streaming parts in `recoverFromDroppedConnection` when the skip
  path fires? (Probably yes — don't truncate in-flight text if we're going to
  wait for re-dial.)

## Next steps

1. P1 interview — confirm priority/scope of fix with user.
2. P2 spec writing — a feature spec for the unified fix bundle, likely titled
   something like `"gh69-session-state-drift"`, with phases mapping 1:1 to the
   P0/P1/P2 recommendation groups above. Spec #50 is already merged so this
   is a follow-up/fix rather than a rewrite.
