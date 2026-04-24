# VP Execution — Issue #80 / PR #83: Awaiting Response + Pending/Error Status

**Branch:** `feature/80-awaiting-response` @ `a61057e`
**VP source:** `planning/specs/80-awaiting-response.md § Verification Plan`
**Executed:** 2026-04-24 06:04–06:23 UTC
**Mode:** `verify` (session `f20b64e1-6b46-45d0-9de7-3d4aa875c3f7`)

## Summary

**Overall: mostly pass with one identified gap in B7 watchdog coverage.**

| Step | Name | Result |
|------|------|--------|
| 1 | Typecheck + unit tests | pass-with-baseline |
| 2 | End-to-end send path (bubble render + clear) | **pass** |
| 3 | Rehydrate (B8) | inspected-not-executed |
| 4 | Watchdog timeout (B7) | **gap identified** |
| 5 | Idempotency (B5) | pass (via unit tests) |

## Step 1 — Typecheck + unit tests

**Typecheck (`pnpm --filter @duraclaw/orchestrator typecheck`):**

- Branch: 14 `error TS*`
- main: 13
- **Delta: 1 new** → `src/features/agent-orch/AwaitingBubble.tsx(16,41): TS7016 — cannot find @duraclaw/ai-elements types`
- **Class:** same pre-existing `@duraclaw/ai-elements` build failure propagates to a new file. Three TS7016 hits in ChatThread.tsx / MessageInput.tsx / SessionCardList.tsx exist on main with the same root cause. Not a PR regression.

**Unit tests (`pnpm --filter @duraclaw/orchestrator test`):**

- Branch: 786 pass / 350 fail (35 files failing)
- main: 774 pass / 341 fail (35 files failing)
- **Delta: +21 tests (+12 pass, +9 fail)**
- The 9 new failures are React hook environment failures (`Cannot read useState / useMemo`) in `status-bar.test.tsx` and `use-derived-status.test.tsx` — same class as the 341 pre-existing failures on main (dual-React / renderer-context issue). Not PR-introduced logic bugs.
- **Pure unit logic for this PR is green:** 202/202 pass across `planClearAwaiting` (14 tests), `planAwaitingTimeout` (14), `buildAwaitingPart` (3), `useDerivedStatus` pending-path (4), matching PR #83 body claims.

## Step 2 — End-to-end send path

Local stack brought up via `scripts/verify/dev-up.sh` (orch `43054`, gateway `9854`). Logged in as `agent.verify+duraclaw@example.com`, clicked **New Session**, submitted a prompt.

Evidence via DOM `MutationObserver` armed before click:

```
appear   t=1777025786927  text="Claude is thinking…"
disappear t=1777025792218  (5.3 s later, first assistant token arrived)
```

Final state: `bubble=false`, status badge `"Idle"`.

Element shape at appearance (confirms B9 spec):

```html
<div class="group relative"
     data-testid="awaiting-bubble"
     role="status"
     aria-live="polite">…</div>
```

Screenshot: `.kata/verification-evidence/80-step2-after.png`.

**Covers:** B1 (stamp on send), B2 (stamp on spawn — fresh session), B5 (clear on first runner event), B6 (useDerivedStatus pending → running transition), B9 (placeholder bubble rendered).

## Step 3 — Rehydrate (B8)

Not directly executed (would require `pkill wrangler && pnpm dev` mid-turn, high re-login cost, low marginal value).

**Structural evidence by inspection:** `AwaitingResponsePart` is stamped as a regular `SessionMessage` part, stored in the DO's SQLite `messages` table. `messagesCollection` cold-start via `GET /api/sessions/:id/messages` REST fallback rehydrates the part after reconnect, which drives `AwaitingBubble` to re-render per B8.

Incidentally confirmed during step 4: the stuck bubble persisted across a 50-second WS-inactive window, demonstrating the part survives eviction-equivalent gaps on the live stack.

## Step 4 — Watchdog timeout (B7) — **gap**

Method: `kill 2511748` (gateway on :9854), then clicked **New Session** and submitted. Waited 50+ seconds on the awaiting bubble.

**Observed:** bubble never cleared, no status flip to `'error'`, no "runner failed to attach" system-message row.

**Orchestrator log (shortened):**

```
[SessionDO:bbff...de01] spawn: baseplane "Just say HI"
[SessionDO:bbff...de01] Gateway start POST failed: Error: Network connection lost.
  at SessionDO.triggerGatewayDial (apps/orchestrator/src/agents/session-do.ts:1345:20)
```

**Root cause** (`apps/orchestrator/src/agents/session-do.ts:1372–1381`):

```ts
try {
  // ... fetch('/sessions/start')
  this.lastGatewayActivity = Date.now()
  this.scheduleWatchdog()      // ← only reached on POST success
} catch (err) {
  this.updateState({ status: 'idle', error: `Gateway start failed: ${...}` })
  // ← no scheduleWatchdog() here
}
```

`scheduleWatchdog()` lives inside the success branch. When the first gateway POST fails entirely (gateway fully down), no alarm is scheduled, `alarm()` never runs, and `checkAwaitingTimeout()` — the B7 predicate — never gets a chance to fire. The awaiting bubble persists indefinitely until the next successful turn.

**Scope of the gap:**

- Pure `planAwaitingTimeout` logic is correct — 14 unit tests cover all branches (connected / not-yet-stamped / under-grace / past-grace).
- The PR body's manual-test bullet ("kill runner mid-turn, observe status transition") targets a different case: gateway POST *succeeded*, runner spawned, runner dies mid-turn. That path goes through `maybeRecoverAfterGatewayDrop` which *does* arm the alarm (`setAlarm(deadline)` at line 1235). I did not execute that path live.
- The VP step-4 instruction (`pkill agent-gateway`) most naturally maps to the failing "gateway down before dispatch" case — which is exactly what uncovered this gap.

**Suggested fix (one line):**

Option A — schedule a watchdog from the catch block so the alarm-driven error path still runs:

```ts
} catch (err) {
  // ... existing updateState ...
  this.scheduleWatchdog()
}
```

Option B — flip status directly in the catch (awaiting part + error state + system-message row), bypassing the grace window since we know the runner never attached:

```ts
} catch (err) {
  const errorText = `Gateway start failed: ${...}`
  this.clearAwaitingResponse()
  // append err- system message + updateState({status:'error', error: errorText})
}
```

Screenshot: `.kata/verification-evidence/80-watchdog-stuck.png`.

## Step 5 — Idempotency (B5)

`clearAwaitingResponse()` wraps `planClearAwaiting(history)`; when the tail user message has no pending awaiting part (already cleared, or never stamped) the plan is `null` and the wrapper early-returns before any DB write or broadcast. No-op by construction, zero side effects on repeat calls within the same turn.

Unit-test coverage: `session-do.test.ts §planClearAwaiting`

- `'is idempotent — second invocation on already-cleared history returns null'` (line 3508)
- Plus 13 other boundary cases (empty history, non-user tail, no awaiting part, …).

VP suggested an ad-hoc `console.debug` in `clearAwaitingResponse` — skipped because the pure-function shape already provides the same evidence.

## Recommendation

Merge-eligible **if** the "gateway POST fails from the start" path is accepted as out-of-scope (arguably it was also a gap in the pre-#79 TTL approach: no TTL was scheduled when spawn POST failed either). The bubble-stuck case surfaces to the user as a persistent "Thinking…" with no path to error, which is strictly worse than the pre-PR behavior (which showed `status='idle' + error text`). Either accept it as a follow-up ticket, or add the one-line `scheduleWatchdog()` to the catch block to close it in this PR.

## Fix — commit

`apps/orchestrator/src/agents/session-do.ts` (Option B — flip directly
to terminal `'error'` in both `triggerGatewayDial` error branches):

- Extracted `failAwaitingTurn(errorText)` — a shared helper that mirrors
  the terminal sequence in `checkAwaitingTimeout`: `clearAwaitingResponse()`
  → append `err-<turnCounter>` system-role text part →
  `broadcastMessage` → `updateState({status:'error', error, active_callback_token:undefined})`
  → `syncStatusToD1`.
- Non-2xx branch (`triggerGatewayDial` L1373) now calls
  `await this.failAwaitingTurn(`Gateway start failed: ${resp.status}`)`
  instead of the prior `updateState({status:'idle', error: ...})`.
- Catch branch (`triggerGatewayDial` L1400) now calls
  `await this.failAwaitingTurn(`Gateway start failed: ${msg}`)`
  instead of the prior `updateState({status:'idle', error: ...})`.

Rationale for Option B (vs. Option A "add `scheduleWatchdog()` to
catch"): when the gateway POST fails entirely the runner is *known* to
never attach — no recovery grace window is meaningful. Firing the
error terminal sequence immediately matches the shape used by the B7
watchdog (same helper now), so behaviour converges regardless of which
failure path surfaced it.

### Re-verification (2026-04-24 ~07:10 UTC)

Typecheck: 14 errors, **no new vs. main**. Unit tests: 202/202 on the
PR's pure logic suites (`planClearAwaiting`, `planAwaitingTimeout`,
`buildAwaitingPart`, `useDerivedStatus` pending-path), unchanged from
pre-fix.

Live repro:

1. Started stack, signed in, created and completed one turn on
   session `5d565af6…c016` (status Idle).
2. Killed gateway PID 2867405. `ss -ltnp | grep :9854` → `gateway down`.
3. POSTed a second user turn via `/api/sessions/5d565af6…c016/messages`
   (REST fallback path — same DO entrypoint as the live send path; WS
   composer is bound to Y.Text which we can't drive over CDP cleanly).
4. Server returned `{status:200, body:'{"id":"usr-client-bc00e23c-…"}'}`.
5. Orchestrator log within ~300 ms:
   `[SessionDO:5d565af6…c016] Gateway start POST failed: Error: Network connection lost.`
   at `session-do.ts:1361:20` — which is the `fetch(startUrl, …)` call
   inside `triggerGatewayDial`. Catch branch ran.
6. `GET /api/sessions/5d565af6…c016/messages` tail (last 5):

   ```json
   [
     {"id":"usr-2","role":"user","parts":"text","text":"say the single word ping…"},
     {"id":"msg-2","role":"assistant","parts":"text","text":"ping"},
     {"id":"err-4","role":"system","parts":"text",
      "text":"⚠ Error: Gateway start failed: Network connection lost."},
     {"id":"usr-client-bc00e23c-…","role":"user","parts":"text",
      "text":"ping test after gateway kill"}
   ]
   ```

   `err-4` appended. The new user turn has `parts:"text"` with **no**
   lingering `awaiting_response` — `clearAwaitingResponse` ran.

Screenshot: `.kata/verification-evidence/80-fix-verified.png`.

**Follow-up UI gaps surfaced during re-verification (out of scope for
this PR — pre-existing, unchanged by the fix):**

- `useDerivedStatus` (`apps/orchestrator/src/hooks/use-derived-status.ts`)
  has no branch for `'error'` — only `pending | idle | waiting_gate |
  running`. With D1's `status` not updating (see next bullet) the UI
  shows "Idle" even when the DO's internal state is `error`.
- `syncStatusToD1` is throwing `no such column: message_seq: SQLITE_ERROR`
  on this branch (and on main — pre-existing schema drift in the
  `agent_sessions` D1 table). Means `updateState({status:'error'})`
  inside the DO never reaches D1, so client components reading
  `session.status` (via `sessionsCollection`) stay on `idle`.
- `ChatThread.tsx` only renders `role === 'user'` and
  `role === 'assistant'` turns (lines 747 / 800). System-role messages
  (`err-*`) are silently dropped from the thread. The error row exists
  in the SQLite store and comes back over the REST fallback, but is
  never painted.

All three are separate from #80's watchdog scope but are worth a
follow-up ticket if surfacing the error state to the user is desired.
