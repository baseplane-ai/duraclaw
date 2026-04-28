---
date: 2026-04-27
topic: GH#115 — worktree as first-class reservable resource
type: feature
status: complete
github_issue: 115
items_researched: 5
---

# Research: GH#115 — Worktree as First-Class Reservable Resource

## Context

GH#115 proposes promoting worktree reservation from an implicit, kataIssue-coupled concern into a first-class entity. The user-facing motivation: standalone debug, freeform exploration, side-arc forks, and read-only analysis don't fit today's "issue owns a worktree" shape. This research maps the current state — data model, code paths, filesystem layout, decision points — so the spec author can scope the refactor confidently.

Five parallel deep-dives ran:
1. D1 schema & `kataIssue` usage map
2. Orchestrator session lifecycle (createSession, SessionDO, forkWithHistory, dial-back)
3. Gateway + runner spawn pipeline (filesystem, branch creation, cleanup)
4. kata CLI per-mode flows
5. Arc-model FK touchpoints (light)

## Scope

**Items researched:** schema, orchestrator, gateway+runner, kata CLI, arc FK target.
**Fields evaluated per item:** current behaviour, file:line citations, what blocks the four GH#115 cases, what changes for the spec.
**Sources:** all of `apps/orchestrator/src/`, `packages/agent-gateway/src/`, `packages/session-runner/src/`, `packages/kata/`, drizzle migrations, `planning/specs/`.

---

## Key surprises (read these first)

These reframe how to think about the spec:

1. **A reservation table already exists.** Migration `0009_worktree_reservations.sql` introduced `worktreeReservations` (`apps/orchestrator/src/db/schema.ts:220–236`) keyed by `worktree TEXT PK` (the **project name**, not a path) with `issueNumber`, `ownerId`, `heldSince`, `lastActivityAt`, `modeAtCheckout`, `stale`. **GH#115 is not "add reservation from scratch" — it's "promote this lock table into a proper resource entity with a surrogate id, decouple from issueNumber, and add an FK from `agent_sessions`."**

2. **Duraclaw never runs `git worktree add`.** Not in the gateway, not in the runner, not in kata. Worktrees on the VPS are pre-created out-of-band (manually, or by `scripts/setup-clone.sh` for dev worktrees, or by the docs-runner bootstrap for that one specific runner). The runner just resolves `cmd.project` → `/data/projects/{name}` and assumes the directory exists (`packages/session-runner/src/project-resolver.ts:18–32`). **"Reserve a fresh worktree" implies a new responsibility someone has to own.**

3. **`worktreeReservations.worktree` is the project name string, not a path.** The actual filesystem path `/data/projects/{name}` is computed downstream in the runner. The orchestrator currently has no concept of an absolute path or a branch. Schema column `agent_sessions.worktreeInfoJson` (migration 0016) was added as a placeholder for "carry path/branch on the session" but is **unwired today** — defined in schema, never read or written.

4. **No arc concept exists in code.** Grep returned zero hits for "arc" as an entity. `planning/specs/116-*.md` doesn't exist. **The FK target `arcs.worktreeId` is forward-looking; we should land GH#115 with a clean shape that the future arc table can plug into without further migration.**

5. **kata CLI is not the bottleneck.** All seven modes (debug/freeform/task/implementation/planning/research/verify) already enter without an issue if `--issue` is omitted (`packages/kata/src/commands/enter.ts:472–491`). `kataIssue: null` flows through `createSession` and persists fine. **The bug is the `/api/chains/:issue/checkout` endpoint requiring `:issue` in the URL** (`apps/orchestrator/src/api/index.ts:2814`) — that's why a debug session can't reserve a worktree today.

6. **Concurrency is "one runner per session," not "one runner per worktree."** Token rotation (`runner-link.ts:280–313`) closes any previous gateway WS with code 4410 before accepting a new one — enforced by DO id, not path. Multiple runners CAN run concurrently in the same `/data/projects/{name}` filesystem today. The lock that prevents two issues from owning the same project is `worktreeReservations`, but two sessions in the same chain can race.

---

## Findings

### 1. Current data model

**`agent_sessions`** (`apps/orchestrator/src/db/schema.ts:127–184`) — 22+ columns. Worktree-relevant:
- `project: text` — project name string; doubles as worktree key downstream
- `kataIssue: integer NULL` — GitHub issue number; chain identity AND implicit worktree-reservation key
- `worktreeInfoJson: text NULL` — placeholder column, **never read or written** in code today (migration `0016`)
- 4 indexes, none on a worktree id

**`worktreeReservations`** (`schema.ts:220–236`) — the existing lock:
- `worktree TEXT PK` (project name, NOT a path)
- `issueNumber INTEGER` (no DB-level FK; index `idx_wt_res_issue`)
- `ownerId` (FK → users), `heldSince`, `lastActivityAt`, `modeAtCheckout`, `stale`
- Created by migration `0009_worktree_reservations.sql`

**`projectMetadata`** (`schema.ts:314–322`) — per-project metadata, holds `docsWorktreePath` for docs-runner integration. Not a session grouper. Distinct PK (`projectId`, sha-based) from `agent_sessions.project` (name).

**Migration timeline relevant to worktrees:**
| Migration | Change |
|---|---|
| `0006_agent_sessions.sql` | Created `agent_sessions` with `kataIssue` (stable since) |
| `0009_worktree_reservations.sql` | Added the lock table |
| `0016_session_state_columns.sql` | Added unused `worktreeInfoJson` placeholder |
| `0026_project_metadata.sql` | Added per-project metadata for docs-runner |

### 2. `kataIssue` usage map (25+ callsites, classified)

The deep-dive reported every `kataIssue` reference, classified read / write / pass-through / worktree-key / identity. Highlights:

**Identity (chain coordination — must remain even after worktree decoupling):**
- `lib/chains.ts:347` — chain aggregation `WHERE kataIssue = ?`
- `lib/auto-advance.ts:160` — successor idempotency gate `WHERE (kataIssue, kataMode) = (?, ?)`
- `lib/auto-advance.ts:117` — per-chain auto-advance preference lookup keyed by `String(kataIssue)`
- `agents/session-do/mode-transition.ts:264` — prior-artifacts query for preamble building

**Worktree-key (sites that conflate chain identity with worktree identity — the load-bearing knot):**
- `lib/auto-advance.ts:185` — `checkoutWorktree({ issueNumber: kataIssue, worktree: project, modeAtCheckout })` — the only call that bridges chain-id to reservation
- `lib/checkout-worktree.ts:60,100` — same-chain idempotency on `existing.issueNumber === issueNumber`
- `agents/session-do/status.ts:199–215` — reservation `lastActivityAt` refresh keyed by `(kataIssue, project)`

**Identity stays. Worktree-key changes.** The spec's job is to teach the worktree-key sites to operate on `worktreeId` while leaving the identity sites untouched.

### 3. Orchestrator session lifecycle

**`createSession` flow** (`lib/create-session.ts:48–204`):
1. Validate `kataIssue` shape (line 61–65)
2. `projectPath = resolveProjectPath(env, params.project)` — gateway lookup, no override (line 67)
3. D1 INSERT first (must exist before DO spawns) — `kataIssue` persisted at line 125
4. POST to SessionDO `/create` with `{project, project_path, prompt, ...}` (line 161–180)
5. Broadcast row delta + chain delta if `kataIssue` set (line 192, 199)

**SessionDO meta** (`agents/session-do/index.ts:96–138`): holds `project` and `project_path` — **today they are always equal** (`rpc-lifecycle.ts:82`: `project_path: config.project`). The DO is mostly worktree-agnostic; the worktree identity rides on `project` through to the gateway dial.

**`forkWithHistory`** (`agents/session-do/branches.ts:239–307`):
- Drops `runner_session_id` → fresh runner (line 294–298)
- Rebuilds prompt with `<prior_conversation>` prefix (line 249–264)
- Triggers `execute` dial with `project: ctx.state.project` (line 300–304) — **no override; child shares parent's worktree**
- `kataIssue` is NOT carried forward; child has `kataIssue: null` (intentional today, but means forks lose chain identity)

**Dial-back transport** (`packages/shared-transport/src/dial-back-client.ts`):
- WS routes by DO id, not path
- Token rotation (close 4410 → mint new token → POST) enforces "one runner per session"
- Backoff `[1s, 3s, 9s, 27s, 30s]`, gives up after 20 failures with no stable window

**Per-session worktree-policy decision points** (full list with file:line is in the agent's report; condensed):

| Phase | File:Line | Decision |
|---|---|---|
| Create | `create-session.ts:67` | `resolveProjectPath(project)` — **hard-coded, needs path override** |
| Spawn | `rpc-lifecycle.ts:82` | `project_path: config.project` — **needs override** |
| Dial | `runner-link.ts:300–304` | Builds gateway command with `project` only |
| Auto-advance | `auto-advance.ts:181–201` | `checkoutWorktree(...)` — current bridge between chain and worktree |
| Fork | `branches.ts:300–304` | Inherits parent `project` — **needs override** |
| Send (orphan) | `rpc-messages.ts:137–171` | Calls `forkWithHistoryImpl` for orphan auto-recovery |
| Stub | `status.ts:219–238` | `syncWorktreeInfoToD1` — defined but never called |

### 4. Gateway + runner spawn pipeline

**`POST /sessions/start`** (`packages/agent-gateway/src/handlers.ts:128–204`):
1. Validate body has `callback_url`, `callback_token`, `cmd` (shallow)
2. `sessionId = randomUUID()` (no path-based id)
3. Write `cmdFile`, prepare `pidFile`/`exitFile`/`metaFile`/`logFile` under `$SESSIONS_DIR` (default `/run/duraclaw/sessions/`)
4. `findSessionRunnerBin()` — walks `node_modules/@duraclaw/session-runner/dist/main.js`
5. `spawn(bin, [sessionId, cmdFile, callbackUrl, callbackToken, pidFile, exitFile, metaFile], { detached: true, stdio: [ignore, log, log] })` — fire-and-forget
6. Return `{ ok: true, session_id }` synchronously

**Note:** the gateway logs `worktree=` from `cmd.worktree` (line 183–184) but never uses it — purely observational.

**Path resolution** (`packages/session-runner/src/project-resolver.ts:18–32`):
- Formula: `/data/projects/{cmd.project}` (validated against `PROJECT_PREFIXES` allow-list)
- Verifies `.git` exists, returns absolute path
- **No branch awareness, no `git worktree` knowledge**

**Runner-side worktree state**: argv-driven, knows only `cmd.project`. Doesn't switch dirs/branches. Doesn't run any git commands at startup.

**Filesystem layout (today):**
```
/run/duraclaw/sessions/        # tmpfs, 0700 — control state
  {sessionId}.cmd              # gateway → runner
  {sessionId}.pid              # runner liveness
  {sessionId}.meta.json        # runner heartbeat (every 10s)
  {sessionId}.exit             # runner terminal write
  {sessionId}.log              # spawn stdout+stderr
/data/projects/{name}/         # project root (worktree assumed pre-existing)
  .git/
  .kata/sessions/{sdkSessionId}/state.json   # kata state, runner reads only
```

**Reaper** (`packages/agent-gateway/src/reaper.ts`, every 5min):
- Reaps `.pid` files (stale >30min → SIGTERM with 10s SIGKILL fallback)
- GCs orphan `.cmd` files (>5min)
- GCs terminal files (`.exit`, `.pid`, `.meta.json`, `.log`, `.cmd`, `.meta.json.gap`) >1h old
- **Never touches git state — no `git worktree remove`, no path-level cleanup**
- RPCs decisions back to DO via `recordReapDecision` (CLAUDE.md `reap` tag)

**Concurrency:** the runner's `hasLiveResume` guard (`main.ts:96–140`) prevents a second `resume` against an already-running `runner_session_id`, but that's session-scoped, not path-scoped. Two distinct sessions can spawn runners in the same `/data/projects/{name}` simultaneously.

### 5. kata CLI per-mode flows

| Mode | `issue_handling` | Issue req at entry? | `kataIssue` value | Worktree creation? |
|------|------------------|---------------------|-------------------|--------------------|
| planning | required | No (UX hint only) | passed if `--issue=N`, else null | No (kata side) |
| implementation | required | No (UX hint only) | passed if `--issue=N`, else null | No |
| task | none | No | null | No |
| freeform | none | No | null | No |
| debug | none | No | null | No |
| verify | none | No | null | No |
| research | none | No | null | No |

`issue_handling: "required"` is **declared in `packages/kata/batteries/kata.yaml`** but only enforced as a UX hint in `packages/kata/src/commands/suggest.ts:284` — not as a blocker at `kata enter`. Spec-expansion modes (planning, implementation) do fail if `--issue=N` is passed but the spec file is missing (`enter.ts:497–546`), but `--issue` itself is optional.

**Kata runs no git commands.** No `git worktree add`, no branch ops anywhere in `packages/kata/`. The blocker for arc-less worktree reservations is downstream — `/api/chains/:issue/checkout` requires an issue in the URL path.

**`kata link <issue>`** (`packages/kata/src/commands/link.ts:190`): updates `.kata/sessions/{id}/state.json` locally with new `issueNumber`, but **does not RPC the orchestrator to update `agent_sessions.kataIssue`** in D1. This is a pre-existing drift bug — out of scope for GH#115, but worth a separate issue.

### 6. Arc-model FK touchpoints (light)

**No arc table or concept in code.** Closest analogous pattern is the `ChainSummary` shape (`apps/orchestrator/src/lib/types.ts:228–251`): an `issueNumber` logically groups multiple sessions and (optionally) one `worktreeReservation`. Code at `project-display.ts:138–146` already handles "multiple sessions in one worktree" with `a/b/c` suffixes.

**Natural FK target shape** (forward-looking, for whoever drafts GH#116):
```
arcs {
  id            text PK
  issueNumber   integer NULL  -- chain link, optional
  worktreeId    text FK -> worktrees.id  -- ONE worktree per arc (default)
  ...
}
agent_sessions {
  id            text PK
  arcId         text FK -> arcs.id NULL  -- many sessions per arc
  worktreeId    text FK -> worktrees.id NULL  -- inherited from arc, or session-scoped
  kataIssue     integer NULL  -- chain identity, kept distinct from worktreeId
  ...
}
```

**Caveat:** unknown today whether arcs can own multiple worktrees (side-branch scenario). If yes, an `arc_worktrees` junction table or sessions holding their own `worktreeId` becomes necessary. **Recommend GH#115 puts `worktreeId` on `agent_sessions` directly so each session can override the arc's default** — that way the side-branch case "just works" once arcs land.

---

## The four GH#115 cases — what specifically breaks today

| Case | What works today | What breaks today | Root cause |
|------|-------------------|-------------------|------------|
| **1. Standalone debug** | `kata enter debug` creates a session with `kataIssue: null` | Cannot reserve a worktree — `/api/chains/:issue/checkout` requires an issue. Session ends up sharing whatever `/data/projects/<project>/` the user happened to point at. | Reservation API is issue-keyed; no per-session reservation path |
| **2. Freeform exploration** | `kata enter freeform` works without `--issue` | Same as debug: no way to reserve a fresh worktree from this entry point | Same as above |
| **3. Side-arc on a separate branch** | `forkWithHistory` produces a fresh runner with prior context | Fork unconditionally inherits parent's `project` (`branches.ts:302`); no path or branch override; child's `kataIssue` is dropped to null, losing chain link if you wanted one | `forkWithHistoryImpl` signature has no path/branch param |
| **4. Read-only analysis** | Multiple runners can already share a `/data/projects/{name}/` path (no path-level lock) | Each session still consumes a `worktreeReservations` slot if its mode is code-touching, blocking other chains. No "no-reservation-needed" mode. | All code-touching modes auto-checkout via `auto-advance.ts:181`; no opt-out |

---

## Existing primitives we can reuse vs. what's missing

### Reusable
- **`worktreeReservations` table** — already does mutual exclusion, has `lastActivityAt` for idle detection and `stale` flag (24h grace). Promote it to first-class by adding a surrogate id and decoupling `issueNumber` from PK semantics.
- **`worktreeInfoJson` placeholder** on `agent_sessions` — wire it (or replace with structured columns).
- **`project_path` field on SessionMeta** — designed to be override-able; today equals `project`. Wire the override.
- **Token-rotation concurrency model** — already enforces "one runner per session." Don't change.
- **Reaper RPC pattern** — `recordReapDecision` is the right shape for "janitor reclaimed worktree" events. Extend it.
- **Auto-advance idempotency** (`auto-advance.ts:160`) — keep keyed on `(kataIssue, kataMode)` for chain identity; just change the `checkoutWorktree` call inside it to use `worktreeId`.

### Missing — the spec's net-new pieces
- **`worktrees` table** with surrogate `id text PK`, `path`, `branch`, `baseBranch`, `status` (`free`/`held`/`active`/`cleanup`), `reservedBy: json` (`{kind, id}`), timestamps. Likely supersedes `worktreeReservations` (could be a renaming + reshape migration, or live alongside as a transition step).
- **`worktreeId` FK column on `agent_sessions`** — the bridge that 25+ callsites can read instead of going via `kataIssue`.
- **Issue-less reservation API**: `POST /worktrees`, `GET /worktrees`, `POST /worktrees/:id/release`, `DELETE /worktrees/:id` per the issue body.
- **`createSession` and `forkWithHistory` path/worktree override** — accept optional `worktreeId` (existing) or `worktree: { kind: 'fresh', branch?, baseBranch? }` (new reservation inline).
- **`git worktree add` invocation owner** — gateway is the natural home (it's already on the VPS with filesystem access). Needs a new gateway endpoint or a step inside `/sessions/start` that creates the worktree if `cmd.create_worktree` is set.
- **Worktree janitor** — separate from the runner reaper. Runs `git worktree remove` for `cleanup`-status rows after an idle window. Could be in the gateway (so it can touch the filesystem) with the orchestrator owning the SQL state machine.
- **`forkWithHistory` signature change** — accept optional `worktreeId` / branch; default to inherit parent.

---

## Migration / backfill concerns

1. **Existing `worktreeReservations` rows** (keyed by `worktree` PK = project name): need a synthetic `id` and need to be exposed as `worktrees` rows. Their `path` column needs to be backfilled — but the orchestrator doesn't know paths today. Options:
   - **Logical id** (`worktreeReservations.worktree` becomes the new `worktrees.id`, path stays NULL for existing rows, populated lazily). Lowest-risk migration.
   - **Physical reconciliation** (run `git worktree list` on the VPS during migration to populate paths). Higher fidelity but couples migration to gateway availability.
   - **Recommend** logical id with lazy path population.

2. **Existing `agent_sessions` rows**: need `worktreeId` populated. For rows where `kataIssue IS NOT NULL`, look up `worktreeReservations WHERE issueNumber = kataIssue AND worktree = project` and link. For rows with `kataIssue IS NULL`, leave `worktreeId NULL` (those sessions never reserved anything).

3. **Stale reservations** (`stale = 1` rows older than 24h): pre-clean before the migration, or migrate them in `cleanup` status so the new janitor can finish the job.

4. **No path/branch state to backfill** because the orchestrator never had it. New rows from this point onward will populate `path` and `branch` correctly; old rows remain logical-only.

5. **`scripts/export-do-state.ts`** (one-time DO→D1 cutover script, references `kata_issue`): obsolete post-migration; document as not-to-be-rerun.

6. **Drift between `worktreeReservations` and on-disk `git worktree list`**: today, nothing reconciles. The migration doesn't have to fix this — the new janitor will run `git worktree list` periodically once it's built.

---

## Open design questions (beyond the three already in the issue)

The issue lists three: auto-release-on-close, branch policy, concurrent-sessions-on-same-worktree. Research surfaced more:

**Q4. Does duraclaw run `git worktree add`, or assume the worktree exists?**
The issue body (Non-goals) says "this issue formalises the registry, not the layout." But cases 1, 2, 3 explicitly need a fresh worktree on demand — someone has to create it. Either:
- (a) duraclaw runs `git worktree add` from the gateway when `worktree.kind === 'fresh'`
- (b) duraclaw stays a registry; user is responsible for `git worktree add` and just registers the path
**Strong default: (a) for fresh-kind reservations.** Otherwise debug/freeform UX is "click button → error: directory doesn't exist." Recommend the spec covers (a) and notes (b) as a future "register existing path" sub-case.

**Q5. Where does the `worktrees` table live (D1) vs. where does `git worktree add` run (VPS)?**
Two-phase: orchestrator INSERTs `worktrees` row in `held` status → calls gateway to create the directory → on success transition to `active` (or `free` if held without a session) → on failure delete the row. This implies a new gateway HTTP endpoint (`POST /worktrees/create`) and a state machine. Alternative: orchestrator POSTs to gateway first, gateway returns the path, orchestrator inserts. Recommend the former (registry is source of truth, side-effect last).

**Q6. Is `worktrees` a replacement for `worktreeReservations`, or do both coexist?**
Two clean options:
- (a) Replace: rename + reshape migration; `worktreeReservations` becomes `worktrees` with new columns. All 6 callsites of `worktreeReservations` (chains.ts, checkout-worktree.ts, status.ts, auto-advance.ts) update.
- (b) Coexist: `worktrees` is the resource entity, `worktreeReservations` is the optional issue-bound lock. Sessions can reserve a worktree without an issue lock.
**Recommend (a): replace.** Coexistence proliferates state machines and the issue-bound use case is just `worktrees` with `reservedBy: { kind: 'arc', id: '<issue>' }`.

**Q7. What is "release" semantics?**
- Mark `cleanup` immediately on session close, vs. mark `cleanup` only on explicit `/release`?
- Janitor reclaims after configurable idle (issue suggests 24h)?
- Force-delete via `DELETE /worktrees/:id` runs `git worktree remove --force` synchronously?

**Q8. Multi-worktree-per-arc (forward-looking).**
If a future arc spawns a side-branch session, does the new session reserve its own worktree (`agent_sessions.worktreeId` overrides arc's default), or does the arc gain a second `worktreeId`? **Recommend per-session FK** — simpler.

**Q9. `kataIssue` as worktree-reservation key — backward-compat for old callers.**
Today's `auto-advance.ts:181` calls `checkoutWorktree({ issueNumber, worktree, modeAtCheckout })`. Post-spec, does this become `checkoutWorktree({ worktreeId })`? Or does the chain-flow auto-create a worktree row keyed by issue if none exists? **Recommend explicit:** chains hold a `worktreeId` (resolved at first checkout); `kataIssue` stays as chain identity, never as worktree identity.

**Q10. UI surface.**
Today the kanban shows a chain → multiple sessions → one reservation badge. Post-spec: where does the worktree show up in the UI? Per-session badge? Per-arc badge? Sidebar group? **Out of scope for the spec, but flag it for the implementation phase.**

**Q11. Out-of-band worktree creation (existing dev worktrees).**
The dev-up flow already creates `/data/projects/duraclaw-dev{1,2,3,4}` as worktrees. Should the orchestrator auto-discover these on first read and populate `worktrees` rows? Or only track worktrees it created? **Recommend latter** — simpler invariant; out-of-band worktrees stay invisible to the registry. The current gateway list-projects flow keeps working as today.

---

## Files / lines that will change in P2 spec (pointer list)

### Schema + migrations
- `apps/orchestrator/src/db/schema.ts:127–184` — add `worktreeId` column on `agentSessions`; consider whether to keep / remove `worktreeInfoJson`
- `apps/orchestrator/src/db/schema.ts:220–236` — replace `worktreeReservations` with new `worktrees` shape (or migrate inline)
- New migration file `apps/orchestrator/migrations/0027_worktrees_table.sql` (or similar)

### Orchestrator session lifecycle
- `apps/orchestrator/src/lib/create-session.ts:27–42` — add `worktree?: WorktreeRequest` to params
- `apps/orchestrator/src/lib/create-session.ts:67` — branch on caller-supplied path vs. `resolveProjectPath`
- `apps/orchestrator/src/lib/create-session.ts:125` — persist `worktreeId` alongside `kataIssue`
- `apps/orchestrator/src/agents/session-do/rpc-lifecycle.ts:82` — change `project_path: config.project` to honour caller override
- `apps/orchestrator/src/agents/session-do/branches.ts:239–304` (`forkWithHistoryImpl`) — accept optional `worktreeId` / `branch`; default to inherit
- `apps/orchestrator/src/agents/session-do/runner-link.ts:300–304` — extend GatewayCommand payload with explicit `worktree_path` / `branch` (vs. relying on `project`)
- `apps/orchestrator/src/agents/session-do/status.ts:219–238` — wire `syncWorktreeInfoToD1` (currently dead)
- `apps/orchestrator/src/lib/checkout-worktree.ts:44–114` — refactor to operate on `worktreeId` (or add a parallel issue-less path)
- `apps/orchestrator/src/lib/auto-advance.ts:181–201` — call new checkout API with `worktreeId`
- `apps/orchestrator/src/lib/chains.ts:337–354` — chain aggregation no longer joins via `worktreeReservations.issueNumber`; uses `agent_sessions.worktreeId` then resolves to `worktrees`

### API surface (new endpoints)
- `apps/orchestrator/src/api/index.ts` — add `POST /worktrees`, `GET /worktrees`, `POST /worktrees/:id/release`, `DELETE /worktrees/:id`
- `apps/orchestrator/src/api/index.ts:2814–2848` — keep `/api/chains/:issue/checkout` as a sugar wrapper that resolves chain → `worktreeId`, or deprecate in favour of `POST /worktrees` with `reservedBy: {kind: 'arc', id}`

### Gateway + runner
- `packages/agent-gateway/src/handlers.ts:128–204` — extend `/sessions/start` to accept `worktree_path` directly (not just `cmd.project`)
- New gateway endpoint `POST /worktrees/create` — invokes `git worktree add` synchronously, returns `{path, branch}`. Authenticated with `CC_GATEWAY_SECRET`.
- New gateway endpoint `POST /worktrees/:id/remove` (or part of janitor sweep) — invokes `git worktree remove`
- `packages/session-runner/src/main.ts:262, 302–308` — accept `worktree_path` from cmd if present, override `resolveProject`'s default
- `packages/session-runner/src/project-resolver.ts:18–32` — accept absolute path bypass when caller supplies it
- `packages/agent-gateway/src/reaper.ts` — extend or fork into a worktree-janitor that consumes `worktrees` registry state

### Shared types
- `packages/shared-types/src/index.ts` — extend `GatewayCommand` (`ExecuteCommand`, `ResumeCommand`) with optional `worktree_path` and `branch`; new types for `WorktreeRequest`

### Kata CLI (minimal change)
- No required changes for arc-less worktrees — kata already supports issue-less entry. Optional polish:
  - `packages/kata/src/commands/link.ts:190` — RPC orchestrator to sync `kataIssue` to D1 (separate issue, but call it out as adjacent)
  - `packages/kata/src/commands/enter.ts` — when entering a code-touching mode without a worktree, auto-call new `POST /worktrees` with `kind: fresh, reservedBy: {kind: 'session', id: sessionId}`. Optional UX win for debug/freeform.

### Config + docs
- `.claude/rules/session-lifecycle.md` — document new worktree-reservation flow
- `CLAUDE.md` (project) — note `worktrees` table among per-project state stores
- `planning/specs/27-docs-as-yjs-dialback-runners.md` — cross-link if docs-runner reservations migrate

---

## Recommendations

**1. Frame GH#115 as "promote `worktreeReservations` to a first-class entity," not "add reservation from scratch."**
The lock table already exists. The migration should reshape it (add surrogate id, path, branch, status enum, reservedBy json) rather than introduce a parallel structure.

**2. Make the orchestrator the registry; the gateway runs the side-effects (`git worktree add` / `git worktree remove`).**
This keeps D1 as the source of truth and matches the existing pattern where the gateway is a thin spawn/reap control plane. Two-phase commit: INSERT row → call gateway → mark `active` on success, delete on failure.

**3. Put `worktreeId` directly on `agent_sessions`, not just on (future) `arcs`.**
This makes session-scoped reservations natural (cases 1, 2, 4) and lets arc-scoped sessions inherit by default (case 3 covered too once arcs land). One migration; arcs plug in cleanly later.

**4. Keep `kataIssue` as chain identity, period.**
All 25+ callsites stay; only the `checkoutWorktree` bridge changes. Don't try to rename or merge `kataIssue` and `worktreeId`.

**5. Default to "duraclaw runs `git worktree add` for fresh-kind reservations."**
Otherwise the debug/freeform UX is "click and hope a directory exists." Stay closed to the simpler shape; "register existing path" can be a v2 sub-case.

**6. Replace `worktreeReservations`, don't coexist.**
The old table's job (issue-bound mutex) is just `worktrees` with `reservedBy: {kind: 'arc', id: <issue>}`. Coexistence multiplies state machines.

**7. New worktree-janitor is separate from the runner-reaper.**
Different cadence (daily? hourly?), different decisions (`git worktree remove`, not `SIGTERM`). Different RPC tag (`janitor` not `reap`). Lives on the gateway, reads `worktrees` registry via gateway→DO RPC.

**8. Out of scope for this spec — flag as follow-ups:**
- `kata link` syncing `kataIssue` to D1 (pre-existing drift)
- Auto-discovery of pre-existing on-disk worktrees
- UI surface for worktree state (per-session badge vs per-arc badge)
- Pre-warming / pooling (issue Non-goals already excludes)

---

## Open Questions (pull these into the P1 interview)

1. **Q4 from above** — duraclaw runs `git worktree add`, yes/no? (Recommend yes.)
2. **Q6** — replace or coexist? (Recommend replace.)
3. **Q7** — release semantics? Auto-mark on close vs. explicit?
4. **The three open questions in the issue body** (auto-release window, branch naming convention, concurrent-session-on-same-worktree policy)
5. **Q11** — auto-discover pre-existing worktrees, or require registration? (Recommend require.)
6. **Confirm GH#115 lands before any arc work** — the issue says split out for independence; check intent that arc-FK is forward-looking only.
7. **Janitor location** — gateway-resident vs orchestrator-cron? (Recommend gateway since it has fs access.)

---

## Next Steps

1. Mark P0 task complete in kata.
2. Move to P1: kata-interview, walking through Q4–Q11 above plus the issue's three.
3. After interview, P2: write the spec using the file:line pointer list as the implementation skeleton.
