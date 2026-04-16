---
initiative: flip-gateway-ws-direction
type: project
issue_type: refactor
status: approved
priority: high
github_issue: 43
created: 2026-04-16
updated: 2026-04-16
phases:
  - id: p1
    name: "Gateway: accept start-session HTTP, dial outbound WS"
    tasks:
      - "Add POST /sessions/start endpoint to gateway server.ts"
      - "Implement outbound WS dialer that connects to DO callback_url"
      - "Create SessionChannel abstraction over ServerWebSocket and outbound WebSocket"
      - "Refactor adapters to use SessionChannel instead of ServerWebSocket<WsData>"
      - "Wire heartbeat, close, and reconnect logic on the outbound WS"
    test_cases:
      - "bun test adapters — all existing adapter tests pass with SessionChannel"
      - "bun test server — POST /sessions/start returns 200 and dials callback_url"
      - "bun test server — POST /sessions/start with bad auth returns 401"
  - id: p2
    name: "DO: accept inbound gateway WS via Hibernation API"
    tasks:
      - "Add WORKER_PUBLIC_URL to Env type and wrangler.toml"
      - "Add gateway WS auth bypass in server.ts (token-based, skip Better Auth)"
      - "Override shouldSendProtocolMessages to suppress for gateway connections"
      - "Track gateway connection ID in DO SQLite (survives hibernation)"
      - "Replace connectAndStream with triggerGatewayDial (HTTP POST to gateway)"
      - "Route inbound gateway WS messages to handleGatewayEvent via onMessage"
      - "Update sendToGateway to use the persisted gateway Connection"
      - "Update broadcastToClients to exclude gateway connection"
    test_cases:
      - "pnpm typecheck passes"
      - "Gateway connection tagged correctly, browser connections unaffected"
      - "State broadcast excludes gateway connection"
  - id: p3
    name: "Cleanup: remove outbound WS, simplify alarm/recovery"
    tasks:
      - "Delete connectToExecutor and sendCommand from vps-client.ts"
      - "Remove private vpsWs field and all references"
      - "Simplify alarm to watchdog-only (no keepalive ping)"
      - "Simplify recoverFromDroppedConnection (gateway reconnects, not DO)"
      - "Remove HEARTBEAT_INTERVAL_MS from claude adapter (gateway owns heartbeat now)"
    test_cases:
      - "pnpm typecheck passes"
      - "pnpm build succeeds for both packages"
      - "No references to vpsWs remain in session-do.ts"
  - id: p4
    name: "Integration test: full session lifecycle"
    tasks:
      - "Start gateway and worker locally"
      - "Spawn a session via UI or API, verify events stream through"
      - "Verify long tool call (>60s) does not drop the session"
      - "Verify sendMessage (follow-up), interrupt, stop, and rewind work"
      - "Verify resume after idle works (gateway reconnects)"
    test_cases:
      - "Session completes without connection-lost errors"
      - "No alarm-based recovery triggered during normal operation"
      - "Gateway reconnects after DO restarts and session resumes cleanly"
---

# 43: Flip Gateway→DO WebSocket Direction for Hibernation Support

## Overview

SessionDO currently dials an outbound WebSocket to the VPS gateway to stream session events. Outbound WS from a DO doesn't benefit from the Hibernation API — the DO must stay in memory for the socket handle to remain valid. During long tool calls, the DO can evict, killing the socket and stalling the session. This refactor flips the WS direction so the gateway dials *into* the DO via the standard Agent WS endpoint, making the connection hibernatable. The DO can then freely evict between events — each gateway message wakes it automatically.

## Feature Behaviors

### B1: Gateway Start-Session Endpoint

**Core:**
- **ID:** gateway-start-session
- **Trigger:** DO sends HTTP POST to `gateway/sessions/start` after spawn/resume
- **Expected:** Gateway validates auth, opens outbound WS to the provided `callback_url`, sends the session command (execute/resume) over that WS, and begins streaming adapter events back
- **Verify:** POST with valid payload returns `{ ok: true, session_id }`. Gateway opens WS to callback_url within 2s.
**Source:** `packages/agent-gateway/src/server.ts` (new endpoint, lines ~325 area)

#### API Layer
- **Endpoint:** `POST /sessions/start`
- **Auth:** Bearer token (same `CC_GATEWAY_SECRET`)
- **Request:**
  ```json
  {
    "callback_url": "wss://worker.example.com/agents/session-agent/<do-id>?role=gateway&token=<one-shot>",
    "cmd": { "type": "execute", "project": "...", "prompt": "...", ... }
  }
  ```
- **Response:** `200 { ok: true, session_id: "<uuid>" }` or `400/401 { ok: false, error: "..." }`
- **Behavior:** Gateway holds the outbound WS for the lifetime of the SDK session. Adapter events (assistant, tool_result, result, error, etc.) are sent as JSON frames on the WS. Commands from DO (abort, answer, stream-input, interrupt, etc.) arrive as JSON frames on the same WS.

### B2: SessionChannel Abstraction

**Core:**
- **ID:** session-channel
- **Trigger:** Adapter needs to send events to the connected client (currently `ServerWebSocket<WsData>`)
- **Expected:** A thin `SessionChannel` interface wraps both Bun's `ServerWebSocket<WsData>` (legacy/direct connections) and Bun's outbound `WebSocket` (dial-back connections) with a unified `.send(json)` and `.close()` API
- **Verify:** `claude.test.ts`, `codex.test.ts`, `opencode.test.ts` pass without changes to their test logic (only the import/type changes)
**Source:** `packages/agent-gateway/src/adapters/types.ts:13-23` (modify AgentAdapter interface)

#### API Layer
```typescript
// New: packages/agent-gateway/src/session-channel.ts
export interface SessionChannel {
  send(data: string): void
  close(code?: number, reason?: string): void
  readonly readyState: number
}

// Wraps Bun ServerWebSocket for existing direct WS connections
export function fromServerWebSocket(ws: ServerWebSocket<WsData>): SessionChannel

// Wraps Bun outbound WebSocket for dial-back connections
export function fromWebSocket(ws: WebSocket): SessionChannel
```

### B3: DO Accepts Gateway WS via Hibernation API

**Core:**
- **ID:** do-accept-gateway-ws
- **Trigger:** Gateway dials `wss://<WORKER_PUBLIC_URL>/agents/session-agent/<do-id>?role=gateway&token=<token>`
- **Expected:** `server.ts` WS handler detects `role=gateway` query param and uses token-based auth instead of Better Auth session. DO's `onConnect` recognizes the gateway connection, validates the one-shot token against SQLite, and persists the `connection.id` in DO SQLite for hibernation recovery. Protocol messages (identity, state, MCP) are suppressed for this connection.
- **Verify:** Gateway WS accepted without browser session cookie. No CF_AGENT_IDENTITY/CF_AGENT_STATE/CF_AGENT_MCP_SERVERS frames sent. Connection ID survives DO hibernation (stored in SQLite).
**Source:** `apps/orchestrator/src/server.ts:7-36` (modify WS auth), `apps/orchestrator/src/agents/session-do.ts:134` (modify onConnect)

#### API Layer
- **WS Route:** `/agents/session-agent/<do-id>?role=gateway&token=<one-shot-token>` (matches existing `WS_ROUTE` regex in `server.ts:7`)
- **Auth bypass:** In `server.ts`, when `role=gateway` query param is present, skip `getRequestSession()` and instead pass the token through to the DO via `x-gateway-token` header. DO validates token in `onConnect`.

#### Data Layer
- **New env:** `WORKER_PUBLIC_URL` (e.g., `https://duraclaw.workers.dev`) — added to `Env` type and wrangler.toml vars
- **Connection tagging:** Do NOT use `connection.setState({ role: 'gateway' })` — this conflicts with the Agent SDK's internal `_cf_`-prefixed flags on the connection attachment. Instead, persist gateway connection ID in DO SQLite: `INSERT OR REPLACE INTO kv (key, value) VALUES ('gateway_conn_id', connection.id)`. On hibernation wake, re-derive by reading from SQLite and matching against `getConnections()`.
- **One-shot token storage:** `INSERT INTO kv (key, value) VALUES ('gateway_token', <uuid>)` with a TTL check (store `gateway_token_expires` = now + 60s). Validate in `onConnect`, then delete.

### B4: DO Triggers Gateway Dial-Back Instead of Dialing Out

**Core:**
- **ID:** do-trigger-dialback
- **Trigger:** `spawn()`, `resumeDiscovered()`, `sendMessage()` (resume path), `resubmitMessage()` — any code path that currently calls `connectAndStream(cmd)`
- **Expected:** Instead of opening an outbound WS, DO sends `POST <CC_GATEWAY_URL>/sessions/start` with a `callback_url` built from `WORKER_PUBLIC_URL + /agents/session-agent/<do-id>?role=gateway&token=<token>`. Gateway then dials back.
- **Verify:** No outbound WS opened from DO. Gateway dials in within 5s. Events begin streaming.
**Source:** `apps/orchestrator/src/agents/session-do.ts:168-213` (replace connectAndStream)

#### API Layer
- DO generates a one-shot token: `crypto.randomUUID()` stored in `ctx.storage` with a 60s TTL
- Callback URL format: `wss://<WORKER_PUBLIC_URL>/agents/session-agent/<do-id>?role=gateway&token=<one-shot-token>`
- HTTP POST to gateway: standard `fetch()` with Bearer auth

### B5: Bidirectional Command Routing Over Inbound WS

**Core:**
- **ID:** bidi-command-routing
- **Trigger:** User actions that need to reach the gateway: `abort`, `stop`, `answer`, `stream-input`, `interrupt`, `rewind`, `get-context-usage`, `set-model`, `set-permission-mode`, `stop-task`, `permission-response`
- **Expected:** `sendToGateway(cmd)` sends JSON frames over the tagged gateway Connection (the inbound WS from gateway). Same socket, reverse direction.
- **Verify:** `interrupt()` callable sends interrupt command to gateway. Gateway receives it and aborts the SDK session.
**Source:** `apps/orchestrator/src/agents/session-do.ts:582-588` (modify sendToGateway)

### B6: Gateway-Side Reconnect on WS Drop

**Core:**
- **ID:** gateway-reconnect
- **Trigger:** The outbound WS from gateway to DO drops (network blip, DO restart, tunnel hiccup)
- **Expected:** Gateway detects close, and if the SDK session is still running, retries the WS connection to the same callback_url (up to 3 attempts with exponential backoff: 1s, 3s, 9s). If all retries fail, the adapter session is aborted.
- **Verify:** Kill the WS mid-session. Gateway reconnects. Events resume on the new WS.
**Source:** `packages/agent-gateway/src/server.ts` (new reconnect logic in dial-back handler)

### B7: Simplified Alarm Watchdog

**Core:**
- **ID:** simplified-alarm
- **Trigger:** Session enters `running` or `waiting_gate` status
- **Expected:** Alarm fires every 60s (up from 30s). No keepalive ping sent. Only checks: if no gateway connection exists and session has been stale for >5 minutes, call `recoverFromDroppedConnection()`. Recovery is simpler: just transition to idle (gateway owns reconnect, not DO).
- **Verify:** During normal operation, alarm fires but takes no action. After 5 min with no gateway WS, session transitions to idle.
**Source:** `apps/orchestrator/src/agents/session-do.ts:216-267` (simplify alarm handler)

### B8: Browser Broadcast Excludes Gateway Connection

**Core:**
- **ID:** broadcast-filter
- **Trigger:** Any `broadcastToClients()` or `broadcastGatewayEvent()` call
- **Expected:** Gateway-tagged connection is excluded from broadcasts. Only browser connections receive state updates, messages, and gateway events.
- **Verify:** Connect a browser WS and a gateway WS. Broadcast a message. Only browser WS receives it.
**Source:** `apps/orchestrator/src/agents/session-do.ts:325-333` (modify broadcastToClients)

## Non-Goals

- **Dual-path / feature flag**: No backward-compat path. The old outbound-WS-from-DO code is deleted entirely.
- **Gateway buffering/queuing**: If the WS to DO drops, gateway retries the connection — it does not buffer events in a queue. Events during the retry window are lost (acceptable; transcript hydration on getMessages fills gaps).
- **Multi-gateway support**: One gateway per session. No fan-out or load balancing.
- **Auth token rotation**: One-shot tokens are UUID-based, not cryptographic JWTs. Sufficient for pre-prod; can upgrade later.
- **HTTP push per event (alternative B)**: We chose WS-direction-flip over HTTP-push-per-event. HTTP push remains a future option if we need to decouple further.

## Implementation Phases

See frontmatter for phase details. Summary:

**P1 — Gateway side (adapters + HTTP endpoint):** Build `SessionChannel`, refactor adapters to use it, add `POST /sessions/start` that dials outbound WS. All existing adapter tests must pass.

**P2 — DO side (accept inbound WS, stop dialing out):** Add `WORKER_PUBLIC_URL` env. Override `onConnect` to tag gateway connections. Replace `connectAndStream` with `triggerGatewayDial`. Route inbound messages to `handleGatewayEvent`. Filter broadcasts.

**P3 — Cleanup:** Delete dead code (`vpsWs`, `connectToExecutor`, alarm pings). Simplify recovery. Typecheck + build.

**P4 — Integration test:** End-to-end session lifecycle through the new flow.

## Verification Plan

### VP1: Gateway starts session via HTTP
```bash
# Start gateway
cd packages/agent-gateway && bun run src/server.ts &

# POST to start session (mock callback_url — expect connection attempt)
curl -s -X POST http://localhost:9877/sessions/start \
  -H "Authorization: Bearer $CC_GATEWAY_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"callback_url":"ws://localhost:9999/mock","cmd":{"type":"execute","project":"test","prompt":"hello"}}'
# Expected: { "ok": true, "session_id": "..." }
```

### VP2: Adapter tests pass with SessionChannel
```bash
cd packages/agent-gateway && bun test
# Expected: all tests pass (claude, codex, opencode, server, etc.)
```

### VP3: Typecheck passes
```bash
pnpm typecheck
# Expected: 0 errors
```

### VP4: Build succeeds
```bash
pnpm build
# Expected: both packages build without errors
```

### VP5: Full session lifecycle via UI
```bash
# Deploy both services, open browser
chrome-devtools-axi open https://duraclaw.workers.dev
# Login, create session, send prompt
# Expected: events stream in, no "connection lost" errors
# Wait for a tool call >30s
# Expected: session continues after tool call completes (no stall)
```

### VP6: No outbound WS from DO
```bash
# Search for removed code
rg "connectToExecutor|new WebSocket" apps/orchestrator/src/
# Expected: no matches
rg "vpsWs" apps/orchestrator/src/agents/session-do.ts
# Expected: no matches
rg "private vpsWs" apps/orchestrator/src/
# Expected: no matches
```

## Implementation Hints

### Key Imports
- `import type { ServerWebSocket } from 'bun'` — existing, for `fromServerWebSocket`
- `import { type Connection, type ConnectionContext } from 'agents'` — existing in session-do
- `import { generateActionToken } from '~/lib/action-token'` — existing token util, may be reusable for one-shot tokens

### Code Patterns

**Auth bypass in server.ts for gateway WS:**
```typescript
// In server.ts WS upgrade handler
const role = url.searchParams.get('role')
if (role === 'gateway') {
  // Gateway auth: validate token in the DO, not via Better Auth
  // Pass token via header for DO to validate in onConnect
  const headers = new Headers(request.headers)
  headers.set('x-partykit-room', sessionId)
  headers.set('x-gateway-token', url.searchParams.get('token') ?? '')
  const wsRequest = new Request(request, { headers })
  return stub.fetch(wsRequest)
}
// ... existing Better Auth path for browser connections
```

**Tagging connections in Agent framework (session-do.ts):**
```typescript
// In onConnect — detect gateway by query param
onConnect(connection: Connection, ctx: ConnectionContext) {
  const url = new URL(ctx.request.url)
  const role = url.searchParams.get('role')
  if (role === 'gateway') {
    const token = ctx.request.headers.get('x-gateway-token')
    if (!this.validateAndConsumeGatewayToken(token)) {
      connection.close(4001, 'Invalid token')
      return
    }
    // Persist in SQLite — survives hibernation (connection.setState conflicts with SDK internals)
    this.sql`INSERT OR REPLACE INTO kv (key, value) VALUES ('gateway_conn_id', ${connection.id})`
    return // Skip replay, no protocol messages (handled by shouldSendProtocolMessages)
  }
  // ... existing browser onConnect logic
}
```

**Suppressing protocol messages for gateway:**
```typescript
shouldSendProtocolMessages(_connection: Connection, ctx: ConnectionContext): boolean {
  const url = new URL(ctx.request.url)
  return url.searchParams.get('role') !== 'gateway'
}
```

**Outbound WS from Bun (gateway dialing DO):**
```typescript
const ws = new WebSocket(callbackUrl)
ws.onopen = () => { /* send execute/resume command */ }
ws.onmessage = (event) => { /* route DO→gateway commands */ }
ws.onclose = () => { /* reconnect logic */ }
```

**Filtering broadcasts:**
```typescript
private getGatewayConnectionId(): string | null {
  try {
    const rows = this.sql<{ value: string }>`SELECT value FROM kv WHERE key = 'gateway_conn_id'`
    return rows.length > 0 ? rows[0].value : null
  } catch { return null }
}

private broadcastToClients(data: string) {
  const gwConnId = this.getGatewayConnectionId()
  for (const conn of this.getConnections()) {
    if (conn.id === gwConnId) continue
    try { conn.send(data) } catch { /* closed */ }
  }
}
```

### Gotchas

1. **Do NOT use `connection.setState()` for tagging:** The Agent SDK wraps `connection.state` with internal `_cf_`-prefixed flags (readonly, no-protocol) via `_ensureConnectionWrapped` (`agents/src/index.ts:1625`). Calling `connection.setState({ role: 'gateway' })` directly overwrites these internal flags. Instead, persist the gateway `connection.id` in DO SQLite (`kv` table). On hibernation wake, re-derive by reading from SQLite and matching against `getConnections()`.

2. **WS URL scheme:** `WORKER_PUBLIC_URL` will be `https://...`. Convert to `wss://` when building the callback URL. The WS upgrade path matches the regex in `server.ts:7`: `/agents/session-agent/<do-id>`. The DO ID is a 64-char hex string (from `newUniqueId`) or a name (from `idFromName`).

3. **Gateway outbound WS is Bun's `WebSocket` (client), not `ServerWebSocket`:** Different API surface — `ws.send(data)` works the same, but close codes, readyState, and event handlers differ slightly. The `SessionChannel` abstraction exists to paper over this.

4. **Race condition on dial-back:** Between DO's POST and gateway's WS connect, the DO must be ready to accept. Since the Agent framework always accepts WS upgrades via `onConnect`, this is fine — but validate the one-shot token before processing any messages.

5. **sendMessage resume path:** When a user sends a message to an idle-but-resumable session, DO currently calls `connectAndStream` with a resume command. With the flip, this becomes another `triggerGatewayDial` + the gateway will reconnect with a resume command.

7. **Auth bypass in server.ts is gateway-only:** The `role=gateway` query param triggers token-based auth that skips Better Auth. The token is a one-shot UUID stored in DO SQLite with a 60s TTL — consumed on first use. This is NOT a general-purpose auth bypass. The `x-user-id` header is not set for gateway connections (no user session). DO must handle `userId` being null for gateway-originated WS messages.

6. **Existing `hydrateFromGateway()` HTTP call:** This uses `CC_GATEWAY_URL` converted from `wss:` to `https:`. This still works — it's a separate HTTP call to the gateway's REST API, not the WS path. Keep it as-is for getMessages.

### Reference Docs
- [Cloudflare Durable Objects Hibernation API](https://developers.cloudflare.com/durable-objects/api/hibernatable-websockets/) — explains acceptWebSocket, webSocketMessage, eviction behavior
- [Agents SDK source: Agent.onConnect](cloudflare-agents/packages/agents/src/index.ts:1351) — how connections are wrapped and protocol messages dispatched
- [Agents SDK: shouldSendProtocolMessages](cloudflare-agents/packages/agents/src/index.ts:1828) — override point for suppressing protocol frames
- [Bun WebSocket client API](https://bun.sh/docs/api/websockets) — outbound WS from gateway
