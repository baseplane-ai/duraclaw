---
initiative: session-state-hibernation-drift
type: project
issue_type: bug
status: approved
priority: high
github_issue: 69
created: 2026-04-22
updated: 2026-04-23
phases:
  - id: p1
    name: "Persist lastEventTs through hibernation"
    tasks:
      - "Add last_event_ts column to session_meta SQLite table (new migration)"
      - "Write lastEventTs to session_meta on every bumpLastEventTs() call (cheap local write)"
      - "Restore lastEventTs from session_meta in hydrateMetaFromSql()"
      - "On wake, if status is running and runner WS is connected, immediately flush lastEventTs to D1"
    test_cases:
      - "Start a session, wait for streaming, verify session_meta.last_event_ts is non-zero in DO SQLite"
      - "Simulate hibernation (DO eviction) mid-stream, verify onStart rehydrates lastEventTs from SQLite"
      - "Verify client never sees TTL-stale idle flip during active streaming (watch derive-status output)"
      - "After 7 events (<10), simulate DO eviction — verify messageSeq matches last broadcast seq on wake (B4)"
      - "Verify client does not request unnecessary snapshots after DO wake (messageSeq continuity)"
  - id: p2
    name: "Piggyback D1 flush on watchdog alarm + reconnect flush"
    tasks:
      - "Add flushLastEventTsToD1() call at top of existing alarm() handler (piggyback on watchdog)"
      - "Keep setTimeout debounce as belt-and-suspenders fast-path (no removal)"
      - "In runner WS acceptance path (onConnectInner), add immediate flushLastEventTsToD1()"
    test_cases:
      - "Verify watchdog alarm flushes lastEventTs to D1 within 30s even after DO hibernation"
      - "Verify runner WS reconnect triggers immediate D1 lastEventTs flush (within 1s, not debounced)"
      - "Verify setTimeout debounce still fires within 10s when DO stays awake (belt-and-suspenders)"
  - id: p3
    name: "Client-side TTL hardening + observability"
    tasks:
      - "Add wsReadyState grace period: suppress TTL idle flip for 5s after WS close (reconnect window)"
      - "Add console.warn tripwire when deriveStatus flips running->idle with WS OPEN"
      - "Add lastEventTs to session debug panel (if exists) or StatusBar tooltip"
    test_cases:
      - "Verify no idle flash during normal WS reconnect cycle (background tab, network flap)"
      - "Verify tripwire fires in console when TTL override triggers with open WS (diagnostic for future)"
      - "Unit test: deriveDisplayStateFromStatus grace period — (a) WS closed <5s returns server status, (b) WS closed >5s returns DISCONNECTED, (c) WS reopened returns server status, (d) WS closed and never reconnects transitions to DISCONNECTED at exactly 5s"
      - "Manual mobile test: background app 30s, foreground, verify status stays running if stream is live"
---

# Bug: Session status drifts to idle while stream is still live

> GitHub Issue: [#69](https://github.com/baseplane-ai/duraclaw/issues/69)

## Summary

Session status UI flips to `idle` while the assistant is still streaming, or the stream appears to end early but a page refresh reveals the full assistant turn. Happens on both web and mobile. Root cause: `lastEventTs` (the runner-liveness signal) is in-memory only on the DO, never persisted to DO SQLite, so DO hibernation kills the debounce timer and leaves D1 with a stale timestamp. The client's 45s TTL predicate in `deriveStatus()` then flips `running` to `idle`.

## Reproduction Steps

**Environment:** Production + local dev, web (Chrome) + mobile (Capacitor Android shell)
**User/Context:** Any authenticated user with an active session

1. Start a session with a prompt that triggers a long-running response (multi-tool, reasoning-heavy)
2. Wait for streaming to begin (status shows "Running")
3. Either: (a) leave the tab/app idle for >45s during a quiet phase (long tool call, extended reasoning), or (b) background the tab/app briefly and foreground
4. Observe status flips to "Idle" while assistant output is still being produced on the server side

**Expected:** Status stays "Running" as long as the runner is producing events
**Actual:** Status flips to "Idle" after 45s of no `lastEventTs` D1 update, even though the runner is alive and the DO is receiving events

## Error Evidence

No error is thrown. The symptom is purely visual: `deriveStatus()` returns `'idle'` at `derive-status.ts:85` because `nowTs - row.lastEventTs > TTL_MS` (45s). On page refresh, the client requests a snapshot from the DO, which returns the full message history including all the turns that were "invisible" during the idle-display period.

## Impact

- **Severity:** High
- **Frequency:** Sometimes (correlates with long tool calls, reasoning phases, or tab backgrounding)
- **Affected users:** All users with active sessions
- **Workaround:** Page refresh recovers full state; no data loss, but UX is confusing and erodes trust in session liveness

## Root Cause

**File:** `apps/orchestrator/src/agents/session-do.ts:249-251`
**Function:** `bumpLastEventTs()` (L1919) + `flushLastEventTsToD1()` (L1935)
**Cause:** Three compounding issues:

### RC1: `lastEventTs` not persisted to DO SQLite

`lastEventTs` is a private in-memory field (L249). It is flushed to D1 via a 10s debounce timer (`setTimeout`, L1922-1925). But it is **never written to `session_meta` SQLite** — `META_COLUMN_MAP` (L138-158) does not include it. When the DO hibernates:

1. In-memory `lastEventTs` is evicted
2. The `setTimeout` debounce timer is destroyed
3. D1 retains the value from the last successful flush (potentially >45s stale)
4. On wake, `hydrateMetaFromSql()` (L1204) does NOT restore `lastEventTs` — it's not in `META_COLUMN_MAP`
5. `lastEventTs` resets to `0` (field initializer, L249)
6. The next `bumpLastEventTs()` call sets it to `Date.now()` and arms a new 10s debounce
7. During those 10s, D1 still has the stale value; client TTL predicate fires

### RC2: `setTimeout` debounce doesn't survive hibernation

The 10s debounce timer (L1922) is a `setTimeout`. CF Durable Objects destroy all timers on hibernation. Even if `lastEventTs` were persisted, the pending flush would be lost. The DO would wake, rehydrate `lastEventTs`, but the D1 column would remain stale until the next explicit flush or a new debounce cycle completes.

### RC3: `messageSeq` batched persistence (minor, secondary)

`messageSeq` is persisted every 10 events (`MESSAGE_SEQ_PERSIST_EVERY = 10`, L110, L1504). If the DO hibernates between persistence points, seq rewinds on wake. The client's `lastSeq` tracking detects this as a gap and requests a snapshot — which works correctly, but the snapshot arrives with the stale D1 `lastEventTs`, reinforcing the idle display.

## Feature Behaviors

### B1: Persist lastEventTs to DO SQLite on every bump

**Core:**
- **ID:** persist-last-event-ts
- **Trigger:** Any `GatewayEvent` received by the DO from the runner (calls `bumpLastEventTs()`)
- **Expected:** `lastEventTs` is written to `session_meta.last_event_ts` in DO SQLite synchronously (single UPDATE, cheap local I/O). The D1 debounce flush continues as-is for fan-out.
- **Verify:** After 20 streaming events, query DO SQLite: `SELECT last_event_ts FROM session_meta WHERE id = 1` — value is within 1s of `Date.now()`.
**Source:** `apps/orchestrator/src/agents/session-do.ts:1919` (`bumpLastEventTs`)

#### Data Layer
- New column: `session_meta.last_event_ts INTEGER DEFAULT 0` (migration v-next)
- Written by `bumpLastEventTs()` alongside the in-memory assignment
- Read by `hydrateMetaFromSql()` on wake

### B2: Rehydrate lastEventTs from DO SQLite on wake

**Core:**
- **ID:** rehydrate-last-event-ts
- **Trigger:** DO `onStart()` (called on every wake from hibernation or cold start)
- **Expected:** `hydrateMetaFromSql()` restores `this.lastEventTs` from `session_meta.last_event_ts`. The on-wake D1 flush is **best-effort**: `onStart()` fires before any `webSocketMessage()`, so `getGatewayConnectionId()` typically returns `null` at this point (the runner WS hasn't re-identified yet). The guaranteed flush path is the next `bumpLastEventTs()` call when the first post-wake `GatewayEvent` arrives — B1's immediate SQLite write + the debounce/watchdog flush ensure D1 catches up. If `getGatewayConnectionId()` does return a value (WS tags survive hibernation via `this.ctx.getWebSockets()`), flush immediately as an optimization.
- **Verify:** Simulate DO eviction mid-stream. On next runner event, verify `lastEventTs` is restored from SQLite (non-zero) and D1 is flushed within max(10s debounce, 30s watchdog) — not stuck at the pre-hibernation value.
**Source:** `apps/orchestrator/src/agents/session-do.ts:1204` (`hydrateMetaFromSql`), `apps/orchestrator/src/agents/session-do.ts:263` (`onStart`)

#### Data Layer
- Do NOT add `lastEventTs` to `META_COLUMN_MAP` — `META_COLUMN_MAP` feeds `SessionMeta` (which is `setState`'d and could leak to clients via the Agents SDK). `lastEventTs` is a private DO liveness signal, not session metadata.
- Handle separately in `hydrateMetaFromSql()`: after the `META_COLUMN_MAP` loop, read `row.last_event_ts` directly and assign to `this.lastEventTs` (the private field). This keeps the type system clean and avoids API contract leakage.

### B3: Piggyback D1 flush on existing watchdog alarm

**Core:**
- **ID:** alarm-flush-piggyback
- **Trigger:** The existing `alarm()` handler fires (every `WATCHDOG_INTERVAL_MS` = 30s, L1068/L1077)
- **Expected:** The existing `alarm()` handler already fires every 30s while the session is `running` or `waiting_gate` (L1077-1096, `scheduleWatchdog` at L1067). Instead of scheduling a **separate** alarm for the D1 flush (CF DOs support only one alarm at a time — `setAlarm` silently overwrites the pending alarm), **piggyback** the flush onto the existing watchdog: add `void this.flushLastEventTsToD1()` at the top of `alarm()` before the staleness check. The `setTimeout` debounce (L1922-1925) is kept as a belt-and-suspenders fast-path for when the DO is awake — it still fires within 10s if the DO stays alive, but the watchdog alarm guarantees a flush within 30s even after hibernation. Remove the `lastEventFlushAlarmArmed` flag from the B1 code hint — it's not needed since we reuse the watchdog alarm.
- **Verify:** Start streaming. Kill the `setTimeout` debounce artificially (or wait for DO hibernation to destroy it). Verify the watchdog alarm fires within 30s and flushes `lastEventTs` to D1. Client TTL (45s) has 15s of headroom beyond the 30s watchdog interval.
**Source:** `apps/orchestrator/src/agents/session-do.ts:1067-1096` (existing `scheduleWatchdog` + `alarm()`)

#### Alarm Multiplexing Contract
- **No new alarm scheduling.** The watchdog alarm is already armed on session start and re-armed on every `alarm()` invocation (L1095). The D1 flush piggybacks as a side-effect.
- **No discriminator needed.** Since we're adding a line to the existing handler, not scheduling a competing alarm, the single-alarm constraint is not violated.
- **`setTimeout` debounce preserved as fast-path.** When the DO is awake, the 10s `setTimeout` fires faster than the 30s watchdog. When the DO hibernates, `setTimeout` is destroyed but the alarm survives. Both paths call the same `flushLastEventTsToD1()` which is idempotent (clears the timer on entry, no-ops if `lastEventTs === 0`).
- **Timing budget:** With B1 persisting `lastEventTs` to DO SQLite on every bump, the worst-case D1 staleness after hibernation is `WATCHDOG_INTERVAL_MS` (30s). This is safely within `TTL_MS` (45s), leaving 15s of headroom.

### B4: Persist messageSeq on every broadcast

**Core:**
- **ID:** persist-seq-every-broadcast
- **Trigger:** `broadcastMessages()` increments `this.messageSeq`
- **Expected:** Write `messageSeq` to `session_meta.message_seq` on every broadcast, not every 10th. The batching saved ~9 SQLite writes per 10 events but introduced a hibernation-rewind risk. At 1 write per event the cost is negligible (DO SQLite is local, sub-ms).
- **Verify:** After 7 events (less than the old batch size of 10), simulate DO eviction. On wake, verify `messageSeq` matches the last broadcast seq, not `messageSeq - (messageSeq % 10)`.
**Source:** `apps/orchestrator/src/agents/session-do.ts:1504-1506` (current batched persist)

#### Data Layer
- Remove `MESSAGE_SEQ_PERSIST_EVERY` constant (L110)
- Change persist condition from `if (this.messageSeq % MESSAGE_SEQ_PERSIST_EVERY === 0)` to unconditional

### B5: Client wsReadyState grace period for TTL predicate

**Core:**
- **ID:** ws-grace-period
- **Trigger:** Client WS closes (readyState transitions away from OPEN)
- **Expected:** `deriveDisplayStateFromStatus()` suppresses the `DISCONNECTED` return for 5s after WS close, allowing the ConnectionManager reconnect cycle to complete before the UI flashes "Disconnected". After 5s without reconnect, show disconnected normally.
- **Verify:** Background a tab for 2s, foreground. Status should NOT flash "Disconnected" → "Running" — it should stay "Running" throughout if the reconnect completes within 5s.
**Source:** `apps/orchestrator/src/lib/display-state.ts:100` (current `wsReadyState !== 1` check)

#### UI Layer
- Track `wsCloseTs` in `sessionLocalCollection` alongside `wsReadyState`
- **Lifecycle rules for `wsCloseTs`:**
  - Set to `Date.now()` when `readyState` transitions from OPEN to any non-OPEN state
  - Cleared to `null` when `readyState` transitions back to OPEN (successful reconnect)
  - On a second disconnect within the grace window (close → reconnect → close again within 5s), `wsCloseTs` resets to the new close time — grace period restarts
  - `wsCloseTs` is transient (in-memory only via `sessionLocalCollection`), not persisted — page refresh clears it, which is correct (fresh page load should show current state, not a grace period from a prior session)
- `deriveDisplayStateFromStatus` checks: if `wsReadyState !== OPEN` AND `wsCloseTs != null` AND `(now - wsCloseTs) < WS_GRACE_MS`, return the server-status-derived state instead of `DISCONNECTED`
- After `WS_GRACE_MS` (5s), fall through to existing `DISCONNECTED` path
- **No render loop risk:** `wsCloseTs` is written in the same `useEffect` that writes `wsReadyState` — single state update, no cascading dependency
- **SPA navigation scope:** `wsCloseTs` is keyed by session ID in `sessionLocalCollection`. Navigating away from a session view and back reads the existing entry — if the WS reconnected during navigation, `wsCloseTs` is already `null` (cleared on OPEN transition). No stale grace period on re-entry.
- **Unit test:** add a vitest for `deriveDisplayStateFromStatus` covering: (a) WS closed <5s ago → returns server status, not DISCONNECTED; (b) WS closed >5s ago → returns DISCONNECTED; (c) WS closed then reopened (wsCloseTs=null) → returns server status. Pure function, trivial to test.

### B6: Diagnostic tripwire for TTL idle flip with open WS

**Core:**
- **ID:** ttl-tripwire
- **Trigger:** `deriveStatus()` returns `'idle'` for a row with `status === 'running'` (TTL override fired)
- **Expected:** At the **call site** (not inside `deriveStatus` itself — `deriveStatus` is a pure function and must stay free of transport concerns), check: if the returned status is `'idle'` AND the input `row.status` was `'running'` (i.e., TTL override fired) AND `wsReadyState === WebSocket.OPEN`, emit `console.warn('[derive-status] TTL idle override fired with WS OPEN — lastEventTs:', row.lastEventTs, 'age:', nowTs - (row.lastEventTs ?? 0), 'ms')`. This is a diagnostic signal that the DO's D1 flush is lagging.
- **Verify:** In dev, set `TTL_MS` to 5s temporarily. Start a session, observe the console.warn fires after 5s of streaming with open WS. Reset `TTL_MS` to 45s.
**Source:** Place the tripwire at `apps/orchestrator/src/components/status-bar.tsx:244` — this is the primary active-session status consumer and has access to `wsReadyState` via the coding-agent hook. Secondary call sites (`tab-bar.tsx:374`, `nav-sessions.tsx:425/679/818/881`) can add the tripwire later if needed. `deriveStatus` signature at `apps/orchestrator/src/lib/derive-status.ts:71` is unchanged — stays pure.

#### UI Layer
- The warn is console-only, no UI surface. Tagged `[derive-status]` for logcat filtering on mobile (`Capacitor/Console:V`).
- `deriveStatus()` remains pure: `(row, nowTs) => SessionStatus`. No `wsReadyState` parameter added.

### B7: Flush lastEventTs on runner WS reconnect

**Core:**
- **ID:** flush-on-runner-reconnect
- **Trigger:** Runner's DialBackClient reconnects to the DO after a transient WS drop (close + new `webSocketMessage` on a fresh conn with valid token)
- **Expected:** On accepting a reconnected runner WS, the DO immediately calls `flushLastEventTsToD1()` (bypass debounce). This ensures D1 reflects liveness as soon as the runner re-establishes contact.
- **Verify:** Kill the runner WS (e.g., iptables drop for 5s), let it reconnect. Verify D1 `lastEventTs` is refreshed within 1s of reconnect, not after the next debounce cycle.
**Source:** `apps/orchestrator/src/agents/session-do.ts` (runner WS acceptance path, `onConnectInner`)

## Non-Goals

- **Replacing the TTL predicate with a different mechanism.** The spec #50 TTL approach is sound for detecting genuinely stuck sessions. The bug is that `lastEventTs` goes stale due to hibernation, not that the predicate logic is wrong.
- **Changing the 45s TTL value.** Increasing it would mask the bug; decreasing it would make it worse. The fix is to keep `lastEventTs` fresh.
- **Adding a client-side heartbeat to the DO.** The runner already produces events; the problem is the DO failing to persist + flush the liveness signal, not a lack of signal.
- **Modifying the runner or DialBackClient.** The runner side works correctly. The bug is entirely in the DO's persistence layer and the client's display derivation.
- **Rearchitecting the status flow.** Spec #37's D1-mirrored status with spec #50's TTL override is the right architecture. This spec fixes the persistence gap that causes the TTL to fire incorrectly.

## Write Frequency Analysis

B1 adds 1 SQLite write per `GatewayEvent` (`UPDATE session_meta SET last_event_ts = ? WHERE id = 1`). B4 changes `messageSeq` persist from 1-per-10 to 1-per-1. Combined, every event triggers 2 SQLite writes instead of ~0.1.

**Expected event rates:** A typical streaming session produces 5-15 `GatewayEvent`s/sec during active streaming (mostly `partial_assistant` text deltas). Bursts during rapid tool-use can hit 30-50/sec briefly. This means 10-30 SQLite writes/sec sustained, 60-100/sec burst.

**DO SQLite throughput:** CF DO SQLite handles ~10K simple writes/sec on a single-row table (benchmarked by CF). Our writes are single-row UPDATEs with no indexes — well within budget even at burst rates. The writes are local (no network), synchronous, and ~0.1ms each.

**Fallback:** If profiling reveals latency impact, B1 and B4 can be independently softened: B1 can batch to every-3rd event (still <10s between persists), B4 can batch to every-3 (still <3-event rewind risk vs. current 10). No feature flag needed — the batching constant is a single-line change.

## Rollback Strategy

All changes are additive and backward-compatible:
- **Migration** (`ALTER TABLE ADD COLUMN last_event_ts`): additive, no rollback needed. Column is ignored by pre-fix code.
- **B1 SQLite writes**: removing the `UPDATE` line in `bumpLastEventTs()` reverts to pre-fix behavior. One-line revert.
- **B3 alarm piggyback**: removing the `flushLastEventTsToD1()` line in `alarm()` reverts. One-line revert.
- **B4 unconditional persist**: restoring the `if (messageSeq % 10 === 0)` guard reverts. One-line revert.
- **B5 grace period**: removing the `wsCloseTs` check reverts to immediate DISCONNECTED. No data dependency.

No feature flags. The changes are small enough that a targeted revert of any single behavior is a one-line diff. Deploy to production directly — the fix is lower-risk than the bug it addresses.

## Implementation Phases

### Phase 1: Persist lastEventTs through hibernation (B1, B2, B4)

Core fix. Adds `last_event_ts` to `session_meta`, writes it on every bump, restores it on wake, persists `messageSeq` on every broadcast.

**Tasks:**
1. Add migration: `ALTER TABLE session_meta ADD COLUMN last_event_ts INTEGER DEFAULT 0`
2. In `bumpLastEventTs()`, add: `try { this.sql\`UPDATE session_meta SET last_event_ts = ${this.lastEventTs} WHERE id = 1\` } catch (err) { console.error(...) }` (fire-and-forget, never crash event pipeline)
3. In `hydrateMetaFromSql()`: after the `META_COLUMN_MAP` loop, read `row.last_event_ts` separately and assign to `this.lastEventTs`. Do NOT add to `META_COLUMN_MAP` — see B2 Data Layer. Post-hydrate: if `this.state.status === 'running'` AND `this.getGatewayConnectionId()` is non-null, call `flushLastEventTsToD1()` (best-effort — runner WS may not have re-identified yet, see B2)
4. Remove `MESSAGE_SEQ_PERSIST_EVERY` gating; persist `messageSeq` unconditionally in `broadcastMessages()` (same try/catch pattern)

**Estimated effort:** 1-2 hours

### Phase 2: Piggyback D1 flush on watchdog alarm + reconnect flush (B3, B7)

Adds `flushLastEventTsToD1()` to the existing `alarm()` handler (watchdog, 30s interval). Keeps `setTimeout` debounce as fast-path. Adds immediate flush on runner WS reconnect.

**Tasks:**
1. Add `void this.flushLastEventTsToD1()` at top of existing `alarm()` handler (L1077), before the staleness check. No new alarm scheduling — piggybacks on `scheduleWatchdog()` (L1067-1068).
2. Keep the `setTimeout` debounce in `bumpLastEventTs()` as-is — it provides faster D1 updates (10s) when the DO is awake. The watchdog alarm (30s) is the hibernation-safe backstop.
3. In runner WS acceptance path (`onConnectInner` or equivalent), add `void this.flushLastEventTsToD1()` to immediately refresh D1 on runner reconnect.

**Estimated effort:** 1 hour

### Phase 3: Client-side hardening + observability (B5, B6)

Polish. Suppress WS-close idle flash, add diagnostic tripwire.

**Tasks:**
1. Track `wsCloseTs` in `sessionLocalCollection` when `readyState` transitions from OPEN
2. Update `deriveDisplayStateFromStatus()` to suppress DISCONNECTED for 5s grace period
3. Add `console.warn` tripwire in `deriveStatus()` when TTL override fires (needs WS state passed in or checked at call site)
4. Manual test on mobile: background app, foreground, verify no idle/disconnected flash

**Estimated effort:** 1-2 hours

## Verification Plan

### VP1: Core fix — lastEventTs survives hibernation

```bash
# 1. Deploy to local dev
scripts/verify/dev-up.sh

# 2. Start a session with a long prompt
# (use the UI or curl to /api/sessions to create + send)

# 3. While streaming, check DO SQLite has lastEventTs
# (inspect via wrangler d1 or add a debug endpoint)
# Expected: session_meta.last_event_ts > 0, within 1s of Date.now()

# 4. Wait for DO to hibernate (stop sending events for 30s+)
# Then send a follow-up message

# 5. Verify lastEventTs was restored on wake:
# - No console errors about hydrateMetaFromSql
# - D1 lastEventTs column is refreshed (check via /api/sessions/:id)
# - Client status stays "Running", never flips to "Idle" during active stream

# 6. Verify messageSeq continuity:
# - After DO wake, client does NOT request a snapshot (no seq gap)
# - Or if it does, the snapshot contains correct messages and seq resumes
```

### VP2: No idle flash on tab background/foreground

```bash
# 1. Open session in browser, start streaming
scripts/axi open http://localhost:$VERIFY_ORCH_PORT/sessions/<id>

# 2. Background the tab (switch to another tab) for 10s
# 3. Foreground the tab
# 4. Check status never showed "Idle" or "Disconnected"
scripts/axi eval 'document.querySelector("[data-testid=status-bar]")?.textContent'
# Expected: "Running" (or current streaming indicator), not "Idle"
```

### VP3: Mobile background/foreground

```bash
export PATH="/home/ubuntu/Android/sdk/platform-tools:$PATH"
# 1. Sideload latest APK
adb -s $DEVICE_IP:<PORT> install -r apps/mobile/android/app/build/outputs/apk/release/app-release-signed.apk

# 2. Start a session, begin streaming
# 3. Press home button (background the app)
# 4. Wait 10s, reopen the app

# 5. Tail logcat for status transitions
adb -s $DEVICE_IP:<PORT> logcat -c
adb -s $DEVICE_IP:<PORT> logcat "*:S" Capacitor/Console:V Capacitor:V chromium:V
# Expected: no [derive-status] TTL idle override warnings
# Expected: [cm] reconnect events followed by stable Running status
```

### VP4: Tripwire diagnostic fires correctly

```bash
# 1. In dev, temporarily set TTL_MS = 5000 in derive-status.ts
# 2. Start a session, begin streaming
# 3. Watch browser console
# Expected: after 5s of streaming, console.warn fires:
#   [derive-status] TTL idle override fired with WS OPEN — lastEventTs: <N> age: <N>ms
# 4. Revert TTL_MS to 45000
```

## Implementation Hints

### Key Imports
- `this.ctx.storage.sql` — DO SQLite (already used throughout session-do.ts)
- `this.ctx.storage.setAlarm(Date)` / `alarm()` handler — CF DO alarm API
- `sessionLocalCollection` — `apps/orchestrator/src/db/session-local-collection.ts`
- `deriveStatus` — `apps/orchestrator/src/lib/derive-status.ts`
- `deriveDisplayStateFromStatus` — `apps/orchestrator/src/lib/display-state.ts`

### Code Patterns

**SQLite write in bumpLastEventTs (B1) — keep existing setTimeout debounce:**
```typescript
private bumpLastEventTs() {
  this.lastEventTs = Date.now()
  // B1: persist to DO SQLite (survives hibernation, ~0.1ms)
  // Fire-and-forget — never crash the event pipeline for a liveness signal
  try {
    this.sql`UPDATE session_meta SET last_event_ts = ${this.lastEventTs} WHERE id = 1`
  } catch (err) {
    console.error(`[SessionDO:${this.ctx.id}] Failed to persist last_event_ts:`, err)
  }
  // Existing setTimeout debounce for fast D1 flush (10s) — unchanged
  if (this.lastEventFlushTimer) return
  this.lastEventFlushTimer = setTimeout(() => {
    this.lastEventFlushTimer = null
    void this.flushLastEventTsToD1()
  }, this.LAST_EVENT_FLUSH_DEBOUNCE_MS)
}
```

**Piggyback in existing alarm() handler (B3):**
```typescript
async alarm() {
  // B3: flush lastEventTs to D1 on every watchdog tick (survives hibernation)
  void this.flushLastEventTsToD1()

  // Existing watchdog logic unchanged below...
  if (this.state.status !== 'running' && this.state.status !== 'waiting_gate') {
    return
  }
  // ... staleness check, recovery, scheduleWatchdog ...
}
```

**Rehydrate in hydrateMetaFromSql (B2):**
```typescript
// After the META_COLUMN_MAP loop restores this.state:
if (typeof row.last_event_ts === 'number' && row.last_event_ts > 0) {
  this.lastEventTs = row.last_event_ts
}
// Flush to D1 on wake if running with a connected runner
if (this.state.status === 'running' && this.getGatewayConnectionId()) {
  void this.flushLastEventTsToD1()
}
```

**Grace period in deriveDisplayStateFromStatus (B5):**
```typescript
const WS_GRACE_MS = 5_000
if (wsReadyState !== WebSocket.OPEN) {
  if (wsCloseTs && (Date.now() - wsCloseTs) < WS_GRACE_MS) {
    // Suppress DISCONNECTED during reconnect window — show server status
  } else {
    return DISPLAY_STATES.DISCONNECTED
  }
}
```

### Gotchas

1. **DO `alarm()` is already in use** — the SessionDO uses `alarm()` for a 30s watchdog (`scheduleWatchdog` at L1067, handler at L1077). CF DOs support only one alarm at a time. B3 **piggybacks** on this existing alarm instead of scheduling a competing one. Do NOT call `setAlarm` for the D1 flush — just add the flush call inside the existing `alarm()` handler.
2. **`bumpLastEventTs()` is called on every GatewayEvent** — the SQLite write must be fast. `UPDATE session_meta SET last_event_ts = ? WHERE id = 1` is a single-row update on a table with exactly one row — sub-ms on DO SQLite. **Error handling:** wrap the SQLite write in try/catch — if it throws (disk pressure, table missing during migration rollout), log `console.error` and continue. The write is fire-and-forget; a failed persist means `lastEventTs` reverts to 0 on next hibernation wake, which is the same behavior as pre-fix. Never let a liveness-signal write crash the event pipeline. Same applies to B4's `messageSeq` persist.
3. **`lastEventTs` is NOT a `SessionMeta` field** — it's a private DO instance field. Do NOT add it to `META_COLUMN_MAP` (which feeds `SessionMeta` / `setState`). Handle it separately in `hydrateMetaFromSql()` after the MAP loop: read `row.last_event_ts` directly and assign to `this.lastEventTs`. This keeps the type system clean and prevents API leakage.
4. **`messageSeq` unconditional persist** doubles SQLite writes per broadcast from ~1/10 to 1/1. Profile under load — if problematic, batch at 2 or 3 instead of 10.
5. **`wsCloseTs` for B5** needs to be written to `sessionLocalCollection` from the same effect that writes `wsReadyState` in `use-coding-agent.ts`. Check the effect dependencies don't cause render loops.

### Reference Docs
- [CF DO Hibernation API](https://developers.cloudflare.com/durable-objects/api/hibernatable-websockets/) — `acceptWebSocket`, `getWebSockets`, alarm survival semantics
- [CF DO Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/) — `setAlarm`, `deleteAlarm`, single-alarm constraint
- Spec #50 (`planning/specs/50-status-ttl.md`) — TTL predicate design rationale
- Spec #37 (`planning/specs/37-session-state-collapse.md`) — D1-mirrored status architecture
- Spec #31 (`planning/specs/31-unified-sync-channel.md`) — original message-derived status (now retired)
