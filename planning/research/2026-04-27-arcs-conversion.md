---
date: 2026-04-27
topic: arcs as first-class durable parent (chain → arc conversion)
type: feature
status: complete
github_issue: 116
items_researched: 5
---

# Research: Arcs as First-Class Durable Parent (GH#116)

## Context

GitHub issue #116 proposes replacing the computed "chain" aggregation
(`buildChainRow` + `chainsCollection` + `WHERE kataIssue = ?` queries)
with a first-class `arcs` table. An arc is the durable container for a
body of work — it holds the external ref (GH issue, Linear, etc.),
references a worktree reservation (via #115), and parents the sessions
that progress through phases. Kata terminology (`kataIssue`, `kataMode`,
`kataPhase`) leaves the schema entirely; kata becomes a consumer that
writes free-form `phase` strings into generic columns.

This research grounds the spec in the real shape of today's code so
that the P2 spec-writing phase can prescribe migrations and refactors
with file-line precision.

**User-confirmed scope decisions (locked at outline phase):**
- **#115 worktrees as hard dependency**, sequenced first
- **Single-drop migration with backfill** (one transaction)
- **Both `parentSessionId` (in-arc) and `parentArcId` (cross-arc)** in v1

## Scope

| Item | Subagent finding length | Sources |
|---|---|---|
| 1. Schema + chains aggregation | Exhaustive | `apps/orchestrator/src/db/`, `lib/chains.ts`, `api/index.ts`, migrations/ |
| 2. DO transition paths (mode-transition / auto-advance / fork) | Exhaustive | `agents/session-do/`, `lib/auto-advance.ts`, `packages/shared-transport/` |
| 3. UI routes + kanban + sidebar | Exhaustive | `routes/`, `features/kanban/`, `components/`, `apps/mobile/`, `packages/ai-elements/` |
| 4. Kata package phase writes | Exhaustive | `packages/kata/`, `.kata/kata.yaml`, hook contract |
| 5. GH#115 worktrees status | Tight | GH issue, `migrations/0009`, no PR/branch yet |

## Findings

### Item 1 — Schema + chains aggregation

**`agent_sessions` table** (`apps/orchestrator/src/db/schema.ts:127-184`)
22 columns; the three kata-linked columns are:
```typescript
kataMode: text('kata_mode'),       // line 160
kataIssue: integer('kata_issue'),  // line 161
kataPhase: text('kata_phase'),     // line 162
```
Plus `kataStateJson` (line 168 area) carrying the full `KataSessionState`
object as JSON. The 3 columns are essentially fast-index reads of the
JSON.

**Indexes** (lines 173-183): `runnerIdUnique`, `userLastActivity`,
`userProject`, `visibilityLastActivity`. **No index on kata columns** —
all `WHERE kataIssue = ?` queries are full table scans today.

**Migrations touching kata cols:**
- `0006_agent_sessions.sql` — initial creation of all three (2026-04-18)
- `0016_session_state_columns.sql` — adds `kataStateJson` (no kata-col change)
- No subsequent migration modifies them. Stable since 0006.

**`worktree_reservations` table** (`migrations/0009`, 2026-04-19) —
keyed on `(worktree, issue_number)`. **This table is silently
superseded** by #115's new `worktrees` table + `arcs.worktreeId` FK.
The single-drop migration must fold its data in.

**Read sites** (15 files, grouped by purpose):
1. **Query/Filter** — `lib/chains.ts:347` (`WHERE kataIssue = ?`),
   `api/index.ts:2659-2701` (DISTINCT scan + IN scan)
2. **Column derivation** — `lib/chains.ts:115-189` (`deriveColumn`,
   `COLUMN_QUALIFYING_MODES` set)
3. **Kanban grouping in sidebar** — `nav-sessions.tsx:395, 675`
4. **UI rendering** — `SessionCardList.tsx:32-43`
   (`KataBadge`), `status-bar.tsx:289-292`, `chain-status-item.tsx:181`
5. **Precondition gating** — `use-chain-preconditions.ts:125, 156, 188`
6. **RPC state detection** — `rpc-queries.ts:84`,
   `mode-transition.ts:33, 46, 51`
7. **Auto-advance dispatch** — `auto-advance.ts:141`

**Write sites** (4 entry points):
1. **Initial spawn** — `lib/create-session.ts:125, 199` (INSERT with
   optional `kataIssue` query param)
2. **Kata state sync** — `agents/session-do/status.ts:174-216`
   (`syncKataAllToD1`, the primary path; called from
   `gateway-event-handler.ts` on `kata_state` events)
3. **Broadcast triggers** — `lib/broadcast-chain.ts:31-71`,
   `agents/session-do/broadcast.ts:259-280`
4. **Auto-advance successor** — `features/kanban/advance-chain.ts`
   (indirect via `createSession`)

**`ChainSummary` type** (`lib/types.ts:221-244`):
```typescript
interface ChainSummary {
  issueNumber: number
  issueTitle: string
  issueType: 'enhancement' | 'bug' | 'other' | string
  issueState: 'open' | 'closed'
  column: 'backlog' | 'research' | 'planning' | 'implementation' | 'verify' | 'done'
  sessions: Array<{ id, kataMode, status, lastActivity, createdAt, project }>
  worktreeReservation: { worktree, heldSince, lastActivityAt, ownerId, stale } | null
  prNumber?: number
  lastActivity: string
}
```

**`buildChainRow`** (`lib/chains.ts:331-360`): does NOT use SQL JOIN —
fetches sessions via `WHERE kataIssue = N`, then JS-groups them.
GH issues + PRs cached in module-level Maps with 5-min TTL
(`chains.ts:52-103`). Callers: `api/index.ts:2734`,
`broadcast-chain.ts:45`, `agents/session-do/broadcast.ts:267`.

**`chainsCollection`** (`db/chains-collection.ts:31-48`):
TanStack DB synced collection, `id: 'chains'`, `syncFrameType: 'chains'`,
keys by `issueNumber.toString()`, persistence-backed (OPFS), no
optimistic mutations (server-authoritative). Subscribers:
`KanbanBoard.tsx:78`, `KanbanLane.tsx`, `KanbanColumn.tsx`,
`KanbanCard.tsx`, `chain-status-item.tsx:158`.

**`/api/chains` handler** (`api/index.ts:2636-2766`): DISTINCT scan
on `kataIssue`, IN-list bulk fetch, JS join, build `ChainSummary[]`,
filter by user/lane/column/project/stale, sort by lastActivity DESC.
Sibling routes: `POST /api/chains/:issue/checkout`,
`/release`, `/force-release`, `GET /api/chains/:issue/spec-status`,
`/vp-status`.

**Tests touching kata cols / chains** (10+):
`lib/chains.test.ts`, `hooks/use-chain-preconditions.test.ts`,
`features/kanban/advance-chain.test.ts`, `lib/auto-advance.test.ts`,
`lib/broadcast-chain.test.ts`, `agents/session-do.test.ts:1847`,
`features/agent-orch/SessionCardList.test.tsx`,
`features/agent-orch/__tests__/session-card-filters.test.ts`,
`packages/shared-types/src/index.test.ts`.

### Item 2 — DO transition paths

**Path A — `handleModeTransitionImpl`** (`agents/session-do/mode-transition.ts:111-228`)

- **DO id:** preserved — same SessionDO instance, same chat thread visually.
- **`runner_session_id`:** NOT cleared; lingers until new runner emits
  `session.init` (`gateway-event-handler.ts:83`). **Race window risk.**
- **Spawn type:** fresh `execute`, NOT `resume`. New runner gets an
  artifact-pointer preamble (lines 244-286) listing prior-mode
  evidence files.
- **Trigger:** `gateway-event-handler.ts:712` on `kata_state` event when
  `prev !== next` mode and `prev !== null` and `continueSdk !== true`.
- **Sequence:** broadcast `mode_transition` event → sleep 2s →
  close runner WS code 4411 → poll old runner exit (5s timeout) →
  build preamble → dial fresh runner.
- **Failure modes:** old runner won't exit (5s timeout, logs and
  proceeds; relies on token rotation 4410 to evict); preamble query
  unguarded (no LIMIT — could be expensive).

**Path B — `tryAutoAdvance` / `maybeAutoAdvanceChainImpl`** (`lib/auto-advance.ts:136-242` + `agents/session-do/mode-transition.ts:29-99`)

- **DO id:** **NEW** — `createSession()` mints a fresh row.
- **`runner_session_id`:** new (minted by new runner).
- **Spawn type:** fresh `execute` with synthesized prompt
  `"enter ${nextMode} --issue=${kataIssue}"`.
- **Trigger:** `gateway-event-handler.ts:656-660` on `stopped`
  terminal event (wrapped in `waitUntil`).
- **Gates:** non-core rung skip, terminal-rung skip, user pref check,
  idempotency (existing non-terminal successor → skip), `runEnded`
  evidence file check (GH#73), worktree availability (if
  `CODE_TOUCHING_MODES`).
- **Failure modes:** auto-advance idempotency race (two simultaneous
  terminal sessions could both create successors — no DB unique
  constraint on `(kataIssue, kataMode)`).

**Path C — `forkWithHistoryImpl`** (`agents/session-do/branches.ts:239-307`)

- **DO id:** preserved.
- **`runner_session_id`:** **explicitly cleared to null** (line 297) —
  this is the orphan-safety step.
- **Spawn type:** always fresh `execute` with `<prior_conversation>`
  wrapper (lines 263-265).
- **Transcript:** full local DO history serialized via
  `serializeHistoryForFork()` (lines 121-142): `User: ...`,
  `Assistant: [thinking] ... [used tool: foo] ...`, joined.
- **Two callers:**
  - **Orphan path** — `sendMessageImpl` preflight detects orphan via
    gateway `listSessions` (`rpc-messages.ts:154-171`), auto-delegates.
  - **Intentional path** — explicit RPC `forkWithHistory()`
    (`index.ts:431-434`).

**`triggerGatewayDial` discriminator** (`runner-link.ts:197-371`):
8 callers; `execute` for spawn/mode-transition/fork, `resume` for
idle-resume/reattach/sendMessage-resumable.

**Reaper** — gateway-driven; DO logs decisions via `recordReapDecision`
RPC (`index.ts:416-422`): `skip-pending-gate` / `kill-stale` /
`kill-dead-runner`. DO does NOT clear `runner_session_id` on reap;
preserved for next-message resume attempt.

**`<prior_conversation>` template** (`branches.ts:263`):
```
<prior_conversation>
{transcript}
</prior_conversation>

Continuing the conversation above. New user message follows.

{nextText}
```
**Only used in `forkWithHistory`** — mode transitions and auto-advance
do NOT wrap. They start fresh with artifact preamble or no context.

### Item 3 — UI routes + kanban + sidebar

**Route tree** (`apps/orchestrator/src/routes/`):
```
/login, /maintenance, /_authenticated/{
  index (/), board (/board), session.$id (redirect),
  settings, deploys, admin.users, admin.codex-models
}
```
**No `/chain/:id` route exists** — chain identity is purely query-param
(`/?session=:id`). Chain is implicit: it's whichever issue the session
belongs to. Sessions are the actual tree.

**Kanban** (`features/kanban/`):
- `KanbanBoard.tsx:78` reads `useLiveQuery(chainsCollection)` →
  derives lanes (issue type) × columns (kanban phase)
- `KanbanCard.tsx:26` props: `chain: ChainSummary`
- Drag handler (`KanbanBoard.tsx:133`): strict single-step
  left-to-right; `checkPrecondition` → `AdvanceConfirmModal` →
  `advanceChain(chain, nextMode)` → POST `/api/sessions` with
  `{kataIssue, kataMode}`
- Lanes: `enhancement | bug | other` (LANES const, line 47)
- Columns: `backlog | research | planning | implementation | verify | done`
  (COLUMN_ORDER, line 49) — derived server-side from latest qualifying
  `kataMode`

**Sidebar** (`components/layout/nav-sessions.tsx`):
- Reads `sessionsCollection` (NOT `chainsCollection`) — sessions are
  the data; chain grouping is implicit via `kataIssue` filter
- 500ms long-press for context menu (line 116) — must NOT regress
  during rename (see `feedback_dnd_long_press.md` MEMORY)
- Two sections: "Recent" (flat) + "Worktrees" (tree)

**`ChainStatusItem`** (`components/chain-status-item.tsx`):
- `useLiveQuery(chainsCollection)` line 158
- Renders rung ladder (research → planning → impl → verify → close)
  for the current chain
- Line 231: literal text `"kata: {currentMode}/{currentPhase}"` — kata
  surface (separate concern from chain rename)

**Mobile** (`apps/mobile/`): thin Capacitor shell. No chain UI imports.
Zero-touch.

**ai-elements** (`packages/ai-elements/`): no chain components.
`ChainOfThought` exists but is reasoning-display UI (unrelated).

**Identifier sweep targets** (~150-180 changes across ~50 files):
- File renames: `chains-collection.ts → arcs-collection.ts`,
  `chain-status-item.tsx → arc-status-item.tsx`, `use-chain-*.ts`,
  `advance-chain.ts`, `broadcast-chain.ts`, etc.
- Type renames: `ChainSummary → ArcSummary`,
  `ChainBuildContext → ArcBuildContext`,
  `AdvanceChainResult → AdvanceArcResult`
- Open question: keep `KanbanBoard/Lane/Column/Card` (layout-pattern
  names) or rename to `Arc*` (domain names)?
- 8 user-facing strings: "Loading chains…", "No chains match…",
  "No chains yet. Spawn a session with a `kataIssue` tag…", etc.

**`KataStatePanel`** (`features/agent-orch/KataStatePanel.tsx`):
renders `Kata: {currentMode} / {currentPhase}` (line 34). **Separate
concern** from chain→arc rename — this is kata's own surface, not
chain aggregation.

### Item 4 — Kata package phase writes

**Kata never reads orchestrator state.** Pure producer:
- Writes `.kata/sessions/{sessionId}/state.json` via
  `state/writer.ts:writeState()` (atomic temp+rename)
- Validated against Zod `SessionStateSchema` (`state/schema.ts`)
- Runner reads this file periodically and emits `kata_state` events
  to the DO; DO syncs to `agent_sessions.kataMode/kataIssue/kataPhase`
  via `syncKataAllToD1()` (`status.ts:174-216`)

**Write sites for `currentMode`/`currentPhase`/`issueNumber`:**
- `commands/enter.ts:575-594` (registered modes) — sets
  `currentMode: canonical, currentPhase: phases[0], issueNumber: N`
- `commands/enter.ts:226-244` (custom templates) — same shape
- `commands/exit.ts:38-64` — clears: `currentMode: 'default',
  currentPhase: undefined`

**Modes** (`.kata/kata.yaml`): research, planning, implementation,
task, freeform, verify, debug. Phase IDs always `p{N}`.

**Phase advancement is via native tasks, NOT kata commands.**
`kata advance` is deprecated (`src/index.ts:75-84`). Phases progress
when their associated task is marked completed via `TaskUpdate`.
`kata can-exit` checks all-tasks-completed + stop conditions.

**Mode transitions are detected ORCHESTRATOR-side, not kata-side.**
`gateway-event-handler.ts:688-713` watches `kata_state.currentMode`
deltas and fires `handleModeTransitionImpl`. Kata is unaware.

**Free-form phase string proposal:** `<mode>:<phase-id>[#<issue>]`
- `planning:p0#116`, `impl:p1`, `research:p0`, `verify:p3`
- Round-trips kata's existing structure
- Validation belongs to kata (write-time) — orchestrator becomes
  passive reader

**Validation surface to relocate:** orchestrator currently does NO
enum validation on `kataMode` — D1 columns accept whatever the
runner emits. So the "kata as consumer" change is effectively
zero-effort on the validation side; just need kata to write
well-formed strings.

### Item 5 — GH#115 worktrees status

- **State:** OPEN, no PR, no feature branch, no spec doc
- **Proposed schema:**
  ```
  worktrees(id, path, branch, baseBranch, status,
            reservedBy json, createdAt, lastTouchedAt)
  ```
- **Legacy `worktree_reservations` table** (migration 0009, 2026-04-19)
  already exists — keyed on `(worktree, issue_number)`. **Implicitly
  coupled to `kataIssue`. Will be superseded entirely by #115's
  worktrees + #116's `arcs.worktreeId`.**
- **Three open questions in #115:** auto-release timing
  (24h idle vs immediate), branch creation policy
  (duraclaw mints vs accepts existing), concurrent sessions on the
  same worktree (allowed for arc-bound, disallowed for session-bound?)
- **Timeline risk:** medium-low likelihood of landing before #116
  starts. Recommend parallel work; #116 spec can reference #115 by
  shape and land sequenced.

## Comparison

### Three progression paths today vs. three primitives proposed

| Today's path | Same-DO? | new row? | xfer transcript? | Proposed primitive |
|---|---|---|---|---|
| `handleModeTransitionImpl` | yes | no | preamble only | **`advanceArc`** (now creates new session row) |
| `tryAutoAdvance` | no | yes | none | **`advanceArc`** (unified) |
| `forkWithHistoryImpl` (orphan) | yes | no | wrapped | **`rebindRunner`** (same row, swap runner_session_id) |
| `forkWithHistoryImpl` (branch) | yes | no | wrapped | **`branchArc`** (new arc with parentArcId, new session) |

**The collapse of `handleModeTransitionImpl` into `advanceArc` is a
UX-visible change.** Today, advancing research → planning preserves
the chat thread; under arcs, every phase change is a new session row,
shown as a phase timeline within the arc. **Interview must confirm.**

## Recommendations

1. **Sequence #115 before #116** (user-confirmed). Open a #115 spec
   doc in parallel with #116 spec writing so schema review can
   converge.

2. **Single-drop migration** absorbs both `kata*` columns AND the
   `worktree_reservations` table:
   - Create `arcs` (one per distinct `kataIssue` + one per
     orphan session)
   - Backfill `agent_sessions.arcId`, `agent_sessions.phase`
     (computed from kata cols), `agent_sessions.worktreeId`
     (from worktree_reservations join)
   - Drop `kataMode`/`kataIssue`/`kataPhase`/`worktree_reservations`
   - Add composite index `arcs(externalRef.id, status)` for kanban

3. **Three primitives map cleanly but with two notable adjustments:**
   - `advanceArc` collapses mode-transition AND auto-advance; **always
     mints a new session row** (today's same-DO mode transition is
     dropped). UI shifts to "phase timeline view per arc."
   - `rebindRunner` is NOT a fork — same DO, same row, just rotates
     `runner_session_id`. **Open question:** does it use SDK `resume`
     (clean swap) or wrap local history in `<prior_conversation>`
     (matches today's orphan path)?
   - `branchArc` always creates a NEW arc with `parentArcId`. The
     `<prior_conversation>` wrapper continues to apply for cross-arc
     branches. In-arc branches via `parentSessionId` are a separate
     UI affordance.

4. **Keep `Kanban*` component names** (KanbanBoard/Lane/Column/Card).
   They describe the layout pattern, not the domain. Rename only
   data-flow identifiers (`chainsCollection → arcsCollection`,
   `ChainSummary → ArcSummary`, etc.). This narrows the rename
   to ~80-100 identifiers from the ~150 worst-case.

5. **`KataStatePanel` and "Kata: mode/phase" labels stay** as-is.
   The issue's "drop kata terminology" applies to the SCHEMA, not
   to kata's own UI surface. Kata-the-methodology continues to exist
   as a consumer.

6. **Free-form phase format: `<mode>:<phase>[#<issue>]`** — readable
   in SQL, URL, and logs. Validation belongs to kata
   (`packages/kata/src/state/writer.ts` pre-write hook).

7. **Add unique constraint** on `arcs(externalRef.provider,
   externalRef.id)` to fix today's auto-advance idempotency race
   (today: no DB-level guard against duplicate successors).

## Open Questions

(Surface these in P1 interview before writing the spec.)

| Q | Decision needed |
|---|---|
| Q1 | Confirm "every phase change = new DO/session row" — drops same-DO mode transitions entirely? |
| Q2 | `rebindRunner` transcript strategy: SDK `resume` from on-disk session file, or wrap local DO history in `<prior_conversation>`? |
| Q3 | Migrate `worktree_reservations` → `arcs.worktreeId` in single-drop, drop legacy table? |
| Q4 | Kanban column derivation: parse `phase` string at query time, or store `arcs.currentColumn` shadow? |
| Q5 | Scope of `kata*` purge: includes UI labels in `KataStatePanel`, or only schema/aggregation? |
| Q6 | Endpoint mapping: `/api/chains/:issue/checkout` → `/api/arcs/:arcId/...` or relocate to `/api/worktrees/...`? |
| Q7 | Phase string format: `<mode>:<phase>[#<issue>]`, compact (`pl:p0/116`), or arbitrary kata-validated? |
| Q8 | Component naming: keep `KanbanBoard/Lane/Column/Card` (layout) or rename to `Arc*` (domain)? |
| Q9 | `runner_session_id` orphan-window risk in mode-transition collapse — explicit clear before dial, or rely on token rotation 4410? |
| Q10 | Auto-advance idempotency: add D1 unique constraint on `arcs(externalRef.provider, externalRef.id)` AND on `sessions(arcId, phase, status='running')`? |

## Next Steps

1. **P1 interview** — work through Q1-Q10 with the user, lock decisions.
2. **P2 spec writing** — `planning/specs/116-arcs-as-first-class-parent.md` with:
   - Schema migration (single-drop, with `worktree_reservations` absorbed)
   - Three new primitives (`advanceArc`, `branchArc`, `rebindRunner`) with file:line refactor targets
   - API surface mapping (chains routes → arcs routes)
   - Naming sweep checklist (file moves + type renames)
   - UI changes (kanban data source swap, phase-timeline view per arc)
   - B-IDs with acceptance criteria for each behavior
   - Implementation phases (sequenced after #115 lands)
3. **P3 review** — external review via kata-spec-review.
4. **P4 close** — push approved spec.
