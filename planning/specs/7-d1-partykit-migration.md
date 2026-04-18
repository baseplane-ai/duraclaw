---
initiative: d1-partykit-migration
type: project
issue_type: feature
status: draft
priority: high
github_issue: 7
supersedes: [5, 6]
created: 2026-04-18
updated: 2026-04-18
phases:
  - id: p1
    name: "D1 schema + drizzle-kit adoption"
    tasks:
      - "Add drizzle.config.ts at apps/orchestrator root pointing at src/db/schema.ts with driver='d1-http', out='migrations'"
      - "Define all tables in apps/orchestrator/src/db/schema.ts using drizzle-orm/sqlite-core: users, sessions (auth), accounts, verifications, push_subscriptions, agent_sessions (new), user_tabs (new), user_preferences (new columnar shape)"
      - "Delete apps/orchestrator/src/lib/auth-schema.ts (duplicate of schema.ts; collapse into one)"
      - "Before writing schema.ts: grep ProjectRegistry callers (rg 'SESSION_REGISTRY' apps/orchestrator/src + reading project-registry-migrations.ts's 30-column DDL) to produce a definitive extend-or-drop list. Commit the audit result as a comment at the top of schema.ts so the column decision is traceable. Ship the 17-column minimum set + any extensions the audit shows are live-written and live-read."
      - "Generate migration 0006_agent_sessions.sql via drizzle-kit generate against the finalised schema.ts"
      - "Generate migration 0007_user_tabs.sql"
      - "Hand-author migration 0008_replace_user_preferences.sql as a SINGLE atomic file containing: (1) DROP TABLE IF EXISTS user_preferences (the old KV-style table from 0003); (2) CREATE TABLE user_preferences (...) with the columnar shape. Wrangler applies the file as one statement-list, so a failure on CREATE cannot leave the old table gone with no replacement — either both apply or neither does. Drizzle-kit generates the CREATE half; the DROP is prepended manually, and a one-line comment in the file explains the merge. A `drizzle-kit check` afterwards confirms the end state matches schema.ts."
      - "Add pnpm scripts: db:generate (drizzle-kit generate), db:migrate (wrangler d1 migrations apply), db:studio (drizzle-kit studio)"
      - "Update src/lib/auth.ts to import from new schema.ts path"
    test_cases:
      - id: "drizzle-schema-compiles"
        description: "pnpm typecheck passes with new schema.ts; all existing auth imports resolve"
        type: "unit"
      - id: "drizzle-generate-deterministic"
        description: "Running drizzle-kit generate twice in a row produces no new migration (idempotent)"
        type: "unit"
      - id: "migrations-apply-clean"
        description: "Dropping and re-applying all migrations (0001 through 0008) on a fresh local D1 instance produces the expected schema — agent_sessions, user_tabs, user_preferences (columnar) all present; old KV user_preferences absent"
        type: "integration"
  - id: p2
    name: "D1-backed API endpoints"
    tasks:
      - "Rewrite GET/POST/PATCH /api/sessions* routes at src/api/index.ts:528-675 to query AUTH_DB via Drizzle instead of SESSION_REGISTRY DO"
      - "Add UNIQUE partial index on agent_sessions.sdk_session_id WHERE NOT NULL — implement resume path as ON CONFLICT DO UPDATE keyed on sdk_session_id"
      - "Replace /api/user-settings/tabs proxy endpoints (src/api/index.ts:257-295) with direct D1 CRUD against user_tabs"
      - "Rewrite GET/PUT /api/preferences (src/api/index.ts:332-340) to read/write user_preferences D1 table with columnar shape"
      - "Add helper src/api/notify.ts exporting notifyInvalidation(env, userId, collection, keys?) — fire-and-forget, POSTs {type:'invalidate', collection, keys?} to UserSettings.fetch('https://do/notify'); MUST be created in p2 (before p3 rewrites the DO body) so mutation endpoints can import it. Against the old Agents SDK UserSettingsDO, /notify returns 404; the fire-and-forget try/catch swallows this as expected. In p3 the handler is added and the same helper starts producing real fanouts with zero caller changes."
      - "Every mutation endpoint (/api/sessions*, /api/user-settings/tabs*, /api/preferences) fires notifyInvalidation() exactly once after D1 commit"
      - "Add scheduled cron trigger (wrangler.toml [triggers] crons = ['*/5 * * * *']) that runs discovery sync: fetch gateway /sessions, UPSERT into agent_sessions"
      - "Add src/api/scheduled.ts handler: exports scheduled(event, env, ctx) that calls discovery sync and logs watermark"
    test_cases:
      - id: "sessions-endpoint-d1"
        description: "GET /api/sessions returns rows from D1 agent_sessions table (not SESSION_REGISTRY)"
        type: "integration"
      - id: "sdk-id-upsert"
        description: "POST /api/sessions/sync with duplicate sdk_session_id produces single row (UPSERT); two different sdk_session_id produces two rows"
        type: "integration"
      - id: "invalidation-fires"
        description: "Every mutation endpoint that returns 200 calls notifyInvalidation() exactly once with the correct collection name. Verified via unit test that spies on the helper (not by observing the DO POST — the /notify handler lives in p3). Because notifyInvalidation is fire-and-forget (catches all errors), the p2 endpoints remain green even though the DO is still the old Agents SDK class that returns 404 for /notify."
        type: "unit"
      - id: "cron-discovery"
        description: "Manually triggering scheduled cron produces same effects as previous alarm(): gateway fetch + UPSERT"
        type: "integration"
  - id: p3
    name: "UserSettingsDO → PartyKit fanout"
    tasks:
      - "Add partykit and partyserver dependencies to apps/orchestrator/package.json"
      - "Rewrite src/agents/user-settings-do.ts: replace class UserSettingsDO extends Agent<Env,State> with class UserSettingsDO extends Server — export the class as the Party"
      - "Delete src/agents/user-settings-do-migrations.ts (DO no longer has its own SQLite)"
      - "Implement onConnect(conn): authenticate via Better Auth cookie in the upgrade request; add to this.sockets; no state snapshot"
      - "Implement onRequest(req): handle POST /notify by broadcasting req.text() (the serialized invalidation message) to all sockets"
      - "Implement onClose(conn): remove from this.sockets"
      - "Wire WS routing in src/server.ts: before the TanStack Start handler, intercept any request whose URL matches /parties/user-settings/:userId — use partyserver's routePartykitRequest(request, env) helper if present, or hand-roll the two-line match + env.UserSettings.get(env.UserSettings.idFromName(userId)).fetch(request). Required so usePartySocket reaches the DO; without this, WS upgrades 404 and the invalidation channel is dead."
      - "Verify wrangler.toml: UserSettings binding's class_name remains literally 'UserSettingsDO' (no rename — the new implementation just re-exports the same class name on top of partyserver.Server). Only the import and extends clause inside user-settings-do.ts change."
      - "Add wrangler migration bump for UserSettingsDO with delete_sqlite: true on the existing class tag (stateless going forward) — this is a SOURCE edit in p3; it ships to production only when p6 deploys the cutover. Do not treat p6's B-INFRA-5 verification as a second migration step."
    test_cases:
      - id: "party-fanout-broadcasts"
        description: "POST /notify with {type:'invalidate',collection:'user_tabs'} broadcasts the exact payload to every open socket on that user's Party"
        type: "integration"
      - id: "party-auth"
        description: "WS upgrade without valid Better Auth cookie is rejected with 401; with valid cookie connects successfully"
        type: "integration"
      - id: "party-no-storage"
        description: "UserSettingsDO class has no this.storage.put/get/list calls in the final source"
        type: "unit"
  - id: p4
    name: "Client collections + OPFS race fix"
    tasks:
      - "Change src/entry-client.tsx L7 from `dbReady.then(() => evictOldMessages())` non-blocking to `await dbReady` inside an async wrapper before ReactDOM render"
      - "Rewrite src/db/db-instance.ts: remove the `let persistence` export; export only `dbReady` as the promise-resolved value; every collection file awaits it at module init"
      - "Rename src/db/sessions-collection.ts → src/db/agent-sessions-collection.ts; update collection id to 'agent_sessions'; bump schemaVersion to 2 (OPFS table migration)"
      - "Rewrite src/db/tabs-collection.ts: point queryFn at GET /api/user-settings/tabs (now D1-backed); update TabItem shape to drop `project`, `title`, `draft` fields (just {id, sessionId, order, created_at})"
      - "Delete seedFromCache, persistSessionsToCache, lookupSessionInCache from src/db/agent-sessions-collection.ts — OPFS handles first-render cache; localStorage paths retired"
      - "Add src/db/user-preferences-collection.ts (new, queryCollectionOptions-based, OPFS-persisted)"
      - "Add src/hooks/use-invalidation-channel.ts: usePartySocket connects to UserSettingsDO per-user party; onMessage parses {type,collection,keys}; calls collectionsByName[collection].utils.refetch() (keys field stored for future refetchKeys support, unused today)"
      - "Wire use-invalidation-channel into the root route (src/routes/__root.tsx) so every authenticated page has the subscription"
      - "Delete src/stores/tabs.ts (dead code)"
    test_cases:
      - id: "opfs-race-fixed"
        description: "After the change, every *-collection.ts file observes `persistence !== null` at createCollection time (verified by temporary console.log, removed after)"
        type: "unit"
      - id: "invalidation-refetch"
        description: "Receiving {type:'invalidate',collection:'user_tabs'} on the party triggers userTabsCollection.utils.refetch() exactly once"
        type: "unit"
      - id: "party-reconnects"
        description: "Dropping the party WS (simulate network blip) reconnects automatically within 5s and continues delivering invalidations"
        type: "integration"
      - id: "entry-client-awaits"
        description: "React does not mount before dbReady resolves (add a timing assertion in a test build)"
        type: "unit"
  - id: p5
    name: "UI refactor — tab-bar join, delete effects"
    tasks:
      - "Rewrite src/components/tab-bar.tsx:176-200 to use useLiveQuery(q => q.from({tab: userTabsCollection}).leftJoin({session: agentSessionsCollection}, ({tab, session}) => eq(tab.sessionId, session.id)).orderBy(({tab}) => tab.order))"
      - "Display tab.sessionId-derived label from joined session.project / session.title; no placeholder fallback to 'unknown' needed (left join returns undefined session → render skeleton)"
      - "Delete placeholder tab-creation paths at AgentOrchPage.tsx:50-53, 124-127, 206-209, 223-226 (4 paths)"
      - "Delete URL-sync effect chain at AgentOrchPage.tsx:84-92, 97-102, 105-147"
      - "Delete backfill effect at AgentOrchPage.tsx:388-413"
      - "Replace with: module-level URL hint consumption (consume ?session= once, call userTabsCollection.insert({id, sessionId}) via createTransaction if not already open)"
      - "Update keyboard shortcuts AgentOrchPage.tsx:270-311: Cmd+T reads selectedSessionId then userTabsCollection.insert; Cmd+W reads userTabsCollection.get(activeId) then .delete; Cmd+1-9 reads userTabsCollection.toArray()[idx]"
      - "Delete src/hooks/use-user-settings.tsx — replaced by direct collection access + useLiveQuery"
      - "Update every caller of useUserSettings() to use the relevant collection directly or the new join query"
    test_cases:
      - id: "tab-bar-no-placeholder"
        description: "Opening a tab for a session that hasn't loaded yet renders skeleton (no 'unknown'/'Session ab12cd34' text); snapshot test against rendered HTML"
        type: "unit"
      - id: "agent-orch-no-effects"
        description: "AgentOrchContent contains zero useEffect calls for URL/tab/session sync. Grep `useEffect` in the file yields only the projects fetch + keyboard listener."
        type: "unit"
      - id: "push-tap-cold-load"
        description: "chrome-devtools-axi opens /?session=X on a cold cache; tab bar renders project badge directly from join (or skeleton while agent_sessions loads); no flash of 'unknown'"
        type: "smoke"
      - id: "keyboard-shortcuts"
        description: "Cmd+T/W/1-9 work without useUserSettings (smoke test each binding end to end)"
        type: "smoke"
  - id: p6
    name: "Cutover: export, deploy, delete ProjectRegistry"
    tasks:
      - "Write scripts/export-do-state.ts: reads SESSION_REGISTRY.sessions + iterates all users (from D1 users table) calling UserSettingsDO.fetch('/tabs') and the drafts endpoint; outputs one export.sql file with INSERT statements for agent_sessions, user_tabs, user_preferences"
      - "Script is idempotent: every INSERT uses ON CONFLICT DO UPDATE keyed on primary key"
      - "Write scripts/cutover.sh runbook: 1) set MAINTENANCE_MODE='1' via wrangler secret put + redeploy, 2) pnpm tsx scripts/export-do-state.ts > export.sql, 3) wrangler d1 migrations apply --remote, 4) wrangler d1 execute --remote --file=export.sql, 5) wrangler deploy (new worker, still in maintenance), 6) set MAINTENANCE_MODE='0' via wrangler secret put + redeploy"
      - "Add src/routes/maintenance.tsx rendering a minimal 'Migration in progress — back in 15 minutes' page; wire to a short-circuit middleware in src/server.ts keyed on env.MAINTENANCE_MODE === '1' (bypass /login and /health). This is the single source of truth for maintenance state — no separate wrangler environment."
      - "Delete src/agents/project-registry.ts and src/agents/project-registry-migrations.ts in the cutover deploy"
      - "Remove SESSION_REGISTRY binding from wrangler.toml (L24-26)"
      - "Add wrangler migration step removing the ProjectRegistry class (deleted_classes in the migrations block)"
      - "Delete any leftover references to SESSION_REGISTRY in src/api/index.ts, src/server.ts, any helper files"
    test_cases:
      - id: "export-roundtrip"
        description: "On a staging DO copy: run export, apply to clean D1, read-back rows; row counts match between source DO and target D1 within ±0 (no skipped rows)"
        type: "integration"
      - id: "export-idempotent"
        description: "Running export twice and applying both SQL files produces same row count as applying once (ON CONFLICT works)"
        type: "integration"
      - id: "maintenance-middleware"
        description: "With MAINTENANCE_MODE=1, every non-/login route returns the maintenance page 503 body; with MAINTENANCE_MODE=0, routes work normally"
        type: "integration"
      - id: "registry-deleted"
        description: "Post-cutover, grep 'SESSION_REGISTRY' across src/ returns zero matches; `pnpm typecheck` passes"
        type: "unit"
      - id: "end-to-end-smoke"
        description: "chrome-devtools-axi: log in, verify sidebar shows historical sessions (from migrated D1), open a tab, rename, refresh, verify persistence"
        type: "smoke"
---

# Spec: D1 + PartyKit migration — unified metadata storage with event-bus invalidation

## Overview

Move session-index, tab, and preference metadata out of two Durable Objects (`ProjectRegistry`, `UserSettingsDO`) into Cloudflare D1 tables owned via `drizzle-kit`. Repurpose `UserSettingsDO` as a PartyKit-based per-user WebSocket fanout whose sole job is to broadcast cache-invalidation messages after D1 writes. Rewrite the client tab-bar around a TanStack DB join query (`user_tabs ⋈ agent_sessions`) so tabs no longer embed session metadata. Fix the OPFS-persistence race that silently disables persisted caches for all three existing collections. Close issues #5, #6, #7 together.

Three prior research rounds arrived at this architecture (`planning/research/2026-04-17-issue-7-tanstack-db-loading-gate.md`, `planning/research/2026-04-18-issue-7-planning-inventory.md`, `planning/research/2026-04-18-issue-7-interview-summary.md`). The interview locked a **big-bang cutover** with an export script preserving user continuity.

## Feature Behaviors

### B-DATA-1: `agent_sessions` D1 table

**Core:**
- **ID:** `agent-sessions-table`
- **Trigger:** D1 migration applied at cutover.
- **Expected:** Table `agent_sessions` exists with the column set defined by the p1 "grep ProjectRegistry callers" audit — a superset of the 17-column minimum in the Drizzle schema below, extended with any of the 13 ProjectRegistry fields that the audit finds are **both** written by some DO path and read by some client path. Fields that are dead (written but never read, or present in the DDL but never populated) are dropped. The audit is committed as a comment block at the top of `schema.ts` so reviewers can verify. PRIMARY KEY `id TEXT`; partial UNIQUE index `idx_agent_sessions_sdk_id ON agent_sessions(sdk_session_id) WHERE sdk_session_id IS NOT NULL`; INDEX on `(user_id, last_activity)` for the sidebar list query; INDEX on `(user_id, project)` for project views.
- **Verify:** `wrangler d1 execute duraclaw-auth --remote --command="SELECT sql FROM sqlite_master WHERE name='agent_sessions'"` returns the expected DDL.
**Source:** new table; replaces `apps/orchestrator/src/agents/project-registry-migrations.ts`'s `sessions` table.

#### Data Layer
Drizzle schema in `src/db/schema.ts`:
```ts
export const agentSessions = sqliteTable('agent_sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  project: text('project').notNull(),
  status: text('status').notNull().default('running'),
  model: text('model'),
  sdkSessionId: text('sdk_session_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  lastActivity: text('last_activity'),
  numTurns: integer('num_turns'),
  prompt: text('prompt'),
  summary: text('summary'),
  title: text('title'),
  tag: text('tag'),
  origin: text('origin').default('duraclaw'),
  agent: text('agent').default('claude'),
  archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
}, (t) => ({
  sdkIdUnique: uniqueIndex('idx_agent_sessions_sdk_id').on(t.sdkSessionId).where(sql`${t.sdkSessionId} IS NOT NULL`),
  userLastActivity: index('idx_agent_sessions_user_last_activity').on(t.userId, t.lastActivity),
  userProject: index('idx_agent_sessions_user_project').on(t.userId, t.project),
}))
```

**Note on column count:** The schema above defines the 17-column minimum set. It is authoritative over any prose "24 columns" reference. Implementers extend the schema only if they find a populated ProjectRegistry field that is actually read somewhere; everything else is dropped.

### B-DATA-2: `user_tabs` D1 table

**Core:**
- **ID:** `user-tabs-table`
- **Trigger:** D1 migration applied at cutover.
- **Expected:** Table with 5 columns `(id TEXT PK, user_id TEXT FK users ON DELETE CASCADE, session_id TEXT, position INTEGER, created_at TEXT)`. No `project`, no `title`, no `draft` — metadata moved to the join. INDEX on `(user_id, position)` for tab-bar ordering.
- **Verify:** `wrangler d1 execute --command="PRAGMA table_info(user_tabs)"` returns exactly those columns.

#### Data Layer
```ts
export const userTabs = sqliteTable('user_tabs', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  // Intentionally NO foreign key to agent_sessions.id — tabs may reference a
  // session that hasn't been synced from the gateway yet (e.g., deep-link
  // pointed at an active-but-undiscovered session). The tab-bar join handles
  // this with a leftJoin that renders a skeleton when the session row is
  // absent. Adding the FK here would reject valid inserts.
  sessionId: text('session_id'),
  position: integer('position').notNull(),
  createdAt: text('created_at').notNull(),
}, (t) => ({
  userPosition: index('idx_user_tabs_user_position').on(t.userId, t.position),
}))
```

### B-DATA-3: `user_preferences` D1 table (columnar)

**Core:**
- **ID:** `user-preferences-table`
- **Trigger:** D1 migration applied at cutover.
- **Expected:** Columnar table `(user_id TEXT PK, permission_mode TEXT, model TEXT, max_budget REAL, thinking_mode TEXT, effort TEXT, updated_at TEXT)`. The old KV-style table from `migrations/0003_user_preferences.sql` is dropped in the same migration bundle.
- **Verify:** `wrangler d1 execute --command="PRAGMA table_info(user_preferences)"` returns 7 columns; `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='user_preferences'` returns 1 (not 2 — old KV dropped).

#### Data Layer
```ts
export const userPreferences = sqliteTable('user_preferences', {
  userId: text('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  permissionMode: text('permission_mode').default('default'),
  model: text('model').default('claude-opus-4-6'),
  maxBudget: real('max_budget'),
  thinkingMode: text('thinking_mode').default('adaptive'),
  effort: text('effort').default('high'),
  updatedAt: text('updated_at').notNull(),
})
```

### B-DATA-4: `drizzle-kit` migration pipeline

**Core:**
- **ID:** `drizzle-kit-pipeline`
- **Trigger:** Developer runs `pnpm db:generate` after changing `src/db/schema.ts`.
- **Expected:** `drizzle-kit generate` produces a new file under `apps/orchestrator/migrations/` with a deterministic name. `pnpm db:migrate` applies it via `wrangler d1 migrations apply duraclaw-auth`. Generating twice back-to-back produces no new file (idempotent).
- **Verify:** Run `pnpm db:generate` twice, confirm `git status` shows only one new file; run `pnpm db:migrate --local` on a fresh DB, confirm `drizzle-kit check` reports clean state.
**Source:** new files `apps/orchestrator/drizzle.config.ts`; pnpm scripts in `apps/orchestrator/package.json`.

**Authoritative migration list (post-spec):** `apps/orchestrator/migrations/` contains exactly 8 files after p1 completes:
- `0001_auth_tables.sql` (pre-existing, Better Auth users/sessions/accounts/verifications)
- `0002_push_subscriptions.sql` (pre-existing)
- `0003_user_preferences.sql` (pre-existing, KV-shape — DROPPED by 0008)
- `0004_*.sql`, `0005_*.sql` (pre-existing; whatever current shape is on main)
- `0006_agent_sessions.sql` (new, this spec)
- `0007_user_tabs.sql` (new, this spec)
- `0008_replace_user_preferences.sql` (new, this spec — single atomic file containing DROP old KV table + CREATE columnar replacement)

There is no `0009`. Any reference to `0009` in earlier drafts of this spec is obsolete.

### B-DATA-5: Export script (one-shot, idempotent)

**Core:**
- **ID:** `export-do-state`
- **Trigger:** Operator runs `pnpm tsx scripts/export-do-state.ts > export.sql` during cutover (step 2 of the runbook).
- **Expected:** Script connects to production via wrangler (uses `wrangler d1 execute ... --remote` through a thin Worker endpoint or direct DO stub calls); reads SESSION_REGISTRY's `sessions` table and every `UserSettingsDO` instance's `tabs` / `drafts` / preferences; emits SQL `INSERT … ON CONFLICT(user_id) DO UPDATE` statements. Running the script twice and applying both outputs to an empty D1 produces the same result as applying once.
- **Verify:** On staging: run `wrangler d1 create duraclaw-test`, apply migrations 0001–0008 to it, run the script with `--target-db duraclaw-test`, apply output, compare row counts with source DOs. Row count delta must be 0.
**Source:** new file `apps/orchestrator/scripts/export-do-state.ts`.

### B-DATA-6: Cutover runbook

**Core:**
- **ID:** `cutover-runbook`
- **Trigger:** Operator executes `scripts/cutover.sh` during a pre-announced maintenance window.
- **Expected:** Runbook script performs: (1) set the `MAINTENANCE_MODE` wrangler secret to `'1'` via `wrangler secret put MAINTENANCE_MODE` and redeploy the current worker — the maintenance middleware short-circuits every non-`/login`, non-`/health` route to the maintenance page; (2) run export; (3) apply migrations to production D1; (4) apply export.sql to D1; (5) deploy the new worker (with `MAINTENANCE_MODE` still `'1'`); (6) set `MAINTENANCE_MODE` to `'0'` via `wrangler secret put` and redeploy. The single mechanism throughout is the `MAINTENANCE_MODE` env var — no separate `--env maintenance` wrangler environment is used. Total window: ≤15 minutes for a mid-hundreds-of-users scale.
- **Verify:** Dry-run on staging: the full script succeeds end-to-end with no manual intervention; all verification tests in §Verification Plan pass after step (6).

**Rollback plan — forward-only, with escape hatches:**

The migration is forward-only; there is no automated rollback. The old DOs (`ProjectRegistry`, the Agents-SDK-backed `UserSettingsDO`) are only physically deleted in step 5's deploy. The D1 tables created in step 3 remain even on rollback, sitting unused until a future re-attempt. Specific recovery procedures:

- **Step 1/2/3 failure (maintenance on, export running, migrations applying):** Abort. Set `MAINTENANCE_MODE='0'`, redeploy the pre-feature-branch commit (`git checkout origin/main && wrangler deploy`). Old DOs are still live and unaffected; users see a short maintenance blip. D1 tables may be partially populated — no harm, future re-attempt will UPSERT over them thanks to B-DATA-5 idempotency.
- **Step 4 failure (export.sql mid-apply):** Same as above. D1 row counts may be inconsistent but the old DOs are still authoritative, so a rollback is lossless.
- **Step 5 failure (new worker fails to start):** The deploy itself errors. Cloudflare keeps the previous worker live. Set `MAINTENANCE_MODE='0'` against the old worker and investigate. Old DOs still intact — no data loss.
- **Step 6 or post-cutover verification failure (new worker runs but data is wrong):** This is the worst case. Decision tree: (a) if the issue is a bug in new code, `git checkout` the pre-feature-branch commit and redeploy — the old DOs' state was frozen at maintenance-on and should still be current enough for continuity (users lose any writes that hit the new D1 during the brief window between step 5 and rollback); (b) if the issue is data corruption in D1, re-run the export script against the still-live old DOs and re-apply (the B-DATA-5 `ON CONFLICT DO UPDATE` makes this safe).

The rollback window shrinks sharply after step 6 completes because `deleted_classes: ['ProjectRegistry']` applied in the deploy hard-deletes the old DO namespace. **Do not flip `MAINTENANCE_MODE='0'` until a smoke test of verification plan items 1–3 has passed in production.** If any of those fail, roll back before unblocking user traffic.

**Source:** new files `apps/orchestrator/scripts/cutover.sh`, `apps/orchestrator/src/routes/maintenance.tsx`.

### B-API-1: Rewrite `/api/sessions*` to D1

**Core:**
- **ID:** `sessions-endpoints-d1`
- **Trigger:** Client calls any `/api/sessions` route.
- **Expected:** Every endpoint in the group queries D1's `agent_sessions` via Drizzle (no `c.env.SESSION_REGISTRY` calls remain). Response shape preserved exactly so the existing `agentSessionsCollection` parser continues to work.
- **Verify:** Grep `SESSION_REGISTRY` under `src/api/` returns zero matches; vitest integration test for `GET /api/sessions` returns rows inserted directly into D1; response JSON snapshot equals the pre-migration snapshot captured from the DO-backed implementation.
**Source:** `apps/orchestrator/src/api/index.ts:528-675` rewrite.

#### API Layer — Response shapes

Response keys are **camelCase** (Drizzle's default when it maps `user_id` → `userId`). The SQL column names in the schema are snake_case; the JSON response uses the TypeScript property names. Explicit response type:

```ts
type AgentSessionRow = {
  id: string
  userId: string
  project: string
  status: 'running' | 'waiting_input' | 'waiting_permission' | 'idle' | 'crashed' | 'archived'
  model: string | null
  sdkSessionId: string | null
  createdAt: string           // ISO-8601
  updatedAt: string           // ISO-8601
  lastActivity: string | null // ISO-8601
  numTurns: number | null
  prompt: string | null
  summary: string | null
  title: string | null
  tag: string | null
  origin: string | null
  agent: string | null
  archived: boolean
}
```

All list endpoints return `{sessions: AgentSessionRow[]}`, single-item endpoints return `{session: AgentSessionRow}`. Implementer MUST snapshot the current DO-backed `GET /api/sessions` response before starting and diff against the D1-backed response at the end of p2 — any key-casing, date format, or null-vs-missing difference is a bug.

- `GET /api/sessions` → `200 {sessions: AgentSessionRow[]}` ordered by `last_activity DESC`
- `GET /api/sessions/active` → `200 {sessions: AgentSessionRow[]}` where `status in ('running','waiting_input','waiting_permission')`
- `POST /api/sessions` → `200 {session: AgentSessionRow}` — `onConflictDoUpdate({target: agentSessions.sdkSessionId, set: ...})` for the resume path; `400` on missing required fields
- `PATCH /api/sessions/:id` → `200 {session: AgentSessionRow}`; `400` on unknown keys in body, `404` on missing row (enforced via `.where(and(eq(id), eq(userId)))` returning 0 rows), `403` implicit (a row owned by another user returns 404, never 403, to avoid existence disclosure); emits invalidation
- `GET /api/sessions/history` → `200 {sessions: AgentSessionRow[], nextOffset: number|null}` paginated with `.limit().offset()`
- `GET /api/sessions/search?q=…` → `200 {sessions: AgentSessionRow[]}` with `LIKE`-based matching across `(prompt, project, id, title, summary, agent, sdk_session_id)`

### B-API-2: `/api/user-settings/tabs*` on D1

**Core:**
- **ID:** `tabs-endpoints-d1`
- **Trigger:** Client calls any tab endpoint.
- **Expected:** Endpoints query D1 `user_tabs` directly (not DO proxy). Response shape: `{id, sessionId, position, created_at}` — no `project`/`title`/`draft` fields.
- **Verify:** Integration test: POST a tab, fetch it, assert response contains only the 4 new fields.
**Source:** `apps/orchestrator/src/api/index.ts:257-295` rewrite.

#### API Layer
- `GET /api/user-settings/tabs` → `200 {tabs: UserTabRow[]}` ordered by `position ASC`
- `POST /api/user-settings/tabs` → `201 {tab: UserTabRow}` — auto-assigned position (`MAX(position)+1`); `400` on malformed body; emits invalidation
- `PATCH /api/user-settings/tabs/:id` → `200 {tab: UserTabRow}`; `404` if the row does not exist for the caller's `userId` (combined not-found / cross-user to avoid existence disclosure); `400` on unknown keys; emits invalidation
- `DELETE /api/user-settings/tabs/:id` → `204 No Content`; `404` if not owned by caller; emits invalidation
- `POST /api/user-settings/tabs/reorder` (body `{orderedIds: string[]}`) → Drizzle transaction rewriting `position` for every row whose id is in the array, filtered by `userId`; returns `200 {ok: true}`. `400` if the body is malformed, any id is not a string, the array contains duplicates, or any id is not owned by the caller (enforced via `COUNT(*) WHERE id IN (...) AND user_id = ?` equaling `orderedIds.length` inside the transaction); emits invalidation.

### B-API-3: `/api/preferences` on D1 (columnar)

**Core:**
- **ID:** `preferences-endpoint-d1`
- **Trigger:** Client GET/PUT to `/api/preferences`.
- **Expected:**
  - **GET** — `SELECT * FROM user_preferences WHERE user_id = ?`. If a row exists, return it as-is (`200`). If no row exists, synthesize and return a default envelope **without** inserting anything: `{userId, permissionMode:'default', model:'claude-opus-4-6', maxBudget:null, thinkingMode:'adaptive', effort:'high', updatedAt: new Date().toISOString()}` (`200`). Never returns `404`. The synthesized defaults mirror the Drizzle `.default(...)` declarations in the schema; the client treats the payload as authoritative and renders the preferences UI directly from it.
  - **PUT** — upsert (`onConflictDoUpdate` keyed on `user_id`) the full row; `200 {preferences: UserPreferencesRow}`; `400` on unknown keys or invalid enum values (`permissionMode` / `thinkingMode` / `effort`); `400` on `maxBudget` non-numeric; emits invalidation.
- **Verify:** Integration test A: PUT `{model:'claude-sonnet-4-5'}`, GET returns same. Test B: GET on a user with no preference row returns 200 with `{model:'claude-opus-4-6', permissionMode:'default', thinkingMode:'adaptive', effort:'high', maxBudget:null, ...}` and `SELECT COUNT(*) FROM user_preferences WHERE user_id = ?` still returns 0 (read does not insert).
**Source:** `apps/orchestrator/src/api/index.ts:332-340` rewrite.

### B-API-4: PartyKit `/notify` on UserSettingsDO

**Core:**
- **ID:** `party-notify-endpoint`
- **Trigger:** Any Worker route POSTs to the UserSettingsDO party's `/notify` path after a D1 commit.
- **Expected:** The DO's `onRequest` parses the body (`{type:'invalidate',collection,keys?}`), broadcasts verbatim JSON to every connected socket. No storage access. Sockets that can't accept are removed from the set. **Caller contract:** `notifyInvalidation()` is fire-and-forget — it catches and logs every error (DO unreachable, timeout, non-2xx) but never throws or returns a rejected promise. A failed notify must never cause a mutation endpoint to return 5xx; the D1 commit is the source of truth, and the worst case of a dropped notify is a 5-minute cron-driven re-sync on idle clients.
- **Verify:** Two WS clients on the same user's party; POST /notify with a test payload; both clients receive the message (manual observation — not a CI-timed assertion, since WS delivery is environment-dependent). Separate unit test: force `env.UserSettings.get(...).fetch(...)` to reject with a synthetic error, assert the calling PATCH endpoint still returns 200 and the caught error is written to `console.warn`.
**Source:** new file layout in `apps/orchestrator/src/agents/user-settings-do.ts` (was Agent, becomes PartyServer).

#### API Layer
- Endpoint `POST /notify` (internal; only reachable via the DO stub, not exposed publicly)
- Payload: `{type:'invalidate', collection: 'agent_sessions'|'user_tabs'|'user_preferences', keys?: string[]}`
- Response: `204 No Content`

### B-API-4b: Route `/parties/user-settings/:userId` to the DO

**Core:**
- **ID:** `party-ws-routing`
- **Trigger:** Browser opens a WebSocket to `wss://{host}/parties/user-settings/{userId}` via `usePartySocket`.
- **Expected:** The Worker's entry point (`src/server.ts`) recognises the `/parties/user-settings/:userId` prefix before the TanStack Start handler runs, looks up the DO stub via `env.UserSettings.get(env.UserSettings.idFromName(userId))`, and forwards the original `Request` (including `Upgrade: websocket`, cookies, and auth headers) to the stub's `fetch()`. The DO's `onConnect` receives the upgraded socket. Use `partyserver`'s `routePartykitRequest(request, env)` helper if present; otherwise hand-roll the prefix match.
- **Verify:** A `wscat -c 'wss://staging/parties/user-settings/{userId}' -H 'Cookie: better-auth.session=…'` succeeds (101 upgrade), logs show the DO's `onConnect` firing. With a bogus userId path, the Worker returns 404 (the DO is never reached).
**Source:** new routing logic in `apps/orchestrator/src/server.ts` — required for B-CLIENT-5 and B-API-4 to function.

### B-API-5: Scheduled cron replaces discovery alarm

**Core:**
- **ID:** `scheduled-discovery-cron`
- **Trigger:** Cloudflare cron fires every 5 minutes.
- **Expected:** `src/api/scheduled.ts` exports `scheduled(event, env, ctx)` that fetches `$CC_GATEWAY_URL/sessions`, UPSERTs each row into `agent_sessions` keyed on `sdk_session_id`. No longer inside a DO.
- **Failure modes (explicit):**
  - Gateway fetch fails (network, 5xx, timeout ≥10s): log `[cron] gateway unreachable: <error>` via `console.warn` and exit cleanly. No retry inside the same cron invocation; the next 5-minute tick retries from scratch. No circuit breaker — the cron is idempotent, so a sequence of failures self-heals as soon as the gateway returns.
  - Gateway returns malformed JSON: log `[cron] invalid response shape` with the first 200 chars of the body, exit cleanly, same self-heal-next-tick behaviour.
  - Per-row UPSERT fails (constraint violation, e.g., FK to a user that no longer exists): log `[cron] upsert failed for <sdk_session_id>: <error>`, continue to the next row — partial success is better than nothing and does not corrupt D1.
  - The entire cron invocation must complete within Cloudflare's scheduled-event budget (30 seconds soft); the body wraps the gateway fetch in `AbortSignal.timeout(10_000)` and the per-row UPSERTs in a single Drizzle transaction to keep wall-clock predictable.
- **Verify:** Manually trigger via `wrangler d1 execute --command="SELECT COUNT(*) FROM agent_sessions"` before and after `curl -X POST .../__scheduled` on a staging worker. Separate unit test: mock `fetch` to reject, assert the scheduled handler resolves (does not throw) and logs a warning.
**Source:** new file `apps/orchestrator/src/api/scheduled.ts`; wrangler.toml `[triggers] crons = ['*/5 * * * *']`.

### B-CLIENT-1: OPFS race fixed

**Core:**
- **ID:** `opfs-race-fix`
- **Trigger:** App boot in the browser.
- **Expected:** Every `*-collection.ts` sees `persistence !== null` at `createCollection` time. React does not mount before `dbReady` resolves. Warm reloads render tab-bar from OPFS-cached rows within 50 ms of mount.
- **Verify:**
  - **Permanent regression test** (vitest, keeps the fix from silently regressing): `src/db/__tests__/db-instance.test.ts` imports `dbReady`, spies on any collection factory (e.g., `createCollection` re-export), and asserts that the spy is **only** invoked after `dbReady` resolves. A second assertion imports `userTabsCollection` at module scope and confirms the instance already has a non-null persistence handle at the moment of the assertion.
  - **One-shot boot assertion** (removed after first confirmation): temporary `console.log` in each collection file that flags if `persistence === null`; run the app once, verify no logs fire, delete the logs.
  - **Warm-reload timing** measured via `performance.mark` before/after `createCollection` — treated as a smoke signal, not a CI gate (see Verification Plan item 6).
**Source:** `apps/orchestrator/src/entry-client.tsx:7, 21-25`; `apps/orchestrator/src/db/db-instance.ts:18, 42-47`.

#### Client Layer
```ts
// entry-client.tsx (new)
import { dbReady } from '~/db/db-instance'

async function bootstrap() {
  await dbReady
  const { createRoot } = await import('react-dom/client')
  const { RouterProvider } = await import('@tanstack/react-router')
  // ... existing mount code
}

void bootstrap()
```

```ts
// db-instance.ts (new) — no `let persistence` export
export const dbReady: Promise<Persistence | null> = initPersistence()

export async function getPersistence(): Promise<Persistence | null> {
  return dbReady
}
```

### B-CLIENT-2: `userTabsCollection` (new)

**Core:**
- **ID:** `user-tabs-collection`
- **Trigger:** Module load after `dbReady` resolves.
- **Expected:** TanStack DB collection with key `'user_tabs'`, id=`'user_tabs'`, OPFS-persisted (schemaVersion 1), queryFn against `/api/user-settings/tabs`, `refetchInterval: false` (WS pushes handle freshness).
- **Verify:** Import and call `userTabsCollection.utils.refetch()`; confirm HTTP GET fires.
**Source:** new file `apps/orchestrator/src/db/user-tabs-collection.ts`.

### B-CLIENT-2b: `userPreferencesCollection` (new)

**Core:**
- **ID:** `user-preferences-collection`
- **Trigger:** Module load after `dbReady` resolves.
- **Expected:** TanStack DB collection with id=`'user_preferences'`, OPFS-persisted (schemaVersion 1), single-row shape (keyed on `userId`), `queryFn` against `GET /api/preferences`, `refetchInterval: false` (invalidation channel handles freshness). Row shape matches the B-API-3 envelope: `{userId, permissionMode, model, maxBudget, thinkingMode, effort, updatedAt}`. Mutations go through `PUT /api/preferences` (a single upsert) rather than per-field updates.
- **Verify:** Import and call `userPreferencesCollection.utils.refetch()` — HTTP GET fires; first-render reads the OPFS row synchronously if present; otherwise renders from the API response.
**Source:** new file `apps/orchestrator/src/db/user-preferences-collection.ts`.

#### Client Layer
- Uses `queryCollectionOptions` (not `localOnlyCollectionOptions`) so server state is authoritative.
- Maps directly into the B-CLIENT-5 `COLLECTIONS_BY_NAME` table under key `user_preferences` for invalidation routing.

### B-CLIENT-3: Rename `sessionsCollection` → `agentSessionsCollection`

**Core:**
- **ID:** `agent-sessions-collection`
- **Trigger:** Module load.
- **Expected:** Collection id changes from `'sessions'` to `'agent_sessions'`; `schemaVersion` bumped to 2 so old OPFS tables aren't read (old rows dropped; repopulated by queryFn on first boot). Row shape unchanged from today.
- **Verify:** Fresh browser profile: open app, observe `agent_sessions` table created in OPFS DB, old `sessions` table absent.
**Source:** `apps/orchestrator/src/db/sessions-collection.ts` → rename.

### B-CLIENT-4: Delete localStorage cache helpers

**Core:**
- **ID:** `delete-localstorage-helpers`
- **Trigger:** Source edit.
- **Expected:** `seedFromCache`, `persistSessionsToCache`, `lookupSessionInCache` deleted from `agent-sessions-collection.ts`. No `duraclaw-sessions` localStorage key written. No `agent-tabs` localStorage key written. OPFS becomes the sole first-render cache.
- **Verify:** Grep `'duraclaw-sessions'` and `'agent-tabs'` across `apps/orchestrator/src/` yields zero matches.
**Source:** deletions in `apps/orchestrator/src/db/sessions-collection.ts:60-112`, `apps/orchestrator/src/hooks/use-user-settings.tsx:100-146`.

### B-CLIENT-5: `use-invalidation-channel` hook

**Core:**
- **ID:** `invalidation-channel-hook`
- **Trigger:** Root route mount.
- **Expected:** Hook calls `usePartySocket({ host, party: 'user-settings', room: userId })`; on message, parses `{type,collection,keys?}`; looks up the collection by name and calls `collection.utils.refetch()`. Survives page navigation (singleton connection per app load).
- **Verify:** Vitest fake-WS test: send mock invalidation message to the hook, assert `refetch` is called on the corresponding collection.
**Source:** new file `apps/orchestrator/src/hooks/use-invalidation-channel.ts`; wired in `apps/orchestrator/src/routes/__root.tsx`.

#### Client Layer
```ts
const COLLECTIONS_BY_NAME = {
  user_tabs: userTabsCollection,
  agent_sessions: agentSessionsCollection,
  user_preferences: userPreferencesCollection,
}

export function useInvalidationChannel() {
  const { userId } = useAuth()
  usePartySocket({
    host: window.location.host,
    party: 'user-settings',
    room: userId,
    onMessage(ev) {
      const msg = JSON.parse(ev.data)
      if (msg.type === 'invalidate') {
        COLLECTIONS_BY_NAME[msg.collection]?.utils.refetch()
      }
    },
  })
}
```

### B-UI-1: Tab-bar renders from join query

**Core:**
- **ID:** `tab-bar-join`
- **Trigger:** Tab-bar component renders.
- **Expected:** Component uses `useLiveQuery(q => q.from({tab: userTabsCollection}).leftJoin({session: agentSessionsCollection}, …).orderBy(position))`. Each tab button reads `row.session?.project` and `row.session?.title` (or a skeleton state when session is `undefined`). No `tab.project`, no `tab.title` references.
- **Verify:** Render the component in jsdom with `userTabsCollection` populated but `agentSessionsCollection` empty; assert every tab renders the skeleton, never the word "unknown".
**Source:** `apps/orchestrator/src/components/tab-bar.tsx:176-200` rewrite.

#### UI Layer
Three render states per tab:
- **Loaded** — `session` joined, display `session.title` + small `session.project`
- **Skeleton** — `session === undefined` (not yet loaded), display shimmer with tab's sessionId-derived label as aria-label only
- **Active** — adds border/background classes based on the tab's matching against the active URL `?session=`

### B-UI-2: Delete placeholder creation paths

**Core:**
- **ID:** `delete-placeholder-paths`
- **Trigger:** Source edit.
- **Expected:** All four placeholder tab-creation paths (`AgentOrchPage.tsx:50-53, 124-127, 206-209, 223-226`) are deleted. Replaced with: one module-level effect that consumes `?session=` query param, calls `userTabsCollection.insert({id:nanoid(), sessionId, position:…})` if not already present — **no embedded `project` or `title`**.
- **Verify:** Grep `'unknown'` across `apps/orchestrator/src/` returns zero matches in tab-creation contexts; grep `addTab` returns only calls with the new shape.
**Source:** deletions in `apps/orchestrator/src/features/agent-orch/AgentOrchPage.tsx`.

### B-UI-3: Delete URL-sync effect chain + backfill

**Core:**
- **ID:** `delete-effect-chain`
- **Trigger:** Source edit.
- **Expected:** `AgentOrchPage.tsx:84-92, 97-102, 105-147, 388-413` all deleted. `useEffect` count in `AgentOrchContent` drops to ≤2 (projects fetch + keyboard listener).
- **Verify:** `rg 'useEffect' apps/orchestrator/src/features/agent-orch/AgentOrchPage.tsx | wc -l` ≤ 2.
**Source:** deletions in `apps/orchestrator/src/features/agent-orch/AgentOrchPage.tsx`.

### B-UI-4: Keyboard shortcuts read collections directly

**Core:**
- **ID:** `shortcuts-direct-collection`
- **Trigger:** User presses Cmd+T / Cmd+W / Cmd+1-9.
- **Expected:** Handlers read `userTabsCollection.toArray()` / `.get(activeId)` synchronously; no dependency on a React hook. Logic unchanged from today (functional parity).
- **Verify:** chrome-devtools-axi smoke: log in, open 3 tabs, press Cmd+2 — second tab becomes active; press Cmd+W — active tab closes.
**Source:** `apps/orchestrator/src/features/agent-orch/AgentOrchPage.tsx:270-311` rewrite.

### B-UI-5: Retire `useUserSettings` + hook

**Core:**
- **ID:** `retire-use-user-settings`
- **Trigger:** Source edit.
- **Expected:** `apps/orchestrator/src/hooks/use-user-settings.tsx` deleted. Every caller migrated to one of: `useLiveQuery` with the join, direct `collection.get()`, or `collection.insert()` via `createTransaction`.
- **Verify:** `rg 'useUserSettings' apps/orchestrator/src/` yields zero matches.
**Source:** deletions + many call-site edits.

### B-INFRA-1: Delete `ProjectRegistry` DO

**Core:**
- **ID:** `delete-project-registry`
- **Trigger:** Cutover deploy.
- **Expected:** `src/agents/project-registry.ts`, `src/agents/project-registry-migrations.ts` deleted. `wrangler.toml` `SESSION_REGISTRY` binding removed. Wrangler migration block adds `deleted_classes: ['ProjectRegistry']` to properly garbage-collect the DO namespace.
- **Verify:** Post-deploy, `wrangler tail` for 5 minutes shows no errors referencing ProjectRegistry; `wrangler d1 execute --command="SELECT COUNT(*) FROM agent_sessions"` returns the migrated row count.
**Source:** file deletions + `apps/orchestrator/wrangler.toml:24-26` edit.

### B-INFRA-2: `UserSettingsDO` shrinks to PartyServer

**Core:**
- **ID:** `user-settings-party-server`
- **Trigger:** Cutover deploy.
- **Expected:** `user-settings-do.ts` shrinks from 357 lines to ≤80 lines. Imports `partyserver`. Class `extends Server`. Methods: `onConnect`, `onClose`, `onRequest` (for `/notify`). No `this.storage.*` calls.
- **Verify:** `wc -l apps/orchestrator/src/agents/user-settings-do.ts` < 100; `rg 'this.storage' apps/orchestrator/src/agents/user-settings-do.ts` returns zero.

### B-INFRA-3: Delete dead zustand store

**Core:**
- **ID:** `delete-dead-zustand`
- **Trigger:** Source edit.
- **Expected:** `apps/orchestrator/src/stores/tabs.ts` deleted.
- **Verify:** File does not exist.

### B-INFRA-4: Delete UserSettingsDO migrations

**Core:**
- **ID:** `delete-do-migrations`
- **Trigger:** Source edit.
- **Expected:** `apps/orchestrator/src/agents/user-settings-do-migrations.ts` deleted.
- **Verify:** File does not exist.

### B-INFRA-5: `wrangler.toml` cleanup

**Core:**
- **ID:** `wrangler-cleanup`
- **Trigger:** Cutover deploy.
- **Expected:**
  - `SESSION_REGISTRY` DO binding removed.
  - `UserSettings` DO binding's `class_name` **stays as `UserSettingsDO`** (same string value as today). The implementation under the hood changes from `Agent<Env,State>` to `partyserver.Server`, but the exported class name and `class_name` in wrangler.toml remain `UserSettingsDO`. Do not rename — the DO namespace is identified by `script_name + class_name`, and any rename would orphan existing DO instances.
  - `[triggers] crons = ['*/5 * * * *']` added to `wrangler.toml`.
  - Migration block adds `deleted_classes: ['ProjectRegistry']`.
  - Migration block `delete_sqlite: true` for `UserSettingsDO` — this directive is already present in the feature branch's `wrangler.toml` from the p3 source edit (not re-added here). B-INFRA-5 only verifies it survived to the cutover deploy. Do not attempt to add it a second time.
- **Verify:** `wrangler deploy --dry-run` succeeds; diff review against pre-cutover `wrangler.toml` confirms the three changes above; `class_name` for `UserSettings` binding is literally unchanged.

## Non-Goals

Explicit exclusions — these are **not** in scope for this spec:

- **Draft persistence.** Drafts are handed off to the Yjs collaboration layer in PR #4. This spec deletes the old draft paths but does **not** introduce any D1 draft storage. If PR #4 has not merged at cutover time, drafts will be non-persisted across reloads for the duration between this spec shipping and PR #4 shipping; the spec accepts that regression.
- **Message cache changes.** `messagesCollection` (cache-behind for chat message parts) remains `localOnlyCollectionOptions` and OPFS-persisted. Its schemaVersion bump is a side effect of the OPFS-race fix (if schema shape changes it does; otherwise no bump).
- **Multi-region D1 replication.** D1 is single-region; cross-region latency for users far from the primary region is an accepted limitation.
- **Feature-flagged gradual rollout.** Big bang cutover; no GrowthBook or similar.
- **iOS Safari OPFS-unavailable warning UX.** Silent memory-only fallback as today; no user-facing banner.
- **Per-key invalidation granularity.** The `keys` field on the invalidation message is reserved in the protocol, but the client handler always treats it as a whole-collection refetch until TanStack DB adds `refetchKeys`.
- **Better Auth schema migration to drizzle-kit.** The existing auth tables are retrofitted into the generated schema.ts for type safety, but the SQL migrations for auth are not regenerated (existing 0001_auth_tables.sql stays authoritative). `drizzle-kit check` must report them as aligned after the retrofit.
- **CRDT merge logic for concurrent tab writes.** Last-writer-wins on `user_tabs.position` concurrency is acceptable (tab reorders are low-frequency, single-user per session).
- **UserSettingsDO echo suppression for same-device origin.** Noted as an open risk in the interview; the first implementation accepts one redundant refetch per mutation from the same device. If measured as painful (UI flicker) a follow-up can add an origin-id filter.

## Implementation Phases

Phases are listed in the frontmatter (p1–p6). Summary:

- **p1** — D1 schema + drizzle-kit adoption
- **p2** — D1-backed API endpoints
- **p3** — UserSettingsDO → PartyKit fanout
- **p4** — Client collections + OPFS race fix
- **p5** — UI refactor (tab-bar join, delete effects)
- **p6** — Cutover: export, deploy, delete ProjectRegistry

Phase p6 is the single cutover window that flips all reads/writes to D1.

**Branching & deploy guardrail (critical):** Because p2 **rewrites** existing `/api/sessions*`, `/api/user-settings/tabs*`, and `/api/preferences` routes in place against empty D1 tables, the window between p2 merging and p6 deploying cannot tolerate any unrelated deploy — a hotfix push to `main` would route live traffic to empty tables and make every user's session history disappear.

Work on all of p1–p6 **in a long-lived feature branch** `feat/d1-partykit-migration` forked from the pre-cutover `main`. Every phase's tasks commit to that branch. The branch is merged to `main` exactly once, during step 5 of the cutover runbook, after migrations and the data export have been applied. No hotfixes land on the feature branch; urgent `main` hotfixes during the migration window are rebased forward into the feature branch as they land.

As a belt-and-braces safeguard, the `scripts/cutover.sh` runbook's first action is to assert that the currently-deployed commit equals the feature branch's merge-base on `main` — if anyone has snuck a deploy in, the script refuses to proceed.

## Verification Plan

Run after phase p6 completes, in a fresh browser session, against a production-like staging environment with migrated data.

1. **Maintenance-mode off check**
   - `curl -s https://{staging-host}/ -o /dev/null -w "%{http_code}"` returns `200` (not the 503 maintenance page).

2. **Login + sidebar render**
   - `chrome-devtools-axi open https://{staging-host}/login`
   - Log in with `agent.verify+duraclaw@example.com` / `duraclaw-test-password`
   - `chrome-devtools-axi snapshot`
   - Assert: sidebar shows at least one historical session row (from migrated D1).

3. **Tab bar with skeleton (cold load on deep-link)**
   - Clear browser data, open `https://{staging-host}/?session={known-archived-sessionId}`
   - `chrome-devtools-axi screenshot`
   - Assert: tab renders with skeleton or project badge, **never** `unknown`.

4. **Invalidation fanout smoke** (manual observation)
   - Open two browser tabs on the same account.
   - In tab A, rename the current session via the UI (PATCH `/api/sessions/:id`).
   - Observe tab B's tab-bar entry updating to the new title without manual refresh. Target: subjectively "immediate" (typically under 2 seconds). This is a manual smoke check, not a timed CI assertion — `wrangler tail` + WS propagation latency is environment-dependent.

5. **Resume by `sdk_session_id` upsert**
   - Trigger the session-resume path manually: kill a runner, wait for gateway discovery, verify `SELECT * FROM agent_sessions WHERE sdk_session_id='{known-id}'` returns exactly one row.

6. **OPFS warm-reload latency** (manual observation, local dev only)
   - Hard reload the dashboard page.
   - `chrome-devtools-axi eval "performance.getEntriesByName('tab-bar-rendered')[0].startTime"` (requires a `performance.mark` at tab-bar first-render, added as a dev-only mark).
   - Target: under 100 ms on a warm reload on a typical laptop. Measurement is sensitive to machine load, so treat as a smoke signal, not a CI gate. Flag in the closing comment of the PR if > 500 ms.

7. **Keyboard shortcuts**
   - Open 3 tabs.
   - Cmd+2 → second tab becomes active (URL updates, badge highlights).
   - Cmd+W → active tab closes, neighboring tab becomes active.
   - Cmd+T → current session is pinned as a new tab.

8. **No orphaned `SESSION_REGISTRY` calls**
   - `rg SESSION_REGISTRY apps/orchestrator/src` returns zero matches.

9. **Drizzle migration round-trip**
   - On a fresh local D1: `wrangler d1 execute --local duraclaw-auth --command="DROP TABLE IF EXISTS agent_sessions; DROP TABLE IF EXISTS user_tabs;"`; then `pnpm db:migrate --local`; then `pnpm tsx scripts/export-do-state.ts --from=file:staging-backup.sqlite > export.sql`; then `wrangler d1 execute --local --file=export.sql`. Row counts in `agent_sessions` and `user_tabs` match staging.

10. **Wrangler health**
    - `wrangler tail` for 5 minutes after cutover: no error logs referencing `SESSION_REGISTRY`, `ProjectRegistry`, or missing DO bindings.

## Implementation Hints

### Key Imports

```ts
// PartyKit server (in user-settings-do.ts)
import { Server, type Connection } from 'partyserver'

// PartyKit client (in use-invalidation-channel.ts)
import usePartySocket from 'partysocket/react'

// Drizzle ORM (replaces raw prepare in api/index.ts)
import { drizzle } from 'drizzle-orm/d1'
import { eq, and, desc, asc, sql } from 'drizzle-orm'
import { sqliteTable, text, integer, real, index, uniqueIndex } from 'drizzle-orm/sqlite-core'

// TanStack DB join
import { eq as tdbEq } from '@tanstack/db'
```

### Code Patterns

**PartyServer fanout (`user-settings-do.ts`)**
```ts
import { Server, type Connection } from 'partyserver'

export class UserSettingsDO extends Server {
  async onConnect(conn: Connection) {
    // Better Auth cookie check from conn.req.headers
    const session = await getRequestSession(this.env, conn.req)
    if (!session) return conn.close(4401, 'unauthenticated')
    // No state send — collections refetch on invalidation
  }

  async onRequest(req: Request) {
    const url = new URL(req.url)
    if (url.pathname === '/notify' && req.method === 'POST') {
      const body = await req.text()
      for (const conn of this.getConnections()) {
        try { conn.send(body) } catch { /* dropped sockets */ }
      }
      return new Response(null, { status: 204 })
    }
    return new Response('not found', { status: 404 })
  }
}
```

**Invalidation helper (`src/api/notify.ts`) — fire-and-forget**
```ts
// IMPORTANT: this function NEVER throws and NEVER returns a rejected promise.
// Mutation endpoints await it purely for ordering; a notify failure must
// never cause the caller to return 5xx after a successful D1 commit.
export async function notifyInvalidation(
  env: Env,
  userId: string,
  collection: 'agent_sessions' | 'user_tabs' | 'user_preferences',
  keys?: string[],
): Promise<void> {
  try {
    const id = env.UserSettings.idFromName(userId)
    const payload = JSON.stringify({ type: 'invalidate', collection, keys })
    const res = await env.UserSettings.get(id).fetch('https://do/notify', {
      method: 'POST',
      body: payload,
    })
    if (!res.ok) console.warn('[notify] non-2xx', res.status, collection, userId)
  } catch (err) {
    console.warn('[notify] threw', (err as Error).message, collection, userId)
  }
}
```

**Drizzle query pattern (replaces raw `prepare`)**
```ts
import { drizzle } from 'drizzle-orm/d1'
import { agentSessions, users } from '~/db/schema'

app.get('/api/sessions', authMiddleware, async (c) => {
  const userId = c.get('userId')
  const db = drizzle(c.env.AUTH_DB, { schema })
  const rows = await db.select().from(agentSessions)
    .where(eq(agentSessions.userId, userId))
    .orderBy(desc(agentSessions.lastActivity))
    .limit(200)
  return c.json({ sessions: rows })
})
```

**TanStack DB join (`tab-bar.tsx`)**
```ts
import { useLiveQuery } from '@tanstack/react-db'
import { eq } from '@tanstack/db'
import { userTabsCollection } from '~/db/user-tabs-collection'
import { agentSessionsCollection } from '~/db/agent-sessions-collection'

export function TabBar() {
  const { data: rows } = useLiveQuery((q) =>
    q.from({ tab: userTabsCollection })
      .leftJoin({ session: agentSessionsCollection }, ({ tab, session }) =>
        eq(tab.sessionId, session.id))
      .orderBy(({ tab }) => tab.position)
  )
  return (
    <div>
      {rows?.map((row) => (
        <TabButton key={row.tab.id} tab={row.tab} session={row.session} />
      ))}
    </div>
  )
}
```

**`drizzle.config.ts`**
```ts
import type { Config } from 'drizzle-kit'

export default {
  schema: './src/db/schema.ts',
  out: './migrations',
  dialect: 'sqlite',
  driver: 'd1-http',
  dbCredentials: {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
    databaseId: 'c5b4d822-9bc6-467f-9ad6-7ee779b82e0c',
    token: process.env.CLOUDFLARE_API_TOKEN!,
  },
} satisfies Config
```

**`scripts/cutover.sh`**
```bash
#!/usr/bin/env bash
set -euo pipefail
# 1. Maintenance mode on — single mechanism: MAINTENANCE_MODE env var
echo "1" | wrangler secret put MAINTENANCE_MODE
wrangler deploy                                        # current worker, now in maintenance
# 2. Export DO state
pnpm tsx scripts/export-do-state.ts --out=export.sql
# 3. Apply migrations
wrangler d1 migrations apply duraclaw-auth --remote
# 4. Apply export
wrangler d1 execute duraclaw-auth --remote --file=export.sql
# 5. Deploy new worker (still under maintenance mode)
wrangler deploy
# 6. Maintenance mode off
echo "0" | wrangler secret put MAINTENANCE_MODE
wrangler deploy                                        # new worker, live
echo "Cutover complete. Monitor wrangler tail for 10 minutes."
```
No separate wrangler `[env.maintenance]` block is required — the maintenance middleware in `src/server.ts` keys off the single `MAINTENANCE_MODE` secret.

### Gotchas

1. **PartyKit class naming vs. wrangler.toml.** PartyKit expects the class to be exported as default or under a specific name keyed by the `party` name in `partykit.json`. Using `partyserver` (the lower-level library) inside a standard Cloudflare Worker, the class is a normal `durable_objects.bindings` entry. Spec uses `partyserver` inside the existing orchestrator Worker — no separate partykit deploy.

2. **`deleted_classes` migration hazard.** Cloudflare requires the deleted class to have no in-flight requests when the migration applies. Because `ProjectRegistry` is a singleton-named DO, the cutover deploy must ensure no `SESSION_REGISTRY.*` calls remain in code *before* the wrangler migration runs. Spec handles this by moving all endpoint rewrites into p2 (before p6), so the deleted-classes migration in p6 never has active callers.

3. **TanStack DB `utils.refetch()` is whole-collection.** There is no `refetchKeys` method in the current TanStack DB version. The spec's invalidation protocol includes `keys` for future compatibility but clients always do a full refetch today.

4. **`drizzle-kit` + D1 HTTP driver authentication.** Requires `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` env vars. The cutover runbook must ensure these are set in the CI/deployment environment that runs `pnpm db:generate`.

5. **OPFS schema version bump invalidates old cached data.** Bumping `schemaVersion` from 1→2 on `agentSessionsCollection` means every user's OPFS table is dropped and repopulated by the queryFn on first load. Factored into the cutover timeline — users see an empty skeleton → populated transition on first open after cutover.

6. **Better Auth `sessions` table vs. `agent_sessions`.** Drizzle schema must export both with different variable names (`sessions` for auth, `agentSessions` for chat) and not collide in the D1 namespace either. Migration 0001 created Better Auth `sessions`; migration 0006 creates `agent_sessions`. Both coexist.

7. **PartyKit / `usePartySocket` reconnect semantics.** The client library auto-reconnects with exponential backoff; the server-side `this.getConnections()` returns only currently-open sockets, so a message sent during reconnect is lost. Acceptable because the next user interaction triggers a fresh fetch, and the worst-case staleness window equals reconnect duration (typically < 5 seconds).

8. **`wrangler d1 migrations apply` ordering vs. deploy.** If the migration adds a NOT NULL column to an existing row, it'll fail on rows with no default. Spec handles this by only creating new tables (no ALTER of existing) in p1; the only ALTER-style change is `DROP TABLE user_preferences` (old KV) bundled with its columnar replacement inside the single atomic file `0008_replace_user_preferences.sql`.

### Reference Docs

- TanStack DB joins: https://tanstack.com/db/latest/docs/guides/queries#joins — covers `leftJoin`, result shape, orderBy semantics. Concrete example of the row shape this spec relies on.
- TanStack DB persistedCollectionOptions: https://tanstack.com/db/latest/docs/guides/persisted-collections — especially the `schemaVersion` bump behavior confirming old tables are dropped.
- PartyKit / partyserver: https://www.partykit.io/docs/reference/partyserver — `Server` class, `onConnect`, `onRequest`, `getConnections`. This is the library we're using (not the higher-level PartyKit runtime).
- partysocket (client): https://www.npmjs.com/package/partysocket — includes `usePartySocket` React hook, room/party addressing.
- Drizzle for Cloudflare D1: https://orm.drizzle.team/docs/connect-cloudflare-d1 — the D1 HTTP driver setup, `wrangler d1 migrations apply` integration.
- Drizzle-kit SQLite migrations: https://orm.drizzle.team/kit-docs/commands#generate-migrations — `drizzle-kit generate` for partial indexes and FK references.
- Cloudflare D1 ON CONFLICT UPSERT: https://developers.cloudflare.com/d1/sql-api/query-builder/#on-conflict — required for B-DATA-1's `sdk_session_id` upsert.
- Cloudflare Worker cron triggers: https://developers.cloudflare.com/workers/configuration/cron-triggers/ — for B-API-5's replacement of the DO alarm.
- Cloudflare DO migrations (class deletion): https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/#delete-migrations — for B-INFRA-1's `deleted_classes`.
- Prior research doc: `planning/research/2026-04-17-issue-7-tanstack-db-loading-gate.md` — architectural rationale for the D1 + PartyKit shape.
- Prior inventory: `planning/research/2026-04-18-issue-7-planning-inventory.md` — file:line references for every change site.
- Prior interview summary: `planning/research/2026-04-18-issue-7-interview-summary.md` — locked decisions and architectural bets.
