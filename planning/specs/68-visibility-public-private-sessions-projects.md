---
initiative: visibility
type: project
issue_type: feature
status: reviewed
priority: high
github_issue: 68
created: 2026-04-22
updated: 2026-04-22
phases:
  - id: p1
    name: "Schema + ACL foundation"
    tasks:
      - "D1 migration 0020: add visibility column to agent_sessions + projects"
      - "Add visibility to Drizzle schema + AgentSessionRow / Project types"
      - "Surface role on Hono context via authMiddleware"
      - "Refactor getOwnedSession → getAccessibleSession with visibility + admin logic"
      - "Add index idx_agent_sessions_visibility_last_activity"
    test_cases:
      - id: "p1-acl-unit"
        description: "getAccessibleSession returns session for owner, public viewer, admin; rejects private non-owner"
        type: "unit"
      - id: "p1-migration"
        description: "Migration 0020 applies cleanly, existing rows default to private"
        type: "integration"
  - id: p2
    name: "Session + project list queries + admin toggle API"
    tasks:
      - "Widen GET /api/sessions, /sessions/active, /sessions/search, /sessions/history to include public sessions"
      - "Add GET /api/sessions/shared — public sessions from other users"
      - "Widen GET /api/gateway/projects, /api/gateway/projects/all to include visibility"
      - "Add PATCH /api/projects/:name/visibility — admin-only toggle"
      - "Add PATCH /api/sessions/:id/visibility — admin-only toggle"
      - "Inherit project visibility into session at creation in createSession()"
    test_cases:
      - id: "p2-list-public"
        description: "Non-owner sees public sessions in /api/sessions; does not see private"
        type: "integration"
      - id: "p2-admin-toggle"
        description: "Admin can PATCH visibility; non-admin gets 403"
        type: "unit"
      - id: "p2-inherit"
        description: "New session inherits visibility from its project"
        type: "unit"
  - id: p3
    name: "Broadcast fanout + multi-user session WS"
    tasks:
      - "Widen broadcastSessionRow to fan out public sessions to all online users"
      - "Allow non-owner browser WS connections to SessionDO for public sessions"
      - "Allow non-owner collab WS connections to SessionCollabDOv2 for public sessions"
      - "Widen all session action endpoints (sendMessage, interrupt, rewind, resubmit, resolve-gate, fork, abort) to allow any authed user on public sessions"
      - "Add sender_id to assistant_messages (DO migration v11) and wire through message handling"
    test_cases:
      - id: "p3-fanout"
        description: "Public session broadcast reaches non-owner UserSettingsDO"
        type: "integration"
      - id: "p3-multi-ws"
        description: "Two users connect to same SessionDO, both receive delta frames"
        type: "integration"
  - id: p4
    name: "UI — session list, visibility badge, admin controls"
    tasks:
      - "Add 'All Sessions' / 'My Sessions' toggle to sidebar"
      - "Show creator attribution on shared sessions"
      - "Add visibility badge (public/private icon) to session cards"
      - "Admin visibility toggle in session detail / project settings"
      - "Show connected collaborators indicator on active sessions"
      - "Show sender attribution on user messages in shared sessions"
    test_cases:
      - id: "p4-sidebar-toggle"
        description: "Sidebar shows shared sessions when 'All Sessions' is active"
        type: "smoke"
      - id: "p4-admin-toggle-ui"
        description: "Admin sees and can use visibility toggle; non-admin does not"
        type: "smoke"
---

# Public/Private Sessions + Projects with Full-Collab Shared Sessions

> GitHub Issue: [#68](https://github.com/baseplane-ai/duraclaw/issues/68)

## Overview

Sessions are currently user-scoped: only the creator can see or drive them. This makes team coding impossible. This feature adds a `visibility` enum (`public | private`) to both projects and sessions. Public sessions are fully collaborative — any authenticated user can see the history, send messages, interrupt, rewind, and share prompt drafts. Only admins can toggle visibility. Sessions inherit their project's visibility at creation time.

## Feature Behaviors

### B1: Visibility column on agent_sessions and projects

**Core:**
- **ID:** visibility-schema
- **Trigger:** D1 migration 0020 runs on deploy
- **Expected:** Both `agent_sessions` and `projects` tables gain a `visibility TEXT NOT NULL DEFAULT 'private'` column. All existing rows backfill to `'private'`. Drizzle schema, TypeScript types, and shared-types are updated.
- **Verify:** `SELECT visibility FROM agent_sessions LIMIT 1` returns `'private'`; `SELECT visibility FROM projects LIMIT 1` returns `'private'`.
- **Source:** `apps/orchestrator/src/db/schema.ts:127` (agentSessions), `:254` (projects)

#### UI Layer
N/A — schema only.

#### API Layer
N/A — schema only. Downstream behaviors consume the column.

#### Data Layer
- Migration `0020_visibility.sql`:
  ```sql
  ALTER TABLE agent_sessions ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private';
  ALTER TABLE projects ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private';
  CREATE INDEX idx_agent_sessions_visibility_last_activity
    ON agent_sessions (visibility, last_activity);
  ```
- Drizzle schema: add `visibility: text('visibility').notNull().default('private')` to both `agentSessions` and `projects`.
- `packages/shared-types`: add `visibility: 'public' | 'private'` to `SessionSummary` and any project types.

---

### B2: Role surfaced on Hono context

**Core:**
- **ID:** role-on-context
- **Trigger:** Any authenticated API request
- **Expected:** `c.get('role')` returns `'admin' | 'user'` on every request that passes `authMiddleware`. Eliminates the need for per-endpoint D1 role lookups.
- **Verify:** Unit test: middleware sets `role` from `getRequestSession().role`.
- **Source:** `apps/orchestrator/src/api/auth-middleware.ts:26`

#### UI Layer
N/A.

#### API Layer
- `authMiddleware` calls `getRequestSession()` (which already returns `role`) and sets `c.set('role', session.role)` alongside `c.set('userId', session.userId)`.
- `ApiAppEnv` type updated: add `role: string` to the Variables type.
- Existing `/api/deploys/state` admin check (line 2468-2471) refactored to use `c.get('role')` instead of a raw D1 query.

#### Data Layer
N/A — reads existing `users.role` column.

---

### B3: Access control gate — getAccessibleSession

**Core:**
- **ID:** accessible-session-gate
- **Trigger:** Any session REST endpoint that currently calls `getOwnedSession()`
- **Expected:** Replace `getOwnedSession(env, sessionId, userId)` with `getAccessibleSession(env, sessionId, userId, role)`. Access granted if ANY of: (a) `row.userId === userId` (owner), (b) `row.visibility === 'public'` (shared), (c) `role === 'admin'`. Private sessions still return 404 for non-owner non-admin (no existence disclosure).
- **Verify:** Unit tests: owner sees private session, non-owner sees public session, admin sees all, non-owner on private gets 404.
- **Source:** `apps/orchestrator/src/api/index.ts:186-209`

#### UI Layer
N/A.

#### API Layer
```typescript
async function getAccessibleSession(
  env: Env,
  sessionId: string,
  userId: string,
  role: string,
): Promise<{ ok: true; session: AgentSessionRow; isOwner: boolean } | { ok: false; status: 404 }> {
  const row = await db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).limit(1)[0]
  if (!row) return { ok: false, status: 404 }

  const isOwner = row.userId === userId || row.userId === 'system'
  const isPublic = row.visibility === 'public'
  const isAdmin = role === 'admin'

  if (!isOwner && !isPublic && !isAdmin) {
    return { ok: false, status: 404 }
  }

  return { ok: true, session: row, isOwner }
}
```
- The `isOwner` flag is returned so callers can distinguish ownership for attribution/UI purposes (not for gating writes — public sessions allow writes from anyone).
- All ~15 session endpoints updated to call `getAccessibleSession` with `c.get('role')`.

#### Data Layer
N/A.

---

### B4: Session list queries include public sessions

**Core:**
- **ID:** list-includes-public
- **Trigger:** `GET /api/sessions`, `GET /api/sessions/active`, `GET /api/sessions/search`, `GET /api/sessions/history`
- **Expected:** Queries widen from `WHERE user_id = ?` to `WHERE (user_id = ? OR visibility = 'public')`. Results include a `isOwner` boolean per row so the UI can distinguish "my session" from "shared session". Admin sees all sessions regardless of visibility.
- **Verify:** User A creates a public session. User B calls `GET /api/sessions` and sees it. User B calls the same endpoint and does NOT see User A's private sessions.
- **Source:** `apps/orchestrator/src/api/index.ts:1483-1583`

#### UI Layer
N/A — consumed by sidebar/hooks.

#### API Layer
- All list endpoints: `WHERE user_id = ? OR visibility = 'public'` (or `WHERE 1=1` for admin).
- Response rows gain `isOwner: boolean` (computed: `row.userId === callerUserId`).
- `GET /api/sessions` default sort unchanged (`last_activity DESC`).
- Consider: `?filter=mine|shared|all` query param for client-side filtering without multiple endpoints.

#### Data Layer
- New index `idx_agent_sessions_visibility_last_activity` on `(visibility, last_activity)` ensures the public-session scan doesn't table-scan.

---

### B5: Admin-only visibility toggle

**Core:**
- **ID:** admin-visibility-toggle
- **Trigger:** Admin calls `PATCH /api/sessions/:id/visibility` or `PATCH /api/projects/:name/visibility`
- **Expected:** Updates `visibility` column. Non-admin callers get 403. Session endpoint checks ownership OR admin. Project endpoint is admin-only (projects are global). Broadcasts the updated row via synced-collection delta.
- **Verify:** Admin PATCHes a session to `public` → 200. Non-admin PATCHes → 403. `GET /api/sessions/:id` reflects the new visibility.
- **Source:** New endpoints.

#### UI Layer
See B10 (admin controls UI).

#### API Layer
```
PATCH /api/sessions/:id/visibility
Body: { "visibility": "public" | "private" }
Auth: admin only (c.get('role') === 'admin')
Response: 200 { ok: true, visibility: "public" }
Error: 403 { error: "Forbidden" } | 404

PATCH /api/projects/:name/visibility
Body: { "visibility": "public" | "private" }
Auth: admin only
Response: 200 { ok: true, visibility: "public" }
Error: 403 | 404
```
- Session toggle broadcasts via `broadcastSessionRow(env, ctx, sessionId, 'update')`.
- Project toggle broadcasts via project synced-collection delta to all online users.

#### Data Layer
- `UPDATE agent_sessions SET visibility = ?, updated_at = ? WHERE id = ?`
- `UPDATE projects SET visibility = ?, updated_at = ? WHERE name = ?`

---

### B6: Session inherits project visibility at creation

**Core:**
- **ID:** visibility-inheritance
- **Trigger:** `createSession()` is called (new session spawn)
- **Expected:** The new session row's `visibility` is set to the project's current `visibility` value. If the project has no row in D1 (e.g. discovered/unsync'd project), defaults to `'public'` (the system default for new projects). The value is snapshot — later project visibility changes do NOT retroactively update existing sessions.
- **Verify:** Set project X to `private`. Create session in X. Session.visibility = `private`. Change project X to `public`. Existing session stays `private`.
- **Source:** `apps/orchestrator/src/lib/create-session.ts`

#### UI Layer
N/A.

#### API Layer
- `createSession()` queries `SELECT visibility FROM projects WHERE name = ?` before inserting the session row.
- Passes `visibility` into the `INSERT INTO agent_sessions` statement.

#### Data Layer
N/A — uses existing columns from B1.

---

### B7: Broadcast fanout to all users with visibility

**Core:**
- **ID:** broadcast-fanout-public
- **Trigger:** Session row changes (status, progress, completion, etc.) and `broadcastSessionRow()` fires
- **Expected:** For a public session, the broadcast reaches ALL online users' `UserSettingsDO` instances (not just the owner's). For a private session, only the owner's DO (current behavior). Uses the `user_presence` table to enumerate online users.
- **Verify:** User A owns a public session. User B is connected. Session updates → User B's `sessionsCollection` receives the delta.
- **Source:** `apps/orchestrator/src/lib/broadcast-session.ts:18-31`

#### UI Layer
N/A — consumed by existing synced-collection hooks.

#### API Layer
```typescript
export async function broadcastSessionRow(env, ctx, sessionId, op) {
  const row = await db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).limit(1)[0]
  if (!row || row.userId === 'system') return

  if (row.visibility === 'public') {
    // Fan out to all online users
    const onlineUsers = await env.AUTH_DB.prepare(
      'SELECT user_id FROM user_presence'
    ).all<{ user_id: string }>()
    const targets = onlineUsers.results?.map(r => r.user_id) ?? []
    ctx.waitUntil(Promise.allSettled(
      targets.map(uid => broadcastSyncedDelta(env, uid, 'agent_sessions', [{ type: op, value: row }]))
    ))
  } else {
    // Private — owner only (current behavior)
    ctx.waitUntil(broadcastSyncedDelta(env, row.userId, 'agent_sessions', [{ type: op, value: row }]))
  }
}
```
- Uses `Promise.allSettled` so one dead DO doesn't abort the rest (same pattern as cross-user project fanout).
- Performance note: `user_presence` is small (tens of rows max in single-tenant deployment). If user count grows, consider a per-session subscription set instead of blanket fanout.

#### Data Layer
- Reads `user_presence` table (existing, maintained by `UserSettingsDO` ref-counted connect/disconnect).

---

### B8: Multi-user browser WS on SessionDO

**Core:**
- **ID:** multi-user-session-ws
- **Trigger:** Non-owner user opens a public session in the browser
- **Expected:** The browser WS upgrade to SessionDO (via `routePartykitRequest` or direct agent routing) succeeds for any authenticated user when the session is public. The DO's existing `getConnections()` iteration broadcasts delta frames to ALL connected browsers — this already works because the DO doesn't filter by user. The upgrade path just needs to stop rejecting non-owners.
- **Verify:** User A owns public session S. User B navigates to S in the UI. User B's browser connects WS. User A sends a message. User B receives the delta frame.
- **Source:** `apps/orchestrator/src/agents/session-do.ts:628-706`, `apps/orchestrator/src/server.ts`

#### UI Layer
N/A — existing message rendering works for any connected client.

#### API Layer
- SessionDO `onConnect` (or the upstream routing in `server.ts`) must validate the session is public OR the caller is the owner OR admin before accepting the WS upgrade.
- The DO already broadcasts to all connections indiscriminately — no code change needed in the broadcast path.
- Tag each WS connection with `userId` metadata so the DO can attribute actions and log who sent what.

#### Data Layer
N/A.

---

### B9: Multi-user collab WS on SessionCollabDOv2

**Core:**
- **ID:** multi-user-collab-ws
- **Trigger:** Non-owner user opens a public session's prompt draft area
- **Expected:** The collab WS handshake in `server.ts` (line 96-113) currently checks `getRequestSession()` but does NOT enforce ownership. However, it passes `x-user-id` which the DO may use. For public sessions, any authenticated user should be allowed. For private sessions, only owner + admin.
- **Verify:** User A and User B both connect to the collab DO for a public session. Y.Doc syncs between them — edits from A appear for B and vice versa.
- **Source:** `apps/orchestrator/src/server.ts:96-113`

#### UI Layer
Connected collaborators shown via Y.js awareness (username, cursor color).

#### API Layer
- Collab WS handshake: after `getRequestSession()`, look up the session's visibility. If `visibility === 'public'` OR caller is owner/admin, allow. Otherwise 403.
- The DO itself (YServer) is user-agnostic — no changes needed inside the DO.

#### Data Layer
N/A.

---

### B10: Session action endpoints allow collab

**Core:**
- **ID:** session-actions-collab
- **Trigger:** Non-owner user calls `POST /api/sessions/:id/messages`, `/abort`, `/fork`, `/answers`, etc. on a public session
- **Expected:** All session write endpoints use `getAccessibleSession()` (B3) which grants access to public sessions. The `sendMessage` / `interrupt` / `rewind` / `resubmit` / `resolve-gate` DO commands work for any connected user on a public session.
- **Verify:** User B sends a message to User A's public session via POST. The runner receives and processes it. User A sees the message in their view.
- **Source:** `apps/orchestrator/src/api/index.ts` — all session endpoints

#### UI Layer
- Input area is enabled for any user on a public session (not read-only).

#### API Layer
- No per-endpoint changes needed beyond the `getOwnedSession → getAccessibleSession` swap (B3).
- DO `sendMessage` handler doesn't check ownership — it processes any `stream-input` command from any connected WS client.

#### Data Layer
N/A.

---

### B11: Sidebar — "All Sessions" / "My Sessions" toggle

**Core:**
- **ID:** sidebar-session-filter
- **Trigger:** User clicks the filter toggle in the sidebar
- **Expected:** Two modes: "My Sessions" (current behavior, `WHERE user_id = ?`) and "All Sessions" (includes public sessions from other users). **Default is "All Sessions"** (matches shared-by-default philosophy — users see team activity immediately). The selected filter persists in `user_preferences` or localStorage.
- **Verify:** User B switches to "All Sessions" and sees User A's public session. Switches to "My Sessions" and only sees their own.

#### UI Layer
- Toggle control in sidebar header (icon or segmented button).
- Session cards show creator name/avatar when viewing "All Sessions" and the session is not owned by the viewer.
- Shared sessions have a subtle visual indicator (e.g. people icon, different card accent).

#### API Layer
- `GET /api/sessions?filter=mine|all` — server-side filtering.
- `mine`: current `WHERE user_id = ?` behavior.
- `all`: `WHERE (user_id = ? OR visibility = 'public')` (or `WHERE 1=1` for admin).

#### Data Layer
- `user_preferences.session_filter` (optional, new column or JSON key) stores the preference. Or client-only localStorage — simpler, no migration.

---

### B12: Visibility badge + admin controls in UI

**Core:**
- **ID:** visibility-ui-controls
- **Trigger:** User views session detail or project settings
- **Expected:** A lock/globe icon indicates public vs private on session cards and detail views. Admins see a toggle button to flip visibility. Non-admins see the badge but no toggle.
- **Verify:** Admin sees toggle on session detail. Clicks it. Session flips from private to public. Badge updates. Non-admin user sees the badge but no toggle.

#### UI Layer
- `VisibilityBadge` component: `<Globe />` for public, `<Lock />` for private.
- Admin-only `VisibilityToggle`: calls `PATCH /api/sessions/:id/visibility`.
- Admin menu item in session header dropdown or project settings page.
- Confirmation dialog when toggling private → public ("This session will be visible to all users").

#### API Layer
Calls B5 endpoints.

#### Data Layer
N/A.

---

### B13: Connected collaborators indicator

**Core:**
- **ID:** collab-presence-indicator
- **Trigger:** Multiple users are connected to the same public session
- **Expected:** An avatar stack or count badge shows how many users are currently viewing/connected to this session. Uses Y.js awareness (already part of the collab DO) or a lightweight presence mechanism on SessionDO.
- **Verify:** User A and B both open session S. Both see "2 connected" indicator. User B disconnects. User A sees "1 connected".

#### UI Layer
- Avatar stack component in session header showing connected users.
- Uses Y.js awareness `getStates()` for collab-connected users.
- Alternatively, SessionDO tracks connected browser WS count and pushes a presence frame.

#### API Layer
- SessionDO could expose connected user count/list via a `presence` frame type.
- Or piggyback on existing Y.js awareness protocol (already multi-user capable).

#### Data Layer
N/A.

---

### B14: Per-message sender attribution

**Core:**
- **ID:** message-sender-id
- **Trigger:** Any user sends a message to a session (via `POST /api/sessions/:id/messages` or DO `sendMessage`)
- **Expected:** Each user message row stores a `sender_id` (the userId of the person who sent it, not necessarily the session owner). The SessionDO's `assistant_messages` table gains a `sender_id TEXT` column. The D1-mirrored message data includes sender info. UI displays the sender's name/avatar on each user turn in a shared session.
- **Verify:** User A (owner) sends a message → `sender_id = A`. User B sends a message → `sender_id = B`. Both messages render with correct attribution in the UI for both users.
- **Source:** `apps/orchestrator/src/agents/session-do.ts` (message handling), `apps/orchestrator/src/agents/session-do-migrations.ts`

#### UI Layer
- User message bubbles show sender name when viewing a shared session (omit for single-user sessions where sender === owner).
- Different avatar/color per sender for visual distinction.

#### API Layer
- `sendMessage` handler extracts `userId` from the WS connection metadata (tagged in B8) or from the REST request auth context.
- Passes `sender_id` through to the DO's message storage.
- Message delta frames include `senderId` field.

#### Data Layer
- SessionDO migration v11: `ALTER TABLE assistant_messages ADD COLUMN sender_id TEXT`.
- Default `NULL` for existing messages (pre-collab, assumed to be session owner).
- `sender_id` is NOT a foreign key in DO SQLite (no D1 access from DO) — it's a raw user ID string.

---

## Non-Goals

Explicitly out of scope for this feature:
- Teams / organizations / workspace-level scoping
- RBAC beyond admin / user (no editor, viewer, etc.)
- Per-session role assignment (all public session users have equal read+write)
- Session ownership transfer (changing the creator)
- Granular permission matrix (e.g. "can interrupt but can't send messages")
- Full audit log of who did what in a shared session beyond per-message sender_id (future follow-up)

## Open Questions

- [x] Inherit model: inherit-at-creation (snapshot, B) vs. live read-through (C) → **B (snapshot)**
- [x] Collab model: read-only vs. read-write → **read-write (full collab)**
- [x] Private project: who can create sessions → **admins only**
- [x] Default sidebar filter → **"All Sessions"** (matches shared-by-default philosophy)
- [x] Bulk-update existing sessions on project visibility change → **No, leave as-is** (only new sessions inherit)
- [x] Per-message sender attribution → **Yes, add `sender_id`** (essential for multi-user collab UX)

## Implementation Phases

See YAML frontmatter `phases:` above.

- **Phase 1** (~3h): Schema + ACL foundation. Migration, Drizzle types, role on context, `getAccessibleSession()`.
- **Phase 2** (~3h): Queries + admin API. Widen list endpoints, add toggle endpoints, inherit at creation.
- **Phase 3** (~4h): Broadcast + multi-user WS. Hardest phase — fanout to all users, WS ACL for SessionDO + collab DO, action endpoints.
- **Phase 4** (~3h): UI. Sidebar toggle, badges, admin controls, presence indicator.

## Verification Strategy

### Test Infrastructure
Vitest with miniflare bindings exists at `apps/orchestrator/vitest.config.ts`. Existing test files cover auth middleware, session API, user tabs, preferences. Add visibility-specific test cases to `sessions-api.test.ts` and new `visibility.test.ts`.

### Build Verification
`pnpm build` from monorepo root. `pnpm typecheck` for type safety. D1 migration tested via `wrangler d1 migrations apply` in local mode.

## Verification Plan

### VP1: Schema migration
Steps:
1. Apply migration 0020 to local D1.
   Expected: `agent_sessions.visibility` and `projects.visibility` columns exist, default `'private'`.
2. `SELECT visibility FROM agent_sessions LIMIT 5` — all return `'private'`.
3. `SELECT visibility FROM projects LIMIT 5` — all return `'private'`.

### VP2: ACL gate — public session visible to non-owner
Steps:
1. Admin sets session S to `public` via `PATCH /api/sessions/S/visibility`.
   Expected: 200
2. User B calls `GET /api/sessions/S`.
   Expected: 200, returns session with `visibility: 'public'`, `isOwner: false`.
3. User B calls `GET /api/sessions` (list).
   Expected: Session S appears in results.

### VP3: ACL gate — private session hidden from non-owner
Steps:
1. Session S has `visibility: 'private'`, owned by User A.
2. User B calls `GET /api/sessions/S`.
   Expected: 404.
3. User B calls `GET /api/sessions`.
   Expected: Session S does NOT appear.

### VP4: Admin toggle
Steps:
1. Non-admin User B calls `PATCH /api/sessions/S/visibility` with `{"visibility":"public"}`.
   Expected: 403.
2. Admin User A calls the same endpoint.
   Expected: 200.
3. `GET /api/sessions/S` returns `visibility: 'public'`.

### VP5: Full collab — non-owner sends message on public session
Steps:
1. Admin sets session S to `public`.
2. User B opens session S in browser (WS connects).
3. User B sends a message via `POST /api/sessions/S/messages`.
   Expected: 200, message reaches the runner, assistant responds, User B sees the response.
4. User A (owner) also sees the message and response in their view.

### VP6: Visibility inheritance
Steps:
1. Admin sets project P to `public`.
2. User creates a new session in project P.
   Expected: Session.visibility = `'public'`.
3. Admin changes project P to `private`.
4. Existing session's visibility remains `'public'` (snapshot, not live).

### VP7: Broadcast fanout
Steps:
1. User A owns public session S. User B is connected (has open tab).
2. Session S receives a status update (e.g. `running` → `waiting_input`).
   Expected: User B's `sessionsCollection` receives the delta update via `UserSettingsDO` broadcast.

## Implementation Hints

### Dependencies
No new npm packages needed. All infrastructure (D1, Drizzle, UserSettingsDO, user_presence) exists.

### Key Imports
| Module | Import | Used For |
|--------|--------|----------|
| `~/db/schema` | `{ agentSessions, projects, users }` | Drizzle schema with new visibility column |
| `~/api/auth-session` | `{ getRequestSession }` | Already returns role |
| `~/lib/broadcast-session` | `{ broadcastSessionRow }` | Widened for public fanout |
| `~/lib/broadcast-synced-delta` | `{ broadcastSyncedDelta }` | Per-user delta push |

### Code Patterns

**ACL check pattern (all session endpoints):**
```typescript
const result = await getAccessibleSession(env, sessionId, userId, c.get('role'))
if (!result.ok) return c.json({ error: 'Not found' }, 404)
const { session, isOwner } = result
```

**Admin guard pattern:**
```typescript
if (c.get('role') !== 'admin') {
  return c.json({ error: 'Forbidden' }, 403)
}
```

**Public broadcast fanout:**
```typescript
const onlineUsers = await env.AUTH_DB.prepare('SELECT user_id FROM user_presence').all()
await Promise.allSettled(
  onlineUsers.results.map(u => broadcastSyncedDelta(env, u.user_id, collection, ops))
)
```

### Gotchas
- `getOwnedSession` currently returns 404 (not 403) for existence-hiding. Keep this behavior for private sessions in `getAccessibleSession`.
- SessionDO's `role=browser` WS has NO user-level ACL today — it relies on the REST layer having validated ownership before the user navigated to the session. For multi-user, the WS upgrade path in `server.ts` (agent routing) must validate visibility before forwarding to the DO.
- `broadcastSessionRow` currently targets a single `userId`'s DO. Fanning out to all `user_presence` rows is O(N) D1 reads + DO stubs — acceptable for <50 users, but add a TODO for subscription-based fanout at scale.
- The `idx_agent_sessions_user_last_activity` index covers the owner-scoped query. The new `idx_agent_sessions_visibility_last_activity` index covers the "show me public sessions" scan. Combined queries (`mine OR public`) may not use either index perfectly — monitor query plans.
- Y.js collab DO is already multi-user (YServer handles N connections). The only gate is the WS handshake auth in `server.ts`.
- `user_presence` rows are ref-counted by `UserSettingsDO` connect/disconnect. If a user has zero tabs open, they won't have a `user_presence` row → they won't receive public session broadcasts. This is correct (no point broadcasting to offline users). They'll catch up via `queryFn` refetch on reconnect.

### Reference Docs
- Spec #37 (synced collections, sessionsCollection) — established the broadcast patterns this feature extends.
- `apps/orchestrator/src/lib/broadcast-synced-delta.ts` — the fanout primitive.
- `apps/orchestrator/src/agents/user-settings-do.ts` — the per-user broadcast DO.
- Better Auth role handling — `getRequestSession()` in `apps/orchestrator/src/api/auth-session.ts`.
