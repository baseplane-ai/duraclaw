---
date: 2026-04-29
topic: "GH#122 — user-facing per-project setup + docs entry point — P0 codebase research"
type: feature
status: complete
github_issue: 122
items_researched: 7
inputs:
  - planning/specs/27-docs-as-yjs-dialback-runners.md
  - planning/specs/115-worktrees-first-class-resource.md
  - planning/research/2026-04-20-gh27-interview-summary.md
  - planning/research/2026-04-27-gh115-interview-summary.md
related:
  - GH#27 (docs-runner — shipped; route + B19 modal in tree but unreachable)
  - GH#115 (worktree-as-resource — approved spec, not yet shipped)
---

# Research: GH#122 — user-facing per-project setup + docs entry point

## Context

GH#27's docs-runner shipped (PR #121 / commit `aa4d472`). The
`/projects/:projectId/docs` route, the BlockNote editor, and the B19
first-run docs-worktree modal are all in tree and functional — but
**no user can reach them**, because per-project setup is a half-built
skeleton. There is no `/projects` page, no "Open Docs" link anywhere,
and the `projects` ↔ `projectMetadata` identity bridge isn't atomic.

This is feature research scoped to ground-truth the issue body's
claims and resolve where the open decisions can be answered from the
codebase before P1 interview.

## Scope

**Items researched (7 parallel deep-dives):**

| # | Item | Sources |
|---|------|---------|
| A | Project data model (`projects`, `projectMetadata`, `agent_sessions.project`) | `db/schema.ts`, migrations, all reader/writer callsites |
| B | Gateway discovery → `/api/gateway/projects/sync` | `agent-gateway/src/projects.ts,server.ts`, sync handler |
| C | `/api/projects/:projectId*` routes + auth patterns + ACL precedent | `api/index.ts`, Better Auth integration, owner-or-admin patterns |
| D | Docs UI — route, B19 modal, BlockNote mount, awareness | `routes/_authenticated/projects.$projectId.docs.tsx`, `components/docs/*` |
| E | Existing project + session UI surfaces, sync collection, sidebar | `routes/_authenticated/settings.tsx`, `components/layout/*`, `db/projects-collection.ts` |
| F | GH#27 + GH#115 spec context, overlap, coordination | `planning/specs/27-*.md`, `planning/specs/115-*.md` |
| G | Web research — multi-tenant project ACL patterns | GitHub, Linear, Sentry, OpenFGA docs |

## Findings

### A. Project data model

- **`projects`** (`db/schema.ts:286–293`) — keyed by `name`. Columns:
  `name PK`, `displayName`, `rootPath`, `updatedAt`, `deletedAt`,
  `visibility` (default `'public'`). No `projectId` column today.
- **`projectMetadata`** (`db/schema.ts:389–397`) — keyed by 16-hex
  `projectId`. Columns: `projectId PK`, `projectName`, `originUrl`,
  `docsWorktreePath`, `tombstoneGraceDays`, `createdAt`, `updatedAt`.
  **No `ownerId`, no `visibility`** — cannot do per-project ACL at
  the DB layer without a schema change.
- **`agent_sessions.project`** (`db/schema.ts:134`) — TEXT, stores
  project **name** string, indexed `(userId, project)`, no FK.
- **No FK** between `projects` and `projectMetadata`. They are two
  parallel identity systems.
- **Latest migration touching either:** `0026_project_metadata.sql`
  (created `projectMetadata`). Latest migration overall: `0031`
  (worktrees-first-class — for GH#115; does not touch these tables).
- **Backfill blockers:** None. Both tables tolerate insert-on-first-
  access; gateway re-syncs every 30s, so a nullable `projectId` column
  on `projects` would populate naturally without a scripted backfill.

### B. Gateway discovery → sync handler

- **Discovery cadence:** every `PROJECT_SYNC_INTERVAL_MS` (default
  30s), plus on startup. Gated on `WORKER_PUBLIC_URL` +
  `CC_GATEWAY_SECRET` both being set
  (`agent-gateway/src/server.ts:512–521`).
- **`repo_origin` is already in the sync payload**
  (`agent-gateway/src/projects.ts:47, 325, 339`) — no payload change
  needed to derive projectId orch-side.
- **`deriveProjectId` already exists**
  (`packages/shared-types/src/entity-id.ts:45–47`):
  `sha256(originUrl).slice(0,16)`.
- **Two parallel write paths** to `projectMetadata`:
  1. Bulk `POST /api/gateway/projects/sync` (handler at
     `api/index.ts:714–750`) — currently writes only `projects`.
  2. Per-project `PATCH /api/projects/:projectId` from
     `registerProjectWithOrchestrator()`
     (`agent-gateway/src/projects.ts:265–308`, fire-and-forget) —
     writes `projectMetadata`.
  These are not transactionally linked; either can race the other.
- **D1 transactions** are supported via Drizzle (`db.transaction()`),
  so an atomic dual-write in the bulk sync handler is feasible with
  no infra change.
- **Test coverage** exists for sync handler at
  `apps/orchestrator/src/api/gateway/projects/sync.test.ts` (auth,
  upsert, soft-delete, fanout, chunking) — no projectId / dual-write
  coverage yet.

### C. `/api/projects/:projectId*` routes + auth

- **Four routes match `/api/projects/:projectId*`:**
  | Method | Path | Handler | Auth | Issue |
  |---|---|---|---|---|
  | PATCH | `/api/projects/:projectId` | `api/index.ts:1169` | `projectMetadataAuth` | **No ownership check — any authed user can rewrite anyone's `docsWorktreePath`** |
  | GET | `/api/projects/:projectId` | `api/index.ts:1270` | `projectMetadataAuth` | Same |
  | GET | `/api/projects/:projectId/docs-files` | `api/index.ts:2266` | **None** | Explicit TODO at line 2272 — any authed user can enumerate any project's files |
  | GET | `/api/docs-runners/:projectId/health` | `api/index.ts:2346` | **None** | Same |

- **`projectMetadataAuth`** (`api/index.ts:1145–1167`) accepts cookie
  OR `Authorization: Bearer ${DOCS_RUNNER_SECRET}` (timing-safe). No
  ownership predicate.
- **`PROJECT_ID_RE`** (`api/index.ts:1143`) = `/^[0-9a-f]{16}$/`.
- **Owner-or-admin precedent (re-use this exactly):**
  - `getAccessibleSession` (`api/index.ts:264–284`):
    `isOwner = row.userId === userId; isAdmin = role === 'admin';
    if (!isOwner && !isPublic && !isAdmin) return 404`.
  - `buildSessionScope` (`api/index.ts:246–250`).
  - Worktree release (`api/index.ts:2598`):
    `row.ownerId === userId || role === 'admin'`.
- **Admin model:** `users.role` column (`db/schema.ts:40`),
  values `'user' | 'admin'`. Extracted via `c.get('role')`.
- **Visibility column on `projects`** is admin-managed via
  `PATCH /api/projects/:name/visibility` (`api/index.ts:2193–2243`)
  — admin-only. Default `'public'`. Used to filter what non-admins
  see in collections.

### D. Docs UI — route + B19 modal

- **Route file:** `routes/_authenticated/projects.$projectId.docs.tsx`
  (295 lines) — already shipped. Auto-opens `DocsWorktreeSetup`
  modal on 404 from `/api/projects/:projectId/docs-files`.
- **`DocsWorktreeSetup`** (`components/docs/DocsWorktreeSetup.tsx`,
  206 lines) — already shipped. POSTs `PATCH /api/projects/:projectId`
  with `{ docsWorktreePath: "/abs/path" }`.
- **BlockNote editor** (`components/docs/DocsEditor.tsx`) — needs
  `entityId = sha256(projectId + ':' + relPath).slice(0,16)`,
  computed via `deriveEntityId()`.
- **`/projects` index route — DOES NOT EXIST.** No
  `routes/_authenticated/projects.tsx`, no
  `routes/_authenticated/projects.index.tsx`. This is the ship-blocker.
- **"Open Docs" link — DOES NOT EXIST anywhere.** Confirmed via grep.
- **TanStack Router Link pattern (for spec):**
  ```tsx
  <Link to="/projects/$projectId/docs"
        params={{ projectId: '0123456789abcdef' }} />
  ```

### E. Existing project + session UI surfaces

- **`ProjectsSection`** (`routes/_authenticated/settings.tsx:380–474`)
  — admin-only, just lists projects + visibility toggle. No
  Open Sessions / Open Docs buttons.
- **Visibility toggle** uses `broadcastSyncedDelta(env, userId,
  'projects', [...])` (`api/index.ts:2236`) — every WS-connected
  user gets a TanStack DB delta frame.
- **`projectsCollection`** (`db/projects-collection.ts`) —
  `createSyncedCollection<ProjectInfo, string>()`, keyed by `name`,
  IndexedDB-persisted. Cold-start fetches `/api/gateway/projects`
  (live data) → fallback `/api/projects`.
- **Session cards** (`components/layout/nav-sessions.tsx:476–540`)
  — show `session.project` string. No project-action buttons today.
- **Sidebar nav** (`components/layout/sidebar-data.ts:4–27`) —
  add "Projects" entry here.
- **Reusable UI:** `Card`, `Button`, `Badge`, `VisibilityBadge` are
  all in `components/ui/` (shadcn-style ports). `useLiveQuery` over
  TanStack DB collections is the standard data-binding pattern.

### F. Spec context — GH#27 + GH#115

- **GH#27** (`planning/specs/27-docs-as-yjs-dialback-runners.md`):
  - **Shipped:** B1–B15, B16–B20 (route, palette, awareness, B19 modal,
    per-file indicators), B21 (ship gate). Verified via VPs.
  - **Not shipped:** the navigation link to reach the route. This is
    GH#122's job. (Issue body's claim that "B16-B20 didn't ship" is
    inaccurate; the right framing is **shipped but unreachable**.)
- **GH#115** (`planning/specs/115-worktrees-first-class-resource.md`):
  - Approved, not yet implemented.
  - Introduces `worktrees` table with `id, path, branch, status,
    reservedBy: json, ownerId`.
  - Adds `agent_sessions.worktreeId` FK.
  - **Owns "who reserved this worktree."** Different concept from
    "who owns this project's docs." No collision with GH#122 as long
    as we don't conflate the two.
- **Coordination calls:**
  - **Pin** `docsWorktreePath` as a path string in v1 (single docs
    worktree per project). If GH#115 later wants `docsWorktreeId` (FK
    to `worktrees`), that's an additive migration.
  - **Do not** model `projectMetadata.ownerId` as the same field as
    `worktrees.ownerId` — orthogonal concepts.

### G. Multi-tenant project ACL patterns (web research)

| Pattern | Example | Schema | Complexity | Fit |
|---------|---------|--------|------------|-----|
| **A. Single-owner + global-admin** | early-stage SaaS | `ownerId` column | S | ✅ MVP — matches existing `getAccessibleSession` precedent |
| **B. Owner + collaborators (role enum)** | GitHub repos, Linear projects | junction `project_members(projectId, userId, role)` | S | ✅ Next step when collaboration is requested |
| **C. Team-based** | GitHub orgs, Sentry teams | `teams`, `team_members`, projects.teamId | M | ❌ Over-engineered for 1-50 users |
| **D. Full RBAC with policies** | AWS IAM, Auth0 RBAC | `roles`, `permissions`, `role_permissions`, `user_role_grants` | L | ❌ **One-way door — do not ship** |
| **E. ABAC / policy-as-code** | OpenFGA, Cedar | external policy engine | L | ❌ Overkill |

**Recommendation:** Start with **Pattern A** for v1 (single `ownerId`
column on `projectMetadata`, owner-or-global-admin gating). Pattern B
becomes a clean additive migration when needed. Avoid D entirely.

Sources: [GitHub repo roles](https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/repository-roles-for-an-organization),
[Linear members & roles](https://linear.app/docs/members-roles),
[Sentry org membership](https://docs.sentry.io/organization/membership/),
[Vercel RBAC](https://vercel.com/docs/rbac),
[WorkOS multi-tenant survey](https://workos.com/blog/multi-tenant-permissions-slack-notion-linear),
[OpenFGA concepts](https://openfga.dev/docs/authorization-concepts).

## Issue body claims vs reality

| Issue claim | Verdict |
|---|---|
| "projectId is never derived" | ❌ Partially wrong. `deriveProjectId` exists in `shared-types/src/entity-id.ts:45–47`; gateway already calls it via `registerProjectWithOrchestrator()`. The real gap is non-atomic dual-write. |
| "No name ↔ projectId mapping" | ✅ Correct — no FK, no helper, no column on `projects`. |
| "No user-facing project list with Docs entry" | ✅ Correct — `/projects` route does not exist. |
| "No add-project flow" | ✅ Correct — gateway discovery only. |
| "Authorization is open" on PATCH | ✅ Correct — `projectMetadataAuth` has no ownership predicate. Plus 2 totally un-gated routes (docs-files, docs-runner health). |
| "B19 modal works correctly" | ✅ Correct — fully shipped, just unreachable. |

## Open decisions — research-informed defaults (pending P1 interview)

| # | Decision | Default (subject to interview) |
|---|---|---|
| 1 | Is projectId user-visible (URLs/share links) or strictly internal? | Already user-visible in `/projects/:projectId/docs` URL. **Default: keep visible.** |
| 2 | One docs worktree per project, or multiple? | **Default: single (v1).** Spec 27 + current schema both assume one. GH#115's `worktreeId` FK enables future per-arc override without changing this. |
| 3 | Where does projectId derivation live? | **Default: orch sync handler** (atomic dual-write of `projects` + `projectMetadata` in one D1 txn). **Plus:** expose `/api/projects/derive-id?originUrl=...` for future add-project UI preview. Drop the gateway's parallel `registerProjectWithOrchestrator` PATCH after the bulk path is proven. |
| 4 | Existing-rows backfill? | **Default: lazy via gateway re-sync.** Gateway re-discovers every 30s; a nullable `projects.projectId` column populates naturally on next sync. No scripted backfill. |
| 5 | Add-project flow scope? | **Default: out of scope (v1 = gateway discovery only).** Pulling it in adds a UI form + originUrl validation + gateway notify. |
| 6 | ACL granularity? | **Default: Pattern A (single owner + global-admin).** One-column migration to add `projectMetadata.ownerId`. Re-uses `getAccessibleSession` predicate exactly. Pattern B is a clean additive migration later. **Hard rule:** do not ship Pattern D. |
| 7 | `agent_sessions.project` rename? | **Default: keep name string for back-compat.** Six callsites + an index use it; migrating is invasive. Add a join helper instead. |

## Recommendations / Implementation outline (refined from issue body)

In order, P1 interview will firm these into B-IDs:

1. **Schema migration** — add `projects.projectId TEXT` nullable +
   index; add `projectMetadata.ownerId TEXT` nullable (FK to `users.id`).
2. **Atomic dual-write in `POST /api/gateway/projects/sync`** —
   compute `projectId` from each incoming `repo_origin`, upsert both
   tables in one D1 txn. Drop the gateway's per-project PATCH path
   after this lands.
3. **Tighten `projectMetadataAuth`** to owner-or-admin on PATCH.
   Keep `DOCS_RUNNER_SECRET` bearer for the docs-runner's own
   callbacks. Gate the un-gated `/docs-files` and `/docs-runners/:id/health`
   the same way (plus the TODO at `api/index.ts:2272`, `:1977`).
4. **New `routes/_authenticated/projects.tsx`** — visibility-aware
   list (uses existing `projectsCollection`), each card has Open
   Sessions + Open Docs buttons.
5. **Sidebar nav** — add "Projects" entry in `sidebar-data.ts`.
6. **Optional / interview-gated:** session-card "Open Docs" link;
   `/api/projects/derive-id` endpoint; add-project UI flow.

## Open questions for P1 interview

- **First-owner-assignment policy:** when the gateway syncs a new
  project, who becomes `ownerId`? (a) null until someone claims it,
  (b) the first session.userId in that project, (c) a global "system"
  admin.
- **Visibility column on `projectMetadata`:** does it mirror
  `projects.visibility` (admin-managed), or is it owner-managed
  (the project owner can flip private/public)? Conceptually
  different from "who owns it."
- **`/api/projects/derive-id` endpoint:** ship now (cheap, enables
  add-project UI later) or defer until add-project lands?
- **GH#115 ordering:** GH#122 ships before GH#115. Anything in GH#122
  should explicitly avoid pre-empting `worktreeId` semantics — confirm
  this discipline holds at spec time.
- **Docs-runner's own auth path:** when the docs-runner PATCHes
  `projectMetadata` from the VPS, it uses `DOCS_RUNNER_SECRET`. Does
  the new owner-or-admin gate apply to that path too, or does the
  bearer auth bypass owner checks? (Likely bypass — the runner is
  semi-privileged infra.)

## Next steps

- Resolve the 5 open questions above + the 7 defaulted decisions in
  P1 interview (`kata-interview` skill).
- Draft spec at `planning/specs/122-projects-docs-entry-point.md`
  with B-IDs covering: schema migration · atomic dual-write · auth
  tightening · projects route · sidebar nav · session-card link
  (optional).
- Verification plan: e2e harness covering "fresh user signs in →
  navigates to /projects → sees list → clicks Open Docs → lands on
  editor (or sees B19 modal on first run)" + 403 negative test for
  non-owner PATCH.
