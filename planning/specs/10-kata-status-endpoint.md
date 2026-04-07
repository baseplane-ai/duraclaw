---
initiative: feat-kata-status-endpoint
type: project
issue_type: feature
status: approved
priority: medium
github_issue: 10
created: 2026-04-06
updated: 2026-04-07
phases:
  - id: p1
    name: "Shared types and kata integration"
    tasks:
      - "Add KataSessionState type to @duraclaw/shared-types"
      - "Add kata_state GatewayEvent variant"
      - "Implement kata state-reading logic inline in cc-gateway (kata has no package.json)"
    test_cases:
      - id: "kata-state-type"
        description: "KataSessionState type compiles with expected fields"
        type: "unit"
  - id: p2
    name: "HTTP endpoint"
    tasks:
      - "Add GET /projects/:name/kata-status endpoint to server.ts"
      - "Implement kata state reading using kata package functions"
      - "Handle edge cases: missing dir, no sessions, corrupt state"
    test_cases:
      - id: "kata-status-endpoint"
        description: "GET /projects/:name/kata-status returns kata session state"
        type: "integration"
      - id: "kata-status-missing"
        description: "Returns null when no .kata directory exists"
        type: "integration"
      - id: "kata-status-404"
        description: "Returns 404 for unknown project name"
        type: "integration"
  - id: p3
    name: "WebSocket push via file watcher"
    tasks:
      - "Add fs.watch on .kata/sessions/ directory per active WS connection"
      - "Push kata_state GatewayEvent when state.json changes"
      - "Clean up watchers on WS disconnect"
    test_cases:
      - id: "kata-state-push"
        description: "kata_state event pushed when state.json changes"
        type: "integration"
      - id: "watcher-cleanup"
        description: "File watcher cleaned up on WS disconnect"
        type: "unit"
---

# Kata Status Endpoint

> GitHub Issue: [#10](https://github.com/codevibesmatter/duraclaw/issues/10)

## Overview

The orchestrator (Duraclaw and Baseplane) currently has no visibility into kata workflow state running on the VPS. This feature exposes kata session state through a new HTTP endpoint on the cc-gateway and pushes state changes over existing WebSocket connections. This enables the frontend to display workflow mode, current phase, completed phases, and other kata metadata alongside the Claude Code session it manages.

## Feature Behaviors

### B1: HTTP Kata Status Endpoint

**Core:**
- **ID:** kata-status-http
- **Trigger:** HTTP GET request to `/projects/:name/kata-status`
- **Expected:** Returns JSON with the most recent kata session's full state for the named project, or `null` if no kata state exists
- **Verify:** `curl` the endpoint and confirm it returns a valid `KataSessionState` object with fields like `currentMode`, `currentPhase`, `completedPhases`
- **Source:** `packages/cc-gateway/src/server.ts` (new route block after the git-status route)

#### UI Layer

N/A (backend only)

#### API Layer

**Endpoint:** `GET /projects/:name/kata-status`

**Auth:** Bearer token (same as all other `/projects/*` endpoints)

**Response (200, active session found):**
```json
{
  "kata_state": {
    "sessionId": "a1b2c3d4-...",
    "currentMode": "implementation",
    "currentPhase": "p2",
    "completedPhases": ["p1"],
    "workflowId": "feat-kata-status-endpoint",
    "issueNumber": 10,
    "phases": ["p1", "p2", "p3"],
    "template": "implementation",
    "modeHistory": ["planning", "implementation"],
    "modeState": {},
    "updatedAt": "2026-04-06T10:00:00.000Z",
    "editedFiles": ["packages/cc-gateway/src/server.ts"],
    "beadsCreated": []
  }
}
```

**Response (200, no kata state):**
```json
{
  "kata_state": null
}
```

**Response (404, project not found):**
```json
{
  "error": "Project \"nonexistent\" not found"
}
```

**`KataSessionState` type definition (add to `@duraclaw/shared-types`):**
```typescript
export interface KataSessionState {
  sessionId: string
  workflowId: string | null
  issueNumber: number | null
  sessionType: string | null
  currentMode: string | null
  currentPhase: string | null
  completedPhases: string[]
  template: string | null
  phases: string[]
  modeHistory: Array<{ mode: string; enteredAt: string }>
  modeState: Record<string, { status: string; enteredAt: string }>
  updatedAt: string
  beadsCreated: string[]
  editedFiles: string[]
}
```

**Add `KataStateEvent` to the `GatewayEvent` union in `packages/shared-types/src/index.ts`.**

#### Data Layer

No schema changes. Kata state is read from the filesystem at `.kata/sessions/{id}/state.json` within the resolved project directory.

---

### B2: WebSocket Kata State Push

**Core:**
- **ID:** kata-state-ws-push
- **Trigger:** A `state.json` file is modified inside `.kata/sessions/` in a project directory that has an active WebSocket connection
- **Expected:** A `kata_state` event is sent over the WebSocket containing the full updated state. State changes are debounced (100-200ms) to avoid duplicate pushes from editor write patterns.
- **Verify:** Connect a WebSocket to the gateway with `?project=<name>`, modify a kata state.json file in that project, and observe the `kata_state` message on the WebSocket

#### UI Layer

N/A (backend only)

#### API Layer

**New GatewayEvent variant:**
```typescript
export interface KataStateEvent {
  type: 'kata_state'
  session_id: string | null
  project: string
  kata_state: KataSessionState | null
}
```

The `session_id` is the cc-gateway session ID if one is active on the WebSocket, otherwise `null`. The `project` field is the project name from `ws.data.project`.

#### Data Layer

N/A -- read-only access to existing kata state files.

---

### B3: Graceful Error Handling

**Core:**
- **ID:** kata-status-error-handling
- **Trigger:** Kata status is requested (HTTP or file watcher fires) but the state is missing, empty, or corrupt
- **Expected:** Returns `null` for the `kata_state` field instead of throwing. Logs a warning to stderr for corrupt/invalid state files.
- **Verify:** Delete or corrupt a `.kata/sessions/*/state.json` file and confirm the endpoint returns `{ "kata_state": null }` without a 500 error

#### UI Layer

N/A (backend only)

#### API Layer

All error conditions map to a successful 200 response with `{ "kata_state": null }`:

| Condition | Behavior |
|-----------|----------|
| No `.kata/` directory in project | Return `null` |
| `.kata/sessions/` exists but is empty | Return `null` |
| No session directories with valid UUIDs | Return `null` |
| `state.json` missing in most recent session dir | Return `null` |
| `state.json` contains invalid JSON | Return `null`, log warning |
| `state.json` fails schema validation | Return `null`, log warning |

#### Data Layer

N/A

---

## Non-Goals

Explicitly out of scope for this feature:
- Modifying kata state from the gateway (this is strictly read-only)
- Listing historical kata sessions (only the most recent session is returned)
- Any kata CLI integration or changes to the kata package itself
- UI components to display kata state (separate feature)
- Watching for new session directories being created (only watches state.json changes in existing sessions)

## Implementation Phases

See YAML frontmatter `phases:` above.

**Phase 1 (p1): Shared types and kata integration** -- Define the `KataSessionState` type in `@duraclaw/shared-types` and add the `KataStateEvent` variant to the `GatewayEvent` union. Since kata has no `package.json`, the gateway implements its own state-reading logic inline (replicating the session lookup algorithm from `packages/kata/src/session/lookup.ts`).

**Phase 2 (p2): HTTP endpoint** -- Add the `GET /projects/:name/kata-status` route to `packages/cc-gateway/src/server.ts` following the existing pattern used by `/projects/:name/git-status`. Implement a `handleKataStatus(projectPath)` function in a new `packages/cc-gateway/src/kata.ts` module.

**Phase 3 (p3): WebSocket push via file watcher** -- When a WebSocket connects with a `?project=` parameter, set up a `fs.watch` on the project's `.kata/sessions/` directory (recursive). On `state.json` changes, read and push the state. Clean up the watcher on WebSocket close.

## Verification Strategy

### Test Infrastructure

The cc-gateway uses vitest (config at `packages/cc-gateway/vitest.config.ts`). Unit tests for the kata state reading logic can use mock filesystem fixtures. Integration tests for the HTTP endpoint require a running gateway instance or mocked Bun server.

### Build Verification

Run `pnpm typecheck` from the monorepo root. This typechecks all packages including `@duraclaw/shared-types` and `@duraclaw/cc-gateway`.

## Verification Plan

### VP1: HTTP endpoint returns kata state for a project with active kata session

Steps:
1. Ensure the gateway is running and a project (e.g., `baseplane-dev1`) has a `.kata/sessions/` directory with at least one session containing a valid `state.json`.
   ```bash
   ls /data/projects/baseplane-dev1/.kata/sessions/*/state.json
   ```
   Expected: At least one state.json file path is listed.

2. Query the kata status endpoint:
   ```bash
   curl -s -H "Authorization: Bearer $CC_GATEWAY_API_TOKEN" http://127.0.0.1:9877/projects/baseplane-dev1/kata-status | jq .
   ```
   Expected: 200 response with `{"kata_state": {...}}` where the object contains `currentMode`, `currentPhase`, `completedPhases`, and `updatedAt` fields.

### VP2: HTTP endpoint returns null for a project without kata state

Steps:
1. Identify a project that has no `.kata/` directory:
   ```bash
   ls /data/projects/baseplane-dev2/.kata/ 2>&1
   ```
   Expected: "No such file or directory" or the directory is empty.

2. Query the kata status endpoint:
   ```bash
   curl -s -H "Authorization: Bearer $CC_GATEWAY_API_TOKEN" http://127.0.0.1:9877/projects/baseplane-dev2/kata-status | jq .
   ```
   Expected: 200 response with `{"kata_state": null}`.

### VP3: HTTP endpoint returns 404 for unknown project

Steps:
1. Query a nonexistent project:
   ```bash
   curl -s -w "\n%{http_code}" -H "Authorization: Bearer $CC_GATEWAY_API_TOKEN" http://127.0.0.1:9877/projects/nonexistent/kata-status
   ```
   Expected: HTTP 404 with body `{"error":"Project \"nonexistent\" not found"}`.

### VP4: Corrupt state.json returns null gracefully

Steps:
1. Create a temporary corrupt state file:
   ```bash
   PROJ=/data/projects/baseplane-dev1
   SESSION_DIR=$(ls -td $PROJ/.kata/sessions/*/ 2>/dev/null | head -1)
   cp "$SESSION_DIR/state.json" "$SESSION_DIR/state.json.bak"
   echo "not valid json{{{" > "$SESSION_DIR/state.json"
   ```
2. Query the endpoint:
   ```bash
   curl -s -H "Authorization: Bearer $CC_GATEWAY_API_TOKEN" http://127.0.0.1:9877/projects/baseplane-dev1/kata-status | jq .
   ```
   Expected: 200 response with `{"kata_state": null}`.
3. Restore the original:
   ```bash
   mv "$SESSION_DIR/state.json.bak" "$SESSION_DIR/state.json"
   ```

### VP5: WebSocket receives kata_state event on state.json change

Steps:
1. Connect a WebSocket to the gateway:
   ```bash
   websocat -H "Authorization: Bearer $CC_GATEWAY_API_TOKEN" ws://127.0.0.1:9877/?project=baseplane-dev1 &
   WS_PID=$!
   ```
2. In another terminal, touch a state.json to trigger a change:
   ```bash
   PROJ=/data/projects/baseplane-dev1
   SESSION_DIR=$(ls -td $PROJ/.kata/sessions/*/ 2>/dev/null | head -1)
   touch "$SESSION_DIR/state.json"
   ```
3. Observe the WebSocket output within 2 seconds.
   Expected: A JSON message with `{"type":"kata_state","project":"baseplane-dev1","kata_state":{...}}`.
4. Clean up:
   ```bash
   kill $WS_PID
   ```

## Implementation Hints

### Dependencies

No new npm dependencies are needed. The gateway reads kata state files directly using `node:fs/promises` and validates with Zod (already a transitive dependency via shared-types, or inline validation).

If Zod is not available in cc-gateway, use a simple try/catch around `JSON.parse` with manual field checks instead of the full `SessionStateSchema` from the kata package.

### Key Imports

| Module | Import | Used For |
|--------|--------|----------|
| `node:fs/promises` | `readdir`, `readFile`, `stat`, `access` | Reading `.kata/sessions/` directory and `state.json` files |
| `node:fs` | `watch` (or `Bun.file` watcher) | Watching for state.json changes in p3 |
| `node:path` | `join`, `resolve` | Building paths to `.kata/sessions/*/state.json` |
| `@duraclaw/shared-types` | `KataSessionState`, `KataStateEvent` | Type-safe state shape |

### Code Patterns

**Finding the most recent kata session (simplified version of `getCurrentSessionId` in `packages/kata/src/session/lookup.ts` — `.kata/` layout only):**
```typescript
async function findLatestKataState(projectPath: string): Promise<KataSessionState | null> {
  const sessionsDir = path.join(projectPath, '.kata', 'sessions')
  try {
    await fs.access(sessionsDir)
  } catch {
    return null // No .kata/sessions/ directory
  }

  const entries = await fs.readdir(sessionsDir, { withFileTypes: true })
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

  let latest: { id: string; mtimeMs: number } | null = null
  for (const entry of entries) {
    if (!entry.isDirectory() || !UUID_RE.test(entry.name)) continue
    const stateFile = path.join(sessionsDir, entry.name, 'state.json')
    try {
      const { mtimeMs } = await fs.stat(stateFile)
      if (!latest || mtimeMs > latest.mtimeMs) {
        latest = { id: entry.name, mtimeMs }
      }
    } catch {
      continue // No state.json in this session dir
    }
  }

  if (!latest) return null

  try {
    const content = await fs.readFile(
      path.join(sessionsDir, latest.id, 'state.json'), 'utf-8'
    )
    return JSON.parse(content) as KataSessionState
  } catch (err) {
    console.warn(`[cc-gateway] Failed to read kata state for session ${latest.id}:`, err)
    return null
  }
}
```

**HTTP route pattern (matches existing `git-status` route in `packages/cc-gateway/src/server.ts`):**
```typescript
// GET /projects/:name/kata-status
const kataStatusMatch = path.match(/^\/projects\/([^/]+)\/kata-status$/)
if (req.method === 'GET' && kataStatusMatch) {
  const [, name] = kataStatusMatch
  const projectPath = await resolveProject(name)
  if (!projectPath) {
    return json(404, { error: `Project "${name}" not found` })
  }
  return handleKataStatus(projectPath)
}
```

**File watcher pattern for WebSocket push (p3):**
```typescript
// In websocket.open handler, after project is known:
const kataWatchers = new Map<ServerWebSocket<WsData>, FSWatcher>()

// Start watching when WS opens with a project
const sessionsDir = path.join(projectPath, '.kata', 'sessions')
try {
  const watcher = fs.watch(sessionsDir, { recursive: true }, (event, filename) => {
    if (filename?.endsWith('state.json')) {
      // Debounce and read state, then push
      findLatestKataState(projectPath).then((state) => {
        ws.send(JSON.stringify({
          type: 'kata_state',
          session_id: sessions.get(ws)?.sessionId ?? null,
          project: ws.data.project,
          kata_state: state,
        }))
      })
    }
  })
  kataWatchers.set(ws, watcher)
} catch {
  // No .kata/sessions/ dir — skip watching
}

// In websocket.close handler:
const watcher = kataWatchers.get(ws)
if (watcher) {
  watcher.close()
  kataWatchers.delete(ws)
}
```

### Gotchas

- The kata package (`packages/kata/`) has no `package.json` and cannot be imported as a workspace dependency. The gateway must implement its own state-reading logic, replicating the session lookup algorithm from `packages/kata/src/session/lookup.ts`.
- The UUID regex for session directory names must match the v4 pattern: `/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i` (same as `SESSION_ID_RE` constant in `packages/kata/src/session/lookup.ts`).
- `fs.watch` with `{ recursive: true }` is supported on Linux with Bun but may have platform-specific behavior. Use a debounce (100-200ms) to avoid duplicate events from editors that write files in multiple steps.
- Some projects may use the legacy `.claude/sessions/` layout instead of `.kata/sessions/`. For v1, only support the `.kata/` layout since all active projects have migrated.
- The `KataSessionState` type in shared-types should be a plain interface (not a Zod schema) to avoid adding Zod as a dependency to the shared-types package. The gateway validates with try/catch around JSON.parse.
