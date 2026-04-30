---
initiative: projects-docs-entry-point
type: project
issue_type: feature
status: approved
priority: medium
github_issue: 122
created: 2026-04-29
updated: 2026-04-29
research:
  - planning/research/2026-04-29-gh122-projects-docs-entry-point.md
  - planning/research/2026-04-29-gh122-interview-summary.md
related:
  - planning/specs/27-docs-as-yjs-dialback-runners.md   # Shipped; this spec exposes its UI
  - planning/specs/115-worktrees-first-class-resource.md  # Pinned coordination point on docsWorktreePath
spec_status_after_review:
  rounds: 3
  final_score: 92
  reviewer_status: PASS
  notes: |
    Rounds 1, 2, 3 all returned PASS (scores 92, 93, 92). All Critical and
    Important issues addressed inline; remaining Low/Medium-impact items
    accepted as documented (per-route auth B-IDs grouped intentionally;
    HonoEnv type augmentation left to implementer; P4 component-level vitest
    deferred per interview F1). Spec approved at iteration cap.
phases:
  - id: p1
    name: "Schema migration 0032 (projects.projectId, projectMetadata.ownerId, project_members) + post-migration backfill script"
    tasks:
      - "Pre-flight: take a D1 backup with `wrangler d1 export <db-name> --output=apps/orchestrator/migrations/backups/pre-0032.sql` BEFORE running the migration. This is the rollback fixture."
      - "Hand-write `apps/orchestrator/migrations/0032_projects_ownership.sql` with: (1) ALTER TABLE projects ADD COLUMN projectId TEXT NULL; CREATE INDEX idx_projects_project_id ON projects(projectId) WHERE projectId IS NOT NULL; (2) ALTER TABLE project_metadata ADD COLUMN ownerId TEXT NULL REFERENCES users(id) ON DELETE SET NULL; (3) CREATE TABLE project_members (project_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')), added_at TEXT NOT NULL, added_by TEXT, PRIMARY KEY (project_id, user_id), FOREIGN KEY (project_id) REFERENCES project_metadata(projectId) ON DELETE CASCADE, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE); (4) CREATE UNIQUE INDEX project_members_one_owner ON project_members(project_id) WHERE role='owner'; (5) CREATE INDEX idx_project_members_user ON project_members(user_id)."
      - "Update `apps/orchestrator/src/db/schema.ts`: add `projectId: text('projectId')` to `projects` table (286-293); add `ownerId: text('ownerId')` to `projectMetadata` table (389-397); add new `projectMembers` table export with the same columns and constraints. Keep all column ordering matching the migration."
      - "Update the `ProjectInfo` shared type at `packages/shared-types/src/index.ts`: add `ownerId: string | null` and `projectId: string | null` fields. Then update `apps/orchestrator/src/db/projects-collection.ts` if its row schema is derived from that type, so the synced collection carries the new fields. Without this, P4's UI will hit a TS error trying to read `project.ownerId` and `project.projectId` on the card."
      - "Write `scripts/backfill-project-ids.ts` (new) — Bun script: connects to D1 via `wrangler d1 execute --json`; SELECTs every `project_metadata` row with non-null originUrl; for each, computes `projectId = await deriveProjectId(originUrl)` (import from `@duraclaw/shared-types/entity-id`); UPDATEs `projects` SET projectId=? WHERE name=? (matched via project_metadata.projectName). Also accepts `--dry-run` flag that prints UPDATE statements without executing. Logs per-row status to stdout."
      - "Add npm script `pnpm backfill:project-ids` in `apps/orchestrator/package.json` that runs the script. Document its usage in the migration's leading SQL comment."
      - "After migration applies, run `pnpm backfill:project-ids` (operator gesture, not in pipeline)."
      - "Generate Drizzle metadata sidecar: `pnpm --filter @duraclaw/orchestrator drizzle:generate` to keep `migrations/meta/_journal.json` in sync (the SQL itself is hand-written but the journal must list 0032). Verify: `migrations/meta/_journal.json` last entry has tag `0032_projects_ownership`."
    test_cases:
      - "drizzle migration applies cleanly on a copy of prod D1 (or local dev D1) with no errors"
      - "post-migrate: PRAGMA table_info(projects) lists projectId column; PRAGMA table_info(project_metadata) lists ownerId column; PRAGMA table_info(project_members) lists all 5 columns + role CHECK constraint"
      - "post-migrate: SELECT count(*) FROM sqlite_master WHERE name='project_members_one_owner' = 1 (partial unique index exists)"
      - "post-migrate: attempt INSERT INTO project_members VALUES ('p1','u1','owner',...), then second INSERT INTO project_members VALUES ('p1','u2','owner',...) raises a UNIQUE constraint error (one-owner-per-project enforced)"
      - "backfill script dry-run on a fixture with N projectMetadata rows prints N UPDATE statements; non-dry-run leaves projects.projectId populated for matching rows"
      - "backfill script idempotent: second run with same data is a no-op (UPDATEs collapse to same values)"
      - "pnpm --filter @duraclaw/orchestrator typecheck passes after schema.ts change"
  - id: p2
    name: "Atomic dual-write in gateway sync handler; drop gateway per-project PATCH"
    tasks:
      - "Modify `apps/orchestrator/src/api/index.ts:714-750` (gateway sync handler): for each incoming project with non-null `repo_origin`, compute `projectId = await deriveProjectId(p.repo_origin)`. Within a single `db.transaction(async (trx) => { ... })` block, upsert the `projects` row (now including projectId column) via INSERT...onConflictDoUpdate, AND upsert the `project_metadata` row keyed by projectId via INSERT...onConflictDoUpdate (set projectName, originUrl, updatedAt). On UPDATE conflict, do NOT touch ownerId."
      - "If `p.repo_origin` is null/empty, leave `projects.projectId` NULL and skip the project_metadata upsert (gateway-discovered project without an origin URL is rare but possible — local-only clones)."
      - "Soft-delete reconciliation (existing logic at `api/index.ts:747-750`): unchanged. Soft-deleting a `projects` row leaves the `project_metadata` row intact (a soft-deleted project's docs config persists; if the gateway re-discovers it later, the metadata is re-attached via projectId)."
      - "Delete `packages/agent-gateway/src/projects.ts:265-308` (`registerProjectWithOrchestrator()` function and its sole call site at the discovery loop). The bulk sync now covers everything this function did. Update its caller to no-op."
      - "Update `apps/orchestrator/src/api/gateway/projects/sync.test.ts` to assert: (a) project_metadata rows are populated by the sync; (b) projectId is set on projects rows; (c) ownerId is left untouched on subsequent syncs of an already-owned project; (d) projects without repo_origin are inserted with projectId=null."
      - "Add a vitest unit test in `apps/orchestrator/src/api/gateway/projects/sync.test.ts` for the atomicity guarantee: simulate a transaction failure mid-batch (mock the second upsert to throw), assert NEITHER the projects row nor the project_metadata row commits."
    test_cases:
      - "POST /api/gateway/projects/sync with a payload of 3 projects, all with repo_origin: post-call, SELECT count(*) FROM projects WHERE projectId IS NOT NULL = 3 AND SELECT count(*) FROM project_metadata = 3"
      - "POST /api/gateway/projects/sync where one project's metadata row already has ownerId set: post-call, that ownerId remains unchanged (UPDATE clause does not touch ownerId)"
      - "POST /api/gateway/projects/sync with one project lacking repo_origin: that row's projects.projectId is NULL, no project_metadata row created"
      - "Unit test: mocked transaction failure mid-write leaves both tables unchanged from pre-call state"
      - "grep -rn 'registerProjectWithOrchestrator' packages/ apps/ returns zero hits"
  - id: p3a
    name: "requireProjectMember middleware + bearer-auth flag refactor + tighten 4 routes"
    sequencing_note: "P3a and P3b BOTH modify apps/orchestrator/src/api/index.ts. They MUST run in sequence (P3a first, then P3b) within a single implementation session. Do NOT run them as parallel worktree agents — merge conflicts are guaranteed. P3b's auth on the transfer endpoint depends on P3a's middleware existing first."
    tasks:
      - "Add `apps/orchestrator/src/api/middleware/require-project-member.ts` (new) — Hono middleware factory `requireProjectMember(minRole: 'owner' | 'editor' | 'viewer')`. Logic: (a) if `c.get('bearerAuth') === true`, call `next()` (bearer bypass per B-AUTH-6). (b) Else require a session; if `c.get('role') === 'admin'`, call `next()` (admin override). (c) Else SELECT role FROM project_members WHERE project_id=? AND user_id=?; if missing → 403 with `{error,reason:'not-a-project-member',requiredRole,actualRole:null}`; if `ROLE_RANK[role] < ROLE_RANK[minRole]` → 403 with `{error,reason:'insufficient-role',requiredRole,actualRole:role}`; else `next()`. Document at top of file: 'Must be chained AFTER projectMetadataAuth so c.get(bearerAuth) is populated.'"
      - "Refactor `projectMetadataAuth` (`apps/orchestrator/src/api/index.ts:1145-1167`) to set `c.set('bearerAuth', true|false)` after the timing-safe compare so the new middleware can read it without re-doing the work. Existing behavior unchanged for callers that only mount projectMetadataAuth."
      - "Wire `requireProjectMember('owner')` onto PATCH /api/projects/:projectId (line 1169). Order: `projectMetadataAuth, requireProjectMember('owner'), handler`."
      - "Wire `requireProjectMember('viewer')` onto GET /api/projects/:projectId (line 1270), GET /api/projects/:projectId/docs-files (line 2266), GET /api/docs-runners/:projectId/health (line 2346). Same middleware order."
      - "Remove the explicit TODO comment block at `api/index.ts:2272-2276` and the analogous TODO at `:1977` (both now satisfied by the middleware)."
      - "Add `getProjectIdByName(db, name): Promise<string | null>` helper in `apps/orchestrator/src/lib/projects.ts` (new file). Single SELECT projectId FROM projects WHERE name=? ORDER BY updatedAt DESC LIMIT 1. Used by P5's session-card link."
    test_cases:
      - "vitest: cookie PATCH /api/projects/<id> from non-member → 403 with reason='not-a-project-member'"
      - "vitest: cookie PATCH /api/projects/<id> from owner → 200; from admin → 200"
      - "vitest: cookie PATCH /api/projects/<id> from a viewer → 403 with reason='insufficient-role', actualRole='viewer'"
      - "vitest: bearer DOCS_RUNNER_SECRET PATCH /api/projects/<id> → 200 (bypass) even though no project_members row exists for any user"
      - "vitest: cookie GET /api/projects/<id>/docs-files from non-member → 403; from viewer → 200; from editor → 200; from owner → 200; bearer → 200"
      - "vitest: cookie GET /api/docs-runners/<id>/health → same matrix as docs-files"
      - "vitest: getProjectIdByName('duraclaw') returns the matching projectId; returns null for unknown name; returns null when projectId column is null for that row"
      - "grep -nE 'TODO.*(per-project|visibility)' apps/orchestrator/src/api/index.ts returns zero hits at lines 2272 and 1977"
  - id: p3b
    name: "Claim + Transfer endpoints (with admin-only and owner-or-admin auth respectively, atomic D1 txns, broadcast)"
    tasks:
      - "Add new endpoint `POST /api/projects/:projectId/claim` in `apps/orchestrator/src/api/index.ts` (placement near other admin endpoints, after :2193). Auth: inline `if (c.get('role') !== 'admin') return c.json({error:'forbidden',reason:'admin-required'}, 403)`. Validate projectId via PROJECT_ID_RE. Inside `db.transaction(async trx => { ... })`: UPDATE project_metadata SET ownerId=:userId, updatedAt=now() WHERE projectId=? AND ownerId IS NULL .returning(); if `result.length === 0` → 409 `{error:'already_owned'}`; else INSERT INTO project_members VALUES (projectId, userId, 'owner', now-iso8601, userId). Outside the txn: call `broadcastSyncedDelta(env, fanoutUserIds, 'projects', [{type:'update', value: projectInfo}])` — see B-LIFECYCLE-1 broadcast fanout policy."
      - "Add new endpoint `POST /api/projects/:projectId/transfer` body `{ newOwnerUserId: string }`. Middleware chain: `projectMetadataAuth, requireProjectMember('owner'), handler` (admin override is automatic from B-AUTH-1). Inside a single D1 transaction: (1) validate newOwnerUserId exists in users → 400 `{error:'bad_request',reason:'unknown-user'}` if not; (2) check current ownerId !== newOwnerUserId → 409 `{error:'no_op',reason:'already-owner'}` if equal; (3) UPDATE project_metadata SET ownerId=:newOwnerUserId, updatedAt=now() WHERE projectId=?; (4) DELETE FROM project_members WHERE project_id=? AND role='owner'; (5) INSERT INTO project_members VALUES (projectId, newOwnerUserId, 'owner', now-iso8601, callerUserId). DELETE+INSERT instead of UPDATE — see B-LIFECYCLE-2 rationale (PK column mutation)."
      - "After the transfer txn commits, call broadcastSyncedDelta same fanout policy as claim."
      - "Implement `projectInfoFromMeta(env, projectId)` helper used by both endpoints to construct the broadcast payload. SELECT joined row from projects + project_metadata; return ProjectInfo shape matching what the sync handler emits."
      - "Add new endpoint `GET /api/users/picker` (B-API-1) returning `[{ id, displayName, email }]` from the users table for ANY authed cookie session (no admin gate). Used by P4's transfer dialog when the caller is a non-admin owner. Cap response at 200 rows ORDER BY displayName ASC to avoid blowing up the browser; if a deploy ever has more than 200 users, a follow-up issue can add a search box. Validate authed via existing session middleware; return 401 if no session."
    test_cases:
      - "vitest: admin POST /api/projects/<id>/claim on null-owner project → 200 + ownerId set + project_members row inserted with role='owner'"
      - "vitest: second admin's claim on already-owned project → 409 with error='already_owned'"
      - "vitest: non-admin (role='user') claim on null-owner project → 403 with reason='admin-required'"
      - "vitest: owner POST /api/projects/<id>/transfer with valid newOwnerUserId → 200 + ownerId migrated + project_members owner-row deleted+reinserted (assert via SELECT count(*) WHERE role='owner' = 1 AND user_id = newOwnerUserId)"
      - "vitest: transfer to nonexistent userId → 400 with reason='unknown-user'"
      - "vitest: transfer to current owner (no-op) → 409 with reason='already-owner'"
      - "vitest: transfer by non-member non-admin → 403 with reason='not-a-project-member'"
      - "vitest: transfer by admin (not the current owner) → 200 (admin override)"
      - "vitest: claim broadcast fanout — assert broadcastSyncedDelta is called with the projectsCollection name and an update op containing the new ownerId"
      - "vitest: GET /api/users/picker returns [{id, displayName, email}] for authed user; returns 401 without session; sorted by displayName ASC; capped at 200 rows on a fixture with 250 users"
  - id: p4
    name: "/projects route + sidebar nav + project card + claim/transfer buttons"
    tasks:
      - "Create `apps/orchestrator/src/routes/_authenticated/projects.tsx` — TanStack Router file route at `/projects`. Component: ProjectsPage. Uses `useLiveQuery(projectsCollection)` (existing collection at `db/projects-collection.ts`). Visibility filtering: if the user's role is not 'admin', filter out projects where `visibility === 'private'` AND the user is not the owner (use the in-memory ownership info already on the projectsCollection row, which is populated by B-SYNC-2's atomic dual-write). Render a grid/list of ProjectCard."
      - "Create `apps/orchestrator/src/components/projects/ProjectCard.tsx` (new). Props: `project: ProjectInfo`, `currentUserId`, `currentUserRole`. Renders: project name (large, monospace), displayName (subtitle), `[Open Sessions]` button (links to `/?project=<name>` or equivalent existing filter), `[Open Docs]` button (links to `/projects/$projectId/docs` IF `project.projectId` is non-null; disabled with tooltip 'Project not yet synced — try again in a moment' otherwise), VisibilityBadge (existing component) if `project.visibility !== 'public'`, ownership status block: `Owner: <displayName>` if owned; `Unowned [Claim]` if null + isAdmin; `Unowned — ask an admin` otherwise."
      - "Project card empty state and loading state per the convention in `routes/_authenticated/settings.tsx:127-141`. Empty: `No projects discovered yet — the gateway syncs every 30s.` Loading: skeleton cards (3 placeholders)."
      - "Add `[Claim]` button click handler: POST `/api/projects/:projectId/claim`; on 200, optimistic update relies on the broadcastSyncedDelta from the server to update the projectsCollection; show a small toast on success or failure."
      - "Add `[Transfer ownership]` button on owned cards (visible only to owner or admin): opens a Dialog with a user picker. **Two paths depending on caller role:** (a) **Admin caller** uses `authClient.admin.listUsers({ query: { limit: 100 } })` (Better Auth admin plugin — same call already used at `routes/_authenticated/admin.users.tsx:76`). (b) **Non-admin owner caller** uses a new lightweight endpoint `GET /api/users/picker` (defined in P3b — see B-API-1) that returns `[{ id, displayName, email }]` for any authed user (no admin gate, but only displayName + email exposed — these are already broadcast via userPresence anyway). Render a `<Select>` of users (label = `displayName || email`, value = `userId`); exclude the current owner. On submit, POST `/api/projects/:projectId/transfer` with `{ newOwnerUserId }`. Same delta + toast pattern as claim. The component picks endpoint (a) or (b) at render time based on `currentUserRole === 'admin'`."
      - "Modify `apps/orchestrator/src/components/layout/sidebar-data.ts` (lines 4-27): insert a new entry in the General navGroup between 'Sessions' and 'Board' with: title 'Projects', url '/projects', icon (use `LayoutGrid` or similar from lucide-react matching existing icon style)."
      - "Extend the admin `ProjectsSection` in `apps/orchestrator/src/routes/_authenticated/settings.tsx:380-474`: add an Owner column to the existing list, with `[Reassign]` button that opens the same transfer dialog. Admins can also reassign even when not the current owner. (This is the admin override path for B-LIFECYCLE-2.)"
    test_cases:
      - "Manual: navigate to /projects in the running app → page loads, sidebar shows new Projects entry between Sessions and Board"
      - "Manual: as admin viewer on a null-owner project, [Claim] button is visible; click → ownerId set, button disappears, ownership status updates to 'Owner: <admin name>'"
      - "Manual: as non-admin viewer on a null-owner project, no [Claim] button; status reads 'Unowned — ask an admin'"
      - "Manual: as owner, [Transfer ownership] button visible; opens dialog; submitting valid user → status block updates to new owner's name"
      - "Manual: project card with non-null projectId: [Open Docs] navigates to /projects/<projectId>/docs; project card with null projectId: button disabled with tooltip"
      - "vitest: ProjectsPage filters out private projects from non-admin non-owners; admin sees all; owner sees own private projects"
  - id: p5
    name: "Session-card 'Open Docs' link + name→projectId resolution"
    tasks:
      - "Modify `apps/orchestrator/src/components/layout/nav-sessions.tsx:476-540` (the SidebarMenuItem render for each session). After the existing `session.project` text, conditionally render a small icon-button (FileTextIcon from lucide-react, size 3.5) wrapped in a TanStack `Link to='/projects/$projectId/docs' params={{ projectId }}`."
      - "Resolve projectId from session.project name via the existing projectsCollection: `const projectIdByName = useMemo(() => Object.fromEntries(projects.map(p => [p.name, p.projectId])), [projects])`. Render the icon-button only when `projectIdByName[session.project]` is non-null."
      - "aria-label: `Open docs for {session.project}`. The icon-button must NOT navigate via the parent SidebarMenuItem's link/onClick (use stopPropagation on the click handler)."
      - "Visual: opacity 60% on hover only (subtle), 100% on focus, kept tight to the project name text. Match the existing 'visibility badge' affordance position pattern in the same component."
    test_cases:
      - "Manual: a session card whose project has a populated projects.projectId shows the small Open Docs icon; clicking it navigates to the docs route, NOT to the session"
      - "Manual: a session card whose project has projects.projectId=NULL (e.g., gateway hasn't synced yet) does NOT render the icon"
      - "Manual: tabbing through the sidebar with keyboard reaches the icon-button as a focusable element"
      - "vitest (component): rendering NavSessions with a session whose project has projectId='abc' and another whose project has projectId=null: only the first session renders the icon"
  - id: p6
    name: "Verification harness + manual smoke checklist + spec sign-off"
    tasks:
      - "Write `scripts/verify/gh122-vp-happy-path-e2e.sh` — bash harness running against a fresh dev environment. Steps: (1) `pnpm verify/dev-up.sh` brings up orch + gateway; (2) wait for first gateway sync (poll GET /api/projects until count > 0 or 60s timeout); (3) curl `wrangler d1 execute --command='SELECT projectId FROM projects WHERE name=?'` to capture a known project's projectId; (4) sign in as the seeded admin user — POST `/api/auth/sign-in/email` with `{ email, password }` from `.env.test-users.prod` (per MEMORY.md); capture the `Set-Cookie` header into a cookies.txt file (curl --cookie-jar) for re-use; check existing scripts under `scripts/verify/*.sh` for the established sign-in pattern (e.g., the GH#27 ship-gate harness if present, or `scripts/verify/dev-up.sh`'s post-bootstrap auth probe); (5) cookie-authed GET /projects (HTML page) using `--cookie cookies.txt` — assert HTTP 200; (6) cookie-authed POST /api/projects/:projectId/claim — assert 200 + ownerId set; (7) cookie-authed GET /api/projects/:projectId/docs-files — assert 200 (file list or empty array if docs worktree not yet configured); (8) cookie-authed GET /projects/:projectId/docs (HTML page) — assert 200. Exit 0 on all-pass, non-zero with descriptive log on any fail."
      - "Document the manual smoke checklist below in the spec's 'Verification Plan / Manual Checks' section (already in this spec — operator runs it once after deploy)."
      - "Add label hooks: `gh issue edit 122 --add-label 'needs-spec'` (handled by /kata-spec-writing methodology)."
    test_cases:
      - "scripts/verify/gh122-vp-happy-path-e2e.sh exits 0 on a fresh dev environment with at least one project synced"
      - "scripts/verify/gh122-vp-happy-path-e2e.sh exits non-zero with a clear error message when the orch is down (negative test for the harness itself)"
verification_plan:
  - id: vp-happy-path-e2e
    script: scripts/verify/gh122-vp-happy-path-e2e.sh
    description: "End-to-end: fresh user signs in, navigates to /projects, claims a project, opens its docs route. Sole automated VP per interview F1; auth/atomicity/backfill checks are covered by per-phase vitest tests in P1, P2, P3a, P3b."
---

# Per-project setup + docs entry point

> **Headline reframe (interview).** GH#27's docs route, BlockNote
> editor, and B19 first-run docs-worktree modal are **already shipped**
> (PR #121, commit `aa4d472`, all 7 verification harnesses pass). The
> ship-blocker is that no user can reach `/projects/:projectId/docs`
> because (a) there is no `/projects` page or sidebar entry, (b)
> `projects` ↔ `projectMetadata` aren't transactionally linked, and
> (c) all four `/api/projects/:projectId*` routes accept any authed
> user (or any `DOCS_RUNNER_SECRET` bearer) without an ownership check.
>
> Cross-references: research at
> `planning/research/2026-04-29-gh122-projects-docs-entry-point.md`
> (current-state map, every claim file:line-cited, ACL pattern survey).
> Locked decisions at
> `planning/research/2026-04-29-gh122-interview-summary.md` (groups A-F,
> four architectural bets, five open risks).

## Overview

Add a user-facing `/projects` page (with sidebar entry) that lists every
visible project and exposes per-project **Open Sessions** + **Open Docs**
buttons; introduce a `Pattern B` (owner + collaborators with role enum)
ACL backed by a new `project_members` table — **but only the `owner`
role gets a UI in v1**, with `editor` and `viewer` reserved as schema
slots for a follow-up issue. Tighten the four currently-permissive
`/api/projects/:projectId*` routes onto an owner-or-admin gate, with
`DOCS_RUNNER_SECRET` bearer continuing to bypass for the docs-runner's
own infra path. Make the gateway sync handler the single source of
truth for `projectId` derivation, written atomically with
`projectMetadata` in one D1 transaction; drop the gateway's parallel
per-project PATCH.

## Goals

- **A `/projects` page** (`/routes/_authenticated/projects.tsx`) with a sidebar entry between Sessions and Board, listing visibility-filtered project cards.
- **A working "Open Docs" entry point** from both the new project card AND existing session cards (conditional on `projects.projectId` being populated).
- **Atomic `projects` ↔ `projectMetadata` linkage:** orchestrator sync handler derives `projectId = sha256(repo_origin).slice(0,16)` and dual-writes both tables in a single D1 transaction. Gateway's parallel `registerProjectWithOrchestrator()` PATCH is dropped.
- **Pattern B ACL schema** (`project_members(projectId, userId, role)` with single-owner partial unique index) — owner role populated via claim/transfer; editor/viewer roles are schema-only in v1.
- **Owner-or-admin gate** on PATCH /api/projects/:projectId, GET /api/projects/:projectId, GET /api/projects/:projectId/docs-files, and GET /api/docs-runners/:projectId/health. Bearer (DOCS_RUNNER_SECRET) bypasses on all four.
- **Ownership lifecycle:** admin-only `[Claim]` for null-owner projects; owner-or-admin `[Transfer ownership]`. No editor/viewer add-via-UI in v1.
- **Backfill:** post-migration script populates `projects.projectId` for rows whose `project_metadata.originUrl` already exists; remaining rows fill in on next 30s gateway sync.

## Non-Goals

- **No editor/viewer add-via-UI in v1.** The `project_members.role` enum and constraints exist; only `owner` rows are created. Per-project member-management page (invite editor, manage roles, audit log) is a follow-up. (interview D1, OR-2)
- **No GitHub-owner-match for first owner.** Deferred to post-GH#22 (no GitHub OAuth, no `users.githubLogin`, no octokit in tree per `docs/integrations/github.md`). v1 ships `ownerId = NULL` on sync; admin claims. A follow-up migration retroactively populates ownerId once GH#22 lands. (interview B2, OR-3)
- **No add-project UI.** Gateway already discovers every clone in `/data/projects/*` on its 30s sweep. Operator adds via `scripts/setup-clone.sh`; project appears in /projects within ≤30s. (interview C3)
- **No `/api/projects/derive-id?originUrl=...` endpoint.** No UI surface needs to preview a projectId in v1. (interview C4)
- **No multiple docs worktrees per project.** `projectMetadata.docsWorktreePath` stays a single nullable path string. Per-arc docs override is a future GH#115 add-on. (interview C1, E1)
- **No `projectMetadata.visibility` column.** Reuse existing admin-managed `projects.visibility`. (interview B3)
- **No copyable projectId badge / no slug-based URL rewrite.** ProjectId stays URL-only (already in `/projects/:projectId/docs`). (interview C2)
- **No migration of `agent_sessions.project` to projectId.** Keep name string; add `getProjectIdByName()` join helper. (interview A3)
- **No automated VP coverage of auth, atomic dual-write, or migration backfill.** Per-phase vitest tests in P1, P2, P3a, P3b cover them; the sole shipped automated VP is the happy-path E2E. (interview F1, OR-1)

## Feature Behaviors

### B-SCHEMA-1: `projects.projectId` column + index

**Core:**
- **ID:** projects-project-id-column
- **Trigger:** Migration 0032 runs.
- **Expected:** `projects` gains `projectId TEXT NULL`. Partial index `idx_projects_project_id ON projects(projectId) WHERE projectId IS NOT NULL` for fast name→projectId lookups (used by B-UI-7).
- **Verify:** `PRAGMA table_info(projects)` lists projectId; `SELECT count(*) FROM sqlite_master WHERE name='idx_projects_project_id' = 1`.
- **Source:** `apps/orchestrator/src/db/schema.ts:286-293` (add column to `projects`); migration `apps/orchestrator/migrations/0032_projects_ownership.sql`.

**Data Layer:**
- Nullable so the column can land before backfill (B-BACKFILL-1) populates it.

### B-SCHEMA-2: `project_metadata.ownerId` column

**Core:**
- **ID:** project-metadata-owner-id
- **Trigger:** Migration 0032.
- **Expected:** `project_metadata` gains `ownerId TEXT NULL REFERENCES users(id) ON DELETE SET NULL`. Default NULL — projects discovered by the gateway are unowned until claimed (B-LIFECYCLE-1).
- **Verify:** `PRAGMA table_info(project_metadata)` lists ownerId; `PRAGMA foreign_key_list(project_metadata)` includes the FK to users.
- **Source:** `apps/orchestrator/src/db/schema.ts:389-397`; same migration.

**Data Layer:**
- `ON DELETE SET NULL` — if a user is deleted, their owned projects revert to unowned (admin can re-claim) rather than cascading and losing the docs metadata.

### B-SCHEMA-3: `project_members` table with single-owner partial unique index

**Core:**
- **ID:** project-members-table
- **Trigger:** Migration 0032.
- **Expected:** New table:
  ```sql
  CREATE TABLE project_members (
    project_id TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    role       TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
    added_at   TEXT NOT NULL,
    added_by   TEXT,
    PRIMARY KEY (project_id, user_id),
    FOREIGN KEY (project_id) REFERENCES project_metadata(projectId) ON DELETE CASCADE,
    FOREIGN KEY (user_id)    REFERENCES users(id)                  ON DELETE CASCADE
  );
  CREATE UNIQUE INDEX project_members_one_owner
    ON project_members(project_id) WHERE role='owner';
  CREATE INDEX idx_project_members_user
    ON project_members(user_id);
  ```
- **Verify:** Inserting two `owner` rows for the same project_id raises a UNIQUE constraint error. Inserting an invalid role raises a CHECK constraint error. Cascading delete: deleting a `users` row removes their project_members rows.
- **Source:** New table in `apps/orchestrator/src/db/schema.ts`; migration 0032.

**Data Layer:**
- `editor` and `viewer` rows are reserved schema slots — no v1 code path inserts them. Spec is OK with the constraints existing without exercise; B-AUTH-1 reads the role enum, so the schema is read-tested even before write paths land.
- **Drizzle schema declaration** (canonical column naming for the implementer — the SQL DDL above uses `snake_case` per project convention; the Drizzle TS layer maps to `camelCase` keys):
  ```ts
  // apps/orchestrator/src/db/schema.ts (NEW table export)
  export const projectMembers = sqliteTable('project_members', {
    projectId: text('project_id').notNull()
      .references(() => projectMetadata.projectId, { onDelete: 'cascade' }),
    userId: text('user_id').notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['owner', 'editor', 'viewer'] }).notNull(),
    addedAt: text('added_at').notNull(),
    addedBy: text('added_by'),
  }, (t) => ({
    pk: primaryKey({ columns: [t.projectId, t.userId] }),
  }))
  ```
  Note: the partial unique index `project_members_one_owner` is declared in the migration SQL; Drizzle's table-builder doesn't currently emit `WHERE` clauses on indexes, so it lives in the hand-written `0032_projects_ownership.sql`. The schema.ts file should NOT attempt to declare it via `index().on(...)`.

### B-BACKFILL-1: Post-migration backfill of `projects.projectId`

**Core:**
- **ID:** backfill-project-ids-script
- **Trigger:** Operator runs `pnpm backfill:project-ids` after migration 0032 applies.
- **Expected:** Script reads every `project_metadata` row with non-null `originUrl`, computes `projectId = await deriveProjectId(originUrl)`, UPDATEs `projects.projectId` for matching `projects.name = project_metadata.projectName`. Idempotent: second run is a no-op for already-populated rows. Projects with no matching `project_metadata` row stay `projectId = NULL` until next gateway sync (within 30s).
- **Verify:** Apply migration on a fixture with: (a) 2 projects + 2 matching project_metadata rows with originUrl → script populates 2 projectIds. (b) 1 project without matching project_metadata → script leaves projectId NULL; next sync via B-SYNC-2 populates it.
- **Source:** `scripts/backfill-project-ids.ts` (new); imports `deriveProjectId` from `@duraclaw/shared-types/entity-id`.

### B-SYNC-1: Sync handler derives projectId per row

**Core:**
- **ID:** sync-handler-derives-project-id
- **Trigger:** `POST /api/gateway/projects/sync` from gateway (every 30s; auth via `CC_GATEWAY_SECRET` bearer).
- **Expected:** For each project in the payload, if `repo_origin` is non-null, compute `projectId = await deriveProjectId(p.repo_origin)`. The handler now owns derivation; the gateway no longer derives or PATCHes per-project metadata.
- **Verify:** vitest unit test on the handler with a fixture payload; assert each output row has the expected projectId from `sha256(originUrl).slice(0,16)`.
- **Source:** `apps/orchestrator/src/api/index.ts:714-750`.

### B-SYNC-2: Atomic dual-write in single D1 transaction

**Core:**
- **ID:** sync-atomic-dual-write
- **Trigger:** Same handler as B-SYNC-1.
- **Expected:** Inside `db.transaction(async (trx) => { ... })`: upsert each `projects` row (now with projectId column) AND upsert the corresponding `project_metadata` row (set projectName, originUrl, updatedAt; do NOT touch ownerId). Failure mid-batch rolls back the entire transaction — neither table commits.
- **Verify:** vitest spec mocks the second upsert to throw; assert pre-call SELECT count(*) FROM projects + post-call SELECT count(*) are equal (no partial commit).
- **Source:** Same handler as B-SYNC-1.

**API Layer:**
- POST /api/gateway/projects/sync request shape unchanged (still `{ projects: ProjectInfo[] }`). Auth unchanged (CC_GATEWAY_SECRET bearer). Response unchanged (204).

### B-SYNC-3: Drop gateway's per-project PATCH

**Core:**
- **ID:** drop-gateway-per-project-patch
- **Trigger:** Code change.
- **Expected:** `packages/agent-gateway/src/projects.ts:265-308` (`registerProjectWithOrchestrator()` function and its caller) deleted. The gateway's discovery loop no longer fires per-project PATCHes; it sends only the bulk `POST /sessions/start`-time sweep payload.
- **Verify:** `grep -rn 'registerProjectWithOrchestrator' packages/ apps/` returns zero hits. Manual: gateway log on startup shows no per-project PATCH log lines; bulk sync log line still appears.
- **Source:** `packages/agent-gateway/src/projects.ts:265-308`.

### B-AUTH-1: `requireProjectMember` middleware

**Core:**
- **ID:** require-project-member-middleware
- **Trigger:** Middleware factory called on a Hono route.
- **Expected:** `requireProjectMember(minRole: 'owner' | 'editor' | 'viewer')` returns a middleware that: (a) if request was bearer-authed via DOCS_RUNNER_SECRET → next() (B-AUTH-6 bypass); (b) if `c.get('role') === 'admin'` → next() (admin override); (c) else SELECT role FROM project_members WHERE project_id=? AND user_id=?; if missing → 403; if rank(role) < rank(minRole) → 403; else next(). Rank: owner=3, editor=2, viewer=1.
- **Verify:** vitest matrix per (caller-role × minRole × bearer-or-not) per `requireProjectMember` test suite — all combinations enumerated in P3a test_cases.
- **Source:** New file `apps/orchestrator/src/api/middleware/require-project-member.ts`.

### B-AUTH-2 to B-AUTH-5: Wire `requireProjectMember` onto 4 routes

**Core:**
- **ID:** wire-require-project-member
- **Trigger:** Each of the 4 routes is hit.
- **Expected:**
  - PATCH /api/projects/:projectId — `requireProjectMember('owner')`. Editors don't change settings (interview B7).
  - GET /api/projects/:projectId — `requireProjectMember('viewer')`.
  - GET /api/projects/:projectId/docs-files — `requireProjectMember('viewer')`. Removes the TODO at `api/index.ts:2272`.
  - GET /api/docs-runners/:projectId/health — `requireProjectMember('viewer')`.
- **Verify:** vitest per route × per role × cookie-vs-bearer matrix (P3a test_cases).
- **Source:** `apps/orchestrator/src/api/index.ts:1169` (PATCH), `:1270` (GET), `:2266` (docs-files), `:2346` (health).

**API Layer:**
- 403 response shape: `{ error: 'forbidden', reason: 'not-a-project-member' | 'insufficient-role', requiredRole: minRole, actualRole: role | null }`.

### B-AUTH-6: DOCS_RUNNER_SECRET bearer bypasses owner check

**Core:**
- **ID:** bearer-bypass-owner-check
- **Trigger:** Request to a `requireProjectMember`-gated route with `Authorization: Bearer <DOCS_RUNNER_SECRET>`.
- **Expected:** Bypasses the project_members lookup entirely; calls `next()` after the bearer-auth flag is set in `projectMetadataAuth`. The runner is infra-level and is not modeled as a user.
- **Verify:** vitest: bearer request to PATCH /api/projects/<random-id> succeeds even though no project_members row exists for any user; same on GET routes.
- **Source:** Existing `projectMetadataAuth` (`api/index.ts:1145-1167`) is refactored to set a context flag; new middleware reads the flag.

### B-LIFECYCLE-1: `POST /api/projects/:projectId/claim` (admin-only)

**Core:**
- **ID:** project-ownership-claim
- **Trigger:** Admin clicks `[Claim]` on a null-owner project card OR cookie-authed POST to the endpoint.
- **Expected:** Auth: cookie session AND `c.get('role') === 'admin'`. Else 403. Body: empty (claimer = the authed user). Inside a single D1 transaction: UPDATE project_metadata SET ownerId=:userId WHERE projectId=? AND ownerId IS NULL (atomic guard against double-claim race); INSERT INTO project_members (project_id, user_id, role, added_at, added_by) VALUES (?, :userId, 'owner', now-iso8601, :userId). If UPDATE affects 0 rows → 409 (already owned). On success: broadcastSyncedDelta('projects', [{type:'update', value: updatedProjectInfo}]) so connected UIs reflect the change.
- **Broadcast fanout policy:** Mirror the existing project-broadcast pattern at `api/index.ts:710-730` and `:2236` — fan out to **all userPresence-active users** (not just admins, not just project members). Rationale: (a) all users see this project on their /projects list (subject to the client-side visibility filter), so all open clients need the updated `ownerId` to render the new ownership status; (b) the client-side visibility filter (B-UI-1) already hides private projects from non-owners non-admins, so leaking ownership of a private project's name to a connected non-member is identical to the leak that already exists today via the projectsCollection sync. No new disclosure surface introduced. (c) Limiting fanout to "members + admins" would require a per-user filtered broadcast, which the existing `broadcastSyncedDelta` does not support — out of scope.
- **Verify:** vitest: admin POST /api/projects/<id>/claim on null-owner project → 200 + project_metadata.ownerId set + project_members row inserted with role='owner'; second admin's claim → 409 (already owned); non-admin claim → 403.
- **Source:** New endpoint in `apps/orchestrator/src/api/index.ts` (placement near other admin endpoints, e.g. after `:2193`).

**API Layer:**
- POST /api/projects/:projectId/claim →
  - 200 `{ ok: true, ownerId, claimedAt }`
  - 400 `{ error: 'bad_request' }` (bad projectId format)
  - 401 `{ error: 'unauthorized' }` (no session cookie)
  - 403 `{ error: 'forbidden', reason: 'admin-required' }` — note: this is the inline admin check shape, NOT the `requireProjectMember` 403 shape. Claim does not go through `requireProjectMember` (it's a state-change for null-owner projects, not a per-member-role gate).
  - 409 `{ error: 'already_owned' }` (race lost — UPDATE matched 0 rows because another claim won)

### B-LIFECYCLE-2: `POST /api/projects/:projectId/transfer` (owner-or-admin)

**Core:**
- **ID:** project-ownership-transfer
- **Trigger:** Owner or admin clicks `[Transfer ownership]`; submits new owner from picker.
- **Expected:** Auth: `requireProjectMember('owner')` (admin override is automatic). Body: `{ newOwnerUserId: string }`. Inside a single D1 transaction:
  1. Validate `newOwnerUserId` exists in `users` (else 400).
  2. Validate `newOwnerUserId` is not already the current owner (else 409 — no-op transfer is rejected to avoid silently swallowing UI mistakes).
  3. UPDATE `project_metadata` SET `ownerId=:newOwnerUserId` WHERE `projectId=?`.
  4. **DELETE** the existing owner row from `project_members` WHERE `project_id=? AND role='owner'`, then **INSERT** a new row `(project_id, :newOwnerUserId, 'owner', now-iso8601, :callerUserId)`. The DELETE+INSERT pattern is used instead of UPDATE because `user_id` is part of the composite PK `(project_id, user_id)` — Drizzle's `.update()` does not support PK column mutation cleanly across all SQLite drivers, and DELETE+INSERT is unambiguous and survives schema-driver quirks.
  5. The partial unique index `project_members_one_owner` enforces correctness — even if a malformed concurrent transaction somehow inserted a second owner row, the index would reject it before commit.
  On success: broadcastSyncedDelta same as claim (see B-LIFECYCLE-1 fanout note).
- **Verify:** vitest: owner POST /api/projects/<id>/transfer with valid newOwnerUserId → 200 + ownerId migrated + project_members owner-row migrated (old row deleted, new row inserted); transfer to nonexistent userId → 400; transfer to current owner → 409; transfer by non-member → 403; transfer by admin (not owner) → 200.
- **Source:** New endpoint in `apps/orchestrator/src/api/index.ts`.

**API Layer:**
- POST /api/projects/:projectId/transfer →
  - 200 `{ ok: true, ownerId, transferredAt }`
  - 400 `{ error: 'bad_request', reason: 'unknown-user' | 'invalid-projectid' }`
  - 401 `{ error: 'unauthorized' }`
  - 403 `{ error: 'forbidden', reason: 'not-a-project-member' | 'insufficient-role', requiredRole: 'owner', actualRole: ... }` (from `requireProjectMember`)
  - 409 `{ error: 'no_op', reason: 'already-owner' }`

### B-UI-1: `/projects` route + visibility-aware list

**Core:**
- **ID:** projects-route-page
- **Trigger:** User navigates to `/projects`.
- **Expected:** TanStack Router file route at `routes/_authenticated/projects.tsx` renders the ProjectsPage. Uses `useLiveQuery(projectsCollection)` (existing). Visibility filter: non-admin non-owner users do NOT see private projects (filter applied client-side over the synced collection; server-side filtering not required because the collection is already user-scoped via the existing visibility broadcast logic).
- **Verify:** Manual: as admin, see all projects. As non-admin user without ownership, see only `visibility='public'` projects + any project where they are the owner. As owner of a private project, see that project.
- **Source:** New file `apps/orchestrator/src/routes/_authenticated/projects.tsx`.

**UI Layer:**
- Empty state: `No projects discovered yet — the gateway syncs every 30s.`
- Loading state: 3 skeleton cards.
- Layout: responsive grid (1 col mobile, 2 cols tablet, 3 cols desktop) using existing Tailwind tokens.

### B-UI-2: ProjectCard composition

**Core:**
- **ID:** project-card-component
- **Trigger:** Each project rendered on `/projects`.
- **Expected:** Card shows: project name (large monospace), displayName (subtitle, smaller), `[Open Sessions]` button (links to existing session-filter URL), `[Open Docs]` button (links to `/projects/$projectId/docs` if projectId non-null; disabled with tooltip otherwise), VisibilityBadge (existing) if not 'public', ownership-status block per current viewer's role.
- **Verify:** Manual: card renders all elements per the screenshot below; Open Docs disabled when projectId is null.
- **Source:** New `apps/orchestrator/src/components/projects/ProjectCard.tsx`.

**UI Layer:**
```
┌── duraclaw ─────────────────────┐
│  Duraclaw · main         [Owner: Ben] │
│                                       │
│  [Open Sessions]   [Open Docs]        │
└───────────────────────────────────────┘

┌── unclaimed-repo ────────────────┐
│  Unclaimed Repo · main   [⚠ Private] │
│                          [Claim]      │
│  [Open Sessions]   [Open Docs]        │
└───────────────────────────────────────┘
```

### B-UI-3: Sidebar nav entry

**Core:**
- **ID:** sidebar-projects-entry
- **Trigger:** Sidebar renders on any authenticated route.
- **Expected:** New General-group entry between Sessions and Board: title 'Projects', url '/projects', icon `LayoutGrid` (lucide-react).
- **Verify:** Manual: sidebar shows Sessions → Projects → Board → Settings on all auth routes.
- **Source:** `apps/orchestrator/src/components/layout/sidebar-data.ts:4-27`.

### B-UI-4: Claim and Transfer buttons on project card

**Core:**
- **ID:** claim-transfer-buttons
- **Trigger:** Render of a project card.
- **Expected:** `[Claim]` button rendered IFF project.ownerId IS NULL AND currentUserRole === 'admin'. `[Transfer ownership]` button rendered IFF project.ownerId === currentUserId OR currentUserRole === 'admin'. Click-handlers POST to the respective endpoints (B-LIFECYCLE-1, B-LIFECYCLE-2). Optimistic UI updates rely on the broadcastSyncedDelta from the server — no local optimistic state management required.
- **Verify:** Manual: matrix of (isAdmin × isOwner × ownerIdNull) renders the right buttons.
- **Source:** Same component as B-UI-2.

### B-UI-5: Admin override in existing settings ProjectsSection

**Core:**
- **ID:** settings-admin-reassign
- **Trigger:** Admin views `/settings`'s ProjectsSection.
- **Expected:** New 'Owner' column appears in the projects list. Each row gets a `[Reassign]` button that opens the same transfer Dialog from B-UI-4. Admins can reassign even when not the current owner (B-LIFECYCLE-2 already permits this via `requireProjectMember('owner')` + admin override).
- **Verify:** Manual: as admin, settings ProjectsSection shows Owner column; click Reassign on any project; submit dialog → project's ownerId updates in real time via the synced collection delta.
- **Source:** `apps/orchestrator/src/routes/_authenticated/settings.tsx:380-474`.

### B-UI-6: Session-card "Open Docs" link

**Core:**
- **ID:** session-card-open-docs-link
- **Trigger:** A SidebarMenuItem session card renders.
- **Expected:** Conditional small icon-button (FileTextIcon, size 3.5) rendered next to `session.project` text, ONLY when `projectsCollection` has the matching project AND its `projectId` is non-null. Clicking navigates to `/projects/$projectId/docs` with `params: { projectId }`. Click handler uses `e.stopPropagation()` so the parent SidebarMenuItem's session-navigation isn't triggered. aria-label: `Open docs for {session.project}`.
- **Verify:** Manual: a session whose project has projectId renders the icon; one without does not.
- **Source:** `apps/orchestrator/src/components/layout/nav-sessions.tsx:476-540`.

### B-UI-7: `getProjectIdByName` join helper

**Core:**
- **ID:** get-project-id-by-name-helper
- **Trigger:** Server-side code needs to convert a session.project name into a projectId.
- **Expected:** New helper `getProjectIdByName(db, name): Promise<string | null>` in `apps/orchestrator/src/lib/projects.ts` (new file). Single SELECT projectId FROM projects WHERE name=? ORDER BY updatedAt DESC LIMIT 1. Returns null if name unknown OR projectId is null.
- **Verify:** vitest: helper returns the matching projectId; returns null on unknown name.
- **Source:** New file `apps/orchestrator/src/lib/projects.ts`.

**Notes:**
- Client-side equivalent is the inline `useMemo` in B-UI-6's component code; no server fetch needed because the client already has projectsCollection.

### B-HELPER-2: `projectInfoFromMeta` broadcast-payload helper

**Core:**
- **ID:** project-info-from-meta-helper
- **Trigger:** Claim (B-LIFECYCLE-1) and transfer (B-LIFECYCLE-2) endpoints construct a `ProjectInfo` payload for `broadcastSyncedDelta` after their D1 transactions commit.
- **Expected:** New helper `projectInfoFromMeta(env: Env, projectId: string): Promise<ProjectInfo>` in `apps/orchestrator/src/lib/projects.ts` (alongside `getProjectIdByName` per B-UI-7). Performs a LEFT JOIN: `SELECT projects.name, projects.displayName, projects.rootPath, projects.visibility, projects.updatedAt, projects.deletedAt, project_metadata.ownerId, project_metadata.docsWorktreePath FROM projects LEFT JOIN project_metadata ON projects.projectId = project_metadata.projectId WHERE projects.projectId = ?`. Returns the `ProjectInfo` shape that the sync handler already emits (see `db/projects-collection.ts` + `shared-types/src/index.ts` for the canonical schema). If the row doesn't exist → throws (caller's responsibility to ensure the projectId is valid).
- **Verify:** vitest: insert a fixture (projects + project_metadata + project_members owner row), call `projectInfoFromMeta(env, projectId)`, assert the returned object has `{ name, displayName, ownerId, visibility, ... }` with the inserted values; assert the helper throws on a nonexistent projectId.
- **Source:** New helper in `apps/orchestrator/src/lib/projects.ts`.

### B-API-1: `GET /api/users/picker` lightweight user-list endpoint

**Core:**
- **ID:** users-picker-endpoint
- **Trigger:** Non-admin owner opens the Transfer-ownership dialog and the dialog needs a list of candidate users to pick from.
- **Expected:** New endpoint `GET /api/users/picker`. Auth: any cookie-authed user (no admin gate). Returns `200 [{ id, displayName, email }]` ordered by `displayName ASC`, capped at 200 rows. The exposed fields (displayName, email) are already broadcast across userPresence-driven channels, so this endpoint introduces no new disclosure. Returns `401 { error: 'unauthorized' }` if no session.
- **Verify:** vitest: GET /api/users/picker authed → 200 with array; without session → 401; on a fixture with 250 users, response array length is exactly 200 sorted by displayName.
- **Source:** New endpoint in `apps/orchestrator/src/api/index.ts`.

**API Layer:**
- GET /api/users/picker →
  - 200 `[{ id: string, displayName: string | null, email: string }]` (sorted, capped at 200)
  - 401 `{ error: 'unauthorized' }`

## Verification Plan

### Automated VPs

| ID | Script | Description |
|----|--------|-------------|
| **vp-happy-path-e2e** | `scripts/verify/gh122-vp-happy-path-e2e.sh` | End-to-end: fresh user signs in → /projects loads → claims a project → opens its docs. Sole automated VP per interview F1. |

### Per-phase vitest tests (NOT in `verification_plan` frontmatter; covered by phase test_cases above)

- **P1:** migration shape + backfill script smoke (idempotent).
- **P2:** sync handler atomic dual-write (positive + transaction-failure rollback).
- **P3a:** auth matrix per route × per role × cookie-vs-bearer.
- **P3b:** claim/transfer state machine + broadcast fanout.
- **P5:** session-card link conditional rendering.

These are deliberately not promoted to top-level VPs per interview F1 (user explicitly selected only the happy-path E2E for the automated verification plan).

### Manual smoke checklist (operator runs once after first deploy)

1. **Migration applied:** `wrangler d1 execute <db> --command="PRAGMA table_info(projects)"` includes `projectId`. `PRAGMA table_info(project_metadata)` includes `ownerId`. `PRAGMA table_info(project_members)` lists 5 columns.
2. **Backfill ran:** `pnpm backfill:project-ids` (run once, manually). Then `wrangler d1 execute --command="SELECT count(*) FROM projects WHERE projectId IS NOT NULL"` matches the count of project_metadata rows with non-null originUrl.
3. **Gateway sync populates new rows:** Wait ≤30s after backfill. `wrangler d1 execute --command="SELECT count(*) FROM projects WHERE projectId IS NULL"` is 0 (assuming all projects have origins).
4. **/projects loads:** Cookie-auth into the orchestrator UI, navigate to /projects, see at least one project card.
5. **Claim button:** As admin, on a null-owner project, click `[Claim]`. ProjectMetadata.ownerId updates; project_members has a row. Refresh page; admin's name appears as Owner.
6. **Transfer flow:** As owner (or admin), click `[Transfer ownership]`, pick another user, submit. Owner field updates without page refresh (delta propagation).
7. **Open Docs from project card:** Click `[Open Docs]` on a configured project → BlockNote editor loads. Click on an unconfigured project → B19 modal appears.
8. **Open Docs from session card:** A session card's small Open-Docs icon links to the same docs route. Sessions whose project has null projectId have no icon.
9. **Auth gate:** Open the network panel. As non-owner non-admin, attempt `PATCH /api/projects/:projectId` from the browser console → 403. As DOCS_RUNNER_SECRET bearer (use curl from VPS), same PATCH → 200.
10. **Sidebar nav:** Sidebar General group reads Sessions → Projects → Board → Settings.

## Implementation Hints

### Key imports

```ts
// Atomic dual-write in sync handler (B-SYNC-2)
import { deriveProjectId } from '@duraclaw/shared-types/entity-id'
import { projects, projectMetadata } from '~/db/schema'

// requireProjectMember middleware (B-AUTH-1)
import type { MiddlewareHandler } from 'hono'
import { eq, and } from 'drizzle-orm'
import { projectMembers } from '~/db/schema'

// /projects page (B-UI-1)
import { createFileRoute, Link } from '@tanstack/react-router'
import { useLiveQuery } from '@tanstack/react-db'
import { projectsCollection } from '~/db/projects-collection'

// ProjectCard (B-UI-2)
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '~/components/ui/card'
import { Button } from '~/components/ui/button'
import { Badge } from '~/components/ui/badge'
import { VisibilityBadge } from '~/components/visibility-badge'
import { LayoutGrid, FileText } from 'lucide-react'
```

### Code patterns

**Atomic dual-write in sync handler (B-SYNC-2):**

```ts
// apps/orchestrator/src/api/index.ts (replacing the body of the sync upsert loop)
await db.transaction(async (trx) => {
  for (const p of incoming) {
    const projectId = p.repo_origin
      ? await deriveProjectId(p.repo_origin)
      : null

    await trx.insert(projects)
      .values({
        name: p.name,
        rootPath: p.path,
        projectId,
        updatedAt: nowIso(),
        deletedAt: null,
      })
      .onConflictDoUpdate({
        target: projects.name,
        set: {
          rootPath: p.path,
          projectId: projectId ?? sql`${projects.projectId}`,  // don't unset if null
          updatedAt: nowIso(),
          deletedAt: null,
        },
      })

    if (projectId && p.repo_origin) {
      await trx.insert(projectMetadata)
        .values({
          projectId,
          projectName: p.name,
          originUrl: p.repo_origin,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        })
        .onConflictDoUpdate({
          target: projectMetadata.projectId,
          set: {
            projectName: p.name,
            originUrl: p.repo_origin,
            updatedAt: nowIso(),
            // ownerId intentionally omitted from set — preserve existing ownership
          },
        })
    }
  }
})
```

**`requireProjectMember` middleware (B-AUTH-1):**

```ts
// apps/orchestrator/src/api/middleware/require-project-member.ts (NEW)
import type { MiddlewareHandler } from 'hono'
import { and, eq } from 'drizzle-orm'
import { projectMembers } from '~/db/schema'
import { getDb } from '~/db'

const ROLE_RANK = { viewer: 1, editor: 2, owner: 3 } as const
type Role = keyof typeof ROLE_RANK

export function requireProjectMember(minRole: Role): MiddlewareHandler {
  return async (c, next) => {
    if (c.get('bearerAuth')) return next() // B-AUTH-6
    const userId = c.get('userId')
    if (!userId) return c.json({ error: 'unauthorized' }, 401)
    if (c.get('role') === 'admin') return next() // admin override

    const projectId = c.req.param('projectId')
    if (!projectId) return c.json({ error: 'bad_request' }, 400)

    const db = getDb(c.env)
    const row = await db.select({ role: projectMembers.role })
      .from(projectMembers)
      .where(and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, userId),
      ))
      .limit(1)

    if (row.length === 0) {
      return c.json({
        error: 'forbidden',
        reason: 'not-a-project-member',
        requiredRole: minRole,
        actualRole: null,
      }, 403)
    }
    const role = row[0].role as Role
    if (ROLE_RANK[role] < ROLE_RANK[minRole]) {
      return c.json({
        error: 'forbidden',
        reason: 'insufficient-role',
        requiredRole: minRole,
        actualRole: role,
      }, 403)
    }
    return next()
  }
}
```

**Wiring middleware on a route (B-AUTH-2 to B-AUTH-5):**

```ts
// apps/orchestrator/src/api/index.ts
app.patch('/api/projects/:projectId',
  projectMetadataAuth,           // sets c.get('bearerAuth') if DOCS_RUNNER_SECRET
  requireProjectMember('owner'), // B-AUTH-2 + B-AUTH-6 bypass
  async (c) => { /* existing handler body */ },
)

app.get('/api/projects/:projectId/docs-files',
  projectMetadataAuth,
  requireProjectMember('viewer'), // B-AUTH-4 + bearer bypass
  async (c) => { /* existing handler body, TODO at :2272 removed */ },
)
```

**Claim endpoint (B-LIFECYCLE-1):**

```ts
// apps/orchestrator/src/api/index.ts
app.post('/api/projects/:projectId/claim', async (c) => {
  if (c.get('role') !== 'admin') return c.json({ error: 'forbidden' }, 403)
  const userId = c.get('userId')
  const projectId = c.req.param('projectId')
  if (!PROJECT_ID_RE.test(projectId)) return c.json({ error: 'bad_request' }, 400)

  const db = getDb(c.env)
  const result = await db.transaction(async (trx) => {
    const updated = await trx.update(projectMetadata)
      .set({ ownerId: userId, updatedAt: nowIso() })
      .where(and(
        eq(projectMetadata.projectId, projectId),
        isNull(projectMetadata.ownerId),
      ))
      .returning()
    if (updated.length === 0) return null // already-owned race
    await trx.insert(projectMembers).values({
      projectId, userId, role: 'owner',
      addedAt: nowIso(), addedBy: userId,
    })
    return updated[0]
  })
  if (result === null) return c.json({ error: 'already_owned' }, 409)

  // Broadcast delta so connected clients see the new owner.
  // Mirror the existing pattern at api/index.ts:760, :2231 and lib/broadcast-chain.ts:47:
  //   collect all userPresence-active userIds, then fan out one update op.
  c.executionCtx.waitUntil((async () => {
    const presenceRows = await db
      .select({ userId: userPresence.userId })
      .from(userPresence)
    const fanoutUserIds = presenceRows.map(r => r.userId)
    const projectInfo = await projectInfoFromMeta(c.env, projectId)
    await Promise.all(fanoutUserIds.map(uid =>
      broadcastSyncedDelta(c.env, uid, 'projects',
        [{ type: 'update', value: projectInfo }])
    ))
  })().catch(e => console.warn('claim fanout error', e)))

  return c.json({ ok: true, ownerId: userId, claimedAt: result.updatedAt })
})
```

The transfer endpoint (B-LIFECYCLE-2) follows the identical fanout pattern after its DELETE+INSERT transaction commits.

**TanStack Router file route (B-UI-1):**

```ts
// apps/orchestrator/src/routes/_authenticated/projects.tsx (NEW)
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_authenticated/projects')({
  component: ProjectsPage,
})

function ProjectsPage() {
  const { data: projects, isLoading } = useLiveQuery(projectsCollection)
  const userId = useCurrentUserId()
  const role = useCurrentUserRole()

  if (isLoading) return <ProjectsPageSkeleton />
  if (!projects?.length) return <ProjectsEmptyState />

  const visible = projects.filter(p =>
    p.visibility === 'public' || role === 'admin' || p.ownerId === userId
  )

  return (
    <div className='grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 p-4'>
      {visible.map(p => (
        <ProjectCard key={p.name}
          project={p} currentUserId={userId} currentUserRole={role} />
      ))}
    </div>
  )
}
```

**Session-card Open Docs link (B-UI-6):**

```tsx
// apps/orchestrator/src/components/layout/nav-sessions.tsx (inside the SidebarMenuItem)
const projectIdByName = useMemo(
  () => Object.fromEntries(projects.map(p => [p.name, p.projectId])),
  [projects]
)
const projectId = projectIdByName[session.project]
// ... existing card JSX ...
{projectId && (
  <Link to='/projects/$projectId/docs'
        params={{ projectId }}
        aria-label={`Open docs for ${session.project}`}
        onClick={(e) => e.stopPropagation()}
        className='opacity-60 hover:opacity-100 focus:opacity-100'>
    <FileText className='size-3.5' />
  </Link>
)}
```

### Gotchas

- **Drizzle SQLite ALTER TABLE for new columns:** SQLite does NOT support `ALTER TABLE ADD CONSTRAINT`. Adding the FK on `project_metadata.ownerId` works because we add the column WITH the REFERENCES clause inline (`ALTER TABLE project_metadata ADD COLUMN ownerId TEXT NULL REFERENCES users(id) ON DELETE SET NULL`). Same pattern as migration 0027 used for `agent_sessions.worktreeId`.
- **Partial unique index syntax:** D1 supports `CREATE UNIQUE INDEX ... WHERE ...` — confirmed (used elsewhere in our migrations). Verify on a local SQLite copy first.
- **Drizzle's `onConflictDoUpdate` with conditional set:** Don't use `sql\`COALESCE(...)\`` patterns inside `set` — use a JS-side conditional to omit the field entirely when you want to preserve the existing value. Example: `set: { projectId: projectId ?? sql\`${projects.projectId}\` }` works but is brittle; a cleaner pattern is to compute the `set` object conditionally.
- **`broadcastSyncedDelta` user fanout list:** Existing call sites (`api/index.ts:2236`) pass a single userId; the project-broadcast pattern fans out to all userPresence-active users. Re-read `api/index.ts:710-730` for the existing pattern; the claim/transfer endpoints should mirror it.
- **TanStack Router file-route generation:** After adding `routes/_authenticated/projects.tsx`, run `pnpm --filter @duraclaw/orchestrator dev` once to regenerate `routeTree.gen.ts`. Don't hand-edit the generated file.
- **Lucide icon import:** Use `import { LayoutGrid, FileText } from 'lucide-react'` — match the existing import style in sidebar-data.ts and nav-sessions.tsx.
- **Bearer-auth flag must be set before requireProjectMember runs:** Order matters — `projectMetadataAuth` must run FIRST in the middleware chain so `c.get('bearerAuth')` is populated by the time `requireProjectMember` checks it. Document this in the middleware file's leading comment.
- **DOCS_RUNNER_SECRET only set in .dev.vars / wrangler secrets:** The bearer bypass test requires the test fixture to set this env var; vitest's `setupFiles` should populate it from `.env.test` or similar.

### Reference docs

- **TanStack Router file-based routing:** https://tanstack.com/router/latest/docs/framework/react/guide/file-based-routing — useful for confirming file naming convention (`routes/_authenticated/projects.tsx`).
- **TanStack DB useLiveQuery:** https://tanstack.com/db/latest/docs/api/react#uselivequery — return shape and loading/error semantics.
- **Drizzle SQLite ALTER TABLE:** https://orm.drizzle.team/docs/migrations#alter-tables — confirms ADD COLUMN with FK inline.
- **Hono middleware composition:** https://hono.dev/docs/api/hono#use — middleware chain ordering.
- **Spec 27 (docs-runner):** `planning/specs/27-docs-as-yjs-dialback-runners.md` — already-shipped surface this spec exposes; B-IDs B16-B20 documented there.
- **GH#27 verification evidence:** `.kata/verification-evidence/vp-27.json` (gitignored; referenced for the docs-runner's already-passing harnesses).

## Risks (mirroring interview Open Risks)

- **OR-1 (Light VP coverage).** Only happy-path E2E is automated. Auth, atomicity, and backfill checks are per-phase vitest only. Reviewers may push back on this; the spec writer (this doc) and interviewee both signed off. If a reviewer challenges, fall back is to promote the P2 atomicity test and the P3a/P3b auth-matrix + lifecycle tests into top-level VPs.
- **OR-2 (Pattern B with no editor/viewer UI).** `project_members` will only have `owner` rows in v1. The CHECK constraint and partial unique index are tested by P1's migration smoke, but no v1 code path exercises editor/viewer roles. Risk: the schema choices may bite a follow-up if the editor/viewer UI surfaces a need we didn't anticipate (e.g., per-role permissions per resource within a project).
- **OR-3 (GH-owner-match deferred but unscheduled).** Decision B2 punts to post-GH#22. If GH#22 lands without remembering to retroactively populate `ownerId` for unowned projects, those projects stay null-owned forever. **Spec writer's mitigation:** open a "follow-up" issue immediately after this spec lands, titled `feat(projects): retroactive ownerId backfill from GH identity (depends on GH#22)`, and link from this spec.
- **OR-4 (Backfill depends on existing project_metadata.originUrl).** A2's scripted backfill works only for projects whose gateway has already PATCHed project_metadata. Brand-new projects discovered AFTER the migration but BEFORE running the script have `projects.projectId = NULL`. **Mitigation:** B-UI-2's [Open Docs] button is disabled when projectId is null (with tooltip), and B-UI-6's session-card icon doesn't render. The next gateway sync within 30s closes the window via B-SYNC-2.
- **OR-5 (Bearer bypass on docs-files endpoint).** B-AUTH-4 + B-AUTH-6 mean a docs-runner bearer can call `/api/projects/:projectId/docs-files` and get the file list for any project, even private ones. This is intentional (the runner IS the file system). **Threat-model note:** `DOCS_RUNNER_SECRET` is treated as semi-privileged infra; rotating it is a security incident.

## Architectural bets (interview AB-*)

- **AB-1 (Pattern B junction table shape).** Once project_members has rows, migrating to Pattern A or C requires a data migration. The composite PK + partial unique index are reasonable defaults but acknowledge the shape is sticky.
- **AB-2 (Single-owner enforcement).** Switching to multi-owner means dropping the partial unique index — easy schema-wise, but every `[Transfer ownership]` UI assumes single-owner today. UI rewrite needed if multi-owner ever ships.
- **AB-3 (Drop gateway per-project PATCH).** Re-introducing a per-project PATCH path later means re-introducing the race we just fixed. The bulk sync covers everything the per-project PATCH did; revisit only if a future sync model demands per-project granularity.
- **AB-4 (Reuse projects.visibility for docs access).** If the product ever wants user-managed per-project docs visibility, we'd add a `project_metadata.visibility` column anyway and reverse this — additive but a UI rework.
