---
initiative: gateway-liveness-authority
type: project
issue_type: feature
status: approved
priority: high
github_issue: 150
created: 2026-04-30
updated: 2026-04-30
phases:
  - id: p1
    name: "Gateway: dispatch endpoint + FIFO + spawn-lock"
    tasks:
      - "Add `POST /sessions/:id/dispatch` route to `packages/agent-gateway/src/server.ts` (Bearer auth, JSON body)"
      - "Implement `handleDispatchMessage(sessionId, body, opts)` in `packages/agent-gateway/src/handlers.ts`: read `.pid`, run `defaultLivenessCheck(pid)`; on alive → write to `${sessionsDir}/${sessionId}.input` FIFO; return 200/404/503"
      - "Validate dispatch body shape with `zod` schema: `{ message: { role: 'user', content: string | ContentBlock[] }, client_message_id?: string }`. Return 400 on schema fail."
      - "Add per-session in-memory write-lock in handlers.ts: `Map<sessionId, Promise<void>>` keyed by sessionId; dispatch handler awaits previous write before its own. Catch errors so a failed write doesn't poison the chain"
      - "Implement length-prefixed framing helper `encodeFrame(payload: object): Buffer` (4B LE uint32 length + UTF-8 JSON). Reject payloads >10MB"
      - "Modify `handleStartSession` (handlers.ts:212-312) to create `${sessionsDir}/${sessionId}.input` FIFO via `mkfifoSync(path, 0o600)` immediately after `.cmd` write, before fork"
      - "Modify `handleStartSession` to write atomic `.lock` file via `writeExitOnce(lockPath, payload)` BEFORE `.cmd` write; on `'already_exists'` return 409 `{ ok: false, error: 'spawn already in flight' }`"
      - "Add `unlink(.lock)` to runner-startup-confirmation step (after spawn fork succeeds and runner pid is observed)"
      - "Modify reaper terminal-trio GC (`reaper.ts:432`) to also unlink `*.input` FIFOs >1h past `.exit` mtime, alongside `.pid`/`.exit`/`.log`"
      - "Modify reaper orphan GC (reaper.ts cmd-orphan sweep, ~line 405) to also unlink `*.lock` files >5min stale (matching `.cmd` orphan window). Prevents a crashed spawn from permanently blocking re-spawn of the same session"
      - "Use `Bun.spawnSync({ cmd: ['mkfifo', '-m', '0600', path] })` to create FIFOs (3 LoC, no runtime probe). Bun's `node:fs.mkfifoSync` support is uncertain across versions; shell-out is unconditionally portable on Linux"
      - "Open dispatch FIFO writes with `O_NONBLOCK | O_WRONLY` flag: `await fs.open(fifoPath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)`. If runner reader is not attached (e.g., runner died between `kill(pid, 0)` and the FIFO open — TOCTOU window), open returns ENXIO → handler returns 503. Without O_NONBLOCK, the gateway's writer would block indefinitely on a dead reader, exhausting CF Worker's 30s wall-clock"
      - "Type the dispatch route in shared-types: extend `GatewayCommand` discriminated union with optional `'dispatch'` variant for runner-side typing? — actually, dispatch is HTTP→FIFO, NOT a GatewayCommand. Keep wire types unchanged"
    test_cases:
      - id: "dispatch-200-on-live-runner"
        description: "Mock `defaultLivenessCheck` to return alive; dispatch returns 200; FIFO write succeeds; frame length+JSON parses on a test reader"
        type: "unit"
      - id: "dispatch-404-no-pid"
        description: "No .pid file present; dispatch returns 404 `{ ok: false, error: 'session not found' }`"
        type: "unit"
      - id: "dispatch-503-stale-pid"
        description: "PID file present but `kill(pid, 0)` returns ESRCH (mocked); dispatch returns 503 `{ ok: false, error: 'session not running', state: 'crashed' }`"
        type: "unit"
      - id: "dispatch-409-on-spawn-lock"
        description: "Concurrent /sessions/start: first wins, second receives 409 `{ ok: false, error: 'spawn already in flight' }`"
        type: "unit"
      - id: "dispatch-write-ordering"
        description: "Two sequential dispatch calls for same sessionId; FIFO reader sees both frames in send order even if both handlers were entered concurrently (per-session lock holds)"
        type: "unit"
      - id: "fifo-pre-created-on-spawn"
        description: "After /sessions/start succeeds, `.input` FIFO exists at the expected path with mode 0600"
        type: "unit"
      - id: "framing-encode-decode-roundtrip"
        description: "encodeFrame writes 4B LE length + JSON; matching reader recovers the same JSON across various sizes (10B, 4KB, 100KB)"
        type: "unit"
      - id: "framing-rejects-oversize"
        description: "encodeFrame throws on payloads serializing to >10MB; reader rejects and closes if length-prefix > 10MB"
        type: "unit"
      - id: "reaper-gc-input-fifo"
        description: "Reaper terminal sweep unlinks *.input alongside *.pid/*.exit/*.log when terminal trio is >1h past .exit mtime"
        type: "unit"
      - id: "reaper-gc-orphan-lock"
        description: "Reaper orphan sweep unlinks *.lock files >5min stale (no matching live .pid). After GC, a fresh /sessions/start for the same sessionId succeeds (no 409)"
        type: "unit"
      - id: "dispatch-503-on-nonblocking-enxio"
        description: "Mock kill(pid, 0) to return alive but no reader is attached to the FIFO; gateway's O_NONBLOCK FIFO open returns ENXIO; dispatch returns 503 within milliseconds (does not block)"
        type: "unit"
  - id: p2
    name: "Runner: FIFO reader + client_message_id dedupe"
    tasks:
      - "In `packages/session-runner/src/main.ts` after `.pid` write (line ~318) and before `dialBackClient.connect()`: open FIFO reader at `${SESSIONS_DIR}/${sessionId}.input` via `fs.createReadStream(path, { highWaterMark: 64 * 1024 })`"
      - "Implement frame-decoder loop: maintain a `Buffer` accumulator; on each `'data'` event, while `buffer.length >= 4`: read 4B LE length, if `length > 10_000_000` log error and `reader.destroy()`; if `buffer.length < 4 + length` break (incomplete frame); slice payload, parse JSON, slice buffer past frame"
      - "Implement `LRUSet<string>` (or use a simple `Map` with insertion-order eviction at size 64) for `client_message_id` dedupe. On valid frame: if `msg.client_message_id && seenIds.has(id)` → drop (log debug); else add to set and call `currentAdapter?.pushUserTurn({ role: 'user', content: msg.message.content })`"
      - "Wire FIFO error handling: on `'error'` log `[runner] FIFO read error` and let DialBackClient continue; on `'end'` (last writer closed) reopen the read-stream (FIFO supports re-open after EOF)"
      - "Add SIGTERM cleanup: in main.ts SIGTERM handler, attempt `fs.unlinkSync(${sessionsDir}/${sessionId}.input)` (best-effort; reaper handles permanent cleanup)"
      - "Add to clean-exit path (after SDK loop completes / abort): unlink `.input` alongside other terminal cleanup"
      - "Update `packages/session-runner/src/types.ts` if needed to add `inputFifoReader?: fs.ReadStream` to `RunnerSessionContext` (only if reader needs to be visible across the runner — likely scoped to main.ts)"
    test_cases:
      - id: "fifo-reader-pushes-to-userqueue"
        description: "Writing a length-prefixed frame to the FIFO causes `currentAdapter.pushUserTurn` to be invoked with the parsed message content"
        type: "unit"
      - id: "fifo-reader-handles-partial-frames"
        description: "Splitting a frame across two `'data'` events still produces exactly one pushUserTurn call with the complete payload"
        type: "unit"
      - id: "fifo-reader-rejects-oversize-frame"
        description: "Sending a 4B header claiming length 20MB causes reader.destroy() and logs error; subsequent valid frames after re-open are still processed"
        type: "unit"
      - id: "client-message-id-dedupe"
        description: "Same client_message_id sent twice → only one pushUserTurn call. Different ids → both pass through"
        type: "unit"
      - id: "fifo-cleanup-on-sigterm"
        description: "Runner receives SIGTERM, exits cleanly, .input FIFO is unlinked from $SESSIONS_DIR"
        type: "unit"
      - id: "fifo-reader-reopens-after-eof"
        description: "Runner reader emits 'end' (last writer closed); reader is re-opened on the same path; a subsequent gateway dispatch is still received and pushed to userQueue. Verifies the open/write/close-per-dispatch + EOF-re-open loop survives multiple cycles"
        type: "unit"
  - id: p3
    name: "DO: env binding + always-try-dispatch refactor"
    tasks:
      - "Add `dispatch(sessionId, content, clientMessageId?)` helper in `apps/orchestrator/src/agents/session-do/runner-link.ts` — POSTs `${gatewayUrl}/sessions/${sessionId}/dispatch` with bearer auth, returns `{ ok: boolean, status: number, body?: unknown }`"
      - "Refactor `apps/orchestrator/src/agents/session-do/rpc-messages.ts:sendMessageImpl` (~lines 90-302): remove `hasLiveRunner` / `isResumable` / `isFreshSpawnable` pre-checks. New flow: (1) `appendUserMessage(content)` to SQLite as today, (2) call `dispatchHelper(sessionId, content, client_message_id)`, (3) if `result.ok` return success, (4) on 404/503 fall through to spawn-dial logic, (5) decide resume vs fresh based on `state.runner_session_id` + `state.project`, (6) call `triggerGatewayDial({type: 'resume' | 'execute', ...})`"
      - "Set status='running' BEFORE calling dispatch (preserves the optimistic-status-update behavior). On dispatch 4xx/5xx + fall-back triggerGatewayDial succeeds, status stays 'running'. On both failing, transition to 'error'"
      - "Preserve auto-healing of stuck `pending`/`running` status (current rpc-messages.ts:98-105 logic) but simplify: it's now just a single 'is the message-write protocol still going to make progress?' check"
      - "Preserve `client_message_id` echo: read from input or generate via `crypto.randomUUID()`; pass into both dispatch payload and (on fall-back) ExecuteCommand/ResumeCommand"
      - "Update `apps/orchestrator/src/agents/session-do/runner-link.ts:sendToGateway` — keep as-is for control commands (interrupt/stop/permission-response/answer/transcript-rpc-response). It still uses `cachedGatewayConnId` for routing. Only `sendMessageImpl`'s use of sendToGateway('stream-input', ...) is removed."
      - "Confirm `cachedGatewayConnId` and `gateway_conn_id` kv path are NOT touched by this phase — they remain load-bearing for control-command routing (see B8 in this spec)"
    test_cases:
      - id: "send-message-dispatch-success"
        description: "Mock env.GATEWAY.dispatch to return 200; sendMessage succeeds, no triggerGatewayDial call"
        type: "unit"
      - id: "send-message-dispatch-404-fresh-execute"
        description: "Mock dispatch 404 + state has no runner_session_id but has project → triggerGatewayDial called with type='execute'"
        type: "unit"
      - id: "send-message-dispatch-404-resume"
        description: "Mock dispatch 404 + state has runner_session_id → triggerGatewayDial called with type='resume'"
        type: "unit"
      - id: "send-message-dispatch-503-fall-back"
        description: "Mock dispatch 503 → fall-back to spawn dial (same as 404)"
        type: "unit"
      - id: "send-message-no-pre-check-of-cached-conn-id"
        description: "Even when getGatewayConnectionId() returns a value, sendMessageImpl still calls dispatch first (does not short-circuit). Verify by spy: dispatch is called regardless of cached conn id state"
        type: "unit"
      - id: "send-to-gateway-still-routes-control-commands"
        description: "interruptImpl still calls sendToGateway({type: 'interrupt', ...}) which routes via cachedGatewayConnId. Unchanged from today"
        type: "regression"
  - id: p4
    name: "DO: delete silent-drop layer"
    tasks:
      - "Delete `failAwaitingTurnSilentDropImpl` and its export from `apps/orchestrator/src/agents/session-do/awaiting.ts:66-91`"
      - "Delete the silent-drop branch in `planAwaitingTimeout` (`apps/orchestrator/src/agents/session-do/watchdog.ts:142-151`) — keep only the `connection-lost` branch (15s grace)"
      - "Delete `AWAITING_LIVE_CONN_GRACE_MS` constant from `apps/orchestrator/src/agents/session-do/types.ts:73`"
      - "Delete `clearStaleGatewayConnection` and its callers in `apps/orchestrator/src/agents/session-do/runner-link.ts:168-175`"
      - "Delete the `lastGatewayActivity` proactive stale-detection branch in `runAlarm` (`apps/orchestrator/src/agents/session-do/watchdog.ts:256-265`) — connection-lost recovery via `recoveryGraceTimer` + grace-until kv stays"
      - "In `checkAwaitingTimeoutImpl` (awaiting.ts:33-53): remove the silent-drop case; only handle `reason: 'connection-lost'`"
      - "Update `sendToGateway` in runner-link.ts to remove silent-drop self-clearing — it can stay simple (try `conn.send`, swallow errors). The dispatch path no longer relies on `sendToGateway` for user messages"
      - "Delete tests that exercise silent-drop semantics in `runner-link.test.ts:74-165` (the regression tests for commit 670796d). Keep tests that exercise control-command routing"
      - "Delete `AWAITING_LIVE_CONN_GRACE_MS` import + usage from `session-do.test.ts:27-36`"
    test_cases:
      - id: "no-silent-drop-watchdog"
        description: "Search for `AWAITING_LIVE_CONN_GRACE_MS`, `failAwaitingTurnSilentDropImpl`, `clearStaleGatewayConnection`, `silent-drop` — zero hits in apps/orchestrator/src after this phase"
        type: "regression"
      - id: "connection-lost-recovery-still-works"
        description: "Existing tests for recoverFromDroppedConnection (15s grace + reconnect cancellation) still pass unchanged"
        type: "regression"
      - id: "control-command-routing-unchanged"
        description: "interrupt and stop still route via cachedGatewayConnId; tests at session-do.test.ts asserting WS-targeted send still pass"
        type: "regression"
  - id: p5
    name: "Documentation updates"
    tasks:
      - "Update `docs/theory/topology.md`: rewrite the `Gateway → runner` bullet (~line 32) to document the new FIFO ingress channel; add the new edge to the directionality section. The 'After spawn, the gateway has no direct channel to the runner' line becomes 'After spawn, the gateway can inject user messages via a per-session named FIFO; everything else (kill, list, status) is unchanged.'"
      - "Update `docs/theory/dynamics.md`: rewrite the 'Follow-up message (live runner)' section (~lines 19-23) to describe the dispatch HTTP → FIFO flow. Update the 'Follow-up message (cold runner — resume)' section to describe the dispatch-404 → fall-back-to-triggerGatewayDial flow"
      - "Update `docs/modules/agent-gateway.md`: add `POST /sessions/:id/dispatch` to the HTTP endpoints table (line ~36); add `${id}.input` FIFO to the 'Owns' bullets (line ~19); update the 'Pure control plane' framing in the intro to acknowledge the user-message fast path while preserving 'no SDK, no buffering, no event proxying'"
      - "Reference this spec from the `topology.md` and `dynamics.md` updates so future readers can find the rationale"
    test_cases:
      - id: "docs-mention-dispatch-endpoint"
        description: "grep -l 'POST /sessions/:id/dispatch' docs/ returns at least topology.md, dynamics.md, agent-gateway.md"
        type: "regression"
      - id: "docs-no-stale-claims"
        description: "grep 'gateway has no direct channel to the runner' returns 0 hits across docs/"
        type: "regression"
---

# Gateway as runner-liveness authority

> GitHub Issue: [#150](https://github.com/baseplane-ai/duraclaw/issues/150)

## Overview

Replace DO-side `hasLiveRunner` / `cachedGatewayConnId` decision logic for user messages with a single gateway HTTP call backed by `kill(pid, 0)`. The DO no longer guesses runner liveness from its own (stale) state — it always dispatches first, and the gateway's 200/404/503 response is authoritative. On 404/503, the DO falls back to its existing `triggerGatewayDial` path. Silent-drop user-message orphans become structurally impossible.

This spec narrows the GH#150 deletion list (research found that `active_callback_token`, `cachedGatewayConnId`, and `triggerGatewayDial` are NOT liveness state — they're load-bearing for auth, control-command routing, and cold-path spawning respectively). The actual deletion is the silent-drop watchdog layer; the actual addition is a FIFO-backed dispatch endpoint.

See `planning/research/2026-04-30-150-gateway-liveness-authority.md` for the full research synthesis.

## Feature Behaviors

### B1: Gateway dispatch endpoint

**Core:**
- **ID:** `gateway-dispatch-endpoint`
- **Trigger:** DO calls `POST /sessions/:id/dispatch` with a user-message payload
- **Expected:** Gateway runs `kill(pid, 0)` against the session's `.pid`. If alive: opens the session's `.input` FIFO with `O_WRONLY | O_NONBLOCK`, writes a length-prefixed JSON frame, closes the fd, returns 200. If `.pid` missing: returns 404. If `.pid` present but kill returns ESRCH: returns 503. If FIFO open returns ENXIO (no reader attached — runner died in the TOCTOU window between `kill(pid,0)` and open): returns 503 within milliseconds (does not block). If body fails schema validation: returns 400. Bearer auth via `CC_GATEWAY_API_TOKEN` (same as other endpoints).
- **Verify:** Unit tests `dispatch-200-on-live-runner`, `dispatch-404-no-pid`, `dispatch-503-stale-pid`, `dispatch-write-ordering`.
- **Source:** new — `packages/agent-gateway/src/handlers.ts:handleDispatchMessage`; route in `packages/agent-gateway/src/server.ts`

#### UI Layer
N/A — backend only.

#### API Layer
```
POST /sessions/:id/dispatch
Authorization: Bearer ${CC_GATEWAY_API_TOKEN}
Content-Type: application/json

{
  "message": { "role": "user", "content": "..." | [...content blocks] },
  "client_message_id": "uuid-v4"            // optional
}

Responses:
  200 { "ok": true }                                              — FIFO write succeeded
  400 { "ok": false, "error": "invalid body", "details": ... }    — schema validation failed
  401                                                              — bearer auth failed (existing pattern)
  404 { "ok": false, "error": "session not found" }                — no .pid file
  503 { "ok": false, "error": "session not running",
        "state": "crashed" | "completed" | ... }                  — .pid present, process dead
  500 { "ok": false, "error": "dispatch write failed" }            — FIFO write IO error
```

#### Data Layer
N/A.

---

### B2: FIFO ingress channel

**Core:**
- **ID:** `fifo-ingress`
- **Trigger:** Gateway pre-creates `$SESSIONS_DIR/${sessionId}.input` FIFO (mode `0600`) immediately after writing `.cmd`, before forking the runner. Runner opens for reading after writing its `.pid`, before dialing back. Dispatch handler writes length-prefixed JSON frames to the FIFO; runner reads, parses, and pushes to `userQueue`.
- **Expected:** Frames are length-prefixed (4B LE uint32 size + UTF-8 JSON payload, max 10MB). Reader handles partial frames by buffering. Runner pushes parsed messages to `ctx.userQueue` via `currentAdapter.pushUserTurn(...)`. SDK consumes from queue between turns (no preemption). Gateway opens the FIFO writer-side with `O_WRONLY | O_NONBLOCK` per dispatch (open / write / close — no persistent fd) so a missing reader fails fast with ENXIO instead of blocking. Runner opens the reader-side once at startup with the default blocking mode (`fs.createReadStream`); on EOF (last writer closed) the runner re-opens the read stream — FIFO supports unlimited re-opens. **Inter-frame ordering and atomicity for frames > PIPE_BUF (4KB) is guaranteed by the gateway's per-session in-memory write-lock (B1)** — POSIX atomic-write only covers ≤ PIPE_BUF, so the lock is the structural mechanism that prevents interleaved bytes for multi-block tool-result and image payloads.
- **Verify:** Unit tests `fifo-pre-created-on-spawn`, `fifo-reader-pushes-to-userqueue`, `fifo-reader-handles-partial-frames`, `fifo-reader-rejects-oversize-frame`, `framing-encode-decode-roundtrip`.
- **Source:** gateway: `handlers.ts:handleStartSession` (modify); runner: new code in `packages/session-runner/src/main.ts` after `.pid` write

#### API Layer
Frame format on the FIFO:
```
[4 bytes: little-endian uint32 — payload length, exclusive of header]
[N bytes: UTF-8 JSON]

JSON shape (matches StreamInputCommand from shared-types, minus session_id):
{ "message": { "role": "user", "content": ... }, "client_message_id"?: string }
```

#### Data Layer
- New file per session: `$SESSIONS_DIR/${sessionId}.input` (named pipe, mode `0600`, owner = systemd user)
- Lifecycle: gateway creates, runner reads, gateway writes, reaper GCs after terminal-trio age >1h

---

### B3: Spawn-during-dispatch idempotency lock

**Core:**
- **ID:** `spawn-lock`
- **Trigger:** Two concurrent `POST /sessions/start` requests for the same `sessionId`
- **Expected:** First request acquires `.lock` via atomic `fs.link()` + EEXIST detection (matching `.exit` precedent); second receives 409. Lock is unlinked by `handleStartSession` after the runner's `.pid` is observed (spawn-confirmed). If spawn fails before pid-observation, `.lock` is unlinked in the failure handler. Reaper orphan sweep also unlinks `.lock` files >5min stale (no matching live `.pid`) — guards against `handleStartSession` crashing between lock-acquire and lock-unlink. Eliminates the existing race where two concurrent spawns overwrite each other's `.pid`.
- **Verify:** Unit test `dispatch-409-on-spawn-lock`.
- **Source:** new — modify `packages/agent-gateway/src/handlers.ts:handleStartSession`; reuse `writeExitOnce` helper from `reaper.ts`

#### API Layer
```
POST /sessions/start (existing)

New 409 response:
  409 { "ok": false, "error": "spawn already in flight" }
```

#### Data Layer
New file: `$SESSIONS_DIR/${sessionId}.lock` — atomic write via `fs.link()` from staging file. Contains JSON `{ spawned_at: epoch_ms, callback_url }`. Unlinked on spawn-confirmed or reaper-orphan-GC (>5min stale, matching `.cmd` orphan window).

---

### B4: DO always-try-dispatch with fall-back

**Core:**
- **ID:** `always-try-dispatch`
- **Trigger:** User sends a message; `sendMessageImpl` is called
- **Expected:** DO appends user message to SQLite as today. Then ALWAYS calls `gateway.dispatch(sessionId, content, client_message_id)` first — no `hasLiveRunner` / `isResumable` / `isFreshSpawnable` pre-check. On 200: success, return. On 404 / 503 / status=0 (fetch timeout or network error from `dispatchHelper`): fall back to `triggerGatewayDial({type: 'resume'})` if `state.runner_session_id` exists, else `triggerGatewayDial({type: 'execute'})` if `state.project` exists, else error. On 4xx schema/auth failure (400/401): error without fall-back (those are bugs, not liveness signals). The 5s `dispatchHelper` timeout maps to status=0 → fall-back path runs within the same RPC.
- **Verify:** Unit tests `send-message-dispatch-success`, `send-message-dispatch-404-fresh-execute`, `send-message-dispatch-404-resume`, `send-message-dispatch-503-fall-back`, `send-message-no-pre-check-of-cached-conn-id`.
- **Source:** `apps/orchestrator/src/agents/session-do/rpc-messages.ts:sendMessageImpl` (~lines 90-302) — major refactor

#### UI Layer
No UI change. Existing message-bubble lifecycle (awaiting → in_progress → complete) is preserved end-to-end.

#### API Layer
DO `sendMessage` RPC interface unchanged. Internal implementation rewires.

```typescript
// New flow (simplified)
async function sendMessageImpl(ctx, content, client_message_id?) {
  const messageId = client_message_id ?? crypto.randomUUID()
  appendUserMessageToSqlite(ctx, content, messageId)
  ctx.do.updateState({ status: 'running' })

  const dispatch = await dispatchHelper(ctx, content, messageId)
  if (dispatch.ok) return { ok: true }

  if (dispatch.status === 404 || dispatch.status === 503) {
    if (ctx.state.runner_session_id) {
      return triggerGatewayDial(ctx, { type: 'resume', prompt: content, ... })
    } else if (ctx.state.project) {
      return triggerGatewayDial(ctx, { type: 'execute', prompt: content, ... })
    }
    throw new Error('cannot send: no runner_session_id and no project')
  }

  throw new Error(`dispatch failed: ${dispatch.status}`)
}
```

#### Data Layer
No schema change. `runner_session_id`, `project`, `active_callback_token`, `cachedGatewayConnId`, `gateway_conn_id` kv all stay (for control-routing, auth, fall-back, orphan recovery). Only the *decision logic* in `sendMessageImpl` changes.

---

### B5: Runner-side dedupe via client_message_id

**Core:**
- **ID:** `runner-dedupe`
- **Trigger:** Runner reads a frame from the FIFO with a `client_message_id`
- **Expected:** Runner maintains a small LRU set (size 64) of recent `client_message_id` values. If a frame's id is already in the set, drop the message (log debug). Otherwise add to set and `pushUserTurn(...)`. Frames without `client_message_id` always pass through (no dedupe).
- **Verify:** Unit test `client-message-id-dedupe`.
- **Source:** new — in `packages/session-runner/src/main.ts` FIFO reader code

#### API Layer
N/A (in-process).

#### Data Layer
In-memory only. No persistence; resets on runner restart (acceptable: dispatch retries within a single in-flight request window are the realistic dedupe target).

---

### B6: Silent-drop layer deletion

**Core:**
- **ID:** `delete-silent-drop`
- **Trigger:** Spec implementation (P4 phase)
- **Expected:** All silent-drop watchdog code paths are removed. Silent-drop becomes structurally impossible because every user message goes through dispatch HTTP → `kill(pid, 0)` synchronous truth check. The DO no longer needs an extended-grace timeout to detect silent-drop, no stale-conn-id reactive clear, no proactive `lastGatewayActivity` watchdog.
- **Verify:** Regression tests `no-silent-drop-watchdog`, `connection-lost-recovery-still-works`, `control-command-routing-unchanged`.
- **Source:** deletes from `awaiting.ts`, `watchdog.ts`, `runner-link.ts`, `types.ts` (see P4 task list for line numbers)

#### Data Layer
The `recovery_grace_until` kv key is preserved (used by connection-lost recovery, not silent-drop). The `gateway_conn_id` kv key is preserved (control-command routing).

---

### B7: Reaper FIFO cleanup

**Core:**
- **ID:** `reaper-fifo-gc`
- **Trigger:** Reaper terminal-trio sweep (>1h past `.exit` mtime)
- **Expected:** Reaper unlinks `${sessionId}.input` FIFO alongside `.pid`/`.exit`/`.log` during terminal-trio GC. Orphan FIFO from a runner that crashed before unlinking is reclaimed within an hour. tmpfs (`/run/duraclaw/sessions`) reclaims kernel buffer memory on unlink.
- **Verify:** Unit test `reaper-gc-input-fifo`.
- **Source:** modify `packages/agent-gateway/src/reaper.ts` terminal-trio GC block (~line 432)

---

### B8: Documentation update

**Core:**
- **ID:** `docs-update`
- **Trigger:** Spec implementation (P5 phase)
- **Expected:** `topology.md`, `dynamics.md`, and `agent-gateway.md` all reflect the new gateway→runner FIFO edge, the dispatch endpoint, and the always-try-dispatch DO flow. Stale claims like "the gateway has no direct channel to the runner" are removed.
- **Verify:** Regression `docs-mention-dispatch-endpoint`, `docs-no-stale-claims`.
- **Source:** modify `docs/theory/topology.md`, `docs/theory/dynamics.md`, `docs/modules/agent-gateway.md`

---

## Non-Goals

Explicitly out of scope for this spec:

- **Folding events runner→DO through the gateway.** The dial-back WSS via `BufferedChannel`/`DialBackClient` is unchanged. `topology.md`'s restart-as-noop invariant depends on this.
- **Migrating control commands (interrupt/stop/permission-response/answer) to dispatch.** They stay on the dial-back WS, routed via `cachedGatewayConnId`. Latency-critical (<50ms target) and tightly coupled to SDK's `Query.interrupt()`.
- **Unifying first-turn cold start into dispatch.** `triggerGatewayDial` stays for fresh-execute and resume paths. Three ordering invariants prevent unification (token rotation close-old-WS-then-rotate-then-spawn; persist-user-msg-before-spawn; `/sessions/start` returns gateway-assigned `session_id`).
- **Deleting `active_callback_token`.** Issue's original AC is wrong — this field is the auth gate on the dial-back WS (`onConnect` timing-safe compare). Without it, any caller is accepted on the dial-back.
- **Deleting `cachedGatewayConnId` / `gateway_conn_id` kv.** Issue's original AC is wrong — these route control commands to the specific runner WS. Deletion would force broadcast (trust-boundary violation).
- **Deleting `recoverFromDroppedConnection` / `RECOVERY_GRACE_MS`.** The connection-lost recovery path (orphan rebind) is preserved. Only the silent-drop layer is deleted.
- **Moving spawn-context state (project/model/agent/identity/feature-flags/preferences) to the gateway.** Gateway remains a stateless control plane. Widest-scope dispatch (gateway as orchestrator) is a future spec, not this one.
- **Integration tests, e2e tests, replay tests.** Test surface is unit-only per interview decision. End-to-end behavior is verified in production.
- **Feature-flagged rollout.** Existing flag system has 5-min in-DO cache that defeats gradual rollout. This is a single-PR hard cut following spec #101 P2 precedent.
- **Multi-region / multi-VPS gateway.** Single-VPS gateway assumption preserved. Cross-host runner ingress would require a different IPC mechanism.

## Open Questions

None — all decisions resolved in P1 interview. See "Architectural Bets" in the research doc for hard-to-revert choices.

## Implementation Phases

See YAML frontmatter `phases:` above. Five phases, total estimated 8-12 hours of focused work:

1. **P1** — Gateway: dispatch endpoint + FIFO + spawn-lock (~3 hours)
2. **P2** — Runner: FIFO reader + client_message_id dedupe (~2 hours)
3. **P3** — DO: env binding + always-try-dispatch refactor (~2 hours)
4. **P4** — DO: delete silent-drop layer (~1.5 hours)
5. **P5** — Documentation updates (~1 hour)

Phases must land in this order — P3 depends on P1 (dispatch endpoint must exist before DO can call it); P4 depends on P3 (silent-drop watchdog assumes the old sendMessageImpl flow); P5 documents what the previous phases shipped.

## Verification Strategy

### Test Infrastructure

- **Vitest** is already configured in both `apps/orchestrator/` and `packages/agent-gateway/` and `packages/session-runner/`. Existing test files: `apps/orchestrator/src/agents/session-do.test.ts` (~3300+ lines), `apps/orchestrator/src/agents/session-do/runner-link.test.ts`, `packages/agent-gateway/src/*.test.ts` (if any — verify or create).
- Mock targets:
  - Gateway-side: `defaultLivenessCheck`, file-system writes (use temp dirs), `fs.mkfifoSync`
  - Runner-side: `currentAdapter.pushUserTurn`, `fs.createReadStream` with mock streams
  - DO-side: `env.GATEWAY` binding (mock the bound service), the dispatch HTTP call (mock global `fetch` or extract a thin wrapper)
- No new test infra required.

### Build Verification

- `pnpm typecheck` — must pass at the workspace root after each phase
- `pnpm test` — must pass at the workspace root after each phase
- `pnpm --filter @duraclaw/agent-gateway build` — must produce a working bundle (P1 onward)
- `pnpm --filter @duraclaw/session-runner build` — must produce a working bundle (P2 onward)
- `pnpm --filter @duraclaw/orchestrator typecheck` — must pass (P3 onward)

## Verification Plan

Concrete, executable steps that prove the feature works end-to-end against a real running system. Run after all phases land.

### VP1: Live-runner dispatch round-trip

Steps:
1. Start the dev stack: `cd /data/projects/duraclaw-dev1&& scripts/verify/dev-up.sh`
   Expected: gateway listening on `127.0.0.1:9854`, orchestrator on `43054`
2. Open the orchestrator UI, log in, create a project + session, wait for session row to show "idle"
3. Send a user message "hello" via the chat input
   Expected: assistant response appears within seconds. Server logs show `[gateway] /sessions/:id/dispatch session_id=... ok` and DO logs show `dispatch result=ok`
4. Send a follow-up message "world" without waiting for the previous turn to fully complete (mid-turn)
   Expected: queued; SDK picks it up after the current turn finishes; both messages get distinct assistant responses
5. Verify FIFO exists: `ls -la /run/duraclaw/sessions/<session_id>.input`
   Expected: `prw-------` file (named pipe, mode 0600)

### VP2: Killed runner falls back to spawn-dial

Steps:
1. Start a session and send one message; let it complete and the runner go idle
2. From the gateway VPS shell: `cat /run/duraclaw/sessions/<session_id>.pid` to get the runner pid
3. `kill -9 <pid>` to simulate silent runner death (no SIGTERM handler runs)
4. Within 5 seconds, send a new message in the UI
   Expected: response arrives. DO logs show `dispatch result=ok=false status=503` followed by `triggerGatewayDial type=resume`. New runner spawns. No orphan `awaiting_response` part in the chat history.

### VP3: Long-idle resume

Steps:
1. Start a session, send "hello", get a response
2. Wait 35+ minutes for reaper to SIGTERM the idle runner
3. Verify runner is gone: `cat /run/duraclaw/sessions/<session_id>.pid` returns the file but `kill -0 <pid>` errors with ESRCH
4. Send "remember our chat?" in the UI
   Expected: dispatch returns 503 (or 404 if .pid was reaper-cleaned), DO falls back to `triggerGatewayDial(type='resume')`, new runner reads transcript and continues conversation

### VP4: Spawn-lock contention

Steps:
1. From a single shell, race two POSTs against the gateway with the same `sessionId`. The body uses a minimal `execute` cmd; the callback_url is a fake (test only checks lock contention, not actual dial-back).
   ```bash
   set -a; source /data/projects/duraclaw-dev1/.env; set +a
   PORT=$VERIFY_GATEWAY_PORT  # or 9854 for duraclaw-dev1

   BODY=$(cat <<'EOF'
   {
     "sessionId": "test-race-1",
     "callback_url": "wss://example.invalid/test",
     "callback_token": "test-token",
     "cmd": {
       "type": "execute",
       "project": "/tmp/test-race",
       "prompt": "noop",
       "model": "claude-sonnet-4-5",
       "agent": "claude"
     }
   }
   EOF
   )

   curl -s -o /tmp/r1.json -w '%{http_code}\n' -X POST \
     -H "Authorization: Bearer $CC_GATEWAY_API_TOKEN" \
     -H "Content-Type: application/json" \
     -d "$BODY" "http://127.0.0.1:$PORT/sessions/start" &
   curl -s -o /tmp/r2.json -w '%{http_code}\n' -X POST \
     -H "Authorization: Bearer $CC_GATEWAY_API_TOKEN" \
     -H "Content-Type: application/json" \
     -d "$BODY" "http://127.0.0.1:$PORT/sessions/start" &
   wait
   cat /tmp/r1.json; echo; cat /tmp/r2.json
   ```
   Expected: one response is `{"ok":true,...}` with status 200/202; the other is `{"ok":false,"error":"spawn already in flight"}` with status 409. Exactly one runner exists: `pgrep -f 'session-runner.*test-race-1' | wc -l` returns 1.
2. After ~10s the spawned runner dies (invalid callback URL → DialBackClient terminates). Verify cleanup:
   ```bash
   ls /run/duraclaw/sessions/test-race-1.* 2>/dev/null
   ```
   Expected: `.exit` present; `.lock` absent (cleaned by handleStartSession's terminal-cleanup OR reaper orphan sweep).
3. Re-fire one POST with the same sessionId; should succeed (no stale 409):
   ```bash
   curl -s -X POST -H "Authorization: Bearer $CC_GATEWAY_API_TOKEN" \
     -H "Content-Type: application/json" -d "$BODY" \
     "http://127.0.0.1:$PORT/sessions/start"
   ```
   Expected: `{"ok":true,...}`.

### VP5: Mid-stream second message preserves order

Steps:
1. Start a session and send a long-running prompt: "Count from 1 to 50 slowly, one number per line"
2. While the assistant is mid-stream, immediately send a second message: "Stop counting at 10"
3. Verify chat history shows TWO distinct assistant turns: turn 1 (counting, possibly truncated by SDK token-budget), turn 2 explicitly acknowledging the stop request (e.g., text containing "stop" / "stopping" / "OK"). Both user messages are present in send order. The first turn is NOT preempted mid-stream — the second message must wait for turn 1 to emit `result` before turn 2 begins. (Specific count value is non-deterministic; the structural property — two turns, no preemption, send-order persistence — is what matters.)
4. Server logs: two `dispatch ok` events; runner logs show two `pushUserTurn` calls in send order; gateway log confirms `acquireWriteLock` serialized them

### VP6: Two-tab race

Steps:
1. Open the same session in two browser tabs
2. From tab A, type "tab A message" and click Send
3. Within 100ms (use a stopwatch app or dev tools), from tab B, type "tab B message" and click Send
4. Both messages persist; both appear in chat in send-time order; runner processes them in order
   Expected: per-session write-lock on gateway preserves order; DO single-threading preserves persistence order

### VP7: Topology + dynamics doc updates land

Steps:
1. `grep -l "POST /sessions/:id/dispatch" docs/`
   Expected: `docs/theory/topology.md`, `docs/theory/dynamics.md`, `docs/modules/agent-gateway.md` all returned
2. `grep "the gateway has no direct channel to the runner" docs/`
   Expected: empty (the stale claim is replaced)
3. `grep "FIFO" docs/theory/topology.md docs/theory/dynamics.md docs/modules/agent-gateway.md`
   Expected: each file mentions FIFO at least once

## Implementation Hints

### Key Imports

| Module | Import | Used For |
|--------|--------|----------|
| `node:fs` (Bun-native compat) | `mkfifoSync, createReadStream, unlinkSync` | Gateway FIFO creation, runner FIFO reader |
| `node:fs/promises` | `link, mkdir, writeFile, open` | Atomic spawn-lock write via fs.link |
| `node:crypto` | `randomUUID` | client_message_id generation |
| `packages/agent-gateway/src/session-state.ts` | `defaultLivenessCheck, resolveSessionState` | Reuse for dispatch's `kill(pid,0)` check. `resolveSessionState` returns `{ found: false } \| { found: true, state: { state: 'running' \| 'crashed' \| 'completed' \| 'failed' \| 'aborted', pid?: number, exit?: ExitFile, ... } }` — see `session-state.ts:23-95` for the full type |
| `packages/agent-gateway/src/reaper.ts` | `writeExitOnce` (re-export if not yet exported) | Atomic write via fs.link for `.lock` file |
| `packages/agent-gateway/src/auth.ts` | `verifyToken` | Bearer auth on dispatch endpoint (existing pattern) |
| `packages/agent-gateway/src/handlers.ts` | `json, getSessionsDir` | Response helper, sessions-dir resolution |
| `packages/session-runner/src/types.ts` | `RunnerSessionContext` | Add inputFifoReader if needed |
| `apps/orchestrator/src/agents/session-do/runner-link.ts` | extend with `dispatchHelper` | DO-side HTTP call to /dispatch |
| `zod` | `z.object, z.string, z.union` | Body schema validation for dispatch endpoint |

### Code Patterns

**Gateway dispatch handler:**
```typescript
// packages/agent-gateway/src/handlers.ts (new function)
export async function handleDispatchMessage(
  sessionId: string,
  body: unknown,
  opts: DispatchHandlerOpts = {},
): Promise<Response> {
  const sessionsDir = opts.sessionsDir ?? getSessionsDir()
  const isAlive = opts.isAlive ?? defaultLivenessCheck

  const parsed = DispatchBodySchema.safeParse(body)
  if (!parsed.success) {
    return json(400, { ok: false, error: 'invalid body', details: parsed.error.flatten() })
  }

  const state = await resolveSessionState(sessionsDir, sessionId, isAlive)
  if (!state.found) {
    return json(404, { ok: false, error: 'session not found' })
  }
  if (state.state.state !== 'running') {
    return json(503, { ok: false, error: 'session not running', state: state.state.state })
  }

  const frame = encodeFrame(parsed.data)
  try {
    await acquireWriteLock(sessionId, async () => {
      // O_NONBLOCK prevents indefinite block if no reader is attached
      // (TOCTOU: runner died between kill(pid,0) and this open).
      const fd = await fs.open(
        `${sessionsDir}/${sessionId}.input`,
        fs.constants.O_WRONLY | fs.constants.O_NONBLOCK,
      )
      try { await fd.write(frame) } finally { await fd.close() }
    })
  } catch (err: any) {
    if (err?.code === 'ENXIO') {
      // No reader attached → treat as runner-dead.
      return json(503, { ok: false, error: 'session not running', state: 'no_reader' })
    }
    if (err?.code === 'ENOENT') {
      // FIFO does not exist (gateway pre-create skipped or unlinked early).
      return json(404, { ok: false, error: 'session not found' })
    }
    return json(500, { ok: false, error: 'dispatch write failed', details: String(err) })
  }
  return json(200, { ok: true })
}
```

**Per-session write lock:**
```typescript
// packages/agent-gateway/src/handlers.ts (new helper)
const writeLocks = new Map<string, Promise<unknown>>()
async function acquireWriteLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeLocks.get(sessionId) ?? Promise.resolve()
  const next = prev.then(fn, fn) // fn runs even if prev rejected
  writeLocks.set(sessionId, next.catch(() => undefined))
  return next
}
```

**Frame encoding:**
```typescript
// packages/agent-gateway/src/handlers.ts (new helper)
const MAX_FRAME = 10_000_000
function encodeFrame(payload: object): Buffer {
  const json = Buffer.from(JSON.stringify(payload), 'utf8')
  if (json.length > MAX_FRAME) throw new Error(`frame too large: ${json.length}`)
  const out = Buffer.alloc(4 + json.length)
  out.writeUInt32LE(json.length, 0)
  json.copy(out, 4)
  return out
}
```

**Runner-side FIFO reader (after `.pid` write, before dialBackClient.connect):**
```typescript
// packages/session-runner/src/main.ts (new code, ~line 318)
const inputFifo = nodePath.join(sessionsDir, `${sessionId}.input`)
const reader = fs.createReadStream(inputFifo, { highWaterMark: 64 * 1024 })
const seenIds = new Set<string>()
let buffer = Buffer.alloc(0)

reader.on('data', (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk])
  while (buffer.length >= 4) {
    const len = buffer.readUInt32LE(0)
    if (len < 0 || len > 10_000_000) {
      console.error('[runner] invalid frame length, destroying reader')
      reader.destroy()
      return
    }
    if (buffer.length < 4 + len) break
    const json = buffer.slice(4, 4 + len).toString('utf8')
    buffer = buffer.slice(4 + len)
    try {
      const msg = JSON.parse(json) as { message: { role: 'user'; content: unknown }; client_message_id?: string }
      if (msg.client_message_id && seenIds.has(msg.client_message_id)) {
        console.debug('[runner] dedupe drop', msg.client_message_id)
        continue
      }
      if (msg.client_message_id) {
        seenIds.add(msg.client_message_id)
        if (seenIds.size > 64) {
          // simple FIFO eviction — Set preserves insertion order
          const first = seenIds.values().next().value
          if (first) seenIds.delete(first)
        }
      }
      currentAdapter?.pushUserTurn({ role: 'user', content: msg.message.content })
    } catch (err) {
      console.error('[runner] frame parse error', err)
    }
  }
})
reader.on('error', (err) => console.error('[runner] FIFO read error', err))
```

**DO-side dispatch helper:**
```typescript
// apps/orchestrator/src/agents/session-do/runner-link.ts (new function)
export async function dispatchHelper(
  ctx: SessionDOContext,
  content: string | ContentBlock[],
  clientMessageId: string,
): Promise<{ ok: boolean; status: number; body?: unknown }> {
  const gatewayUrl = ctx.env.CC_GATEWAY_URL
  const url = `${gatewayUrl}/sessions/${ctx.state.session_id}/dispatch`
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (ctx.env.CC_GATEWAY_SECRET) {
    headers.Authorization = `Bearer ${ctx.env.CC_GATEWAY_SECRET}`
  }
  // Cap the fetch at 5s. Gateway's O_NONBLOCK FIFO write fails fast (ENXIO);
  // network blip is the realistic cause of slowness. CF Workers' 30s wall-clock
  // is the outer bound — 5s leaves headroom for the fall-back triggerGatewayDial
  // to also complete in the same RPC.
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 5_000)
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ message: { role: 'user', content }, client_message_id: clientMessageId }),
      signal: ac.signal,
    })
    if (resp.ok) return { ok: true, status: resp.status }
    const body = await resp.json().catch(() => undefined)
    return { ok: false, status: resp.status, body }
  } catch (err) {
    ctx.logEvent('rpc', `dispatch fetch failed: ${err}`, {})
    // Treat timeout / network error as 503-equivalent: caller falls back to spawn dial.
    return { ok: false, status: 0, body: { error: String(err) } }
  } finally {
    clearTimeout(timer)
  }
}
```

**Refactored `sendMessageImpl`:**
```typescript
// apps/orchestrator/src/agents/session-do/rpc-messages.ts (rewrite ~lines 90-302)
export async function sendMessageImpl(
  ctx: SessionDOContext,
  content: string | ContentBlock[],
  clientMessageId?: string,
) {
  const messageId = clientMessageId ?? crypto.randomUUID()
  await appendUserMessage(ctx, content, messageId)
  ctx.do.updateState({ status: 'running' })

  const dispatch = await dispatchHelper(ctx, content, messageId)
  if (dispatch.ok) return { ok: true, messageId }

  // 404/503/0 (timeout/network) all mean "runner not reachable via dispatch" → fall back.
  if (dispatch.status === 404 || dispatch.status === 503 || dispatch.status === 0) {
    if (ctx.state.runner_session_id) {
      return triggerGatewayDial(ctx, {
        type: 'resume',
        prompt: content,
        runner_session_id: ctx.state.runner_session_id,
        // ... existing payload fields
      })
    }
    if (ctx.state.project) {
      return triggerGatewayDial(ctx, {
        type: 'execute',
        prompt: content,
        project: ctx.state.project,
        // ... existing payload fields
      })
    }
    throw new Error('cannot send: no runner_session_id and no project')
  }

  throw new Error(`dispatch failed: status=${dispatch.status}`)
}
```

### Gotchas

- **mkfifo creation**: use `Bun.spawnSync({ cmd: ['mkfifo', '-m', '0600', path] })` unconditionally. `node:fs.mkfifoSync` support varies by Bun version; the shell-out is 3 LoC, portable on every Linux, and the tmpfs path means the syscall cost is negligible. Verify exit code; on non-zero, log and fail the spawn.
- **Gateway opens FIFO writer per-dispatch (open / write / close)**, not as a long-lived fd. Reasons: (a) `O_NONBLOCK` open returns ENXIO immediately if no reader is attached, giving the dispatch handler a fast-path 503 instead of an indefinite block; (b) per-write open avoids fd-leak bookkeeping; (c) atomic-write semantics for ≤ PIPE_BUF (4KB) hold per-open so multiple writers don't interleave a single frame.
- **Runner opens FIFO reader once at startup** with `fs.createReadStream` (default blocking mode). Reader's `'end'` event fires only when *all* writers have closed (i.e., between gateway dispatches there's a brief moment where no writer is open). Treat `'end'` as a re-open trigger — call `fs.createReadStream` again on the same path. FIFOs support unlimited re-opens; the underlying inode persists until unlinked.
- **TOCTOU between `kill(pid, 0)` and FIFO open**: `defaultLivenessCheck` runs before the gateway's open. If the runner dies in between, the open with `O_NONBLOCK | O_WRONLY` returns ENXIO (no readers), which the handler maps to 503. Without `O_NONBLOCK`, the open would block until either a reader appears or the process is killed — exhausting CF Worker's 30s wall-clock. The flag closes the window.
- **`fs.link()` for atomic spawn-lock**: write to `${path}.tmp.${pid}.${rand}` first, then `fs.link(tmp, final)`. If `link` throws EEXIST, the lock was taken; if not, unlink the tmp. This matches the existing `writeExitOnce` pattern in `reaper.ts`.
- **Per-session write-lock memory**: the `Map<sessionId, Promise>` grows over runtime. Clean up entries when the session terminates (in handleStartSession failure, or via reaper-coordinated cleanup). For now, accept the leak — session count is bounded by VPS resources.
- **`zod` may not be in the gateway package**: check `packages/agent-gateway/package.json`. If not, use a hand-written validator (~10 LoC) — adding a dep just for one schema is overkill. The session-runner uses zod (per recent specs), so it's already in the workspace.
- **`triggerGatewayDial` payload reconstruction**: the fall-back path needs the full ExecuteCommand or ResumeCommand payload (project, model, agent, identity LRU result, feature flags, codex/gemini catalogs, system_prompt, etc). Today this is built inside `triggerGatewayDial` from DO state. Don't duplicate the build logic — call `triggerGatewayDial` and let it construct internally.
- **`active_callback_token` rotation timing**: the fall-back path goes through `triggerGatewayDial`, which rotates the token. Don't rotate proactively in `sendMessageImpl` — let the fall-back path own the rotation (matches today's behavior).
- **Runner concurrent-resume guard**: `packages/session-runner/src/main.ts:97-141` checks for sibling runners on resume. The new spawn-lock works at the gateway level (different from the runner-side guard). Both are needed: gateway-lock prevents double-spawn at request time; runner-side guard prevents two-different-PIDs-attaching-to-one-resume.
- **`docs/modules/session-runner.md`**: not updated by this spec (per interview decision). If it exists and enumerates ingress channels, it'll be slightly stale until a follow-up — flag in the PR description.
- **DO test mocking**: `env.GATEWAY` is a Cloudflare service binding shape. Tests should mock at the dispatch helper level (`dispatchHelper`), not at the binding level. Inject the helper as a dep into `sendMessageImpl` for easier testing, or mock `fetch` globally.
- **Spawn-lock cleanup**: the `.lock` file should be removed when the runner pid is observed alive. Add this to `handleStartSession`'s fork-then-confirm flow (or the existing pid-write completion). If the spawn fails, also unlink. Reaper's 5-min orphan-window catches anything missed.

### Reference Docs

- [Bun fs API compat](https://bun.sh/docs/runtime/nodejs-apis#node-fs) — confirms which `node:fs` functions Bun supports natively
- [POSIX FIFO semantics (mkfifo(7))](https://man7.org/linux/man-pages/man7/fifo.7.html) — atomic write up to PIPE_BUF (4KB on Linux), reader blocks until writer opens
- [Cloudflare service bindings (RPC) — fetch from a Worker to a public URL](https://developers.cloudflare.com/workers/runtime-apis/fetch/) — DO uses plain `fetch()` to the gateway; CF Workers' 30s wall-clock applies
- [`docs/theory/topology.md`](../../docs/theory/topology.md) — the load-bearing edges duraclaw assumes; this spec adds one (gateway → runner FIFO)
- [`docs/theory/dynamics.md`](../../docs/theory/dynamics.md) — the spawn / follow-up / resume / orphan flows that this spec touches
- [`docs/modules/agent-gateway.md`](../../docs/modules/agent-gateway.md) — gateway endpoint inventory; this spec adds `POST /sessions/:id/dispatch`
- [`planning/research/2026-04-30-150-gateway-liveness-authority.md`](../research/2026-04-30-150-gateway-liveness-authority.md) — full P0 research synthesis with item-by-item findings
- [`planning/specs/101-session-do-refactor.md`](./101-session-do-refactor.md) — recent precedent for hard-cut migration (P2 `runner_session_id` rename via migration v18)
- Issue [#150](https://github.com/baseplane-ai/duraclaw/issues/150) — original problem statement and production-evidence sessions
- Symptom-patch commits: `ad1ee7b` (role-rank tie-breaker, regression coverage to keep), `670796d` (`clearStaleGatewayConnection`, deleted by this spec), `7ef6c22` (`AWAITING_LIVE_CONN_GRACE_MS`, deleted by this spec)
