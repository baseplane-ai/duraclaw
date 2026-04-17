---
date: 2026-04-17
topic: Decouple session lifecycle from dial-back WebSocket
type: feasibility
status: complete
github_issue: null
items_researched: 3
---

# Research: Decouple Session Lifecycle from Dial-back WebSocket

## Context

When the orchestrator (CF Worker) redeploys, the gateway's outbound WS connection drops. The gateway retries 3 times (1s, 3s, 9s) then **aborts the running SDK session**. This kills real work because the observer disappeared. The DO also struggles with long-running outbound connections due to hibernation.

The goal: the SDK session on the VPS should run independently of whether anyone is watching it. The dial-back WS becomes an observation channel, not a lifecycle controller.

## Scope

Three areas investigated:

1. **Current coupling** — where exactly the adapter lifecycle is tied to the WS
2. **ReconnectableChannel** — what exists, what it's missing
3. **DO-side impact** — what changes on the orchestrator

## Findings

### 1. Current Coupling Points

**`dialback.ts:141-228` — adapter runs inside `dialOutboundWs()`:**

The adapter is started on first WS open (line 162-163):
```typescript
if (attempt === 0) {
  const channel = new ReconnectableChannel(ws)
  const sessionPromise = adapter.execute(channel, cmd, ctx)
  // ...
}
```

On WS close, after 3 failed reconnects (line 214-218):
```typescript
ctx.abortController.abort()  // ← kills the SDK session
dialbackSessions.delete(sessionId)
```

**The problem is structural:** `dialOutboundWs()` owns both the connection lifecycle AND the session lifecycle. They need to be separate.

**`session-channel.ts:48-71` — ReconnectableChannel:**

The channel abstraction exists but is thin — it swaps the WS reference but has no buffering. If `send()` is called while the WS is disconnected, it throws. The adapter sees the error and may fail.

**`server.ts:328-374` — POST /sessions/start:**

Creates `GatewaySessionContext` and immediately calls `dialOutboundWs()`. The session ID is returned to the DO, but the session only starts once the WS opens. No session exists independently of the dial.

**`server.ts:674-702` — Direct WS close handler:**

For direct WS connections (non-dialback), closing the WS aborts the session immediately:
```typescript
ctx.abortController.abort()
```

### 2. What ReconnectableChannel Needs

Current: thin wrapper, swaps WS, no buffering, no awareness of connection state.

Missing:
- **Event buffer** — when WS is down, events should queue (ring buffer, bounded)
- **Connection state tracking** — `isConnected()` so callers can check
- **Replay on reconnect** — drain buffer when new WS connects
- **Send-while-disconnected tolerance** — buffer instead of throw

### 3. DO-Side Impact

**Minimal changes needed.** The DO doesn't need to change its connection handling. It already:
- Handles `onClose` for the gateway WS (line 222-241)
- Has recovery logic via `recoverFromDroppedConnection()` (line 346-383)
- Can re-trigger `triggerGatewayDial()` on resume

The key DO-side benefit: the 5-minute stale threshold + watchdog becomes unnecessary for the common case. If the gateway session keeps running, the DO just reconnects and catches up. The watchdog remains as a safety net for true gateway failures.

**One change:** The recovery path currently transitions to `idle` immediately on WS drop. With decoupling, the DO should distinguish "WS dropped but session still running on gateway" from "session actually ended." This can be done via a `GET /sessions/:id/status` HTTP check before transitioning.

## The Fix

### Gateway-side (packages/agent-gateway)

**Split `dialOutboundWs()` into two independent lifecycles:**

1. **Session lifecycle** — `startSession(cmd, ctx, adapter)` → runs adapter against a `BufferedChannel`, returns immediately. Session lives in `activeSessions` map keyed by session ID. Survives WS drops.

2. **Connection lifecycle** — `dialOutboundWs(callbackUrl, sessionId)` → connects WS, pipes `BufferedChannel` events to WS, routes incoming commands to session context. Reconnects indefinitely (not 3 attempts). Connection dying doesn't abort session.

**New `BufferedChannel`** (extends `ReconnectableChannel`):
```
adapter.send(event) → buffer.push(event)
                      if ws connected: flush immediately
                      if ws disconnected: queue (ring buffer, 10K events)
ws connects → replay buffered events, then live-pipe
ws disconnects → events keep buffering
```

**New session map:**
```typescript
const activeSessions = new Map<string, {
  ctx: GatewaySessionContext
  channel: BufferedChannel
  promise: Promise<void>  // adapter completion
}>()
```

**New HTTP endpoints:**
- `GET /sessions/:id/status` — returns session state (running/waiting/completed/failed)
- Existing `POST /sessions/start` — modified to separate session start from dial

**Session termination:** Only via:
- Explicit `abort` command from DO
- Adapter completes naturally (result/error)
- Server shutdown (SIGTERM)

### DO-side (apps/orchestrator)

**Minimal changes:**
- `onClose` for gateway WS: instead of immediately recovering, check `GET /sessions/:id/status` first. If session still running, just log "WS dropped, session alive" and wait for reconnect.
- Watchdog: keep as safety net, but reduce stale threshold since reconnect is now reliable.

## Implementation Phases

### Phase 1: BufferedChannel + session lifecycle split
- New `BufferedChannel` class with ring buffer and replay
- Extract session start from `dialOutboundWs()` into `startSession()`
- `dialOutboundWs()` becomes connection-only (no adapter start)
- Add `GET /sessions/:id/status` endpoint
- Remove 3-retry limit on reconnect (retry indefinitely with backoff cap)

### Phase 2: DO-side resilience
- `onClose` checks gateway session status before recovering
- Reduce/remove stale threshold
- Keep watchdog as safety net for gateway process crash

### Phase 3: Cleanup
- Remove dead code paths (the old tight coupling)
- Update tests
- Verify deploy-during-session scenario

## Recommendations

1. **Do this.** It's a clean, contained change mostly in `dialback.ts` + `session-channel.ts`. The DO changes are minimal.
2. **BufferedChannel ring buffer: 10K events, ~50MB cap.** A typical session produces hundreds of events. 10K is generous for any reconnect gap.
3. **Reconnect backoff: cap at 30s.** No reason to stop trying. `1s, 3s, 9s, 27s, 30s, 30s, ...`
4. **Don't change the direct WS path** (browser→gateway). That's a different use case and works fine today.

## Open Questions

1. **Buffer persistence?** If the gateway process itself restarts, the buffer is lost. The SDK session files on disk survive, so hydration from gateway HTTP still works. Probably not worth persisting the buffer.
2. **Max session lifetime without observer?** Should there be a timeout for sessions that run with no observer connected? Current thinking: no — let the SDK's own limits (max_turns, max_budget) handle it. The DO will eventually reconnect.
