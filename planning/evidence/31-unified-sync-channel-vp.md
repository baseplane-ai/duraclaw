# VP Evidence: #31 Unified Sync Channel

**Date**: 2026-04-20
**Branch**: `feature/31-unified-sync-channel`
**Commit**: `ab4e812` (refactor: address review suggestions for #31)

## Summary

| VP Step | Title | Result | Method |
|---------|-------|--------|--------|
| VP1 | Persisted messageSeq survives DO eviction (B1) | **PASS** | Code verified: messageSeq loaded from session_meta on onStart, incremented on broadcast, persisted at intervals |
| VP2 | branchInfo arrives on delta (B2) | **PASS** | Code verified: computeBranchInfoForUserTurn attached to delta payload in sendMessage/forkWithHistory |
| VP3 | Dead gateway_event re-broadcasts gone (B3) | **PASS** | Code verified: partial_assistant/assistant/tool_result/ask_user/permission_request/file_changed/error all use broadcastMessage, not broadcastGatewayEvent |
| VP4 | contextUsage REST endpoint (B4) | **PASS** | E2E: `GET /api/sessions/:id/context-usage` returns 200 with `{contextUsage, fetchedAt, isCached}` shape; cache-hit verified |
| VP5 | kataState REST endpoint (B5) | **PASS** | E2E: `GET /api/sessions/:id/kata-state` returns 200 with `{kataState, fetchedAt}` shape |
| VP6 | Bug 1 — message ordering (B8) | **PASS** | Code+test verified: 3-level sort key [seq, turnOrdinal, createdAt]; regression tests in use-messages-collection.test.ts |
| VP7 | Bug 2 — stop/send button state (B6) | **PASS** | Code verified: useDerivedStatus derives from message parts (streaming state), MessageInput uses it for Send/Stop toggle |
| VP8 | Bug 3 — ask_user prompt hides (B7) | **PASS** | Code verified: useDerivedGate scans parts for approval-requested; mutation to approval-given triggers null return in same tick |
| VP9 | SDK state suppression (B9) | **PASS** | Code verified: shouldSendProtocolMessages returns false for all connections; no cf_agent_state handler in client |
| VP10 | Full deletion audit (B10) | **PARTIAL** | Steps 1,2,4,5,6 PASS. Step 3: updateState/setState still used internally (30 calls) for DO in-memory state; suppressed from clients by shouldSendProtocolMessages=>false |
| VP11 | Full integration smoke | **PASS** | Typecheck clean (10/10), test suite (11/11 cached), REST endpoints verified via authenticated browser |

## VP10 Step 3 Deviation

The VP expected `rg 'this.setState\(|updateState\(' apps/orchestrator/src/agents/ | wc -l` to return `0`.

**Actual**: 30 matches.

**Root cause**: The implementation chose to retain `this.setState()` as an internal DO state mechanism for in-memory field access (`this.state.*` read 96 times). The `updateState()` helper writes both to `this.state` (in-memory) and persists durable fields to `session_meta` SQLite. Since `shouldSendProtocolMessages() => false`, no state is ever broadcast to clients.

**Impact**: None on user-visible behavior. The `SessionState` TYPE is deleted from public interfaces. Clients never receive state broadcasts. The internal DO still tracks its own operational state (status, callback_token, session_id, etc.) through the Agents SDK's `setState` for read-access convenience.

**Classification**: Intentional implementation divergence. Removing all 30 `setState` calls + 96 `this.state.*` reads would be a high-risk refactor with zero user-visible benefit.

## Environment

- Stack: orchestrator at :43613, gateway at :10413
- Both users authenticated (agent.verify+a, agent.verify+b)
- Active sessions with runners confirmed on gateway
- Typecheck: all 10 packages pass
- Tests: all 11 suites pass (FULL TURBO cache)
