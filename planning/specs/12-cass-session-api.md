---
initiative: feat-cass-session-api
type: project
issue_type: feature
status: approved
priority: medium
github_issue: 12
created: 2026-04-08
updated: 2026-04-08
phases:
  - id: p1
    name: "Gateway cass subprocess foundation"
    tasks:
      - "Create cass.ts handler with Bun.spawn subprocess wrapper"
      - "Implement cass health and capabilities endpoints"
      - "Add cass binary detection and error handling"
      - "Update OpenAPI spec with cass endpoints"
    test_cases:
      - id: "gw-cass-health"
        description: "GET /cass/health returns cass health status"
        type: "integration"
      - id: "gw-cass-missing"
        description: "Endpoints return 503 when cass binary not found"
        type: "integration"
  - id: p2
    name: "Gateway search, timeline, and stats endpoints"
    tasks:
      - "Implement GET /cass/search with query param passthrough"
      - "Implement GET /cass/timeline with date filtering"
      - "Implement GET /cass/stats"
      - "Implement GET /cass/index trigger endpoint"
    test_cases:
      - id: "gw-cass-search"
        description: "GET /cass/search returns JSON results from cass search"
        type: "integration"
      - id: "gw-cass-timeline"
        description: "GET /cass/timeline returns grouped session activity"
        type: "integration"
  - id: p3
    name: "Gateway export, context, and diag endpoints"
    tasks:
      - "Implement GET /cass/sessions/export with path query param"
      - "Implement GET /cass/sessions/context with path query param"
      - "Implement GET /cass/diag"
      - "Implement freshness-triggered auto-indexing"
    test_cases:
      - id: "gw-cass-export"
        description: "GET /cass/sessions/:path/export returns conversation JSON"
        type: "integration"
      - id: "gw-cass-context"
        description: "GET /cass/sessions/:path/context returns related sessions"
        type: "integration"
  - id: p4
    name: "Orchestrator proxy routes"
    tasks:
      - "Add /api/cass/* proxy routes in orchestrator"
      - "Forward auth headers to gateway"
      - "Integration tests for proxy end-to-end"
    test_cases:
      - id: "orch-cass-proxy"
        description: "Orchestrator /api/cass/* routes proxy to gateway and return results"
        type: "integration"
---

# Cass Session API

## Overview

The VPS has 21k+ Claude Code sessions indexed by the `cass` CLI, but there is no programmatic way to search, browse, or analyze them from the orchestrator or any external client. This spec adds HTTP endpoints to cc-gateway that wrap every `cass` machine-readable command as a subprocess call, plus orchestrator proxy routes to forward those endpoints through Cloudflare Workers. This unlocks historical session search, timeline browsing, analytics, and conversation export for future UI and data pipeline work.

## Feature Behaviors

### B1: Cass Health Check

**Core:**
- **ID:** cass-health
- **Trigger:** `GET /cass/health` request to cc-gateway
- **Expected:** Gateway spawns `cass health --json`, returns the JSON output with `healthy`, `latency_ms`, and `state` fields. Returns 503 if cass reports unhealthy or binary is missing.
- **Verify:** curl the endpoint and confirm `healthy: true` with sub-second latency.

#### UI Layer
N/A (backend only)

#### API Layer
- **Endpoint:** `GET /cass/health`
- **Auth:** Bearer token (same as all gateway endpoints)
- **Response 200:**
```json
{
  "healthy": true,
  "latency_ms": 12,
  "state": { "db": "ok", "index": "fresh" }
}
```
- **Response 503:** `{ "error": "cass unhealthy", "details": { ... } }`

#### Data Layer
N/A -- reads from cass subprocess (`cass health --json`)

---

### B2: Cass Capabilities

**Core:**
- **ID:** cass-capabilities
- **Trigger:** `GET /cass/capabilities` request to cc-gateway
- **Expected:** Gateway spawns `cass capabilities --json`, returns the JSON output with `features`, `limits`, and `connectors` fields.
- **Verify:** curl the endpoint and confirm `limits.max_limit` is a positive integer.

#### UI Layer
N/A (backend only)

#### API Layer
- **Endpoint:** `GET /cass/capabilities`
- **Auth:** Bearer token
- **Response 200:**
```json
{
  "features": ["search", "timeline", "export", "context"],
  "limits": {
    "max_limit": 100,
    "max_content_length": 50000,
    "max_fields": 20,
    "max_agg_buckets": 50
  },
  "connectors": ["claude-code"]
}
```

#### Data Layer
N/A -- reads from cass subprocess (`cass capabilities --json`)

---

### B3: Session Search

**Core:**
- **ID:** cass-search
- **Trigger:** `GET /cass/search?q=<query>` request to cc-gateway
- **Expected:** Gateway spawns `cass search <query> --json` with all supported query params forwarded as CLI flags. Returns search results array.
- **Verify:** Search for a known term and confirm results contain matching conversation excerpts.

#### UI Layer
N/A (backend only)

#### API Layer
- **Endpoint:** `GET /cass/search`
- **Auth:** Bearer token
- **Query params (all optional except `q`):**
  - `q` (required) -- search query string
  - `workspace` -- filter by workspace path
  - `agent` -- filter by agent name
  - `limit` -- max results (default cass default)
  - `offset` -- pagination offset
  - `cursor` -- cursor-based pagination
  - `days` -- limit to last N days
  - `since` -- ISO date lower bound
  - `until` -- ISO date upper bound
  - `mode` -- `lexical`, `semantic`, or `hybrid`
  - `highlight` -- boolean, include match highlights
  - `fields` -- comma-separated field list
  - `max_content_length` -- truncation limit
  - `timeout` -- timeout in milliseconds (maps to `--timeout`)
- **Note:** Gateway passes through cass JSON output verbatim. Field names match cass output: `source_path` (not `session_id`), `snippet` (not `excerpt`), `score`, `agent`, `workspace`, etc. The response shape shown is the native cass format.
- **Response 200:**
```json
{
  "count": 10,
  "hits": [
    {
      "source_path": "/home/ubuntu/.claude/projects/.../session.jsonl",
      "workspace": "/data/projects/baseplane-dev1",
      "agent": "claude_code",
      "title": "Fix auth token validation",
      "snippet": "...matched text...",
      "score": 24.5,
      "line_number": 1,
      "created_at": 1775645446287
    }
  ],
  "total_matches": 42,
  "cursor": "next-page-token",
  "_meta": { "elapsed_ms": 45 }
}
```
- **Response 400:** `{ "error": "Missing required query parameter: q" }`

#### Data Layer
N/A -- reads from cass subprocess (`cass search <q> --json [flags]`)

---

### B4: Activity Timeline

**Core:**
- **ID:** cass-timeline
- **Trigger:** `GET /cass/timeline` request to cc-gateway
- **Expected:** Gateway spawns `cass timeline --json` with supported date/grouping params forwarded as CLI flags. Returns grouped activity data.
- **Verify:** curl the endpoint and confirm response contains grouped entries with timestamps and counts.

#### UI Layer
N/A (backend only)

#### API Layer
- **Endpoint:** `GET /cass/timeline`
- **Auth:** Bearer token
- **Query params (all optional):**
  - `group_by` -- `hour`, `day`, or `none` (maps to `--group-by`)
  - `since` -- ISO date lower bound
  - `until` -- ISO date upper bound
  - `today` -- boolean, shortcut for today only
  - `agent` -- filter by agent name
- **Response 200:**
```json
{
  "groups": {
    "2026-04-07": {
      "count": 15,
      "sessions": [
        { "session_id": "abc-123", "workspace": "/data/projects/baseplane-dev1", "started_at": "2026-04-07T09:00:00Z" }
      ]
    }
  },
  "range": {
    "start": 1775539200000,
    "end": 1775625600000
  }
}
```

#### Data Layer
N/A -- reads from cass subprocess (`cass timeline --json [flags]`)

---

### B5: Index Statistics

**Core:**
- **ID:** cass-stats
- **Trigger:** `GET /cass/stats` request to cc-gateway
- **Expected:** Gateway spawns `cass stats --json`, returns conversation/message counts, per-agent breakdown, top workspaces, and date range.
- **Verify:** curl the endpoint and confirm `conversations` count is > 0 and `by_agent` is a non-empty array.

#### UI Layer
N/A (backend only)

#### API Layer
- **Endpoint:** `GET /cass/stats`
- **Auth:** Bearer token
- **Response 200:**
```json
{
  "conversations": 21432,
  "messages": 184000,
  "by_agent": [
    { "agent": "claude_code", "count": 21432 }
  ],
  "top_workspaces": [
    { "workspace": "/data/projects/baseplane-dev1", "count": 5000 }
  ],
  "date_range": {
    "oldest": 1748736000000,
    "newest": 1775908800000
  }
}
```

#### Data Layer
N/A -- reads from cass subprocess (`cass stats --json`)

---

### B6: Session Export

**Core:**
- **ID:** cass-export
- **Trigger:** `GET /cass/sessions/export?path=<session_path>` request to cc-gateway
- **Expected:** Gateway spawns `cass export <path> --format json`, optionally with `--include-tools`. Returns the full conversation JSON.
- **Verify:** Export a known session path and confirm response contains messages array with role/content fields.

#### UI Layer
N/A (backend only)

#### API Layer
- **Endpoint:** `GET /cass/sessions/export`
- **Auth:** Bearer token
- **Query params:**
  - `path` (required) -- session storage path
  - `include_tools` -- boolean, include tool call details (maps to `--include-tools`)
- **Response 200:**
```json
{
  "path": "/home/ubuntu/.claude/projects/.../session-abc",
  "messages": [
    { "role": "user", "content": "Fix the bug in auth.ts" },
    { "role": "assistant", "content": "I'll look at the auth module..." }
  ],
  "metadata": {
    "agent": "claude",
    "workspace": "/data/projects/baseplane-dev1",
    "started_at": "2026-04-07T14:30:00Z"
  }
}
```
- **Response 400:** `{ "error": "Missing required query parameter: path" }`
- **Response 404:** `{ "error": "Session not found at path" }` (cass exit code 3)

#### Data Layer
N/A -- reads from cass subprocess (`cass export <path> --format json`)

---

### B7: Session Context

**Core:**
- **ID:** cass-context
- **Trigger:** `GET /cass/sessions/context?path=<source_path>` request to cc-gateway
- **Expected:** Gateway spawns `cass context <path> --json` with optional `--limit`. Returns related sessions for the given session file path.
- **Verify:** Query with a known session file path and confirm response contains related session entries.

#### UI Layer
N/A (backend only)

#### API Layer
- **Endpoint:** `GET /cass/sessions/context`
- **Auth:** Bearer token
- **Query params:**
  - `path` (required) -- path to session source file (.jsonl)
  - `limit` -- max results
- **Response 200:**
```json
{
  "path": "/home/ubuntu/.claude/projects/-data-projects-baseplane-dev1/abc-123.jsonl",
  "related": [
    {
      "session_id": "abc-123",
      "workspace": "/data/projects/baseplane-dev1",
      "relevance": 0.85,
      "excerpt": "Modified auth.ts to fix token validation..."
    }
  ]
}
```
- **Response 400:** `{ "error": "Missing required query parameter: path" }`

#### Data Layer
N/A -- reads from cass subprocess (`cass context <path> --json`)

---

### B8: Diagnostics

**Core:**
- **ID:** cass-diag
- **Trigger:** `GET /cass/diag` request to cc-gateway
- **Expected:** Gateway spawns `cass diag --json`, returns connector info, database size, index size, paths, platform, and version.
- **Verify:** curl the endpoint and confirm response contains `database_size` and `version` fields.

#### UI Layer
N/A (backend only)

#### API Layer
- **Endpoint:** `GET /cass/diag`
- **Auth:** Bearer token
- **Response 200:**
```json
{
  "connectors": ["claude-code"],
  "database_size": "3.1 GB",
  "index_size": "450 MB",
  "paths": {
    "database": "/home/ubuntu/.local/share/coding-agent-search/agent_search.db",
    "index": "/home/ubuntu/.local/share/coding-agent-search/index"
  },
  "platform": "linux-x64",
  "version": "0.8.2"
}
```

#### Data Layer
N/A -- reads from cass subprocess (`cass diag --json`)

---

### B9: Trigger Index

**Core:**
- **ID:** cass-index-trigger
- **Trigger:** `POST /cass/index` request to cc-gateway
- **Expected:** Gateway spawns `cass index --json`, returns indexing results with conversations/messages indexed and elapsed time. Returns 409 Conflict if cass exit code is 7 (lock/busy from concurrent index).
- **Verify:** POST to the endpoint and confirm response contains `conversations_indexed` and `elapsed_ms`.

#### UI Layer
N/A (backend only)

#### API Layer
- **Endpoint:** `POST /cass/index`
- **Auth:** Bearer token
- **Response 200:**
```json
{
  "conversations_indexed": 150,
  "messages_indexed": 1200,
  "elapsed_ms": 3400
}
```
- **Response 409:** `{ "error": "Index operation already in progress" }` (cass exit code 7)

#### Data Layer
N/A -- reads from cass subprocess (`cass index --json`)

---

### B10: Orchestrator Proxy

**Core:**
- **ID:** orch-cass-proxy
- **Trigger:** Any `GET /api/cass/*` or `POST /api/cass/*` request to the orchestrator
- **Expected:** Orchestrator forwards the request to the cc-gateway at `CC_GATEWAY_URL` (converted to HTTP), preserving path suffix, query params, method, and injecting the `CC_GATEWAY_SECRET` as Bearer auth. Returns the gateway response body and status code.
- **Verify:** Hit an orchestrator cass proxy route and confirm response matches direct gateway output.

#### UI Layer
N/A (backend only)

#### API Layer
- **Endpoint:** `/api/cass/*` (wildcard proxy)
- **Auth:** Orchestrator auth middleware (Better Auth session cookie or token), then forwards with gateway Bearer token
- **Proxy mapping:** `/api/cass/health` -> `GET {CC_GATEWAY_URL}/cass/health`, `/api/cass/search?q=foo` -> `GET {CC_GATEWAY_URL}/cass/search?q=foo`, etc.
- **Implementation:** Add a Hono wildcard route in `apps/orchestrator/src/api/index.ts` that uses `fetchGatewayProjects`-style HTTP forwarding pattern (convert wss:// to https://, inject Bearer header).
- **Response:** Pass-through from gateway (same status code and JSON body).
- **Response 502:** `{ "error": "Gateway unreachable" }` if fetch to gateway fails.

#### Data Layer
N/A -- proxies to gateway

---

### B11: Cass Binary Detection and Error Handling

**Core:**
- **ID:** cass-binary-detection
- **Trigger:** Any `/cass/*` endpoint is called but the `cass` binary is not installed or not in PATH
- **Expected:** Gateway catches the spawn error (ENOENT or similar), returns 503 with a descriptive error message indicating cass is not available. All cass endpoints share this detection logic.
- **Verify:** Temporarily rename the cass binary, call any cass endpoint, confirm 503 response with clear error message.

#### UI Layer
N/A (backend only)

#### API Layer
- **All `/cass/*` endpoints** return:
- **Response 503:** `{ "error": "cass binary not found or not executable" }`
- **Exit code mapping:**
  - Exit 0: success, return parsed JSON with 200
  - Exit 1: unhealthy/general failure, return 503 with `{ "error": "cass unhealthy", "details": "<stderr>" }`
  - Exit 2: usage error (bad params), return 400 with `{ "error": "Invalid parameters", "details": "<stderr>" }`
  - Exit 3: resource not found, return 404 with `{ "error": "Not found", "details": "<stderr>" }`
  - Exit 7: lock/busy, return 409 with `{ "error": "Index operation already in progress" }`
  - Exit 8: partial results, return 200 with parsed JSON plus `{ "_warning": "partial_results" }`
  - Other non-zero: return 500 with `{ "error": "cass command failed", "exit_code": N, "details": "<stderr>" }`

#### Data Layer
N/A

---

### B12: Auto-Index on Staleness

**Core:**
- **ID:** cass-auto-index
- **Trigger:** Any `/cass/search`, `/cass/timeline`, or `/cass/stats` request when the last known index time is older than a configurable threshold (default: 5 minutes)
- **Expected:** Gateway checks index freshness via `cass status --json` (cached for 60 seconds). If `recommended_action` indicates re-indexing is needed, spawns `cass index --json` in the background (fire-and-forget, non-blocking) before returning the query results from the current index. Does not block or delay the user's request.
- **Verify:** Wait for index to become stale, make a search request, then check gateway logs for background index trigger.

#### UI Layer
N/A (backend only)

#### API Layer
- No separate endpoint -- this is internal gateway logic triggered as a side effect of B3, B4, and B5 endpoints.
- The response from the query endpoint is unchanged; the index refresh happens asynchronously.
- A `_index_triggered` boolean field is added to responses when auto-indexing was kicked off:
```json
{
  "results": [...],
  "_index_triggered": true
}
```

#### Data Layer
N/A -- gateway-internal caching of `cass status --json` output, refreshed at most once per 60 seconds.

---

### B13: Cass Status

**Core:**
- **ID:** cass-status
- **Trigger:** `GET /cass/status` request to cc-gateway
- **Expected:** Gateway spawns `cass status --json`, returns database stats, index freshness, pending sessions, and recommended action.
- **Verify:** curl the endpoint and confirm response contains `pending_sessions` and `recommended_action` fields.

#### UI Layer
N/A (backend only)

#### API Layer
- **Endpoint:** `GET /cass/status`
- **Auth:** Bearer token
- **Response 200:**
```json
{
  "database_stats": {
    "conversations": 21432,
    "messages": 184000
  },
  "index_freshness": {
    "last_indexed_at": 1775908800000,
    "stale": false
  },
  "pending_sessions": 3,
  "recommended_action": "none"
}
```

#### Data Layer
N/A -- reads from cass subprocess (`cass status --json`)

## Non-Goals

- **No React UI** -- frontend for browsing cass sessions is a separate spec.
- **No direct SQLite access** -- all data access goes through the cass CLI subprocess, never by reading `~/.local/share/coding-agent-search/agent_search.db` directly.
- **No user-scoping** -- the VPS is single-user; all sessions belong to the same operator. No multi-tenant filtering.
- **No replacing existing session endpoints** -- the existing `GET /api/sessions` and `GET /api/projects/{name}/sessions` routes backed by Durable Object SQLite remain unchanged. Cass endpoints are complementary.

## Implementation Phases

**Phase P1: Gateway cass subprocess foundation** -- Create the `cass.ts` handler file in `packages/cc-gateway/src/` with the `Bun.spawn` subprocess wrapper, implement `/cass/health` and `/cass/capabilities` endpoints, add cass binary detection with proper error responses, and update the OpenAPI spec in `packages/cc-gateway/src/openapi.ts`.

**Phase P2: Gateway search, timeline, and stats endpoints** -- Implement `GET /cass/search` with full query param passthrough, `GET /cass/timeline` with date filtering and grouping, `GET /cass/stats`, and `POST /cass/index` trigger endpoint. Wire up exit code mapping for all new endpoints.

**Phase P3: Gateway export, context, and diag endpoints** -- Implement `GET /cass/sessions/export`, `GET /cass/sessions/context`, `GET /cass/diag`, and the auto-index freshness check logic (B12).

**Phase P4: Orchestrator proxy routes** -- Add `/api/cass/*` wildcard proxy route in `apps/orchestrator/src/api/index.ts` using the existing `fetchGatewayProjects`-style HTTP forwarding pattern, forward auth headers, and write integration tests for end-to-end proxy behavior.

## Verification Strategy

### Test Infrastructure
Integration tests using `bun:test` in `packages/cc-gateway/src/__tests__/`. Tests call real gateway endpoints at `http://127.0.0.1:9877` with real cass data. The gateway must be running and cass must be installed on the VPS. Tests use the `CC_GATEWAY_API_TOKEN` env var for auth if configured.

### Build Verification
`pnpm typecheck` from repo root must pass with no errors. `pnpm build` from repo root must complete successfully. New types added to `packages/shared-types/src/index.ts` must not break existing consumers.

## Verification Plan

All commands assume the gateway is running at `http://127.0.0.1:9877`. Replace `$TOKEN` with the value of `CC_GATEWAY_API_TOKEN` if auth is configured, or omit the `-H` header if the gateway is running in open mode.

### VP1: Health and Capabilities

**Step 1 -- Cass health:**
```bash
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:9877/cass/health | jq .
```
**Expected:** HTTP 200. Response contains `"healthy": true`, `"latency_ms"` as a number, and `"state"` as an object.

**Step 2 -- Cass capabilities:**
```bash
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:9877/cass/capabilities | jq .
```
**Expected:** HTTP 200. Response contains `"features"` as an array, `"limits"` with `"max_limit"` as a positive integer, and `"connectors"` as an array.

**Step 3 -- Unauthorized access:**
```bash
curl -s -w "\n%{http_code}" http://127.0.0.1:9877/cass/health
```
**Expected:** HTTP 401 with `{ "error": "Unauthorized" }` (when `CC_GATEWAY_API_TOKEN` is set).

### VP2: Search Endpoint

**Step 1 -- Basic search:**
```bash
curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:9877/cass/search?q=auth" | jq .
```
**Expected:** HTTP 200. Response contains `"hits"` as an array with at least one entry containing `"source_path"` and `"snippet"` fields.

**Step 2 -- Search with filters:**
```bash
curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:9877/cass/search?q=auth&limit=5&days=30&mode=lexical" | jq .
```
**Expected:** HTTP 200. Response `"hits"` array has at most 5 entries.

**Step 3 -- Missing query parameter:**
```bash
curl -s -w "\n%{http_code}" -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:9877/cass/search" 
```
**Expected:** HTTP 400 with `{ "error": "Missing required query parameter: q" }`.

### VP3: Timeline Endpoint

**Step 1 -- Default timeline:**
```bash
curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:9877/cass/timeline" | jq .
```
**Expected:** HTTP 200. Response contains `"groups"` as an object keyed by period string and `"range"` with `"start"`/`"end"` timestamps.

**Step 2 -- Timeline with date filter:**
```bash
curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:9877/cass/timeline?group_by=day&today=true" | jq .
```
**Expected:** HTTP 200. Response `"groups"` object contains keys for today only.

### VP4: Stats Endpoint

**Step 1 -- Get stats:**
```bash
curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:9877/cass/stats" | jq .
```
**Expected:** HTTP 200. Response contains `"conversations"` as a positive integer, `"messages"` as a positive integer, `"by_agent"` as a non-empty array, and `"date_range"` object.

### VP5: Export Endpoint

**Step 1 -- Export a session:**
```bash
SESSION_PATH=$(curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:9877/cass/search?q=auth&limit=1" | jq -r '.hits[0].source_path // empty')
curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:9877/cass/sessions/export?path=$SESSION_PATH" | jq .
```
**Expected:** HTTP 200. Response contains `"messages"` as a non-empty array and `"metadata"` object.

**Step 2 -- Export with missing path:**
```bash
curl -s -w "\n%{http_code}" -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:9877/cass/sessions/export"
```
**Expected:** HTTP 400 with `{ "error": "Missing required query parameter: path" }`.

### VP6: Index Trigger

**Step 1 -- Trigger index:**
```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:9877/cass/index" | jq .
```
**Expected:** HTTP 200. Response contains `"conversations_indexed"` and `"elapsed_ms"` as numbers.

**Step 2 -- Diagnostics:**
```bash
curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:9877/cass/diag" | jq .
```
**Expected:** HTTP 200. Response contains `"version"` as a string and `"database_size"` as a string.

**Step 3 -- Context lookup:**
```bash
curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:9877/cass/sessions/context?path=/home/ubuntu/.claude/projects/-data-projects-baseplane-dev1/abc-123.jsonl" | jq .
```
**Expected:** HTTP 200. Response contains `"related"` as an array.

**Step 4 -- Cass status:**
```bash
curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:9877/cass/status" | jq .
```
**Expected:** HTTP 200. Response contains `"pending_sessions"` and `"recommended_action"` fields.

### VP7: Orchestrator Proxy

**Step 1 -- Proxy health through orchestrator:**
```bash
curl -s -b cookies.txt "https://duraclaw.bfreeed.workers.dev/api/cass/health" | jq .
```
**Expected:** HTTP 200. Same response shape as direct gateway `/cass/health`.

**Step 2 -- Proxy search through orchestrator:**
```bash
curl -s -b cookies.txt "https://duraclaw.bfreeed.workers.dev/api/cass/search?q=auth&limit=3" | jq .
```
**Expected:** HTTP 200. Same response shape as direct gateway `/cass/search`.

**Step 3 -- Proxy index trigger through orchestrator:**
```bash
curl -s -X POST -b cookies.txt "https://duraclaw.bfreeed.workers.dev/api/cass/index" | jq .
```
**Expected:** HTTP 200. Same response shape as direct gateway `/cass/index`.

## Implementation Hints

- **Subprocess wrapper location:** Create `packages/cc-gateway/src/cass.ts` as the handler file. Follow the pattern of `packages/cc-gateway/src/files.ts` and `packages/cc-gateway/src/kata.ts` -- export handler functions that return `Promise<Response>`.
- **Key imports:** `Bun.spawn` from the Bun runtime for subprocess execution, `verifyToken` from `./auth.js` (already used in `packages/cc-gateway/src/server.ts`).
- **Route registration:** Add new route blocks in the `fetch()` handler of `packages/cc-gateway/src/server.ts`, after the auth check (`if (!verifyToken(req))`) and before the WebSocket upgrade block. Match paths with `path.startsWith('/cass/')` or individual route matching.
- **Subprocess pattern:** Use `Bun.spawn(['cass', subcommand, '--json', ...flags])` with `stdout: 'pipe'` and `stderr: 'pipe'`. Collect output via `new Response(proc.stdout).text()`. Set `env: { ...process.env, CODING_AGENT_SEARCH_NO_UPDATE_PROMPT: '1' }` to suppress interactive update prompts.
- **JSON helper:** Reuse the existing `json(status, body)` helper already defined in `packages/cc-gateway/src/server.ts` -- either export it or pass it to handler functions.
- **Exit code 7 (lock/busy):** Cass uses a lock file for index operations. If `cass index --json` exits with code 7, return HTTP 409 Conflict with an appropriate error message. Do not retry.
- **Exit code 8 (partial results):** Still return HTTP 200, but add `"_warning": "partial_results"` to the response body so callers know the data may be incomplete.
- **Exit code 3 (not found):** Return HTTP 404. This covers cases like exporting a non-existent session path.
- **OpenAPI update:** Add all new endpoints to the `paths` object in `packages/cc-gateway/src/openapi.ts` following the existing pattern for `/projects/{name}/kata-status`.
- **Orchestrator proxy:** Add a catch-all route in `apps/orchestrator/src/api/index.ts` using `app.all('/api/cass/*', ...)`. Convert `CC_GATEWAY_URL` from wss:// to https:// (same pattern as `fetchGatewayProjects`), build the target URL from the wildcard path suffix and query string, inject `Authorization: Bearer ${env.CC_GATEWAY_SECRET}`, and return the fetch response.
- **Auto-index caching:** Store the last `cass status --json` result and timestamp in a module-level variable in `cass.ts`. Check staleness before query endpoints. If stale, fire `Bun.spawn(['cass', 'index', '--json'])` without awaiting -- let it complete in the background.
- **Shared types:** Add `CassHealthResponse`, `CassCapabilitiesResponse`, `CassSearchResult`, etc. to `packages/shared-types/src/index.ts` for type-safe proxy responses in the orchestrator.
