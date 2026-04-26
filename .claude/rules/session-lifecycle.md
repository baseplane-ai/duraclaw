# Session lifecycle & resume

1. **New session** — browser calls DO `spawn()` -> DO `triggerGatewayDial({type:'execute', ...})` -> `POST /sessions/start` -> gateway spawns detached runner -> runner dials DO at `wss://.../agents/session-agent/<do-id>?role=gateway&token=...` -> DO validates token (timing-safe) against `active_callback_token` -> accept -> SDK runs -> events stream.
2. **Follow-up message, runner still connected** (normal path) — `sendMessage` sees `getGatewayConnectionId()` -> sends `stream-input` over existing WS -> runner's command queue wakes the multi-turn loop. No re-spawn.
3. **Follow-up after >30min idle** — reaper has killed the runner; DO state is `idle` with persisted `runner_session_id`. `sendMessage` falls through to `triggerGatewayDial({type:'resume', runner_session_id})` -> new runner, SDK `resume` reads the on-disk transcript (`@anthropic-ai/claude-agent-sdk` session file in the project dir).
4. **Orphan case** — runner alive on VPS but unreachable from DO. `sendMessage` preflights `GET /sessions` on the gateway, finds the orphan by `runner_session_id`, auto-delegates to `forkWithHistory(content)`: the DO serialises local history as `<prior_conversation>...</prior_conversation>`, drops `runner_session_id` (forces a fresh one — no `hasLiveResume` collision), and spawns a new `execute` with the transcript-prefixed prompt. User-visible UX is a normal send.

The orphan case is self-healing from the runner side too: on close code `4401`/`4410` from the DO, the runner aborts and exits rather than squatting on the runner_session_id.

## VPS Communication Protocol

Transport: runner -> DO over wss, and gateway -> DO via HTTP only (spawn/status). Shapes live in `packages/shared-types/src/index.ts`.

**GatewayCommand** (DO -> runner, over dial-back WS):
- `stream-input` — inject a user turn into the live SDK query
- `interrupt`, `rewind`, `get-context-usage` — mid-session controls
- `resolve-gate` — answer to `ask_user` / `permission_request`

**GatewayEvent** (runner -> DO, over dial-back WS):
- `session.init`, `partial_assistant` (streaming text / reasoning deltas), `assistant` (finalised turn), `tool_use_summary`, `tool_result`, `ask_user`, `permission_request`, `task_started`/`progress`/`notification`, `rate_limit`, `result`, `heartbeat`, `error`

Every event is stamped with a monotonic `seq` by the runner's BufferedChannel so the DO can detect and act on gap sentinels.
