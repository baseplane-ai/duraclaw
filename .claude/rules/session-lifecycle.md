---
paths:
  - "apps/orchestrator/src/agents/session-do.ts"
  - "apps/orchestrator/src/agents/**"
  - "packages/session-runner/src/**"
  - "packages/agent-gateway/src/reaper.ts"
---
# Session lifecycle (rule stub)
Invariants live in [`docs/theory/dynamics.md`](../../docs/theory/dynamics.md). This file just points at code.

Post-GH#116, the SessionDO exposes three explicit session-progression
primitives (`advanceArc`, `branchArc`, `rebindRunner`) instead of the
overlapping legacy paths (`handleModeTransition`, `tryAutoAdvance`,
`forkWithHistory`). Auto-advance + manual mode change both go through
`advanceArc` (mints a successor session in the same arc); cross-arc
branching from a specific message goes through `branchArc` (mints a
child arc with a parent FK and a wrapped-history prompt); orphan
recovery goes through `rebindRunner` (clears `runner_session_id` and
re-dials `execute` with wrapped local history, same session row).

1. **New session** — browser calls DO `spawn()` -> DO `triggerGatewayDial({type:'execute', ...})` -> `POST /sessions/start` -> gateway spawns detached runner -> runner dials DO at `wss://.../agents/session-agent/<do-id>?role=gateway&token=...` -> DO validates token (timing-safe) against `active_callback_token` -> accept -> SDK runs -> events stream.
2. **Follow-up message, runner still connected** (normal path) — `sendMessage` sees `getGatewayConnectionId()` -> sends `stream-input` over existing WS -> runner's command queue wakes the multi-turn loop. No re-spawn.
3. **Follow-up after >30min idle** — reaper has killed the runner; DO state is `idle` with persisted `runner_session_id`. `sendMessage` falls through to `triggerGatewayDial({type:'resume', runner_session_id})` -> new runner, SDK `resume` reads the on-disk transcript (`@anthropic-ai/claude-agent-sdk` session file in the project dir). For an explicit mode change at this boundary the client calls `POST /api/arcs/:id/sessions` instead, which mints a successor session in the same arc via `advanceArcImpl` rather than mutating the current session in-place.
4. **Orphan case** — runner alive on VPS but unreachable from DO. `sendMessage` preflights `GET /sessions` on the gateway, finds the orphan by `runner_session_id`, auto-delegates to `rebindRunner({nextUserMessage: content})`: the DO clears `runner_session_id` (forces a fresh runner — no `hasLiveResume` collision), serialises local history as `<prior_conversation>...</prior_conversation>`, and triggers a new `execute` dial with the transcript-prefixed prompt. The session row id is preserved. User-visible UX is a normal send.
5. **Auto-advance** — when a session terminates with `terminate_reason === 'stopped'` and the per-arc auto-advance pref is on, the `advanceArcGate` (in `agents/session-do/advance-arc.ts`) closes the current session as `idle`, reuses the same `arcId`, and calls `createSession()` for the next mode in the kata ladder. The partial unique index `idx_agent_sessions_arc_mode_active` enforces idempotency at the DB layer — concurrent advance attempts for the same `(arcId, mode)` collapse to one successor row.
6. **In-arc branch from a message** — `POST /api/arcs/:id/branch` invokes `branchArcImpl`: a child arc is minted with `parentArcId = ctx.session.arcId`, `externalRef` inherited from the parent, and a first session whose prompt is `<prior_conversation>` wrapping history up to the chosen `fromMessageSeq`. The current arc is unmodified.

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
