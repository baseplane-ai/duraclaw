---
initiative: chain-ux
type: project
issue_type: epic
status: approved
priority: high
github_issue: 16
created: 2026-04-19
updated: 2026-04-19
child_features:
  - id: 3b
    name: Chain tab surface
    priority: P0
    status: draft
  - id: 3c
    name: Mode-enter session reset
    priority: P1
    status: draft
  - id: 3d
    name: Kanban home + swim lanes
    priority: P0
    status: draft
  - id: 3e
    name: Worktree checkout
    priority: P0
    status: draft
phases:
  - id: p1
    name: "Chain tab surface (3B)"
    tasks:
      - "Extend TabEntry with kind + issueNumber fields"
      - "Add chain cluster key logic to computeInsertOrder"
      - "Build /chain/:issueNumber route with mode-session timeline"
      - "Add chain tab icon + one-chain-per-issue enforcement"
    test_cases:
      - id: "chain-tab-create"
        description: "Opening a kata-linked session creates/reuses chain tab"
        type: "integration"
      - id: "chain-tab-cluster"
        description: "Chain tabs cluster by issue, not project"
        type: "integration"
      - id: "chain-route-timeline"
        description: "Chain route renders timeline with correct mode rows and artifact chips (B2)"
        type: "integration"
      - id: "chain-sidebar"
        description: "Sidebar collapses same-issue sessions under chain node with pipeline dots (B3)"
        type: "integration"
  - id: p2
    name: "Worktree checkout (3E)"
    tasks:
      - "Add worktreeReservations state to SessionDO"
      - "Build POST /api/chains/:issue/checkout, /release, /force-release"
      - "Build conflict UI modal + worktree picker lock badges"
      - "Add stale-reservation GC via Cron Trigger (hourly, 7d threshold)"
      - "Build POST /api/webhooks/github for issue.closed + PR.merged release"
    test_cases:
      - id: "wt-chain-reserve"
        description: "Chain entering impl reserves worktree, blocks others (B11)"
        type: "integration"
      - id: "wt-conflict"
        description: "Second chain gets conflict modal with owner details"
        type: "smoke"
      - id: "wt-release-auto"
        description: "Closing issue via GH webhook auto-releases worktree reservation"
        type: "integration"
      - id: "wt-stale-flag"
        description: "Reservation with no activity >7d is flagged as stale"
        type: "unit"
      - id: "wt-webhook-sig"
        description: "Webhook rejects requests with invalid X-Hub-Signature-256 (401)"
        type: "unit"
      - id: "wt-webhook-repo-filter"
        description: "Webhook ignores events from non-configured repos (200 no-op)"
        type: "unit"
      - id: "wt-force-release-nonstale"
        description: "Force-release on non-stale reservation returns 403"
        type: "unit"
      - id: "wt-checkout-idempotent"
        description: "Same chain re-checkout returns 200 with existing reservation (B12 idempotent path)"
        type: "unit"
  - id: p3
    name: "Kanban home (3D)"
    depends_on: [p1, p2]
    tasks:
      - "Build GET /api/chains endpoint (join GH issues + sessions)"
      - "Build /board route with column/lane layout"
      - "Build chain card component reusing chain-tab timeline dots"
      - "Add drag-to-advance with confirmation modal"
      - "Add new-card creation form on Backlog column"
      - "Build GET /api/chains/:issue/spec-status and /vp-status precondition endpoints"
      - "Add PR artifact chip to chain timeline row (data from ChainSummary.prNumber)"
    test_cases:
      - id: "kanban-render"
        description: "Board shows cards in correct columns derived from kataMode"
        type: "smoke"
      - id: "kanban-drag"
        description: "Dragging card between columns triggers mode transition"
        type: "integration"
      - id: "kanban-card-actions"
        description: "Start-next button enabled only when preconditions met, spawns correct mode"
        type: "integration"
      - id: "kanban-drag-reject"
        description: "Dragging card backwards or to non-adjacent column snaps back with toast"
        type: "integration"
  - id: p4
    name: "Mode-enter session reset (3C)"
    tasks:
      - "Add SessionDO mode-transition watcher on kata_state events"
      - "Implement close code 4411 (mode_transition) in DialBackClient"
      - "Build artifact-pointer preamble template"
      - "Add continue-sdk advisory hint to KataSessionState"
    test_cases:
      - id: "reset-on-mode"
        description: "Mode change in chain kills runner, spawns fresh with preamble"
        type: "integration"
      - id: "continue-sdk"
        description: "continue-sdk hint skips runner restart (B6)"
        type: "integration"
      - id: "reset-timeout"
        description: "Runner not exiting within 5s triggers token rotation + warning event, fresh spawn proceeds (B5 timeout path)"
        type: "integration"
      - id: "reset-degraded-preamble"
        description: "Chain history fetch failure produces degraded preamble, runner still spawns (B5 failure path)"
        type: "integration"
---

# Chain UX: chain tabs, session reset, kanban home, worktree checkout

> GitHub Issue: [#16](https://github.com/baseplane-ai/duraclaw/issues/16)

## Vision

A kata workflow is a **chain** of mode sessions against one piece of
work (research -> planning -> impl -> verify -> close). Today those
sessions float independently in the sidebar. Chain UX makes the chain a
first-class entity: a tab that groups mode sessions, a kanban board that
shows all chains at a glance, worktree reservations that prevent stomps,
and context resets that keep each mode lean.

Six months from now, starting new work is "click a card, pick a mode" -
not "find worktree, remember issue number, open session form."

## Problem Statement

1. **No chain surface.** Sessions cluster by project, not by issue. No
   route says "here are the four sessions for issue #42."
2. **Context bloat.** `kata enter` inside an existing session keeps the
   same `sdk_session_id`. By verify mode, the context window is full of
   stale research transcript.
3. **Silent worktree stomps.** `ProjectRegistry` locks per-session. When
   a runner dies, the lock drops. Two chains can grab the same worktree
   with no visible signal.
4. **No overview.** No place to see "what's in flight across the repo"
   grouped by mode phase and issue type.

## Success Metrics

- **Tab-click-to-context:** 1 click from kanban card to live session
  (currently: 3-4 clicks through sidebar + project + session)
- **Worktree conflicts caught before mutation:** 100% (currently: 0% -
  conflicts surface only as git errors)
- **Context budget per mode:** fresh ~0 tokens at mode start (currently:
  cumulative from prior modes)
- **Qualitative:** user says "I can see where everything is"

## Features in This Epic

| # | Feature | Priority | Status | Spec Section |
|---|---------|----------|--------|--------------|
| 3B | Chain tab surface | P0 | draft | [below](#feature-3b-chain-tab-surface) |
| 3C | Mode-enter session reset | P1 | draft | [below](#feature-3c-mode-enter-session-reset) |
| 3D | Kanban home + swim lanes | P0 | draft | [below](#feature-3d-kanban-home--swim-lanes) |
| 3E | Worktree checkout | P0 | draft | [below](#feature-3e-worktree-checkout) |

## Dependencies

- **Requires:** GH#12 (TanStack DB unification) before 3C ships -
  single state channel avoids runner-exit / DO-state race
- **Requires:** GH#14 (message transport on DB) for clean transcript
  boundaries in 3B/3D - different `sdk_session_id` per row
- **Enables:** Auto-advance (3F, deferred) - "Continue to <next>" on
  chain rows
- **Enables:** 3A (kata upstream) - promote-to-issue at research close

## Non-Goals

- 3A (kata upstream - promote at research close). Kata concern, tracked
  in kata repo.
- 3F (auto-advance affordances). Deferred until B+C+D+E ship.
- Multi-repo chains (one chain spanning multiple projects).
- Real-time collaborative editing within a chain (two users in same
  session).

---

## Feature 3B: Chain Tab Surface

### B1: Chain tab creation and clustering

**Core:**
- **ID:** chain-tab-create
- **Trigger:** User opens a session that has `kataIssue` set, OR navigates to `/chain/:issueNumber`
- **Expected:** A chain tab appears (or is reused) with `kind: 'chain'` and `issueNumber` as the cluster key. If a chain tab for this issue already exists, the existing tab is focused (one-chain-per-issue-per-user). If not, a new chain tab is inserted after the last tab with the same project.
- **Verify:** Open two sessions linked to issue #42 - both focus the same chain tab. Open a session for issue #43 - a new chain tab appears.
- **Source:** `apps/orchestrator/src/hooks/use-tab-sync.ts:323-334`

#### UI Layer

Extended `TabEntry` in Yjs:

```typescript
interface TabEntry {
  project?: string
  order: number
  kind?: 'chain' | 'session'   // NEW, default 'session'
  issueNumber?: number          // NEW, cluster key for chain tabs
  activeSessionId?: string      // NEW, which mode session is live
}
```

Chain tab renders with a stacked-layers icon (vs solo-page for session
tabs). Tab label: `#42 Pluggable gateway` (issue number + title).

#### Data Layer

No D1 migration. Tab state lives in Yjs (`Y.Map<string>("tabs")`) which
is already persisted in UserSettingsDO via OPFS.

Cluster key computation changes in `computeInsertOrder`:

```
if (entry.kind === 'chain')
  clusterKey = `issue:${entry.issueNumber}`
else
  clusterKey = `project:${entry.project}`
```

One-chain-per-issue enforcement mirrors one-tab-per-project: scan Y.Map,
delete existing chain tab with same issueNumber before inserting.

---

### B2: Chain route and timeline

**Core:**
- **ID:** chain-route-timeline
- **Trigger:** User navigates to `/chain/:issueNumber` (via chain tab click, sidebar link, or direct URL)
- **Expected:** Page renders a vertical timeline of all sessions belonging to this issue, ordered by `createdAt`. Each row shows: mode badge, session status (live/completed/crashed), last activity, artifact chips. The active row (if any) expands to show the live transcript.
- **Verify:** Navigate to `/chain/42` with three sessions (research done, planning done, impl live). See three rows, impl expanded with streaming transcript.
- **Source:** new route, new component

**Empty/error states:**
- `/chain/99999` (nonexistent issue): render an empty timeline with
  header "Issue #99999 not found" and a "Back to board" link. Do NOT
  404 — the issue may exist on GitHub but have no Duraclaw sessions yet.
- `/chain/42` with no sessions: render the issue header (fetched from
  GH API) with an empty timeline and a "Start research" CTA button.
  This is the first thing a user sees when creating a chain from the
  kanban board's Backlog column.

#### UI Layer

```
+---------------------------------------------------------+
| #42 - Pluggable gateway     [in-progress] [enhancement] |
| workspace: duraclaw-dev2 - [release]                    |
+---------------------------------------------------------+
| * research   done   2h ago   [research/...-gw.md]       |
| |                                                       |
| * planning   done   1h ago   [specs/42-gateway.md]      |
| |                                                       |
| * impl       live   now      [sess_xyz]  [PR #77]       |
|   |                                                     |
|   | [live transcript stream here]                       |
|   |                                                     |
| o verify     pending                                    |
| o close      pending                                    |
|                                                         |
| [Continue to verify ->]                                 |
+---------------------------------------------------------+
```

Components:
- `ChainPage` - fetches sessions for issue, renders timeline
- `ChainTimelineRow` - mode badge, status dot, artifact chips, expand toggle
- `ChainHeader` - issue title, labels, worktree reservation badge

#### API Layer

`GET /api/sessions?issue=:issueNumber` - already works via `kataIssue`
column in D1 `agentSessions` table. Returns `AgentSessionRow[]` filtered
by issue, ordered by `createdAt ASC`.

No new endpoint needed for basic chain view. Session live state comes
via existing `sessionLiveStateCollection` (TanStack DB).

#### Data Layer

Query: `SELECT * FROM agentSessions WHERE kata_issue = ? ORDER BY created_at ASC`

Artifact chips derived from (all convention-based, no new D1 fields in P1):
- Research doc: glob `planning/research/*` files whose frontmatter
  `github_issue` matches the chain's issueNumber. Resolved via gateway
  project-browse endpoint.
- Spec: glob `planning/specs/{issue}-*` by filename convention.
- PR: **deferred to P3.** In P1 the PR chip renders as empty/hidden.
  P3 adds a `prNumber` field to `ChainSummary` (populated via GH API
  search `is:pr head:{issue}-` on the repo). No D1 migration needed —
  PR number is fetched live and cached in `chainsCollection`.

---

### B3: Chain-aware sidebar

**Core:**
- **ID:** chain-sidebar
- **Trigger:** Sidebar renders session list for a project
- **Expected:** Sessions with the same `kataIssue` collapse under a chain node showing the issue title and a pipeline progress indicator (dots per mode). Expanding shows individual session cards. Sessions without `kataIssue` render as standalone cards (unchanged).
- **Verify:** Sidebar shows `#42 Pluggable gateway [*-*-o-o-o]` with three sessions nested under it.
- **Source:** `apps/orchestrator/src/components/layout/nav-sessions.tsx`

#### UI Layer

Chain node in sidebar:
```
v #42 Pluggable gateway  [*-*-*-o-o]
    research   done
    planning   done
    impl       live
```

Collapsed: shows only the chain node with pipeline dots. Click expands
to show individual sessions. Double-click opens chain tab.

---

## Feature 3C: Mode-Enter Session Reset

### B4: Mode transition detection

**Core:**
- **ID:** mode-transition-detect
- **Trigger:** `SessionDO` receives a `kata_state` event where `currentMode` differs from the previously stored mode, AND the session has `kataIssue` set (is part of a chain)
- **Expected:** SessionDO recognizes this as a mode transition and initiates the reset flow (B5). If `kataIssue` is null (orphan session), mode change is recorded but no reset occurs.
- **Verify:** Send `kata_state` event with `currentMode: 'planning'` to a chain-linked session whose `lastKataMode` is `'research'`. Assert: (1) `handleModeTransition()` is called (unit test on SessionDO), (2) a `mode_transition` gateway event with `{from: 'research', to: 'planning', issueNumber: N}` is emitted to the WS (integration test via event capture), (3) the runner receives close code `4411`.
- **Source:** `apps/orchestrator/src/agents/session-do.ts:2085`

#### Data Layer

New field on SessionDO internal state:
```typescript
lastKataMode?: string  // track previous mode for diff detection
```

Detection logic in the existing `kata_state` event handler:
```typescript
if (kataState.currentMode !== this.state.lastKataMode
    && kataState.issueNumber != null) {
  await this.handleModeTransition(kataState)
}
this.state.lastKataMode = kataState.currentMode
```

---

### B5: Runner close and fresh spawn on transition

**Core:**
- **ID:** mode-transition-reset
- **Trigger:** `handleModeTransition()` fires (from B4), AND `kataState` does NOT contain `continueSdk: true`
- **Expected:** SessionDO flushes the BufferedChannel (waits for in-flight events up to 2s; if flush times out, proceed anyway — unflushed events are dropped with a `flush_timeout` warning event logged to the chain timeline), closes the runner WS with code `4411` ("mode_transition"), waits for runner exit confirmation (up to 5s). If the runner exits within 5s, spawns a fresh runner. If the runner does NOT exit within 5s: (1) rotate `active_callback_token` (same as existing token-rotation path, close code `4410`), which forces the old runner to terminate on its next reconnect attempt, (2) proceed with fresh runner spawn regardless — the old runner will self-terminate when it sees `4410` on reconnect, same as the existing orphan recovery path. A `mode_transition_timeout` warning event is emitted to the WS for UI visibility. The fresh runner is spawned via `triggerGatewayDial({type: 'execute'})` with a preamble prompt seeded with artifact pointers from the chain history.
- **Verify:** Trigger mode transition. Old runner PID exits. New runner PID appears with fresh `sdk_session_id`. First message in new transcript references prior artifacts.
- **Source:** `apps/orchestrator/src/agents/session-do.ts` (new method)

#### API Layer

New WS close code:
```
4411 — mode_transition
```

Added to `DialBackClient` terminal close code list alongside `4401`
(invalid_token) and `4410` (token_rotated). Runner exits cleanly on
receipt, same as existing terminal-close path.

#### Data Layer

Preamble template (stored in SessionDO, generated per transition):

```typescript
function buildModePreamble(chain: ChainHistory): string {
  const artifacts = chain.sessions
    .filter(s => s.status === 'completed')
    .map(s => `- ${s.kataMode}: ${s.artifactPath ?? 'no artifact'}`)
    .join('\n')

  return `You are entering ${chain.currentMode} mode for issue #${chain.issueNumber} ("${chain.issueTitle}").

Prior artifacts in this chain:
${artifacts}

Read the relevant artifacts before acting. Your kata state is already linked: workflowId=GH#${chain.issueNumber}, mode=${chain.currentMode}, phase=p0.`
}
```

The preamble is passed as the `prompt` field in `triggerGatewayDial`,
which gateway forwards to the runner's initial `query()` call.

**Failure path:** If chain history fetch (D1 read) fails or artifact
paths can't be resolved, the runner spawns with a **degraded preamble**:

```
You are entering {mode} mode for issue #{issueNumber}.
Prior artifact paths could not be resolved — read the issue on GitHub
for context, then proceed with kata mode entry.
```

The transition is never blocked by preamble generation failure. A
`mode_transition_preamble_degraded` event is emitted to the WS so the
chain timeline UI can show an info badge ("context incomplete — prior
artifacts not linked").

---

### B6: Continue-SDK opt-out

**Core:**
- **ID:** continue-sdk-hint
- **Trigger:** `kata enter <mode> --continue-sdk` inside a chain session
- **Expected:** Kata state event includes `continueSdk: true`. SessionDO skips the reset flow (B5) - mode is recorded but runner stays alive with existing `sdk_session_id`.
- **Verify:** Run `kata enter debug --continue-sdk` in an impl session. Runner PID unchanged, transcript continues in same context.
- **Source:** `packages/shared-types/src/index.ts` (KataSessionState)

#### Data Layer

New optional field on `KataSessionState`:
```typescript
continueSdk?: boolean  // advisory hint: skip runner reset on mode change
```

SessionDO treats as advisory - if the runner is already dead (crashed,
reaped), a fresh spawn happens regardless.

---

## Feature 3D: Kanban Home + Swim Lanes

### B7: Chains API endpoint

**Core:**
- **ID:** chains-api
- **Trigger:** `GET /api/chains` with optional query parameters (see below)
- **Expected:** Returns an array of `ChainSummary` objects, each joining a GitHub issue with its Duraclaw sessions and worktree reservation status. Chains are ordered by `lastActivity DESC`.
- **Verify:** Call `GET /api/chains` with three issues in various modes. Response contains correct column derivation and session counts.

**Query parameters:**

| Param | Type | Behavior |
|---|---|---|
| `mine` | `true` (presence) | Filter to chains where authenticated user's `userId` matches any session's `userId` in the chain |
| `lane` | string enum: `enhancement`, `bug`, `other` | Filter to chains whose `issueType` matches. Mapping: GH label `bug` -> `bug`, GH label `enhancement` -> `enhancement`, everything else -> `other`. **Label precedence** (when issue has multiple matching labels): `bug` wins over `enhancement` (bugs are more urgent), `enhancement` wins over `other`. First match in priority order determines the lane. |
| `column` | string enum: `backlog`, `research`, `planning`, `implementation`, `verify`, `done` | Filter to chains in the specified derived column |
| `stale` | duration string `{N}d` (e.g. `7d`, `14d`) | Filter to chains where `lastActivity` is older than N days ago. Parsed as integer days. Invalid format returns 400. |
| `project` | string | Filter to chains whose sessions belong to this project name |

#### API Layer

```typescript
interface ChainSummary {
  issueNumber: number
  issueTitle: string
  issueType: 'enhancement' | 'bug' | string  // from GH label
  issueState: 'open' | 'closed'
  column: 'backlog' | 'research' | 'planning' | 'implementation' | 'verify' | 'done'
  sessions: {
    id: string
    kataMode: string
    status: string
    lastActivity: string
  }[]
  worktreeReservation: {
    worktree: string
    heldSince: string
    lastActivityAt: string
  } | null
  lastActivity: string
}
```

Column derivation (server-side, evaluated top-to-bottom, first match wins):

| # | Rule | Column | Notes |
|---|------|--------|-------|
| 1 | issue closed or merged PR | `done` | Terminal — overrides session state |
| 2 | issue open, no sessions with `kataIssue` | `backlog` | |
| 3 | latest session `kataMode = 'verify'` | `verify` | Any status (running/crashed/completed) |
| 4 | latest session `kataMode in ('implementation', 'task')` | `implementation` | Any status |
| 5 | latest session `kataMode = 'planning'` | `planning` | Any status |
| 6 | latest session `kataMode = 'research'` | `research` | Any status |
| 7 | fallback | `backlog` | Sessions exist but with no `kataMode` |

"Latest" = most recent by `createdAt`. Session `status` (running,
completed, crashed) does **not** affect column placement — the card
stays in the mode's column regardless.

**Edge cases:**
- **Crashed session:** card stays in the mode's column. A red status
  dot and "crashed — resume?" action distinguish it from a live
  session. The user must explicitly restart or advance.
- **Multiple sessions in different modes:** the latest session by
  `createdAt` determines the column, regardless of earlier sessions.
- **Out-of-order mode sessions** (e.g. debug mid-impl): debug is not
  in the `modeToColumn` map, so it falls through to `backlog`. To
  prevent this, the derivation skips sessions where `kataMode` is
  `'debug'` or `'freeform'` (these are side-quests, not pipeline
  stages). Adjusted rule: "latest session whose `kataMode` is in
  `{research, planning, implementation, task, verify}`."

Data sources:
- `agentSessions` D1 table (grouped by `kata_issue`)
- GitHub issues API (in-memory cached with 5min TTL, fetched live) —
  paginated: fetch up to 3 pages (`per_page=100`, max 300 issues). If
  the repo has >300 open issues, older issues won't appear on the board.
  A `more_issues_available: true` flag on the API response signals the
  UI to show a "Showing 300 of N issues" footer. Same pagination
  applies to the PR search endpoint. **Off-page issues with D1
  sessions:** the join is D1-first — query `SELECT DISTINCT kata_issue
  FROM agentSessions WHERE kata_issue IS NOT NULL`, then enrich with GH
  API data. Issues not found in the GH response (off-page or deleted)
  render with `issueTitle: "Issue #N"` (placeholder) and
  `issueType: 'other'`. No chain silently disappears.
- Worktree reservations from D1 `worktree_reservations` table

---

### B8: Kanban board route

**Core:**
- **ID:** kanban-route
- **Trigger:** User navigates to `/board` (linked from sidebar header or nav)
- **Expected:** Renders a kanban board with 6 columns (Backlog, Research, Planning, Implementation, Verify, Done) and swim lanes grouped by issue type (Enhancement, Bug, Other). Each card shows the chain summary. Columns and lanes are populated from `GET /api/chains`.
- **Verify:** Navigate to `/board`. See cards distributed across columns matching their derived mode phase.
- **Source:** new route, new components

#### UI Layer

Components:
- `KanbanBoard` - fetches chains, renders columns + lanes
- `KanbanColumn` - vertical stack of cards for one mode phase
- `KanbanLane` - horizontal grouping by issue type, collapsible
- `KanbanCard` - chain summary (reuses `ChainTimelineRow` pipeline dots)

Card layout:
```
+------------------------------+
| #42 - Pluggable gateway      |
| enhancement - @alice          |
| *-*-o-o-o  impl live  3m     |
| [wt: duraclaw-dev2]          |
| [Open]  [Start verify ->]    |
+------------------------------+
```

Lane collapse state persisted in Yjs alongside tab map (new
`Y.Map<string>("kanbanLanes")` — key: lane name, value: `{collapsed}`).

#### Data Layer

Chain summary data refreshes via polling (30s) from `GET /api/chains`,
stored in a new `chainsCollection` TanStack DB collection (OPFS
persisted, same pattern as `agentSessionsCollection`).

---

### B9: Card actions — open and start-next

**Core:**
- **ID:** kanban-card-actions
- **Trigger:** User clicks "Open" or "Start <next> ->" on a kanban card
- **Expected:** "Open" navigates to `/chain/:issueNumber` (opens chain tab, B1). "Start <next>" behaviour depends on whether P4 (mode-reset, B5) has shipped:
  - **With P4:** triggers mode transition (B5) — clean close + fresh spawn with preamble.
  - **Without P4 (P3 ships first):** if an active session exists, the button label changes to "Close current + start <next>" and the action calls the existing `stop()` RPC on the active session, waits for completion, then spawns a new session via `spawn()`. No preamble — the runner gets a standard kata-mode prompt. This is the degraded path; when P4 ships, the button seamlessly upgrades to the B5 flow.
  - **No active session:** spawns a new session via `spawn()` with `kataIssue` set, regardless of P4 status.
- **Verify:** Click "Open" on a card. Chain tab opens. Click "Start verify" on an impl-complete card. New verify session spawns.

#### UI Layer

"Start <next>" button visibility follows a preconditions table:

| Current column | Button label | Precondition | How checked |
|---|---|---|---|
| backlog | Start research | issue open | `issueState !== 'closed'` from GH API |
| research | Start planning | latest research session completed | `sessions.filter(s => s.kataMode === 'research').some(s => s.status === 'completed')` |
| planning | Start implementation | spec file exists with `status: approved` in frontmatter | `GET /api/chains/:issue/spec-status` — globs `planning/specs/{issue}-*.md`, picks the **most recently modified** match, parses its YAML frontmatter, checks `status === 'approved'`. If no match: `{ exists: false }`. |
| implementation | Start verify | latest impl session completed | `sessions.filter(s => s.kataMode === 'implementation').some(s => s.status === 'completed')` |
| verify | Start close | VP evidence file exists | `GET /api/chains/:issue/vp-status` — checks for `.kata/verification-evidence/vp-{issue}.json` on disk via gateway project-browse endpoint |

Button is disabled (with tooltip showing unmet precondition) when check
returns false. Precondition checks are cached client-side for 30s to
avoid per-render overhead.

**Precondition check endpoints (added to P3 tasks):**

```typescript
// GET /api/chains/:issue/spec-status
// 200: { exists: boolean, status: string | null, path: string | null }
// Reads planning/specs/{issue}-*.md via gateway project-browse,
// parses YAML frontmatter for `status` field.
// 404: no project configured

// GET /api/chains/:issue/vp-status
// 200: { exists: boolean, passed: boolean | null, path: string | null }
// Reads .kata/verification-evidence/vp-{issue}.json via gateway
// project-browse, parses `overallPassed` field.
// 404: no project configured
```

Both endpoints delegate to the gateway's existing `GET /projects/:name/files/:path`
endpoint for file reads. Errors from gateway (network, 404) return
`{ exists: false }` — precondition stays unmet, button stays disabled.

---

### B10: Drag-to-advance

**Core:**
- **ID:** kanban-drag-advance
- **Trigger:** User drags a card from one column to the next column (left-to-right only)
- **Expected:** On drop, the same precondition check from B9 runs for the target column. If precondition fails, card snaps back with toast showing the unmet condition (e.g. "Spec not yet approved"). If precondition passes, confirmation modal appears: "Close {current_mode} session and enter {target_mode}?" On confirm, triggers mode transition (B5 if P4 shipped, or degraded stop+spawn from B9 if not). On cancel, card snaps back. Dragging backwards (right-to-left) is not allowed (card snaps back with toast "Can't move backwards"). Drag and button use the same validation path — no bypass.
- **Verify:** Drag card from Planning to Implementation. Confirm. New impl session spawns. Drag card from Implementation to Research. Card snaps back.

#### UI Layer

Drag-and-drop via existing React DnD or a lightweight lib (evaluate
`@dnd-kit/core` for accessibility). Drop zones are columns. Only
adjacent-forward drops accepted (planning -> impl OK, planning -> verify
rejected).

Confirmation modal:
```
+---------------------------------------------+
| Advance #42 from planning to implementation? |
|                                              |
| This will:                                   |
|  - Close the current planning session        |
|  - Start a fresh implementation session      |
|  - Reset context (new SDK session)           |
|                                              |
| Worktree: duraclaw-dev2 (reserved)           |
|                                              |
|  [Cancel]              [Advance ->]          |
+---------------------------------------------+
```

---

## Feature 3E: Worktree Checkout

### B11: Chain-level worktree reservation

**Core:**
- **ID:** wt-chain-reserve
- **Trigger:** User starts a session for a chain in a code-touching mode (implementation, verify, debug, task)
- **Expected:** The **client-side UI** calls `POST /api/chains/:issue/checkout { worktree }` **before** spawning the session. If 200 (free or same-chain re-entry): proceed to spawn. If 409 (held by different chain): show conflict modal (B13) — user must resolve before session spawns. This is client-orchestrated, not SessionDO-initiated, because the conflict modal must appear before the session starts. SessionDO is not involved in checkout — it only tracks `kataIssue` for other purposes.
- **Verify:** Start impl session for chain #42 in worktree `dev2`. Reservation appears. Start verify session for same chain - reuses same reservation. No conflict.
- **Source:** `apps/orchestrator/src/agents/session-do.ts` (new state)

#### Data Layer

**Source of truth: D1 only.** Reservations live exclusively in the D1
`worktree_reservations` table. SessionDO does NOT hold a local copy —
all reads and writes go through D1. This avoids dual-write bugs and
sync complexity. The checkout/release API routes read/write D1 directly
(not through a DO).

Type definition (for API contracts and client-side use):

```typescript
interface WorktreeReservation {
  issueNumber: number
  worktree: string
  ownerId: string           // userId who first checked out
  heldSince: string         // ISO timestamp
  lastActivityAt: string    // updated on each session event
  modeAtCheckout: string    // first mode that claimed it
  stale: boolean            // set by hourly GC
}
```

D1 table `worktree_reservations` (new migration):

```sql
CREATE TABLE worktree_reservations (
  worktree TEXT PRIMARY KEY,
  issue_number INTEGER NOT NULL,
  owner_id TEXT NOT NULL,
  held_since TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  mode_at_checkout TEXT NOT NULL,
  stale INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (owner_id) REFERENCES user(id)
);
CREATE INDEX idx_wt_res_issue ON worktree_reservations(issue_number);
```

`stale` is an integer flag (0/1). Set to 1 by hourly GC when
`last_activity_at` is older than 7 days. Reset to 0 on any new session
activity. Force-release is only allowed when `stale = 1`.

Which modes check out:

| Mode | Reserves? |
|---|---|
| research, planning, freeform | No |
| implementation, verify, debug, task | Yes |
| close | No (releases) |

---

### B12: Checkout and release API

**Core:**
- **ID:** wt-checkout-api
- **Trigger:** `POST /api/chains/:issue/checkout`, `POST /api/chains/:issue/release`, `POST /api/chains/:issue/force-release`
- **Expected:**
  - `checkout { worktree }`: creates reservation if worktree is free. Returns 200 with reservation details. If the worktree is already held by the **same chain** (re-entry, e.g. impl → debug → impl), returns 200 with the existing reservation (idempotent — no new row, just refresh `lastActivityAt`). Returns 409 with existing reservation details if worktree is held by a **different** chain.
  - `release`: removes reservation for this chain. Returns 200. Returns 404 if no reservation.
  - `force-release { confirmation: true }`: removes reservation regardless of owner, but only if `lastActivityAt` is older than stale threshold (default 7 days). Returns 200 or 403 if not stale enough.
- **Verify:** POST checkout for chain #42 on `dev2` - 200. POST checkout for chain #43 on `dev2` - 409 with #42 details. POST release for #42 - 200. POST checkout for #43 on `dev2` - 200.

#### API Layer

Routes (TanStack Start API routes):

```typescript
// POST /api/chains/:issue/checkout
// Body: { worktree: string }
// 200: { reservation: WorktreeReservation }
// 409: { conflict: WorktreeReservation, message: string }

// POST /api/chains/:issue/release
// 200: { released: true }
// 404: { message: "No reservation for this chain" }

// POST /api/chains/:issue/force-release
// Body: { confirmation: true }
// 200: { released: true, forced: true }
// 403: { message: "Reservation not stale enough", staleAfterDays: 7, lastActivity: string }
```

Auth: all endpoints require authenticated user.

**Concurrency control:** Checkout requests are serialized via D1's
single-writer SQLite semantics. The checkout handler runs
`db.batch([SELECT, INSERT])` — D1's batch API executes all statements
in a single implicit transaction. If two concurrent `POST /checkout`
requests for the same worktree arrive:
1. First request's `INSERT` succeeds (worktree is PRIMARY KEY).
2. Second request's `INSERT` fails with `UNIQUE constraint` → handler
   catches the error, re-reads the reservation, returns 409 with the
   first request's reservation details.
No explicit mutex or `SELECT ... FOR UPDATE` needed (SQLite doesn't
support `FOR UPDATE`) — D1's single-writer guarantee is sufficient.

**Force-release authorization:** Any authenticated user can force-release
a stale reservation (`stale = 1`). Non-stale reservations cannot be
force-released by anyone — the 403 response is universal, not
role-gated. Rationale: stale threshold (7d) is the access control;
adding RBAC for a team-of-one product is premature. Force-release logs
an audit entry to the D1 `audit_log` table:

```sql
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  user_id TEXT NOT NULL,
  details TEXT NOT NULL,  -- JSON string
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES user(id)
);
CREATE INDEX idx_audit_action ON audit_log(action, created_at);
```

This migration is part of P2 (same migration file as
`worktree_reservations`). The `audit_log` table is intentionally
generic — reusable for other audit events beyond force-release.

---

### B13: Conflict UI and worktree picker

**Core:**
- **ID:** wt-conflict-ui
- **Trigger:** User attempts to start a code-touching session in a worktree held by another chain (409 from checkout API)
- **Expected:** Modal shows reservation details (holding chain issue/title, owner, held-since, last-activity). Options: "Pick different worktree" (opens worktree picker with held worktrees grayed out), "Force release" (only enabled if stale > 7d), "Cancel".
- **Verify:** Try to start impl for #43 in a worktree held by #42. See conflict modal with #42 details. Pick a different worktree. Session starts.
- **Source:** new component

#### UI Layer

Conflict modal:
```
+--------------------------------------------------+
| Worktree duraclaw-dev2 is held by chain #42       |
| * @alice - since Apr 18 (2h ago)                  |
| * last activity: impl session - 12m ago           |
|                                                   |
| [Pick different worktree]  [Force release]  [X]   |
+--------------------------------------------------+
```

Worktree picker (opened from conflict modal or from chain tab header):
- Lists all worktrees for the project via existing gateway
  `GET /projects/:name/worktrees` endpoint
- Each worktree shows: path, branch, and reservation badge if held
  (`locked #42 @alice 2h`)
- Held worktrees are selectable but show a warning tooltip
- Free worktrees are green-highlighted
- "Create new worktree" option at bottom (name auto-derived from
  `feature/{issue}-{slug}`)

---

### B14: Release triggers and stale GC

**Core:**
- **ID:** wt-release-triggers
- **Trigger:** Chain enters `close` mode and exits, issue is closed (GH webhook), PR is merged (GH webhook), or stale threshold exceeded
- **Expected:** Worktree reservation is automatically released. For stale GC: a periodic check (every hour, piggyback on gateway reaper) identifies reservations with `lastActivityAt` > 7 days, marks them as `stale` (visible in UI but not auto-released - only force-release removes them).
- **Verify:** Close issue #42 via GitHub. Reservation for `dev2` disappears within 60s. Start new chain #50 on `dev2` - no conflict.

#### API Layer

GH webhook handler (new TanStack Start API route `POST /api/webhooks/github`):

- On `issues.closed` event: `DELETE FROM worktree_reservations WHERE issue_number = ?` using the event's `issue.number`. Direct, no heuristic.
- On `pull_request.merged` event: extract linked issue number via this algorithm (first match wins):
  1. Parse PR branch name for `feature/{N}-*`, `fix/{N}-*`, `feat/{N}-*` patterns — extract `N`.
  2. Search PR body for `Closes #{N}` or `Fixes #{N}` (case-insensitive regex).
  3. If no match found: no-op (log warning, reservation stays; user can force-release).
  Then: `DELETE FROM worktree_reservations WHERE issue_number = ?` using extracted `N`.

Webhook security and filtering:
- Signature: validated via `X-Hub-Signature-256` header against a new
  `GITHUB_WEBHOOK_SECRET` env var (wrangler secret). Invalid → 401.
- Repo filter: handler checks `event.repository.full_name` against the
  configured repo (from `GITHUB_REPO` env var, e.g.
  `baseplane-ai/duraclaw`). Events from other repos return 200 (ack)
  with no action. This prevents cross-repo issue number collisions from
  releasing the wrong reservation.
- Unknown issues: `DELETE WHERE issue_number = ?` for an issue with no
  reservation is a no-op (0 rows affected). Handler returns 200
  regardless — webhooks must always be acknowledged.

**Stale GC scheduling:** Uses a Cloudflare Cron Trigger (configured in
`wrangler.jsonc` as `crons = ["0 * * * *"]` — hourly). The cron handler
in `apps/orchestrator/src/server.ts` runs:

```sql
UPDATE worktree_reservations
SET stale = 1
WHERE last_activity_at < datetime('now', '-7 days')
  AND stale = 0
```

And resets stale flag on recently active reservations:

```sql
UPDATE worktree_reservations
SET stale = 0
WHERE last_activity_at >= datetime('now', '-7 days')
  AND stale = 1
```

This runs in the Worker context (no DO needed). If the cron trigger is
missed (Worker cold start, Cloudflare outage), reservations just stay
non-stale longer — no correctness issue, only delayed GC eligibility.
Force-release still checks `last_activity_at` directly as a fallback.

#### Data Layer

`lastActivityAt` is updated on every `kata_state` event in
`syncKataToD1` (piggyback on existing sync):

```typescript
// In syncKataToD1, after writing kata fields:
await this.env.DB.prepare(
  'UPDATE worktree_reservations SET last_activity_at = ? WHERE issue_number = ?'
).bind(new Date().toISOString(), kataState.issueNumber).run()
```

---

## Resolved Questions

- [x] **GH issue caching:** Live fetch with in-memory 5min TTL (no D1
  migration). The `GET /api/chains` handler fetches
  `GET /repos/{owner}/{repo}/issues?state=all&per_page=100` once,
  caches the response in a module-level `Map<number, {data, expiresAt}>`
  with 5min TTL. **Caveat:** Workers use isolate recycling — module-level
  state may not persist across requests if the isolate is evicted. Cache
  hit rate will be lower than a persistent store. At ~5k requests/hr
  GitHub rate limit and 30s polling from the UI, worst case (0% cache
  hits) is ~120 requests/hr per user — well within limits for a small
  team. If rate limits become a problem (>10 concurrent users), migrate
  to Cloudflare Cache API (`caches.default.put/match`) which persists
  across isolate evictions within the same colo. D1 cache deferred as
  last resort.
- [x] **Kanban route:** Separate `/board` route. `/` stays as the
  existing session dashboard (current default). Sidebar adds a "Board"
  nav link alongside the existing project tree. Rationale: non-breaking
  for existing users; board can be promoted to `/` later via a user
  preference toggle.
- [x] **Column skipping:** Not allowed in initial ship. Drag only
  accepts adjacent-forward columns. Hotfix workflows that skip research
  or planning start directly in the target column by clicking "Start
  <mode>" on the card (B9). This avoids the complexity of validating
  skip-paths while still supporting the use case.
- [x] **PR number tracking:** Derived from GitHub API on chain render
  (no D1 migration). `GET /api/chains` does a single
  `GET /repos/{owner}/{repo}/pulls?state=all&per_page=100` (same
  cache strategy), matches PRs to issues by branch naming convention
  (`feature/{issue}-*`, `fix/{issue}-*`) or PR body `Closes #{issue}`.
  Populates `ChainSummary.prNumber` from the cache. Deferred: D1
  column for `prNumber` if live fetch proves too slow.

## Implementation Phases

See YAML frontmatter. Recommended order:

1. **P1: Chain tab surface (3B)** - ~3 days. Self-contained UI. Extend
   TabEntry, add chain route, update sidebar. No runtime changes.
2. **P2: Worktree checkout (3E)** - ~3 days. Independent of P1
   (can ship in parallel). D1 migration + API + conflict UI.
3. **P3: Kanban home (3D)** - ~4 days. **Depends on P1 + P2** (reuses
   chain card components from P1, renders worktree reservation chips
   from P2). Builds `GET /api/chains`, board route, drag-to-advance.
4. **P4: Mode-enter session reset (3C)** - ~4 days. Depends on GH#12
   landing. Touches DO lifecycle + runner close codes. Highest risk.

```
P1 (3B) ──┐
           ├──▶ P3 (3D) ──▶ P4 (3C)
P2 (3E) ──┘                   ▲
                           GH#12
```

## Verification Strategy

### Test Infrastructure

Vitest with jsdom for component tests. Integration tests via
`chrome-devtools-axi` for end-to-end chain tab and kanban flows.
Smoke tests via `curl` for API endpoints.

### Build Verification

`pnpm build && pnpm typecheck` - standard monorepo build. D1 migration
tested via `wrangler d1 migrations apply` in dev.

## Verification Plan

### VP1: Chain tab groups sessions by issue

Steps:
1. Start a session with `kata enter research`, link to an issue via
   `kata link <n>`. Complete the session.
   Expected: Session appears in sidebar under project.
2. Start a new session with `kata enter planning --issue=<n>`.
   Expected: Both sessions now appear under a chain node for issue #n
   in the sidebar. A chain tab exists with pipeline dots showing
   research (done) and planning (live).
3. Navigate to `/chain/<n>`.
   Expected: Timeline shows two rows - research (completed, artifact
   chip) and planning (live, streaming transcript).

### VP2: Worktree checkout prevents conflict

Steps:
1. Start impl session for chain #42 in worktree `dev2`.
   Expected: `POST /api/chains/42/checkout` returns 200.
2. Try to start impl session for chain #43 in worktree `dev2`.
   Expected: Conflict modal shows #42 reservation details.
3. Pick different worktree `dev3` in the picker.
   Expected: Session starts, `dev3` reserved for #43.
4. Close issue #42 via GitHub.
   Expected: `dev2` reservation released, available for other chains.

### VP3: Kanban board shows correct column placement

Steps:
1. Navigate to `/board`.
   Expected: Board renders with 6 columns.
2. Create a new issue (no sessions).
   Expected: Card appears in Backlog column.
3. Start a research session for that issue.
   Expected: Card moves to Research column.
4. Complete research, start planning.
   Expected: Card moves to Planning column.

### VP4: Mode transition resets context

Steps:
1. Start a chain-linked session in research mode.
   Note the `sdk_session_id` from session status.
2. Run `kata enter planning --issue=<n>` (mode transition).
   Expected: Old runner exits (close code 4411). New runner spawns
   with a different `sdk_session_id`. First message in new transcript
   contains artifact-pointer preamble referencing prior research doc.
3. Run `kata enter debug --continue-sdk` (opt-out).
   Expected: Runner PID unchanged. Same `sdk_session_id`. No reset.

## Implementation Hints

### Key Imports

| Module | Import | Used For |
|--------|--------|----------|
| `@dnd-kit/core` | `{ DndContext, useDraggable, useDroppable }` | Kanban drag-and-drop (accessible) |
| `~/hooks/use-tab-sync` | `{ useTabSync, TabEntry }` | Extended tab management |
| `~/lib/tanstack-db` | `{ chainsCollection }` | New collection for chain summaries |

### Code Patterns

**Chain tab opening (extending existing openTab):**
```typescript
function openChainTab(issueNumber: number, project: string) {
  const existing = findTabByIssue(issueNumber)
  if (existing) { focusTab(existing.id); return }
  insertTab({
    kind: 'chain',
    issueNumber,
    project,
    order: computeInsertOrder(entries, project)
  })
}
```

**Column derivation (server-side) — matches B7 rules table exactly:**

The normative rule is: **latest session by `createdAt` determines
column, regardless of session status.** Crashed/running/completed
sessions all place the card in the same column for their mode. This is
intentional — a crashed impl session should stay visible in the
Implementation column so the user can restart it.

```typescript
function deriveColumn(sessions: AgentSessionRow[], issueState: string): Column {
  if (issueState === 'closed') return 'done'
  if (!sessions.length) return 'backlog'

  // Latest session by createdAt determines column
  const latest = sessions.reduce((a, b) =>
    new Date(a.createdAt) > new Date(b.createdAt) ? a : b
  )
  const mode = latest.kataMode ?? ''

  // Mode -> column. Status (crashed/running/completed) does NOT
  // affect column placement (B7 rules 3-8).
  const modeToColumn: Record<string, Column> = {
    verify: 'verify',
    implementation: 'implementation',
    task: 'implementation',
    planning: 'planning',
    research: 'research',
  }
  return modeToColumn[mode] ?? 'backlog'
}
```

### Gotchas

- `kataIssue` in D1 is `integer` type. Null for unlinked sessions.
  Always filter `WHERE kata_issue IS NOT NULL` for chain queries.
- Yjs `Y.Map` entries are opaque JSON strings. Adding `kind` and
  `issueNumber` fields is backwards-compatible (old clients ignore
  unknown fields, default to `kind: 'session'`).
- Close code `4411` must be added to BOTH `DialBackClient` (runner side,
  `shared-transport`) and `SessionDO` (DO side). Runner treats it as
  terminal (same as 4401/4410). DO initiates it.
- `computeInsertOrder` uses fractional ordering. Chain tabs that replace
  a session tab should inherit its order to avoid visual jumps.

### Reference Docs

- [TanStack DB collections](https://tanstack.com/db/latest) - OPFS
  persistence pattern for `chainsCollection`
- [@dnd-kit](https://dndkit.com/) - accessible drag-and-drop for React
- [Cloudflare D1 migrations](https://developers.cloudflare.com/d1/build-with-d1/d1-migrations/) - for `worktree_reservations` table
