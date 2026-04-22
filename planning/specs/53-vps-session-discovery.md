---
initiative: feat-vps-session-discovery
type: project
issue_type: feature
status: draft
priority: high
github_issue: 53
created: 2026-04-12
updated: 2026-04-22
phases:
  - id: p1
    name: "SessionSource adapter interface and Claude adapter"
    tasks:
      - "Define SessionSource interface and DiscoveredSession type in shared-types"
      - "Implement ClaudeSessionSource in agent-gateway (wrap listSdkSessions)"
      - "Stub CodexSessionSource and OpenCodeSessionSource"
      - "Add GET /sessions/discover endpoint to gateway"
      - "Update OpenAPI spec"
    test_cases:
      - id: "gw-discover-claude"
        description: "GET /sessions/discover returns Claude sessions from .claude/sessions/"
        type: "integration"
      - id: "gw-discover-empty"
        description: "GET /sessions/discover returns empty array when no sessions exist"
        type: "integration"
      - id: "gw-discover-since"
        description: "GET /sessions/discover?since=<ISO> filters to sessions after timestamp"
        type: "integration"
  - id: p2
    name: "DO schema migration and sync endpoint"
    tasks:
      - "Add migration v7: origin, agent, message_count, sdk_session_id columns"
      - "Add syncDiscoveredSessions() method to ProjectRegistry DO"
      - "Add POST /api/sessions/sync orchestrator endpoint"
      - "Implement dedup logic (sdk_session_id match or project+started_at)"
      - "Update SessionSummary type with new fields"
    test_cases:
      - id: "do-migration-v7"
        description: "Migration v7 adds new columns without breaking existing data"
        type: "integration"
      - id: "do-sync-dedup"
        description: "Syncing a session that already exists updates rather than duplicates"
        type: "integration"
  - id: p3
    name: "DO alarm polling and completion hook"
    tasks:
      - "Implement DO alarm that fires every 5 minutes"
      - "Alarm handler fetches GET /sessions/discover?since=<watermark> from gateway"
      - "Upsert discovered sessions into DO SQLite"
      - "Wire session completion in SessionDO to trigger immediate sync"
      - "Store sync watermark in DO storage"
    test_cases:
      - id: "do-alarm-fires"
        description: "ProjectRegistry alarm fires and fetches from gateway"
        type: "integration"
      - id: "do-completion-sync"
        description: "Session completion triggers immediate sync of new sessions"
        type: "integration"
  - id: p4
    name: "UI: blended session history with resume"
    tasks:
      - "Update SessionHistory table to show agent column and handle missing fields"
      - "Add resume button for discovered sessions with sdk_session_id"
      - "Update /api/projects to use DO-only sessions (drop gateway session fetch)"
      - "Update session search to cover new fields (agent, sdk_session_id)"
    test_cases:
      - id: "ui-blended-table"
        description: "Session history shows both Duraclaw and discovered sessions in one table"
        type: "e2e"
      - id: "ui-resume-discovered"
        description: "Clicking resume on a discovered session starts a new session with sdk_session_id"
        type: "e2e"
---

# VPS Session Discovery

## Overview

Session discovery is limited to sessions created through the Duraclaw UI. The VPS has thousands of Claude Code sessions (from CLI usage, SDK sessions started outside Duraclaw) plus potential sessions from other agents (Codex, OpenCode) — all invisible in the orchestrator.

This spec adds a `SessionSource` adapter interface to the gateway for discovering sessions from any agent's on-disk storage, a sync mechanism that copies metadata into the ProjectRegistry Durable Object, and blended UI display with resume capability.

## Feature Behaviors

### B1: SessionSource Adapter Interface

**Core:**
- **ID:** session-source-interface
- **Trigger:** Gateway startup — adapters are registered
- **Expected:** A `SessionSource` interface defines how each agent discovers sessions. Each source implements `discoverSessions(projectPath, since?)` returning normalized `DiscoveredSession[]`. The gateway registers all available sources at startup.
- **Verify:** Import `SessionSource` from shared-types. Confirm ClaudeSessionSource, CodexSessionSource, OpenCodeSessionSource all implement it.

#### API Layer
```typescript
interface SessionSource {
  /** Agent name matching the execution adapter (e.g. 'claude', 'codex') */
  readonly agent: string
  /** Human-readable description */
  readonly description: string
  /** Whether this source can discover sessions (binary exists, dirs present, etc.) */
  available(): Promise<boolean>
  /** Discover sessions in a project directory, optionally filtered by timestamp */
  discoverSessions(projectPath: string, opts?: {
    since?: string  // ISO timestamp — only sessions with activity after this
    limit?: number  // Max sessions to return (default 50)
  }): Promise<DiscoveredSession[]>
}

interface DiscoveredSession {
  /** Unique session ID from the agent (SDK session_id, thread_id, etc.) */
  sdk_session_id: string
  /** Agent that created this session */
  agent: string
  /** Project directory path */
  project_dir: string
  /** Project name (derived from path) */
  project: string
  /** Git branch at time of session */
  branch: string
  /** Session start time (ISO) */
  started_at: string
  /** Last activity time (ISO) */
  last_activity: string
  /** Session summary or first prompt */
  summary: string
  /** User-assigned tag */
  tag: string | null
  /** Title (from SDK rename or agent-generated) */
  title: string | null
  /** Number of messages/turns if known */
  message_count: number | null
  /** User identity from the agent */
  user: string | null
}
```

#### Data Layer
Type definitions in `packages/shared-types/src/index.ts`. No storage — pure interface contract.

---

### B2: Claude Session Source

**Core:**
- **ID:** claude-session-source
- **Trigger:** `discoverSessions(projectPath)` called with a project directory
- **Expected:** Reads `.claude/sessions/*/session-info.json` and per-project `sessions.jsonl` files. Returns `DiscoveredSession[]` with session_id, branch, started_at, last_activity (from dir mtime), summary, tag. Wraps existing `listSdkSessions()` logic.
- **Verify:** Call `discoverSessions('/data/projects/duraclaw')` and confirm results match `ls .claude/sessions/`.

#### API Layer
Implements `SessionSource` interface. Constructor takes no args. `available()` checks for `.claude/` directory existence.

#### Data Layer
Reads from filesystem:
- Primary: SDK `listSessions()` from `@anthropic-ai/claude-agent-sdk`
- Fallback: `.claude/sessions/*/session-info.json` disk scan
- Enrichment: `~/.claude/projects/<project-hash>/sessions.jsonl` for workflow metrics

---

### B3: Codex Session Source (Stub)

**Core:**
- **ID:** codex-session-source
- **Trigger:** Registration at gateway startup
- **Expected:** Stub implementation. `available()` returns `false` (no known persistent session storage for Codex yet). `discoverSessions()` returns `[]`. Ready for implementation when Codex session storage format is known.
- **Verify:** `CodexSessionSource.available()` returns `false`. `discoverSessions()` returns `[]`.

---

### B4: OpenCode Session Source (Stub)

**Core:**
- **ID:** opencode-session-source
- **Trigger:** Registration at gateway startup
- **Expected:** Stub implementation. `available()` returns `false`. `discoverSessions()` returns `[]`. Ready for implementation when OpenCode is installed and storage format is known.
- **Verify:** `OpenCodeSessionSource.available()` returns `false`. `discoverSessions()` returns `[]`.

---

### B5: Gateway Discovery Endpoint

**Core:**
- **ID:** gateway-discover-endpoint
- **Trigger:** `GET /sessions/discover` request to agent-gateway
- **Expected:** Iterates all discovered projects, calls each registered `SessionSource.discoverSessions()` for each project, returns merged and deduplicated results sorted by `last_activity DESC`.
- **Verify:** `GET /sessions/discover` returns sessions from all available sources across all projects.

#### API Layer
- **Endpoint:** `GET /sessions/discover`
- **Auth:** Bearer token (same as all gateway endpoints)
- **Query params (all optional):**
  - `since` — ISO timestamp, only sessions with activity after this time
  - `limit` — max sessions per project per source (default 50)
  - `project` — filter to a specific project name
- **Response 200:**
```json
{
  "sessions": [
    {
      "sdk_session_id": "abc-123",
      "agent": "claude",
      "project": "duraclaw",
      "project_dir": "/data/projects/duraclaw",
      "branch": "main",
      "started_at": "2026-04-12T10:00:00Z",
      "last_activity": "2026-04-12T12:30:00Z",
      "summary": "Implement session discovery",
      "tag": null,
      "title": null,
      "message_count": null,
      "user": "user@example.com"
    }
  ],
  "sources": {
    "claude": { "available": true, "session_count": 45 },
    "codex": { "available": false, "session_count": 0 },
    "opencode": { "available": false, "session_count": 0 }
  }
}
```

#### Data Layer
N/A — aggregates from SessionSource adapters.

---

### B6: DO Schema Migration v7

**Core:**
- **ID:** do-schema-v7
- **Trigger:** ProjectRegistry DO initialization
- **Expected:** Migration v7 adds four nullable columns to the sessions table: `origin TEXT`, `agent TEXT`, `message_count INTEGER`, `sdk_session_id TEXT`. Adds a unique index on `sdk_session_id` for dedup. Existing sessions get `origin = 'duraclaw'` and `agent = 'claude'` defaults.
- **Verify:** After migration, `PRAGMA table_info(sessions)` shows new columns. Existing data is preserved with default values.

#### Data Layer
Migration in `apps/orchestrator/src/agents/project-registry-migrations.ts`:
```sql
ALTER TABLE sessions ADD COLUMN origin TEXT DEFAULT 'duraclaw';
ALTER TABLE sessions ADD COLUMN agent TEXT DEFAULT 'claude';
ALTER TABLE sessions ADD COLUMN message_count INTEGER;
ALTER TABLE sessions ADD COLUMN sdk_session_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_sdk_id ON sessions(sdk_session_id) WHERE sdk_session_id IS NOT NULL;
```

---

### B7: DO Sync Method

**Core:**
- **ID:** do-sync-method
- **Trigger:** `syncDiscoveredSessions(userId, sessions)` called on ProjectRegistry DO
- **Expected:** For each `DiscoveredSession`, checks if a session with matching `sdk_session_id` already exists. If yes, updates `last_activity`, `summary`, `tag`, `title` (preserving Duraclaw-specific fields like `cost`, `model`, `status`). If no, inserts as a new session with `origin = 'discovered'`, `status = 'idle'`. Returns count of inserted and updated records.
- **Verify:** Sync the same session twice — first inserts, second updates without duplicating.

#### API Layer
Orchestrator endpoint for triggering sync:
- **Endpoint:** `POST /api/sessions/sync`
- **Auth:** Better Auth session
- **Response 200:**
```json
{
  "inserted": 12,
  "updated": 3,
  "watermark": "2026-04-12T12:30:00Z"
}
```

#### Data Layer
Dedup strategy:
1. If `sdk_session_id` matches an existing row → UPDATE (merge fields)
2. If no `sdk_session_id` match but `project + created_at` within 60s of an existing row → treat as same session, UPDATE
3. Otherwise → INSERT new row with `origin = 'discovered'`

---

### B8: DO Alarm Polling

**Core:**
- **ID:** do-alarm-polling
- **Trigger:** Durable Object alarm fires every 5 minutes
- **Expected:** ProjectRegistry DO schedules a recurring alarm. On fire, it fetches `GET /sessions/discover?since=<watermark>` from the gateway, calls `syncDiscoveredSessions()` with the results, and updates the watermark. On failure (gateway unreachable), logs and retries on next alarm.
- **Verify:** Wait 5 minutes after deployment. Check DO logs for sync activity. Verify new CLI sessions appear in the UI.

#### API Layer
No new endpoint. Uses DO alarm API (`this.ctx.storage.setAlarm()`).

#### Data Layer
Watermark stored in DO KV storage:
- Key: `sync_watermark`
- Value: ISO timestamp of the most recent `last_activity` from the last successful sync
- Initial value: 7 days ago (on first alarm, syncs last 7 days)

---

### B9: Session Completion Sync Hook

**Core:**
- **ID:** completion-sync-hook
- **Trigger:** A session completes (result event received on WebSocket) in SessionDO
- **Expected:** After syncing the result to the registry (existing behavior), the SessionDO triggers a sync on the ProjectRegistry. This is a fire-and-forget RPC call to `syncDiscoveredSessions()` with just the completed session's data — no need to poll the full gateway.
- **Verify:** Complete a session, immediately check the registry — the session should be present with both Duraclaw fields (cost, duration) and discovered fields (sdk_session_id, agent).

#### Data Layer
The completion hook already calls `syncResultToRegistry()`. After that, it additionally calls `registry.syncDiscoveredSessions(userId, [completedSessionAsDiscovered])` to ensure the `sdk_session_id` and `agent` fields are populated.

---

### B10: Blended Session History UI

**Core:**
- **ID:** blended-session-ui
- **Trigger:** User opens session history in the orchestrator UI
- **Expected:** The SessionHistory table shows all sessions — both Duraclaw-created and discovered. Columns: title/prompt, project, agent, status, duration, cost, date. For discovered sessions without Duraclaw data, cost and model show '—'. An agent badge shows which tool created the session (claude, codex, etc.).
- **Verify:** Open session history. See a mix of Duraclaw sessions (with cost/model) and discovered sessions (with '—' for missing fields). Both types are searchable and sortable.

#### UI Layer
- `SessionHistory.tsx`: Add `agent` column. Show `title ?? summary ?? prompt` as the primary text. Render missing fields as '—'.
- Agent badge: Small chip/tag showing 'claude', 'codex', etc. Uses the existing badge component if available.
- No separate tab or filter for discovered sessions — they're blended in.

---

### B11: Resume Discovered Sessions

**Core:**
- **ID:** resume-discovered
- **Trigger:** User clicks "Resume" on a discovered session in the UI
- **Expected:** The resume flow uses the `sdk_session_id` from the discovered session. The orchestrator creates a new SessionDO and sends a `resume` command to the gateway with the `sdk_session_id` and the session's project. The gateway's execution adapter handles the resume via its existing `resume()` method.
- **Verify:** Find a completed CLI session in the history. Click resume. The session continues in the same project with conversation context preserved.

#### UI Layer
- Resume button visible on discovered sessions that have a `sdk_session_id` and `agent = 'claude'` (Codex/OpenCode resume support TBD).
- Clicking resume calls the existing `spawn` flow but with `sdk_session_id` set for resume.

#### API Layer
Uses existing `POST /api/sessions` with an additional `sdk_session_id` field in the body. The SessionDO sends a `resume` command instead of `execute` when `sdk_session_id` is present. This pattern already exists in the codebase.

---

## Non-Goals

- **No CASS integration** — this uses direct filesystem reads, not the cass CLI. CASS (#12) is a separate feature for search/indexing.
- **No historic backfill** — only last 7 days on first sync, then incremental going forward.
- **No multi-user ownership** — single-user VPS model. All discovered sessions assigned to the requesting user.
- **No enrichment** — no cost estimation, model detection, or summary generation for discovered sessions. Show what the agent stored.
- **No real-time streaming** — sync is poll-based (5 min interval + completion hook). Not instant for external CLI sessions.
- **No Codex/OpenCode session reading** — stubs only. Implement when storage formats are documented.
- **No conversation content sync** — only metadata (title, summary, timestamps). Full conversation stays on VPS disk.

## Implementation Phases

**Phase P1: SessionSource adapter interface and Claude adapter** — Define `SessionSource` and `DiscoveredSession` in shared-types. Implement `ClaudeSessionSource` wrapping `listSdkSessions()`. Stub Codex and OpenCode sources. Add `GET /sessions/discover` endpoint to the gateway. Update OpenAPI.

**Phase P2: DO schema migration and sync method** — Migration v7 adds `origin`, `agent`, `message_count`, `sdk_session_id` columns. Implement `syncDiscoveredSessions()` on ProjectRegistry DO with dedup logic. Add `POST /api/sessions/sync` orchestrator endpoint. Update `SessionSummary` type.

**Phase P3: DO alarm polling and completion hook** — Wire up ProjectRegistry alarm for 5-min polling. Implement watermark tracking. Wire session completion hook in SessionDO to trigger immediate sync.

**Phase P4: UI — blended session history with resume** — Update SessionHistory table for agent column and missing fields. Add resume button for discovered sessions. Update `/api/projects` to use DO-only sessions. Update search to cover new fields.

## Verification Strategy

### Test Infrastructure
- Gateway integration tests: `bun:test` in `packages/agent-gateway/src/__tests__/`
- Orchestrator: manual verification via `chrome-devtools-axi` for UI behaviors
- DO sync: verify via API calls to `/api/sessions/history`

### Build Verification
`pnpm typecheck` from repo root. `pnpm build` must complete. New types in shared-types must not break consumers.

## Verification Plan

### VP1: Gateway Discovery Endpoint

**Step 1 — Basic discovery:**
```bash
curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:9877/sessions/discover" | jq '.sessions | length'
```
**Expected:** Positive integer. Response contains `sessions` array and `sources` object.

**Step 2 — Discovery with since filter:**
```bash
curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:9877/sessions/discover?since=$(date -d '7 days ago' -Iseconds)" | jq '.sessions | length'
```
**Expected:** Fewer or equal sessions compared to Step 1.

**Step 3 — Discovery with project filter:**
```bash
curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:9877/sessions/discover?project=duraclaw" | jq '.sessions[0].project'
```
**Expected:** `"duraclaw"`.

### VP2: Source Capabilities

**Step 1 — Check source availability:**
```bash
curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:9877/sessions/discover" | jq '.sources'
```
**Expected:** `claude.available = true`, `codex.available = false`, `opencode.available = false`.

### VP3: DO Sync

**Step 1 — Trigger sync via API:**
```bash
# Login and get session cookie first
curl -s -b cookies.txt -X POST "https://duraclaw.bfreeed.workers.dev/api/sessions/sync" | jq .
```
**Expected:** Response with `inserted`, `updated`, and `watermark` fields.

**Step 2 — Verify synced sessions appear in history:**
```bash
curl -s -b cookies.txt "https://duraclaw.bfreeed.workers.dev/api/sessions/history?limit=5" | jq '.sessions[] | {id, origin, agent, sdk_session_id}'
```
**Expected:** Some sessions have `origin: "discovered"` and non-null `sdk_session_id`.

### VP4: Dedup

**Step 1 — Sync twice, verify no duplicates:**
```bash
curl -s -b cookies.txt -X POST "https://duraclaw.bfreeed.workers.dev/api/sessions/sync" | jq .inserted
curl -s -b cookies.txt -X POST "https://duraclaw.bfreeed.workers.dev/api/sessions/sync" | jq .inserted
```
**Expected:** Second sync returns `inserted: 0` (all sessions already exist).

### VP5: Blended UI

**Step 1 — Open session history:**
```bash
chrome-devtools-axi open https://duraclaw.bfreeed.workers.dev/sessions
chrome-devtools-axi snapshot
```
**Expected:** Table shows sessions with agent badges. Some rows have cost/model, others show '—'.

### VP6: Resume

**Step 1 — Resume a discovered session:**
```bash
chrome-devtools-axi snapshot  # Find a discovered session with resume button
chrome-devtools-axi click @<resume-ref>
chrome-devtools-axi snapshot  # Verify session starts with context
```
**Expected:** New session starts in the correct project, conversation context is preserved.

## Implementation Hints

- **Adapter location:** Create `packages/agent-gateway/src/session-sources/` directory with `types.ts`, `claude.ts`, `codex.ts`, `opencode.ts`, `registry.ts`, `index.ts`. Mirror the existing `adapters/` structure.
- **Reuse listSdkSessions:** `ClaudeSessionSource.discoverSessions()` should call existing `listSdkSessions()` and map `SdkSessionInfo` → `DiscoveredSession`.
- **Gateway URL construction:** The DO alarm needs to call the gateway. Use `CC_GATEWAY_URL` env var (already available). Remember to convert `wss://` to `https://` per the existing pattern in `fetchGatewayProjects()`.
- **DO alarm pattern:** `this.ctx.storage.setAlarm(Date.now() + 5 * 60 * 1000)` in `alarm()` handler. Reschedule at the end of each alarm handler to create recurring behavior.
- **Dedup index:** The unique index on `sdk_session_id` uses `WHERE sdk_session_id IS NOT NULL` to allow multiple rows with NULL (legacy Duraclaw sessions that predate this feature).
- **Session ID for discovered sessions:** Use `sdk_session_id` as the DO session `id` when inserting discovered sessions. This ensures the same session always maps to the same row.

### Gotchas

- DO alarms are not cron — they fire once. Must reschedule in the alarm handler.
- `CC_GATEWAY_URL` might be `wss://` — must convert to `https://` for HTTP fetch.
- The `listSdkSessions()` fallback disk scan uses `Bun.Glob` — not available in CF Workers. All discovery runs on the gateway side.
- SQLite `INSERT OR REPLACE` will delete and re-insert, losing any columns not in the INSERT. Use `INSERT ... ON CONFLICT(sdk_session_id) DO UPDATE SET ...` instead.
- The `SessionSummary` type is used in many places — adding new optional fields is safe, but removing or changing existing fields will break consumers.
