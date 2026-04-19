---
initiative: feat-cass-session-api
type: project
issue_type: feature
status: parked
priority: medium
github_issue: null
created: 2026-04-08
updated: 2026-04-19
parked_note: "Filename used the `12-` prefix but GH #12 is unrelated (TanStack DB client unification, see 12-client-data-layer-unification.md). Renamed to `parked-` prefix and unset github_issue to avoid kata picking this up by filename collision. Spec content preserved as-is — re-file under a fresh issue number if/when the cass API work is actually scheduled."
phases:
  - id: p1
    name: "Cass subprocess wrapper and search endpoint"
    tasks:
      - "Create cass.ts handler with Bun.spawn subprocess wrapper"
      - "Implement GET /cass/search with query param passthrough"
      - "Add cass binary detection and exit code mapping"
      - "Update OpenAPI spec with cass endpoints"
    test_cases:
      - id: "gw-cass-search"
        description: "GET /cass/search returns JSON results from cass search"
        type: "integration"
      - id: "gw-cass-missing"
        description: "Endpoints return 503 when cass binary not found"
        type: "integration"
  - id: p2
    name: "Sync contract and push endpoint"
    tasks:
      - "Define CassSessionRecord schema in shared-types"
      - "Implement POST /cass/sync — extract new rows, push to configured endpoint"
      - "Add cursor/watermark tracking for incremental sync"
      - "Implement configurable remote ingest endpoint (env var)"
    test_cases:
      - id: "gw-cass-sync"
        description: "POST /cass/sync extracts new sessions and pushes to remote endpoint"
        type: "integration"
      - id: "gw-cass-sync-incremental"
        description: "Subsequent syncs only push new rows since last watermark"
        type: "integration"
  - id: p3
    name: "Orchestrator proxy and index trigger"
    tasks:
      - "Add /api/cass/* proxy routes in orchestrator"
      - "Implement POST /cass/index to trigger re-indexing"
      - "Wire session completion hook to trigger sync"
    test_cases:
      - id: "orch-cass-proxy"
        description: "Orchestrator /api/cass/* routes proxy to gateway and return results"
        type: "integration"
      - id: "gw-cass-index"
        description: "POST /cass/index triggers cass re-indexing"
        type: "integration"
---

# Cass Session API

## Overview

The VPS has 21k+ coding agent sessions indexed by the `cass` CLI, but this data is trapped on the local machine. This spec adds two capabilities to cc-gateway: (1) a search endpoint for ad-hoc local queries, and (2) a sync mechanism that pushes cass session records to a configurable remote ingest endpoint. The remote system (currently baseplane's dataforge) handles enrichment, summarization, analytics, and serving the session list UI. Cass is the extraction layer, not the query layer.

## Feature Behaviors

### B1: Session Search

**Core:**
- **ID:** cass-search
- **Trigger:** `GET /cass/search?q=<query>` request to cc-gateway
- **Expected:** Gateway spawns `cass search <query> --json` with all supported query params forwarded as CLI flags. Returns cass JSON output verbatim.
- **Verify:** Search for a known term and confirm results contain matching conversation hits.

#### UI Layer
N/A (backend only)

#### API Layer
- **Endpoint:** `GET /cass/search`
- **Auth:** Bearer token (same as all gateway endpoints)
- **Query params (all optional except `q`):**
  - `q` (required) -- search query string
  - `workspace` -- filter by workspace path
  - `agent` -- filter by agent name (claude_code, codex, gemini)
  - `limit` -- max results (default 10)
  - `offset` -- pagination offset
  - `cursor` -- cursor-based pagination (from previous `_meta.next_cursor`)
  - `days` -- limit to last N days
  - `since` -- ISO date lower bound
  - `until` -- ISO date upper bound
  - `mode` -- `lexical`, `semantic`, or `hybrid`
  - `highlight` -- boolean, include match highlights
  - `fields` -- comma-separated field list or preset (`minimal`, `summary`)
  - `max_content_length` -- truncation limit in characters
  - `timeout` -- timeout in milliseconds
- **Response 200:** Gateway passes through cass JSON output verbatim. Field names match cass output:
```json
{
  "count": 10,
  "total_matches": 42,
  "hits": [
    {
      "source_path": "/home/ubuntu/.claude/projects/.../session.jsonl",
      "workspace": "/data/projects/baseplane-dev1",
      "agent": "claude_code",
      "title": "Fix auth token validation",
      "snippet": "...matched text...",
      "content": "full message text",
      "score": 24.5,
      "line_number": 1,
      "match_type": "exact",
      "created_at": 1775645446287,
      "source_id": "local",
      "origin_kind": "local"
    }
  ],
  "cursor": "next-page-token",
  "hits_clamped": false,
  "_meta": {
    "elapsed_ms": 45,
    "search_mode": "lexical",
    "index_freshness": { "fresh": true, "stale": false }
  }
}
```
- **Response 400:** `{ "error": "Missing required query parameter: q" }`

#### Data Layer
N/A -- reads from cass subprocess (`cass search <q> --json [flags]`)

---

### B2: Sync Contract — CassSessionRecord Schema

**Core:**
- **ID:** cass-sync-schema
- **Trigger:** Defined at build time in `packages/shared-types/src/index.ts`
- **Expected:** A `CassSessionRecord` type defines the shape of each row pushed to the remote ingest endpoint. This is the contract between the gateway (producer) and any remote consumer.
- **Verify:** Type is exported from shared-types and used by both the sync handler and documented in the spec.

#### UI Layer
N/A

#### API Layer
The sync contract schema — each record pushed to the remote endpoint:
```typescript
interface CassSessionRecord {
  /** cass internal row ID */
  id: number
  /** Agent type: claude_code, codex, gemini, etc. */
  agent: string
  /** Path to raw session JSONL file */
  source_path: string
  /** Working directory the session ran in */
  workspace: string
  /** First user message, truncated (cass-generated) */
  title: string
  /** Session start time (epoch ms) */
  started_at: number
  /** Session end time (epoch ms) */
  ended_at: number
  /** Duration in seconds */
  duration_seconds: number
  /** Total messages in conversation */
  message_count: number
  /** Source identifier */
  source_id: string
  /** local or remote */
  origin_kind: string
  /** Remote hostname if applicable */
  origin_host: string | null
}
```

This maps 1:1 to the fields cass returns from `cass timeline --json --group-by none`.

#### Data Layer
Type definition only -- no storage. Shared between gateway (sync producer) and remote consumer.

---

### B3: Sync Push

**Core:**
- **ID:** cass-sync-push
- **Trigger:** `POST /cass/sync` request to cc-gateway, or automatically after session completion
- **Expected:** Gateway runs `cass timeline --json --group-by none --since <watermark>` to extract sessions newer than the last sync. Converts each entry to a `CassSessionRecord`. POSTs the batch to the configured remote ingest endpoint (`CASS_SYNC_ENDPOINT` env var). Updates the local watermark on success.
- **Verify:** Trigger sync, confirm remote endpoint received the batch, confirm subsequent sync only sends newer rows.

#### UI Layer
N/A (backend only)

#### API Layer
- **Gateway endpoint:** `POST /cass/sync`
- **Auth:** Bearer token
- **Response 200:**
```json
{
  "synced": 15,
  "watermark": "2026-04-08T12:00:00Z",
  "remote_status": 200
}
```
- **Response 200 (nothing to sync):**
```json
{
  "synced": 0,
  "watermark": "2026-04-08T12:00:00Z"
}
```
- **Response 503:** `{ "error": "CASS_SYNC_ENDPOINT not configured" }` if env var not set
- **Response 502:** `{ "error": "Remote ingest failed", "remote_status": 500, "details": "..." }` if remote endpoint returns non-2xx

**Remote ingest contract (what the gateway POSTs):**
- **Method:** `POST`
- **URL:** `${CASS_SYNC_ENDPOINT}/ingest`
- **Headers:**
  - `Content-Type: application/json`
  - `Authorization: Bearer ${CASS_SYNC_TOKEN}` (if `CASS_SYNC_TOKEN` env var is set)
- **Body:**
```json
{
  "source": "duraclaw-gateway",
  "batch": [
    { /* CassSessionRecord */ },
    { /* CassSessionRecord */ }
  ],
  "watermark": "2026-04-08T12:00:00Z",
  "total": 15
}
```
- **Expected response:** HTTP 2xx. Body is opaque to the gateway (logged but not parsed).

**Watermark tracking:**
- Stored as a file at `~/.local/share/duraclaw/cass-sync-watermark.json`
- Contains `{ "last_sync": "ISO-date", "last_id": 21045 }`
- On first sync (no watermark), syncs all sessions from the last 30 days
- Watermark advances to the most recent `ended_at` timestamp in the batch on successful push

#### Data Layer
- Watermark file: `~/.local/share/duraclaw/cass-sync-watermark.json`
- No database -- watermark is a single JSON file

---

### B4: Trigger Index

**Core:**
- **ID:** cass-index-trigger
- **Trigger:** `POST /cass/index` request to cc-gateway
- **Expected:** Gateway spawns `cass index --json`, returns indexing results. Returns 409 Conflict if cass exit code is 7 (lock/busy from concurrent index).
- **Verify:** POST to the endpoint and confirm response contains indexing stats.

#### UI Layer
N/A (backend only)

#### API Layer
- **Endpoint:** `POST /cass/index`
- **Auth:** Bearer token
- **Response 200:**
```json
{
  "success": true,
  "conversations": 21110,
  "messages": 742986,
  "elapsed_ms": 3400
}
```
- **Response 409:** `{ "error": "Index operation already in progress" }` (cass exit code 7)

#### Data Layer
N/A -- reads from cass subprocess (`cass index --json`)

---

### B5: Cass Binary Detection and Exit Code Mapping

**Core:**
- **ID:** cass-binary-detection
- **Trigger:** Any `/cass/*` endpoint is called
- **Expected:** All cass endpoints share centralized subprocess execution with binary detection and exit code mapping. If the cass binary is not found, returns 503. Exit codes map to appropriate HTTP status codes.
- **Verify:** Call any cass endpoint with cass unavailable, confirm 503 with clear error.

#### UI Layer
N/A (backend only)

#### API Layer
- **All `/cass/*` endpoints** use shared exit code mapping:
  - Exit 0: success, return parsed JSON with 200
  - Exit 1: unhealthy/general failure, return 503 with `{ "error": "cass unhealthy", "details": "<stderr>" }`
  - Exit 2: usage error (bad params), return 400 with `{ "error": "Invalid parameters", "details": "<stderr>" }`
  - Exit 3: resource not found, return 404 with `{ "error": "Not found", "details": "<stderr>" }`
  - Exit 7: lock/busy, return 409 with `{ "error": "Index operation already in progress" }`
  - Exit 8: partial results, return 200 with parsed JSON plus `{ "_warning": "partial_results" }`
  - Other non-zero: return 500 with `{ "error": "cass command failed", "exit_code": N, "details": "<stderr>" }`
- **Binary not found:** return 503 with `{ "error": "cass binary not found or not executable" }`

#### Data Layer
N/A

---

### B6: Orchestrator Proxy

**Core:**
- **ID:** orch-cass-proxy
- **Trigger:** Any `GET /api/cass/*` or `POST /api/cass/*` request to the orchestrator
- **Expected:** Orchestrator forwards the request to the cc-gateway at `CC_GATEWAY_URL`, preserving path suffix, query params, method, and injecting `CC_GATEWAY_SECRET` as Bearer auth. Returns the gateway response body and status code.
- **Verify:** Hit an orchestrator cass proxy route and confirm response matches direct gateway output.

#### UI Layer
N/A (backend only)

#### API Layer
- **Endpoint:** `/api/cass/*` (wildcard proxy)
- **Auth:** Orchestrator auth middleware (Better Auth session), then forwards with gateway Bearer token
- **Proxy mapping:** `/api/cass/search?q=foo` -> `GET {CC_GATEWAY_URL}/cass/search?q=foo`, `/api/cass/sync` -> `POST {CC_GATEWAY_URL}/cass/sync`, etc.
- **Implementation:** Wildcard route in `apps/orchestrator/src/api/index.ts` using existing HTTP forwarding pattern (convert wss:// to https://, inject Bearer header). Must be registered after the auth middleware `use()` call.
- **Response:** Pass-through from gateway (same status code and JSON body).
- **Response 502:** `{ "error": "Gateway unreachable" }` if fetch to gateway fails.

#### Data Layer
N/A -- proxies to gateway

---

### B7: Session Completion Sync Hook

**Core:**
- **ID:** cass-completion-hook
- **Trigger:** A Claude Code session completes (result event received on WebSocket)
- **Expected:** After a session completes, the gateway triggers `cass index` (to pick up the new session) then `POST /cass/sync` (to push it to the remote endpoint). Both are fire-and-forget (non-blocking, don't delay the result event).
- **Verify:** Complete a session, wait a few seconds, confirm the new session appears in the remote endpoint.

#### UI Layer
N/A (backend only)

#### API Layer
No new endpoint -- internal gateway logic triggered as a side effect of session completion in the WebSocket `result` event handler in `packages/cc-gateway/src/server.ts`.

Sequence:
1. Session result event received
2. Fire-and-forget: `cass index --json` (subprocess, no await)
3. After index completes: `POST /cass/sync` (internal call, no await on the HTTP response to the session)

#### Data Layer
N/A

## Non-Goals

- **No wrapping every cass command** -- only search, index, and sync are exposed. Timeline, stats, diag, capabilities, health, export, context are not needed as HTTP endpoints. Use `cass` CLI directly for those.
- **No React UI** -- frontend for browsing sessions is a separate spec, built against the remote DB.
- **No direct SQLite access** -- all cass data access goes through the CLI subprocess.
- **No session list endpoint** -- the remote DB (dataforge) serves the session list. The gateway is a sync pump, not a query layer.
- **No enrichment on the gateway** -- cost, model, summary, structured tags are added by the remote system, not the gateway.

## Implementation Phases

**Phase P1: Cass subprocess wrapper and search endpoint** -- Create `packages/cc-gateway/src/cass.ts` with the `Bun.spawn` wrapper, exit code mapping, and binary detection. Implement `GET /cass/search` with full query param passthrough. Update `packages/cc-gateway/src/openapi.ts`.

**Phase P2: Sync contract and push endpoint** -- Define `CassSessionRecord` in `packages/shared-types/src/index.ts`. Implement `POST /cass/sync` with watermark tracking, `cass timeline` extraction, and HTTP push to `CASS_SYNC_ENDPOINT`. Implement `POST /cass/index`.

**Phase P3: Orchestrator proxy and completion hook** -- Add `/api/cass/*` wildcard proxy in `apps/orchestrator/src/api/index.ts`. Wire session completion in the WebSocket handler to trigger index + sync as fire-and-forget.

## Verification Strategy

### Test Infrastructure
Integration tests using `bun:test` in `packages/cc-gateway/src/__tests__/`. Tests call real gateway endpoints at `http://127.0.0.1:9877` with real cass data. The gateway must be running and cass must be installed on the VPS.

### Build Verification
`pnpm typecheck` from repo root must pass. `pnpm build` must complete. New types in `packages/shared-types/src/index.ts` must not break existing consumers.

## Verification Plan

All commands assume gateway at `http://127.0.0.1:9877`. Replace `$TOKEN` with `CC_GATEWAY_API_TOKEN` value.

### VP1: Search Endpoint

**Step 1 -- Basic search:**
```bash
curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:9877/cass/search?q=auth" | jq .
```
**Expected:** HTTP 200. Response contains `"hits"` as an array with at least one entry containing `"source_path"`, `"snippet"`, and `"score"` fields.

**Step 2 -- Search with filters:**
```bash
curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:9877/cass/search?q=auth&limit=5&days=30&mode=lexical" | jq .
```
**Expected:** HTTP 200. `"hits"` array has at most 5 entries.

**Step 3 -- Missing query parameter:**
```bash
curl -s -w "\n%{http_code}" -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:9877/cass/search"
```
**Expected:** HTTP 400 with `{ "error": "Missing required query parameter: q" }`.

### VP2: Sync Endpoint

**Step 1 -- Trigger sync (no endpoint configured):**
```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:9877/cass/sync" | jq .
```
**Expected:** HTTP 503 with `{ "error": "CASS_SYNC_ENDPOINT not configured" }`.

**Step 2 -- Trigger sync (with endpoint configured):**
```bash
# Start a local HTTP server to receive the sync payload
python3 -c "
from http.server import HTTPServer, BaseHTTPRequestHandler
import json
class H(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers['Content-Length'])
        body = json.loads(self.rfile.read(length))
        print(json.dumps(body, indent=2)[:500])
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'ok')
HTTPServer(('127.0.0.1', 9999), H).handle_request()
" &
sleep 1
CASS_SYNC_ENDPOINT=http://127.0.0.1:9999 curl -s -X POST -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:9877/cass/sync" | jq .
```
**Expected:** HTTP 200. Response contains `"synced"` as a positive integer and `"watermark"` as an ISO date. The local server prints a JSON body with `"source"`, `"batch"` (array of CassSessionRecord), and `"total"`.

### VP3: Index Trigger

**Step 1 -- Trigger index:**
```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:9877/cass/index" | jq .
```
**Expected:** HTTP 200. Response contains `"success": true`, `"conversations"` as a positive integer, and `"elapsed_ms"`.

### VP4: Orchestrator Proxy

**Step 1 -- Proxy search through orchestrator:**
```bash
curl -s -b cookies.txt "https://duraclaw.bfreeed.workers.dev/api/cass/search?q=auth&limit=3" | jq .
```
**Expected:** HTTP 200. Same response shape as direct gateway `/cass/search`.

## Implementation Hints

- **Subprocess wrapper location:** Create `packages/cc-gateway/src/cass.ts`. Follow the pattern of `packages/cc-gateway/src/files.ts` -- export handler functions that return `Promise<Response>`.
- **Key imports:** `Bun.spawn` for subprocess execution, `verifyToken` from `./auth.js` (already used in `packages/cc-gateway/src/server.ts`).
- **Route registration:** Add route blocks in the `fetch()` handler of `packages/cc-gateway/src/server.ts` after the auth check. Match with `path.startsWith('/cass/')`.
- **Subprocess pattern:** `Bun.spawn(['cass', subcommand, '--json', ...flags], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, CODING_AGENT_SEARCH_NO_UPDATE_PROMPT: '1' } })`. Collect output via `new Response(proc.stdout).text()`.
- **JSON helper:** Reuse the existing `json(status, body)` helper from `packages/cc-gateway/src/server.ts`.
- **Watermark file:** Use `Bun.file()` and `Bun.write()` for reading/writing `~/.local/share/duraclaw/cass-sync-watermark.json`. Create parent directory if needed.
- **Sync endpoint env vars:** `CASS_SYNC_ENDPOINT` (required for sync, URL base), `CASS_SYNC_TOKEN` (optional, Bearer token for remote auth).
- **Orchestrator proxy:** Wildcard route in `apps/orchestrator/src/api/index.ts` using `fetchGatewayProjects`-style pattern (convert wss:// to https://, inject Bearer header). Register after auth middleware.
- **Completion hook:** In the WebSocket `result` event handler in `packages/cc-gateway/src/server.ts`, add a fire-and-forget call: spawn `cass index`, then on completion call the sync handler internally.
- **OpenAPI:** Add `/cass/search`, `/cass/sync`, `/cass/index` to `packages/cc-gateway/src/openapi.ts`.

### Reference Docs
- [Bun.spawn API](https://bun.sh/docs/api/spawn) -- subprocess execution in Bun
- [cass robot-docs](run `cass robot-docs commands` locally) -- machine-readable CLI docs
