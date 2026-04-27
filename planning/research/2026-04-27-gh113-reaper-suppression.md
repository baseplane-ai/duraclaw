---
date: 2026-04-27
topic: GH#113 reaper suppression while runner parked on a gate
type: feasibility
status: complete
github_issue: 113
items_researched: 5
---

# Research: GH#113 — runner parked on `ask_user` gate gets reaped

## Context

Per GH#113: when the runner emits an `ask_user` GatewayEvent and parks on
`PushPullQueue.waitForNext()` for the user's answer, it correctly waits
indefinitely — but the gateway's idle reaper kills it after 30 minutes
because the runner emits no events while parked, so its
`last_activity_ts` goes stale. On resume the agent re-asks independently
but has lost the original gate's blocking semantics and context.

The issue offered two fixes (runner heartbeat / DO-side suppression) and
preferred the latter on the assumption that the DO already tracks
`SessionMeta.transient_state`. **Research shows that assumption is
false** — `transient_state` is a comment-level design intention, not an
implemented field — so the issue's preferred path doesn't work as
described. This research evaluated the actual signal and storage
surface and arrived at a third option that's strictly cleaner.

## Scope

Five parallel deep-dives:
1. Reaper implementation (gateway-local? DO-driven?)
2. `session_state_changed` event flow (does the signal actually flow?)
3. Gate lifecycle in runner & DO (where does the gate live?)
4. `SessionMeta` / `hydrateMetaFromSql` schema
5. Reaper config, threshold, and observability

## Findings

### 1. Reaper is gateway-local and DO-agnostic

- **Location**: `packages/agent-gateway/src/reaper.ts`
- **Cadence**: every 5 min (`DEFAULT_INTERVAL_MS`, line 7)
- **Threshold**: `30 * 60_000` ms hard-coded (`DEFAULT_STALE_THRESHOLD_MS`, line 8)
- **Decision**: scans `${SESSIONS_DIR}/*.pid`; reads `${id}.meta.json`
  for `last_activity_ts`; `currentNow - lastActivityTs > staleThresholdMs`
  triggers SIGTERM (line 272), then SIGKILL after a 10s grace.
- **No DO call before reap**, no notification after. The DO learns only
  when its own `maybeRecoverAfterGatewayDrop()` (`runner-link.ts:296`)
  probes `GET /sessions/:id/status` after the WS closes.
- **DO has its own watchdog** (`apps/orchestrator/src/agents/session-do/watchdog.ts:27`,
  90s default, `STALE_THRESHOLD_MS` env-overridable) but it does **not
  reap runners** — it only triggers `recoverFromDroppedConnection()`.
- **`last_activity_ts` is stamped on every SDK event by the runner**
  (`packages/session-runner/src/main.ts:536`) and flushed every 10s
  (line 411, 428). When parked on a gate, no events flow → timestamp
  goes stale → reaper fires.

### 2. `session_state_changed` is broadcast-only; nothing persists

- **Runner emits** `session_state_changed` with states
  `idle | running | requires_action | compacting | api_retry`
  (`packages/session-runner/src/claude-runner.ts:600–663`).
- **DO consumes** at `apps/orchestrator/src/agents/session-do/gateway-event-handler.ts:837–839`:
  `self.broadcastGatewayEvent(event)`. Comment explicitly says the DO
  does NOT mutate `ctx.state.status` from this event — it's a transient
  UI signal only.
- **Commit d766f2c** simply removed `session_state_changed` from a
  legacy-drop set and added explicit case arms for several previously
  falling-through event types. It did not introduce any persistence
  layer.
- **`SessionMeta.transient_state` does not exist.** No schema column,
  no `META_COLUMN_MAP` entry, no `hydrateMetaFromSql` mapping
  (`apps/orchestrator/src/agents/session-do/index.ts:96–130`,
  `hydration.ts:75–116`). The mention is aspirational comment only.

**Implication**: the reaper has nowhere to read `transient_state` from,
and adding such a field would still leave the unsolved problem of how
the gateway-local reaper *gets* that signal (it doesn't talk to the
DO).

### 3. Gate state is already persistent — in `assistant_messages`

- Runner emits `ask_user` / `permission_request` from `canUseTool`
  callback (`claude-runner.ts:280–337`); parks on a Promise (lines
  302–352).
- DO sets `status: 'waiting_gate'` (which IS persistent — column on
  `session_meta`) AND writes a tool message part with
  `state: 'input-available'` / `'approval-requested'` into
  `assistant_messages` (`gateway-event-handler.ts:309–454`).
- On client reconnect, `replayMessagesFromCursor()`
  (`client-ws.ts:272–339`) re-emits every `assistant_messages` row past
  the cursor — including the pending-gate part. The client's
  `GateResolver` re-mounts the question UI from `messagesCollection`.

**Implication for the issue's "secondary fix":** persisting
`pending_gate_type` / `pending_gate_payload` on `session_meta` is
**redundant**. Clients see pending gates via message replay from
`assistant_messages`, not from session_meta scalars. DO restart while
gated already works correctly.

### 4. `session_meta` schema and migration pattern

- Table established at v6, evolved through v18; registry in
  `apps/orchestrator/src/agents/session-do/do-migrations.ts`.
- `hydrateMetaFromSql()` (`hydration.ts:75–116`) iterates
  `META_COLUMN_MAP` (`types.ts:118–143`) to map field → column.
- Adding a column is a small registry entry; existing precedent
  for JSON-blob columns (`capabilities_json`, legacy `gate_json`).
- **For GH#113 primary fix: no migration is needed** if we keep the
  signal in the runner's `.meta.json` file (which the reaper already
  reads).

### 5. Reaper observability

- Reaper logs to gateway stdout only via `[reaper]` prefix
  (`reaper.ts:291, 402, 410`). Visible via `journalctl` /
  `wrangler tail` for the worker but **not queryable** because nothing
  hits the DO's `event_log` table.
- DO watchdog uses `console.log` not `logEvent()` —
  intentionally not in event_log (`watchdog.ts:207–209`).
- CLAUDE.md tags today: `gate`, `conn`, `rpc`. **No `reap` tag** exists.
- Test infra: reaper tests inject `now: () => FIXED_NOW` and override
  `staleThresholdMs` per test (`reaper.test.ts:128, 155, 233`). DO
  watchdog tests inject `STALE_THRESHOLD_MS` via env. No existing
  test covers "parked gate must NOT be reaped."

## Comparison: fix options

| Option | Mechanism | DO change | Gateway change | Runner change | Migration | Verdict |
|---|---|---|---|---|---|---|
| **A. Runner heartbeat while gated** | Runner emits periodic event refreshing `last_activity_ts` | none | none | timer + emit | none | Works, but adds steady event-stream noise the issue itself flagged |
| **B. DO-side suppression as issue describes** | DO tracks `transient_state`; reaper queries DO before SIGTERM | new column + handler | new HTTP probe before reap | none | yes | Adds gateway↔DO call that doesn't exist; couples control planes the architecture intentionally separates; depends on field that doesn't exist |
| **C. Runner meta-file flag (recommended)** | Runner stamps `pending_gate` into `${id}.meta.json` on park, clears on resume; reaper reads it | none for primary fix | one read + skip in reapOnce() | meta-file write on park/resume | none | Single source of truth (the runner is the one parked); no new APIs; uses primitives both processes already share |

## Recommendations

### Primary fix — Option C: runner meta-file flag

1. **Runner**: in `claude-runner.ts` at the gate-park sites
   (`canUseTool` AskUserQuestion path, line ~302; permission path,
   line ~341), stamp into the meta file:
   ```
   meta.pending_gate = { type: 'ask_user' | 'permission_request',
                         tool_call_id, parked_at_ts: Date.now() }
   ```
   Flush atomically (existing `atomicOverwrite` path). Clear the field
   immediately when the parked Promise resolves or rejects, before
   continuing the SDK turn.
2. **Reaper**: in `reaper.ts:289` immediately before SIGTERM, if
   `meta.pending_gate` is present and `parked_at_ts` is sane (e.g.
   within last 24h to guard against stale flags), skip SIGTERM and
   continue to next session. Log the skip via the new `reap` tag (see
   below).
3. **Edge cases**:
   - **Runner crashes while parked**: meta file retains
     `pending_gate`. Pid is dead. Reaper's "alive AND stale" precondition
     (`reaper.ts:272`) protects: `process.kill(pid, 0)` returns
     ESRCH for dead pids → not in the `alive` branch → existing
     crashed-marker path runs. `pending_gate` does NOT prevent
     reaping a dead pid.
   - **Meta file missing**: reaper falls back to pid mtime today
     (`reaper.ts:268`). With pending_gate absent, fall-through is
     existing behavior — no change.
   - **Resume races reap scan**: if the user answers exactly as the
     reaper is mid-decision, the runner clears `pending_gate` and
     emits an event refreshing `last_activity_ts`. Reaper sees stale
     snapshot → SIGTERM. Mitigation: re-read meta inside the alive
     branch right before SIGTERM (the existing code already reads it
     once at line 265; one extra read in the SIGTERM path closes the
     window).
   - **Flag set but never cleared (runner bug)**: bounded by the
     `parked_at_ts` sanity check; after 24h treat as cleared and
     reap normally.

### Secondary fix — drop entirely

Gates already persist to `assistant_messages`; client reconnect via
`replayMessagesFromCursor()` already re-renders pending gates. DO
restart while gated works without any new persistence. The issue's
proposed `session_meta.{pending_gate_type, pending_gate_payload}`
columns would be redundant. If a real "DO restart lost my gate"
failure surfaces in production, file a follow-up with concrete
repro.

### Observability — add `reap` event_log tag

- Add `reap` to the canonical tag set documented in CLAUDE.md.
- Gateway emits a structured log on every reap decision (kill or
  suppress). Since the gateway can't write to a DO's `event_log`
  directly, two options:
  - **Stdout-only with strict prefix**: `[reaper] decision={kill|skip-pending-gate} sessionId=X reason=Y`. VP greps gateway journal. Simple.
  - **POST to DO**: gateway POSTs reap decisions to a new DO RPC
    (e.g. `recordReapDecision`) which calls `logEvent('info', 'reap', …)`. Durable, queryable. Adds an API surface.
- **Recommended**: stdout-only for now (matches the architectural
  rule that gateway↔DO interactions are minimal). Document the log
  shape in the spec so VP can rely on it. Promote to event_log only
  if prod debugging demands it.

## Open questions

None blocking. The fix shape is determined.

## Next steps

1. **P1 — interview**: confirm acceptance criteria (24h sanity-check
   threshold? Resume-race mitigation strategy? Stdout vs event_log
   for `reap` tag?)
2. **P2 — write spec** at
   `planning/specs/gh-113-reaper-suppression.md` with behaviors:
   - B1: Runner stamps `pending_gate` on park
   - B2: Runner clears `pending_gate` on resume
   - B3: Reaper skips SIGTERM when `pending_gate` is present and fresh
   - B4: Reaper still reaps dead pids regardless of `pending_gate`
   - B5: Reaper re-reads meta in the SIGTERM path to close the resume race
   - B6: `reap` tag and structured log shape
3. **P3 — review**, **P4 — close** per kata workflow.

## Sources

- `packages/agent-gateway/src/reaper.ts` (full file)
- `packages/session-runner/src/main.ts:380, 411, 428, 536`
- `packages/session-runner/src/claude-runner.ts:280–352, 600–663`
- `apps/orchestrator/src/agents/session-do/gateway-event-handler.ts:309–454, 837–839`
- `apps/orchestrator/src/agents/session-do/client-ws.ts:81, 157, 272–339`
- `apps/orchestrator/src/agents/session-do/runner-link.ts:296–316`
- `apps/orchestrator/src/agents/session-do/watchdog.ts:27–221`
- `apps/orchestrator/src/agents/session-do/index.ts:96–130`
- `apps/orchestrator/src/agents/session-do/hydration.ts:75–116`
- `apps/orchestrator/src/agents/session-do/types.ts:48–143`
- `apps/orchestrator/src/agents/session-do/do-migrations.ts` (registry)
- `packages/agent-gateway/src/reaper.test.ts:128, 155, 182, 207, 233, 254, 269, 296, 321`
- `apps/orchestrator/src/agents/session-do.test.ts:1409–1429`
- Commit `d766f2c` (`git show d766f2c`)
- `.claude/rules/session-lifecycle.md`
