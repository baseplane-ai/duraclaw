---
paths:
  - "packages/session-runner/**"
---

# Session Runner (per-session SDK owner)

- One process per session. Spawned detached by gateway with 7 positional argv: `sessionId cmdFile callback_url bearer pidFile exitFile metaFile`.
- Writes `.pid` at startup, reads `.cmd`, dials the DO via `DialBackClient` (from `shared-transport`), then runs `query()` / `query({resume:sdk_session_id})` from `@anthropic-ai/claude-agent-sdk`.
- Emits `session.init` / `partial_assistant` (from `stream_event.content_block_delta.text_delta` and `thinking_delta`) / `assistant` / `tool_result` / `result` / etc. via the channel, assigning monotonic `ctx.nextSeq` to every event.
- Stays alive across turns — after `type=result` it blocks on `queue.waitForNext()` for the next `stream-input` from the DO.
- Exits cleanly on: SDK abort, SIGTERM (2s watchdog), or DialBackClient terminal (`4401 invalid_token`, `4410 token_rotated`, or post-connect reconnect cap exhausted).
