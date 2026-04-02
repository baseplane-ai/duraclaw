---
initiative: p0-foundation
type: project
issue_type: epic
status: approved
priority: critical
github_issue: null
created: 2026-04-02
updated: 2026-04-02
child_features:
  - p0.1-bug-fixes
  - p0.1b-session-ownership
  - p0.1c-spa-migration
  - p0.1d-ci-pipeline
  - p0.1e-do-schema-versioning
  - p0.2-dependency-upgrades
  - p0.3-mobile-layout
  - p0.4-cli-parity-core
---

# P0: Foundation

## Vision

Duraclaw ships as a secure, mobile-friendly SPA with full auth enforcement, correct bug-free behavior, and a modern dependency stack. After P0, every session is user-scoped, the app works on phones, and there is a CI gate preventing regressions. This is the foundation that all later phases (chat quality, multi-session dashboard, push notifications) build on.

## Problem Statement

The current codebase has several categories of issues that block production use:

1. **Security gaps** -- no session ownership, no auth on DO endpoints, XSS possible via unsanitized markdown.
2. **Architectural debt** -- TanStack Start SSR adds complexity with no benefit (single-user app on CF Workers), causing hydration bugs and limiting deployment options.
3. **Bugs** -- hard-coded tool_call_id for pending questions, double history load race, tool approval sync race.
4. **Missing basics** -- no logout button, dashboard component not wired to `/` route, no CI pipeline, no schema versioning for DO SQLite.
5. **Mobile unusable** -- desktop-only layout, no touch targets, no safe-area handling.
6. **Stale dependencies** -- Agents SDK 0.7 (current is 0.9+), Better Auth 1.2 (current is 1.5+), Vite 7 (current is 8).

## Success Metrics

- **Auth coverage**: 100% of DO endpoints require valid userId (from 0%)
- **XSS surface**: 0 unsanitized markdown rendering paths (from 1)
- **Known bugs**: 0 open P0 bugs (from 6)
- **Mobile usability**: all touch targets >= 44px, layout works at 320px width
- **CI gate**: typecheck + lint runs on every commit
- **Schema safety**: DO SQLite has version tracking and migration runner

## Features in This Epic

| # | Feature | Priority | Status | Spec Section |
|---|---------|----------|--------|--------------|
| 0.1c | Drop TanStack Start, migrate to SPA | P0 | draft | Phase 1 |
| 0.2 | Dependency Upgrades | P0 | draft | Phase 1 |
| 0.1d | CI Pipeline | P0 | draft | Phase 2 |
| 0.1e | DO SQLite Schema Versioning | P0 | draft | Phase 2 |
| 0.1 | Bug Fixes | P0 | draft | Phase 3 |
| 0.1b | Session Ownership | P0 | draft | Phase 3 |
| 0.3 | Mobile-First Layout | P1 | draft | Phase 4 |
| 0.4 | CLI Parity -- Core | P1 | draft | Phase 5 |

## Dependencies

- **Requires:** Working CF Workers deployment, cc-gateway running on VPS
- **Enables:** Phase 1 (Chat Quality), Phase 2 (Multi-Session Dashboard), Phase 4 (Push/PWA)
- **Blocks:** All subsequent phases depend on the SPA architecture and auth model established here

## Implementation Order (dependency-driven)

```
Phase 1: 0.1c + 0.2  -- SPA migration + dep upgrades (structural foundation)
Phase 2: 0.1d + 0.1e -- CI pipeline + schema versioning (tooling)
Phase 3: 0.1 + 0.1b  -- Bug fixes + session ownership (on new foundation)
Phase 4: 0.3         -- Mobile layout + shadcn (UI foundation)
Phase 5: 0.4         -- CLI parity (builds on new UI)
```

Each phase below is self-contained and can be handed to an implementation agent independently.

---

## Phase 1: SPA Migration + Dependency Upgrades (0.1c + 0.2)

### Goal

Replace TanStack Start SSR with a plain client-side SPA using TanStack Router + Hono backend. Upgrade all major dependencies. This is the most invasive change and must happen first so all subsequent work targets the new architecture.

### 1A. Drop TanStack Start, Add Hono Backend

#### Files to Delete

- `apps/orchestrator/src/lib/auth.functions.ts` (if exists -- server function for getSession)
- `apps/orchestrator/src/lib/cf-env.ts` (global env hack for TanStack Start server handlers)

#### Files to Create

**`apps/orchestrator/src/api/index.ts`** -- Hono app with all API routes

```
Purpose: Single Hono app exported for the Worker fetch handler.
Routes:
  - GET  /api/health         -- { ok: true }
  - GET  /api/projects       -- proxy to gateway, attach sessions from registry
  - GET  /api/sessions       -- list all sessions from registry
  - GET  /api/sessions/active -- list active sessions from registry
  - POST /api/sessions       -- create new session (same logic as current routes/api/sessions/index.ts POST)
  - GET  /api/sessions/:id   -- get session state from SessionDO
  - GET  /api/sessions/:id/messages -- get messages from SessionDO
  - POST /api/sessions/:id/abort   -- abort session via SessionDO
  - ALL  /api/auth/*         -- Better Auth handler (see below)

Auth middleware: All routes except /api/health and /api/auth/* must validate
the Bearer token or session cookie. Use Better Auth's session verification.

Env access: Hono Context provides env via c.env (standard CF Workers Hono pattern).
No global env hack needed.
```

**`apps/orchestrator/src/api/auth-middleware.ts`** -- Hono middleware

```
Purpose: Extract and verify session cookie from request.
Better Auth uses HTTP-only cookies (same-origin, no Bearer tokens needed).
Middleware calls auth.api.getSession({ headers: request.headers }).
If no valid session, return 401.
Attach userId to Hono context variable for downstream routes.
```

**`apps/orchestrator/src/api/auth-routes.ts`** -- Better Auth Hono integration

```
Purpose: Mount Better Auth as a Hono route handler at /api/auth/*.
Better Auth provides toNodeHandler or can handle raw Request objects.
Use auth.handler(request) pattern.
```

#### Files to Modify

**`apps/orchestrator/src/server.ts`** -- Complete rewrite

```typescript
// New structure:
// 1. Import Hono app from ./api
// 2. Import DO classes
// 3. Worker fetch handler:
//    a. WebSocket upgrade check (same pattern as current, route to SessionDO)
//    b. /api/* routes -> Hono app
//    c. Everything else -> serve static SPA assets (env.ASSETS.fetch)
// 4. Export DO classes
```

The key change: replace `handler.fetch` (TanStack Start) with `env.ASSETS.fetch(request)` for static asset serving, and route `/api/*` to the Hono app.

**`apps/orchestrator/vite.config.ts`** -- Remove TanStack Start plugin

```
Remove: tanstackStart plugin import and usage
Keep: cloudflare, react, tailwindcss plugins
Change cloudflare plugin: remove viteEnvironment ssr config, add assets config for SPA
Add: configure build.rollupOptions if needed for SPA entry
```

Note: The Cloudflare Vite plugin with `assets: { binding: 'ASSETS' }` will automatically handle static asset serving. The Worker only needs to handle API routes and WebSocket upgrades, falling through to `env.ASSETS.fetch(request)` for everything else.

**`apps/orchestrator/wrangler.toml`** -- Add assets binding

```toml
# Add:
[assets]
binding = "ASSETS"
directory = "./dist/client"
```

**`apps/orchestrator/src/routes/__root.tsx`** -- Convert to client-only root

```
Remove: beforeLoad server auth check, getSession import, HeadContent, Scripts
Remove: createRootRoute server options
Remove: <html>, <head>, <body> document shell rendering -- this moves to index.html
Keep: AppLayout component, ProjectSidebar
Change: Use createRootRoute() with only component option
RootComponent should render only the app layout content (<Outlet/>), not the HTML document.
Auth check becomes a client-side redirect in the component body:
  - Call authClient.useSession()
  - If not authenticated and not on /login, redirect to /login
```

**`apps/orchestrator/index.html`** -- Create SPA entry point (new file)

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Duraclaw</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/entry-client.tsx"></script>
</body>
</html>
```

**`apps/orchestrator/src/entry-client.tsx`** -- Create SPA entry (new file)

```typescript
// Standard TanStack Router SPA bootstrap:
// 1. createRouter({ routeTree })
// 2. ReactDOM.createRoot(document.getElementById('root')).render(<RouterProvider router={router} />)
```

**All route files in `apps/orchestrator/src/routes/api/`** -- Delete all

These server-side route handlers are replaced by the Hono app. Delete:
- `routes/api/projects.ts`
- `routes/api/sessions/index.ts`
- `routes/api/sessions/$id.ts`
- `routes/api/sessions/$id.messages.ts`
- `routes/api/sessions/$id.abort.ts`
- `routes/api/sessions/active.ts`
- `routes/api/auth/$.ts`

**Client route files** -- Convert from TanStack Start to plain TanStack Router

- `routes/index.tsx` -- Keep as client route, no server options
- `routes/login.tsx` -- Keep as client route, remove any server functions
- `routes/session.$id.tsx` -- Keep as client route, no server options

**`apps/orchestrator/src/lib/auth-client.ts`** -- Update baseURL

```typescript
// Change: createAuthClient() needs baseURL pointing to /api/auth
// Better Auth uses HTTP-only cookies by default (same-origin). No "SPA mode" needed --
// cookies work fine since the SPA and API are on the same origin.
export const authClient = createAuthClient({
  baseURL: '/api/auth',
})
```

> **Note:** Better Auth does NOT have a separate "SPA mode." It uses HTTP-only session cookies by default. Since the SPA and Hono API are served from the same Worker (same origin), cookies work transparently. No Bearer token handling is needed. The auth middleware should verify cookies via `auth.api.getSession({ headers: request.headers })`.

**`apps/orchestrator/src/lib/types.ts`** -- Update Env interface

```typescript
// Add ASSETS binding:
export interface Env {
  // ... existing fields ...
  ASSETS: Fetcher  // Workers static assets binding
}
```

**`apps/orchestrator/package.json`** -- Update dependencies

```
Remove: @tanstack/react-start
Keep: @tanstack/react-router
Add: hono
```

### 1B. Dependency Upgrades

Upgrade the following in `apps/orchestrator/package.json`:

| Package | Current | Target |
|---------|---------|--------|
| `agents` | ^0.7.0 | ^0.9.0 (latest at implementation time) |
| `better-auth` | ^1.2.0 | ^1.5.0 (latest at implementation time) |
| `react` | ^19.1.0 | ^19.2.0 (latest at implementation time) |
| `react-dom` | ^19.1.0 | ^19.2.0 (latest at implementation time) |
| `vite` | ^7.0.0 | ^8.0.0 (latest at implementation time) |
| `@cloudflare/vite-plugin` | ^1.4.0 | latest compatible with Vite 8 |
| `vitest` | ^4.1.2 | latest compatible with Vite 8 |

> **Fallback:** If `@cloudflare/vite-plugin` does not yet support Vite 8 at implementation time, stay on Vite 7 and upgrade the CF plugin to its latest Vite 7-compatible version instead. The SPA migration does not strictly require Vite 8 — only the TanStack Start removal and Hono addition are mandatory. Revisit the Vite 8 upgrade when CF plugin support lands.

Also upgrade in `packages/cc-gateway/package.json` and root `package.json` as needed.

Keep Drizzle for now — Better Auth's native D1 adapter status is uncertain. Investigate dropping Drizzle in a follow-up after upgrading. Do not block the upgrade on this research.

### Acceptance Criteria

- [ ] `pnpm dev` starts the SPA without SSR
- [ ] `pnpm build` produces `dist/client/` (SPA assets) and `dist/worker/` (Worker)
- [ ] All `/api/*` routes return correct responses via Hono
- [ ] WebSocket connections to `/api/sessions/:id/ws` still work
- [ ] Better Auth login/signup works via `/api/auth/*`
- [ ] Client-side routing works (navigate between /, /login, /session/:id)
- [ ] No TanStack Start imports remain in codebase
- [ ] All upgraded dependencies resolve without conflicts
- [ ] `pnpm typecheck` passes

### Test Requirements

- Unit tests for each Hono API route handler
- Test auth middleware rejects unauthenticated requests
- Test auth middleware passes authenticated requests
- Integration test: create session via POST /api/sessions

---

## Phase 2: CI Pipeline + DO SQLite Schema Versioning (0.1d + 0.1e)

### Goal

Establish automated quality gates and safe schema evolution for Durable Object SQLite.

### 2A. CI Pipeline (0.1d)

#### Files to Create

**`.husky/pre-commit`** (or equivalent hook mechanism)

```bash
#!/bin/sh
pnpm turbo typecheck lint
```

If not using Husky, use `lefthook` or a simple git hook script.

#### Files to Modify

**`package.json` (root)** -- Add lint script and hook tooling

```json
{
  "scripts": {
    "lint": "biome check .",
    "typecheck": "turbo typecheck",
    "precommit": "turbo typecheck && biome check ."
  }
}
```

**`turbo.json`** -- Ensure `typecheck` and `lint` tasks are defined

```json
{
  "tasks": {
    "typecheck": { "dependsOn": ["^build"] },
    "lint": {}
  }
}
```

Note: This is local-only CI (not GitHub Actions). The pre-commit hook runs `pnpm turbo typecheck` and `biome check` before each commit.

### 2B. DO SQLite Schema Versioning (0.1e)

#### Files to Create

**`apps/orchestrator/src/lib/do-migrations.ts`** -- Migration runner

```typescript
/**
 * Schema version tracking for DO SQLite.
 *
 * Each DO that uses SQLite (SessionDO, ProjectRegistry) calls
 * runMigrations(sql, migrations) in its onStart/ensureInit.
 *
 * Schema:
 *   CREATE TABLE IF NOT EXISTS _schema_version (
 *     version INTEGER PRIMARY KEY,
 *     applied_at TEXT NOT NULL
 *   )
 *
 * Migration interface:
 *   interface Migration {
 *     version: number
 *     description: string
 *     up: (sql: SqlStorage) => void
 *   }
 *
 * Runner:
 *   1. Create _schema_version table if not exists
 *   2. SELECT MAX(version) FROM _schema_version
 *   3. Run all migrations with version > current, in order
 *   4. INSERT version record after each successful migration
 *
 * Note: sql parameter is ctx.storage.sql for DurableObject subclasses,
 * or this.sql for Agent subclasses (which provide a tagged template helper).
 */
```

**`apps/orchestrator/src/agents/session-do-migrations.ts`** -- SessionDO migrations

```typescript
import type { Migration } from '~/lib/do-migrations'

export const SESSION_DO_MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'Initial messages table',
    up: (sql) => {
      sql.exec(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL DEFAULT 'assistant',
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      )`)
    },
  },
  {
    version: 2,
    description: 'Add nullable columns for future use',
    up: (sql) => {
      // Forward-compatible nullable columns:
      // - session_id: for multi-session message sharing
      // - metadata: JSON blob for extensible message metadata
      // Note: SQLite ALTER TABLE ADD COLUMN fails if column exists.
      // Use try-catch for idempotency in case of partial migration runs.
      try { sql.exec(`ALTER TABLE messages ADD COLUMN session_id TEXT`) } catch {}
      try { sql.exec(`ALTER TABLE messages ADD COLUMN metadata TEXT`) } catch {}
    },
  },
]
```

**`apps/orchestrator/src/agents/project-registry-migrations.ts`** -- ProjectRegistry migrations

```typescript
import type { Migration } from '~/lib/do-migrations'

export const REGISTRY_MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'Initial sessions table',
    up: (sql) => {
      sql.exec(`CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        model TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        duration_ms INTEGER,
        total_cost_usd REAL,
        num_turns INTEGER,
        prompt TEXT,
        summary TEXT
      )`)
    },
  },
  {
    version: 2,
    description: 'Add userId column for session ownership',
    up: (sql) => {
      // try-catch for idempotency -- ALTER TABLE fails if column already exists
      try { sql.exec(`ALTER TABLE sessions ADD COLUMN user_id TEXT`) } catch {}
    },
  },
]
```

#### Files to Modify

**`apps/orchestrator/src/agents/session-do.ts`** -- Replace inline SQL with migration runner

```
In onStart():
  Remove: inline CREATE TABLE IF NOT EXISTS messages ...
  Replace with: runMigrations(this.ctx.storage.sql, SESSION_DO_MIGRATIONS)
  (Note: Agent subclass provides this.sql as tagged template, but migrations
   need raw exec. Use this.ctx.storage.sql.exec for migrations.)
```

**`apps/orchestrator/src/agents/project-registry.ts`** -- Replace inline SQL with migration runner

```
In ensureInit():
  Remove: all try/catch ALTER TABLE blocks and CREATE TABLE IF NOT EXISTS
  Replace with: runMigrations(this.ctx.storage.sql, REGISTRY_MIGRATIONS)
```

### Acceptance Criteria

- [ ] Pre-commit hook runs typecheck + biome lint, blocks commit on failure
- [ ] `_schema_version` table exists in both SessionDO and ProjectRegistry after first run
- [ ] Migrations run in order and are idempotent (re-running skips already-applied)
- [ ] New nullable columns exist in messages table (session_id, metadata)
- [ ] New user_id column exists in registry sessions table
- [ ] `pnpm typecheck` passes

### Test Requirements

- Unit test: migration runner applies migrations in order
- Unit test: migration runner skips already-applied migrations
- Unit test: migration runner handles empty migration list
- Unit test: migration runner creates _schema_version table on first run

---

## Phase 3: Bug Fixes + Session Ownership (0.1 + 0.1b)

### Goal

Fix all known bugs and enforce user-scoped session access. This phase runs on the new SPA architecture from Phase 1.

> **Note:** Line numbers referenced below are from the pre-Phase-1 codebase. After the SPA migration, API routes will have been deleted and `server.ts` rewritten. Re-locate code sections by searching for the described patterns rather than relying on exact line numbers.

### 3A. Bug Fixes (0.1)

#### Fix 1: Hard-coded `'pending-question'` tool_call_id

**File:** `apps/orchestrator/src/lib/components/chat-view.tsx`

**Current (line ~311):**
```typescript
agent.call('submitAnswers', [{ toolCallId: 'pending-question', answers }])
```

**Problem:** The `toolCallId` is hard-coded to `'pending-question'` instead of using the actual tool_call_id from the gateway's `ask_user` event.

**Fix:** Restructure `pending_question` from a bare array to a structured object (consistent with `pending_permission` pattern), storing the `tool_call_id` from the gateway event.

Changes needed:
1. In `packages/shared-types/src/index.ts`: Change `pending_question: unknown[] | null` to `pending_question: { tool_call_id: string; questions: unknown[] } | null` in `SessionState`. This mirrors `pending_permission` which is already an object with `tool_call_id`.
2. In `apps/orchestrator/src/agents/session-do.ts`: In the `ask_user` case of `handleGatewayEvent`, set `pending_question: { tool_call_id: event.tool_call_id, questions: event.questions }`.
3. In `apps/orchestrator/src/agents/session-do.ts`: In the `onConnect` method where pending questions are re-emitted (line ~239), use `this.state.pending_question.tool_call_id` instead of `'pending-question'`.
4. In `apps/orchestrator/src/lib/components/chat-view.tsx`: In `handleQuestionAnswer`, use `session.pending_question.tool_call_id`. Update all reads of `pending_question` to use `.questions` for the question data.
5. In `apps/orchestrator/src/agents/session-do.ts`: Clear `pending_question: null` wherever questions are resolved (already the pattern).

#### Fix 2: Double history load race

**File:** `apps/orchestrator/src/lib/components/chat-view.tsx` (lines ~282-293)

**Problem:** On mount, the component both (a) fetches history via HTTP `GET /api/sessions/:id/messages` and (b) receives a `history` chunk from the WebSocket `onConnect` in session-do.ts line 230. Both call `setMessages`, causing a race where messages may appear twice or flash.

**Fix:** Remove the HTTP fetch in the useEffect (lines 282-293). The WebSocket `onConnect` handler in SessionDO already sends the full history replay. The `WsChatTransport` receives the `history` chunk and should handle it. If the transport does not handle `history` chunks, add handling there.

Alternatively, remove the WebSocket history broadcast from `session-do.ts` `onConnect` and keep only the HTTP fetch. The simpler approach is to remove the HTTP fetch since the WS already sends history.

Delete the entire `useEffect` block at lines 282-293:
```typescript
// DELETE THIS:
useEffect(() => {
  fetch(`/api/sessions/${sessionId}/messages`)
    .then(...)
    .catch(...)
}, [sessionId, setMessages])
```

#### Fix 3: Tool approval sync race

**File:** `apps/orchestrator/src/lib/components/chat-view.tsx` (lines ~296-304)

**Problem:** `addToolApprovalResponse` (local AI SDK state update) and `agent.call('submitToolApproval', ...)` (server RPC) run in parallel. If the server processes the approval and sends back status updates before the local state updates, the UI can get out of sync.

**Fix:** Await the RPC call before updating local state. Change the handler to be async and await the RPC:

```typescript
const handleToolApproval = useCallback(
  async (toolCallId: string, approved: boolean) => {
    // Send to server first, wait for confirmation
    await agent.call('submitToolApproval', [{ toolCallId, approved }])
    // Then update local UI state
    addToolApprovalResponse({ id: toolCallId, approved })
  },
  [addToolApprovalResponse, agent],
)
```

#### Fix 4: Wire dashboard.tsx to `/` route

**File:** `apps/orchestrator/src/routes/index.tsx`

**Current:** Shows `WelcomePage` placeholder.

**Fix:** Import and render `Dashboard` component:

```typescript
import { createFileRoute } from '@tanstack/react-router'
import { Dashboard } from '~/lib/components/dashboard'

export const Route = createFileRoute('/')({
  component: Dashboard,
})
```

#### Fix 5: Add logout button to sidebar

**File:** `apps/orchestrator/src/lib/components/project-sidebar.tsx`

**Fix:** Add a sign-out button in the sidebar footer, next to the "+ New" button.

```typescript
// Import signOut from auth-client
import { signOut } from '~/lib/auth-client'

// In the sidebar footer (currently just the New button), add:
<div className="border-t border-border p-3 space-y-2">
  <Button variant="outline" className="w-full text-sm" onClick={() => setShowNewSession(true)}>
    + New
  </Button>
  <Button
    variant="ghost"
    className="w-full text-sm text-muted-foreground"
    onClick={() => signOut().then(() => window.location.href = '/login')}
  >
    Sign Out
  </Button>
</div>
```

#### Fix 6: Markdown/HTML sanitization (XSS prevention)

**File:** `apps/orchestrator/src/lib/components/message-parts/text-part.tsx`

**Problem:** `react-markdown` renders HTML from assistant messages without sanitization. While react-markdown does not render raw HTML by default (it strips it), the `rehypeRaw` plugin or custom components could introduce XSS. Add explicit sanitization as defense-in-depth.

**Fix:** Add `rehype-sanitize` plugin to the Markdown component:

1. Add `rehype-sanitize` to `apps/orchestrator/package.json` dependencies.
2. In `text-part.tsx`:
```typescript
import rehypeSanitize from 'rehype-sanitize'

// In the Markdown component:
<Markdown
  remarkPlugins={[remarkGfm]}
  rehypePlugins={[rehypeSanitize]}
  components={...}
>
```

### 3B. Session Ownership (0.1b)

#### Step 1: Add userId to SessionState

**File:** `packages/shared-types/src/index.ts`

Add `userId: string | null` to `SessionState` interface (line ~207):

```typescript
export interface SessionState {
  id: string
  userId: string | null  // NEW
  project: string
  // ... rest unchanged
}
```

Add `userId: string | null` to `SessionSummary` interface:

```typescript
export interface SessionSummary {
  id: string
  userId: string | null  // NEW
  project: string
  // ... rest unchanged
}
```

#### Step 2: Auth checks on SessionDO

**File:** `apps/orchestrator/src/agents/session-do.ts`

Changes:
1. Update `DEFAULT_STATE` to include `userId: null`.
2. In `onConnect`: Extract userId from the connection request (passed as a header or query param by the Worker fetch handler). Reject connections where `this.state.userId` is set and does not match the connecting user's userId. Close the connection with code 4001 and reason "Unauthorized".
3. In `onRequest`: For all endpoints except those that don't need auth, verify the userId from the request header matches `this.state.userId`. Return 403 if mismatch.
4. In `create` RPC: Accept `userId` parameter and store it in state.

The Worker fetch handler (`server.ts`) must extract the authenticated userId from the request (via Better Auth session verification) and pass it to the DO as a header (e.g., `X-User-Id`).

#### Step 3: Auth checks on ProjectRegistry

**File:** `apps/orchestrator/src/agents/project-registry.ts`

Changes:
1. `registerSession`: Accept and store `user_id` column.
2. `listSessions`: Add `userId` parameter, filter with `WHERE user_id = ?`.
3. `listActiveSessions`: Add `userId` parameter, filter with `WHERE user_id = ?`.
4. `listSessionsByProject`: Add `userId` parameter, filter with `WHERE user_id = ? AND project = ?`.
5. Keep `updateSessionStatus` and `updateSessionResult` without user filtering (called internally by SessionDO).

#### Step 4: Pass userId through API routes

**File:** `apps/orchestrator/src/api/index.ts` (Hono app from Phase 1)

All session-related API routes must:
1. Get `userId` from Hono context (set by auth middleware).
2. Pass `userId` to registry methods for filtering.
3. Pass `userId` to SessionDO create calls.
4. For session-specific routes (GET /api/sessions/:id, abort, messages), verify the session belongs to the user before proxying to the DO.

#### Step 5: Pass userId to WebSocket connections

**File:** `apps/orchestrator/src/server.ts`

In the WebSocket upgrade handler:
1. Verify auth (call Better Auth session verification on the upgrade request).
2. If unauthenticated, return 401 (not a WebSocket upgrade).
3. Add `X-User-Id` header to the request forwarded to the SessionDO.

#### Step 6: Block unauthenticated requests

Ensure the Hono auth middleware (from Phase 1) blocks all requests to `/api/*` except:
- `GET /api/health`
- `ALL /api/auth/*`

The WebSocket upgrade handler in `server.ts` must also check auth (Step 5 above).

### Acceptance Criteria

- [ ] Pending question answers use the actual tool_call_id from the gateway event
- [ ] No duplicate history load on session page mount
- [ ] Tool approval waits for server confirmation before updating UI
- [ ] `/` route renders the Dashboard component
- [ ] Sidebar has a working Sign Out button
- [ ] Markdown rendering includes rehype-sanitize
- [ ] SessionState and SessionSummary include userId field
- [ ] SessionDO rejects connections/requests from non-owner users
- [ ] ProjectRegistry filters sessions by userId
- [ ] Unauthenticated requests to /api/* (except health/auth) return 401
- [ ] Unauthenticated WebSocket upgrade attempts return 401
- [ ] `pnpm typecheck` passes

### Test Requirements

- Test: submitAnswers uses correct tool_call_id (not hardcoded)
- Test: SessionDO onConnect rejects mismatched userId
- Test: SessionDO onRequest returns 403 for non-owner
- Test: ProjectRegistry listSessions filters by userId
- Test: auth middleware returns 401 for missing token
- Test: auth middleware passes for valid token
- Test: /api/health accessible without auth
- Test: /api/auth/* accessible without auth

---

## Phase 4: Mobile-First Layout (0.3)

### Goal

Establish shadcn/ui as the component library and implement a responsive layout with bottom tabs on mobile, sidebar on desktop.

### 4A. shadcn/ui Theme Setup

#### Files to Create/Modify

**`apps/orchestrator/src/lib/components/ui/`** -- Replace or augment existing UI primitives

The existing `ui/` directory has hand-rolled components (Badge, Button, Card, Dialog, etc.). Replace them with proper shadcn/ui components:

1. Initialize shadcn/ui: `npx shadcn@latest init` (or manually configure)
2. Add `components.json` for shadcn configuration
3. Install required shadcn components: button, card, badge, dialog, input, textarea, select, tabs, sheet, dropdown-menu
4. Update `tailwind.config.ts` (or CSS variables) with shadcn theme tokens

**`apps/orchestrator/src/styles.css`** -- Add CSS custom properties for shadcn theme

```css
@layer base {
  :root {
    /* shadcn/ui CSS variables for light/dark theme */
    --background: ...;
    --foreground: ...;
    /* etc. */
  }
}
```

### 4B. Responsive Layout

#### Files to Modify

**`apps/orchestrator/src/routes/__root.tsx`** -- Responsive shell

```
Layout strategy:
- Desktop (>1024px): Current sidebar + main content
- Tablet (640-1024px): Collapsible sidebar (overlay), main content full width
- Mobile (<640px): No sidebar, bottom tab bar

Implementation:
- Use CSS media queries or Tailwind responsive classes
- Bottom tabs component for mobile: Sessions / Dashboard / Settings
- Sheet (slide-over drawer) for session list on mobile
- Replace h-screen with h-dvh (dynamic viewport height)
- Add safe-area-inset padding: pb-[env(safe-area-inset-bottom)]
```

**`apps/orchestrator/src/lib/components/bottom-tabs.tsx`** -- New component

```typescript
/**
 * Mobile bottom tab bar. Visible only below 640px breakpoint.
 * Three tabs: Sessions, Dashboard, Settings
 * Each tab: icon + label, 44px min height for touch targets
 * Active tab highlighted
 * Sessions tab opens a Sheet with session list
 */
```

**`apps/orchestrator/src/lib/components/mobile-session-drawer.tsx`** -- New component

```typescript
/**
 * Sheet (slide-over drawer) containing the session list.
 * Triggered from bottom tabs "Sessions" tab on mobile.
 * Contains the same project tree as ProjectSidebar but in sheet format.
 */
```

**`apps/orchestrator/src/lib/components/project-sidebar.tsx`** -- Hide on mobile

```
Add: className="hidden lg:flex" to the aside element
The sidebar is replaced by bottom tabs + drawer on mobile/tablet
```

**`apps/orchestrator/src/lib/components/chat-view.tsx`** -- Mobile adaptations

```
- Replace h-screen with h-dvh
- Ensure message bubbles have appropriate padding on mobile
- Input area: safe-area-inset-bottom padding
- Touch targets: all buttons >= 44px
```

### 4C. Breakpoint System

Define breakpoints as Tailwind config:
- `sm`: 640px (tablet starts)
- `lg`: 1024px (desktop starts)
- Default (< 640px): mobile

All interactive elements must have minimum 44x44px touch target (use `min-h-11 min-w-11` or equivalent).

Replace all `h-screen` usage with `h-dvh` across the app.

Add `safe-area-inset-*` padding where content touches screen edges:
- Bottom of chat input: `pb-[env(safe-area-inset-bottom)]`
- Bottom tabs: `pb-[env(safe-area-inset-bottom)]`
- Top header: `pt-[env(safe-area-inset-top)]` (if applicable)

### Acceptance Criteria

- [ ] shadcn/ui components replace hand-rolled UI primitives
- [ ] Desktop (>1024px): sidebar visible, no bottom tabs
- [ ] Tablet (640-1024px): sidebar hidden by default, available as overlay
- [ ] Mobile (<640px): bottom tabs visible, sidebar hidden, session list in drawer
- [ ] All touch targets >= 44px
- [ ] dvh units used instead of vh/h-screen
- [ ] safe-area-inset padding applied on relevant edges
- [ ] No layout overflow or scroll issues at 320px width
- [ ] `pnpm typecheck` passes

### Test Requirements

- Visual regression tests or manual verification at 320px, 640px, 1024px, 1440px widths
- Component tests for BottomTabs (renders correct active state)
- Component tests for MobileSessionDrawer (opens/closes)

---

## Phase 5: CLI Parity -- Core (0.4)

### Goal

Bring the web UI closer to Claude Code CLI feature parity with enhanced interaction flows and session metadata display.

### 5A. Enhanced AskUserQuestion Flow

**File:** `apps/orchestrator/src/lib/components/chat-view.tsx` (QuestionPrompt component)

Current implementation renders a basic text input per question. Enhance:

1. Support question types from the gateway: text input, multi-choice (radio/checkbox), confirmation (yes/no)
2. Render appropriate UI controls based on question type
3. Add client-side validation (required fields, format constraints if specified)
4. Style with shadcn/ui form components

```typescript
// Question shape from gateway (update shared-types if needed):
interface AskUserQuestion {
  id: string
  text: string
  type?: 'text' | 'select' | 'confirm'  // default: 'text'
  options?: string[]                      // for 'select' type
  required?: boolean                      // default: true
  default?: string                        // pre-filled value
}
```

### 5B. Permission Request Detail

**File:** `apps/orchestrator/src/lib/components/message-parts/tool-part.tsx`

When a tool requires permission approval, show rich details:
1. Tool name prominently displayed
2. For file operations: show the file path
3. For bash commands: show the command string
4. For file edits: show old_string/new_string diff preview
5. Approve/Deny buttons with 44px touch targets

The data is already available in `pending_permission.input` -- this is about rendering it well.

### 5C. Session Header Enhancements

**File:** `apps/orchestrator/src/lib/components/chat-view.tsx` (SessionHeader component)

Add the following to the session header:

1. **Model display** -- already partially implemented (line ~196), ensure it is always visible
2. **Context window usage bar** -- horizontal progress bar showing token usage
   - Data source: needs a new field in SessionState or a separate API
   - For now, show a placeholder bar based on `num_turns` as a rough proxy
   - Future: wire to actual token count from gateway events
3. **Live cost display** -- already partially implemented (line ~208), make it update in real-time during streaming
4. **Turn counter** -- show `num_turns` from session state

```typescript
// In SessionHeader, add after the model badge:
{session.num_turns != null && (
  <span className="text-xs text-muted-foreground">
    {session.num_turns} turn{session.num_turns !== 1 ? 's' : ''}
  </span>
)}

// Context usage bar (placeholder):
<div className="h-1.5 w-20 rounded-full bg-muted overflow-hidden">
  <div
    className="h-full bg-primary rounded-full transition-all"
    style={{ width: `${Math.min((session.num_turns ?? 0) * 5, 100)}%` }}
  />
</div>
```

### Acceptance Criteria

- [ ] AskUserQuestion renders appropriate controls per question type
- [ ] Multi-choice questions render as radio/checkbox groups
- [ ] Confirmation questions render as Yes/No buttons
- [ ] Permission requests show tool name, file path, command details
- [ ] Session header shows model, turns, cost, and context usage bar
- [ ] All new interactive elements have 44px minimum touch targets
- [ ] `pnpm typecheck` passes

### Test Requirements

- Component test: QuestionPrompt renders text input for text type
- Component test: QuestionPrompt renders radio buttons for select type
- Component test: QuestionPrompt renders yes/no for confirm type
- Component test: QuestionPrompt validates required fields
- Component test: SessionHeader displays turn count and cost
- Component test: ToolPart shows permission details for bash tool

---

## Non-Goals

- **GitHub Actions CI** -- local pre-commit hooks only, no cloud CI in P0
- **Multi-user support** -- auth enforces single-user ownership, not user management UI
- **Full offline support** -- no service worker or offline caching
- **Native mobile app** -- mobile-first web layout only, no Capacitor
- **Server-side rendering** -- explicitly removing SSR in favor of SPA
- **Token-level context tracking** -- context bar uses turn count proxy; real token tracking is a future enhancement
- **D1 migrations tooling** -- D1 schema managed by Better Auth; DO SQLite migrations are separate

## Open Questions

- [ ] Does Better Auth 1.5+ have a native D1 adapter that eliminates the Drizzle dependency? (deferred — keep Drizzle for now)
- [ ] Does the Cloudflare Vite plugin support Vite 8? If not, stay on Vite 7 (see fallback note in Phase 1B).
- [ ] Should the context usage bar wait for real token data from the gateway, or ship with the turn-count proxy?
- [ ] What is the exact Agents SDK 0.9 API for Agent.sql -- does it still provide a tagged template literal, or has it changed?

## Verification Plan

After all phases are complete:

1. **Auth flow**: Sign up -> sign in -> see dashboard -> create session -> sign out -> verify redirect to login
2. **Session ownership**: Create session as user A -> attempt to access via direct URL as user B (or unauthenticated) -> verify 401/403
3. **Bug regression**: Create session -> trigger AskUserQuestion -> verify correct tool_call_id sent -> verify no double history load
4. **Mobile layout**: Open in Chrome DevTools mobile simulator at 320px, 375px, 640px, 1024px, 1440px -> verify layout at each breakpoint
5. **Schema versioning**: Deploy -> check _schema_version table in DO SQLite -> redeploy -> verify no duplicate migrations
6. **CI gate**: Make a type error -> attempt commit -> verify hook blocks it -> fix error -> commit succeeds
7. **CLI parity**: Trigger permission request -> verify tool name and details shown -> approve -> verify flow completes
8. **Dependency health**: `pnpm typecheck` passes, `pnpm build` succeeds, `pnpm dev` starts cleanly

## Notes

- The SPA migration (Phase 1) is the highest-risk change. It touches the entry point, routing, auth, and build pipeline. Consider doing it in a feature branch.
- The Agents SDK (Durable Objects) provides `this.sql` as a tagged template literal for queries, but `this.ctx.storage.sql.exec()` for raw SQL execution. The migration runner needs the raw exec form.
- ProjectRegistry extends `DurableObject` (not `Agent`), so it uses `this.ctx.storage.sql.exec()` directly.
- SessionDO extends `Agent`, which provides `this.sql` (tagged template) and `this.ctx.storage.sql` (raw).
- The `x-partykit-room` header is required by the Agents SDK for fetch-based DO access.
- Better Auth uses HTTP-only session cookies by default. Since SPA and API are same-origin, cookies work transparently — no Bearer token handling needed.
