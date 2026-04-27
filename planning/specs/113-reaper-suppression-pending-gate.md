---
initiative: reaper-suppression-pending-gate
type: project
issue_type: bug
status: approved
priority: high
github_issue: 113
created: 2026-04-27
updated: 2026-04-27
phases:
  - id: p1
    name: "Runner stamps pending_gate; reaper suppresses on it"
    tasks:
      - "In `packages/session-runner/src/main.ts`: extend `MetaFile` (the type passed to `atomicOverwrite(argv.metaFile, ...)`) with `pending_gate?: { type: 'ask_user' | 'permission_request', tool_call_id: string, parked_at_ts: number } | null`. Mirror the same shape in `packages/agent-gateway/src/reaper.ts`'s `MetaFile` type so the reaper can read it"
      - "In `packages/session-runner/src/claude-runner.ts` at the AskUserQuestion gate site (lines 280-327): immediately AFTER `sendEvent({ type: 'ask_user', ... })` and BEFORE the `await new Promise(...)` park, set `ctx.meta.pending_gate = { type: 'ask_user', tool_call_id: id, parked_at_ts: Date.now() }` and call the existing meta-flush function synchronously (the function that wraps `atomicOverwrite(argv.metaFile, ctx.meta)` — exposed today via the 10s loop in main.ts at lines 411,428; refactor it into a callable `flushMeta(ctx)` helper if it's currently inline). Wrap the `await new Promise(...)` in `try { ... } finally { ctx.meta.pending_gate = null; await flushMeta(ctx) }` so the field clears on resolve, reject, OR abort"
      - "In `packages/session-runner/src/claude-runner.ts` at the permission_request gate site (lines 331-352): same pattern — stamp `pending_gate = { type: 'permission_request', tool_call_id: id, parked_at_ts: Date.now() }` and `await flushMeta(ctx)` before the park; clear in `finally{}`"
      - "Refactor `packages/session-runner/src/main.ts` to extract the existing inline `atomicOverwrite(argv.metaFile, ctx.meta)` calls (currently at lines 411 and 428) into a named function `export async function flushMeta(ctx: RunnerCtx): Promise<void>` that awaits the atomic overwrite. The 10s loop and both new gate sites in `claude-runner.ts` import and call this single function. Pass `flushMeta` into `runClaudeQuery()` via the existing context object (do NOT add a new top-level argument — extend `RunnerCtx` if needed). Singleton in-memory `ctx.meta` guarantees writes serialize via JS event-loop semantics — no lock needed"
      - "In `packages/agent-gateway/src/reaper.ts` at line 289 (the `if (stale && !awaitingKill.has(sessionId))` block): immediately before the `kill(pid, 'SIGTERM')` call at line 294, re-read the meta file (`const freshMeta = await readJsonIfExists<MetaFile>(metaPath)`) and check: if `freshMeta?.pending_gate?.parked_at_ts` is a number AND `currentNow - freshMeta.pending_gate.parked_at_ts <= 24 * 60 * 60_000`, log `[reaper] skip-pending-gate sessionId=${id} type=${freshMeta.pending_gate.type} tool_call_id=${freshMeta.pending_gate.tool_call_id} parked_age_ms=${currentNow - freshMeta.pending_gate.parked_at_ts}` and `continue` (skip SIGTERM). Otherwise (no `pending_gate`, or `parked_at_ts` older than 24h), fall through to the existing SIGTERM path"
      - "Add `PENDING_GATE_MAX_AGE_MS = 24 * 60 * 60_000` constant to reaper.ts at line 12 (next to existing thresholds)"
      - "Add a regression test to `packages/agent-gateway/src/reaper.test.ts` (the GH#110 P1 failure scenario): pre-stamp `${sessionId}.meta.json` with `{ last_activity_ts: FIXED_NOW - 31 * 60_000, pending_gate: { type: 'ask_user', tool_call_id: 'tu_test', parked_at_ts: FIXED_NOW - 5 * 60_000 } }`, also write a live `.pid`. Run `reapOnce()` with `now: () => FIXED_NOW`. Assert `report.sigtermed` is empty AND a `[reaper] skip-pending-gate` log line was emitted"
      - "Add a sanity-threshold test: same setup but `parked_at_ts: FIXED_NOW - 25 * 60 * 60_000` (over 24h). Assert `report.sigtermed` contains the sessionId (sanity recovery path)"
      - "Add a dead-pid test: `pending_gate` set but pid file points to a non-existent process (livenessCheck returns false). Assert the existing crashed-marker path runs (`pending_gate` does NOT exempt dead pids — alive precondition unchanged)"
      - "Verify: `pnpm typecheck`, `pnpm test --filter @duraclaw/agent-gateway`, `pnpm test --filter @duraclaw/session-runner` all pass"
    test_cases:
      - id: "regression-gh110-p1"
        description: "reaper skips SIGTERM when pending_gate is fresh (parked <24h) and last_activity_ts is stale (>30min)"
        type: "regression"
      - id: "sanity-threshold-24h"
        description: "reaper SIGTERMs anyway when pending_gate.parked_at_ts > 24h old (recovers from runner-bug stuck flags)"
        type: "unit"
      - id: "dead-pid-still-reaped"
        description: "reaper still writes crashed marker for dead pid even when pending_gate is set (alive precondition is the gate)"
        type: "unit"
      - id: "runner-stamp-on-park"
        description: "claude-runner.ts writes pending_gate to meta file via awaited atomicOverwrite BEFORE parking on Promise (both ask_user and permission_request paths)"
        type: "unit"
      - id: "runner-clear-on-settle"
        description: "finally{} clears pending_gate=null and flushes meta on all three settlement paths: (a) Promise resolves with answer, (b) Promise rejects with thrown error, (c) abort signal fires. Last atomicOverwrite call has pending_gate=null in each case"
        type: "unit"
      - id: "typecheck-clean"
        description: "pnpm typecheck succeeds across runner + gateway packages"
        type: "build"
  - id: p2
    name: "Observability — `reap` tag + gateway→DO recordReapDecision RPC"
    tasks:
      - "Add `recordReapDecision` callable to `apps/orchestrator/src/agents/session-do/index.ts` (the SessionDO facade): accepts `{ decision: 'skip-pending-gate' | 'kill-stale' | 'kill-dead-runner', attrs: Record<string, unknown> }` and calls `logEvent(ctx, 'info', 'reap', `decision=${decision}`, attrs)`. Returns `{ ok: true }`. Decorate with `@callable` to match the existing RPC pattern (e.g., `getEventLog` at the same file)"
      - "Add the HTTP endpoint to the existing Hono app in `apps/orchestrator/src/server.ts` (the same app `createApiApp()` builds — see `.claude/rules/orchestrator.md`). Route: `app.post('/api/gateway/sessions/:id/reap-decision', handler)`. Handler: (1) timing-safe-compare `Authorization: Bearer` against `env.CC_GATEWAY_SECRET` (use the same helper `runner-link.ts` uses for its bearer compare — extract or copy as needed); (2) look up the SessionDO stub via `env.SessionDO.idFromName(sessionId)` then `env.SessionDO.get(id)`; (3) call `stub.recordReapDecision({ decision, attrs })`; (4) return `Response.json({ ok: true })`. 401 on bad bearer; 404 if the SessionDO stub returns 404 for the session; 200 on success"
      - "In `packages/agent-gateway/src/reaper.ts`: add a fire-and-forget helper `reportReapDecision(sessionId, decision, attrs)` that POSTs to `${WORKER_PUBLIC_URL}/api/gateway/sessions/${sessionId}/reap-decision` with the gateway bearer token and a 2s `AbortSignal.timeout(2000)`. On error (timeout, non-2xx, network failure), log `[reaper] rpc-failed sessionId=${id} decision=${decision} err=${msg}` to gateway stdout. Reap decision is NOT reverted — the SIGTERM (or skip) already happened locally"
      - "Call `reportReapDecision` from the three reaper decision points: (1) the new skip-pending-gate path (P1), with attrs `{ type, tool_call_id, parked_age_ms, last_activity_age_ms }`; (2) the SIGTERM path at reaper.ts:294, with attrs `{ pid, last_activity_age_ms }` and decision `kill-stale`; (3) the crash-marker path at reaper.ts:329, with attrs `{ pid, duration_ms }` and decision `kill-dead-runner`"
      - "Update the file-header jsdoc in `apps/orchestrator/src/agents/session-do/event-log.ts` (lines 6-10): change the example tag list from `[gate] / [conn] / [rpc]` to `[gate] / [conn] / [rpc] / [reap]`"
      - "Update `CLAUDE.md` (the project-instructions block, the bullet starting with 'DO observability'): change `Use tag prefixes consistently: \\`gate\\` for AskUserQuestion / permission lifecycle, \\`conn\\` for WS connection events, \\`rpc\\` for callable entry/exit.` to add `, \\`reap\\` for reaper kill/skip decisions originating on the gateway and forwarded via recordReapDecision RPC.`"
      - "Add a unit test to `apps/orchestrator/src/agents/session-do.test.ts` (or the appropriate split file post-101): `recordReapDecision({decision: 'skip-pending-gate', attrs: {...}})` → assert one event_log row written with `tag='reap'`, `level='info'`, `message='decision=skip-pending-gate'`, `attrs` JSON contains the passed values"
      - "Add a gateway-side unit test to `packages/agent-gateway/src/reaper.test.ts`: stub a fetch that returns 200; run `reapOnce()` with the regression scenario; assert one `POST` was issued to `/api/gateway/sessions/.../reap-decision` with body containing `decision: 'skip-pending-gate'` and the right attrs. Add a second test where fetch rejects/timeouts; assert reap decision still proceeds locally and `[reaper] rpc-failed` is logged"
      - "Verify: `pnpm typecheck`, `pnpm test`, `getEventLog({tag: 'reap'})` returns the rows after a smoke run"
    test_cases:
      - id: "do-rpc-writes-event-log"
        description: "recordReapDecision RPC writes one event_log row with tag='reap' and the supplied attrs"
        type: "unit"
      - id: "gateway-posts-on-skip"
        description: "Reaper POSTs reap-decision to DO when skipping due to pending_gate; body matches contract"
        type: "unit"
      - id: "gateway-posts-on-kill-stale"
        description: "Reaper POSTs reap-decision with decision=kill-stale on SIGTERM path"
        type: "unit"
      - id: "gateway-posts-on-kill-dead"
        description: "Reaper POSTs reap-decision with decision=kill-dead-runner on crash-marker path"
        type: "unit"
      - id: "rpc-failure-non-fatal"
        description: "When reap-decision POST fails (timeout/network), reaper still completes its local action and logs [reaper] rpc-failed to stdout"
        type: "unit"
      - id: "auth-required"
        description: "POST /api/gateway/sessions/:id/reap-decision returns 401 without bearer; 200 with valid CC_GATEWAY_SECRET"
        type: "integration"
      - id: "docs-updated"
        description: "CLAUDE.md and event-log.ts jsdoc both list `reap` as a canonical tag"
        type: "docs"
---

## Overview

When the runner emits an `ask_user` or `permission_request` GatewayEvent
and parks (correctly, indefinitely) waiting for the user's answer, no
events flow on the dial-back WS, so the meta file's `last_activity_ts`
goes stale. After 30 minutes the gateway's idle reaper SIGTERMs the
runner — even though it is actively waiting on user input, not idle.
This spec adds a `pending_gate` flag the runner stamps onto its
`.meta.json` while parked; the reaper consults it before killing and
skips the kill if the runner is correctly parked. A new `recordReapDecision`
DO RPC plus a `reap` event_log tag give every reap decision a durable,
queryable trail.

The original failure was observed during the GH#110 P1 interview:
`AskUserQuestion` was emitted, the user hadn't answered, the stream
closed, and on resume the agent re-asked independently — losing the
gate's blocking semantics and prior context.

## Feature Behaviors

### B1: Runner stamps `pending_gate` on AskUserQuestion park

**Core:**
- **ID:** runner-stamp-ask-user
- **Trigger:** Runner enters `canUseTool` callback for `AskUserQuestion`; emits `ask_user` event; about to `await` the parked Promise.
- **Expected:** Before `await`, the runner sets `ctx.meta.pending_gate = { type: 'ask_user', tool_call_id, parked_at_ts: Date.now() }` and atomically flushes the meta file (immediate, not riding the 10s loop). The flush is awaited so a subsequent reaper read sees the field.
- **Verify:** Unit test in session-runner: stub `flushMeta` (the new named export from `main.ts`); invoke the gate path; assert `flushMeta` was called with a `ctx` whose `meta.pending_gate.type === 'ask_user'` AND that the call was awaited BEFORE the gate Promise was constructed.
**Source:** `packages/session-runner/src/claude-runner.ts:280-327`

#### Data Layer
- New optional field on `MetaFile` (the type read/written via `atomicOverwrite(argv.metaFile, ...)`): `pending_gate?: { type: 'ask_user' | 'permission_request', tool_call_id: string, parked_at_ts: number } | null`
- The meta file is on tmpfs (`/run/duraclaw/sessions/{id}.meta.json`); not durable across VPS reboot, but neither is the runner process

---

### B2: Runner stamps `pending_gate` on permission_request park

**Core:**
- **ID:** runner-stamp-permission
- **Trigger:** Runner enters `canUseTool` callback for any tool other than `AskUserQuestion`; emits `permission_request` event; about to `await` the parked Promise.
- **Expected:** Same shape as B1 with `type: 'permission_request'`. Same atomic-flush guarantee.
- **Verify:** Unit test: stub `flushMeta`; invoke the permission path; assert the call awaited with `ctx.meta.pending_gate.type === 'permission_request'` BEFORE the gate Promise was constructed.
**Source:** `packages/session-runner/src/claude-runner.ts:331-352`

---

### B3: Runner clears `pending_gate` in `finally{}` on resolve/reject/abort

**Core:**
- **ID:** runner-clear-finally
- **Trigger:** Parked gate Promise settles (user answers, user denies, SDK error, abort signal fires).
- **Expected:** A `try { await pendingPromise } finally { ctx.meta.pending_gate = null; await flushMeta(ctx) }` wrapper around both gate-await sites. Final state of meta file: `pending_gate === null` (or absent — both treated equivalently by the reaper).
- **Verify:** Unit test: simulate three Promise outcomes (resolve, reject from inside, abort signal); after each, assert `atomicOverwrite` was last called with `pending_gate === null`.
**Source:** `packages/session-runner/src/claude-runner.ts:301-313` (ask_user) and `:341-352` (permission)

---

### B4: Reaper skips SIGTERM when `pending_gate` is fresh (≤24h)

**Core:**
- **ID:** reaper-skip-on-pending-gate
- **Trigger:** `reapOnce()` finds a session with `alive AND stale (last_activity_ts > 30min old)`.
- **Expected:** Inside the existing `if (stale && !awaitingKill.has(sessionId))` block at line 289, BEFORE calling `kill(pid, 'SIGTERM')`, the reaper re-reads the meta file. If `freshMeta?.pending_gate?.parked_at_ts` is a number AND `currentNow - parked_at_ts <= 24h`, the reaper logs `[reaper] skip-pending-gate sessionId=X type=Y tool_call_id=Z parked_age_ms=...` to stdout and `continue`s the loop (no SIGTERM, no `awaitingKill` insertion, no escalation timer). Otherwise (no flag, or flag older than 24h), the existing SIGTERM path runs unchanged.
- **Verify:** `reaper.test.ts` regression test (B10): pre-stamp meta with `last_activity_ts: FIXED_NOW - 31min` and `pending_gate: { type: 'ask_user', tool_call_id: 'tu_test', parked_at_ts: FIXED_NOW - 5min }`. Run `reapOnce({ now: () => FIXED_NOW })`. Assert `report.sigtermed === []` and the skip log line was emitted.
**Source:** `packages/agent-gateway/src/reaper.ts:265,289-307`

---

### B5: Reaper still SIGTERMs when `pending_gate.parked_at_ts` is older than 24h

**Core:**
- **ID:** reaper-sanity-recovery
- **Trigger:** Same staleness path as B4, but `pending_gate.parked_at_ts` is more than `PENDING_GATE_MAX_AGE_MS = 24h` old.
- **Expected:** Reaper treats the flag as stale-flag (runner bug) and falls through to the existing SIGTERM path. Log line includes `parked_age_ms` showing the value exceeded the sanity threshold (preserves debug breadcrumb).
- **Verify:** Unit test: same setup as B4 but `parked_at_ts: FIXED_NOW - 25 * 60 * 60_000`. Assert `report.sigtermed` contains the sessionId. Optional: assert log line `[reaper] stale session ... pending_gate_expired=true`.
**Source:** `packages/agent-gateway/src/reaper.ts:289-307` (sanity check on `parked_at_ts`)

---

### B6: Reaper still reaps dead pids regardless of `pending_gate`

**Core:**
- **ID:** reaper-dead-pid-unchanged
- **Trigger:** Pid file points to a process where `process.kill(pid, 0)` returns ESRCH (runner crashed without clearing the flag).
- **Expected:** The existing dead-pid path (reaper.ts:308-341) is unchanged — `pending_gate` is never consulted because the `if (alive && pid !== null)` precondition at line 274 short-circuits first. Dead runner gets the crashed marker; phantom flag in meta is harmless because `.exit` write triggers terminal-file GC at the 1h threshold (line 11).
- **Verify:** Unit test: write meta with `pending_gate` set; spawn a short-lived child process (`Bun.spawn(['sleep', '0'])`), wait for it to exit, then write its now-dead PID into the pid file. Run `reapOnce()`. Assert `.exit` file exists with `state: 'crashed'`. (Do NOT use PID 1 — `process.kill(1, 0)` returns true on Linux/macOS because init is always alive, which would invalidate the test premise.)
**Source:** `packages/agent-gateway/src/reaper.ts:274,308-341` (no change required; behavior preserved by precondition order)

---

### B7: Gateway POSTs reap decision to DO via `recordReapDecision` RPC

**Core:**
- **ID:** gateway-rpc-on-reap
- **Trigger:** Reaper makes a decision: skip (B4), kill-stale (existing SIGTERM at line 294), or kill-dead-runner (existing crash marker at line 329).
- **Expected:** A fire-and-forget `reportReapDecision()` helper POSTs `{ decision, attrs }` to `${WORKER_PUBLIC_URL}/api/gateway/sessions/${sessionId}/reap-decision` with `Authorization: Bearer ${CC_GATEWAY_SECRET}` and a 2s `AbortSignal.timeout(2000)`. On failure (timeout / non-2xx / network), the gateway logs `[reaper] rpc-failed sessionId=X decision=Y err=Z` to stdout. The local reap action (SIGTERM, crash marker, or skip) is NOT reverted.
- **Verify:** Unit test in `reaper.test.ts`: stub `globalThis.fetch`; run reapOnce with each of the three scenarios. Assert exactly one POST per decision with the correct path, headers, and body shape. Assert that when the stub rejects, `[reaper] rpc-failed` appears in captured logs and the local report unchanged.
**Source:** new helper in `packages/agent-gateway/src/reaper.ts`; new endpoint in `apps/orchestrator/src/server.ts`

#### API Layer
- New endpoint: `POST /api/gateway/sessions/:id/reap-decision`. The endpoint is a Hono route in `apps/orchestrator/src/server.ts` that **bridges** HTTP into the DO callable: it validates the bearer, looks up the SessionDO stub, and invokes the `recordReapDecision` callable. The callable is NOT auto-exposed as HTTP — the bridge route is the only public entry.
- Auth: `Authorization: Bearer ${CC_GATEWAY_SECRET}` (timing-safe compare; matches existing gateway-→worker pattern at runner-link.ts:296)
- Request body: `{ decision: 'skip-pending-gate' | 'kill-stale' | 'kill-dead-runner', attrs?: Record<string, unknown> }`
- Response 200: `{ ok: true }`
- Response 400: malformed body — non-JSON, missing `decision`, or `decision` not one of the three allowed values. Body: `{ error: 'invalid request' }`. Validation happens before the SessionDO lookup
- Response 401: missing/wrong bearer
- Response 404: SessionDO not found for that id (gateway logs and continues)

---

### B8: DO `recordReapDecision` writes durable event_log row with tag `reap`

**Core:**
- **ID:** do-event-log-reap-tag
- **Trigger:** Worker fetch handler routes `POST /api/gateway/sessions/:id/reap-decision` to the SessionDO instance; the DO calls its own `recordReapDecision` callable.
- **Expected:** `recordReapDecision({ decision, attrs })` calls `logEvent(ctx, 'info', 'reap', `decision=${decision}`, attrs)`. The event_log row has `tag='reap'`, `level='info'`, `message='decision=<value>'`, and `attrs` JSON-stringified. Queryable via the existing `getEventLog({ tag: 'reap', sinceTs?, limit? })` RPC.
- **Verify:** Unit test in session-do.test.ts: invoke the RPC with each of the three decision values; for each, query the event_log via `getEventLogImpl(ctx, { tag: 'reap', limit: 10 })` and assert the row count and shape.
**Source:** new callable in `apps/orchestrator/src/agents/session-do/index.ts`; uses existing `logEvent` helper in `event-log.ts:11`

---

### B9: Documentation — `reap` tag added to canonical lists

**Core:**
- **ID:** docs-reap-tag
- **Trigger:** N/A (documentation behavior).
- **Expected:** Two canonical locations updated to list `reap` alongside `gate`, `conn`, `rpc`:
  1. `apps/orchestrator/src/agents/session-do/event-log.ts:6-10` jsdoc: `Every \`[gate]\` / \`[conn]\` / \`[rpc]\` / \`[reap]\` log should flow through here ...`
  2. `CLAUDE.md` project-instructions bullet (line ~91-96 in current CLAUDE.md): `Use tag prefixes consistently: \`gate\` for AskUserQuestion / permission lifecycle, \`conn\` for WS connection events, \`rpc\` for callable entry/exit, \`reap\` for reaper kill/skip decisions ...`
- **Verify:** `grep -n reap apps/orchestrator/src/agents/session-do/event-log.ts CLAUDE.md` returns at least one hit per file.
**Source:** docs only

---

## Non-Goals

- **Secondary fix from the GH#113 issue body** (persist `pending_gate_type` / `pending_gate_payload` to `session_meta` for client reconnect) — **dropped**. Per the P0 research, gates are already persisted as tool message parts in `assistant_messages`, and `replayMessagesFromCursor()` re-emits them on reconnect. No correctness gap exists. If a real "DO restart lost my gate" failure surfaces in production, file a follow-up issue with concrete repro.
- **Runner-side heartbeat events** (Option A in the issue) — Not pursued. Adds steady event-stream noise the issue itself flagged as a downside; pending_gate flag achieves the same outcome without periodic emits.
- **Moving reap authority to the DO** (Option B as originally framed) — Not pursued. The reaper stays gateway-local and unilateral; the new RPC is observability-only. Reversing this later (DO-driven reap arbitration) is a significant refactor and isn't motivated by current failures.
- **Adding `transient_state` column to `SessionMeta`** — The issue body assumed this existed. Research showed it does not; the field is comment-level aspiration only. We don't add it; we don't need it.
- **Changing the 30-minute idle threshold** — Threshold stays at `DEFAULT_STALE_THRESHOLD_MS = 30 * 60_000`. The fix is suppression-on-flag, not threshold tuning.
- **Per-tool-type reap policy** — Both `ask_user` and `permission_request` get the same suppression treatment. We don't differentiate based on tool name or anticipated answer time.
- **Push-notification re-trigger on DO restart** — Out of scope. If DO evicts while gated, the existing message-part replay handles UI re-render on reconnect; push was already dispatched on the original gate-arrival broadcast.
- **Migration to add `pending_gate` to `session_meta` SQLite** — Not needed. The flag lives in the runner-managed tmpfs meta file (`{id}.meta.json`), not in DO state. No schema migration for the primary fix.

## Implementation Phases

See frontmatter for full task + test_case breakdowns.

### Phase 1: Runner stamps; reaper suppresses (the actual bug fix)

- Runner: stamp/clear `pending_gate` at both gate-park sites with immediate atomic flush
- Reaper: re-read meta inside SIGTERM block; skip on fresh `pending_gate`; sanity-recover after 24h
- Tests: regression scenario (the GH#110 P1 failure), sanity-threshold, dead-pid unchanged
- **Done when:** `pnpm test` passes; the regression test would have failed before the fix (manual verification on a pre-fix branch optional but recommended)
- **Rollback:** `git revert` the P1 commits. Field is additive on the meta file (existing readers ignore unknown keys); reaper change is localized to one block. No schema change, no wire change. Safe revert at any point.

### Phase 2: Observability — `reap` tag + recordReapDecision RPC

- Add `recordReapDecision` callable + `POST /api/gateway/sessions/:id/reap-decision` endpoint
- Reaper fires fire-and-forget POST on every decision (skip + both kill paths)
- Update `event-log.ts` jsdoc and CLAUDE.md to list `reap` as a canonical tag
- Tests: DO RPC writes correct event_log row; gateway POSTs on each decision; RPC failure non-fatal
- **Done when:** `getEventLog({ tag: 'reap' })` returns rows for a real reap-skip event observed in dev
- **Rollback:** `git revert` the P2 commits. P1 is independent and stays. The new endpoint and helper are additive.

## Verification Plan

### VP1: Regression test for the GH#110 P1 failure

```
1. cd packages/agent-gateway
2. pnpm test -- reaper                              # expect: all reaper.test.ts passes including new regression-gh110-p1 case
3. # Inspect failure mode pre-fix: git stash the runner changes, run again
4. # Confirm without the runner-side stamp the regression test would FAIL (because no pending_gate flag; reaper would SIGTERM)
```

### VP2: Phase 1 — End-to-end on a real session (manual smoke)

```
1. scripts/verify/dev-up.sh                                          # start gateway + orchestrator
2. # In the browser at http://localhost:43613 (worktree-derived port), start a Claude session
3. # Send a prompt that will invoke AskUserQuestion (e.g. "ask me three questions before proceeding")
4. # When the gate appears, do NOT answer. Wait.
5. cat /run/duraclaw/sessions/<session-id>.meta.json | jq .pending_gate
   # expect: { "type": "ask_user", "tool_call_id": "tu_...", "parked_at_ts": <recent timestamp> }
6. # Force a reaper pass with the dev-only debug endpoint
   #   (confirmed available per .claude/rules/gateway.md — gated by DURACLAW_DEBUG_ENDPOINTS=1):
   DURACLAW_DEBUG_ENDPOINTS=1 # ensure gateway was started with this set; restart dev-up.sh if not
   curl -X POST -H "Authorization: Bearer $CC_GATEWAY_API_TOKEN" http://127.0.0.1:$CC_GATEWAY_PORT/debug/reap
   # expect response includes the session in `inflight`, NOT in `sigtermed`
   # If /debug/reap is not enabled, alternative: wait up to 5min for the natural reaper interval and re-check the journal
7. # Inspect the gateway journal:
   journalctl -u duraclaw-agent-gateway -n 50 --no-pager | grep '\[reaper\]'
   # expect: `[reaper] skip-pending-gate sessionId=<id> type=ask_user tool_call_id=tu_... parked_age_ms=...`
8. # Now answer the question. Verify the session resumes normally.
9. cat /run/duraclaw/sessions/<session-id>.meta.json | jq .pending_gate
   # expect: null (cleared in finally{})
```

### VP3: Phase 1 — Sanity threshold (24h synthetic)

```
1. cd packages/agent-gateway
2. pnpm test -- reaper-sanity                       # expect: sanity-threshold-24h test passes
3. # Verify the test asserts:
   #   - parked_at_ts = FIXED_NOW - 25h
   #   - report.sigtermed contains the sessionId
   #   - log shows the SIGTERM path ran
```

### VP4: Phase 2 — `recordReapDecision` RPC and event_log

```
1. # After P2 lands, repeat VP2 steps 1-7 (skip case)
2. # Open a SessionDO RPC client (e.g. via the existing devtool or the orchestrator's debug page)
3. # Or curl-equivalent: query the DO's getEventLog
   curl -H "Authorization: Bearer $SESSION_DO_TOKEN" \
     "http://localhost:43613/api/sessions/<id>/event-log?tag=reap&limit=10"
   # expect: at least one row with tag='reap', message='decision=skip-pending-gate', attrs JSON containing tool_call_id and parked_age_ms
4. # Manually kill a runner to trigger the kill-dead-runner path:
   pgrep -f "session-runner.*<id>" | xargs kill -9
5. # Wait for next reaper scan (≤5 min), or curl the debug endpoint
6. # Re-query event_log; expect a `decision=kill-dead-runner` row
```

### VP5: Phase 2 — RPC failure non-fatal

```
1. # Stop the orchestrator (or block port 43613 with iptables / point WORKER_PUBLIC_URL at an unreachable host in gateway env)
2. # Trigger a reaper scan with the debug endpoint
3. # Confirm the reaper still SIGTERMed stale runners (or skipped pending-gate ones) — local action proceeded
4. journalctl -u duraclaw-agent-gateway -n 50 --no-pager | grep 'rpc-failed'
   # expect: `[reaper] rpc-failed sessionId=... decision=... err=AbortError` (or fetch failure message)
```

### VP6: Phase 2 — Auth required on new endpoint

```
1. curl -X POST -H "Content-Type: application/json" \
     -d '{"decision":"skip-pending-gate"}' \
     http://localhost:43613/api/gateway/sessions/foo/reap-decision
   # expect: 401
2. curl -X POST -H "Authorization: Bearer wrong-secret" -H "Content-Type: application/json" \
     -d '{"decision":"skip-pending-gate"}' \
     http://localhost:43613/api/gateway/sessions/foo/reap-decision
   # expect: 401 (timing-safe compare)
3. curl -X POST -H "Authorization: Bearer $CC_GATEWAY_SECRET" -H "Content-Type: application/json" \
     -d '{"decision":"skip-pending-gate","attrs":{}}' \
     http://localhost:43613/api/gateway/sessions/<real-id>/reap-decision
   # expect: 200 {"ok":true}
```

### VP7: Phase 2 — Docs updated

```
1. grep -n 'reap' apps/orchestrator/src/agents/session-do/event-log.ts
   # expect: jsdoc lists [reap] alongside [gate]/[conn]/[rpc]
2. grep -n 'reap' CLAUDE.md
   # expect: tag list includes `reap` for reaper kill/skip decisions
```

## Implementation Hints

### Key Imports

- `import { atomicOverwrite } from '<runner local utils>'` — already used by `main.ts`'s 10s flush loop. The new gate-stamp/clear sites call the same function via `flushMeta(ctx)`.
- `import { logEvent } from './event-log'` — in `apps/orchestrator/src/agents/session-do/index.ts` (or the post-101 split file). Existing helper, no new imports needed.
- `import type { MetaFile } from '../shared-meta-types'` — both `packages/session-runner/src/main.ts` and `packages/agent-gateway/src/reaper.ts` already define `MetaFile` types locally. They can stay separate or be unified into `packages/shared-types`. Recommendation: unify under `packages/shared-types/src/index.ts` as `RunnerMetaFile` to prevent the two definitions drifting. Optional cleanup; not gating.

### Code Patterns

**Pattern: try/finally around the parked Promise (B1, B2, B3)**
```typescript
// In claude-runner.ts at line ~301 (ask_user) and ~341 (permission)
const id = /* tool_call_id from the SDK callback */
ctx.meta.pending_gate = { type: 'ask_user', tool_call_id: id, parked_at_ts: Date.now() }
await flushMeta(ctx)
try {
  const answers = await new Promise<Record<string, string>>((resolve, reject) => {
    ctx.pendingAnswer = { resolve, reject }
    signal.addEventListener('abort', () => {
      ctx.pendingAnswer = null
      reject(new Error('Session aborted'))
    }, { once: true })
  })
  return { behavior: 'allow', updatedInput: { ...input, answers } }
} finally {
  ctx.meta.pending_gate = null
  await flushMeta(ctx)
}
```

**Pattern: re-read inside the SIGTERM block (B4, B5)**
```typescript
// In reaper.ts at line ~289, before kill(pid, 'SIGTERM')
if (stale && !awaitingKill.has(sessionId)) {
  const freshMeta = await readJsonIfExists<MetaFile>(metaPath)
  const pg = freshMeta?.pending_gate
  if (pg && typeof pg.parked_at_ts === 'number') {
    const parkedAgeMs = currentNow - pg.parked_at_ts
    if (parkedAgeMs <= PENDING_GATE_MAX_AGE_MS) {
      logger.info(
        `[reaper] skip-pending-gate sessionId=${sessionId} type=${pg.type} tool_call_id=${pg.tool_call_id} parked_age_ms=${parkedAgeMs}`,
      )
      reportReapDecision(sessionId, 'skip-pending-gate', {
        type: pg.type,
        tool_call_id: pg.tool_call_id,
        parked_age_ms: parkedAgeMs,
        last_activity_age_ms: currentNow - lastActivityTs,
      })
      continue
    }
    // pending_gate exists but exceeded sanity threshold — fall through to SIGTERM
  }
  // ... existing SIGTERM path (line 290-306) unchanged ...
}
```

**Pattern: fire-and-forget RPC with timeout (B7)**
```typescript
// New helper in reaper.ts
async function reportReapDecision(
  sessionId: string,
  decision: 'skip-pending-gate' | 'kill-stale' | 'kill-dead-runner',
  attrs: Record<string, unknown>,
): Promise<void> {
  const url = `${WORKER_PUBLIC_URL}/api/gateway/sessions/${sessionId}/reap-decision`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${CC_GATEWAY_SECRET}`,
      },
      body: JSON.stringify({ decision, attrs }),
      signal: AbortSignal.timeout(2000),
    })
    if (!res.ok) {
      logger.warn(`[reaper] rpc-failed sessionId=${sessionId} decision=${decision} status=${res.status}`)
    }
  } catch (err) {
    logger.warn(
      `[reaper] rpc-failed sessionId=${sessionId} decision=${decision} err=${(err as Error).message}`,
    )
  }
}
```

**Pattern: DO callable using existing logEvent (B8)**
```typescript
// In apps/orchestrator/src/agents/session-do/index.ts (the facade post-101)
@callable()
async recordReapDecision(args: {
  decision: 'skip-pending-gate' | 'kill-stale' | 'kill-dead-runner'
  attrs?: Record<string, unknown>
}): Promise<{ ok: true }> {
  logEvent(this.ctx, 'info', 'reap', `decision=${args.decision}`, args.attrs ?? {})
  return { ok: true }
}
```

### Gotchas

1. **`MetaFile` type duplication.** The type is defined in both `packages/session-runner/src/main.ts` and `packages/agent-gateway/src/reaper.ts`. Adding `pending_gate` requires updating BOTH. Easy to forget the gateway side; typecheck won't catch it because the gateway reads via `readJsonIfExists<MetaFile>` and the field would silently be `undefined`. Consider unifying under `packages/shared-types` as a P1 cleanup task; not strictly required but reduces drift risk.
2. **Atomic-flush ordering.** `flushMeta(ctx)` must be `await`ed before the `await new Promise(...)` park, or the reaper's read could miss the flag during the small window between assignment and disk write. The 10s flush loop does NOT cover this window. The spec requires immediate atomic flush.
3. **`finally{}` runs on abort signal.** The existing abort handler currently calls `reject(new Error('Session aborted'))` from inside the Promise (claude-runner.ts:309). The Promise rejection propagates into `finally{}` correctly. Verify this in the test for B3.
4. **`AbortSignal.timeout` requires Node 17+ / Bun.** Both runner and gateway run Bun (see CLAUDE.md "Tech Stack"); confirmed available. If targeting older Node, fall back to `AbortController` + `setTimeout`.
5. **Reaper reads meta TWICE per session.** Once at line 263 (existing), once inside the SIGTERM block (new). The second read protects against the resume-race window. Negligible perf cost (kills are rare; ≤5 candidates per scan typical).
6. **`logger` in reaper.ts.** The reaper imports its own logger; don't conflate with the DO's `logEvent`. Stdout `[reaper]` lines stay in the gateway journal; the DO's `[reap]` event_log entries are the durable record. Both coexist intentionally.
7. **`@callable` decorator.** Existing pattern in the SessionDO. New RPC follows the same shape as `getEventLog`. Make sure the callable surface is exposed via the same mechanism the worker fetch handler uses to route DO RPCs — see `apps/orchestrator/src/server.ts` for the routing pattern (or post-101 facade index.ts).
8. **No D1 sync needed.** The event_log row is DO-local SQLite only; not mirrored to D1. This is consistent with existing event_log entries (gate, conn, rpc) which are also DO-local.
9. **Test infra: `now` callback.** The reaper accepts `now: () => number` as a `ReaperOptions` field already (line 142). Tests inject `FIXED_NOW`. New code must call `now()` (not `Date.now()`) inside the reap loop to remain testable. Helper `reportReapDecision` can use `Date.now()` since it's not on the test path's hot loop.
10. **Permission gate `tool_call_id` source.** At `claude-runner.ts:331` the `id` variable is in scope from the `canUseTool` callback signature. Pass it directly into `pending_gate.tool_call_id`. Don't synthesize.

### Reference Docs

- `.claude/rules/gateway.md` — full gateway control-plane contract; confirms session-file paths and reaper semantics
- `.claude/rules/session-runner.md` — confirms `.meta.json` is written every 10s by the runner
- `.claude/rules/session-lifecycle.md` — DO ↔ runner ↔ gateway protocol (CLAUDE.md context block)
- `planning/research/2026-04-27-gh113-reaper-suppression.md` — full P0 research output for this spec
- Cloudflare Workers `fetch` + bearer auth pattern: existing `apps/orchestrator/src/agents/session-do/runner-link.ts:296` (gateway-→worker probe) — same auth shape used by the new endpoint
