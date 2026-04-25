---
date: 2026-04-25
topic: SessionDO refactor — simplify and prepare for multi-SDK runners
type: brainstorming + feasibility
status: complete
github_issue: 101
related_issues: [98, 100, 86, 30, 85]
related_specs:
  - planning/specs/30-runner-adapter-pluggable.md
  - planning/specs/37-session-state-collapse.md
  - planning/specs/76-session-state-subtraction.md
  - planning/specs/80-awaiting-response.md
  - planning/specs/86-haiku-session-titler.md
  - planning/specs/92-caam-claude-auth-rotation.md
related_research:
  - planning/research/2026-04-20-runner-adapter-evaluation.md
  - planning/research/2026-04-20-session-state-surface-inventory.md
  - planning/research/2026-04-22-session-do-partyserver-migration-feasibility.md
---

# Research: SessionDO refactor — simplify and prepare for multi-SDK runners

## TL;DR

`apps/orchestrator/src/agents/session-do.ts` is 5,646 lines (6,980 LoC
across the family) and concentrates ~10 distinct concerns inside one
class that `extends Agent`. Most of the bloat is hygiene debt, not
fundamental complexity — concerns can be extracted into focused modules
behind a thin DO façade with no behavior change. **For multi-SDK prep
(#98 ACP wedge, #30 RunnerAdapter), SessionDO needs surprisingly little
change**: the wire protocol is already ~95% agent-agnostic. The two
real bits of Claude-flavoring inside the DO are (a) the
`gateway-event-mapper.ts` content-block translator and (b) the
`sdk_session_id` field name + JSONL-transcript-on-disk assumption in
`forkWithHistory`. Everything else is name choice, not coupling.

Recommended sequencing: **(1) Hygiene split first** (no behavior
change, drops the main file from 5.6k LoC to ~1.5k); **(2) Capabilities
relay + naming generalization** (small surface, unblocks #98/#30);
**(3) Migration sediment cleanup** (last, lowest priority).

## Context

User goal: refactor SessionDO to (a) simplify and (b) prep for
non-Claude runners. Issue #98 introduces ACP-speaking runners with
Codex as the first non-Claude agent; the issue scopes the change at the
runner ↔ agent boundary and explicitly leaves the DO + browser
unchanged ("translator-style mapping: ACP messages → existing
GatewayEvent shapes"). Issue #30's spec already lays out a
`RunnerAdapter` interface on the runner side with `AdapterCapabilities`
flowing through `session.init`.

So the multi-SDK prep on the DO side is bounded — the heavy lift is on
the runner side per #30/#98. What this research adds is: the
**simplification** angle (where the DO has accumulated complexity
worth paying down now), and the **minimum DO-side surface** needed to
make non-Claude runners first-class.

## Inventory: what's actually in SessionDO today

Source: parallel exploration of `apps/orchestrator/src/agents/` and
`packages/{shared-types,shared-transport,session-runner,agent-gateway}`.

### File sizes

| File | LoC | Role |
|---|---|---|
| `session-do.ts` | 5,646 | Main DO class, all concerns mixed |
| `session-do-helpers.ts` | 699 | Pure helpers (snapshots, token compare, turn-state) |
| `session-do-migrations.ts` | 343 | 18 versioned SQLite migrations |
| `gateway-event-mapper.ts` | 292 | Claude content-block → SessionMessagePart translation |

### Concerns mixed inside session-do.ts

1. **Runner lifecycle** — `triggerGatewayDial`, `spawn`, `reattach`,
   `resumeFromTranscript`, `stop`, `abort`, `forceStop`, callback-token
   minting + timing-safe validation. ~20% of the file.
2. **Message history persistence** — wraps `Session` class
   (assistant_messages table), turnCounter, currentTurnMessageId,
   streaming aggregation. ~15%.
3. **Broadcast / WS fanout** — `broadcastMessage`,
   `broadcastMessages`, `broadcastBranchInfo`, `broadcastSessionRow`,
   `broadcastSyncedDelta`, role-based filtering. ~10%.
4. **Gate / permission handling** — `findPendingGatePart`,
   `resolveGate`, `clearPendingGateParts`, `isPendingGatePart`. Touches
   issue #100 (move gates out of CC hooks). ~5%.
5. **Status state machine** — `idle`/`pending`/`running`/`waiting_gate`/
   `error`/`waiting_profile`, `syncStatusToD1`, `persistMetaPatch`,
   D1 hydration. ~8%.
6. **Branch / rewind / fork** — `rewind`, `forkWithHistory`,
   `resubmitMessage`, `computeBranchInfo`,
   `serializeHistoryForFork`. ~10%.
7. **Event log** — `event_log` table, `logEvent`, `getEventLog` RPC,
   7-day pruning. ~3%.
8. **CAAM rotation handling** — `planRateLimitAction`,
   `pendingResume` persistence, alarm-driven delayed resume. ~5%
   (#92).
9. **Title generation** — `case 'title_update'` in
   `handleGatewayEvent`, never-clobber gate via `title_source`. ~2%
   (#86).
10. **Alarm watchdog** — recovery grace, stale-session detection,
    awaiting-response timeout, delayed-resume dispatch, self-rescheduling.
    ~5%.
11. **Hydration / migrations** — onStart, `hydrateMetaFromSql`, D1
    discovery (#53), 18 migrations. ~7%.
12. **RPC surface** — 16 `@callable` methods + 3 HTTP routes + 2 WS
    handlers (`onConnect`/`onMessage`). Threaded through everything
    above.

Roughly 10–12 cohesive concerns. None of them need to live in the same
file; most don't need to be methods on `Agent`.

### Claude-SDK-specific surface inside the DO (the part that matters
for multi-SDK)

This is the **only list that constrains the multi-SDK refactor**:

| Site | What's Claude-flavored | Generalization |
|---|---|---|
| `SessionMeta.sdk_session_id` | Field name + semantics (Claude SDK's resumable session handle) | Rename to `runner_session_id`; treat as opaque |
| `gateway-event-mapper.ts` | Translates Claude `content_block_delta` / `thinking_delta` shapes into `SessionMessagePart` | Either move into runner (per #98 ACP plan) or accept agent-flavored deltas as-is and translate at the runner layer |
| `forkWithHistory` | Builds `<prior_conversation>…</prior_conversation>` system-prompt prefix; assumes SDK reads JSONL transcript on disk for resume | Codex has no on-disk transcript; needs generic "resume by re-prompting with serialized history" path that's agent-agnostic |
| `total_cost_usd` aggregation | DO sums `result.total_cost_usd` from runner | Per spec #30 P2, delegate to `packages/pricing` keyed on `(provider, model, usage)` |
| Tool-result `applyToolResult` | Already generic — keys on `toolCallId`, agent-shape-neutral | No change |
| Gate shapes (`ask_user`, `permission_request`) | Already generic — Codex/Gemini will speak the same shapes via translator (#98) | No change |
| Status state machine | Generic — agnostic to which agent is speaking | No change |
| `session.init.capabilities` | Spec #30 already plans this: `{supportsRewind, supportsThinkingDeltas, supportsPermissionGate, ...}` | DO needs to **persist + relay** to UI; UI gates affordances on it |

**That's the entire list.** Five touch points, of which only two
(`sdk_session_id` rename + `gateway-event-mapper` simplification) carry
non-trivial code change. The wire protocol (`GatewayCommand` /
`GatewayEvent` types in `shared-types`) is already agent-agnostic — the
exploration confirmed that >95% of the protocol fields are Claude-name-
flavored at most, not Claude-shape-coupled.

## Smell catalog (simplification candidates, decoupled from multi-SDK)

Ordered by ROI. Each is independently shippable.

### S1. The DO is a god-class. Split into focused modules behind a thin façade.

5,646-line single file. No architectural reason it has to be one class.
The Cloudflare Agent base class only requires:
`onConnect` / `onMessage` / `onClose` / `alarm` / RPC methods bound to
the class. Everything else can be a free function or a helper class
constructed in `onStart`.

Proposed split (no behavior change, no schema change):

```
apps/orchestrator/src/agents/session-do/
  index.ts                  # SessionDO class — thin router, ~600 LoC
  history.ts                # Session class wrapper, message ops, snapshots
  broadcast.ts              # All broadcast* functions, role filtering
  gates.ts                  # Gate find/resolve/clear, isPendingGatePart
  runner-link.ts            # triggerGatewayDial, spawn/resume/reattach,
                              callback token mint+validate, force-stop
  status.ts                 # State machine, syncStatusToD1, persistMetaPatch
  branches.ts               # rewind, resubmit, fork-with-history,
                              computeBranchInfo, serializeHistoryForFork
  resume-scheduler.ts       # CAAM pendingResume, alarm-driven dispatch
  watchdog.ts               # alarm() body — recovery grace, stale,
                              awaiting-response timeout
  event-log.ts              # logEvent, getEventLog RPC, 7d pruning
  hydration.ts              # onStart restore, hydrateMetaFromSql,
                              D1 discovery (#53)
```

Each module gets `(do: SessionDO, …)` or a narrow context object as its
first arg. Tests can target modules directly without spinning up a full
DO. **No protocol change, no schema change, no client change.** Net
LoC roughly preserved; readability and test surface improve
dramatically.

This is the single highest-ROI change and a prerequisite for everything
else — it makes the subsequent multi-SDK changes localized.

### S2. Streaming aggregation has no transactional boundary

`handleGatewayEvent('partial_assistant')` collates deltas into a single
in-memory `SessionMessage`, persisting only on the final `assistant`
event. If the DO is evicted mid-turn, the partial state lives only in
the runner's BufferedChannel; the next DO instance sees a "naked
assistant" appear with no streaming history. The exploration agent
flagged this. Fix: queue partials to SQLite (debounced) so any DO
instance can rebuild the in-progress turn from the table.

### S3. CAAM `pendingResume` + watchdog scheduling has hibernation drift risk

Persisted `pending_resume_json` (migration v18) is correct; in-memory
`lastGatewayActivity` and `scheduleWatchdog()` calls are not durable.
On hibernation wake, scheduler state has to be reconstructed.
Currently this works, but it's not load-bearing on durable state alone.
Recommend: every scheduler input (next-alarm-at, awaiting-response-since)
is in SQLite; in-memory caches are derived, never source-of-truth.
Aligned with #69 hibernation-drift work.

### S4. Migration sediment: 18 versions, several no-ops/legacy

- v1–v3: legacy message/event/kv tables, deprecated
- v4: rename old tables
- v8: documented as no-op stub
- v11: renumbered as v14
- v13: backfill `modified_at = created_at`, no audit column

Compaction options: leave history alone but mark no-ops + legacy in
the migrations file with explicit comments; OR collapse pre-v6 into a
"baseline" migration for fresh deploys (existing DOs have already
migrated, but new project DOs would skip the dead steps). Lowest
priority — works fine as is.

### S5. Broadcast layering is hard to reason about

`broadcastMessage` → `broadcastMessages` → `broadcastSyncedDelta` with
role-based filters at each layer. After the S1 module split, this
becomes a single `broadcast.ts` that's easy to read; can then decide if
collapsing layers is worthwhile.

### S6. RPC dispatch is decorator-spread

16 `@callable` methods scattered through the file. After S1, can
optionally extract a thin `rpc.ts` that lists them in one place
(useful for docs and testing). Note: per the partyserver feasibility
study (#61 research), this is not a base-class change — keep
`extends Agent` and `@callable`, just colocate.

### S7. Title-update handler is ad-hoc

`case 'title_update'` in `handleGatewayEvent` has inline never-clobber
logic via `title_source`. After S1, lift into `title.ts` with an
explicit policy function (`titleResolutionPolicy(prev, incoming)`).
Pure code-organization win. (Aligned with #86.)

### S8. Gates as a candidate extraction (touches #100)

#100 wants to move all gate/permission handling out of CC hooks into
the duraclaw transport. The DO side of that work is already partially
in place (resolveGate, findPendingGatePart). Extracting `gates.ts`
in S1 makes #100 easier — its CC-side caller has a clean DO API to
call into.

## What multi-SDK prep on the DO actually looks like

Given #30 has already shipped a spec for the runner side (RunnerAdapter
+ AdapterCapabilities + per-agent classes) and #98 proposes ACP at the
runner ↔ agent boundary, the DO's job is:

### M1. Persist + relay `capabilities` from `session.init`

Already in #30's spec ("Update `apps/orchestrator` DO to persist
`capabilities` on `SessionState` and relay to the UI"). After S1, this
lands in `runner-link.ts` + a new column in `session_meta` (or JSON
blob field) and a broadcast on session row.

### M2. Rename `sdk_session_id` → `runner_session_id`

Pure naming. The DO treats it as opaque already. One migration to
rename the column; type rename across `SessionMeta`, `GatewayCommand`,
`GatewayEvent`. ~1-day mechanical change. Optional: keep the old name
as a deprecated alias for one release cycle.

### M3. Make `gateway-event-mapper.ts` agent-agnostic OR push it into
the runner

Two paths:

- **Path A (preferred, aligned with #98)** — runner is responsible for
  emitting already-translated `SessionMessagePart` shapes. The DO
  receives generic deltas. `gateway-event-mapper.ts` becomes very thin
  or disappears. ACP runner emits ACP→SessionMessagePart at the
  translator layer (per #98 plan). Codex runner does the same. Claude
  runner moves the existing mapper logic from the DO to the runner.

- **Path B (less invasive)** — keep the DO mapper, generalize it to
  handle ACP shapes alongside Claude shapes. Cheaper short-term, more
  branching long-term.

Recommend Path A in service of #98's clean ACP boundary. This is the
most "Claude-coupled" code in the DO today — moving it out of the DO
is the deepest change in the multi-SDK prep, and the only one with
real complexity.

### M4. Generalize `forkWithHistory` resume model

Today: serialise local history → drop sdk_session_id → spawn fresh
runner with transcript-prefixed prompt. Codex doesn't have a
JSONL-on-disk transcript to read; it has a thread API. The serialized
prompt-prefix approach actually works for both — the DO just needs to
not assume the runner can resume "by transcript file"; it always sends
the history as a prompt prefix when forking. Small change.

### M5. `total_cost_usd` source-of-truth

Move pricing computation out of the DO entirely; the runner emits raw
usage numbers, and `packages/pricing` (per #30 P2) computes USD per
adapter × model. The DO just stores the number it receives. Per-row
change in event handlers.

### Not-on-the-list

- Capabilities don't need a new wire-format. The `session.init` event
  already has `capabilities?` slotted (per #30 spec wording).
- No SQLite schema rework needed beyond the `runner_session_id`
  rename + a `capabilities_json` column.
- No client RPC shape change (UI gates affordances on a new field
  already broadcast via session row).

## Sequencing recommendation

Three independently shippable phases, each opens its own PR:

### Phase 1 — Hygiene split (no behavior change)

S1 only. Mechanical extraction of concerns into modules under
`apps/orchestrator/src/agents/session-do/`. Keep the public DO class
shape identical. CI green = ship.

- Drops `session-do.ts` from 5.6k LoC to ~600 LoC
- Each module independently testable
- Prerequisite for both Phase 2 and #100/#98 follow-ups
- ~2-3 days of careful extraction

### Phase 2 — Multi-SDK prep on the DO

M1 + M2 + M5. Capabilities relay, rename, pricing delegation. M4
is small and lands here too.

- One column add (`capabilities_json`), one column rename
  (`sdk_session_id` → `runner_session_id`)
- Forward-compatible with #30 P2 / #98 / Codex bring-up
- ~2-3 days

### Phase 3 — Move event-shape translation out of the DO

M3 (Path A). Coordinated change with the runner — the runner takes
over content-block translation. `gateway-event-mapper.ts` becomes a
thin pass-through or moves into the runner package.

- Couples to #98 directly; could be done as part of #98's P0/P1
- ~3-5 days

### Optional / later

S2 (streaming-aggregation persistence), S3 (hibernation-drift
hardening), S4 (migration compaction), S6 (RPC colocation), S7
(title-policy extraction). All independent, none urgent.

## GitHub issue

Filed as #101: `refactor(session-do): split into focused modules and
prep agent-shape boundary`. All 3 phases, sibling to #98, coordinated
with spec #30. See https://github.com/baseplane-ai/duraclaw/issues/101.

## Appendix A — Issue draft (filed as #101)

```markdown
# refactor(session-do): split into focused modules and prep agent-shape boundary

## Motivation

`apps/orchestrator/src/agents/session-do.ts` is 5,646 lines and
concentrates ~10 cohesive concerns inside one class — runner
lifecycle, message history, broadcast, gate handling, status state
machine, branch/rewind, event log, CAAM rotation, title generation,
alarm watchdog, hydration. Most of the bloat is hygiene debt.

Separately, #98 introduces ACP-speaking runners with Codex as the
first non-Claude agent. The DO's wire protocol is already ~95%
agent-agnostic; the remaining Claude-flavoring is small and isolated
(`sdk_session_id` naming, `gateway-event-mapper.ts` content-block
translation, `forkWithHistory`'s JSONL-transcript assumption,
DO-side cost aggregation).

This issue lands the DO-side work that makes both simplification and
multi-SDK clean.

## Scope

### Phase 1 — Hygiene split (no behavior change)

Extract concerns into modules under
`apps/orchestrator/src/agents/session-do/`:

- `history.ts`         — Session class wrapper, message ops, snapshots
- `broadcast.ts`       — broadcast* functions, role filtering
- `gates.ts`           — gate find/resolve/clear (also helps #100)
- `runner-link.ts`     — triggerGatewayDial, spawn/resume/reattach,
                          callback token, force-stop
- `status.ts`          — state machine, syncStatusToD1, persistMetaPatch
- `branches.ts`        — rewind, resubmit, fork-with-history,
                          computeBranchInfo, serializeHistoryForFork
- `resume-scheduler.ts`— CAAM pendingResume, alarm-driven dispatch
- `watchdog.ts`        — alarm() body
- `event-log.ts`       — logEvent, getEventLog, 7d pruning
- `hydration.ts`       — onStart restore, D1 discovery (#53)
- `index.ts`           — SessionDO class, ~600 LoC, thin router

CI green ⇒ ship. No protocol, schema, or client change.

### Phase 2 — Multi-SDK prep on the DO

- Persist + relay `session.init.capabilities` (per #30 P1)
- Rename `sdk_session_id` → `runner_session_id` (column + types)
- Move USD cost computation out of the DO; delegate to
  `packages/pricing` (per #30 P2)
- Generalize `forkWithHistory` to not assume disk-transcript resume

### Phase 3 — coordinated with #98

Move event-shape translation out of the DO (`gateway-event-mapper.ts`
becomes a thin pass-through; runner emits already-translated
`SessionMessagePart`). Land alongside #98's P0/P1.

## Non-goals

- PartyServer base-class migration (declined in #61 research —
  too expensive for the value, blockers in `Session` class +
  `@callable` rework).
- RPC framework changes — keep `extends Agent` + `@callable`.
- Wire protocol changes (`GatewayCommand` / `GatewayEvent` types).
- Streaming-aggregation persistence (S2 in research) — defer until
  prod evidence shows it bites.

## Acceptance

- Existing Claude sessions: zero behavior change vs. current main.
  Full vitest + integration suite passes.
- `session.init.capabilities` is persisted on the DO and broadcast
  to the UI on the session row.
- A non-Claude runner (Codex via #98) can be brought up end-to-end
  without DO-side code changes beyond what this issue lands.
- `sdk_session_id` rename is mechanical; no semantic change.

## Related

- Sibling to: #98 (ACP-speaking runner, Codex bring-up)
- Helps: #100 (gate handling refactor), #69 (hibernation drift
  hardening)
- Depends on / coordinated with: spec #30 (RunnerAdapter)
- Research: planning/research/2026-04-25-session-do-refactor-multi-sdk-prep.md
```

## Sources

- `apps/orchestrator/src/agents/session-do.ts` — exhaustive structural
  inventory via Explore agent (5,646 lines)
- `apps/orchestrator/src/agents/{session-do-helpers,session-do-migrations,
  gateway-event-mapper}.ts`
- `packages/{shared-types,shared-transport,session-runner,
  agent-gateway}/src/**`
- Issue #98 body via `gh-axi issue view 98 --full`
- Issue #100 title (gate/permission handling refactor)
- Spec #30 (`planning/specs/30-runner-adapter-pluggable.md`) — runner
  adapter interface, capabilities, pricing delegation
- Research `2026-04-22-session-do-partyserver-migration-feasibility.md`
  — declines PartyServer migration; constrains the design space
- Research `2026-04-20-runner-adapter-evaluation.md` — multi-agent
  baseline analysis
