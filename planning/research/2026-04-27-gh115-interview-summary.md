---
date: 2026-04-27
topic: "GH#115 — worktree as first-class reservable resource — P1 interview summary"
type: interview
status: complete
github_issue: 115
inputs:
  - planning/research/2026-04-27-gh115-worktrees-first-class.md
---

# Interview summary — GH#115 / worktrees as first-class reservable resource

Produced by P1 interview on 2026-04-27. Every decision below is locked
and maps to at least one behaviour in the forthcoming spec. Open risks
called out at the end.

**Headline reframe from the interview:** in duraclaw vocabulary, "worktree"
means a **full clone** under `/data/projects/<name>`, not a `git worktree`
sub-tree. Bootstrapping a clone is an operator gesture (`scripts/setup-clone.sh`),
not a duraclaw action. GH#115 is therefore a **registry over pre-existing
clones**, with **zero git operations in the orchestrator/gateway path**.
This collapses several open questions in the research doc.

## Decisions (grouped by category)

### A. Data model & migration

| # | Decision | Reasoning |
|---|---|---|
| A1 | **Replace `worktreeReservations` via reshape migration** — the existing lock table evolves into `worktrees` with surrogate `id`, `path`, `branch`, `status`, `reservedBy: json`, `released_at`. No coexistence. | One state machine, one source of truth. Existing issue-bound mutex collapses to `reservedBy: {kind:'arc', id:<issueNumber>}`. Touches the ~6 callsites enumerated in research doc. |
| A2 | **`worktreeId` FK on `agent_sessions`** (issue body acceptance criterion). Future `arcs.worktreeId` plugs in alongside; sessions can override the arc's default per-session. | Locked by issue body. Lets session-scoped reservations work without an arc, and lets future arcs offer a default that individual sessions override (side-arc case). |
| A3 | **`kataIssue` stays as chain identity** — untouched by this migration. The 25+ `kataIssue` callsites continue to mean "which GH issue does this session belong to," not "which worktree." Only the worktree-key sites (`auto-advance.ts:185`, `checkout-worktree.ts:60,100`, `status.ts:199–215`) shift to `worktreeId`. | Decoupling is the point of GH#115. Don't conflate two distinct concerns into the migration. |
| A4 | **Drop `agent_sessions.worktreeInfoJson`** (added by migration 0016, never read or written). Replaced by structured `worktreeId` FK + JOIN to `worktrees`. | Dead column; cleanup belongs with the migration that supersedes it. |

### B. Discovery & registration

| # | Decision | Reasoning |
|---|---|---|
| B1 | **Gateway auto-discovers clones** under `/data/projects/` and INSERTs / UPDATEs `worktrees` rows on a periodic sweep. New clones from `setup-clone.sh` appear in the registry on next sweep, no operator gesture needed. | Reuses the existing project-enumeration pass (migration 0013 `projects` table). Lowest-friction onboarding for new clones. |
| B2 | **Auto-discovery classifies clones by HEAD branch:** | Heuristic that captures human intent. A clone on `main` is "scratch" / available; any feature branch implies someone is using it for ongoing work. |
| | — default branch (`main`/`master`) → `status: 'free'`, no `reservedBy` | |
| | — feature branch → `status: 'held'`, `reservedBy: {kind:'manual', id: null}` (or `id: <branchName>`) UNLESS overridden by ceremony (B3) | |
| B3 | **Setup ceremony can override classification** by writing `.duraclaw/reservation.json` at the clone root with explicit `{kind, id}`. Auto-discovery reads this file during the sweep and uses it instead of the branch-name heuristic. | Lets `setup-clone.sh --reserve-for arc:115` pre-bind a clone to an arc at bootstrap time. Optional escape hatch; not required for the dev clones. |
| B4 | **Setup ceremony owns branch creation, not the registry.** `scripts/setup-clone.sh` checks out whatever branch makes sense; registry observes it. No `git checkout` / `git branch` in the orchestrator or gateway code paths. | "No worktree ceremony" — user-stated invariant. Honors issue's stated non-goal "Changing the gateway's filesystem layout." |

### C. Allocation API

| # | Decision | Reasoning |
|---|---|---|
| C1 | **`POST /worktrees { kind: 'fresh' }`** — registry picks any clone with `status='free'` and reserves it. Caller doesn't specify a name. | Pool-pick semantics. Matches the debug/freeform UX target ("just give me somewhere to work"). |
| C2 | **`GET /worktrees`** — list all (filterable by `status`, `reservedBy.kind`, `reservedBy.id`). | Required by issue acceptance criteria. |
| C3 | **`POST /worktrees/:id/release`** — mark `released_at = now()`. Defers actual deletion to the janitor (D2). | Required by issue acceptance criteria. |
| C4 | **`DELETE /worktrees/:id`** — force-delete (admin only). Bypasses the grace window. | Required by issue acceptance criteria. Operator escape hatch when something is genuinely wedged. |
| C5 | **No caller-specified name in v1** — only `kind: 'fresh'`. If a future need to reserve a specific clone arises, add `POST /worktrees { name }` as a v2 endpoint. | YAGNI. Auto-discovery + pool-pick covers all four GH#115 cases. |
| C6 | **Pool-exhaustion response: HTTP 503 with operator hint.** Body: `{error: 'pool_exhausted', freeCount: 0, totalCount: N, hint: 'SSH to VPS and run scripts/setup-clone.sh ...'}`. Caller (kata/UI) surfaces the hint to the user. | Keeps duraclaw out of the clone-creation business. Operator has full control over disk usage and clone topology. |

### D. Reservation lifecycle

| # | Decision | Reasoning |
|---|---|---|
| D1 | **Session/arc close → mark `released_at = now()`.** Session-bound reservations release when the session closes (`status` transitions to `completed`/`error`/`stopped`/`failed`). Arc-bound reservations release when the **last** session in the arc closes (chain terminates). | Symmetric with today's session-bound reservation idea. Arc-bound semantics match the existing chain pattern (research doc § 5: chain summaries already account for the multi-session-per-reservation case). |
| D2 | **Janitor deletes reservations where `released_at < now() - idle_window`.** Default `idle_window = 24h`, configurable per `worktrees.idle_window_secs` (or env var). | The 24h grace allows recovery: if a user re-opens within the window, the same reservation re-binds. Aligns with existing `worktreeReservations.stale` 24h cutoff (research doc § 1). |
| D3 | **Re-attach during grace window: NULL out `released_at`.** A new session reserving the same clone (same `reservedBy`) within the grace clears the release marker; reservation continues. | Naturally handles flap (close → re-open within minutes). No special "revive" endpoint needed; it's just another `POST /worktrees`. |
| D4 | **Status enum: `'free' | 'held' | 'active' | 'cleanup'`.** | |
| | — `free`: no reservation, available for fresh-pick | |
| | — `held`: reservation exists, no active session connected yet | |
| | — `active`: reservation exists AND ≥1 session has a runner connected | |
| | — `cleanup`: `released_at IS NOT NULL`, awaiting janitor | |
| | (`'cleanup'` is sugar for `released_at IS NOT NULL` — may be a derived view rather than a stored column; spec phase decides.) | |

### E. Concurrency / sharing

| # | Decision | Reasoning |
|---|---|---|
| E1 | **`reservedBy.kind` encodes sharing policy:** | The kind itself is the policy; no separate `sharing` column. |
| | — `arc` → **shared** (N sessions allowed in same clone) | Today's chain behavior — multiple kata-mode sessions in one issue's clone. |
| | — `session` → **exclusive** (1 session only; second attach → 409) | Debug/freeform isolation: one focused investigation per clone. |
| | — `manual` → **shared** (N sessions allowed) | "I'm working in this clone" — user wants to spawn multiple sessions there. |
| E2 | **Cross-reservation conflict on the same path → 409 Conflict.** Two distinct reservations cannot coexist on one clone. The 409 response includes the existing `reservedBy` so the caller can explain who holds it. | Mutual exclusion at the path level. The existing `worktreeReservations` table already enforces this (PK on `worktree`); the new schema preserves it (UNIQUE on `path`). |
| E3 | **Same-`reservedBy` re-acquisition is idempotent.** A repeat `POST /worktrees { kind:'fresh', reservedBy: {arc, 115} }` after one is already held returns the existing reservation, doesn't 409. Same as today's `auto-advance.ts:60` same-chain-idempotency check. | Avoids breaking auto-advance, which retries checkouts during chain progression. |
| E4 | **Token-rotation concurrency at the runner layer is unchanged.** "One runner per session" stays enforced by `runner-link.ts:280–313` (close 4410 → mint new token). The reservation layer doesn't touch this. | Different concern, different layer. The path-level lock is sharing; the runner-level lock is "one process binding." Both stay. |

### F. kata CLI integration

| # | Decision | Reasoning |
|---|---|---|
| F1 | **Code-touching modes auto-reserve** when entered without an existing reservation. | Modes `debug`, `implementation`, `verify`, `task` call `POST /worktrees { kind:'fresh', reservedBy: {kind:'session', id:<sid>} }` (or `{kind:'arc', id:<issue>}` if `--issue` given) before spawning the session. Zero extra user gesture. Matches issue acceptance criterion: "kata debug mode can open a session without an arc, with its own worktree." |
| F2 | **Read-only modes skip auto-reserve.** | `research`, `planning`, `freeform` don't reserve a clone (they don't need code-write isolation). Saves pool capacity for the modes that actually use it. |
| F3 | **`packages/kata/src/commands/enter.ts` is the auto-reserve insertion point.** A new helper (`reserveWorktreeIfNeeded`) sits between mode-validation and session-creation. | Single point of policy. If the mode's `code_touching` flag is true and the resolved kataIssue + worktree don't already pin a reservation, call the API. |
| F4 | **`POST /api/sessions { worktree?: WorktreeRequest }`** — the orchestrator API also accepts `worktree: 'fresh'` or `worktree: <id>` directly. Kata's auto-reserve uses this; manual UI flows can also use it. | Issue body shows `POST /sessions { worktree: { kind: 'fresh', branch?: ... } }`. Make this work end-to-end so non-kata callers (UI buttons, API clients) get the same primitive. |

### G. Janitor implementation

| # | Decision | Reasoning |
|---|---|---|
| G1 | **DO alarm-driven release** is the recommended shape. When a session closes and `released_at` is set, the SessionDO schedules an alarm at `released_at + idle_window`. Alarm fires → RPC to a sweep endpoint that DELETEs the row if `released_at` is still set. | Native to the orchestrator stack. Per-row scheduling avoids polling. Matches existing alarm patterns. |
| G2 | **Worker cron fallback for arc-bound and manual reservations** where no DO holds the alarm naturally. CF Workers cron runs hourly, queries D1 for `released_at < now() - idle_window`, deletes them. | Some reservation kinds don't have a session DO (manual). Cron is the catch-all. Implementation phase may decide to use only cron and skip alarms entirely — acceptable. |
| G3 | **Re-attach cancels the alarm implicitly.** When a session re-attaches and clears `released_at`, the alarm still fires but is a no-op (it re-checks `released_at IS NOT NULL` before deleting). No explicit alarm cancellation needed. | Idempotent design pattern. Alarms are cheap; just make the handler defensive. |
| G4 | **`POST /admin/worktrees/sweep`** as a manual escape hatch. Runs the same DELETE logic synchronously. | Operator/CI tool. Useful when D1 is in a known-stale state and waiting for the next cron tick is too slow. |

### H. Migration

| # | Decision | Reasoning |
|---|---|---|
| H1 | **Pre-clean stale rows before reshape.** Migration 0027 starts with `DELETE FROM worktreeReservations WHERE stale = 1`. Then `ALTER TABLE worktreeReservations RENAME TO worktrees` + `ALTER TABLE worktrees ADD COLUMN ...` for the new shape. | Cleanest migration. No orphan rows for the new janitor to clean up later. Stale rows are by definition not actively held — deletion is safe. |
| H2 | **Backfill `id`** with `lower(hex(randomblob(8)))` for existing rows. | Surrogate id is new; generate at migration time. |
| H3 | **Backfill `path`** as `'/data/projects/' || worktree`. | Reconstructs the absolute path from the project name (which was the old PK). |
| H4 | **Backfill `reservedBy`** as `'{"kind":"arc","id":' || issueNumber || '}'`. | All existing rows are issue-bound (today's only reservation kind). |
| H5 | **Backfill `status`** as `'held'` (existing rows are all active reservations after pre-clean). | After step H1, only non-stale rows survive; all are by definition held. |
| H6 | **Backfill `agent_sessions.worktreeId`** by joining on `kataIssue` + `project`: `UPDATE agent_sessions SET worktreeId = (SELECT id FROM worktrees WHERE worktrees.issueNumber = agent_sessions.kataIssue AND worktrees.path = '/data/projects/'||agent_sessions.project)`. Unmatched rows (sessions with `kataIssue IS NULL`) get `worktreeId = NULL`. | Connects existing sessions to their reshaped reservations. Sessions without reservations stay null — they'll auto-reserve next time they enter a code-touching mode. |
| H7 | **Branch column is NULL on migrate**, populated lazily by the gateway's first auto-discovery sweep. | Old `worktreeReservations` didn't track branch. Lazy populate avoids needing the gateway online during migration. |
| H8 | **`drop column worktreeInfoJson`** from `agent_sessions` in the same migration (A4). | Dead column cleanup. |

### I. Out of scope (confirmed)

| # | Decision | Reasoning |
|---|---|---|
| I1 | **`kata link` → D1 sync drift** stays a separate issue. `packages/kata/src/commands/link.ts:190` updates `state.json` but doesn't RPC orchestrator to update `agent_sessions.kataIssue`. Pre-existing bug, adjacent but distinct from worktrees. | Don't grow this spec's scope. File a separate GH issue when this lands. |
| I2 | **UI surface for worktree state** (per-session badge, kanban swim lanes, sidebar group, etc.) deferred to a follow-up issue. | Issue body explicitly scopes API + schema, not UI. |
| I3 | **Pool pre-warming / auto-creation of clones** is out of scope (issue Non-goals). Pool exhaustion returns 503; operator manually clones. | Strict adherence to issue body. May be revisited if pool exhaustion becomes a daily occurrence. |
| I4 | **Read-only / no-fs sessions** stay out of scope. Every session that needs a clone reserves one (research/planning/freeform skip the reservation entirely). | Issue Non-goals: "Every session reserves a worktree until proven otherwise — simpler invariant." We respect this for code-touching modes; read-only modes simply don't reserve. |
| I5 | **`forkWithHistory` worktree override** stays in scope (the side-arc case in the issue body) but the spec will frame it as: fork inherits parent's `worktreeId` by default; pass `worktreeId` parameter to override. No new git operations. | Smallest possible change to `branches.ts:300–304`. |

## Architectural bets

These decisions are hard to reverse later. The spec should call them out explicitly so reviewers can challenge them.

1. **Replace `worktreeReservations` with `worktrees`** — one-way migration. Rollback would require recreating the old table from a `worktrees` snapshot. Mitigation: take a D1 backup before running migration 0027.
2. **Auto-discovery as the registry's source of truth** — means the gateway must run the sweep consistently. If the gateway is down for hours, new clones aren't visible to callers. Mitigation: small sweep interval (60s); also sweep on `/sessions/start` lazily.
3. **Pool model with no auto-creation** — pool exhaustion is a real user-visible failure mode. Operational dependency: someone runs `setup-clone.sh` periodically. Mitigation: 503 hint surfaces clearly in UI; future v2 could add auto-clone trigger.
4. **Sharing policy from `reservedBy.kind` (no separate `sharing` column)** — means kind-to-policy mapping is hardcoded. Adding a new kind requires a code change + likely a migration. Mitigation: only three kinds today; if it grows, factor out.
5. **Branch is observed, not controlled** — if a session's `git checkout` mid-flight changes the clone's branch, the registry's `branch` column is stale until the next sweep. Mitigation: sweep is frequent; spec says `branch` is informational, not authoritative.

## Open risks

Decisions where the spec phase needs to nail down a sub-detail or where I see a potential issue.

1. **Re-attach authorization during grace window.** When `released_at` is set, who can `POST /worktrees/:id` to revive it? Same `reservedBy` only? Same userId? Anyone? — spec needs to define. Recommend: same `reservedBy.kind` + `id` only (so a debug session that closed can be re-opened by the same user, but not stolen by a different arc).
2. **Manual-reservation auto-classification edge case.** A clone discovered on a feature branch with no `.duraclaw/reservation.json` gets `reservedBy: {kind:'manual', id:null}`. If a session tries to reserve it via `kind:'fresh'`, the registry sees it as held and skips. Need an explicit "claim this manual reservation" or "transfer" path. — may be covered by allowing `POST /worktrees/:id { reservedBy: <new> }` as a transfer endpoint, but spec must define.
3. **Branch sweep cadence vs. session-runner activity.** If runner does `git checkout` during a session, registry's `branch` column lags until next sweep. Probably acceptable as informational only, but worth flagging.
4. **Janitor: alarm vs. cron implementation.** User picked "DO alarm per reservation," but practical implementation may end up using a worker cron sweep (simpler for arc-bound and manual reservations that don't have a natural DO host). Spec should allow either; implementation phase picks.
5. **`auto-advance.ts` worktreeId resolution.** Today's `checkoutWorktree({issueNumber, worktree, modeAtCheckout})` becomes `worktreeId`-based. The chain successor's `worktreeId` is inherited from the predecessor's row. Spec must define the inheritance rule explicitly so the migration doesn't break in-flight chains.
6. **Migration safety.** The pre-clean step deletes stale rows. If a stale-marked row is somehow still active (data drift), the chain would lose its reservation. Mitigation: take D1 backup; document recovery path (`POST /worktrees` to re-create).

## Codebase findings (from research, restated for spec phase)

- `worktreeReservations` table at `apps/orchestrator/src/db/schema.ts:220–236` (migration 0009).
- `kataIssue` usage at 25+ callsites; classified in research doc.
- `agent_sessions.worktreeInfoJson` placeholder column at schema.ts:170 — unwired since migration 0016.
- `git worktree add` is **never run in the session-spawn pipeline.** Only `docs-runner/src/main.ts:92` uses it (manual bootstrap, separate concern).
- kata CLI at `packages/kata/src/commands/enter.ts:472–491` already supports issue-less mode entry; downstream `/api/chains/:issue/checkout` is the bottleneck.
- Token rotation at `runner-link.ts:280–313` enforces "one runner per session" — unchanged by this spec.
- Auto-advance worktree-key sites: `auto-advance.ts:181–201`, `checkout-worktree.ts:44–114`, `status.ts:199–215`.
- Fork-with-history at `branches.ts:239–307` — needs `worktreeId` parameter.

## Spec implementation phases (preview, for spec author)

The forthcoming spec will likely be structured as:

- **Phase P1: Schema + migration** — land `worktrees` table, `agent_sessions.worktreeId` FK, drop `worktreeInfoJson`, backfill.
- **Phase P2: Orchestrator API** — `POST /worktrees`, `GET /worktrees`, `POST /worktrees/:id/release`, `DELETE /worktrees/:id`. Also extend `POST /api/sessions` body with `worktree?:` parameter.
- **Phase P3: Gateway auto-discovery sweep** — enumerate `/data/projects/`, INSERT/UPDATE `worktrees` rows with classification heuristic (B2/B3).
- **Phase P4: Auto-advance + checkout-worktree refactor** — replace `(issueNumber, worktree, modeAtCheckout)` keying with `worktreeId` keying. Backward-compat for in-flight chains.
- **Phase P5: forkWithHistory worktreeId override** — add parameter to `forkWithHistoryImpl`.
- **Phase P6: kata CLI auto-reserve** — add `reserveWorktreeIfNeeded` helper; wire into `enter.ts` for code-touching modes.
- **Phase P7: Janitor (DO alarm + worker cron fallback)** — release-grace expiration logic.
- **Phase P8: Verification + dogfood** — verify `kata enter debug` (no `--issue`) reserves a fresh clone end-to-end; verify chain auto-advance keeps the same reservation; verify pool-exhaustion 503 surfaces correctly in the UI.

(Phase numbers are illustrative; spec writer may regroup.)
