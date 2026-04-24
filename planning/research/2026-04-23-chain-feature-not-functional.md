---
title: "Chain feature — why it is currently not functional"
date: 2026-04-23
type: feature-research
status: draft
---

# Chain feature — why it is currently not functional

## TL;DR

The chain feature has most of its server-side plumbing wired up correctly
(D1 schema, synced collection, API endpoints, DO auto-advance, webhook,
StatusBar widget) but is non-functional end-to-end for three cascading
reasons:

1. **Manual advance is broken by a status mismatch.** The client-side
   precondition check (`useNextModePrecondition` / `checkPrecondition`)
   gates on `session.status === 'completed'`, but `'completed'` is not a
   member of the `SessionStatus` union (removed upstream; finished sessions
   park as `'idle'`). Drag-to-advance on the kanban — and the `Start next`
   button on every card — silently refuse research→planning and
   implementation→verify transitions forever.
2. **There is no UI affordance to create / bootstrap a chain.** A chain
   exists iff (a) a session already has `kataIssue` set in D1 **or** (b)
   the GitHub issue appears in the cached `/issues` window. The session
   creation UI doesn't expose a `kataIssue` input, and the kanban has no
   "create from issue" action for backlog cards — `advanceChain()` returns
   `"No project for chain"` for any chain with zero sessions. In a fresh
   dev worktree with no `GITHUB_REPO` env var, the board is empty and
   there is no way to populate it from the UI.
3. **Auto-advance is disabled by default and is the only path that
   actually works today.** GH#73 consolidated the auto-advance gate onto a
   single `runEnded` evidence bit produced by kata's Stop hook, persisted
   by the runner via fs.watch, then mirrored into
   `session_meta.last_run_ended` in the DO. But `default_chain_auto_advance`
   is OFF, per-chain overrides require a preferences PUT through the
   StatusBar popover (which only renders when `kataIssue` is already set),
   and if the user doesn't have auto-advance enabled they're thrown back
   onto the manual path — which is broken by finding #1.

The "feature non-functional" report is consistent with a user who pulled
main, opened `/board`, either saw an empty board (no GH token / fresh
dev) or could not drag any card past `research` / `implementation` even
when sessions were visibly finished.

---

## Context

- Roadmap items: GH#16 (original chain UX epic), GH#58 (StatusBar
  widget + auto-advance amendment), GH#73 (auto-advance evidence-bit
  gate fix).
- Relevant specs: `planning/specs/16-chain-ux.md`,
  `planning/specs/16-chain-ux-p1-5.md`.
- Relevant research: `planning/research/2026-04-22-chain-statusbar-widget-p1-5.md`,
  `planning/research/2026-04-19-github-issue-board-integration.md`.
- All three GH chain issues (16, 58, 73) are **closed**, so from a
  project-management surface the feature reads as "shipped". The issues
  below are behavioural regressions / unfinished edges, not open tracked
  tickets.

## Architecture map (current state on `main` at commit 280adf1)

```
GH Issues ─── /api/chains (reads D1 kataIssue + cached GH issues)
                  │
                  ▼
          chainsCollection (synced; OPFS-persisted)
                  │                  ▲
                  │                  │ WS delta
                  ▼                  │
            Kanban /board   ◄─── broadcastSyncedDelta('chains', ops)
            StatusBar widget         │
                                     │
                                     │
 SessionDO ── maybeAutoAdvanceChain() on 'stopped':
              tryAutoAdvance(runEnded=state.lastRunEnded)
                → checkoutWorktree (code-touching modes only)
                → createSession({kataIssue, agent: nextMode})
                → rebindTabsForSession
                → broadcastGatewayEvent('chain_advance' | 'chain_stalled')
                → buildChainRow → broadcastSyncedDelta

 Runner ── fs.watch('.kata/sessions/<sdk>/run-end.json')
           → emits kata_state event with runEnded=true
           → DO persists last_run_ended in session_meta (migration v14)
```

---

## Bug #1 — `status === 'completed'` is never true (manual advance broken)

### Location

- `apps/orchestrator/src/hooks/use-chain-preconditions.ts:116`
  ```ts
  const ok = sessionsForChain.some(
    (s) => s.kataMode === 'research' && s.status === 'completed',
  )
  return { canAdvance: ok, reason: ok ? '' : 'No completed research session', … }
  ```
- `apps/orchestrator/src/hooks/use-chain-preconditions.ts:140`
  ```ts
  const ok = sessionsForChain.some(
    (s) => s.kataMode === 'implementation' && s.status === 'completed',
  )
  ```
- `apps/orchestrator/src/features/kanban/KanbanCard.tsx:43`
  ```ts
  if (status === 'completed') return 'done'   // dead branch in the status label
  ```

### Why it doesn't match

`packages/shared-types/src/index.ts:579` defines the type:

```ts
export type SessionStatus =
  | 'idle'
  | 'running'
  | 'waiting_input'
  | 'waiting_permission'
  | 'waiting_gate'
```

No `'completed'` member. And the intentional convention is called out in
`apps/orchestrator/src/components/chain-status-item.tsx:72-78`:

> `agent_sessions.status` never holds 'completed' in this codebase —
> finished sessions land as 'idle' (SessionStatus union in
> packages/shared-types).

`ChainStatusItem` already handles this correctly via an `isChainSessionCompleted`
proxy (`status === 'idle' && lastActivity != null`). The precondition
hook and the kanban card's label helper never got the same treatment.

### Observable symptoms

- **Kanban drag** research → planning: toast "No completed research session",
  modal never opens.
- **Kanban drag** implementation → verify: toast "No completed
  implementation session".
- **`Start next`** button on any card whose current column is `research` or
  `implementation`: disabled; hover-title shows the same "No completed …"
  reason.
- **Card status pill** shows "idle" for finished sessions instead of "done".

### Blast radius

- Does **not** affect auto-advance. `tryAutoAdvance` (`apps/orchestrator/src/lib/auto-advance.ts:141-178`)
  gates on `runEnded` only; it explicitly dropped the session-status /
  spec-status probes in GH#73.
- Does **not** affect backlog → research (that gate is
  `issueState !== 'closed'`) or planning → implementation (spec-status
  fetch) or verify → close (vp-status fetch). Those three transitions
  still work if the board can be populated at all.
- Does **not** affect the StatusBar rung ladder — `ChainStatusItem` uses
  the `'idle' + lastActivity` proxy.

### Test coverage

No test file exists for `use-chain-preconditions.ts`:

```
apps/orchestrator/src/hooks/use-chain-checkout.test.ts   ✓
apps/orchestrator/src/hooks/use-chain-preconditions.ts   (no .test.ts)
```

`chains.test.ts` covers `buildChainRowFromContext` / `deriveColumn` only.
`auto-advance.test.ts` was rewritten in GH#73 around `runEnded`. The
manual advance path has no unit coverage — the bug survived the test
gate because the test gate doesn't exist.

---

## Bug #2 — No bootstrap path to create a chain from the UI

### The requirement

A chain shows up in `chainsCollection` iff the `/api/chains` handler
(`apps/orchestrator/src/api/index.ts:2331`) emits a row for it. The
handler unions two sources:

1. Distinct `agentSessions.kataIssue` values from D1
   (`api/index.ts:2354-2357`).
2. Cached GitHub `/issues?state=all` response for `env.GITHUB_REPO`
   (`api/index.ts:2366`, delegating to `fetchGithubIssues`).

Neither source is reachable from UI affordances today:

### No UI to set `kataIssue` on a session

- `POST /api/sessions` accepts `kataIssue` in the body
  (`api/index.ts:1778`), but:
  - The session-creation form on the dashboard does not render a
    "kata issue" field (grep of `features/agent-orch/*.tsx` and
    `features/spawn-form/*.tsx` — no input named kataIssue).
  - The only client-side call that supplies `kataIssue` is
    `spawnChainSession` in `features/kanban/advance-chain.ts:61-90`,
    invoked from `advanceChain`.
- So the only way to create a session with `kataIssue` set is through
  the kanban… which requires a chain to already exist.

### No bootstrap for backlog cards

`advanceChain` (`features/kanban/advance-chain.ts:92-139`) first calls
`chainProject(chain)`:

```ts
export function chainProject(chain: ChainSummary): string | null {
  if (chain.sessions.length === 0) return null   // ← backlog card
  …
}
```

If the chain has no sessions, `advanceChain` immediately returns
`{ok: false, error: 'No project for chain'}`. `KanbanCard.tsx:109-113`
acknowledges this gap:

> // No in-app worktree picker yet — close modal and let the user pick a
> // different worktree via the existing spawn form / worktrees panel.

In other words: backlog cards (issue visible via GH, zero sessions)
cannot be advanced to `research` from the board. There is no picker.

### Chicken-and-egg in dev worktrees

Without `env.GITHUB_REPO` set, `fetchGhIssuesCached()` returns `[]`
(`lib/chains.ts:67-84`). The D1 side is also empty (no prior sessions
with `kataIssue`). `/api/chains` returns `{chains: []}`. The board is
empty. There is no way to get the first session into D1 with `kataIssue`
set because there's no field for it in the spawn form. Feature is
unusable on a fresh clone.

### Observable symptoms

- Fresh `/board` → empty board, no rows, no way to create one.
- Dev worktree without GH token → empty board (even if you had a way
  to spawn a session with a kataIssue, you couldn't see the chain card
  until the issue surfaced via GH, which requires auth).
- Prod with GH token → board renders issues as backlog cards, but each
  card's `Start next` → toast "No project for chain".

---

## Bug #3 — auto-advance OFF by default and gated behind invisible surfaces

### The plumbing (GH#73, commit 47d24ee, merged onto main)

`tryAutoAdvance` (`lib/auto-advance.ts:136-233`) runs on every session's
terminal `stopped` transition (`session-do.ts:4530-4556`). Gates:

1. Mode must be a core rung (`CORE_RUNGS`).
2. User pref — `readAutoAdvancePref(db, userId, kataIssue)` reads
   `user_preferences.chains_json` and falls back to
   `default_chain_auto_advance`.
3. No existing non-terminal successor for `(kataIssue, nextMode)`.
4. `runEnded === true` — the single evidence-file gate.
5. Worktree checkout for code-touching modes (implementation / verify /
   debug / task).
6. `createSession({kataIssue, agent: nextMode})`.
7. `rebindTabsForSession` + `broadcastGatewayEvent('chain_advance')`.

### Where the happy path can drop the ball

- **`default_chain_auto_advance` = 0** (migration `0019_chains_auto_advance_prefs.sql`).
  Out of the box, auto-advance is off for every chain for every user.
  To turn it on, the user must:
  1. Open a session that has `kataIssue` set (which requires bug #2
     to be worked around).
  2. See the StatusBar widget render (requires both `kataState` and
     `session.kataIssue` to be non-null — `status-bar.tsx:318`).
  3. Open the popover, toggle "auto-advance" for that specific chain.
  This writes `user_preferences.chains_json` via a `PUT /api/user/preferences`
  (`chain-status-item.tsx:269-281`).
- There is no "turn on auto-advance for all chains" toggle in
  `/settings` — grepped `routes/_authenticated/settings.tsx` and no
  chain-related setting is exposed. The global `default_chain_auto_advance`
  column is writable via the same preferences endpoint but has no UI
  anywhere.
- **`runEnded` is only true when kata's Stop hook fires** cleanly. The
  runner's fs.watch chain (`packages/session-runner/src/claude-runner.ts:114-121`)
  is susceptible to the same "missed filesystem event under worktree
  contention" failure mode that GH#73 fixed for `state.json` reads.
  (The read side is now targeted by sdk_session_id, but the watch is
  still the standard `fs.watch` on the session directory and can miss
  the `run-end.json` create if the session dir wasn't the watch target
  at the moment the file was written.)

### Observable symptoms

- New user, new worktree: even after fixing #1 and #2, sessions that
  terminate do not advance. Popover shows the auto-advance toggle in
  OFF state.
- User toggles ON for a specific chain; next stopped event advances.
- If `runEnded=false` (kata Stop hook didn't fire — e.g. session was
  killed, reached max_turns, or the evidence file creation raced the
  watch setup) the DO emits `chain_stalled` with reason "Rung did not
  signal run-end (kata can-exit not satisfied)" and the user sees a
  ⚠ indicator on the rung ladder.

---

## Secondary issues (not root causes of "non-functional" but worth noting)

### S1. `buildChainRow` broadcast call is gated on userId + issueNumber presence, but every session is broadcast under a single userId

`session-do.ts:2347-2351` does:

```ts
const row = await buildChainRow(this.env, this.d1, userId, issueNumber)
await broadcastSyncedDelta(this.env, userId, 'chains', [{ type: 'update', value: row }])
```

`chainsCollection` is not per-user scoped on the read side (`/api/chains`
doesn't filter by userId; see comment in `lib/chains.ts:299-303`:
"chains are shared across users today"). The fan-out only hits the
triggering user's `UserSettingsDO`, so other users watching the board
won't see the delta until they hit the 30s TTL or reload. Minor, but
makes multi-user chain UX feel stale.

### S2. `KanbanCard.shortStatusLabel` returns `'idle'` instead of `'done'`

Same root cause as #1 — the `'completed'` branch is dead. Visual-only:
every finished session's pill reads "idle".

### S3. No "release worktree" affordance on the StatusBar widget

Reservation is bound when auto-advance (or manual drag) calls
`checkoutWorktree`. The only UI to release is the
`WorktreeConflictModal` on kanban (only reachable when you try to drag
a second chain onto the same worktree). If an auto-advance stalls
mid-chain, the worktree stays reserved; the popover has an "auto-
advance" toggle and rung jump links but no release button.

### S4. `rebindTabsForSession` runs before the client has WS to the new DO

`session-do.ts:1612` calls `rebindTabsForSession(this.env, userId, sessionId, result.newSessionId, this.ctx)`
immediately after the successor session is created. The user's open tab
is rebound via `user_tabs` update, which fans out via
`broadcastSyncedDelta('user_tabs', …)`. The client then reconciles the
tab pointer and mounts `useAgent({agentName: newSessionId})`. If the
new SessionDO hasn't yet emitted any `messages` delta, the UI shows
a blank chat thread for a few hundred ms while the PartySocket WS
opens. Not broken — just worth noting as a UX rough edge.

### S5. `ChainStatusItem.computeRungs` uses `lastActivity != null` as the "ran at least one turn" proxy

This is a known workaround (called out in the file's own doc block).
It misfires if a session was spawned, crashed before its first turn,
but still got a `lastActivity` stamp (we stamp `lastActivity` on
session creation in some paths). Edge case; I didn't trace whether
this actually happens in practice.

### S6. `/api/chains/:issue/spec-status` and `/vp-status` depend on the VPS gateway for filesystem reads

`listGatewayFiles` / `fetchGatewayFile` go over HTTPS to the agent-gateway
(`CC_GATEWAY_URL`). If the gateway is down (e.g. dev worktree without
`dev-up.sh` running) both endpoints return `{exists: false}`, so
`planning → implementation` gates false with "Spec not found" and
`verify → close` gates false with "VP evidence not found". **This is
the exact failure mode that bit auto-advance in GH#73** — the server-side
path was fixed, but the client-side path (`useNextModePrecondition`)
still makes the same fragile calls.

---

## Dependency chain — what you'd have to fix, and in what order

1. **Fix #1 (`'completed'` → `isChainSessionCompleted`)** — one-file
   change, unblocks manual drag-to-advance and the `Start next` button
   for two out of four session-gated transitions.
2. **Bootstrap UI** — add a `kataIssue` input to the spawn form and/or a
   "Start research session" button on backlog kanban cards that opens a
   worktree picker. Without this, chains cannot be created from the UI.
3. **Auto-advance default / settings surface** — expose
   `default_chain_auto_advance` in `/settings`. Optional but makes the
   feature discoverable.
4. **Cache spec-status / vp-status on the DO side** — re-probe via the
   gateway and treat gateway-down as "unknown, retry later" rather than
   "does not exist". Or move the probe to the DO side where it can be
   cached in `session_meta` (same pattern as `runEnded`).

(I am not writing code — this is a research report. The above is
sequencing advice for whoever picks up the follow-up spec.)

---

## How to reproduce

### Minimal repro for bug #1

```bash
# in a fresh worktree
scripts/verify/dev-up.sh
# sign in as agent.verify+duraclaw@example.com
# manually insert a session with kataMode='research', status='idle', kataIssue=99
wrangler d1 execute duraclaw-auth --local --command \
  "INSERT INTO agent_sessions (id, user_id, project, status, kata_mode, kata_issue, last_activity, created_at) \
   VALUES ('test', '<userId>', '/data/projects/duraclaw', 'idle', 'research', 99, datetime('now'), datetime('now'))"
# open /board, drag the chain card from research → planning
# → toast "No completed research session"
```

### Minimal repro for bug #2

```bash
# fresh worktree, no GITHUB_REPO in .dev.vars
scripts/verify/dev-up.sh
# sign in, open /board
# → empty board, no affordance to create a chain
```

### Minimal repro for bug #3

```bash
# same setup as #2, then:
#   - POST /api/sessions with {kataIssue: 99, ...} via curl or REST client
#   - watch the session complete
#   - expect: new 'planning' session spawns
#   - actual: nothing happens (default_chain_auto_advance = 0)
# toggle via /api/user/preferences PUT with {defaultChainAutoAdvance: 1}
# next completion does spawn.
```

---

## References

- `planning/specs/16-chain-ux.md` — original chain UX epic
- `planning/specs/16-chain-ux-p1-5.md` — StatusBar widget + auto-advance amendment
- `planning/research/2026-04-22-chain-statusbar-widget-p1-5.md` — widget research
- `planning/research/2026-04-19-github-issue-board-integration.md` — GH integration research
- Commits: 6109f49 (GH#16), 821e0c0/1b3f889 (GH#58), 47d24ee (GH#73)

## Addendum — auto-advance UI reports spurious stall reasons ("no spec" / "no completed stage") even when the server-side path is fine

**User reported:** "Auto advance broken too — says 'no spec' or 'noncompleted stage'."

**Why that happens (and why my first pass under-weighted it):** the
server-side `tryAutoAdvance` after GH#73 only ever emits one stall
reason — `"Rung did not signal run-end (kata can-exit not satisfied)"`.
It does **not** emit "Spec not found", "No completed research session",
"No completed implementation session", or "VP evidence not found". Those
strings come exclusively from the **client-side** `checkPrecondition` in
`use-chain-preconditions.ts`.

So when the user sees those reasons against an auto-advanced chain, it
is coming from a separate fallback path I glossed over in the main
writeup. The full chain of causation:

1. User enables auto-advance on a chain (writes `chains_json` in
   `user_preferences`).
2. A chain session terminates. Server `tryAutoAdvance` runs with the
   `runEnded` bit. It does **one** of:
   - `action:'advanced'` — emits `chain_advance`. Fine.
   - `action:'stalled'` — emits `chain_stalled` with reason
     `"Rung did not signal run-end …"` or
     `"Worktree held by chain #N"`. Client stores reason in
     `chain-stall-store` (module-level `Map`), widget shows ⚠ with the
     real server reason.
   - `action:'none'` — silent (e.g. user pref OFF, already-spawned
     successor).
3. User reloads the page **or** the browser context is rebuilt
   (tab switch after long idle, Capacitor WebView destruction, etc.).
4. `chain-stall-store` is deliberately transient
   (`apps/orchestrator/src/lib/chain-stall-store.ts:11-14` — "Transient
   — not persisted; clears on chain_advance for the same issue or on
   reload"). So `wsStallReason` is now `null`.
5. `ChainStatusItem` runs its mount re-eval
   (`chain-status-item.tsx:230-254`): when the current session is
   `status === 'idle'` and auto-advance is on, it calls
   `checkPrecondition(chain, chain.sessions)`.
6. `checkPrecondition` is the exact client-side code from Bug #1 — it
   checks `s.status === 'completed'` for research→planning and
   implementation→verify (always false; `SessionStatus` has no
   `'completed'`), and it fetches `/api/chains/:issue/spec-status` +
   `/api/chains/:issue/vp-status` for planning→implementation and
   verify→close (those endpoints go through the VPS gateway — see
   `api/index.ts:2473`, `listGatewayFiles`; they return
   `{exists: false}` if the gateway is down, the worktree isn't
   reachable, or no spec file matches the issue-number prefix).
7. The re-eval writes its reason into `mountReevalStallReason`. The
   widget renders that as the current stall, with ⚠.
8. User concludes: "auto-advance is broken — it keeps saying 'no spec'
   or 'no completed stage'."

**What is actually true at that moment:**

- The chain may already have auto-advanced correctly (new successor
  session exists in D1 with `kataMode = next`).
- OR it may have silently not advanced because `runEnded=false` (kata
  Stop hook never fired — session was aborted, hit max_turns, or the
  runner fs.watch missed the file creation).
- OR it may have stalled with the genuine server reason, but that
  reason is gone because `chain-stall-store` didn't survive the
  reload.

The UI cannot distinguish those three cases — it papers over all of
them with whatever `checkPrecondition` returns, and `checkPrecondition`
returns false negatives for the reasons in Bug #1 and S6.

### Worked example: the specific strings the user quoted

- **"no spec"** — `checkPrecondition` reached the planning→implementation
  branch (`use-chain-preconditions.ts:125-135`). The spec-status fetch
  hit the gateway and returned `{exists: false}`. Three plausible
  causes:
  1. The spec file was never written (chain actually stuck on planning
     — real stall, but UI can't confirm it from the client).
  2. The spec file exists but the gateway-file listing returned a 404
     or a transient error (dev stack down, gateway restart race).
  3. The worktree path in `chain.sessions[*].project` doesn't match
     where the spec was written (e.g. the user wrote it in a sibling
     worktree). `listGatewayFiles(c.env, project, 'planning/specs')` is
     pinned to the reservation's worktree.
- **"noncompleted stage"** — `checkPrecondition` reached either
  research→planning or implementation→verify. Returned "No completed
  research session" / "No completed implementation session" because
  `s.status === 'completed'` is the dead literal from Bug #1. There
  may well be a completed-by-kata-stop research session visible in the
  UI under that same rung ladder — but the precondition code doesn't
  know how to recognise it.

### Why this ties back to the same fix

Fixing Bug #1 (replace `status === 'completed'` with the
`isChainSessionCompleted(s)` proxy) makes two of the four spurious
messages vanish. Moving the spec-status / vp-status probe off the
client (S6 — cache on the DO via a `lastSpecStatus` / `lastVpStatus`
bit written from the same kata/runner pipeline that produces
`runEnded`) eliminates the other two, along with the original
GH#73-style "gateway hiccup = permanent stall" risk.

Alternatively: drop the mount re-eval entirely and make
`chain-stall-store` read from a persisted source (OPFS or a small
`session_meta.last_stall_reason` mirror pushed over the synced
channel). The re-eval is only useful because the store is transient;
persisting the store removes the need for the broken fallback.

### Correction to the main TL;DR

My original summary said "auto-advance is the only path that actually
works today." That's defensible for the server-side computation, but
**from the user's perspective auto-advance does not read as working
either**, because the UI's post-reload fallback surfaces false-stall
text generated by the same broken client code that breaks manual
advance. The feature has effectively one set of reports — UI stall
messages — and those reports are dominated by Bug #1 regardless of
which server path you're on.

## Addendum B — `run-end.json` is never written (auto-advance permanently dead)

**Critical finding:** The entire auto-advance evidence-file gate (GH#73)
is based on a file that **nothing in the codebase creates**.

### Evidence

```bash
# Zero run-end.json files anywhere in the project
find /data/projects/duraclaw-dev2 -name "run-end*" \
  -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null
# (empty — zero results)
```

The GH#73 commit message states:

> Kata's Stop hook already writes `run-end.json` inside the session
> folder whenever `can-exit` succeeds (no-op modes + all stop conditions
> met; skipped on block / background-agents-running).

This is **false**. Kata's Stop hook handler (`packages/kata/src/commands/hook.ts:458-523`)
either outputs `{decision: "block"}` JSON on stdout (when canExit fails)
or outputs nothing (when canExit passes). It never writes a file. There
is no `writeFile`, `touch`, or `fs.stat` call targeting `run-end.json`
anywhere in `packages/kata/`.

### Impact

Since `run-end.json` is never created:
- The runner's watcher never detects it
  (`packages/session-runner/src/claude-runner.ts:121`)
- `readSessionKataState()` always returns `runEnded: false`
  (`packages/session-runner/src/claude-runner.ts:65-71`)
- The `kata_state` event always carries `runEnded: false`
- The DO's `lastRunEnded` is always `false`
- `tryAutoAdvance()` always reaches the gate at `auto-advance.ts:173`:
  ```ts
  if (!runEnded) {
    return {
      action: 'stalled',
      reason: 'Rung did not signal run-end (kata can-exit not satisfied)',
    }
  }
  ```
- Auto-advance is **permanently stalled** for every chain, every rung,
  regardless of whether can-exit actually passes.

### Why this wasn't caught

- GH#73's `auto-advance.test.ts` tests set `runEnded: true` in test
  fixtures — they test the happy path with the bit pre-set, never
  testing the real pipeline where the file has to actually exist.
- There is no integration test that runs a session through kata close,
  verifies `run-end.json` is written, and checks auto-advance fires.
- The session-runner unit tests don't test the watcher against real
  kata output.

### Why the user's suggestion is exactly right

The user suggested **replacing the file-based system with direct API
calls from kata CLI to Duraclaw endpoints**. This is now not just an
improvement — it's a necessity, because the file-based path is dead
code. The evidence:

1. `run-end.json` writer was never implemented in kata.
2. `state.json` works (kata does write it), but the file-watch pipeline
   adds 150ms+ latency, debounce jitter, fs.watch race conditions, and
   fails silently when the runner crashes or the watcher misses events.
3. The runner is the unnecessary intermediary — it exists because kata
   historically had no network path to the DO. But kata already runs
   inside a project where the runner set up the environment, and the
   runner could trivially inject `DURACLAW_SESSION_ID` +
   `DURACLAW_CALLBACK_URL` + `DURACLAW_AUTH_TOKEN` via
   `buildCleanEnv()` (`packages/session-runner/src/env.ts`).

### Proposed dual-write architecture

```
CURRENT (broken):
  kata writes state.json → runner fs.watch → runner reads → WS to DO
  kata DOES NOT write run-end.json → runEnded always false → auto-advance dead

PROPOSED (dual-write):
  kata writes state.json (backward compat)
  kata POST $DURACLAW_CALLBACK_URL/kata-state { sessionId, state, runEnded }
    → DO receives directly, zero latency, explicit ACK
    → file-watch path becomes fallback/redundancy, not primary

MINIMAL FIX (just run-end.json):
  kata hook stop-conditions: when canExit=true, write run-end.json:
    await writeFile(join(sessionDir, 'run-end.json'), '{}')
  → unblocks existing pipeline without new API surface
```

The minimal fix (write the file) is a 3-line patch. The dual-write
approach is better long-term but requires:
1. Runner injects 3 env vars into `buildCleanEnv()` (sessionId, URL, token)
2. Kata adds an HTTP POST helper that fires-and-forgets to the callback URL
3. SessionDO exposes a `kata-state` endpoint on its WS or HTTP RPC surface
4. Keep file writes for backward compat / offline / non-Duraclaw usage

Either way: the current system is not "fragile" — it is **non-functional**.
The auto-advance gate depends on a file that is never created.

## Open questions (for follow-up specs, not answered here)

- Should backlog → research need a project picker, or should it default
  to the repo the issue was filed against? (Latter requires a
  repo-to-worktree map.)
- Should auto-advance default to ON? Most users who enable chains
  presumably want the whole chain to run.
- Should `chainsCollection` be user-scoped or project-scoped? The
  current "shared across users" model produces noisy fan-out when
  teams share a workspace.
- Is the `runEnded` evidence-file path robust enough that we should
  remove the client-side `spec-status` / `vp-status` gates entirely and
  rely on it for manual advance too?
