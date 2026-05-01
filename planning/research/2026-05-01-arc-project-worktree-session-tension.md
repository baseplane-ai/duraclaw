---
date: 2026-05-01
topic: Surface tension between arc / project / worktree / session primitives
type: feasibility
status: complete
github_issue: 160
items_researched: 5
---

# Research: Surface tension between arc / project / worktree / session

## Context

GH#160 surfaced a small UI bug — the projects list at `/projects` renders one card per worktree while the sidebar already groups worktrees by parent repo. The fix is two hours of UI work. But the bug exists because **duraclaw has four overlapping identity-bearing primitives — arc, project, worktree, session — that were introduced incrementally and never reconciled.** Each spec (#27, #115, #116, #122) added a primitive without retiring an old one. Each UI surface picks a different identity to lean on.

This doc maps the four primitives honestly, names the seams between them, and proposes where the lines could be redrawn. It's not a spec — it's groundwork for one.

## Scope

**Items researched (5 parallel deep-dives):**

1. **Arc** — schema, lifecycle, the three primitives (`advanceArc` / `branchArc` / `rebindRunner`), where it's load-bearing vs vestigial
2. **Project** — the dual identity (`projects.name` per-worktree string vs `projectMetadata.projectId` per-repo sha), every consumer
3. **Worktree** — `worktrees` table, lifecycle (free/held/cleanup), what it does that `projectMetadata` doesn't
4. **Session** — `agent_sessions` schema, denormalized fields (project, mode, worktreeId), session-vs-runner identity
5. **UI surfaces & spec history** — sidebar, `/projects`, `/arc/:id`, agent-orch home; spec #27 / #115 / #116 / #122

Plus a focused trace of the **"Open Docs disabled until next gateway sync" timing race** as a concrete failure example.

## Findings

### The data graph

```
projectMetadata (per-repo)              projects (per-worktree)
   PK: projectId                              PK: name
   originUrl, ownerId, docsWorktreePath      FK: projectId (NULLABLE, async-populated)
                                              repo_origin (string, no FK)
                                                    ↓ path-derived, no FK
                                              worktrees (per-clone)
                                                    PK: id
                                                    path (UNIQUE)
                                                    status: free | held | cleanup
                                                    reservedBy (JSON: kind+id)
                                                          ↑ worktreeId (advisory, nullable)
                                              arcs (per-workflow)
                                                    PK: id
                                                    parentArcId (self-FK)
                                                    externalRef (issue/PR, unique-indexed)
                                                          ↑ arcId (NOT NULL FK)
                                              agent_sessions (per-conversation)
                                                    PK: id
                                                    project (string, denormalized = projects.name)
                                                    worktreeId (FK, nullable)
                                                    parentSessionId (self-FK)
                                                    mode (string, kata-validated)
```

**Four primitives, four PK keyspaces, no single hierarchy connecting them.**

### Per-primitive map

#### Arc (`apps/orchestrator/src/db/schema.ts:268-305`)

A durable container for a workflow. Owns external references (GitHub issue / Linear / plain), parents a tree of sessions, advisory-binds a worktree, and tracks mode progression *implicitly* (via its sessions' modes).

- **PK:** `id` (`arc_${uuid}`)
- **FKs:** `userId` (CASCADE), `worktreeId` (nullable, advisory), `parentArcId` (self, no Drizzle ref due to circular binding)
- **External-ref deduplication:** expression-unique index on `(provider, id)` extracted from `externalRef` JSON — the DB constraint is what makes "one arc per GitHub issue per user" a true invariant (`schema.ts:297-302`)
- **Three operations on SessionDO:**
  - `advanceArcImpl` (`advance-arc.ts:86-144`) — close frontier session, mint successor in same arc with new mode
  - `branchArcImpl` (`branches.ts:253-380`) — mint child arc with `parentArcId`, seed first session with wrapped transcript
  - `rebindRunnerImpl` (`rebind-runner.ts:34-107`) — same arc, same session, new runner (orphan recovery)

**The "implicit single-session arc" pattern.** ~70-80% of arcs in practice match `externalRef === null && sessions.length === 1 && parentArcId == null`. The sidebar collapses these to flat session rows via `isImplicitSingleSessionArc` (`nav-sessions.tsx:65-71`). They exist because `agent_sessions.arcId` is `NOT NULL` — every session needs an arc parent, even ephemeral debug sessions.

**Where arcs are load-bearing:**
- Multi-session mode-progression chains (research → planning → implementation → verify → close)
- Branch trees (`branchArc` creates child arc with `parentArcId`)
- External-ref deduplication ("this issue is already being worked")
- Arc-level lifecycle (status: draft / open / closed / archived)

**Where arcs are vestigial:** any single-session debug/freeform spawn. The arc row exists but is never browsed, hidden by the sidebar's collapse heuristic.

#### Project (dual identity)

Two PKs for what users perceive as one concept:

- **`projects.name`** (`schema.ts:398`) — per-worktree string, derived from the gateway's filesystem scan of `/data/projects/<name>`. Used by `agent_sessions.project`, sidebar's `sessionsByProject`, `/?project=<name>` deep-link, ProjectCard's getKey
- **`projectMetadata.projectId`** (`schema.ts:520`) — per-repo `sha256(originUrl).slice(0,16)`. Used by ownership, docs-runner addressing, `RepoDocumentDO` entityId derivation

Linked by a **nullable `projects.projectId` FK** that's populated *async* by the next gateway sync (atomic dual-write at `apps/orchestrator/src/api/index.ts:732-787`).

**`projectMetadata` schema** (`schema.ts:519-533`):
```
projectId         TEXT   PK   = sha256(originUrl).slice(0,16)
projectName       TEXT   NOT NULL
originUrl         TEXT   NULL
docsWorktreePath  TEXT   NULL
tombstoneGraceDays INT   DEFAULT 7
ownerId           TEXT   FK→users.id ON DELETE SET NULL
createdAt, updatedAt
```

**`ProjectInfo` shape** (`packages/shared-types/src/index.ts:692-724`) carries fields from both identities:
- Per-worktree (gateway-discovered, transient): `name`, `path`, `branch`, `dirty`, `repo_origin`, `ahead`, `behind`, `pr`, `active_session`
- Per-repo (D1-persisted): `projectId`, `ownerId`, `visibility`
- UI customization: `abbrev`, `color_slot`

**The two identities cannot be collapsed without loss.** `name`/`branch`/`dirty`/`pr` are path-scoped and live on the gateway side; `projectId`/`ownerId`/`docsWorktreePath` are repo-scoped and live in D1. Sibling worktrees of the same upstream repo (`duraclaw`, `duraclaw-dev1`, `duraclaw-dev2`, `duraclaw-dev3`) share a `projectId` but have distinct `name`s — both are correct.

#### Worktree (`apps/orchestrator/src/db/schema.ts:351-372`)

A reservable VPS resource — one row per **full git clone** under `/data/projects/<name>`. **Not** a `git worktree` subtree (despite the table name).

- **PK:** `id` (8-byte hex)
- **`path`:** UNIQUE absolute filesystem path
- **State machine:** `free` → `held` → `cleanup` (with re-attach grace window, default 24h)
- **`reservedBy`:** JSON `{kind: 'arc'|'session'|'manual', id}` — single column carries multiple reservation models
- **No `parent_repo` column.** The connection to a repo is inferred via `path` matching the gateway scan, then `projects.repo_origin` lookup. Two worktrees of the same upstream are detectable only by joining through `projects` and grouping on `repo_origin`.
- **Two creation paths:**
  - Gateway sweep (`worktree-sweep.ts:295`) every 60s, batch POST `/api/gateway/worktrees/upsert`
  - Explicit reservation (`POST /api/worktrees`) — orchestrator atomic pick from `status='free'` pool, ordered by lowest `lastTouchedAt`
- **Release path** (`release-worktree-on-close.ts:42-61`): fires on session terminal status (stopped/error/failed/crashed/idle), with a last-session sibling check before flipping to `cleanup`. Three deletion paths: DO alarm, hourly cron janitor, `POST /api/admin/worktrees/sweep`. (GH#157 issue tracks ambiguity in this area.)
- **No FK to `projectMetadata`.** The two tables describe filesystem state independently.

#### Session (`apps/orchestrator/src/db/schema.ts:148-246`)

The original primitive. One Claude SDK conversation, owned by one SessionDO with SQLite message history.

49 columns. Identity-bearing fields:
- **Cannot derive:** `id`, message history, `runner_session_id` (transient lease)
- **Denormalized for read perf:** `project` (string, = `projects.name`), `mode` (string, kata-validated), `worktreeId` (nullable FK), `arcId` (NOT NULL FK), `parentSessionId` (self-FK)

**`mode`** is free-form text. The orchestrator does **not** validate it — kata's `kata.yaml` is authoritative. But mode drives orchestrator-side logic: auto-advance gate (`nextMode(currentMode)` lookup), code-touching check (which modes need a worktree), kanban column placement (`deriveColumn` over arc.sessions). So mode is shared semantics between two systems with no shared schema.

**`runner_session_id` and `rebindRunner`** make the session-vs-runner distinction explicit: session.id is stable across runner reaps; `runner_session_id` is a transient lease. Orphan recovery is "same session row, fresh runner."

**`session.project`** is the per-worktree name string, **not** `projectId`. Authorization checks must traverse `session.project → projects.name → projects.projectId → projectMetadata.ownerId` — a four-hop chain with timing, nullability, and naming-collision edge cases at each step.

### The five seams

**1. Project has two PKs.** `projects.name` (per-worktree) and `projectMetadata.projectId` (per-repo). Linked by a nullable FK populated async by gateway sync. **This is the seam that bites users** — it's GH#160, it's the Open Docs timing race, it's the per-worktree-card bug.

**2. Worktree has no parent-repo FK.** Detection of "two worktrees of the same upstream" requires joining through `projects` on `path` then grouping by `repo_origin`. The sidebar already does this work (`nav-sessions.tsx:390-398`); the projects page would have to repeat it.

**3. Arc → worktree FK is advisory, not enforced.** `arcs.worktreeId` is nullable; nothing in code prevents sessions in the same arc from binding to different worktrees. In practice multi-session arcs do share a worktree, but it's convention, not constraint.

**4. `agent_sessions.project` is the worktree name string.** Not `projectId`. Authorization paths walk a four-hop chain. New-worktree-of-same-repo creates ownership ambiguity (Symptom 1 below).

**5. Mode is session-level data with arc-level meaning.** `agent_sessions.mode` is per-session, but progress (research → planning → implementation → ...) is an arc property derived at query time via `deriveColumn(arc.sessions)`. Works fine, but it means "what column is this arc in?" requires a child-row scan on every render. And kata-vs-orchestrator mode validation lives in two places.

### UI surfaces — what each one leans on

| Surface | Files | Collections | Groups by | Identity used | Actions |
|---------|-------|-------------|-----------|---------------|---------|
| **Sidebar** | `nav-sessions.tsx` | projects, sessions, arcs | `repo_origin` → `name` → sessions | Worktree path | Select session, open arc, rename, archive, hide |
| **/projects** | `routes/_authenticated/projects.tsx` + `ProjectCard.tsx` | projects only | `name` (flat, no grouping) | Worktree path → projectId | Open Sessions, Open Docs, Claim, Transfer ownership |
| **/arc/:id** | `routes/_authenticated/arc.$arcId.tsx` | arcs only | `arc.id` → sessions | Arc id, worktree advisory | Edit title, view externalRef, view worktree badge, open session by id |
| **/ (agent orch)** | `features/agent-orch/AgentOrchPage.tsx` | sessions, projects | `session.id` → tabs | Session id, project string | Spawn session, select/close tabs, direct-create |

Each surface picks one identity to lean on. **The lean is what causes GH#160:** the sidebar leans on `repo_origin` (so it groups by repo); `/projects` leans on `name` (so it renders per-worktree).

### Concrete failure: the Open Docs timing race

The `/projects` page disables the "Open Docs" button when `project.projectId` is null (`ProjectCard.tsx:97-105`). The sidebar's docs icon only renders when `projectIdByName[session.project]` is truthy (`nav-sessions.tsx:581-591`). Both gate on the async-populated `projectId`.

**Failure timeline (worst case, after `scripts/setup-clone.sh alpha` with origin set later):**

| T+0s   | User runs `setup-clone.sh alpha`; clone exists, no remote yet |
| T+0s   | User opens UI; cold-start `GET /api/projects` returns row with `projectId: null` |
| T+2s   | Worktree-sweep fires (60s interval) — upserts `worktrees` only |
| T+5s   | Gateway `pushProjectsToWorker()` (30s interval) sends `repo_origin: null` |
| T+6s   | Orchestrator sync handler upserts `projects` row, `projectId` stays null, `projectMetadata` row not created (`api/index.ts:767`) |
| T+7s   | Broadcast delta arrives at client; no change |
| T+8s   | User clicks Open Docs — disabled |
| T+30s  | Next push cycle; if origin now set, derive `projectId`, upsert both tables atomically (`api/index.ts:806-808`) |
| T+32s  | Broadcast → re-render → button enables |

**Best case:** ≤30s if origin is set before first sync.
**Worst case:** 30s + however long it takes the user to remember to add the origin.

**Workarounds in code today:** none. No optimistic rendering, no "syncing..." spinner, no "resync now" button. UI silently disables with tooltip *"Project not yet synced — try again in a moment"*.

**Why this race exists:** `projects` is keyed by `name` (gateway-stable, available immediately) but `projectId` is a nullable column on the same row, populated async when origin is known. `projectMetadata` only exists when `projectId` is known. The single source of truth is split across two tables with different availability windows.

### User-visible symptoms (today)

1. **Ownership ambiguity for new worktree of same repo.** A user clones a second worktree of an already-owned repo. The sidebar shows it under "Orphan sessions" until the gateway sync registers it. During that window, ownership checks bypass entirely (no `ownerId` on the row to check against). After sync, it inherits the repo's `projectMetadata.ownerId` — which may surprise the user who expected fresh-clone semantics.

2. **Sidebar hides projects but `/projects` doesn't.** The `hidden` flag lives only in `userPreferencesCollection` (`nav-sessions.tsx:310`). `/projects` filters on visibility + ownership but ignores `hidden`. Net effect: hide a project from the sidebar, then go to `/projects` and see it again.

3. **Open Docs disabled until sync** (the timing race above).

## Comparison

Three proposals, ranked by ROI. **Lead recommendation: #2 (projects becomes a view)**, per the calibration question.

| Proposal | Lift | Fixes | Risk | Verdict |
|----------|------|-------|------|---------|
| #1 — `worktrees.parentRepoId` column | ~2h schema add + UI fix | GH#160 directly | Low | **Tactical fix.** Bandage that addresses the visible bug without touching the deeper duality. Worth doing as a stepping stone toward #2 or as a standalone if #2 is deferred. |
| **#2 — `projects` becomes a derived view** | **~1 week migration** | **GH#160 + Open Docs race + Symptom 1 + Symptom 2** | **Medium (migration, hot-path query rewrites)** | **Recommended.** Eliminates the dual-PK problem at the source. Right long-term architecture. |
| #3 — drop `agent_sessions.project` denormalization | ~1 week + perf work | Symptom 1 cleanly | Higher (sidebar read amplification) | **Deferred.** Principled but the read-perf cost on the hot sidebar render path is real. Not worth it standalone. |

## Recommendations

### Lead: Proposal #2 — `projects` becomes a derived view

Make `projectMetadata` the authoritative project row, keyed by `projectId`. Replace the `projects` table with:

- A `project_ui_settings` table for per-user customization (`hidden`, `abbrev`, `color_slot`) — this is the only thing on `projects` that doesn't belong on `projectMetadata` or `worktrees`
- A SQL view (or app-layer derivation) `projects_view` that joins `worktrees ⨝ projectMetadata ⨝ project_ui_settings` for read paths that want per-worktree rows
- Direct queries on `projectMetadata` (per-repo) and `worktrees` (per-clone) for new code

**What this fixes:**

- **GH#160** — `/projects` queries `projectMetadata` directly (one row per repo); a sub-list of `worktrees` per repo nests underneath. Sidebar's `repoGroups` derivation becomes the canonical shape.
- **Open Docs timing race** — `projectMetadata` row only exists when `projectId` is known. The "Open Docs" button is gated on the row's existence, not on a nullable column. Cold-start UI shows "syncing..." for a project until its `projectMetadata` row arrives, which is honest about the actual state.
- **Symptom 1 (ownership ambiguity)** — ownership lives only on `projectMetadata`. New worktree of same repo inherits unambiguously because it has no row of its own to add nuance.
- **Symptom 2 (hide-vs-visible split)** — `project_ui_settings.hidden` is a single source of truth for both surfaces.

**What it costs:**

- Migration of `projects` data into `projectMetadata` + `project_ui_settings` (medium-complexity D1 migration with a backfill sweep)
- Rewrite of `agent_sessions.project` denormalization — either keep it as a path string with a documented "this is the worktree name, not the project identity" comment, or migrate to `worktreeId` + lookup (overlaps with proposal #3)
- Every consumer of `projects` (gateway sync handler, sidebar, `/projects`, ProjectCard, AgentOrchPage tab logic) needs to retarget to either `projectMetadata` (per-repo) or `projects_view` (per-worktree compat)
- Risk of read-perf regression on hot sidebar queries — needs benchmarking

**Migration strategy:**

1. Add `projectMetadata` rows for every existing `projects` row (atomic backfill; null `projectId` rows skipped)
2. Introduce `project_ui_settings` table; migrate `hidden`/`abbrev`/`color_slot` columns
3. Add `projects_view` (SQL view or app-layer wrapper) that exposes the legacy shape
4. Migrate consumers one at a time to the new shape (sidebar first as it's the highest-traffic surface)
5. Drop `projects` table when no consumer references it directly

### Tactical alternative: Proposal #1 — `worktrees.parentRepoId` column

If a full migration is too much, one column on `worktrees` (populated from `projects.repo_origin` at sweep time, then nullable-not-null over time) eliminates the path-matching dance for "group worktrees by repo." GH#160 collapses to a one-line UI fix that joins on `worktrees.parentRepoId` instead of inferring it through `projects`.

This is a stepping stone, not a destination — the deeper dual-PK problem stays.

### Considered, not recommended now: Proposal #3 — drop `session.project`

Derive via `worktreeId → worktrees.path` (or `worktreeId → worktrees → projectMetadata.projectName`). Cleaner, eliminates ownership ambiguity at the type level. But the sidebar render path queries thousands of session rows per user; adding a 2-hop join on every render is real cost. Defer until profiling justifies it.

## Open questions

- **Is the read-perf hit of #2 actually material?** Need a benchmark of "render sidebar with 200 sessions and 12 projects" before vs after the view rewrite.
- **What happens to `agent_sessions.project` historically?** A backfill that maps name → projectId is straightforward for current rows; older rows where the originating clone is gone are harder.
- **Does the gateway need to keep emitting per-worktree `ProjectInfo`?** The transient fields (branch, dirty, ahead, behind, pr) belong on `worktrees`, not on a "project." Maybe `ProjectInfo` becomes a worktree-shaped DTO and the gateway stops sending project-shaped data at all.
- **Is there appetite for a kata-vs-orchestrator mode-validation reconciliation?** Currently kata is authoritative; orchestrator silently accepts unknown modes and degrades (no auto-advance, no kanban column). Could be tightened.
- **GH#157 (`releaseWorktreeOnClose`)** — the worktree-lifecycle ambiguity tracked there is adjacent to this work. May be worth bundling.

## Next steps

1. **Decide on proposal #1 vs #2 timing.** If #2 is the destination, is #1 worth doing as a bridge? Or just go straight to #2?
2. **If #2: write a spec.** GH#160 becomes the trigger; the spec should sequence the migration phases (backfill → view → consumer-rewrites → drop), with each phase shippable independently.
3. **If #1 only: simple PR.** ~2h work; closes GH#160 cleanly.
4. **Benchmark before deciding.** The read-perf concern in #2 is the main reason to choose #1 first. A ~1 day spike to measure sidebar render time with a synthetic 200-session load would either justify or kill the worry.
