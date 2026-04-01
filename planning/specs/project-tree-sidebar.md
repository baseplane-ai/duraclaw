---
initiative: project-tree-sidebar
type: project
issue_type: feature
status: approved
priority: high
github_issue: null
created: 2026-04-01
updated: 2026-04-01
phases:
  - id: p1
    name: "Rename worktree→project across all packages"
    tasks:
      - "Rename types in shared-types: WorktreeInfo→ProjectInfo, SessionSummary.worktree→project, SessionState.worktree→project, etc."
      - "Rename in cc-gateway: ExecuteCommand.worktree→project, SessionInitEvent.worktree→project, WsData.worktree→project, worktree discovery exports, HTTP routes /worktrees→/projects (including /worktrees/:name/files and /worktrees/:name/git-status)"
      - "Rename in orchestrator: API routes /api/worktrees→/api/projects, POST /api/sessions body worktree→project, WorktreeRegistry class→ProjectRegistry, DO SQLite column rename (ALTER TABLE sessions RENAME COLUMN worktree TO project), update wrangler.toml renamed_classes"
      - "Verify typecheck passes across all packages"
    test_cases:
      - id: "tc-rename-typecheck"
        description: "pnpm typecheck passes with zero errors after rename"
        type: "integration"
      - id: "tc-rename-api"
        description: "GET /api/projects returns ProjectInfo[] with 'name' field"
        type: "smoke"
  - id: p2
    name: "Add SDK summary to gateway result event"
    tasks:
      - "Add summary field to ResultEvent in shared-types"
      - "In cc-gateway sessions.ts, call getSessionInfo() after session completes and include summary in result event"
      - "Add summary field to SessionSummary and SessionState types"
      - "Add summary column to ProjectRegistry DO SQLite table (ALTER TABLE sessions ADD COLUMN summary TEXT)"
      - "Expand syncStatusToRegistry() in SessionAgent to pass summary (and other result fields) to registry, add updateSessionResult() method on ProjectRegistry"
    test_cases:
      - id: "tc-summary-result"
        description: "ResultEvent includes sdk_summary string after session completes"
        type: "integration"
      - id: "tc-summary-stored"
        description: "GET /api/sessions returns sessions with summary field populated for finished sessions (status=idle)"
        type: "smoke"
  - id: p3
    name: "Build sidebar layout and project tree component"
    tasks:
      - "Create ProjectTree component with collapsible project folders"
      - "Create SessionItem component with status icon + summary display"
      - "Create sidebar layout wrapper (collapsible, ~280px) replacing dashboard"
      - "Wire up data fetching: GET /api/projects + GET /api/sessions into tree structure"
      - "Implement collapsed completed sessions ('N completed' expander)"
    test_cases:
      - id: "tc-sidebar-renders"
        description: "Sidebar shows project folders with session counts"
        type: "smoke"
      - id: "tc-sidebar-collapse"
        description: "Sidebar can be fully collapsed/expanded via toggle button"
        type: "smoke"
      - id: "tc-tree-expand"
        description: "Project folders expand to show sessions, collapse to hide them"
        type: "smoke"
  - id: p4
    name: "Add search and polish"
    tasks:
      - "Add search input at top of sidebar"
      - "Implement client-side filtering across session summaries, project names, and status"
      - "Style idle projects as muted, ensure active sessions are visually prominent"
      - "Update session detail route to work within new layout (sidebar persists)"
      - "Handle empty states (no sessions, no search results)"
    test_cases:
      - id: "tc-search-filter"
        description: "Typing in search filters tree to matching sessions and projects"
        type: "smoke"
      - id: "tc-search-empty"
        description: "Empty search state shows helpful message"
        type: "smoke"
      - id: "tc-navigation"
        description: "Clicking a session in sidebar navigates to detail view while sidebar persists"
        type: "smoke"
---

# Project Tree Sidebar with SDK Summaries

> GitHub Issue: TBD

## Overview

Replace the flat dashboard (worktree grid + session list tabs) with a sidebar-based layout matching the standard IDE/chat-app pattern. Sessions are grouped under collapsible project folders, identified by Claude-generated summaries instead of raw UUIDs, and filterable via a search bar. The "worktree" terminology is renamed to "project" throughout to match Claude Code's naming.

## Feature Behaviors

### B1: Worktree→Project Rename

**Core:**
- **ID:** rename-worktree-to-project
- **Trigger:** Any code that references "worktree" in types, APIs, UI, or protocol
- **Expected:** All references renamed to "project" across shared-types, cc-gateway, and orchestrator
- **Verify:** `pnpm typecheck` passes; API responses use `project` field name
- **Source:** `packages/shared-types/src/index.ts`, `packages/cc-gateway/src/`, `apps/orchestrator/src/`

#### UI Layer

All UI text changes from "worktree" to "project":
- Dashboard header: "Projects" instead of "Worktrees"
- New session dialog: "Project" dropdown instead of "Worktree"
- Session header: "Project: dev1" instead of "Worktree: dev1"

#### API Layer

Orchestrator routes:

| Old Route | New Route | Method | Change |
|-----------|-----------|--------|--------|
| `/api/worktrees` | `/api/projects` | GET | Route file rename + response shape |
| `POST /api/sessions` body `{ worktree }` | `POST /api/sessions` body `{ project }` | POST | Field rename in request body |

cc-gateway HTTP routes:

| Old Route | New Route | Method | Change |
|-----------|-----------|--------|--------|
| `/worktrees` | `/projects` | GET | Endpoint rename |
| `/worktrees/:name/files` | `/projects/:name/files` | GET | Endpoint rename |
| `/worktrees/:name/git-status` | `/projects/:name/git-status` | GET | Endpoint rename |

Response shape change:
```typescript
// Before
interface WorktreeInfo { name: string; path: string; branch: string; dirty: boolean; active_session: string | null }

// After
interface ProjectInfo { name: string; path: string; branch: string; dirty: boolean; active_session: string | null }
```

#### Data Layer

Field renames in shared-types:
```typescript
// Types renamed
WorktreeInfo → ProjectInfo

// Fields renamed in existing types
ExecuteCommand.worktree → ExecuteCommand.project
ResumeCommand.worktree → ResumeCommand.project
SessionInitEvent.worktree → SessionInitEvent.project
SessionState.worktree → SessionState.project
SessionState.worktree_path → SessionState.project_path
SessionSummary.worktree → SessionSummary.project
```

cc-gateway internal renames:
- `WORKTREE_PATTERNS` env var → `PROJECT_PATTERNS` (keep `WORKTREE_PATTERNS` as fallback)
- `discoverWorktrees()` → `discoverProjects()`
- `/worktrees` HTTP endpoint → `/projects` (including `/worktrees/:name/files` and `/worktrees/:name/git-status`)
- `WsData.worktree` → `WsData.project` in `packages/cc-gateway/src/types.ts`
- WS upgrade query param `?worktree=` → `?project=` (set by orchestrator, read by `server.ts:82`)
- `resolveWorktree()` → `resolveProject()`
- Rename file `packages/cc-gateway/src/worktrees.ts` → `packages/cc-gateway/src/projects.ts`

DO storage:
- **SessionAgent DO**: Rename `worktree`/`worktree_path` fields in state object (in-memory, no migration needed).
- **WorktreeRegistry DO → ProjectRegistry DO**: Rename the class. Requires `renamed_classes` entry in wrangler.toml. The SQLite `sessions` table has a `worktree` column that needs `ALTER TABLE sessions RENAME COLUMN worktree TO project`. Run migration in the DO's `constructor` or `sql` block before first use.
- **wrangler.toml**: Update class name binding from `WorktreeRegistry` to `ProjectRegistry`, add `renamed_classes = [{from = "WorktreeRegistry", to = "ProjectRegistry"}]` under `[migrations]`.

---

### B2: SDK Session Summary in Result Event

**Core:**
- **ID:** sdk-summary-in-result
- **Trigger:** Session completes (result event emitted by cc-gateway)
- **Expected:** cc-gateway calls `getSessionInfo(sdk_session_id, { dir: projectPath })` and includes `sdk_summary` in the ResultEvent
- **Verify:** After a session completes, `GET /api/sessions` returns the session with a populated `summary` field
- **Source:** `packages/cc-gateway/src/sessions.ts` (in `executeSession()` after result event), `packages/shared-types/src/index.ts:ResultEvent`

#### UI Layer

Session summary displayed in:
- Project tree sidebar: summary text next to status icon (truncated ~50 chars)
- Session detail header: full summary text
- Fallback: if no SDK summary available, show first 80 chars of initial prompt (existing behavior)

#### API Layer

No new endpoints. Existing endpoints return summary:
- `GET /api/sessions` — `SessionSummary` now includes `summary?: string`
- `GET /api/sessions/:id` — `SessionState` now includes `summary?: string`

#### Data Layer

shared-types additions:
```typescript
// ResultEvent gains sdk_summary
interface ResultEvent {
  // ...existing fields
  sdk_summary: string | null  // from SDK's getSessionInfo().summary
}

// SessionSummary gains summary
interface SessionSummary {
  // ...existing fields
  summary?: string  // Claude-generated session description
}

// SessionState gains summary
interface SessionState {
  // ...existing fields
  summary: string | null
}
```

cc-gateway change in `sessions.ts`:
```typescript
// After session completes, before sending result event:
let sdkSummary: string | null = null
if (sdkSessionId) {
  const { getSessionInfo } = await import('@anthropic-ai/claude-agent-sdk')
  const info = await getSessionInfo(sdkSessionId, { dir: projectPath })
  sdkSummary = info?.summary ?? null
}
// Include in result event
send(ws, { type: 'result', ..., sdk_summary: sdkSummary })
```

**ProjectRegistry DO changes:**
- Add `summary TEXT` column to `sessions` table: `ALTER TABLE sessions ADD COLUMN summary TEXT`
- Add `updateSessionResult(id, { summary, duration_ms, total_cost_usd, num_turns })` method that updates the session index row with result data
- Currently `syncStatusToRegistry()` in SessionAgent only passes `(id, status)` — expand it to call `updateSessionResult()` with the full result payload including summary after a result event

---

### B3: Project Tree Sidebar

**Core:**
- **ID:** project-tree-sidebar
- **Trigger:** User navigates to the app (any route)
- **Expected:** Full-height sidebar on left with collapsible project tree, detail panel on right showing selected session or welcome state
- **Verify:** Sidebar renders with project folders, sessions grouped correctly, collapse toggle works
- **Source:** `apps/orchestrator/src/lib/components/dashboard.tsx` (replaced), `apps/orchestrator/src/routes/index.tsx`

#### UI Layer

**Layout** (replaces current dashboard):
```
┌──────────────┬──────────────────────────────┐
│ [<] Duraclaw │                              │
│ 🔍 Search... │  Session Detail / Chat View  │
│              │                              │
│ 📁 dev1 (2) │  "Added OAuth flow to..."    │
│  🟢 OAuth   │  Project: dev1 | Opus 4.6   │
│  🟡 Rate... │  Status: Running | $0.42     │
│ 📁 dev2 (1) │                              │
│  🟢 Migrate │  [Chat messages...]          │
│ ▸ dev3 (3)  │                              │
│ dev4 (idle) │                              │
│              │                              │
│ [+ New]      │  [Input bar]                 │
└──────────────┴──────────────────────────────┘
```

**Components:**

1. **`AppLayout`** — Root layout wrapper in `__root.tsx`. Sidebar (collapsible, 280px) + main content area (`<Outlet />`). Persists across route navigation because it lives in the root route. The `NewSessionDialog` is triggered by the `[+ New]` button at the bottom of the sidebar.

2. **`ProjectSidebar`** — Contains: collapse toggle, search input, project tree, new session button. When collapsed, sidebar fully hidden and main content takes full width. Toggle button remains visible.

3. **`ProjectTree`** — Renders list of `ProjectFolder` components. Fetches data from `GET /api/projects` + `GET /api/sessions` (same 5s polling as current dashboard).

4. **`ProjectFolder`** — Collapsible folder node for a project:
   - Header: project name + active session count badge
   - Expanded: active sessions as `SessionItem` components, then "N completed" expander if any
   - Idle projects (no sessions): shown with muted text, no expander
   - Default state: expanded if has active sessions, collapsed otherwise

5. **`SessionItem`** — Single session in tree:
   - Status icon: 🟢 running, 🟡 waiting_input/waiting_permission, ⬜ idle (finished successfully), 🔴 failed, ⚪ aborted
   - Text: `summary` if available, else truncated `prompt` (50 chars), else session ID prefix
   - Click: navigates to `/session/:id`
   - Visual highlight when selected (matches current route)

6. **`FinishedSessionsExpander`** — "N finished" row that expands to show idle/failed/aborted sessions for a project.

**Note on terminal status:** Successful sessions transition to `idle`, not `completed`. The `completed` value exists in the `SessionStatus` type but is not currently used. "Active" sessions are: `running`, `waiting_input`, `waiting_permission`. "Finished" sessions are: `idle` (with `duration_ms` set), `failed`, `aborted`. An `idle` session with no `duration_ms` means it was never started.

**State management:**
- Sidebar collapsed state: persisted in `localStorage`
- Project folder expanded state: persisted in `localStorage` per project name
- Selected session: derived from URL route param

#### API Layer

No new endpoints needed. Existing endpoints provide all data:
- `GET /api/projects` — project list with active session IDs
- `GET /api/sessions` — all sessions with summary field (client-side filtering replaces the `/api/sessions/active` endpoint)

#### Data Layer

N/A — uses existing data with added summary field from B2.

---

### B4: Client-Side Search

**Core:**
- **ID:** client-side-search
- **Trigger:** User types in the search input in the sidebar
- **Expected:** Tree filters to show only matching sessions and their parent projects. Empty projects hidden during search.
- **Verify:** Typing "oauth" shows only sessions whose summary/prompt contains "oauth", under their parent project
- **Source:** New component within `ProjectSidebar`

#### UI Layer

- Search input at top of sidebar, below the header
- Filters across: session summary text, session prompt text, project name, status text
- Case-insensitive substring match
- When filtering: only matching sessions shown, parent projects auto-expanded, non-matching projects hidden
- Clear button (×) to reset filter
- Empty state: "No sessions matching '{query}'" message

#### API Layer

N/A — client-side only, no server changes.

#### Data Layer

N/A — filters the already-fetched session list in React state.

---

## Non-Goals

- **Server-side search** — not needed at expected scale (dozens of sessions)
- **Drag-and-drop** reordering of projects or sessions
- **Custom project naming** — projects use the directory name as-is
- **Session rename** from UI — could use SDK's `renameSession()` later but not in this spec
- **Mobile-responsive sidebar** — desktop-first, mobile can be a follow-up
- **Real-time summary updates** during session — summary only fetched on completion

## Open Questions

- [x] Does the SDK expose session summaries? → Yes, via `getSessionInfo().summary` (verified in `sdk.d.ts` — `SDKSessionInfo` type at line ~2412)
- [x] Where to store summary? → ProjectRegistry DO SQLite `sessions` table
- [x] Full rename or UI-only? → Full rename (including DO class rename with wrangler migration)
- [ ] Verify `getSessionInfo()` works at runtime on VPS before Phase 2 implementation — SDK types are confirmed but runtime behavior should be smoke-tested

## Implementation Phases

See YAML frontmatter `phases:` above.

- **Phase 1** (~2h): Rename worktree→project everywhere. Pure refactor, no new features. Must typecheck.
- **Phase 2** (~1h): Wire SDK summary into gateway result event + store in registry. Backend only.
- **Phase 3** (~3h): Build sidebar layout + project tree. Replace dashboard. Core UI work.
- **Phase 4** (~1h): Add search, polish styling, handle empty states.

## Verification Strategy

### Test Infrastructure
No unit test framework is configured. Verification uses typecheck (`pnpm typecheck`), manual/browser testing via agent-browser, and API smoke tests via curl.

### Build Verification
`pnpm build` in the monorepo root. Note: TanStack Start generates route types at build time, so `tsc` alone is insufficient — use `pnpm typecheck` which runs the full build pipeline.

## Verification Plan

### VP1: Rename Verification
Steps:
1. `pnpm typecheck`
   Expected: Zero errors across all packages
2. `grep -r 'worktree' packages/shared-types/src/ apps/orchestrator/src/ --include='*.ts' --include='*.tsx' -l`
   Expected: No matches (all renamed to project). cc-gateway internals may still reference worktree for git operations — that's fine.
3. `curl -s https://<worker-url>/api/projects | jq '.[0] | keys'`
   Expected: Response includes "name", "path", "branch", "dirty", "active_session" — no "worktree" key

### VP2: SDK Summary Flow
Steps:
1. Create a session via POST `/api/sessions` with a simple prompt
2. Wait for session to complete
3. `curl -s https://<worker-url>/api/sessions | jq '.[] | select(.status == "idle" and .duration_ms != null) | .summary'`
   Expected: Non-null string with a Claude-generated summary like "Added OAuth flow to settings page"

### VP3: Sidebar UI
Steps:
1. Open app in browser via agent-browser
   Expected: Sidebar visible on left with project tree, collapsible
2. Click collapse toggle
   Expected: Sidebar hides, main content takes full width, toggle button remains
3. Click a project folder
   Expected: Folder expands/collapses showing sessions underneath
4. Click a session
   Expected: Navigates to session detail view, sidebar persists with session highlighted

### VP4: Search
Steps:
1. Type a known session summary substring in the search box
   Expected: Tree filters to show only matching sessions under their parent projects
2. Clear the search
   Expected: Full tree restored
3. Type a nonsense string
   Expected: "No sessions matching" message shown

## Implementation Hints

### Dependencies
No new npm packages needed. All UI built with existing Tailwind primitives.

### Key Imports
| Module | Import | Used For |
|--------|--------|----------|
| `@anthropic-ai/claude-agent-sdk` | `{ getSessionInfo }` | Fetch SDK session summary after completion |
| `@anthropic-ai/claude-agent-sdk` | `type { SDKSessionInfo }` | Type for session info response |
| `@duraclaw/shared-types` | `{ ProjectInfo, SessionSummary }` | Renamed types for projects and sessions |

### Code Patterns

**Fetching SDK summary in cc-gateway (sessions.ts):**
```typescript
// After session query completes, before sending result event
let sdkSummary: string | null = null
if (sdkSessionId) {
  try {
    const { getSessionInfo } = await import('@anthropic-ai/claude-agent-sdk')
    const info = await getSessionInfo(sdkSessionId, { dir: projectPath })
    sdkSummary = info?.summary ?? null
  } catch {
    // Non-fatal — summary is best-effort
  }
}
```

**Collapsible sidebar pattern (React):**
```tsx
const [collapsed, setCollapsed] = useState(() =>
  localStorage.getItem('sidebar-collapsed') === 'true'
)

return (
  <div className="flex h-screen">
    {!collapsed && <ProjectSidebar onCollapse={() => setCollapsed(true)} />}
    <div className="flex-1 min-w-0">
      {collapsed && <button onClick={() => setCollapsed(false)}>☰</button>}
      <Outlet />
    </div>
  </div>
)
```

**Project tree data merging:**
```typescript
// Active = currently running or awaiting input
const isActive = (s: SessionSummary) =>
  s.status === 'running' || s.status === 'waiting_input' || s.status === 'waiting_permission'

// Finished = idle with duration (ran and completed), failed, or aborted
const isFinished = (s: SessionSummary) =>
  (s.status === 'idle' && s.duration_ms != null) || s.status === 'failed' || s.status === 'aborted'

const projectTree = projects.map(project => {
  const all = sessions.filter(s => s.project === project.name)
  return {
    ...project,
    sessions: all,
    activeSessions: all.filter(isActive),
    finishedSessions: all.filter(isFinished),
  }
})
```

### Gotchas
- `getSessionInfo()` is async ESM-only — must use dynamic import in cc-gateway (already the pattern for `query()`)
- `getSessionInfo()` returns `undefined` if session file not found — handle gracefully
- The SDK summary may not exist for very short sessions that fail before generating one — fallback to prompt snippet
- ProjectRegistry DO stores the session index in SQLite — adding a `summary` column via `ALTER TABLE` works on existing DOs since SQLite supports `ADD COLUMN`. The `RENAME COLUMN` for worktree→project also works (SQLite 3.25+, which CF Durable Objects support)
- `WORKTREE_PATTERNS` env var: keep as fallback for `PROJECT_PATTERNS` to avoid breaking existing deployments
- TanStack Start route files must be named correctly for the file-based router — renaming `/api/worktrees.ts` to `/api/projects.ts` changes the route automatically

### Reference Docs
- Claude Agent SDK `getSessionInfo()` — see `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` line ~2412
- TanStack Start file-based routing — routes defined by file path under `src/routes/`
