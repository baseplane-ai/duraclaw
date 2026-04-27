---
initiative: session-store-failover
type: project
issue_type: feature
status: approved
priority: high
github_issue: 119
created: 2026-04-27
updated: 2026-04-27
phases:
  - id: p1a
    name: "DO transcript storage (server-side)"
    tasks:
      - "Add DO SQLite migration v26: session_transcript table (project_key, session_id, subpath, seq INTEGER, entry_json TEXT, created_at TEXT)"
      - "Add shared-types: TranscriptRpcRequest / TranscriptRpcResponse command types with rpc_id correlation"
      - "Add SessionDO RPC handlers: appendTranscript, loadTranscript, listTranscriptSubkeys, deleteTranscript"
      - "Spike: determine whether SDK routes tool-results through SessionStore.append() or writes to disk directly. Document finding in P1a PR. Result gates P1b scope (Branch A: skip v27 + mirror; Branch B: keep v27 + mirror)"
      - "Add transcript GC in DO onStart: DELETE FROM session_transcript WHERE created_at < datetime('now', '-30 days')"
      - "Add debug endpoint: GET /api/sessions/:id/debug/transcript-count (dev-only) for VP-1 verification"
      - "Unit tests: DO RPC handlers with mock SQL (insert, load ordering, subkey enumeration, delete)"
    test_cases:
      - "appendTranscript inserts entries with incrementing seq per (session_id, subpath)"
      - "loadTranscript returns entries in seq order, null for unknown session"
      - "listTranscriptSubkeys returns distinct subpath values for a session"
      - "deleteTranscript removes all entries for a session"
      - "Transcript GC prunes entries older than 30 days on DO wake"
  - id: p1b
    name: "SessionStore adapter (runner-side)"
    tasks:
      - "Implement TranscriptRpc: request/response multiplexer over dial-back WS with rpc_id correlation, 30s per-call timeout, and reconnect-safe retry"
      - "Implement DuraclavSessionStore adapter in session-runner (SessionStore interface delegating to TranscriptRpc)"
      - "Wire adapter into claude-runner.ts query() options behind session_store_enabled feature flag (injected by DO from D1 feature_flags)"
      - "Add session_store_enabled field to ExecuteCommand and ResumeCommand in shared-types"
      - "Unit tests: adapter contract using InMemorySessionStore as reference, TranscriptRpc timeout and error handling"
    test_cases:
      - "Runner with session_store_enabled=true appends transcript entries to DO SQLite during a normal session"
      - "Runner with session_store_enabled=true can resume a session from DO SQLite transcript (not filesystem)"
      - "Runner with session_store_enabled=false behaves identically to today (filesystem-only)"
      - "TranscriptRpc times out after 30s and throws, adapter surfaces error to SDK"
      - "TranscriptRpc retries once on WS disconnect, then throws"
  - id: p2
    name: "Runner identity abstraction + gateway multi-HOME spawn"
    tasks:
      - "Add D1 table: runner_identities (id TEXT PK, name TEXT, home_path TEXT, status TEXT, cooldown_until TEXT, last_used_at TEXT, created_at TEXT, updated_at TEXT)"
      - "Add D1 migration: ALTER TABLE agent_sessions ADD COLUMN identity_name TEXT"
      - "Extend ExecuteCommand/ResumeCommand with optional runner_home field in shared-types"
      - "Extend gateway handleStartSession to accept runner_home in request body and set HOME in spawn env"
      - "Add identity CRUD API endpoints: GET/POST/PUT/DELETE /api/admin/identities"
      - "Wire identity selection into DO triggerGatewayDial: LRU round-robin — SELECT WHERE status='available' AND (cooldown_until IS NULL OR cooldown_until < datetime('now')) ORDER BY last_used_at ASC LIMIT 1"
      - "On identity selection, UPDATE last_used_at and persist identity_name to agent_sessions row via broadcastSessionRow"
    test_cases:
      - "Gateway spawns runner with custom HOME when runner_home is provided in start payload"
      - "Runner authenticates using credentials from the overridden HOME"
      - "GET /api/admin/identities returns all configured identities with status and cooldown info"
      - "Identity with status='cooldown' and future cooldown_until is skipped during selection"
      - "LRU: after using work1 then work2, next selection picks work1 (least recently used)"
      - "Cooldown expiry: identity with cooldown_until in the past is returned by selection query (lazy expiry, no explicit cleanup)"
      - "Zero identities: if runner_identities table is empty, DO spawns without runner_home override (current behavior preserved)"
      - "agent_sessions.identity_name is populated and visible via broadcastSessionRow"
  - id: p3
    name: "Automatic failover on rate_limit / auth error"
    tasks:
      - "Extend RateLimitEvent with rate_limit_info.resets_at field extraction"
      - "Add DO failover handler: on rate_limit event, mark current identity as cooldown (cooldown_until from resets_at or +30min fallback), select next identity via LRU, spawn new runner with resume + sessionStore + runner_home"
      - "Add DO failover handler: on SDK result with error='rate_limit' or 'authentication_failed', trigger same failover flow"
      - "Add waiting_identity alarm: when no identity available, DO sets alarm(60s). On alarm wake, re-query D1 for available identities. If found, spawn resume. If not, re-arm alarm. Max 30 re-arms (30 min total wait), then set session status='failed' with error 'All identities exhausted'."
      - "Add FailoverEvent to GatewayEvent union for UI observability"
      - "Add debug endpoint: POST /api/sessions/:id/debug/simulate-rate-limit { resets_at?: string } (dev-only, behind ENABLE_DEBUG_ENDPOINTS feature flag). Injects a synthetic RateLimitEvent into handleGatewayEvent() as if it arrived over WS — exercises the real failover path including identity selection, cooldown write, and resume spawn."
      - "Add UI StatusBar handling for 'failover' and 'waiting_identity' display states"
    test_cases:
      - "When runner emits rate_limit, DO automatically spawns new runner under different identity and resumes"
      - "Resumed runner continues from full transcript (no message loss)"
      - "Cooldown-expired identity becomes available again for future sessions"
      - "If no identities are available, session enters 'waiting_identity' status with user-visible message and retries via alarm every 60s"
      - "After 30 alarm iterations with no available identity, session fails with 'All identities exhausted'"
      - "UI shows 'Switching accounts...' during failover, 'All accounts on cooldown' during waiting_identity"
  - id: p4
    name: "Admin UI + setup tooling"
    tasks:
      - "Add Settings > Identities section: list identities, add/remove, view cooldown status"
      - "Add identity setup script: scripts/setup-identity.sh --name work2 --home /srv/duraclaw/homes/work2 (creates HOME dir, copies .claude skeleton, prompts for auth)"
      - "Add session detail: show which identity is running the current session (read identity_name from sessionsCollection)"
      - "Add docs: CLAUDE.md section on identity management"
    test_cases:
      - "Admin can add/remove identities from Settings UI"
      - "setup-identity.sh creates HOME dir with correct .claude structure"
      - "Session sidebar shows current identity name"
---

# GH#119: Account failover via shared Claude project session store

## Overview

When a Claude runner hits a rate limit or auth error mid-session, the
session is currently lost or requires manual intervention. This feature
enables automatic failover: the DO detects the limit, selects a different
runner identity (with its own Claude auth credentials), and resumes the
session using the SDK's `SessionStore` API to load the transcript from
DO SQLite instead of the filesystem. The user sees a brief interruption
and a notification — no message loss, no manual action.

## Feature Behaviors

### B1: SessionStore adapter (runner-side)

**Core:**
- **ID:** session-store-adapter
- **Trigger:** Runner starts with `ENABLE_SESSION_STORE` feature flag enabled (read from D1 feature_flags via DO injection, same pattern as `titler_enabled`)
- **Expected:** Runner instantiates a `DuraclavSessionStore` that implements the SDK `SessionStore` interface and passes it to `query({sessionStore})`. Every SDK transcript operation (append, load, listSubkeys, delete) routes through the adapter to the SessionDO via RPC over the dial-back WS.
- **Verify:** Start a session with the feature flag on. After 3+ turns, check that `SELECT count(*) FROM session_transcript WHERE session_id = ?` in the SessionDO returns entries. Resume the session and confirm the SDK loads from the store (not from `~/.claude/projects/`).
- **Source:** `packages/session-runner/src/claude-runner.ts:550-572` (options construction)

#### Data Layer

New file: `packages/session-runner/src/session-store-adapter.ts`

```typescript
import type { SessionStore } from '@anthropic-ai/claude-agent-sdk'

// SessionKey = { projectKey: string; sessionId: string; subpath?: string }
// SessionStoreEntry = { type: string; uuid?: string; timestamp?: string; [k: string]: unknown }

export class DuraclavSessionStore implements SessionStore {
  constructor(private rpc: TranscriptRpc) {}

  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    await this.rpc.call('appendTranscript', { key, entries })
  }

  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    return this.rpc.call('loadTranscript', { key })
  }

  async delete(key: SessionKey): Promise<void> {
    await this.rpc.call('deleteTranscript', { key })
  }

  async listSubkeys(key: { projectKey: string; sessionId: string }): Promise<string[]> {
    return this.rpc.call('listTranscriptSubkeys', { key })
  }
}
```

#### TranscriptRpc contract

New file: `packages/session-runner/src/transcript-rpc.ts`

`TranscriptRpc` is a request/response multiplexer over the existing
dial-back WS. It piggybacks on the same connection used for
`GatewayEvent` / `GatewayCommand` — no new connection needed.

```typescript
export interface TranscriptRpc {
  /** Send an RPC and await the response. Throws on timeout or WS error. */
  call<T>(method: string, params: Record<string, unknown>): Promise<T>
}

export class WsTranscriptRpc implements TranscriptRpc {
  private pending = new Map<string, { resolve: Function; reject: Function; timer: ReturnType<typeof setTimeout> }>()
  private readonly timeoutMs = 30_000

  constructor(private send: (msg: string) => void) {}

  async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const rpcId = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rpcId)
        reject(new Error(`TranscriptRpc timeout: ${method} after ${this.timeoutMs}ms`))
      }, this.timeoutMs)
      this.pending.set(rpcId, { resolve, reject, timer })
      this.send(JSON.stringify({ type: 'transcript-rpc', method, params, rpc_id: rpcId }))
    })
  }

  /** Called by the WS message handler when a transcript-rpc-response arrives. */
  handleResponse(rpcId: string, result: unknown, error: string | null): void {
    const entry = this.pending.get(rpcId)
    if (!entry) return
    this.pending.delete(rpcId)
    clearTimeout(entry.timer)
    if (error) entry.reject(new Error(`TranscriptRpc error: ${error}`))
    else entry.resolve(result)
  }

  /** Cancel all pending RPCs (called on WS close / abort). */
  cancelAll(reason: string): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error(`TranscriptRpc cancelled: ${reason}`))
    }
    this.pending.clear()
  }
}
```

**Timeout:** 30s per call. If the DO is hibernated, the WS message
wakes it — cold-start adds ~100ms, well within budget. No retry on
timeout (the SDK's `append()` is best-effort; a timeout on `load()`
during resume surfaces as a resume failure, which the DO handles by
falling back to `forkWithHistory`).

**WS disconnect mid-RPC:** `cancelAll()` is called from the
`DialBackClient` `onClose` handler. Pending appends are lost (the SDK
will re-append on reconnect). Pending loads fail, triggering the
resume fallback path.

**Shared WS:** The runner's existing `onMessage` switch in `main.ts`
gains a `'transcript-rpc-response'` case that delegates to
`rpc.handleResponse(msg.rpc_id, msg.result, msg.error)`. No command
queue contention — RPCs and `GatewayCommand` traffic are interleaved
on the same WS without blocking each other.

### B2: DO transcript storage (server-side)

**Core:**
- **ID:** do-transcript-storage
- **Trigger:** SessionDO receives `appendTranscript` / `loadTranscript` / `listTranscriptSubkeys` / `deleteTranscript` RPCs from the runner over WS
- **Expected:** Entries are persisted to DO SQLite `session_transcript` table. `load` returns entries in insertion order. `listSubkeys` returns distinct subpath values for a given session. `delete` removes all entries for a session.
- **Verify:** After a session with 5 turns, query `session_transcript` directly via `getEventLog()` debug RPC — entries present with correct seq ordering. Resume the session under a different identity and confirm transcript loads correctly.
- **Source:** `apps/orchestrator/src/agents/session-do/` (new RPC handlers alongside existing ones)

#### Data Layer

Migration v26 (`session_transcript`):

```sql
CREATE TABLE IF NOT EXISTS session_transcript (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  subpath TEXT DEFAULT '',
  seq INTEGER NOT NULL,
  entry_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_transcript_lookup
  ON session_transcript(session_id, subpath, seq);
```

Migration v27 (`session_tool_results`):

```sql
CREATE TABLE IF NOT EXISTS session_tool_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  result_key TEXT NOT NULL,
  content BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_tool_result_key
  ON session_tool_results(session_id, result_key);
```

**Size budget:** 10GB per DO. Typical session = 5KB–5MB transcript +
0–2MB tool-results. At 500 concurrent sessions per DO, worst case ~3GB.

**Transcript lifecycle:**
- **Append:** Called by runner via `appendTranscript` RPC on every SDK turn.
- **Load:** Called by runner via `loadTranscript` RPC on resume.
- **Delete:** Called by the DO's existing reaper/GC logic. When a session
  is reaped (status transitions to `idle` and stays idle for >30 days),
  the DO deletes transcript entries as part of its `onStart` GC sweep
  (same pattern as `event_log` pruning). The SDK's `SessionStore.delete()`
  is wired through `deleteTranscript` RPC but is only invoked by the SDK
  during explicit `deleteSession()` calls — not during normal operation.
- **GC:** `DELETE FROM session_transcript WHERE created_at < datetime('now', '-30 days')`
  runs in `onStart`, same cadence as `event_log` 7-day pruning but with
  30-day retention (transcripts are needed for resume across idle periods).

### B3: Tool-results storage through SessionStore

**Core:**
- **ID:** tool-results-store
- **Trigger:** SDK writes a tool-result file (e.g., large Bash output) during a session with SessionStore enabled
- **Expected:** The SDK writes tool-results to local disk at `~/.claude/projects/<project>/<sessionId>/tool-results/*.txt`. After each SDK turn completes (`result` event), the runner scans for new tool-result files and mirrors them to DO SQLite via `storeToolResult` RPC. On resume under a different identity, the runner materialises tool-results from DO SQLite to the new identity's local disk before calling `query({resume, sessionStore})`.
- **Verify:** Run a session that produces large tool output (>100KB Bash command). Kill the runner. Resume under a different identity. Confirm the tool-result file exists at the new identity's `~/.claude/projects/` path and the SDK resumes without "tool result not found" errors.
- **Source:** `packages/session-runner/src/claude-runner.ts` (post-turn hook point, after `result` event handling)

**Design rationale:** The SDK's `SessionStore` interface covers
transcript entries (JSONL lines) but empirical testing is needed to
confirm whether `tool-results/*.txt` files route through `append()` or
bypass the store entirely. This spec assumes the conservative path:
tool-results are filesystem-only, and the runner mirrors them
post-turn. If future SDK versions route tool-results through the store
natively, the mirror step becomes a no-op (idempotent upsert).

**P1a spike task:** During P1a implementation, empirically test whether
the SDK writes tool-results through `SessionStore.append()` (as
subpath entries with a `tool-result` type) or directly to disk.

**Branch A (SDK routes tool-results through store):** Skip
`session_tool_results` migration (v27), skip `storeToolResult` /
`loadToolResult` RPCs, skip the post-turn mirror step. Tool-results
land in `session_transcript` as subpath entries. B3's mirror logic
becomes dead code — do not build it.

**Branch B (SDK writes tool-results to disk, bypassing store):** Keep
migration v27, implement `storeToolResult` / `loadToolResult` RPCs,
build the post-turn mirror step in the runner (scan
`~/.claude/projects/<project>/<sessionId>/tool-results/` after each
`result` event, upsert new files via RPC). On resume under a new
identity, materialise tool-results from DO SQLite to local disk before
calling `query({resume, sessionStore})`.

Document the spike finding in the P1a PR. The implementer should not
build both branches — the spike resolves this before P1b begins.

#### Data Layer

DO SQLite migration v27 (`session_tool_results`):

```sql
CREATE TABLE IF NOT EXISTS session_tool_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  result_key TEXT NOT NULL,
  content BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_tool_result_key
  ON session_tool_results(session_id, result_key);
```

**Size budget:** tool-results are typically 500KB each, 0–5 per
session. Worst case 2.5MB per session. The UNIQUE constraint on
`(session_id, result_key)` ensures idempotent upsert on mirror retries.
GC: same 30-day retention as `session_transcript`.

### B4: Runner identity abstraction

**Core:**
- **ID:** runner-identity
- **Trigger:** Admin configures a new runner identity via the Settings UI or `setup-identity.sh` script
- **Expected:** Identity is stored in D1 `runner_identities` table with a unique name, HOME path, and status. The DO reads available identities when spawning a runner and passes the selected identity's HOME to the gateway. The gateway spawns the runner with `HOME=<identity.home_path>` in the process env.
- **Verify:** Configure two identities (`work1`, `work2`) with different HOME paths. Start a session. Confirm the runner process has `HOME=/srv/duraclaw/homes/work1` (or whichever was selected). Check `ps aux | grep session-runner` and verify the HOME env var.
- **Source:** `packages/agent-gateway/src/handlers.ts:196` (spawn env), `apps/orchestrator/src/agents/session-do/runner-link.ts:197-200` (triggerGatewayDial)

#### API Layer

```
POST   /api/admin/identities        { name, home_path }  -> { id, name, home_path, status }
GET    /api/admin/identities         -> [{ id, name, home_path, status, cooldown_until }]
PUT    /api/admin/identities/:id     { status?, name? }   -> { id, name, home_path, status }
DELETE /api/admin/identities/:id     -> { ok: true }
```

Auth: admin-only (existing Better Auth role check).

#### Data Layer

D1 migration (new table in `apps/orchestrator/src/db/schema.ts`):

```typescript
export const runnerIdentities = sqliteTable('runner_identities', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text('name').notNull().unique(),
  homePath: text('home_path').notNull(),
  status: text('status').notNull().default('available'), // 'available' | 'cooldown' | 'disabled'
  cooldownUntil: text('cooldown_until'), // ISO timestamp, null = no cooldown
  lastUsedAt: text('last_used_at'), // ISO timestamp, null = never used. LRU ORDER BY this ASC.
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
})
```

### B5: Automatic failover on rate limit

**Core:**
- **ID:** auto-failover
- **Trigger:** SessionDO receives a `rate_limit` event (via WS from runner) or detects an SDK `result` event with `error: 'rate_limit'` or `error: 'authentication_failed'`
- **Expected:** DO marks the current identity as `cooldown` with `cooldown_until` derived from `rate_limit_info.resets_at` (or +30min fallback). DO selects the next available identity using LRU round-robin: `SELECT * FROM runner_identities WHERE status = 'available' AND (cooldown_until IS NULL OR cooldown_until < datetime('now')) ORDER BY last_used_at ASC LIMIT 1`. DO spawns a new runner with `{type: 'resume', runner_session_id, session_store_enabled: true, runner_home: nextIdentity.homePath}`. The new runner loads the transcript from DO SQLite and continues. The DO persists `identity_name` on the `agent_sessions` row and broadcasts via `broadcastSessionRow` so the UI updates.
- **Verify:** Simulate a rate_limit event by injecting a mock `rate_limit` GatewayEvent into the DO. Confirm: (1) current identity marked cooldown in D1, (2) new runner spawned under different identity, (3) session resumes with full transcript, (4) UI shows failover notification.
- **Source:** `apps/orchestrator/src/agents/session-do/runner-link.ts` (triggerGatewayDial), `packages/shared-types/src/index.ts:306-310` (RateLimitEvent)

#### Wire changes

New field on `ExecuteCommand` and `ResumeCommand` (in `packages/shared-types/src/index.ts`):

```typescript
/** HOME path for runner identity. Gateway sets HOME in spawn env. */
runner_home?: string
/** Whether to enable SessionStore for this runner. */
session_store_enabled?: boolean
```

New `GatewayEvent` variant:

```typescript
export interface FailoverEvent {
  type: 'failover'
  session_id: string
  from_identity: string
  to_identity: string
  reason: 'rate_limit' | 'auth_error'
}
```

#### Failover state machine

```
running (identity A)
  |
  v  rate_limit / auth_error event
  |
mark identity A as cooldown(cooldown_until)
UPDATE runner_identities SET status='cooldown', cooldown_until=? WHERE id=?
  |
  v
select next identity B (LRU round-robin):
  SELECT * FROM runner_identities
  WHERE status='available'
    AND (cooldown_until IS NULL OR cooldown_until < datetime('now'))
  ORDER BY last_used_at ASC LIMIT 1
  |
  ├─ found → UPDATE last_used_at → spawn resume under identity B → running (identity B)
  │
  └─ none available → set session status 'waiting_identity'
                       → DO calls this.ctx.storage.setAlarm(Date.now() + 60_000)
                       → on alarm(): re-query D1 for available identities
                         ├─ found → spawn resume → running
                         └─ not found → increment retry counter
                           ├─ retries < 30 → re-arm alarm(60s)
                           └─ retries >= 30 → set status 'failed',
                              error: 'All identities exhausted after 30min'
```

The alarm loop uses `this.ctx.storage.setAlarm()` (Durable Object
alarm API), not `setTimeout`. This survives DO hibernation — if the DO
sleeps during the wait, the alarm wakes it. The retry counter is
persisted in `session_meta` so it survives hibernation cycles.

**Cross-store access:** Identity queries use `ctx.env.AUTH_DB` (D1
binding), not `this.sql` (DO SQLite). This follows the existing pattern
in `runner-link.ts` where `user_preferences` and `codex_models` are
read from D1 inside the DO. Transcript storage uses `this.sql` (DO
SQLite). The two stores serve different lifetimes: identities are
global/admin-managed (D1), transcripts are per-session (DO SQLite).

**Zero-identities fallback:** If `runner_identities` has no rows (P2
deployed but no identities configured), the DO skips identity selection
entirely and spawns without `runner_home` — preserving current behavior.
Identity selection is only attempted when `SELECT count(*) FROM
runner_identities WHERE status != 'disabled'` returns > 0. This makes
P2 deployment safe even before identities are configured.

### B6: Identity cooldown management

**Core:**
- **ID:** identity-cooldown
- **Trigger:** Failover marks an identity as `cooldown`. Time passes. A new session needs an identity.
- **Expected:** When selecting an identity, the DO checks `cooldown_until < now()`. Expired cooldowns are treated as `available`. Background: no explicit cleanup job needed — the check is lazy (at selection time via the LRU WHERE clause in B5).
- **Verify:** Set identity `work1` cooldown to 1 minute from now. Wait 90 seconds. Start a new session. Confirm `work1` is selected (cooldown expired).
- **Phase:** P2 (the cooldown check is the WHERE clause in the identity selection query). The failover-triggered cooldown write is P3.

### B7: UI failover notification

**Core:**
- **ID:** failover-notification
- **Trigger:** DO broadcasts a `FailoverEvent` to connected browser clients
- **Expected:** StatusBar shows "Switching accounts..." during failover. After new runner connects, status returns to "Running". Session sidebar shows current identity name.
- **Verify:** (P3) Trigger a failover via mock event. Confirm the StatusBar flashes "Switching accounts..." for 3-5 seconds, then returns to "Running". (P4) After failover, session sidebar card shows the new identity name.

#### UI Layer

- **P3 scope** — `StatusBar`: derive from `FailoverEvent` in `deriveDisplayStateFromStatus()` — add `'failover'` and `'waiting_identity'` to the status enum, map to labels "Switching accounts..." (warning color) and "All accounts on cooldown — retrying..." (error color).
- **P4 scope** — `SessionCard`: show `identity_name` field from `sessionsCollection` (read from `agent_sessions.identity_name` D1 column, broadcast via `broadcastSessionRow`).

## Non-Goals

- **Multi-VPS failover** — this spec assumes all identities share the same VPS. Cross-VPS resume (where the transcript lives on a different machine) is a future extension enabled by this architecture but not built here.
- **CAAM integration** — CAAM rotates profiles within a single HOME. This feature uses separate HOME dirs per identity. The two systems are orthogonal; CAAM can still run within each identity's HOME if desired.
- **Automated identity provisioning** — identities are admin-configured via UI or script. No auto-discovery of available Claude accounts.
- **Form-time identity selection** — the user doesn't pick which identity to use. The DO selects automatically based on availability.
- **Session migration from filesystem to SessionStore** — existing sessions on disk remain on disk. `importSessionToStore()` could migrate them in a future task, but this spec only covers new sessions created with the feature flag on.
- **Memory file sharing** — `~/.claude/projects/<project>/memory/` is project-scoped, not session-scoped. This spec doesn't address memory portability across identities (it's already shared via the project worktree's `.claude/` dir, not the HOME-scoped one).

## Implementation Phases

See frontmatter `phases` for tasks and test_cases per phase.

**Phase ordering rationale:**
- P1a (DO transcript storage) + P1b (runner adapter) are the foundation — everything else depends on transcript portability. Split so P1a can be reviewed independently before wiring the runner. P1b is the largest single phase (RPC multiplexer + adapter + wiring + tests) — budget 4-6 hours or consider a further split if the TranscriptRpc implementation proves complex.
- P2 (identity abstraction) is the second foundation — failover needs identities to fail over to.
- P3 (automatic failover) is the feature — connects P1 and P2.
- P4 (admin UI) is polish — the feature works without it (identities can be DB-seeded), but admin ergonomics matter.

## Verification Plan

### VP-1: SessionStore round-trip

```bash
# 1. Enable feature flag
sqlite3 /path/to/d1/duraclaw-auth.db \
  "INSERT INTO feature_flags (name, enabled) VALUES ('session_store', 1)
   ON CONFLICT(name) DO UPDATE SET enabled = 1"

# 2. Start a session via the UI, send 3 messages
# 3. Check DO SQLite for transcript entries:
curl -H "Authorization: Bearer $TOKEN" \
  "https://dura.../api/sessions/$SESSION_ID/debug/transcript-count"
# Expected: { "count": N } where N > 0

# 4. Kill the runner (simulate crash):
kill -9 $(cat /run/duraclaw/sessions/$SESSION_ID.pid)

# 5. Send a follow-up message in the UI (triggers resume)
# Expected: session resumes, prior messages visible, no "session not found" error

# 6. Disable feature flag and start a new session
# Expected: runner uses filesystem-only (no transcript RPCs in DO event_log)
```

### VP-2: Identity spawn with custom HOME

```bash
# 1. Create identity:
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"work2","home_path":"/srv/duraclaw/homes/work2"}' \
  "https://dura.../api/admin/identities"
# Expected: 201 { id: "...", name: "work2", status: "available" }

# 2. Ensure /srv/duraclaw/homes/work2/.claude/.credentials.json exists with valid auth

# 3. Start a session (DO should select an available identity)

# 4. Check runner process env:
cat /proc/$(cat /run/duraclaw/sessions/$SESSION_ID.pid)/environ | tr '\0' '\n' | grep HOME
# Expected: HOME=/srv/duraclaw/homes/work2 (or whichever identity was selected)
```

### VP-3: Automatic failover

```bash
# 1. Ensure two identities are configured (work1, work2)
# 2. Start a session (lands on work1)
# 3. Inject a mock rate_limit event into the DO:
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"simulate-rate-limit","resets_at":"2026-04-27T16:00:00Z"}' \
  "https://dura.../api/sessions/$SESSION_ID/debug/inject-event"
# Expected:
#   - work1 marked cooldown in runner_identities
#   - new runner spawned under work2
#   - session resumes from DO SQLite transcript
#   - UI shows "Switching accounts..." briefly

# 4. Check identity status:
curl -H "Authorization: Bearer $TOKEN" \
  "https://dura.../api/admin/identities"
# Expected: work1.status = "cooldown", work2.status = "available" (in use)

# 5. After cooldown_until passes, start another session
# Expected: work1 is selectable again
```

### VP-4: No available identity (graceful degradation)

```bash
# 1. Set all identities to cooldown
# 2. Start a session or trigger failover
# Expected: session status = "waiting_identity", UI shows
#   "All accounts on cooldown — retrying in 60s"
# 3. Wait for one identity's cooldown to expire
# Expected: session automatically resumes
```

## Implementation Hints

### Key imports

```typescript
// SDK SessionStore types (session-runner)
import type { SessionStore, SessionStoreEntry, SessionSummaryEntry } from '@anthropic-ai/claude-agent-sdk'
// Exact import path — types are re-exported from the main entry

// foldSessionSummary + importSessionToStore helpers
import { foldSessionSummary, importSessionToStore, InMemorySessionStore } from '@anthropic-ai/claude-agent-sdk'
```

### Code patterns

**Feature flag injection** (same pattern as `titler_enabled` and `permission_mode`, `runner-link.ts:210-215`):
```typescript
if (cmd.type === 'execute' || cmd.type === 'resume') {
  const sessionStoreEnabled = await ctx.do.getFeatureFlagEnabled('session_store', false)
  cmd = { ...cmd, session_store_enabled: sessionStoreEnabled }
}
```

**Gateway HOME override** (extend `handlers.ts:196`):
```typescript
const spawnEnv = {
  ...buildCleanEnv(),
  SESSIONS_DIR: dir,
  ...(cmd.runner_home ? { HOME: cmd.runner_home } : {}),
}
```

**DO SQLite batch insert** (existing pattern in `session-do`):
```typescript
for (const entry of entries) {
  this.sql.exec(
    `INSERT INTO session_transcript (project_key, session_id, subpath, seq, entry_json)
     VALUES (?, ?, ?, ?, ?)`,
    key.projectKey, key.sessionId, key.subpath ?? '', nextSeq++, JSON.stringify(entry)
  )
}
```

**RPC over dial-back WS** (runner -> DO, new command type):
```typescript
// Runner sends:
{ type: 'transcript-rpc', method: 'appendTranscript', params: { key, entries }, rpc_id: 'uuid' }
// DO replies:
{ type: 'transcript-rpc-response', rpc_id: 'uuid', result: null, error: null }
```

### Gotchas

1. **SessionStore is `@alpha`** — the interface could shift in future SDK releases. Keep the adapter thin (~100 lines) so changes are localized. Pin SDK version in `package.json` with exact version after validating.

2. **`loadTimeoutMs` default is 60s** — if DO SQLite is slow (large transcript, cold start), the SDK will fail the resume. Override with a generous value (120s) in the runner.

3. **tool-results may not route through SessionStore** — the SDK may write `tool-results/*.txt` directly to disk, bypassing the store. Empirically test this in P1. If it does bypass, implement a post-turn mirror: after each `result` event, scan for new tool-result files and upload via `storeToolResult` RPC.

4. **`projectKey` encoding** — the SDK encodes project paths as: replace every `/` with `-`, prepend `-`. Example: `/data/projects/duraclaw-dev2` becomes `-data-projects-duraclaw-dev2`. Paths longer than 200 chars are hashed with djb2. The adapter MUST replicate this encoding so `load()` during resume finds the right transcript. Encoding function (replicate in the adapter):
   ```typescript
   function encodeProjectKey(cwd: string): string {
     const encoded = '-' + cwd.slice(1).replace(/\//g, '-')
     return encoded.length > 200 ? `-djb2-${djb2Hash(cwd)}` : encoded
   }
   ```
   Alternatively, the runner can read the `projectKey` that the SDK passes to the `SessionStore` during the first `append()` call and cache it for later use — the SDK controls the encoding, the adapter just stores it.

5. **Concurrent WS RPCs** — the dial-back WS is shared between `GatewayCommand` traffic and transcript RPCs. Use `rpc_id` for request/response correlation. Don't block the command queue while waiting for an RPC response.

6. **DO hibernation** — DOs hibernate after 30s of inactivity. Transcript RPCs will wake the DO, but the first `load()` on resume may hit a cold-start penalty (~100ms). The `loadTimeoutMs` budget accommodates this.

### Reference docs

- [Claude Agent SDK SessionStore](https://platform.claude.com/docs/en/agent-sdk/sessions) — official docs on session persistence and the store API
- [Durable Objects SQLite storage](https://developers.cloudflare.com/durable-objects/api/storage/sql/) — CF docs for DO SQLite API, limits, best practices
- [Existing DO migrations](https://github.com/baseplane-ai/duraclaw/blob/main/apps/orchestrator/src/agents/session-do-migrations.ts) — pattern for adding new SQLite migrations
- [CAAM spec](https://github.com/baseplane-ai/duraclaw/blob/main/planning/specs/92-v2-caam-rotation-narrow.md) — existing rate-limit detection and profile rotation (orthogonal to this feature)
