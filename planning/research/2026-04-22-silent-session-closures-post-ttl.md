# Silent session closures after GH#50 TTL + heartbeat removal

**Date:** 2026-04-22
**Classification:** Feasibility / regression root-cause research (feature-research flavour)
**Driver:** User report — "silent session closures we weren't getting before these changes"
**Scope:** Runner / gateway / DO paths that can terminate a live session OR make
it appear terminated to the client, with focus on what changed in the last
~5 days.

## TL;DR

The regression is almost certainly one of two interacting changes in
commit **`fa2845c feat(status): derive session status from liveness TTL (#50)`**:

1. **`maybeRecoverAfterGatewayDrop` lost its "runner still alive" skip-trap-door.**
   ANY gateway-WS close on a `running`/`waiting_gate` session now runs
   `recoverFromDroppedConnection()` unconditionally. That path **clears
   `active_callback_token`** and sets status → `idle`. Any DialBackClient
   reconnect that arrives afterward is rejected with close `4401 invalid_token`,
   which the runner treats as terminal (`onTerminate('invalid_token')` →
   `process.exit`). **Transient WS drops are no longer survivable.**

2. **Application-level heartbeat (`startHeartbeat` + `heartbeat` GatewayEvent)
   was deleted.** With no WS-level ping/pong in `DialBackClient` either, a
   quiet session (long tool call, long reasoning block, waiting on
   `queue.waitForNext()`) has zero wire traffic. CF Workers' idle-WS behavior
   (plus any hibernation path) is now the sole gate on how long the socket
   stays up. Every idle-timeout close now triggers pathway #1 and kills the
   runner. The prod-observed "~70s flap" cited in the recent
   `web_socket_auto_reply_to_close` fix matches this cadence.

The user-visible symptom is **silent** because:
- `recoverFromDroppedConnection` broadcasts a synthetic `result` event
  (`"Connection lost — session idle"`) — no error status, no alert modal.
- The runner exits cleanly on `4401` (no crash, no error event).
- Client TTL predicate (`deriveStatus`) never gets a chance to distinguish
  "running but quiet" from "dead" because the DO has already flipped the row
  to `idle` server-side.

## 1 · Changes in scope (git log, last ~5 days)

| SHA | Date | Title | Relevance |
|-----|------|-------|-----------|
| **`fa2845c`** | 04-22 | feat(status): derive session status from liveness TTL (#50) | **Primary suspect** — see §2 |
| `9f02cc8` | 04-21 | fix(session): stop button no longer traps sessions in permanent error | Minor — runner now sets `meta.state='aborted'` and suppresses `error` events post-interrupt. Makes Stop "silent" in a *good* way; unrelated to closures during active work. |
| `fc53a4a` | 04-20 | feat(force-stop): gateway kill endpoint | New SIGTERM/SIGKILL path. Only triggered by explicit user force-stop — not implicated in silent closures. |
| `0aeb46a` | 04-22 | fix(session-do): flush idle→running status to D1 on new-turn paths | Fixes a sticky-status bug, not a longevity regression. |
| `fc99ec9` | 04-22 | refactor(cron): drop gateway-sessions sync; keep worktree stale GC | Reduced cron scope — less likely to incorrectly reap, not more. |
| `a9936fe` | 04-22 | fix(ws): opt into `web_socket_auto_reply_to_close` flag | **Corroborating evidence** — commit message explicitly cites "~70s Gateway WS flap in prod, hundreds of closes/hour with zero clean closes." Means CF was already dropping WS at ~70s and leaving them in CLOSING. Post-fix the drops are cleaner but still drops. |
| `8eb882a` | 04-22 | fix(cron): stop bumping last_activity to now when gateway reports null | Tangential — affects cron `last_activity` bookkeeping only, not runner WS. |
| `e46cfe2` | 04-21 | debug(session-do): structured onConnect/onClose logs for GH#49 | Observability only. Will help triage this regression — run `wrangler tail` and grep for `[SessionDO][conn] close`. |
| `82842d2` | 04-21 | fix(mobile): don't reconnect OPEN sockets on foreground/online | Mobile-only. Unrelated. |

## 2 · Pathway #1 — unconditional recovery clears callback token

### What the commit changed

`apps/orchestrator/src/agents/session-do.ts:787-820`
(`maybeRecoverAfterGatewayDrop`) used to have a skip-trap-door:

```diff
- if (result.kind === 'state' && result.body.state === 'running') {
-   // runner says it's still live — wait for re-dial, don't finalize
-   return
- }
+ if (result.kind === 'state') {
+   // GH#50 B6: trust the client TTL predicate … run recovery unconditionally
+   await this.recoverFromDroppedConnection()
+   return
+ }
```

All three branches (`state`, `not_found`, `unreachable`) now call
`recoverFromDroppedConnection()`.

### What recovery does

`apps/orchestrator/src/agents/session-do.ts:976-1018`:

```ts
this.updateState({
  status: 'idle',
  gate: null,
  error: 'Gateway connection lost — session stopped. You can send a new message to resume.',
  active_callback_token: undefined,   // ← KILLS the runner's next reconnect
})
```

…plus a broadcast of a synthetic `result` event carrying the text
`"Connection lost — session idle"`.

### Why this kills the runner

`packages/shared-transport/src/dial-back-client.ts:157-173` — `4401`/`4410`/`4411`
are terminal close codes. `DialBackClient` sets `stopped = true` and fires
`onTerminate`. `packages/session-runner/src/main.ts:362-366` catches that and
aborts the SDK controller → the process exits.

`active_callback_token: undefined` guarantees the **next** reconnect handshake
fails auth → DO closes with `4401` → runner exits. The token mismatch is not
logged as an error; the runner logs `[dial-back-client] connection dropped
… code=4401` and exits silently.

### Prior behaviour

Before `fa2845c`, the trap door returned early without touching
`active_callback_token`. A transient WS flap would:

1. Gateway connection close fires DO `onClose`.
2. DO probes `GET /sessions/:id/status` → gateway reports `state: 'running'`.
3. DO returns early (skip recovery).
4. Runner's DialBackClient reconnects within the 1s/3s/9s backoff — token
   still valid — DO accepts → session resumes.

Now step (3) is gone, step (4) auths against a freshly-cleared token and
dies.

## 3 · Pathway #2 — no more app-level keepalive

### What was deleted

Per the `fa2845c` commit message, the following were removed:

- `HEARTBEAT_INTERVAL_MS` constant
- `startHeartbeat()` in session-runner
- `session_state_changed` emission in session-runner
- `HeartbeatEvent` + `SessionStateChangedEvent` from
  `packages/shared-types/src/index.ts` GatewayEvent union
- `case 'heartbeat': break` in the DO event dispatcher
- The `if (result.body.state === 'running') return` skip trap door (see §2)

The commit message argues "the TTL predicate subsumes heartbeat's keep-alive
role." That's true for the **client-side status render** — the client no longer
needs a periodic event to know the row is stale. It is **not** true for keeping
the underlying WS from being closed by CF.

### Absence of WS-level keepalive

`packages/shared-transport/src/dial-back-client.ts` (entire file, 237 lines) has:

- No ping/pong frame handling.
- No periodic `ws.send` of any kind.
- No `health` timer beyond `STABLE_THRESHOLD = 10_000` which only resets
  `attempt = 0` after a successful open stays alive for 10s (used for backoff
  reset, not keepalive).

`BufferedChannel` also has no keepalive — it's a pure ring buffer.

So during any of these states:

- SDK `query()` doing an extended-thinking block
- SDK running a long tool call (`Bash`, `WebFetch`, etc.) with no interim
  events
- Runner blocked on `queue.waitForNext()` between turns

…zero bytes flow over the DO↔runner WS. The only thing that was previously
ticking was the deleted heartbeat.

### Interaction with CF idle-close

Commit `a9936fe` opts into `web_socket_auto_reply_to_close`, with the commit
message noting "~70s Gateway WS flap in prod" pre-fix. That strongly implies
CF (or an intermediary) is closing the WS around 70 seconds of inactivity.
Post-fix the close handshake is cleaner but the underlying close still
happens.

Combined with §2, any ≥70s quiet period during a live session now:

1. CF closes WS (code typically 1006 pre-flag, 1000/cleaner post-flag).
2. DO `onClose` fires → `maybeRecoverAfterGatewayDrop` → recovery.
3. Recovery clears token, broadcasts "Connection lost — session idle".
4. Runner dials back → 4401 → exits.

## 4 · Why "silent"

- The recovery path emits a **result** event, not an **error** event. Result
  events don't trigger the error UI chrome.
- Status transitions cleanly to `idle`, which the UI renders as a normal
  stop — composer is re-enabled, no alert.
- Runner exits with `process.exit(0)`/`(1)` quickly via the abort path; no
  unhandled exception to surface.
- `9f02cc8` explicitly removed the `'error'` status variant, so even paths
  that previously surfaced as `status=error` now surface as `status=idle`.
  Any mid-turn SDK throw post-interrupt is now indistinguishable from "user
  clicked stop".

## 5 · Other contributing factors (lesser, but worth noting)

### 5a · TTL=45s and useNow 10s tick

`apps/orchestrator/src/lib/derive-status.ts:40` — `TTL_MS = 45_000`.
`apps/orchestrator/src/lib/use-now.tsx:18` — 10s shared tick.

This is a client-side *display* override only — it flips `status='running'`
to `'idle'` when the row is >45s stale. It does NOT close any connection.
But because the TTL is 45s and CF idle-close is ~70s, the client can flip
to "idle" visually up to ~25s before the server actually runs recovery.
When recovery then broadcasts, the status was already showing idle — so
there's no visual "running → error → idle" transition to alert the user.
Everything looks smooth. Silent.

### 5b · `recoverFromDroppedConnection` finalises streaming parts (l. 985-993)

Any in-flight streaming assistant part is finalised at recovery time. This
means the partially-streamed text is preserved — good — but also means a
long reasoning block that was mid-stream when CF closed the WS is snapshotted
at whatever text had landed, and the SDK `query` is terminated. No chance to
resume mid-reasoning.

### 5c · Gateway reaper is NOT implicated

`packages/agent-gateway/src/reaper.ts:8` — `DEFAULT_STALE_THRESHOLD_MS = 30 * 60_000`
(30 min). Reaper reads `meta.last_activity_ts` from `${id}.meta.json`, which
the runner updates every 10s (`META_INTERVAL_MS`). Unchanged in recent commits.
Reaper won't touch a runner that's actively ticking its meta file.

### 5d · Runner's own meta-failure watchdog

`packages/session-runner/src/main.ts:377-384` — 5 consecutive meta-write
failures abort. This fires only on tmpfs / permission issues. Not implicated.

### 5e · DialBackClient post-connect cap

`dial-back-client.ts:39` — `MAX_POST_CONNECT_ATTEMPTS = 20`. After 20 back-to-back
reconnect failures with no 10s-stable window between them, the runner gives
up with `onTerminate('reconnect_exhausted')`. In the §2 scenario the FIRST
reconnect after recovery hits `4401` (terminal) before reaching the cap, so
this isn't the trigger — but if `4401` weren't terminal, 20 failed reconnects
at up to 30s each is 10 min of retry before give-up.

## 6 · Hypothesis ranking

| # | Hypothesis | Confidence | Evidence | Fix sketch |
|---|-----------|-----------|----------|------------|
| **H1** | Eager recovery clears `active_callback_token`, killing legitimate reconnects after transient CF WS drops | **High** | Code diff at session-do.ts:787-820; absence of old skip path; runner terminal on 4401 | Restore skip-path keyed on runner liveness OR keep token alive through recovery; have recovery only fire after a grace window (e.g. 15s) with no re-dial. |
| **H2** | No app-level heartbeat + no WS ping/pong means any quiet >70s window triggers CF idle-close, cascading into H1 | **High** | dial-back-client.ts has no keepalive; `a9936fe` commit msg cites 70s flap; deleted `startHeartbeat` in fa2845c | Add a 20–30s ping frame at the `DialBackClient` layer (cheap, doesn't pollute event stream) OR restore a minimal heartbeat event that doesn't bump TTL. |
| H3 | `web_socket_auto_reply_to_close` side-effect drops more sockets | Low | Opt-in flag, commit claims it *reduces* flap | — |
| H4 | Gateway reaper false-positive | Very low | Threshold unchanged at 30min, unrelated to symptoms | — |
| H5 | `9f02cc8` silencing error states hides a real error | Low | Only active post-interrupt; wouldn't trigger without user action | — |

## 7 · Recommended next steps

1. **Reproduce with `wrangler tail`** on a prod session. Leave an idle
   session at a permission gate (or mid long-tool-call) for ≥90s. Grep for:
   - `[SessionDO][conn] close doId=…` — close code + reason
   - `[SessionDO:…] Gateway WS closed`
   - `[SessionDO:…] WS dropped, gateway reports state=running — running recovery`
   - `[dial-back-client] connection dropped … code=4401`
   That log triad is the smoking gun for H1+H2.

2. **Short-term mitigation (H1 only)** — revert the skip trap door in
   `maybeRecoverAfterGatewayDrop`: when `result.kind === 'state'` AND
   `result.body.state === 'running'`, schedule a 15–30s grace timer and
   only proceed to recovery if no re-dial landed in the window. Preserves
   GH#50's "don't get stuck in running forever" goal while tolerating transient
   flaps.

3. **Short-term mitigation (H2 only)** — add a `setInterval(25_000)` in
   `DialBackClient.onopen` that sends a small frame (either a WS native ping
   if the CF side supports it, or a zero-byte JSON keepalive the DO drops on
   the floor). Must NOT emit a `GatewayEvent` — that would defeat the
   last-event-ts semantics from GH#50.

4. **Long-term** — move to an explicit WS-layer ping/pong contract. CF DO
   sockets support server-sent pings; the DO can ping the runner every 20s
   and close with a specific code if no pong lands in 15s. This replaces
   both the application heartbeat and the eager recovery — recovery then
   fires only on authoritative "runner dead" signal, not on any close.

5. **Test coverage gap** — add a unit test that:
   - spins up a SessionDO with a live callback token,
   - simulates an `onClose(code=1006)` on the gateway connection,
   - asserts that `active_callback_token` is NOT cleared within the grace
     window if a re-dial with the same token arrives.
   This test would have caught the regression.

## 8 · Files to read together

Primary:
- `apps/orchestrator/src/agents/session-do.ts:698-820, 976-1018`
- `packages/shared-transport/src/dial-back-client.ts` (whole)
- `packages/session-runner/src/main.ts:348-426` (exit paths)

Corroborating:
- `apps/orchestrator/src/lib/derive-status.ts` (TTL predicate)
- `apps/orchestrator/wrangler.toml` (compat flag)
- `packages/agent-gateway/src/reaper.ts` (confirm uninvolved)
- Commit messages on `fa2845c`, `a9936fe`, `9f02cc8`

Related priors:
- `planning/research/2026-04-22-gh50-status-ttl.md` (drove the changes)
- `planning/research/2026-04-21-do-topology-collapse-connection-manager.md`
  (client-side WS lifecycle)

## 9 · Open questions

- What exact close code does CF now send after `web_socket_auto_reply_to_close`
  when idle-closing a DO WS? Need `wrangler tail` evidence before deciding
  whether to treat e.g. `1001` as "benign, skip recovery" in the DO.
- Does the DO itself hibernate while a runner is mid-session? If so, rehydration
  may contribute to WS churn. `a9936fe` pinning compat date to 2026-03-31
  pre-dates some hibernation changes; worth verifying.
- What's the legitimate upper bound on SDK silence during a tool call? If
  `WebFetch` against a slow host can exceed 70s, any ping/pong interval
  needs to be shorter than CF's idle threshold with margin.
