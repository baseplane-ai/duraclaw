# Verification Gaps — Specs #13, #16, #17

> Research report from VF-c37c-0411 verification session, 2026-04-11.
> Evidence: `.kata/verification-evidence/vp-verify-13-16-17.json`

## Overview

21 VP steps executed across 3 specs. 8 passed, 16 have issues. This report documents root causes and fix paths for each gap, grouped by system layer.

---

## Layer 1: Gateway Session Lifecycle (agent-gateway)

These gaps are in `packages/agent-gateway/src/adapters/claude.ts` and `packages/agent-gateway/src/commands.ts`.

### G1: Interrupt ends session instead of pausing (#13 VP1)

**Symptom:** `query.interrupt()` causes the SDK to emit a `result` with `subtype: "error_during_execution"`. The adapter reports `is_error: true`. VP expects the session to stay alive for follow-up messages.

**Root cause:** The `for await (const message of iter)` loop in `claude.ts:341` exits when the SDK yields the `result` message. The `finally` block (line 484-489) nulls `ctx.query` and closes the message queue. After that, no further commands can reach the session.

**Fix path:**
- The SDK's `interrupt()` stops the current turn but the session can continue if the message generator yields more messages. The issue is that after `result`, the loop exits.
- Option A: Don't treat `result` as loop-terminating. Instead, check if the message queue has pending messages and continue the loop.
- Option B: After `result`, keep the Query alive and wait for `stream-input` commands before yielding the next message. Only exit the loop when the WS closes or `abort` is called.
- Key constraint: The `messageGenerator()` async generator (line 320-328) yields the initial prompt then yields from `queue.iterable`. If the queue isn't done, the SDK will wait for the next message. The `result` event doesn't mean the generator is exhausted — it means the current turn is done.

**Investigation needed:** Check if SDK `query()` continues iterating after emitting `result` when the prompt generator hasn't returned. Test with a simple script that yields two messages and see if the SDK processes both turns.

### G2: Multi-turn rewind not possible (#13 VP4)

**Symptom:** After the first turn completes (result event), `query` is nulled. Rewind command sent after result has no Query to call `rewindFiles()` on.

**Root cause:** Same as G1 — the session lifecycle ends after the first `result`. Rewind requires an active Query object.

**Fix path:** Same as G1. If the session stays alive between turns, rewind can be called between turns before the next `stream-input`.

### G3: No session_state_changed events (#13 VP5)

**Symptom:** The forwarding code exists at `claude.ts:404-411` but no `session_state_changed` events are received during a session.

**Root cause candidates:**
1. The SDK may not emit `session_state_changed` messages in `permissionMode: 'default'` — it might only emit them in `bypassPermissions` mode.
2. The SDK might emit them as a different message type or subtype than what the adapter checks (`message.type === 'system' && (message as any).subtype === 'session_state_changed'`).
3. The events might be emitted but filtered out before reaching the `for await` loop.

**Investigation needed:** Run a session in `bypassPermissions` mode and log ALL messages with their types/subtypes. Compare against the `permissionMode: 'default'` session to identify which events are mode-dependent.

### G4: PostToolUse file_changed not emitting (#13 VP8)

**Symptom:** PreToolUse hook fires correctly (permission_request sent). Permission response sent, tool executes (session completes successfully). But PostToolUse hook doesn't emit `file_changed` event.

**Root cause candidates:**
1. PostToolUse hooks might not fire when using `permissionMode: 'default'` with PreToolUse hooks — possible SDK interaction.
2. The PostToolUse hook might fire but the session completes (result event) before the WS message is sent.
3. The `input.tool_name` in PostToolUse might differ from the PreToolUse tool name (e.g., internal name vs display name).

**Investigation needed:** Add `console.log` inside the PostToolUse hook callback to verify it fires. Check `input.tool_name` value.

---

## Layer 2: Gateway Session Listing (agent-gateway)

These gaps are in `packages/agent-gateway/src/sessions-list.ts`.

### G5: Forked sessions not in listing (#13 VP6)

**Symptom:** `forkSession()` returns a valid session ID, but `GET /projects/:name/sessions` doesn't include it.

**Root cause:** `listSdkSessions` scans for session JSONL files in a specific location (likely `~/.claude/projects/` or a similar path). `forkSession()` creates a new session file but the listing function may scan a different directory, or use a cached file list.

**Investigation needed:** Check where `forkSession()` writes the new session file. Check what directory `listSdkSessions` scans. Compare paths.

### G6: Listing lacks summary/tag fields (#13 VP7)

**Symptom:** `renameSession()` and `tagSession()` succeed (PATCH returns `{ok:true}`), but the listing response doesn't include `summary` or `tag` fields.

**Root cause:** `listSdkSessions` extracts a minimal set of fields from session metadata. It doesn't read the `summary` or `tags` fields from the session info.

**Fix path:** Enrich `listSdkSessions` return type to include `summary` and `tag`. Use `getSessionInfo()` or parse the session JSONL header for these fields.

---

## Layer 3: Orchestrator Client Events (#17)

These gaps are in the orchestrator's client-side code — specifically the SessionDO → browser event relay.

### G7: ChatThread shows "No messages yet" despite session completing (#17 VP2, VP4)

**Symptom:** Sessions spawn and run to completion (sidebar shows `running → completed`, turn count, time). But the chat content area shows "No messages yet — The session will appear here as it runs."

**Root cause candidates:**

1. **Event persistence works** — the SessionDO persists events in DO SQLite (`events` table). The `onConnect` handler replays them (session-do.ts:64-71). So events ARE stored.

2. **Client-side parsing issue** — The `useCodingAgent` hook (or equivalent) receives `gateway_event` messages via the `useAgent` WebSocket connection. It must parse these into renderable chat messages. If the parsing doesn't handle the event types emitted by the new adapter (e.g., `partial_assistant` vs `assistant`), messages won't render.

3. **useAgent connection issue** — The `useAgent` hook from `agents/react` connects to the DO via WebSocket. If the connection isn't established before events are emitted, or if the event format doesn't match what the client expects, messages are lost.

4. **Event replay format** — The DO replays events as `{ type: 'gateway_event', event: <raw_event> }`. The client might expect a different wrapper format, or might not handle replayed events vs live events.

**Investigation path:**
- Open browser DevTools → Network → WS tab while loading a completed session
- Check if `gateway_event` messages are received by the client
- Check the `useCodingAgent` or `useAgentOrchSessions` hook for event parsing logic
- Check if `ChatThread` component receives messages as props

**Key files to examine:**
- `src/hooks/` — look for agent connection hooks
- `src/features/agent-orch/` — the 11 components ported in A.3
- `src/stores/` — any zustand/state stores for messages

### G8: Gate resolution untested (#17 VP3)

**Symptom:** No gate triggered during the test session. The session used a simple math prompt that didn't require tool approval.

**Fix path:** Not a code issue — just needs a test prompt that triggers tool use requiring approval. Use a prompt like "Edit /tmp/test.txt" on a project where the gateway runs in `permissionMode: 'default'`.

### G9: Session persistence and reconnect untested (#17 VP5, VP6)

**Symptom:** Blocked by G7 — can't verify persistence or reconnect if content never renders.

**Fix path:** Fix G7 first.

---

## Layer 4: External Prerequisites (#16)

### G10: Codex/OpenCode not available (#16 VP2, VP3)

**Symptom:** Codex adapter needs `OPENAI_API_KEY`. OpenCode adapter needs `opencode` CLI + running sidecar.

**Fix path:** These are deployment prerequisites, not code bugs. To verify:
- Codex: Set `OPENAI_API_KEY` in gateway environment, ensure `codex` CLI is on PATH
- OpenCode: Install `opencode`, run `opencode serve`, set `OPENCODE_URL`

---

## Priority Order

1. **G1/G2 (Session lifecycle)** — Highest impact. Fixing the session-stays-alive-between-turns pattern unblocks interrupt, rewind, and multi-turn workflows. This is foundational for the CLI parity story.

2. **G7 (ChatThread rendering)** — Highest UI impact. The entire #17 UI verification is blocked until events render. Likely a straightforward parsing/wiring issue.

3. **G5/G6 (Session listing)** — Medium. Fork/rename/tag APIs work; listing just needs enrichment.

4. **G3/G4 (State events, PostToolUse)** — Medium. May resolve automatically once G1 is fixed (longer-lived sessions = more events observable).

5. **G8/G9/G10** — Low priority / not code issues.
