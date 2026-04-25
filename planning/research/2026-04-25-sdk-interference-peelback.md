---
date: 2026-04-25
topic: SDK interference peel-back — collapse the runner↔DO wire to "send messages, interrupt, stop"
type: feature-research + feasibility
status: complete
github_issue: 101
related_issues: [101, 100, 98, 86, 30]
related_specs:
  - planning/specs/30-runner-adapter-pluggable.md
  - planning/specs/98-acp-codex-runner.md
related_research:
  - planning/research/2026-04-23-sdk-mid-stream-input-api.md
  - planning/research/2026-04-25-session-do-refactor-multi-sdk-prep.md
  - planning/research/2026-04-25-acp-codex-runner.md
items_researched: 5
---

# Research: SDK interference peel-back

## TL;DR

Duraclaw's runner↔DO wire surface has accreted into a near-1:1 proxy of
the Claude Agent SDK *plus* a parallel hand-rolled liveness/multi-turn
stack — 14 wire commands, 26 wire events, a per-turn `query({resume})`
loop instead of `Query.streamInput()`, a 5-layer liveness derivation
(heartbeat + watermark + alarm watchdog + D1 fallback + UI hook), and
11 SDK message variants dropped on the floor. Three of those drops are
high-UX-value (`session_state_changed`, `compact_boundary`, `api_retry`).

The cleanest possible peel-back is **four reductions stacked**, none of
which require pass-through `SDKMessage` shapes on the wire (that
inversion was tested and discarded — it would *increase* DO Claude-
coupling, not decrease it):

1. **Reduction B — One `Query` per session** via `streamInput()`. Drop
   per-turn `query({resume})`. Endorsed by prior research
   (`2026-04-23-sdk-mid-stream-input-api.md`); also fixes a latent bug
   where our existing `streamInput()` call half-closes CLI stdin.
   ~−220 LOC in `claude-runner.ts`.
2. **Reduction C — `session_state_changed` liveness**. Replace
   `HeartbeatEvent` + `lastGatewayActivity` watermark + 30s alarm
   walking. Keep one thin transport-level dead-man's switch. ~−20 LOC,
   no UI churn (output contract is unchanged).
3. **Reduction D — Adopt the 3 high-value SDK signals we're dropping**:
   `session_state_changed` (liveness, see (C)), `compact_boundary`
   (transcript seam UX), `api_retry` (transient-failure banner).
4. **Reduction E — Move `gateway-event-mapper.ts` from DO to runner**
   per #98/#30. Aligns this research with the established multi-SDK
   plan; lets the wire stay agent-neutral while shrinking the DO.

After all four: wire collapses from 14 commands → 6
(`execute`/`resume`/`stream-input`/`interrupt`/`stop`/`ping`), 26 events
→ ~12 (drop `heartbeat`, drop the four `mode_transition*`, drop chain
events that aren't yet wired, replace `rewind_result` and
`context_usage` with on-result attachments, add three SDK adoptions),
multi-turn becomes one-Query, liveness becomes SDK-native, and the DO
sheds ~292 LOC of mapper code that lives more naturally in the runner.

Total estimated LoC delta: **~−600 LOC net delete** across runner +
DO + types, with **zero UI hook contract changes**.

## Context

User framing: *"we have gone too far in interfering with sdk running
natural flow and need to peel back to just send messages and interrupt/
stop in the cleanest way possible."*

Initial scoping suggested this was a wire-surface conversation only,
but the user correctly pushed back: *"yes but i feel like its not just
the surface structure but our event system and various pings, status
updates, background resume, tool call responses etc. need full map."*

So this research starts from a **complete inventory** of every place
Duraclaw layers on top of the SDK — input commands, output events,
liveness, multi-turn, fork/resume, gates — and asks: *what is the
minimum-interference shape, given everything the SDK already gives
us natively?*

Adjacent in-flight work that this research interlocks with:

- **#101** (split SessionDO into focused modules) — hygiene split.
  Orthogonal; this research mostly *deletes* code instead of relocating
  it. Should land after this peel-back so the split happens on a
  smaller surface.
- **#98** (ACP/Codex runner via translator-style mapping) — explicitly
  chose `GatewayEvent` as the agent-neutral wire, with translation in
  the runner. This research validates that direction (rejecting raw
  `SDKMessage` pass-through) and proposes the mapper-move as Reduction
  E, finishing what #98 starts.
- **#100** (move gates out of CC hooks into Duraclaw transport) — owns
  the `permission-response`/`answer` commands and `ask_user`/
  `permission_request` events. This research's Reduction A defers to
  #100's design for those; the six-verb wire surface assumes #100 has
  landed or runs concurrent.
- **#30** (RunnerAdapter abstraction for non-Claude runners) — sets the
  contract (`AdapterCapabilities` via `session.init`). Reduction E is
  the runner-side mapper move that #30 implies.

## Scope

Five items, deep-dived in parallel by Explore agents:

| # | Item | Output |
|---|---|---|
| 1 | Canonical SDK `Query` control surface (input methods, streaming-mode prerequisites, version-skew risk) | Reference table of all 27 Query methods + 8 standalone functions, annotated with our usage |
| 2 | Canonical SDK message stream — what we drop on the floor | Catalogue of 11 dropped variants, UX-relevance scoring |
| 3 | Multi-turn `Query.streamInput()` feasibility (one Query per session) | Feasibility verdict + LoC delta + risk assessment |
| 4 | `session_state_changed` liveness adoption — can it replace our 5-layer stack? | Coverage matrix + residual-watchdog scope + UI-hook impact |
| 5 | Raw `SDKMessage` wire pass-through (the user's initial preference) — does it hold up against the multi-SDK plan? | Verdict + 3-option ranked recommendation |

Sources cited inline; raw agent reports are the authoritative finding;
this synthesis cherry-picks the operational conclusions.

## Findings

### Item 1 — `Query` control surface

**Source:** `node_modules/.../claude-agent-sdk/sdk.d.ts:1687-1877`,
cross-referenced against `packages/session-runner/src/{commands,
main,claude-runner}.ts`.

**The SDK exposes 27 methods on `Query`.** Duraclaw uses 4 (interrupt,
setModel, setPermissionMode, getContextUsage) plus `streamInput`. The
remaining 22 fall into:

- **Introspection** (6): `initializationResult`, `supportedCommands`,
  `supportedModels`, `supportedAgents`, `mcpServerStatus`,
  `accountInfo`. Never needed at the wire — this info is already on
  `system.init`.
- **Session/config mutation** (7): `applyFlagSettings`, `reloadPlugins`,
  `rewindFiles`, `seedReadState`, `reconnectMcpServer`,
  `toggleMcpServer`, `setMcpServers`. Mostly unused; `rewindFiles` is
  the SDK-native version of our hand-rolled `rewind` command.
- **Tasks** (1 used, 1 unused): `stopTask` is unused even though our
  `stop-task` wire command exists; today it just isn't wired through.
- **Lifecycle** (1): `close()`. We use SIGTERM instead — keep it that
  way, `close()` is the harshest option.
- **Deprecated** (1): `setMaxThinkingTokens`. Replaced by
  `query({options:{thinking}})`.

**Streaming-input-mode entry mechanism confirmed:** the SDK enters
streaming-input mode iff `query({prompt})` is called with an
`AsyncIterable<SDKUserMessage>` rather than a `string`. We do this
already (`claude-runner.ts:780-792`'s `initialPrompt()`
async generator), so all control methods are unlocked from t=0.

**Version-skew risk in 0.2.x:** SemVer-loose (pre-1.0). The 0.2.91 →
0.2.98 range has had non-breaking minor changes (e.g. `options.env`
now replaces rather than merges process env). The dual zod-peer
install in `node_modules/.pnpm` (`zod3` and `zod4` flavours of 0.2.98)
is a warning sign that peer-dep changes can ripple. **Implication:**
keep the SDK at the runner boundary; never let SDK shapes leak into
the wire (validates Reduction E, falsifies pass-through).

**Standalone functions worth highlighting:** `forkSession()` exists.
Our `forkWithHistory` in `session-do.ts` is a hand-rolled equivalent
that serialises history into a `<prior_conversation>` prefix and
spawns a fresh execute. The SDK-native fork is a candidate
replacement, but out of scope here — see open question 4.

### Item 2 — Dropped SDK message variants

**Source:** `sdk.d.ts:2497` (the `SDKMessage` union, 25 variants),
cross-referenced against `claude-runner.ts:533-770` (the
`processQueryMessages` switch).

**11 variants are dropped on the floor today:**

| Variant | Trigger | UX value | Recommendation |
|---|---|---|---|
| `SDKSessionStateChangedMessage` | idle/running/requires_action transitions | **HIGH** — canonical liveness | **Adopt** (Reduction C) |
| `SDKCompactBoundaryMessage` | mid-session auto-compact | **HIGH** — transcript seam, "context compacted: 45K → 8K" | **Adopt** (Reduction D) |
| `SDKAPIRetryMessage` | transient API failure (5xx/529) | **HIGH** — prevents "session looks frozen" | **Adopt** (Reduction D) |
| `SDKStatusMessage` | permission-mode change; compaction state | MEDIUM — partial overlap with adopted signals | Conditional |
| `SDKToolProgressMessage` | long-running tool elapsed time | MEDIUM — partial overlap with `partial_assistant` deltas | Defer |
| `SDKHookStarted/Progress/Response` | git/workflow hook lifecycle | LOW — no UI surface today | Defer |
| `SDKAuthStatusMessage` | auth flow | MEDIUM-LOW — rarely seen in normal flow | Defer |
| `SDKLocalCommandOutputMessage` | slash command execution | MEDIUM — silent today | Defer |
| `SDKFilesPersistedEvent` | file save batch | LOW — internal | Defer |
| `SDKElicitationCompleteMessage` | MCP elicitation teardown | LOW — control flow only | Defer |
| `SDKPromptSuggestionMessage` | suggested next user prompt | LOW — no suggestion UI | Defer |

The three high-value adoptions (top three rows) are folded into
Reductions C and D below. The user requested "full SDK signal
adoption" for these three, so they're all in scope.

### Item 3 — One `Query` per session via `streamInput()`

**Source:** `claude-runner.ts:529-846` (multi-turn loop) and
`sdk.d.ts:1862` (`streamInput`); also prior research at
`planning/research/2026-04-23-sdk-mid-stream-input-api.md` (commit
`280adf1`) which already endorsed this exact pattern.

**Verdict: feasible.** The SDK's `streamInput()` is documented as
"used internally for multi-turn conversations" (`sdk.d.ts:1858`), the
returned `Query` survives `interrupt()`, and conversation context
persists for the lifetime of the underlying CLI subprocess.

**Bug-shaped finding.** Our existing `streamInput()` call at
`packages/session-runner/src/main.ts:178` is *incorrectly used*. The
SDK 0.2.98 implementation unconditionally calls
`transport.endInput()` when the iterable exhausts — half-closing CLI
stdin on each call. This works once and then subsequent calls write
to closed stdin. The correct shape is a **single lifetime async
iterable** passed to `query({prompt})` at construction, with new
messages enqueued onto that iterable for the session's lifetime. This
is what the prior research (`2026-04-23-sdk-mid-stream-input-api.md`)
recommended as `PushPullQueue`.

**LoC delta:** ~−220 LOC from `claude-runner.ts` (the multi-turn loop
at lines 796-846, the per-turn `initialPrompt`/`followUpPrompt`
generators, the `createMessageQueue` plumbing, the `resumeOpts`/
`resume:sdkSessionId` glue, the idle-stop branching). Plus collapse
of the `commands.ts` `QueueableCommand` queue (~50 LOC) — once Query
is always live after init, the "queue commands until Query is ready"
plumbing is unnecessary.

**Risks (all low or [uncertain] but cheap to verify):**
- Long-lived Query holds an open subprocess — fine, that's the design.
- Cumulative model context grows until compact fires — already bounded
  by the SDK's auto-compact; not new.
- MCP servers set at construction don't reconnect on transient drops
  — `setMcpServers()` mid-session is available if needed; not blocking.
- JSONL transcript: one writer instead of N short-lived appenders
  — should be fine (line-buffered), worth a one-test verify.

**`forkWithHistory` orphan recovery is unaffected** — it spawns a
fresh runner with serialised history; the runner's internal turn
pattern is orthogonal. If anything, fork fits one-Query-per-session
cleaner because the fork starts a new top-level `query()`.

### Item 4 — `session_state_changed` liveness

**Source:** `sdk.d.ts:2729-2738`; `apps/orchestrator/src/agents/
session-do.ts` (the alarm/watchdog plumbing); `packages/session-
runner/src/main.ts:36,479` (15s heartbeat); `apps/orchestrator/src/
db/session-local-collection.ts:126-129` (`useSessionStatus`).

**Verdict: replace with thin residual watchdog.** The SDK signal
covers normal turn completion, gate transitions
(`requires_action`), and clean WS disconnect. It does *not* cover:
- Runner process kills (-9 / OOM).
- Silent network partition (WS dropped without FIN/RST).
- SDK internal stalls (compact, API retry, plugin reload) where the
  SDK doesn't emit a state change.

**Coverage matrix:**

| Scenario | Heartbeat (today) | session_state_changed | Residual watchdog |
|---|---|---|---|
| Normal turn complete | ✓ | ✓ | n/a |
| Gate (permission/ask_user) | ✓ | ✓ | n/a |
| Clean WS drop | ✓ | ✓ | n/a |
| Runner -9 / OOM | ✓ | ✗ | ✓ needed |
| Silent partition | ✓ | ✗ | ✓ needed |
| SDK internal stall | ✗ | [uncertain] | ✓ needed |

**The thin residual:** keep the 30s `alarm()` cycle but reframe it as
"no event of *any* kind in N seconds → recovery". This generalises
`lastGatewayActivity` from "last heartbeat" to "last anything".

**LoC delta:** ~−20 LOC delete (heartbeat emission loop,
`HeartbeatEvent` interface, `case 'heartbeat':` no-op) + ~10 LOC
modified (alarm reframing).

**Crucial finding: zero UI churn.** `useSessionStatus` reads the
DO-stamped `n` field on every WS frame; the UI's `SessionStatus` enum
(`idle | pending | running | waiting_input | waiting_permission |
waiting_gate | error`) is *richer* than SDK's
(`idle | running | requires_action`) and is derived inside the DO,
not on the wire. The DO's derivation can ingest
`session_state_changed` as a primary input instead of heartbeat, with
the same output contract — no consumer changes.

The legacy `useDerivedStatus` hook is already deprecated in favour of
`useSessionStatus`; this migration confirms it was the right call.

### Item 5 — Raw `SDKMessage` wire pass-through

**Source:** Agent 5's full report; `packages/shared-types/src/
index.ts:146-172` (GatewayEvent union); `apps/orchestrator/src/
agents/{session-do,gateway-event-mapper}.ts`; multi-SDK research at
`planning/research/2026-04-25-{acp-codex-runner,session-do-refactor-
multi-sdk-prep}.md`.

**Verdict: do not pass through. Move the mapper to the runner instead.**

I asked the agent to argue for pass-through. The agent came back with
a citation-heavy case against it, and the case holds:

1. **ACP/Codex runners speak JSON-RPC, not `SDKMessage`.** Forcing a
   Codex-ACP adapter to emit SDK-shaped envelopes is *another*
   translation layer (ACP → SDKMessage), not a removed one. Net zero
   simplification on the multi-SDK side, with extra coupling.
2. **`GatewayEvent` is ~95% agent-neutral by design.** `SDKMessage`
   is ~30% Claude-specific (`thinking_delta`, `tool_use_summary`
   naming, rate-limit info, extended-thinking). Inverting the wire
   pulls more Claude-isms across the boundary, not fewer.
3. **DO merger logic** (`mergeFinalAssistantParts`, runaway-turn
   fingerprinting, thinking-delta accumulation) is already 100%
   Claude-specific. Pass-through *adds* SDK-version sensitivity to
   that logic without removing the Claude-coupling.
4. **SDK version skew becomes a DO problem.** With `GatewayEvent` as
   the wire, an SDK 0.3.0 shape change is a runner-internal patch.
   With `SDKMessage` as the wire, every SDK update is a DO update,
   tested against every runner-version-it-might-talk-to.
5. **Violates #30 spec.** RunnerAdapter's contract is "agent-specific
   protocol → neutral wire". Pass-through inverts that.

**Reframe — the right reduction.** The user's instinct ("we've gone
too far") is correct, but the cure is shrink + native-signal adoption
+ mapper-move:

- **Shrink** `GatewayEvent` from 26 → ~12 types by deleting hand-
  rolled events the SDK already gives us natively (heartbeat,
  mode_transition*, chain_*) and folding RPC replies into existing
  events (`context_usage`/`rewind_result` become attachments on
  `result`).
- **Adopt** the 3 dropped SDK signals (Reduction D).
- **Move** `gateway-event-mapper.ts` from `apps/orchestrator/src/
  agents/` to the runner, so the DO never sees Claude-specific
  shapes. This is the natural completion of #98 / #30 / #101.

User-confirmed this direction in mid-research clarification: *"no we
move translation to the runner as was suggested in other spec right?"*

## Reductions (the actual proposal)

### Reduction A — Wire surface shrink

**Wire commands: 14 → 6.** Keep `execute`, `resume`, `stream-input`,
`interrupt`, `stop`, `ping`. Cut `abort` (collapse into `interrupt` +
`stop`), `set-model`/`set-permission-mode` (set at execute time only;
mid-flight is rare UX, deliberate add-back later if needed),
`get-context-usage` (becomes attachment on `result` event),
`rewind` (delete; if rewind UX needed, use SDK-native `rewindFiles`
behind a different verb), `stop-task` (defer), `permission-response`/
`answer` (#100's domain).

**Wire events: 26 → ~12.** Keep `session.init`, `partial_assistant`,
`assistant`, `tool_result`, `ask_user`, `permission_request`,
`file_changed`, `result`, `error`, `stopped`, `gap`, `title_update`.
Add three SDK adoptions (Reduction D). Cut `heartbeat` (Reduction C),
`context_usage`/`rewind_result` (fold into `result`),
`mode_transition*` (4 types — DO-internal anyway), `chain_advance`/
`chain_stalled` (defer until kata chains are fully wired), `kata_state`
(stays for now — kata-specific, low cost), `rate_limit`
(consider folding into `api_retry` adoption).

The `commands.ts` `QueueableCommand` queue (~50 LOC) disappears —
once Reduction B holds, Query is always available after `system.init`.

### Reduction B — One `Query` per session (`streamInput()`)

Pass a single lifetime `AsyncIterable<SDKUserMessage>` to `query()`
at construction. Subsequent `stream-input` wire commands push onto
that iterable. `interrupt()` stops the current turn but leaves the
Query alive. Only `stop` (or fatal error) terminates the Query.

Implementation pattern (per `2026-04-23-sdk-mid-stream-input-api.md`):

```typescript
// Pseudocode
const queue = new PushPullQueue<SDKUserMessage>()
queue.push(initialMessage)  // first turn

const q = query({ prompt: queue, options: { ... } })
ctx.query = q
ctx.onStreamInput = (msg) => queue.push(msg)
ctx.onInterrupt = () => q.interrupt()
ctx.onStop = () => { queue.close(); /* SIGTERM watchdog */ }

for await (const message of q) {
  // existing processQueryMessages body — unchanged
}
```

Bug fix included: stop calling `q.streamInput()` mid-flight at
`main.ts:178`. That call is the source of the closed-stdin issue.

**Estimated LoC delta:** −220 in `claude-runner.ts`, −50 in
`commands.ts` (queue gone), modest additions for `PushPullQueue`.
Net ~−250.

**Out of scope but worth noting:** the runner's `isIdleStop()` auto-
nudge stays runner-internal under this pattern — when the model emits
"No response requested.", the runner pushes `"continue"` onto the
queue silently. No DO involvement, no wire event.

### Reduction C — `session_state_changed` liveness

Wire-side: drop `HeartbeatEvent` and the 15s emit loop.

Runner-side: forward `session_state_changed` as a new `GatewayEvent`
variant (or fold into existing `session.init`-derived state — small
design call, both work).

DO-side: `lastGatewayActivity` becomes `lastAnyEvent`; alarm cycle
reframed as "no event in 90s + no live WS → recover". Status
derivation in `useSessionStatus` ingests the new signal as a primary
input; output contract unchanged.

**Estimated LoC delta:** ~−40 net (−20 delete, +10 reframe, +10
ingest plumbing). Zero UI changes.

### Reduction D — Three high-value SDK signal adoptions

| SDK message | New `GatewayEvent` | UX surface |
|---|---|---|
| `SDKSessionStateChangedMessage` | (used internally, see C) | Liveness signal |
| `SDKCompactBoundaryMessage` | new `compact_boundary` event | Transcript divider: "Context compacted: pre→post tokens", history above the seam dimmed/collapsed |
| `SDKAPIRetryMessage` | new `api_retry` event | Transient banner: "Retrying (attempt 2/10, 5s)…" with error-class chip (rate_limit / server_error / billing_error) |

**Per user direction:** all three in scope (full SDK signal
adoption). UI work for `compact_boundary` (transcript seam) is
significant — separate UX design pass — but the wire/DO plumbing
lands here.

**Estimated LoC delta:** modest add (~50 LOC across runner + DO +
shared-types) for the new events; UI cost is design-driven.

### Reduction E — Move `gateway-event-mapper` to runner

Per #98 P3 / #101 P3 (already on the roadmap; this research validates
it). The 292-LOC `gateway-event-mapper.ts` moves from
`apps/orchestrator/src/agents/` to a runner-side module. The Claude
runner translates SDK content blocks to `SessionMessagePart` shapes
*before* they hit the wire. Future ACP/Codex runners do the same
translation from their native protocol.

The DO becomes shape-agnostic: it persists, broadcasts, runs gates,
applies merge logic on `SessionMessagePart` — without ever knowing
which agent produced them.

**Estimated LoC delta:** DO −292, runner +~250 (some inlining
savings). Net DO simplification of ~292 LOC.

## Sequencing

These four reductions interlock with each other and with three
in-flight efforts. Suggested order:

1. **Reduction C** (liveness) — independent, smallest, lowest risk.
   Land first as a forcing function: it proves the
   "ingest SDK native signal, keep UI contract stable" pattern with
   minimum code surface.
2. **Reduction B** (one-Query) — high LoC delete, fixes the latent
   `streamInput()` bug, simplifies the runner enough that subsequent
   work has cleaner ground. Should land *before* #98 ACP wedge so
   the runner-adapter contract is the cleaner pattern.
3. **Reduction A** (wire shrink) — depends on B (collapses
   `QueueableCommand` queue) and on #100 landing or running parallel
   (gates verbs). Can be partially staged.
4. **Reduction D** (SDK signal adoption) — partially in C (state),
   plus the two UI-driven signals (`compact_boundary`, `api_retry`)
   which can land independently as small specs. UI design for the
   transcript seam is the long pole.
5. **Reduction E** (mapper move) — coordinates with #98 / #101 P3.
   Lands last in this group; it's the natural completion of the
   multi-SDK direction.

## Cuts list

What this research proposes deleting, with file/line references:

**Wire types** (`packages/shared-types/src/index.ts`):
- `HeartbeatEvent` interface (lines 179-183) — Reduction C
- `RewindCommand` (cut entirely) — Reduction A
- `AbortCommand` (collapse into `interrupt`/`stop`) — Reduction A
- `SetModelCommand`, `SetPermissionModeCommand`,
  `GetContextUsageCommand`, `StopTaskCommand`, `AnswerCommand` —
  Reductions A + #100
- `ContextUsageEvent`, `RewindResultEvent` (fold into `ResultEvent`) —
  Reduction A
- `ModeTransitionEvent`, `ModeTransitionTimeoutEvent`,
  `ModeTransitionPreambleDegradedEvent`,
  `ModeTransitionFlushTimeoutEvent` (4 types — DO-internal use only;
  no wire crossing today) — Reduction A
- Optional: `ChainAdvanceEvent`, `ChainStalledEvent` (defer until kata
  chains land) — Reduction A

**Session-runner**:
- `claude-runner.ts:796-846` — multi-turn loop (Reduction B)
- `claude-runner.ts:780-786` — `initialPrompt` generator
  (Reduction B; merged into lifetime queue)
- `claude-runner.ts:830-836` — `followUpPrompt` generator (Reduction B)
- `claude-runner.ts:183-247` — `createMessageQueue`
  (Reduction B; replaced by `PushPullQueue`)
- `commands.ts:11-87` — `QueueableCommand`/`handleQueryCommand` queue
  (Reduction B; Query always live after init)
- `main.ts:36,479` + heartbeat emit loop (Reduction C)
- `main.ts:178` `streamInput()` mis-call (Reduction B fix)

**Session-do** (`apps/orchestrator/src/agents/session-do.ts`):
- `lastGatewayActivity` field (line 270) reframed (Reduction C)
- `case 'heartbeat':` no-op handler (Reduction C)
- `gateway-event-mapper.ts` (entire file, 292 LOC) — Reduction E /
  #98 P3 / #101 P3
- `forkWithHistory` — out of scope for this research, but candidate
  for `SDK.forkSession()` replacement in a follow-up

**UI**:
- No changes (status contract stable; `useSessionStatus` ingests new
  signal silently)

## Open questions

1. **`session_state_changed` trigger conditions in detail** — SDK
   docstring is sparse. `requires_action` definitely fires for tool-
   result waits and gates; [uncertain] whether it fires during
   compaction, API retry, or plugin reload. Worth a quick test-matrix
   spike before deleting heartbeat fully (Reduction C). Low-risk,
   one-evening verify.
2. **`streamInput()` mid-flight bug fix posture** — fix in place
   (one-line patch to call once) vs delete as part of Reduction B?
   Recommend delete-as-part-of-B; the patch is a band-aid on a
   pattern that's about to be replaced.
3. **`compact_boundary` UI surface design** — needs a design pass
   (transcript seam, history dimming, token-savings chip). Should the
   compact-boundary research/spec be carved out separately, or in-
   scope here? Recommend: wire/DO plumbing in this peel-back; UX
   design as a sibling spec.
4. **`forkSession()` adoption** — out of scope here, but flagged for a
   follow-up. The current `forkWithHistory` is a hand-rolled fork via
   transcript prefixing; the SDK has a native fork that respects the
   session JSONL. Would clean up the orphan-recovery path.
5. **Does Reduction A's "fold `context_usage` into `result`" lose any
   live-during-turn UX value?** Today `get-context-usage` is an RPC
   that the UI can poll. If no UI today polls it (likely), the
   collapse is free. Verify before cutting.

## Next steps

1. **Spec-writing pass** for the umbrella effort, linked to **#101**
   as the natural home (this is the "simplify the runner↔DO
   boundary" sibling of #101's "split SessionDO into modules"). Spec
   should propose the four reductions as four phases under one issue,
   with verification plan per phase. Sequencing per the section above.
2. **Coordinate with #100** on the gates verbs (`permission-response`,
   `answer`, `ask_user`, `permission_request`). Reduction A depends on
   #100's final wire shape; either #100 lands first, or the two specs
   share verbs.
3. **Coordinate with #98** on the mapper-move (Reduction E). Either
   #98 P3 absorbs Reduction E, or this peel-back's spec carves it out
   and #98 references it.
4. **Spike on open question 1** (`session_state_changed` trigger
   matrix) — half-day at most; needed before Reduction C lands fully.
5. **Sibling spec for `compact_boundary` UX design** if the call is to
   keep that out of this peel-back's scope.

## Appendix — Inventory snapshots

### Wire commands (today: 14)

| Command | SDK call | Status under proposal |
|---|---|---|
| `execute` | `query({prompt, options})` | KEEP |
| `resume` | `query({prompt, options:{resume}})` | KEEP |
| `stream-input` | `q.streamInput()` (via lifetime queue) | KEEP |
| `interrupt` | `q.interrupt()` | KEEP |
| `stop` | `q.close()` + SIGTERM + exit | KEEP |
| `ping` | (transport keepalive) | KEEP |
| `abort` | local AbortController | DROP (collapse into interrupt/stop) |
| `set-model` | `q.setModel()` | DROP (set at execute) |
| `set-permission-mode` | `q.setPermissionMode()` | DROP (set at execute) |
| `get-context-usage` | `q.getContextUsage()` | DROP (attachment on result) |
| `rewind` | `q.rewindFiles()` | DROP (delete or replace with native) |
| `stop-task` | `q.stopTask()` | DROP (defer) |
| `permission-response` | gate callback | DEFER to #100 |
| `answer` | gate callback | DEFER to #100 |

### Wire events (today: 26)

Keep: `session.init`, `partial_assistant`, `assistant`, `tool_result`,
`ask_user`, `permission_request`, `file_changed`, `result`, `error`,
`stopped`, `gap`, `title_update`, `kata_state`.

Add (Reduction D): `compact_boundary`, `api_retry`,
`session_state_changed`(or absorb into `session.init`-style event).

Drop: `heartbeat`, `context_usage`, `rewind_result`,
`mode_transition*` (×4), `chain_advance`, `chain_stalled`,
optional `rate_limit` (fold into `api_retry`).

### SDK `Query` methods (27) usage

Used (4 + streamInput): `interrupt`, `setModel`, `setPermissionMode`,
`getContextUsage`, `streamInput`.

Unused (22): introspection ×6, session/config ×7, MCP ×3, task ×1,
lifecycle ×1 (`close` — keep unused, prefer SIGTERM), deprecated ×1
(`setMaxThinkingTokens`), file utils ×2, plus `applyFlagSettings` (low
priority).

### SDK message variants (25)

Translated today (14): `assistant`, `stream_event`, `tool_use_summary`,
`rate_limit_event`, `system/init`, `system/task_started/progress/
notification`, `result`, `user`, plus a few minor.

Dropped today (11): see Item 2 table. Three high-value adoptions; the
other 8 stay deferred.
