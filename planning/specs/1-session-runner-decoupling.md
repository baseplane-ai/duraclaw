---
initiative: session-runner-decoupling
type: project
issue_type: refactor
status: approved
priority: high
github_issue: 1
created: 2026-04-17
updated: 2026-04-17
phases:
  - id: p1
    name: "Extract shared-transport package (BufferedChannel + dial-back client)"
    tasks:
      - "Create packages/shared-transport with package.json, tsconfig, index.ts"
      - "Port ReconnectableChannel from session-channel.ts and extend with ring buffer (10K events / 50MB cap)"
      - "Implement overflow: drop oldest + emit single {type:'gap',dropped_count,from_seq,to_seq} sentinel on replay"
      - "Implement dial-back client: connects to callback_url with bearer, exposes send()/onCommand(), reconnects indefinitely with backoff 1s/3s/9s/27s/30s/30s"
      - "Re-dial collision policy: replace old WS, log warning"
      - "Unit tests: buffer overflow, replay ordering, gap sentinel, reconnect backoff progression"
    test_cases:
      - "bun test packages/shared-transport — all unit tests pass"
      - "Overflow test: push 15000 events, assert oldest 5000 dropped, gap sentinel at correct seq"
      - "Reconnect test: 10 simulated drops, assert backoff sequence matches 1,3,9,27,30,30,30,30,30,30"
  - id: p2
    name: "Create session-runner package (owns SDK Query + adapter + dial-back + meta.json)"
    tasks:
      - "Create packages/session-runner with package.json (bun bin entry), tsconfig, index.ts"
      - "Move claude adapter logic from packages/agent-gateway/src/adapters/claude.ts into session-runner/src/claude-runner.ts"
      - "Move buildCleanEnv, resolveProject, handleCanUseTool, isIdleStop, startHeartbeat, createMessageQueue"
      - "Add argv parsing: session-runner <sessionId> <cmd-json-path> <callback_url> <bearer> <pid-file> <exit-file> <meta-file>"
      - "On startup: write PID file, dial callback_url via shared-transport, then start SDK query()"
      - "Assign monotonic ctx.nextSeq on every outbound event before buffering; update ctx.meta (last_activity_ts, last_event_seq, cost, model, turn_count, sdk_session_id, state) on every event handler"
      - "Add 10s setInterval that snapshots ctx.meta and writes meta-file atomically (writeFile .tmp + rename)"
      - "On adapter completion or abort: clear meta interval, write exit file with {state, exit_code, duration_ms, error?}, exit(0)"
      - "On SIGTERM: run abort, wait up to 2s for SDK shutdown, write exit file with state:'aborted', exit(0); if 2s expires exit(1) anyway"
    test_cases:
      - "bun test packages/session-runner — adapter unit tests pass (ported from claude.test.ts)"
      - "Run session-runner stub: spawn with fake callback URL, assert it writes pid file within 500ms and meta file within 11s; exits cleanly on SIGTERM with exit file"
      - "Integration with WS mock (DO token validation from P4 not yet built): spawn session-runner against a local WS server stub that accepts any token and echoes dial events; verify events stream through with monotonic seq numbers and meta.json updates during streaming. Full DO integration test moves to P4."
  - id: p3a
    name: "Gateway: spawn + list + status (remove adapter code). Depends on P2 (session-runner bin + shared file schema) and runs before P3b."
    tasks:
      - "Rewrite POST /sessions/start: accept {callback_url, callback_token, cmd}, spawn detached session-runner with proc.unref(), return 200 within 100ms"
      - "Remove dialback.ts and dialOutboundWs entirely"
      - "Remove claude/codex/opencode adapter imports from agent-gateway (adapter code already moved in P2)"
      - "Implement GET /sessions (B5b): scan pid files, return array of status entries; REPLACES /sessions/discover"
      - "Implement GET /sessions/:id/status (B5): exit → pid+live → pid+dead → 404; 401 on bad bearer; include ok:true on 200"
      - "Update systemd install script to add RuntimeDirectory=duraclaw/sessions"
    test_cases:
      - "POST /sessions/start returns 200 within 100ms and a valid session_id"
      - "POST /sessions/start with missing callback_token returns 400"
      - "GET /sessions/:id/status with no files for id returns 404; with bad bearer returns 401; with live pid returns 200 state:'running'"
      - "GET /sessions returns array of status entries, one per pid file"
      - "bun test packages/agent-gateway — server tests pass (with adapter tests moved out)"
      - "Kill agent-gateway process during active session; session-runner pid still alive; restart gateway; GET /sessions lists the session"
  - id: p3b
    name: "Gateway: reaper + SIGKILL escalation + GC. Depends on P3a (file layout must be in place); parallelizable with P4 (independent surfaces)."
    tasks:
      - "Implement reaper per B6: 5min interval + startup run; meta-then-pid-mtime staleness fallback; SIGTERM → wait 10s → SIGKILL"
      - "Reaper atomic .exit write via fs.link(tmp, final) with EEXIST handling to avoid TOCTOU race with session-runner's own exit-file write"
      - "Reaper GC .cmd orphans >5min old with no matching live pid"
      - "Reaper GC terminal files (.pid, .meta.json, .exit) >1h after .exit mtime"
      - "Add debug endpoint POST /debug/reap (bearer-gated, dev-only behind env flag) to trigger reaper on demand for tests"
    test_cases:
      - "Reaper integration: stale session (meta.last_activity > 30min) receives SIGTERM"
      - "Reaper integration: SIGKILL escalation after SIGTERM-ignored (11s window)"
      - "Reaper integration: stale .cmd files unlinked after 5min with no matching pid"
      - "Reaper integration: terminal files unlinked 61min after exit mtime"
      - "Reaper TOCTOU: concurrent runner-SIGTERM-exit and reaper-crashed-write — only one writes the .exit file"
  - id: p4
    name: "DO-side: callback_token + status-aware recovery + watchdog tuning"
    tasks:
      - "Add active_callback_token field to SessionState (no SQL migration — lives in setState JSON blob)"
      - "Modify triggerGatewayDial (session-do.ts:250-310): generate crypto.randomUUID() callback_token, store in active_callback_token (rotating any previous value), include in POST body"
      - "Modify onConnect gateway-role branch (session-do.ts:145-149): extract token query param, timing-safe compare to active_callback_token; on match accept connection and leave token in state (supports reconnects); on mismatch close WS with code 4401"
      - "On terminal-state transitions (completed/failed/aborted/crashed handlers in handleGatewayEvent), clear active_callback_token in the same setState as status"
      - "Modify onClose in session-do.ts:222 — before recoverFromDroppedConnection, call gateway GET /sessions/:id/status"
      - "If status=running: log 'WS dropped, runner alive', skip recovery, wait for re-dial"
      - "If status=completed|failed|aborted|crashed: run existing recoverFromDroppedConnection path"
      - "If status=404 or unreachable (non-200, timeout 5s): fall through to current recovery (defensive)"
      - "Add STALE_THRESHOLD_MS env override (default 90_000); update constant at session-do.ts:73"
      - "Keep alarm + watchdog intact as safety net"
    test_cases:
      - "Unit test: triggerGatewayDial generates token and stores in active_callback_token; POST body includes callback_token"
      - "Unit test: first onConnect with matching token accepts connection AND token remains in state"
      - "Unit test: subsequent reconnect with same token is also accepted (simulates WS drop + re-dial)"
      - "Unit test: onConnect with wrong/missing token closes WS with code 4401"
      - "Unit test: terminal state transition clears active_callback_token; subsequent connect with previously-valid token is rejected 4401"
      - "Unit test: onClose with stubbed status=running does not call recoverFromDroppedConnection"
      - "Unit test: onClose with stubbed status=completed calls recoverFromDroppedConnection"
      - "Unit test: onClose with stubbed 404 calls recoverFromDroppedConnection (defensive)"
      - "pnpm typecheck passes"
  - id: p5
    name: "Observability + verification + cleanup"
    tasks:
      - "Add structured logs: BufferedChannel depth on each send, overflow events with (sessionId, dropped_count)"
      - "Add structured logs: reconnect attempt (sessionId, attempt, delay_ms)"
      - "Add structured logs: status endpoint hits with (sessionId, state, duration_ms)"
      - "Delete unused ReconnectableChannel from session-channel.ts (moved to shared-transport)"
      - "Delete old HEARTBEAT_INTERVAL_MS duplicate if present in session-channel.ts"
      - "Update packages/agent-gateway/README with new scope"
      - "E2E: run deploy-during-session scenario manually, capture evidence"
    test_cases:
      - "pnpm typecheck passes across all packages"
      - "pnpm build succeeds"
      - "E2E verification: start long session, trigger CF Worker redeploy mid-stream, session completes without loss"
      - "Gateway restart during active session: session-runner unaffected, DO continues receiving events"
---

# 1: Decouple Session Lifecycle from Gateway via session-runner Subprocess

## Overview

Today when the orchestrator redeploys or the gateway process restarts, the Claude Agent SDK session on the VPS dies — the SDK subprocess is piped to the gateway process, so losing the parent loses the child. This spec introduces a new detached `session-runner` process (one per session) that owns the SDK Query and dials the Durable Object directly over WebSocket. The gateway becomes a thin spawn/list/reap layer with no data-path involvement. Gateway restarts, CF Worker redeploys, and transient network flakes all become non-events for the running session.

## Feature Behaviors

### B1: BufferedChannel with ring-buffer and gap replay

**Core:**
- **ID:** buffered-channel
- **Trigger:** `channel.send(event)` called while underlying WebSocket is disconnected, reconnecting, or full
- **Expected:** Events queue in a ring buffer capped by BOTH event count (10K) and byte size (50MB). Eviction algorithm on push: if adding the new event would exceed EITHER cap, drop oldest events one-at-a-time (loop) until both constraints are satisfied, then push. **Oversized-event edge case:** if a single serialized event itself exceeds `maxBytes`, the buffer drains fully, then the event is sent directly on the live WS if attached (skipping the buffer), or dropped with a logged warning + gap sentinel if WS not attached. This prevents infinite eviction loops. Track coalesced drop range as `{dropped_count, from_seq, to_seq}`; subsequent evictions within the same disconnect window extend the existing gap range rather than creating multiple sentinels. When WS reconnects, replay starts with a single `{type:'gap', ...}` sentinel (if any drops occurred) followed by remaining events in seq order.
- **Verify:** (a) Event-count overflow — push 15000 equal-sized events, reconnect, assert first event is gap `{dropped_count:5000, from_seq:1, to_seq:5000}`, followed by 5001..15000. (b) Byte-cap overflow — push 5MB events until total > 50MB, reconnect, assert gap sentinel range reflects the count needed to bring bytes under cap. (c) Mixed overflow — many small + one large event triggering byte cap first.
**Source:** `packages/shared-transport/src/buffered-channel.ts` (new file; ports `ReconnectableChannel` from `packages/agent-gateway/src/session-channel.ts:48-71`)

#### API Layer
```typescript
// packages/shared-transport/src/buffered-channel.ts
export interface BufferedChannelOptions {
  maxEvents?: number       // default 10_000
  maxBytes?: number        // default 50 * 1024 * 1024
                           // byte accounting: Buffer.byteLength(serialized, 'utf8')
                           //                  where serialized = JSON.stringify(event)
                           // each buffer entry stores {seq, serialized, bytes}
                           // total bytes = sum of entry.bytes; cap triggered if
                           //   incoming push would exceed either cap
  onOverflow?: (dropped: GapSentinel) => void
}

export class BufferedChannel {
  constructor(options?: BufferedChannelOptions)
  send(event: { seq: number; [k: string]: unknown }): void
  attachWebSocket(ws: WebSocket): void   // replay buffered on open
  detachWebSocket(): void
  close(): void
  readonly depth: number                  // current buffer size
  readonly isAttached: boolean
}

export interface GapSentinel {
  type: 'gap'
  dropped_count: number
  from_seq: number
  to_seq: number
}
```

### B2: Dial-back client with indefinite reconnect

**Core:**
- **ID:** dial-back-client
- **Trigger:** session-runner starts up and needs to reach the DO's `callback_url`
- **Expected:** Opens WS with `Authorization: Bearer <token>` passed as `?token=<token>` query param (CF Agents SDK reads token from query, not from header, since browser WS doesn't support custom upgrade headers). Reconnects indefinitely on drop with backoff `1s/3s/9s/27s/30s/30s…`. **Backoff resets to 1s after the connection stays open for at least 10 seconds** (a healthy connection; transient blip should not penalize subsequent drops). A second WS opening for the same session-runner (collision) replaces the old channel and logs a warning. All outbound events flow through an attached `BufferedChannel`. **Startup failure mode:** if the initial connection cannot be established within 15 minutes of continuous retry (matches ~32 attempts at cap), session-runner aborts the SDK, writes exit file with `state:"failed", error:"callback_url unreachable for 15m"`, and exits 1. Prevents runaway credit burn on misconfigured spawns.
- **Verify:** (a) Unit test — 10 drops with no stable window, asserts delays = `[1000,3000,9000,27000,30000,30000,30000,30000,30000,30000]` ms (±50ms). (b) Unit test — drop, stay connected 11s, drop again, assert second-drop delay = 1000ms (reset triggered). (c) Unit test — connect never succeeds, fast-forward 15min, assert session-runner exits 1 with expected exit file.
**Source:** `packages/shared-transport/src/dial-back-client.ts` (new file)

#### API Layer
```typescript
export interface DialBackClientOptions {
  callbackUrl: string
  bearer: string
  channel: BufferedChannel
  onCommand: (cmd: unknown) => void
  onStateChange?: (state: 'connecting' | 'open' | 'closed' | 'reconnecting') => void
}

export class DialBackClient {
  constructor(options: DialBackClientOptions)
  start(): void                 // connect + handle reconnects
  stop(): Promise<void>         // close WS, flush buffer best-effort
}
```

### B3: session-runner process (per-session SDK owner)

**Core:**
- **ID:** session-runner-binary
- **Trigger:** `agent-gateway` spawns `session-runner <sessionId> <cmd-file> <callback_url> <bearer> <pid-file> <exit-file> <meta-file>` detached
- **Expected:** On startup: reads `<cmd-file>`. If read fails (missing, unreadable, invalid JSON) → write exit file atomically with `{state:"failed", exit_code:1, error:"cmd-file unreadable: <reason>"}`, exit 1 immediately (no DO dial, no SDK work). **Concurrent-resume guard:** if `cmd.type === 'resume'` and any existing `*.meta.json` in `/run/duraclaw/sessions/` has `sdk_session_id` matching `cmd.sdk_session_id` AND its pid is alive, write exit file `{state:"failed", exit_code:2, error:"sdk_session_id already active"}` and exit 2. Otherwise: writes PID file, dials DO via `DialBackClient`, starts SDK `query()`. Stamps monotonic `ctx.nextSeq` on every event before buffering. Writes `<meta-file>` (atomic via write-then-rename — rename is correct here because we WANT to overwrite on every tick) every 10s with live context: `{sdk_session_id, last_activity_ts, last_event_seq, cost, model, turn_count, state}`. The interval runs on a `setInterval` attached to the SDK event loop; each event handler updates an in-memory `ctx.meta` which the interval snapshots. **Meta-write failure policy:** individual write failures (disk full, permission error) are logged; after 5 consecutive failures the session-runner aborts its `abortController` (letting the adapter emit a terminal event), ensuring the reaper doesn't SIGTERM a "healthy" session whose meta is silently stale. On natural completion (SDK emits `result`) or explicit abort: writes `<exit-file>` with `{state, exit_code, duration_ms, error?}`, clears meta interval, then exits 0. On SIGTERM: aborts SDK, waits up to 2s for completion, writes exit file with `state:"aborted"`, exits 0. If the 2s window elapses, exits 1 anyway — reaper handles the zombie.
- **Verify:** Spawn `packages/session-runner/bin/session-runner.js test-id /tmp/cmd.json ws://localhost:9999/cb test-bearer /tmp/run.pid /tmp/run.exit /tmp/run.meta` against a local WS stub. Assert `/tmp/run.pid` contains process PID within 500ms. Wait 11s; assert `/tmp/run.meta` exists and parses as JSON with `last_activity_ts` set. Send SIGTERM; assert `/tmp/run.exit` written within 3s with `{state:"aborted", exit_code:0}`.
**Source:** `packages/session-runner/src/main.ts` (new file); adapter code moved from `packages/agent-gateway/src/adapters/claude.ts`

#### API Layer
```
Invocation (from agent-gateway):
  $ /opt/duraclaw/session-runner/bin/session-runner.js \
      <sessionId> <cmd-file-path> <callback_url> <bearer> \
      <pid-file> <exit-file> <meta-file>

Files written:
  <pid-file>   — JSON: {pid, sessionId, started_at}
                 Written once at startup, unlinked on clean exit.
                 (cmd_type intentionally excluded — metadata lives in meta-file)
  <meta-file>  — JSON: {sdk_session_id, last_activity_ts, last_event_seq,
                         cost: {input_tokens, output_tokens, usd},
                         model, turn_count, state}
                 Written every 10s via write-then-rename atomic pattern
                 (fs.writeFile to {meta-file}.tmp, then fs.rename).
  <exit-file>  — JSON: {state: "completed"|"failed"|"aborted"|"crashed",
                         exit_code, duration_ms, error?}
                 Written once on terminal state, never modified.

Stdio: gateway opens /run/duraclaw/sessions/{id}.log (append mode, line-buffered)
and passes its fd as both stdout and stderr to the detached spawn. Detached
spawn with stdio:['ignore','ignore','ignore'] loses all diagnostic output;
using a per-session log file preserves it without needing the gateway process
alive. Log files are GC'd alongside terminal files (B6 step 6).
```

### B4: Gateway POST /sessions/start spawns detached session-runner

**Core:**
- **ID:** spawn-session-runner
- **Trigger:** DO posts to gateway `/sessions/start` with `{callback_url, cmd, callback_token}`
- **Expected:** Gateway validates: (1) bearer (`CC_GATEWAY_SECRET`), (2) `callback_url` is a non-empty string starting with `ws://` or `wss://` (→ 400 `"invalid callback_url"` otherwise), (3) `callback_token` is a non-empty string (→ 400 `"invalid callback_token"` otherwise), (4) `cmd` using the existing `GatewayCommand` runtime check at `packages/agent-gateway/src/server.ts:328-374` (required fields: `type: 'execute'|'resume'|...`, plus type-specific fields like `project` for execute, `sdk_session_id` for resume) → 400 `"invalid cmd"` on failure. Generates `sessionId`. Writes `cmd-json` to `/run/duraclaw/sessions/{sessionId}.cmd`. Spawns detached `session-runner` via `Bun.spawn({ detached: true, stdio: ['ignore','ignore','ignore'] })` passing `callback_token` as bearer argv. Returns `200 {ok:true, session_id}` within 100ms. Gateway does NOT hold the child handle (calls `proc.unref()`).
- **Verify:** POST with valid payload + bearer returns 200 within 100ms. Kill gateway after POST; session-runner PID still alive and continues to dial DO. POST with bad `callback_token` (empty string) returns 400 `{ok:false, error:"invalid callback_token"}`. POST with bad `callback_url` (e.g., `"not-a-url"`) returns 400 `{ok:false, error:"invalid callback_url"}`.
**Source:** `packages/agent-gateway/src/server.ts:328-374` (rewrite existing endpoint)

#### API Layer
- **Endpoint:** `POST /sessions/start` (unchanged URL + auth)
- **Auth:** Gateway-level bearer (`CC_GATEWAY_SECRET`). This bearer is for orchestrator-to-gateway only; `callback_token` is a separate per-session secret for gateway-to-DO.
- **Request:** `{callback_url: string, callback_token: string, cmd: GatewayCommand}`
- **Response:** `200 {ok:true, session_id}` or `400/401 {ok:false, error}`

#### Data Layer
- Directory: `/run/duraclaw/sessions/` — tmpfs under systemd, mode 0700, owned by gateway user
- Files per session: `{id}.pid`, `{id}.meta.json`, `{id}.exit`, `{id}.cmd` (deleted by session-runner after read; reaper GC's orphans)

### B4b: DO generates per-session callback_token and validates dial-back (+ reconnections)

**Core:**
- **ID:** callback-token-lifecycle
- **Trigger:** `SessionDO.triggerGatewayDial()` prepares to POST `/sessions/start`; later, WS connections arrive on `/agents/session-agent/{doId}?role=gateway&token=<callback_token>` — potentially multiple times for the same session as the runner reconnects after WS drops.
- **Expected:** DO generates a fresh `callback_token` per spawn via `crypto.randomUUID()`, stores it in `this.state.active_callback_token` (DO-resident, hibernation-safe via `setState`). On rotation (a new `triggerGatewayDial` while a session-runner is already connected), DO closes any existing gateway-role WS connection with code 4410 ("token rotated") BEFORE storing the new token, preventing old+new runners from both streaming to DO. On POST to gateway, passes `callback_token` in the request body. The gateway's `POST /sessions/start` response contains the gateway-assigned `session_id`; DO persists it into `this.state.session_id` via `setState` (this is the ID used for subsequent `GET /sessions/:id/status` calls).  On every WS connect, the DO's `onConnect` handler extracts the query-param token and compares it (timing-safe) to `active_callback_token`. On match: accept the connection. **Token stays in state** so subsequent reconnects by the same session-runner also succeed. On mismatch or missing: close WS with code 4401. Token is cleared only when (a) `triggerGatewayDial()` is called again for this session (rotating for a new runner), or (b) the session reaches a terminal state (completed/failed/aborted/crashed — cleared in the same `setState` as `status`).
- **Verify:** Unit tests: (a) `triggerGatewayDial` generates token and stores in `active_callback_token`. (b) First WS connect with matching token → accepted; token still present in state after. (c) Second WS connect (reconnection) with same token → still accepted. (d) WS connect with wrong token → closed with code 4401. (e) After session transitions to `completed`, WS connect with previously-valid token → closed 4401 (token was cleared). (f) New `triggerGatewayDial` during an existing session rotates the token; old token no longer accepted.
**Source:** `apps/orchestrator/src/agents/session-do.ts:250-310` (modify triggerGatewayDial), `:145-149` (onConnect gateway role branch), terminal-state transition sites in handleGatewayEvent.

#### Data Layer
- `SessionState` gains field: `active_callback_token?: string` (UUID v4, persists for session lifetime, rotated on new dial, cleared on terminal state)
- DO migration: no new SQLite column — `active_callback_token` lives in the `SessionState` JSON blob managed by `setState`. No migration needed.

### B5: Gateway GET /sessions/:id/status

**Core:**
- **ID:** session-status-endpoint
- **Trigger:** DO calls `GET /sessions/:id/status` on gateway after WS drop to decide whether to run recovery
- **Expected:** Resolves state from files in this order: (1) if `.exit` file exists → `state` from exit file, other fields from `.meta.json` if present else null/defaults. (2) else if `.pid` file exists AND `process.kill(pid, 0)` succeeds → `state:"running"`, fields from `.meta.json` (default to null/zero if meta not yet written). (3) else if `.pid` file exists but process dead (no `kill -0`) → `state:"crashed"`. (4) else (no pid, no exit) → HTTP 404. Always 200 for cases 1-3, always 404 for case 4. Bad bearer → 401.
- **Verify:** Unit test table: (a) pid-file + live PID + meta → `200 {state:"running", ...}`; (b) exit-file `state:"completed"` → `200 {state:"completed", ...}`; (c) pid-file + dead PID → `200 {state:"crashed", ...}`; (d) no files → `404 {error:"session not found"}`; (e) no bearer → `401 {error:"unauthorized"}`.
**Source:** `packages/agent-gateway/src/server.ts` (new route handler)

#### API Layer
- **Endpoint:** `GET /sessions/:id/status`
- **Auth:** Bearer (`CC_GATEWAY_SECRET`). Missing/invalid → `401 {ok:false, error:"unauthorized"}`.
- **Responses:**
  - `200` (session known):
    ```json
    {
      "ok": true,
      "state": "running|completed|failed|aborted|crashed",
      "sdk_session_id": "uuid or null",
      "last_activity_ts": 1713369600000,
      "last_event_seq": 142,
      "cost": {"input_tokens": 1200, "output_tokens": 800, "usd": 0.015},
      "model": "claude-sonnet-4-6",
      "turn_count": 3
    }
    ```
  - `404 {ok:false, error:"session not found"}` — no pid, no exit file for this sessionId
  - `401 {ok:false, error:"unauthorized"}` — missing/bad bearer
- **Live-status source:** session-runner writes `{sessionId}.meta.json` every 10s while running (see B3). Gateway reads it on each status call. On `kill -0` failure, treat pid file as orphaned → state `crashed`.

### B5b: Gateway GET /sessions list

**Core:**
- **ID:** sessions-list-endpoint
- **Trigger:** Caller (DO or operator) hits `GET /sessions` on gateway
- **Expected:** Scan `/run/duraclaw/sessions/*.pid`. For each pid, resolve state via the same logic as B5 (pid+live = running; exit file = terminal state; pid+dead = crashed). Returns an array of entries matching the B5 response body shape. This endpoint REPLACES the existing `GET /sessions/discover` SDK-based scanner (`server.ts:92`) — the old discovery mechanism relied on parsing `.claude/sessions/` on disk and is no longer needed because session-runner owns its own state.
- **Verify:** Unit test with 3 fake pid files (1 live, 1 with exit, 1 dead without exit) — response contains 3 entries with expected states. Integration test: POST /sessions/start three times, GET /sessions returns 3 entries.
**Source:** `packages/agent-gateway/src/server.ts:92-140` (replace existing `/sessions/discover` handler) and `packages/agent-gateway/src/sessions-list.ts:1-92` (rewrite)

#### API Layer
- **Endpoint:** `GET /sessions`
- **Auth:** Bearer (`CC_GATEWAY_SECRET`); 401 on failure
- **Response:**
  ```json
  {
    "ok": true,
    "sessions": [
      {
        "session_id": "uuid",
        "state": "running|completed|failed|aborted|crashed",
        "sdk_session_id": "uuid or null",
        "last_activity_ts": 1713369600000,
        "last_event_seq": 142,
        "cost": {"input_tokens": 1200, "output_tokens": 800, "usd": 0.015},
        "model": "claude-sonnet-4-6",
        "turn_count": 3
      }
    ]
  }
  ```

### B6: Gateway reaper cron

**Core:**
- **ID:** session-reaper
- **Trigger:** `setInterval(reapOrphans, 5 * 60_000)` runs every 5 minutes in the gateway process; also runs once on gateway startup.
- **Expected:** Scans `/run/duraclaw/sessions/*.pid`. For each pid file:
  1. Read pid. Determine liveness via `process.kill(pid, 0)`.
  2. Determine staleness: prefer `last_activity_ts` from matching `.meta.json`. If `.meta.json` missing (runner started but hasn't written first meta), fall back to pid-file mtime. Staleness threshold: 30 minutes.
  3. If alive + stale → send SIGTERM. Wait 10s. If still alive → send SIGKILL.
  4. If dead + no `.exit` file → write `.exit` atomically (write to `.exit.tmp`, then `link` with `O_EXCL`-equivalent semantics by using `fs.link(tmp, final)` and catching `EEXIST`) with `{state:"crashed", exit_code:null, duration_ms:(now - pid mtime)}`. This avoids the TOCTOU race where session-runner's own SIGTERM handler is writing `state:"aborted"` between the reaper's liveness check and its write — only one writer succeeds; the other sees EEXIST and aborts the write (logging `exit file already present, skipping crash mark`).
  5. GC stale `.cmd` files: any `.cmd` older than 5 minutes with no matching live pid → unlink (session-runner should read+unlink within seconds of spawn; 5min indicates a crash during spawn).
  6. GC terminal files: `.pid`, `.meta.json`, `.exit`, and `.log` older than 1 hour after `.exit` mtime → unlink all four.
- **Verify:** Integration test — create fake pid file with meta.json showing `last_activity_ts = now - 31min` pointing at a `sleep 9999` process; run reaper; assert sleep receives SIGTERM; simulate SIGTERM ignore (replace sleep with a SIGTERM-trapping script), assert SIGKILL follows within 11s; stale `.cmd` file older than 5min with no matching pid unlinked; terminal files 61min after exit unlinked.
**Source:** `packages/agent-gateway/src/reaper.ts` (new file)

### B7: DO-side status-aware recovery

**Core:**
- **ID:** status-aware-recovery
- **Trigger:** `onClose` fires on a gateway-role Connection in `SessionDO`
- **Expected:** Before running `recoverFromDroppedConnection()`, DO calls `GET /sessions/:id/status` on gateway with 5s timeout. Response handling:
  - `200 state:"running"` → log + skip recovery, wait for session-runner to re-dial (its `DialBackClient` reconnect loop will reopen the WS).
  - `200 state:"completed" | "failed" | "aborted" | "crashed"` → run `recoverFromDroppedConnection()` (treat as terminal; DO finalizes).
  - `404` (session not found on gateway) → run `recoverFromDroppedConnection()` (orphan / never spawned).
  - timeout or other non-2xx/404 → run `recoverFromDroppedConnection()` (defensive fallback).
- **Verify:** Unit tests in `session-do.test.ts`: stub status returning each of `running`, `completed`, `failed`, `aborted`, `crashed`, `404`, timeout. Assert `recoverFromDroppedConnection` NOT called only for `running`; called in all other cases.
**Source:** `apps/orchestrator/src/agents/session-do.ts:222-241` (modify onClose)

### B8: Tuned watchdog threshold

**Core:**
- **ID:** watchdog-tuning
- **Trigger:** Existing alarm at `session-do.ts:328` checks `staleDuration > STALE_THRESHOLD_MS`
- **Expected:** Default threshold reduced from 5min to 90s. Made env-configurable via `STALE_THRESHOLD_MS` read from DO env. Watchdog still aborts stale sessions (safety net for runner crash without status endpoint reachable).
- **Verify:** With `STALE_THRESHOLD_MS=60000` in env, alarm aborts session after 60s of no activity.
**Source:** `apps/orchestrator/src/agents/session-do.ts:73` (constant → env-backed)

## Non-Goals

- **SDK-internal subprocess detaching.** The `@anthropic-ai/claude-agent-sdk` spawns `claude` with piped stdio; we don't patch around that. We wrap the whole SDK in our own detached session-runner process instead.
- **Session-runner crash recovery (auto-resume).** If the session-runner process itself crashes (OOM, segfault, kill -9), the session is lost. The SDK's on-disk `.claude/sessions/{sdk_session_id}/` state survives so a user can manually resume, but the gateway does not auto-respawn a runner. Flagged as follow-up.
- **Concurrent-resume locking for the same `sdk_session_id`.** Session-runner checks for an existing live pid file at startup and refuses to proceed if one exists for the same `sdk_session_id`, but there is no distributed lease with TTL / recovery. Good enough for single-VPS deployments.
- **Changes to the direct WS path** (browser → gateway `/` WS upgrade at `server.ts:377-386`). That's a separate, working feature (kata state watching); untouched.
- **Changes to the state management audit's broader scope** (D1 migration of session index, append-only DO log, TanStack AI provider shape, dropping Agents SDK). Those are separate specs.
- **HeartbeatEvent type revival.** Remains dead code in `shared-types`; this spec doesn't touch it.
- **Persistent BufferedChannel across session-runner restarts.** Buffer is in-memory; if session-runner dies, buffered-but-unsent events are lost (DO reconstructs from SDK's on-disk session files via hydration).
- **Port of codex / opencode adapters into session-runner.** Same pattern applies, but this spec ships the Claude adapter first. Codex + opencode remain in gateway until a follow-up.

## Verification Plan

### VP1 — Unit: BufferedChannel overflow + replay

```bash
cd /data/projects/duraclaw-dev3
bun test packages/shared-transport/src/buffered-channel.test.ts
```

Expected output includes:
- `✓ pushes 15000 events with WS disconnected, replays from oldest kept`
- `✓ emits single gap sentinel on overflow with correct seq range`
- `✓ depth metric reflects current queue size`

### VP2 — Unit: DialBackClient reconnect backoff

```bash
bun test packages/shared-transport/src/dial-back-client.test.ts
```

Expected: test asserts reconnect delays for 10 drops = `[1000, 3000, 9000, 27000, 30000, 30000, 30000, 30000, 30000, 30000]` (±50ms).

### VP3 — Unit: DO status-aware recovery

```bash
cd apps/orchestrator
pnpm test src/agents/session-do.test.ts -t "status-aware recovery"
```

Expected: 2 new tests pass — `running → skip recovery`, `failed → run recovery`.

### VP4 — Integration: spawn + detach survives gateway kill

```bash
# Terminal A: start gateway
cd packages/agent-gateway && bun run src/server.ts

# Terminal B: simulate DO posting start
curl -X POST http://localhost:9877/sessions/start \
  -H "Authorization: Bearer $CC_GATEWAY_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "callback_url": "ws://localhost:9998/cb",
    "callback_token": "test",
    "cmd": {"type": "execute", "agent": "claude", "project": "duraclaw", "prompt": "echo test"}
  }'
# Expected: {"ok":true,"session_id":"<uuid>"} within 100ms

# Capture the pid from /run/duraclaw/sessions/<session_id>.pid
SESSION_PID=$(jq .pid /run/duraclaw/sessions/<session_id>.pid)

# Terminal A: kill gateway
# kill <gateway_pid>

# Assertion: session-runner still alive
ps -p $SESSION_PID   # must show session-runner process
cat /run/duraclaw/sessions/<session_id>.pid  # must still exist
```

Expected: session-runner process is still running after gateway dies.

### VP5 — Integration: status endpoint after gateway restart

```bash
# With a session-runner alive (from VP4):
# Restart gateway:
bun run packages/agent-gateway/src/server.ts &

curl -H "Authorization: Bearer $CC_GATEWAY_API_TOKEN" \
  http://localhost:9877/sessions/<session_id>/status
```

Expected response body: `{"state":"running","sdk_session_id":"...","last_activity_ts":...,"last_event_seq":N,"cost":{...},"model":"claude-sonnet-4-6","turn_count":N}`.

### VP6 — Reaper behavior

```bash
# Create a stale pid file (matching B3 pid schema exactly):
sleep 9999 &
SLEEP_PID=$!
printf '{"pid":%d,"sessionId":"stale-test","started_at":%d}\n' \
  "$SLEEP_PID" "$(($(date +%s)*1000))" \
  > /run/duraclaw/sessions/stale-test.pid
printf '{"last_activity_ts":%d,"last_event_seq":0,"cost":{"input_tokens":0,"output_tokens":0,"usd":0},"model":null,"turn_count":0,"state":"running","sdk_session_id":null}\n' \
  "$(($(date +%s)*1000 - 31*60*1000))" \
  > /run/duraclaw/sessions/stale-test.meta.json

# Trigger reaper (either wait 5min or invoke via a debug endpoint)
curl -X POST http://localhost:9877/debug/reap \
  -H "Authorization: Bearer $CC_GATEWAY_API_TOKEN"

# Assertion: sleep process received SIGTERM
sleep 2
ps -p $SLEEP_PID   # must be gone
cat /run/duraclaw/sessions/stale-test.exit  # must exist with state:"crashed"
```

### VP7 — E2E: deploy-during-session survives

Manual test with deterministic assertions; record evidence in `planning/evidence/1-deploy-during-session.md`.

1. Start orchestrator + gateway locally per `CLAUDE.md`.
2. Log into the UI (`agent.verify+duraclaw@example.com` / `duraclaw-test-password`).
3. Start a task with a fixed-count loop so sequence gaps are detectable: `"Run: for i in {1..300}; do echo $i; sleep 1; done"`.
4. Capture session-runner PID: `SESSION_PID=$(jq .pid /run/duraclaw/sessions/<session_id>.pid)`.
5. After 30s of active streaming, trigger CF Worker redeploy.
6. After redeploy completes, wait 60s, then stop the session.

Deterministic pass criteria (all must hold):
- `ps -p $SESSION_PID` succeeds throughout (PID unchanged from step 4 to session end).
- Final assistant message contains the complete sequence `1..300` with no missing integers. `chrome-devtools-axi eval 'document.body.innerText.match(/\b(\d+)\b/g)'` produces a sequence where no integer in 1-300 is skipped.
- Gateway log contains at least one `GET /sessions/<session_id>/status → state:"running"` line during the redeploy window.
- No `{type:"gap"}` sentinels appear in client message state (check via `chrome-devtools-axi eval 'window.__DURACLAW_DEBUG__?.lastGapSentinel'`, expected: `undefined`).

### VP8 — E2E: gateway-restart during session

Identical setup to VP7 steps 1-4. In step 5 run `systemctl restart duraclaw-agent-gateway` (or local dev: `pkill -f 'bun.*agent-gateway' && bun run packages/agent-gateway/src/server.ts &`).

Deterministic pass criteria:
- `ps -p $SESSION_PID` succeeds throughout.
- Final assistant message contains `1..300` complete sequence.
- DO WS event log shows ZERO `onClose` events during the gateway restart window (session-runner dials DO directly; gateway restart is not observable on the DO side). Measured via `wrangler tail` grep `onClose.*gateway`.
- Gateway status endpoint hit count during the restart window: 0 (DO had no reason to check status since its WS never dropped).

## Implementation Hints

### Key Imports

- `@anthropic-ai/claude-agent-sdk` — `query`, `getSessionInfo`, `forkSession`, `getSessionMessages`, `renameSession`, `tagSession`, `listSessions`. All dynamic-imported (ESM-only).
- `bun` — `Bun.spawn({ detached: true, stdio: ['ignore','ignore','ignore'] })` for detached spawn. `Bun.write()` for pid/exit files.
- `node:fs/promises` — `stat`, `readFile`, `writeFile`, `unlink` for pid/exit file management.
- `node:path` — joining `/run/duraclaw/sessions/{id}.{pid,exit,meta.json,cmd}`.

### Code Patterns

**Detached spawn (gateway → session-runner):**
```typescript
// packages/agent-gateway/src/server.ts POST /sessions/start handler
const sessionId = randomUUID()
const runDir = '/run/duraclaw/sessions'
const cmdFile = `${runDir}/${sessionId}.cmd`
await Bun.write(cmdFile, JSON.stringify(body.cmd))

const logPath = `${runDir}/${sessionId}.log`
const logFd = await fs.open(logPath, 'a')  // append mode so reconnects don't clobber

const proc = Bun.spawn(
  [
    SESSION_RUNNER_BIN,
    sessionId,
    cmdFile,
    body.callback_url,
    body.callback_token,
    `${runDir}/${sessionId}.pid`,
    `${runDir}/${sessionId}.exit`,
    `${runDir}/${sessionId}.meta.json`,   // 7th positional arg — meta file path
  ],
  {
    stdio: ['ignore', logFd.fd, logFd.fd],  // preserve diagnostic output
    detached: true,
  },
)
await logFd.close()  // child inherits the fd; parent doesn't need it
proc.unref()  // don't keep gateway event loop alive for this child
return json(200, { ok: true, session_id: sessionId })
```

**session-runner entrypoint skeleton:**
```typescript
// packages/session-runner/src/main.ts
const [, , sessionId, cmdFile, callbackUrl, bearer, pidFile, exitFile, metaFile] = process.argv
await Bun.write(pidFile, JSON.stringify({ pid: process.pid, sessionId, started_at: Date.now() }))
const cmd = JSON.parse(await Bun.file(cmdFile).text())
await Bun.file(cmdFile).unlink?.()

const channel = new BufferedChannel({ maxEvents: 10_000, maxBytes: 50 * 1024 * 1024 })
const client = new DialBackClient({
  callbackUrl,
  bearer,
  channel,
  onCommand: (msg) => handleDialbackMessage(sessionId, msg, ctx, channel),
})
client.start()

const ctx: GatewaySessionContext = {
  sessionId,
  abortController: new AbortController(),
  nextSeq: 0,
  meta: { sdk_session_id: null, last_activity_ts: Date.now(), last_event_seq: 0,
          cost: { input_tokens: 0, output_tokens: 0, usd: 0 },
          model: null, turn_count: 0, state: 'running' },
  /* ... */
}

// atomic meta.json writer runs every 10s — see full impl with failure counter below
// (do not double-define; the enhanced version lower in this hint is canonical)

try {
  await runClaudeAdapter(channel, cmd, ctx)   // ported from adapters/claude.ts
  await writeExitAtomic(exitFile, { state: 'completed', exit_code: 0, duration_ms: Date.now() - started })
} catch (err) {
  await writeExitAtomic(exitFile, { state: 'failed', exit_code: 1, error: String(err), duration_ms: Date.now() - started })
} finally {
  clearInterval(metaInterval)
  await client.stop()
  process.exit(0)
}

// Shared helper — all terminal file writes use link+EEXIST so the first writer wins
// (prevents session-runner's SIGTERM exit from racing reaper's crashed-write, or vice versa)
async function writeExitAtomic(path: string, body: object): Promise<boolean> {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  await Bun.write(tmp, JSON.stringify(body))
  try {
    await fs.link(tmp, path)           // atomic "create only if absent"
    await fs.unlink(tmp)
    return true
  } catch (err: any) {
    if (err?.code === 'EEXIST') {
      await fs.unlink(tmp).catch(() => {})
      return false                     // someone else already wrote the exit file
    }
    throw err
  }
}

// Meta-file writer uses rename (must overwrite on every tick) with failure counter
let metaFailureCount = 0
const MAX_META_FAILURES = 5
const metaInterval = setInterval(async () => {
  try {
    const tmp = `${metaFile}.tmp`
    await Bun.write(tmp, JSON.stringify(ctx.meta))
    await fs.rename(tmp, metaFile)
    metaFailureCount = 0
  } catch (err) {
    metaFailureCount++
    console.error(`[session-runner] meta write failed (${metaFailureCount}/${MAX_META_FAILURES})`, err)
    if (metaFailureCount >= MAX_META_FAILURES) {
      console.error('[session-runner] meta write failed too many times; aborting session')
      ctx.abortController.abort()       // let the finally block write exit file
    }
  }
}, 10_000)
```

**Status endpoint (gateway):**
```typescript
// packages/agent-gateway/src/server.ts
if (req.method === 'GET' && path.startsWith('/sessions/') && path.endsWith('/status')) {
  if (!checkBearer(req)) return json(401, { ok: false, error: 'unauthorized' })

  const id = path.slice('/sessions/'.length, -'/status'.length)
  const pidPath = `/run/duraclaw/sessions/${id}.pid`
  const exitPath = `/run/duraclaw/sessions/${id}.exit`
  const metaPath = `/run/duraclaw/sessions/${id}.meta.json`

  const [pidInfo, exitInfo, metaInfo] = await Promise.all([
    readIfExists(pidPath), readIfExists(exitPath), readIfExists(metaPath),
  ])

  // 404 path: no pid, no exit — unknown session
  if (!pidInfo && !exitInfo) return json(404, { ok: false, error: 'session not found' })

  let state: string
  if (exitInfo) state = exitInfo.state                    // completed/failed/aborted/crashed
  else if (pidInfo && isAlive(pidInfo.pid)) state = 'running'
  else state = 'crashed'                                  // pid present but process dead

  return json(200, {
    ok: true,
    state,
    sdk_session_id: metaInfo?.sdk_session_id ?? null,
    last_activity_ts: metaInfo?.last_activity_ts ?? null,
    last_event_seq: metaInfo?.last_event_seq ?? 0,
    cost: metaInfo?.cost ?? { input_tokens: 0, output_tokens: 0, usd: 0 },
    model: metaInfo?.model ?? null,
    turn_count: metaInfo?.turn_count ?? 0,
  })
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}
```

**DO-side status check (session-do.ts):**
```typescript
// onClose override at session-do.ts:222
onClose(connection: Connection, code: number, reason: string, wasClean: boolean) {
  if (connection.data?.role === 'gateway') {
    void this.maybeRecover()
  }
  super.onClose(connection, code, reason, wasClean)
}

private async maybeRecover() {
  const sessionId = this.state.session_id
  if (!sessionId) return
  try {
    const res = await fetch(
      `${this.env.CC_GATEWAY_URL}/sessions/${sessionId}/status`,
      {
        headers: { Authorization: `Bearer ${this.env.CC_GATEWAY_SECRET}` },
        signal: AbortSignal.timeout(5_000),
      },
    )
    if (!res.ok) return this.recoverFromDroppedConnection()
    const body = await res.json() as { state: string }
    if (body.state === 'running') {
      console.log(`[SessionDO] WS dropped, runner alive for ${sessionId} — skipping recovery`)
      return
    }
  } catch {
    // timeout / network error — fall through
  }
  await this.recoverFromDroppedConnection()
}
```

### Gotchas

- **ESM-only SDK.** `@anthropic-ai/claude-agent-sdk` must be dynamically imported (see `adapters/claude.ts:232,281`). Keep this pattern in session-runner.
- **`Bun.spawn({ detached: true })` still keeps the parent alive unless you `proc.unref()`.** Easy to miss. Test by killing the parent and checking the child survives.
- **`process.kill(pid, 0)` semantics.** Returns successfully if the process exists OR if it's a zombie not yet reaped. Pair with exit file check to disambiguate running-vs-zombie.
- **tmpfs sizing.** `/run` is tmpfs on most systemd distros, typically 10% of RAM. Pid/exit files are tiny (<1KB each) but meta.json may grow if we log event-by-event. Cap meta.json at last-known summary only.
- **systemd unit ownership.** `/run/duraclaw/sessions/` needs to exist before gateway starts. Add `RuntimeDirectory=duraclaw/sessions` to the systemd unit so it's auto-created with correct ownership.
- **SIGTERM handling.** Bun processes receive SIGTERM on systemd stop. session-runner must register a handler that calls `abortController.abort()` then waits up to 2s for SDK shutdown before `process.exit(0)`.
- **Buffer size tuning.** 10K events / 50MB is a starting point. The observability metrics (depth + overflow count) are the feedback loop; don't hard-code until prod data confirms.
- **WS reconnect on the DO side.** The DO hibernates between events, and re-opens via the Hibernation API when a message arrives. The status check must happen in `onClose` (still in-memory at that point), not in the alarm handler.

### Reference Docs

- `planning/research/2026-04-17-session-lifecycle-decoupling.md` — Original research, coupling-point analysis, failure-mode inventory. Read first.
- `planning/specs/43-flip-gateway-ws-direction.md` — Most recent WS-direction refactor; established the dial-back pattern this spec extends. Same style template.
- `packages/agent-gateway/src/dialback.ts:141-228` — Current dial-back implementation being replaced.
- `packages/agent-gateway/src/session-channel.ts:48-71` — Current `ReconnectableChannel`; source of the ported logic.
- `packages/agent-gateway/src/adapters/claude.ts` — Source of the code moving into `packages/session-runner`.
- `apps/orchestrator/src/agents/session-do.ts:73,222,328,346` — DO-side integration points for the new status check + watchdog tuning.
- Bun subprocess docs: https://bun.sh/docs/api/spawn — `detached`, `stdio`, `.unref()` semantics.
- systemd RuntimeDirectory: https://www.freedesktop.org/software/systemd/man/systemd.exec.html#RuntimeDirectory= — for `/run/duraclaw/sessions/` provisioning.
