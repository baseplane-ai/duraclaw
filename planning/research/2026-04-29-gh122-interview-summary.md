---
date: 2026-04-29
topic: "GH#122 — user-facing per-project setup + docs entry point — P1 interview summary"
type: interview
status: complete
github_issue: 122
inputs:
  - planning/research/2026-04-29-gh122-projects-docs-entry-point.md
  - planning/specs/27-docs-as-yjs-dialback-runners.md
  - planning/specs/115-worktrees-first-class-resource.md
---

# Interview summary — GH#122 / per-project setup + docs entry point

Produced by P1 interview on 2026-04-29. Every decision below is locked
and maps to at least one behaviour in the forthcoming spec
(`planning/specs/122-projects-docs-entry-point.md`). Open risks called
out at the end.

**Headline reframe from the interview:** GH#27's docs route, BlockNote
editor, and B19 first-run modal are **already shipped** — the actual
gap is (a) no `/projects` page or sidebar entry to reach them, (b)
`projects` ↔ `projectMetadata` aren't transactionally linked, and
(c) the existing `/api/projects/:projectId*` routes accept any
authed user (or any `DOCS_RUNNER_SECRET` bearer). GH#122 plugs all
three holes plus introduces a Pattern B (owner + collaborators)
ACL schema, even though only the owner role gets a UI in v1.

## Decisions (grouped by category)

### A. Data model & atomicity

| # | Decision | Reasoning |
|---|---|---|
| A1 | **Orch sync handler derives projectId; drop the gateway's parallel `registerProjectWithOrchestrator()` PATCH path.** Atomic dual-write of `projects` (with new `projectId` column) + `projectMetadata` in a single D1 transaction inside `POST /api/gateway/projects/sync`. | `repo_origin` is already in the sync payload (`agent-gateway/src/projects.ts:325,339`); `deriveProjectId` already exists (`shared-types/src/entity-id.ts:45-47`). Single source of truth, transactionally consistent. Removes the existing race between bulk sync and per-project PATCH. |
| A2 | **Scripted one-shot backfill** for `projects.projectId`. Post-migration wrangler script reads existing `projectMetadata.originUrl` rows, derives projectId, writes to `projects.projectId` for matching `projects.name`. Any project without a matching `projectMetadata` row stays `projectId = null` until the next gateway sync populates it. | User chose the heavier deterministic path over lazy-via-resync. Acknowledges D1 migrations don't have shell access; backfill ships as a separate operator-runnable script that hits `wrangler d1 execute`. |
| A3 | **Keep `agent_sessions.project` as a name string;** do NOT add a `projectId` column to `agent_sessions`. Add a `getProjectIdByName(name)` join helper for code that needs projectId. | Six callsites + `idx_agent_sessions_user_project` index use the name. Migrating is invasive and unnecessary if `projects.projectId` becomes the join column. |
| A4 | **Schema additions:** `projects.projectId TEXT NULL` + index; `projectMetadata.ownerId TEXT NULL` (FK to `users.id`); new table `project_members(projectId, userId, role, addedAt, addedBy)` with composite PK + partial unique index on `(projectId) WHERE role='owner'`. | Single migration, three changes. All nullable to allow staged rollout. |

### B. ACL & ownership

| # | Decision | Reasoning |
|---|---|---|
| B1 | **Pattern B** — owner + collaborators with role enum (`'owner' \| 'editor' \| 'viewer'`). Backed by `project_members` junction table. | User overrode the recommended Pattern A. Web research (GitHub, Linear) confirms B is the proven scale pattern for small-team products. Extra schema is cheap; UI for editor/viewer can ship in a follow-up issue. |
| B2 | **First owner = `null` until claimed.** Sync writes `ownerId = null` for newly-discovered projects. GH-owner-match (originally requested) deferred to **post-GH#22** because: no GitHub OAuth in Better Auth, no `users.githubLogin` column, no GitHub API client (`docs/integrations/github.md` confirms). When GH#22 ships, an additive migration can retroactively set `ownerId` by matching parsed origin org ↔ linked GitHub identity. | User accepted the defer-to-GH#22 plan after research showed GH-owner-match isn't currently implementable. |
| B3 | **No separate `visibility` column on `projectMetadata`.** Reuse the existing `projects.visibility` (admin-managed, default `'public'`) as governing both project listing and docs access. | One visibility concept across the system. Avoids the "public project, private docs" edge case which has no current use. |
| B4 | **`DOCS_RUNNER_SECRET` bearer bypasses the owner-or-admin check.** The runner is infra-level, not a user identity. Composition: `if (bearerAuthOk) skipOwnerCheck; else require owner-or-admin`. | Matches existing semantics of the secret elsewhere; the runner is per-machine and shouldn't be modeled as a user. |
| B5 | **All four routes get the new owner-or-admin gate** (cookie path only; bearer bypasses): `PATCH /api/projects/:projectId`, `GET /api/projects/:projectId`, `GET /api/projects/:projectId/docs-files`, `GET /api/docs-runners/:projectId/health`. | Plugs the existing TODO at `api/index.ts:2272` and the analogous gap at `:1977`. |
| B6 | **Single owner per project enforced via partial unique index** on `project_members(projectId) WHERE role='owner'`. | Matches GitHub repo + Linear project models. Cleaner ownership-transfer story (replace the row, not co-existence). |
| B7 | **Role capabilities:** Owner — full (PATCH, member mgmt, transfer, delete). Editor — docs write (BlockNote write, file list read), no settings/member mgmt. Viewer — docs read only (BlockNote read-only, file list read). | Maps to GitHub's read/write/admin and BlockNote's collaborative-edit model. |
| B8 | **Ownership claim is admin-only** (only admins can claim a `null`-owner project). **Transfer requires owner OR admin.** | Conservative; matches existing visibility-toggle pattern (admin-only on `settings.tsx` ProjectsSection). Avoids first-come-first-claim risks in shared deploys. |

### C. UI / UX scope

| # | Decision | Reasoning |
|---|---|---|
| C1 | **One docs worktree per project (v1).** `projectMetadata.docsWorktreePath` stays a single nullable path string. | Spec 27 + current schema both assume one. Per-arc override is a future GH#115 add-on. |
| C2 | **`projectId` is URL-only** in the new `/projects` UI. No copyable badge on cards, no slug rewriting. | The 16-hex hash is an opaque internal handle; surfacing it as UI clutter doesn't help users. URL-bar exposure (already there for `/projects/:projectId/docs`) is sufficient. |
| C3 | **Stay gateway-discovery-only.** No UI-driven add-project flow in v1. | Operator runs `scripts/setup-clone.sh`; gateway syncs within 30s. Duplicating this in UI would degrade UX and bloat scope. Defer until concrete user request. |
| C4 | **No `/api/projects/derive-id?originUrl=...` endpoint** in v1. | If add-project UI is out of scope, nothing in the UI needs to preview a projectId. Add later if needed. |
| C5 | **Session cards get an "Open Docs" link** in v1. Conditional render: only when `projects.projectId` resolves for the session's `project` name. | Once `projects.projectId` exists, lookup is a single index hit. Big UX win for small cost. Pattern: small icon-button next to the existing `session.project` text. |
| C6 | **Project card composition:** name (large monospace), displayName (subtitle), `[Open Sessions]` button, `[Open Docs]` button, small visibility badge if not `'public'`, ownership status (`Owner: <name>` if owned; `Unowned [Claim]` if null + admin viewer; `Unowned — ask an admin` otherwise). Loading: skeleton. Empty: `No projects discovered yet — the gateway syncs every 30s.` | Single-purpose project hub. "Open Sessions" + "Open Docs" are the two primary actions. Ownership status is small but informative. |
| C7 | **Sidebar nav: insert "Projects" entry between Sessions and Board** in `sidebar-data.ts:4-27`'s General group. | Highest discoverability. Matches frequency-of-use semantic (project = unit of work, sessions = operations within). |

### D. Member management UI scope

| # | Decision | Reasoning |
|---|---|---|
| D1 | **v1 ships owner-claim + ownership-transfer only.** Editor/viewer add-via-UI deferred to a follow-up issue. | The `project_members` schema + role enum exist in v1, but the only role populated is `'owner'`. Editor/Viewer roles are reserved schema slots. v1 satisfies the data model without a full member-management page. |
| D2 | **Surfaces in v1:** `[Claim]` button on `/projects` card (admin viewer + null owner), `[Transfer ownership]` button on `/projects` card (owner OR admin viewer), admin override in existing `settings.tsx` `ProjectsSection`. | Minimum to satisfy Pattern B's claim/transfer story without per-project member UI. |
| D3 | **Out of scope for v1** (callout in spec): per-project settings page, email-based invite flow, role dropdown, audit log. | Probably 2-3x the rest of GH#122's effort. Worth its own spec. |

### E. GH#115 coordination

| # | Decision | Reasoning |
|---|---|---|
| E1 | **Pin `docsWorktreePath` as a path string in v1; document the swap point.** Spec note: "When GH#115 ships, an additive migration can introduce `projectMetadata.docsWorktreeId` (nullable FK to `worktrees.id`); `docsWorktreePath` becomes derived/legacy or is deprecated." | Don't pre-build `docsWorktreeId` before GH#115's `worktrees` table exists. Don't block on GH#115 either — GH#122 is the user-visible payoff for already-shipped GH#27 work. |
| E2 | **`project_members` is orthogonal to `worktrees.ownerId`.** Different concepts, different tables, no collision. | GH#122 owns project-level ownership; GH#115 owns worktree-reservation ownership. |

### F. Verification plan

| # | Decision | Reasoning |
|---|---|---|
| F1 | **Verification plan v1: happy-path E2E user journey ONLY.** Single harness exercising: sign in → `/projects` → see ≥1 project → click "Open Docs" → land on BlockNote editor (configured) OR see B19 modal (first-run) → enter docsWorktreePath → see file tree. | User explicitly selected only this category. Auth negative + ownership-state-machine tests, atomic dual-write integration test, and migration backfill smoke test were **deliberately deselected** (see Open Risk OR-1). |
| F2 | **Manual smoke checklist** included in spec under "Verification plan / Manual checks." 5-10 bulleted post-deploy steps: backfill ran, sync populates new rows correctly, /projects loads, claim button appears for admin, owner-or-admin gate enforces, etc. | Captures real-environment checks the automated VP doesn't. |
| F3 | **Spec filename:** `planning/specs/122-projects-docs-entry-point.md`. Matches existing convention (`27-docs-as-yjs-dialback-runners.md`, `115-worktrees-first-class-resource.md`). | — |

## Open risks

- **OR-1 (Verification coverage is light).** Only the happy-path E2E was selected for the automated VP. Auth negative tests, ownership claim/transfer state-machine tests, atomic dual-write integration test, and migration backfill smoke test were deselected. The manual checklist (F2) partially covers some of this. **Recommendation for spec writer:** in the verification-plan section, explicitly note these as "deliberately scoped out — covered manually" so reviewers can challenge if they disagree.
- **OR-2 (Pattern B with no editor/viewer UI).** The `project_members` table will only have `owner` rows in v1. Editor/Viewer roles exist in the enum + index constraints but no code path adds them. Risk: the schema design choices (composite PK, partial unique index, role enum) are hard to migrate later if a real editor/viewer UI surfaces a need we didn't anticipate. **Mitigation:** spec should include a small "schema future-proofing notes" section flagging any constraints that might bite a follow-up.
- **OR-3 (GH-owner-match deferred but not scheduled).** Decision B2 punts GH-owner-match to "post-GH#22." If GH#22 lands without remembering to retroactively populate `ownerId` for already-discovered projects, those projects stay `null`-owned forever (or admins claim them all manually). **Mitigation:** spec should add a "Follow-up issues" section with a concrete bullet for this.
- **OR-4 (Backfill script tied to existing `projectMetadata.originUrl`).** Decision A2's scripted backfill works only for projects whose gateway has already PATCHed `projectMetadata` (so `originUrl` is populated). Brand-new projects discovered AFTER the migration but BEFORE running the script have `projects.projectId = null`. **Mitigation:** the spec's join helper (A3) must treat `projectId = null` gracefully (e.g., session-card "Open Docs" link doesn't render); the next gateway sync within 30s will close the window.
- **OR-5 (Bearer bypass on docs-files endpoint).** B4 + B5 mean a docs-runner bearer can call `/api/projects/:projectId/docs-files` and get the full file list for any project, even private ones. This is intentional (the runner is the file system) but worth calling out to security-minded reviewers. **Mitigation:** spec should explicitly document the threat model: `DOCS_RUNNER_SECRET` is treated as semi-privileged infra; rotating it is a security incident.

## Architectural bets (hard to reverse)

- **AB-1 (Pattern B junction table shape).** Once `project_members` has rows, migrating to Pattern A (single ownerId column) or Pattern C (team-based) requires a data migration. The composite PK + partial unique index are reasonable defaults but the spec should call this out.
- **AB-2 (Single-owner enforcement via partial unique index).** Switching to multi-owner later means dropping the index — easy schema-wise, but every `[Transfer ownership]` UI assumes single-owner today. UI rewrite needed if multi-owner ever ships.
- **AB-3 (Drop gateway's per-project PATCH path).** F1 says drop `registerProjectWithOrchestrator()`. Re-adding it later (e.g., for a different sync model) means re-introducing the race we just fixed. Mitigation: spec writer should ensure the drop is genuinely safe — the bulk sync covers everything the per-project PATCH did.
- **AB-4 (Reuse `projects.visibility` for docs access).** B3's decision means making docs private requires admin action (since `projects.visibility` is admin-managed). If the product ever wants user-managed per-project docs visibility, we'd add a `projectMetadata.visibility` column anyway and reverse this — additive but a UI rework.

## Codebase findings (key file:line refs)

These are the files the spec writer will touch or reference. Captured here so the spec can drop straight into implementation phases.

| Concern | File | Line |
|---|---|---|
| `projects` table schema | `apps/orchestrator/src/db/schema.ts` | 286–293 |
| `projectMetadata` table schema | `apps/orchestrator/src/db/schema.ts` | 389–397 |
| `users` table (role column) | `apps/orchestrator/src/db/schema.ts` | 34–46 (role at 40) |
| `agent_sessions.project` | `apps/orchestrator/src/db/schema.ts` | 134 |
| Latest migration touching projects-related tables | `apps/orchestrator/migrations/0026_project_metadata.sql` | — |
| Gateway sync handler | `apps/orchestrator/src/api/index.ts` | 714–750 |
| `projectMetadataAuth` middleware | `apps/orchestrator/src/api/index.ts` | 1145–1167 |
| `PROJECT_ID_RE` | `apps/orchestrator/src/api/index.ts` | 1143 |
| PATCH /api/projects/:projectId | `apps/orchestrator/src/api/index.ts` | 1169–1267 |
| GET /api/projects/:projectId | `apps/orchestrator/src/api/index.ts` | 1270–1289 |
| GET /api/projects/:projectId/docs-files (TODO) | `apps/orchestrator/src/api/index.ts` | 2266–2329 (TODO at 2272) |
| GET /api/docs-runners/:projectId/health | `apps/orchestrator/src/api/index.ts` | 2346–2411 |
| Owner-or-admin precedent (`getAccessibleSession`) | `apps/orchestrator/src/api/index.ts` | 264–284 |
| Owner-or-admin precedent (worktree release) | `apps/orchestrator/src/api/index.ts` | 2598 |
| Visibility broadcast pattern | `apps/orchestrator/src/api/index.ts` | 2236 (`broadcastSyncedDelta`) |
| Existing admin ProjectsSection | `apps/orchestrator/src/routes/_authenticated/settings.tsx` | 380–474 |
| `projectsCollection` (TanStack DB) | `apps/orchestrator/src/db/projects-collection.ts` | — |
| Docs route (already shipped) | `apps/orchestrator/src/routes/_authenticated/projects.$projectId.docs.tsx` | — |
| B19 modal (already shipped) | `apps/orchestrator/src/components/docs/DocsWorktreeSetup.tsx` | — |
| Session cards | `apps/orchestrator/src/components/layout/nav-sessions.tsx` | 476–540 |
| Sidebar config | `apps/orchestrator/src/components/layout/sidebar-data.ts` | 4–27 |
| `deriveProjectId` (entity-id) | `packages/shared-types/src/entity-id.ts` | 45–47 |
| Gateway origin URL collection | `packages/agent-gateway/src/projects.ts` | 47, 325, 339 |
| Gateway per-project PATCH (to be dropped) | `packages/agent-gateway/src/projects.ts` | 265–308 |

## Behaviour preview (for spec writer)

Rough mapping from decisions to expected B-IDs (final IDs assigned in spec):

- **Schema:** B1 (add projectId column + index), B2 (add ownerId column), B3 (create project_members table)
- **Backfill:** B4 (post-migration script)
- **Sync handler:** B5 (orch derives projectId), B6 (atomic dual-write), B7 (drop gateway per-project PATCH)
- **Auth:** B8 (owner-or-admin middleware composition), B9 (gate PATCH /api/projects/:projectId), B10 (gate GET /api/projects/:projectId), B11 (gate GET /api/projects/:projectId/docs-files), B12 (gate GET /api/docs-runners/:projectId/health), B13 (bearer bypass behavior)
- **Ownership lifecycle:** B14 (admin-only claim), B15 (owner-or-admin transfer)
- **UI:** B16 (`/projects` route + page), B17 (project card composition), B18 (sidebar Projects entry), B19 (claim/transfer buttons), B20 (session-card Open Docs link), B21 (admin override in settings ProjectsSection)
- **Verification:** VP1 (happy-path E2E), Manual smoke checklist

## Next steps

- Spec writing (P2 / `kata-spec-writing` skill) consumes this document as primary input.
- Spec target: `planning/specs/122-projects-docs-entry-point.md`.
- Open risks OR-1, OR-2, OR-3 should be reflected verbatim in the spec's "Risks" section so reviewers and implementers see them.
