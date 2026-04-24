---
initiative: session-state-subtraction
type: project
issue_type: feature
status: approved
priority: medium
github_issue: 80
created: 2026-04-23
updated: 2026-04-23
phases:
  - id: p1
    name: "Types + status plumbing"
    tasks:
      - "Add `AwaitingResponsePart` to `SessionMessagePart` discriminated union at the point of re-export in `apps/orchestrator/src/lib/types.ts` (new file `apps/orchestrator/src/lib/awaiting-response.ts` holding the type + helpers)."
      - "Add `'pending'` to `SessionStatus` union in `packages/shared-types/src/index.ts`."
      - "Extend `deriveDisplayStateFromStatus` in `apps/orchestrator/src/lib/display-state.ts` with a `'pending'` branch — label 'Thinking', icon matches 'running', badge color: open `display-state.ts` and read the existing status→color mapping, then pick the first unused Tailwind color token from this preference order: `bg-amber-500`, `bg-violet-500`, `bg-sky-400`. The rule is strictly 'not any color already returned by another case'; pick the first one that clears that rule."
      - "Update every status switch site to handle `'pending'`: `components/status-bar.tsx`, `features/agent-orch/AgentDetailView.tsx`, `features/agent-orch/tab-bar.tsx`, `features/agent-orch/session-list-item.tsx`, `components/disconnected-banner.tsx`."
    test_cases:
      - "`pnpm typecheck` clean across all packages."
      - "Storybook / manual render: force a session row with `status: 'pending'` and confirm the badge renders with the new color + 'Thinking' label in every UI surface above."
  - id: p2
    name: "DO stamp + clear"
    tasks:
      - "Introduce private `buildAwaitingPart(reason: AwaitingReason): AwaitingResponsePart` helper in `session-do.ts`."
      - "In `sendMessage` at ~line 3500, build the user message with the awaiting part pre-populated BEFORE `safeAppendMessage(userMsg)` (not as a follow-up update)."
      - "In `spawn` at ~line 2980, do the same — build initial user message with awaiting part before append."
      - "In `forkWithHistory` at ~line 3548, same pattern on the synthesised user message."
      - "In `resubmitMessage` at ~line 3931, same pattern at the user-message-append equivalent."
      - "Introduce private `clearAwaitingResponse()` helper that locates the most-recent user message with `awaiting_response@pending` part and removes it via `safeUpdateMessage` (idempotent no-op if already cleared)."
      - "In `handleGatewayEvent`, invoke `clearAwaitingResponse()` at the top of each case for: `partial_assistant`, `assistant`, `tool_result`, `ask_user`, `permission_request`, `result`, `error`, `stopped`."
      - "After stamp, call `syncStatusToD1('pending')` and broadcast the status-row delta (piggybacks existing fire-and-forget sync path — no `await`)."
    test_cases:
      - "Unit test: `sendMessage` appends a user message whose last part is `{type: 'awaiting_response', state: 'pending', reason: 'first_token', startedTs}`."
      - "Unit test: first `partial_assistant` event removes the awaiting part from the user message."
      - "Unit test: if no `partial_assistant` arrives but `result` arrives (turn-end-with-no-output), awaiting is still cleared."
      - "Unit test: second `partial_assistant` on the same turn is a no-op (clear is idempotent)."
  - id: p3
    name: "Hook + wire"
    tasks:
      - "Extend `useDerivedStatus` in `apps/orchestrator/src/hooks/use-derived-status.ts` — add `awaiting_response` case to the tail scan BEFORE the existing `result`/`tool-permission`/`text@streaming` cases. Return `'pending'`."
      - "Confirm no new wire frame types needed — `awaiting_response` rides the existing `messages` delta as a part on the user message."
      - "Confirm `messageSeq` is bumped by the user-message append (it already is — `safeAppendMessage` increments)."
    test_cases:
      - "Unit test: `useDerivedStatus` returns `'pending'` when tail user message has awaiting_response part."
      - "Unit test: `useDerivedStatus` returns `'running'` (via streaming branch) after awaiting part is cleared and `text@streaming` arrives."
      - "Integration test: client receives two sequential deltas (user+awaiting, then clear) and hook transitions `undefined → 'pending' → 'running'`."
      - "B8 coverage: integration test — stamp awaiting via `sendMessage`, force DO eviction (drain + discard instance), re-instantiate DO, read history; assert user row still has `awaiting_response@pending` as tail part and a fresh `useDerivedStatus` call returns `'pending'`."
  - id: p4
    name: "Watchdog timeout"
    tasks:
      - "Extend `alarm()` at `session-do.ts:1335`. After the existing stale-session logic, add a branch: if any message has a tail part `{type:'awaiting_response', state:'pending'}`, AND `getGatewayConnectionId() === null`, AND `Date.now() - startedTs > RECOVERY_GRACE_MS` (15s), then clear the awaiting part, call `syncStatusToD1('error')`, broadcast error status row, and persist a diagnostic error message."
      - "Expose a private `checkAwaitingTimeout()` predicate that callers (alarm + tests) can invoke directly — avoids depending on alarm scheduler in unit tests."
    test_cases:
      - "Unit test with fake clock: stamp awaiting, leave `getGatewayConnectionId()` null, advance clock >15s past startedTs, invoke `checkAwaitingTimeout()`, assert awaiting cleared, status = 'error', D1 sync fired."
      - "Unit test: if `getGatewayConnectionId()` is non-null, `checkAwaitingTimeout()` is a no-op even past grace — runner is attached, we don't time out."
  - id: p5
    name: "UI placeholder bubble"
    tasks:
      - "Create `features/agent-orch/AwaitingBubble.tsx` — assistant-styled row with placeholder text keyed by `reason`: `first_token` → 'Claude is thinking…', `subagent` → 'Running subagent…', `monitor` → 'Watching monitor…', `async_wake` → 'Waiting for response…'. Include existing typing-dot animation. Add `data-testid='awaiting-bubble'`."
      - "In `ChatThread.tsx`, detect tail user message with `awaiting_response@pending` part. When present, render `<AwaitingBubble reason={...} />` into the slot IMMEDIATELY after the user row — the same slot the next assistant row will occupy."
      - "Verify slot continuity: the placeholder must unmount and the real assistant row must mount in the exact same slot so the DOM node identity change is a content swap, not a layout jump."
    test_cases:
      - "Component test (React Testing Library): render `<AwaitingBubble reason='first_token' />`; assert `getByTestId('awaiting-bubble').textContent` includes 'Claude is thinking…'. Repeat for all four `reason` values — each asserts the exact copy from B9."
      - "Component test: render `<AwaitingBubble />` inside a list with a user row above and an (optional) assistant row below; assert the bubble's parent index in the rendered list is exactly `userRowIndex + 1`."
      - "Visual test: send a message via `scripts/axi`, observe 'Claude is thinking…' bubble via `scripts/axi snapshot | grep awaiting-bubble` within 500ms of send."
      - "Visual test: when first `partial_assistant` arrives, the placeholder unmounts and streaming text appears in the same slot (no vertical jump). Compare `scripts/axi screenshot` at T0+500ms and T0+5s — the streaming row's `boundingClientRect.top` must equal the bubble's prior `top` ± 2px."
      - "Visual test: when runner crashes pre-first-event (force by killing agent-gateway), placeholder remains up for ~15s then the row is replaced by an error row (B7)."
---

## Overview

Add an `awaiting_response` message part that SessionDO stamps on the user
message at every turn-entry point, clears on the first runner event,
surfaces as a distinct `'pending'` session status, and renders as a
placeholder assistant bubble in ChatThread. Closes the first-token
fallback race left by #79 (GH#37) where `useDerivedStatus` returns
`undefined` between `sendMessage` and the first runner event, letting a
stale D1 mirror flicker 'idle' mid-wait. Also reserves shape for future
subagent / Monitor / async-wake waiting states without a migration.

## Types

Canonical declarations — P1 creates `apps/orchestrator/src/lib/awaiting-response.ts`
holding these (plus the `buildAwaitingPart` helper). Code snippets elsewhere in
this spec must conform to these shapes.

```typescript
export type AwaitingReason =
  | 'first_token'   // v1-wired: sendMessage → first runner event
  | 'subagent'      // reserved (SDK subagent_started — not emitted today)
  | 'monitor'       // reserved (Monitor tool — not yet in SDK)
  | 'async_wake'    // reserved (async-wake resume — not yet in SDK)

export interface AwaitingResponsePart {
  type: 'awaiting_response'
  state: 'pending'          // singleton literal; reserves room for future 'cancelled' etc.
  reason: AwaitingReason
  startedTs: number         // ms epoch, set at stamp time, used by the watchdog (B7)
}
```

`AwaitingResponsePart` is added as a new member of the `SessionMessagePart`
discriminated union in `apps/orchestrator/src/lib/types.ts`. All four fields
are required — none optional, none nullable.

## Feature Behaviors

### B1: Stamp awaiting part on `sendMessage`

**Core:**
- **ID:** stamp-sendmessage
- **Trigger:** Client invokes `sendMessage(content)` RPC on SessionDO.
- **Expected:** The appended user message carries a trailing
  `{type:'awaiting_response', state:'pending', reason:'first_token',
  startedTs: Date.now()}` part. Status is set to `'pending'` and mirrored
  to D1 in the same DO tick. The message delta broadcast reflects both.
- **Verify:** Unit test calls `sendMessage('hello')`, then inspects the
  last `safeAppendMessage` arg — final part is `awaiting_response@pending`
  with `reason: 'first_token'`. `syncStatusToD1` called with `'pending'`.
- **Source:** `apps/orchestrator/src/agents/session-do.ts:3500` (after the
  `safeAppendMessage(userMsg)` call; message is built with the part
  pre-included, not added post-append).

#### Data Layer
User message parts array gains one trailing element of type
`AwaitingResponsePart`. No schema change — rides existing
`assistant_messages` SQLite persistence via the SDK's `Session.appendMessage`.

### B2: Stamp on `spawn`

**Core:**
- **ID:** stamp-spawn
- **Trigger:** SessionDO `spawn(prompt, config)` creates a brand-new
  session and persists the initial user turn.
- **Expected:** The initial user message carries the awaiting part at
  creation time. Same reason (`'first_token'`), same `startedTs` stamp
  as B1. `syncStatusToD1('pending')` fires in the same tick (fire-and-
  forget, matches B1). Gateway dial kicks off immediately after.
- **Verify:** Unit test: `spawn('hello', {...})`; inspect persisted
  messages. Initial user message has `awaiting_response@pending` as last
  part.
- **Source:** `apps/orchestrator/src/agents/session-do.ts:2980` (before
  `triggerGatewayDial` at 2997).

### B3: Stamp on `forkWithHistory`

**Core:**
- **ID:** stamp-fork
- **Trigger:** SessionDO `forkWithHistory(content)` — orphan-self-heal
  path that bundles prior transcript as `<prior_conversation>…</prior_conversation>`
  and spawns fresh.
- **Expected:** The synthesised user message (prior_conversation prefix +
  new turn) carries `awaiting_response@pending` as its last part.
  `syncStatusToD1('pending')` fires in the same tick.
- **Verify:** Unit test with mocked orphan path: invoke
  `forkWithHistory('next turn')`; user message last part is awaiting.
- **Source:** `apps/orchestrator/src/agents/session-do.ts:3548`.

### B4: Stamp on `resubmitMessage`

**Core:**
- **ID:** stamp-resubmit
- **Trigger:** SessionDO `resubmitMessage(...)` — rewind-then-resend
  branching action.
- **Expected:** The new user message (at the new branch leaf) carries
  `awaiting_response@pending` as its last part.
  `syncStatusToD1('pending')` fires in the same tick.
- **Verify:** Unit test: invoke `resubmitMessage(parentId, 'new content')`;
  inspect the newly-appended user row.
- **Source:** `apps/orchestrator/src/agents/session-do.ts:3931`.

### B5: Clear awaiting part on first runner event

**Core:**
- **ID:** clear-on-first-event
- **Trigger:** SessionDO `handleGatewayEvent` receives any of:
  `partial_assistant`, `assistant`, `tool_result`, `ask_user`,
  `permission_request`, `result`, `error`, `stopped`.
- **Expected:** Locate the tail user message carrying
  `awaiting_response@pending`; remove that part via `safeUpdateMessage`;
  broadcast the update delta. Idempotent — second event on the same turn
  is a no-op.
- **Verify:** Unit test: stamp awaiting via `sendMessage`; inject a
  `partial_assistant` event; assert awaiting part removed from the user
  message. Inject a second event; assert no additional update fires.
- **Source:** `apps/orchestrator/src/agents/session-do.ts:4095`
  (`handleGatewayEvent` switch; each case calls the `clearAwaitingResponse()`
  helper once at the top).

#### API Layer
No new wire frame types. The clear broadcasts as a normal `messages`
delta with the updated message row.

### B6: `useDerivedStatus` returns `'pending'` for awaiting tail

**Core:**
- **ID:** hook-pending
- **Trigger:** `useDerivedStatus(sessionId)` called with a session whose
  `messagesCollection` tail user message has `awaiting_response@pending`.
- **Expected:** Hook returns `'pending'` (the new literal). Seq-tiebreaker
  still gates on `localMaxSeq > serverSeq` — awaiting part must be on a
  row whose seq is ahead of D1, which it will be because
  `safeAppendMessage` bumps `messageSeq`.
- **Verify:** Unit test: populate `messagesCollection` with a user row
  whose last part is `awaiting_response@pending`, `messageSeq` on
  session below row seq. Call `useDerivedStatus`; expect `'pending'`.
  Remove awaiting part from the row; expect `undefined` (fall through
  to D1) or `'running'` (if streaming tail follows).
- **Source:** `apps/orchestrator/src/hooks/use-derived-status.ts` —
  new case prepended to the tail-scan loop.

#### UI Layer
Every consumer of `useDerivedStatus(id) ?? session?.status` inherits the
new literal for free. `deriveDisplayStateFromStatus` adds a `'pending'`
branch so StatusBar, sidebar cards, tab bar, session-list-item all render
a distinct 'Thinking' label + color without further per-component logic.

### B7: Watchdog clears awaiting on no-runner-attached timeout

**Core:**
- **ID:** watchdog-timeout
- **Trigger:** `alarm()` fires (`ALARM_INTERVAL_MS = 30s` cadence).
- **Expected:** If a message has tail part `awaiting_response@pending`,
  AND `getGatewayConnectionId() === null`, AND `Date.now() - startedTs >
  RECOVERY_GRACE_MS` (15s), then clear the awaiting part, set session
  `status: 'error'` with message "runner failed to attach within recovery
  grace", `syncStatusToD1('error')`, broadcast error row.
- **Verify:** Unit test with fake clock: stamp awaiting with
  `startedTs = now`; leave `getGatewayConnectionId` returning null;
  advance clock 16s; invoke `checkAwaitingTimeout()`; assert awaiting
  removed, status `'error'`, error message persisted.
- **Source:** `apps/orchestrator/src/agents/session-do.ts:1335`
  (`alarm()` method).

### B8: Awaiting part persists across DO hibernation

**Core:**
- **ID:** persist-rehydrate
- **Trigger:** DO evicted (stale) and rehydrated (new RPC arrives).
- **Expected:** The user message carrying the awaiting part is re-read
  from SDK `assistant_messages` table during rehydrate; the part is
  intact. `useDerivedStatus` on the reconnected client still returns
  `'pending'` via message tail.
- **Verify:** Integration test: stamp awaiting; force DO eviction
  (`this.ctx.blockConcurrencyWhile(async () => {...})` drain + manual
  instance discard in test harness); spawn fresh DO instance backing the
  same durable id; request history; assert user row still carries
  `awaiting_response@pending`.
- **Source:** Rides existing `Session.rehydrate()` — no new code needed;
  covered as a verification behavior to prove the bet.

### B9: Placeholder assistant bubble renders during awaiting

**Core:**
- **ID:** ui-awaiting-bubble
- **Trigger:** `ChatThread.tsx` renders a session whose tail user
  message has `awaiting_response@pending`.
- **Expected:** Immediately below the user row, an `AwaitingBubble`
  component renders in the slot where the next assistant row will land.
  Text is keyed by `reason`. Unmounts when the awaiting part is removed;
  the subsequent assistant row renders into the same slot (no layout
  jump).
- **Verify:** Visual test with `scripts/axi`: send a message, take
  snapshot within 500ms; `data-testid='awaiting-bubble'` is present with
  text 'Claude is thinking…'. Wait for streaming; same `snapshot` shows
  the streaming assistant row at the same vertical position (bubble
  unmounted).
- **Source:** New `features/agent-orch/AwaitingBubble.tsx`; edit in
  `features/agent-orch/ChatThread.tsx`.

#### UI Layer
- Placeholder copy per reason (four variants, only `first_token` reachable
  in v1 — others are dead strings reserved for future hookup):
  - `first_token` → "Claude is thinking…"
  - `subagent` → "Running subagent…"
  - `monitor` → "Watching monitor…"
  - `async_wake` → "Waiting for response…"
- Re-uses existing three-dot typing animation component.
- `data-testid='awaiting-bubble'` for automated verification.

### B10: Entry-point parity (coverage summary)

**Core:**
- **ID:** entry-point-parity
- **Trigger:** Meta — verifies all four entry points B1–B4 use the same
  stamp helper and produce identical part shapes.
- **Expected:** `sendMessage`, `spawn`, `forkWithHistory`,
  `resubmitMessage` all call `buildAwaitingPart('first_token')` inline in
  the user-message builder — no branch-specific variant.
- **Verify:** Grep assertion in a test: all four methods reference
  `buildAwaitingPart`. No other call sites exist.
- **Source:** `session-do.ts` — buildAwaitingPart helper and its 4 call
  sites.

## Non-Goals

- **Not** wiring subagent / monitor / async_wake reason values — the
  SDK does not emit events that would let the DO stamp these. Enum is
  reserved shape; only `first_token` is reachable in v1.
- **Not** adding a `waiting_reason` field on `SessionMeta` or a
  `gateway_attached` boolean — those were Option-C follow-ups gated on
  Monitor/Task* adoption.
- **Not** introducing a per-turn TTL on the awaiting state itself. The
  watchdog guards only the "no runner attached" case. Monitor / async
  waits can legitimately last minutes.
- **Not** changing the 4→1 signal architecture from #79. This is purely
  additive — one new message-part type, one new status literal.
- **Not** adding a D1 schema migration. `agent_sessions.status` is
  `text NOT NULL DEFAULT 'running'` with no CHECK constraint; `'pending'`
  writes without DDL work.
- **Not** a new synthetic message row (B1 shape from research) — rejected
  to preserve branch-graph integrity.
- **Not** a new wire frame type. Awaiting rides existing `messages`
  delta.

## Verification Plan

**Prerequisite:** `scripts/axi` is an existing worktree-local wrapper around
`chrome-devtools-axi` (see CLAUDE.md → "UI Testing"). It is pre-installed
and working in every dev worktree; no setup required. `snapshot` returns
the accessibility tree as text (grep-friendly), `screenshot` returns a PNG
path, `eval <js>` executes JS in the page context and returns the result
(use this for `boundingClientRect.top` comparisons).

Run after all 5 phases are merged.

### 1. Typecheck + unit tests
```bash
cd /data/projects/duraclaw-dev1
pnpm typecheck
pnpm --filter @duraclaw/orchestrator test -- awaiting
```
Expected: 0 type errors. All new unit tests (B1–B7 coverage) pass.

### 2. End-to-end send path

Start local stack:
```bash
cd apps/orchestrator
pnpm dev
```

Browser verification (the orchestrator port is per-worktree derived —
either read it from `$VERIFY_ORCH_PORT` after sourcing
`scripts/verify/common.sh`, or look at the dev-up log output):
```bash
source scripts/verify/common.sh
scripts/axi open http://localhost:${VERIFY_ORCH_PORT}/login
scripts/axi fill @<email> agent.verify+duraclaw@example.com
scripts/axi fill @<pw> duraclaw-test-password
scripts/axi click @<submit>
# Navigate to a fresh session, send a message.
scripts/axi snapshot | grep 'awaiting-bubble'
```
Expected: within 500ms of click, `awaiting-bubble` is present with text
"Claude is thinking…". Status bar shows 'Thinking' badge in the new color.

Wait ~5s for first token, re-snapshot:
```bash
scripts/axi snapshot | grep 'awaiting-bubble'
```
Expected: no match (bubble unmounted). Streaming assistant row present.
Status bar shows 'Running'.

### 3. Rehydrate path (B8)

After step 2's first send, force-evict DO:
```bash
# No CLI; use DO 30min idle or restart miniflare with the same durable-id store:
pkill -f "wrangler" && pnpm dev
```
During the reconnect window, re-open the session in browser; confirm if a
turn was mid-awaiting (repeat step 2 and kill miniflare immediately after
clicking send), `awaiting-bubble` is re-rendered after reconnect because
the user message row still carries the part.

### 4. Watchdog timeout (B7)

Stop agent-gateway to simulate dial failure:
```bash
pkill -f "agent-gateway"
```
Send a message from UI. Expected:
- Within ~1 frame: `awaiting-bubble` renders (B9).
- After ~15–45s (alarm cadence + grace): bubble unmounts, status badge
  flips to 'Error', error message row appears: "runner failed to attach
  within recovery grace".

### 5. Idempotency (B5)

With normal stack, send a message and observe server logs in the DO (add
a temporary `console.debug` in `clearAwaitingResponse` for this test):
Expected: exactly one clear invocation results in a state change; every
subsequent event on the same turn logs 'no-op, already cleared'.

## Implementation Hints

### Key imports
- `import type { SessionMessagePart } from 'agents/experimental/memory/session'`
- `import type { SessionStatus } from '@duraclaw/shared-types'`
- `import { safeAppendMessage, safeUpdateMessage } from './session-helpers'` (or wherever they live in session-do.ts)
- `Session.appendMessage` wraps arbitrary part shapes — no SDK change needed.

### Code patterns

**Stamp site (all four entry points identical):**
```typescript
// BEFORE safeAppendMessage — build the user message with the part inline.
const startedTs = Date.now()
const userMsg: SessionMessage = {
  id: userMessageId,
  role: 'user',
  parts: [
    ...userContentParts,
    {
      type: 'awaiting_response',
      state: 'pending',
      reason: 'first_token',
      startedTs,
    },
  ],
  // ...existing fields (parent_id, etc.)
}
await this.safeAppendMessage(userMsg)
// status → 'pending' (fire-and-forget, same as existing 'running' stamp)
this.syncStatusToD1('pending')
```

**Clear helper:**
```typescript
private async clearAwaitingResponse(): Promise<void> {
  const msgs = this.session.getHistory()  // or equivalent
  for (let i = msgs.length - 1; i >= 0; i--) {
    const msg = msgs[i]
    if (msg.role !== 'user') continue
    const lastPart = msg.parts[msg.parts.length - 1]
    if (lastPart?.type === 'awaiting_response' && lastPart.state === 'pending') {
      const nextParts = msg.parts.slice(0, -1)
      await this.safeUpdateMessage({ ...msg, parts: nextParts })
      return
    }
    // First user message without awaiting → nothing to clear, bail.
    return
  }
}
```

**Hook extension:**
```typescript
// In useDerivedStatus's tail scan, before the existing cases:
const lastPart = msg.parts[msg.parts.length - 1]
if (lastPart?.type === 'awaiting_response' && lastPart.state === 'pending') {
  return 'pending'
}
```

**ChatThread placeholder detection:**
```tsx
const tailUser = findTailUserMessage(messages)
const awaitingPart = tailUser?.parts.find(
  (p): p is AwaitingResponsePart => p.type === 'awaiting_response' && p.state === 'pending',
)
// After the user row, before any assistant rows:
{awaitingPart && <AwaitingBubble reason={awaitingPart.reason} />}
```

### Gotchas

- **`safeAppendMessage` must run AFTER the part is added, not before.**
  Adding the part post-append via `safeUpdateMessage` costs an extra
  broadcast and widens the race window. Build the part inline.
- **`syncStatusToD1` fire-and-forget.** Don't `await` it. Matches
  existing pattern at session-do.ts:3518/3528; the RPC return races the
  write, which is acceptable.
- **`messageSeq` tiebreaker in `useDerivedStatus`.** The seq check is
  `serverSeq >= localMaxSeq` → return undefined. The awaiting part
  piggybacks a fresh `safeAppendMessage` which bumps `messageSeq`, so
  `localMaxSeq > serverSeq` is guaranteed at stamp time. On reconnect,
  the REST history fetch carries `seq` per row → stays ahead of D1 until
  D1 catches up via fire-and-forget sync.
- **No CHECK constraint on `agent_sessions.status`.** Confirmed by
  inspecting `schema.ts:135` and all 21 migrations — column is plain
  `text NOT NULL DEFAULT 'running'`. `'pending'` writes succeed without
  DDL. No migration file required.
- **Bubble slot continuity.** The placeholder and the real assistant row
  render in the same `ChatThread` list slot by structural position —
  they are not the same component instance. React will unmount the
  placeholder and mount the assistant row. Confirm no wrapping `<div>`
  around either introduces layout shift; the assistant-row container
  should be the outermost element in both.
- **Re-entrant `sendMessage` is impossible by construction.** Cloudflare
  Durable Objects serialise RPCs per instance — a second `sendMessage`
  cannot begin until the first completes its synchronous work
  (stamping + status set + `triggerGatewayDial`). The awaiting part is
  stamped and the status is set before the first `sendMessage` returns,
  so by the time a client could fire a second send (earliest: next
  round-trip), the first awaiting part is either still pending on that
  user message (fine — second send appends a new user message and the
  first will clear on its runner event) or already cleared. The clear
  helper's backward scan stops at the first user message it examines
  (early return) which is always the tail — so it always finds the
  most-recent awaiting, never an older orphan. If a design change ever
  relaxes DO serialization (it won't), revisit this invariant.
- **Accepted D1 `'pending'` write transient.** `syncStatusToD1('pending')`
  is fire-and-forget. If the write fails silently, D1 remains at the
  prior status (typically 'idle'). The message-delta broadcast carrying
  the awaiting part arrives in the same tick, so `useDerivedStatus`
  returns 'pending' via the tail-scan path — this is *exactly* what the
  feature is designed to do. The D1 miss is an accepted transient
  window; no retry needed. Subsequent status writes (e.g., 'running' on
  first token, 'idle' on result) will catch D1 up on the same
  fire-and-forget path.
- **Watchdog interaction with normal alarm work.** The existing alarm at
  line 1335 handles stale-session reaping. The new predicate must run
  independently (not inside the stale branch) because a session with an
  active awaiting part is not stale — `last_activity` was just bumped by
  the user turn.
- **Idempotency of clear.** A `permission_request` followed by an
  `assistant` both trigger `clearAwaitingResponse()`. First call removes
  the part; second call finds no awaiting part on the tail user message
  and returns early. Both calls `safeUpdateMessage` only when there's
  actually a change — do the check inside the helper.
- **`stopped` event pathway — directive.** The research doc listed
  `partial_assistant / assistant / tool_result / ask_user /
  permission_request / result / error`. P1 interview locked in
  `stopped` too (user aborts before first event). At P2, grep
  `handleGatewayEvent` for `case 'stopped'`:
  - **If the case exists**, add a `clearAwaitingResponse()` call at the
    top and leave the rest of the case body unchanged.
  - **If it does NOT exist**, add a new `case 'stopped':` that calls
    `clearAwaitingResponse()`, then `syncStatusToD1('idle')`, then
    breaks. Do NOT fall through to `error` — a user-initiated abort is
    not a runner error and shouldn't surface an error row in the UI.
  Either outcome satisfies B5; decide by inspection, not guess.
- **Clear-failure error handling.** `safeUpdateMessage` already follows
  the "safe" pattern (swallows + logs — confirm at P2 by reading its
  implementation). The `clearAwaitingResponse` helper MUST NOT re-throw
  on `safeUpdateMessage` failure: log and return. The watchdog (B7) is
  the backstop — if a clear fails and no subsequent event clears it,
  the 30s alarm will still time out the awaiting state and flip status
  to 'error'. Do not add try/catch around the helper itself unless
  `safeUpdateMessage` is confirmed to throw; trust the existing pattern.

### Reference docs

- `planning/research/2026-04-23-awaiting-response-and-async-wait-state.md` —
  original design exploration for awaiting-response; B1 vs B2 trade-off
  analysis.
- `planning/research/2026-04-23-session-state-subtraction-gh76.md` —
  context for the 4→1 signal collapse that produced `useDerivedStatus`.
- `.kata/sessions/e8936de2-34b7-477b-9e6a-b31f8c32774e/workflow/p0-findings.md` —
  post-#79 code validation for this spec.
- `.kata/sessions/e8936de2-34b7-477b-9e6a-b31f8c32774e/workflow/p1-interview-summary.md` —
  all 7 locked decisions, reasoning, open risks.

## Architectural Bets

1. **Part-on-user-message (B2 shape) over synthetic row (B1).** Hard to
   reverse without migrating history. Locks rendering layer into
   "inspect user message for awaiting markers". Bet: branch-graph
   integrity outweighs rendering-layer simplicity.
2. **Reason enum widened day-one, only `first_token` wired.** Avoids a
   wire/DB shape change when Monitor / Task* / async-wake land. Bet:
   those are probable-enough that pre-declaring is cheaper than
   migrating later.
3. **Watchdog-driven timeout clear.** Couples awaiting lifecycle to the
   30s alarm machinery. Bet: 30s cadence is fine-grained enough for
   "runner failed to attach" UX; a dedicated per-turn timer would be
   more plumbing for no UX gain.
4. **New `'pending'` status value.** Distinct UI bucket for "runner is
   alive but quiet". Costs one branch in every display-state switch
   site. Bet: distinct UX signal is worth the call-site churn; folding
   into `'running'` would collapse useful information.

## Open Risks (post-P1, post-spec)

- **Slot stability under odd ChatThread rendering.** If any ancestor
  wraps the assistant row container in a conditional `<div>` that
  doesn't exist for the placeholder, the swap produces a layout jump.
  P5 test-cases include a pixel-compare no-jump check (2px tolerance on
  `boundingClientRect.top`); if it fails, refactor the wrapper to be
  unconditional.
- **`stopped` event switch case** — resolved with a directive in
  Gotchas: check by grep at P2, add a new case if missing (don't fall
  through to `error`).
- **Tests for alarm-driven watchdog.** Direct alarm invocation in
  miniflare tests is flaky. P4 mitigates by exposing a
  `checkAwaitingTimeout()` predicate callable from tests without
  scheduler involvement.
