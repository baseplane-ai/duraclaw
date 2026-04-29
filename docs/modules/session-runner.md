# Session Runner

Source package: `packages/session-runner/`.

The per-session SDK owner. One process per session, spawned detached by `agent-gateway`, dials back directly to its session's Durable Object over a WebSocket, and owns exactly one Claude Agent SDK `query()` for the lifetime of that session.

## Module Test

- **Nav entry / surface:** the per-session bun-bundled binary at `packages/session-runner/dist/main.js` (shebanged, `+x`). On the VPS, every live session is one detached process running this bundle.
- **Owns:** one Claude SDK `query()` lifecycle, the dial-back WebSocket to the per-session DO, the in-process buffered channel that survives transient WS loss, and the runner-side gate ack/resolution loop.
- **Domain question:** What translates between an SDK turn and a duraclaw session?

## Owns

- The SDK query lifetime — `query()` for new sessions, `query({ resume: sdk_session_id })` for resume
- The dial-back transport buffer (a `BufferedChannel` over a `DialBackClient`), stamping every emitted event with a monotonic `seq`
- Gate acknowledgement — parking the SDK on `ask_user` / `permission_request`, unparking on a `resolve-gate` command from the DO
- The `.pid`, `.meta.json` (rewritten every 10 s), and `.exit` (single-writer via `link`+EEXIST) files inside `$SESSIONS_DIR`
- The 2 s SIGTERM watchdog: abort the SDK, flush meta, write the exit file, then exit

## Consumes

- [`docs/integrations/claude-agent-sdk.md`] — `@anthropic-ai/claude-agent-sdk` for `query()`, `resume`, the `SessionStore` API, and SDK message types
- [`docs/modules/shared-transport.md`] — `BufferedChannel` + `DialBackClient` (the only edge from a runner to anywhere)
- [`docs/modules/agent-gateway.md`] — the spawning parent; the runner reads `.cmd`, writes `.pid` / `.meta` / `.exit` against the gateway's `$SESSIONS_DIR` contract

## Theory references

- [`docs/theory/topology.md`] — runner is single-tenant by construction (one process, one HOME, one identity, one session) and only ever talks to its session's DO
- [`docs/theory/dynamics.md`] — spawn → dial-back → multi-turn loop, plus the resume / failover / orphan-recovery transitions
- [`docs/theory/data.md`] — runner-emitted events are append-only with a monotonic `seq` for gap detection at the DO

## Spawn contract

Spawned with 7 positional argv:

```
session-runner <sessionId> <cmd-file> <callback_url> <bearer> <pid-file> <exit-file> <meta-file>
```

- Reads `<cmd-file>` synchronously. On failure: write a `failed` exit-file and exit(1) before any other state.
- Concurrent-resume guard: scans sibling `*.meta.json` for a live `runner_session_id` collision before claiming the session.
- Writes `<pid-file>` (plain `writeFile`, no race here).
- Builds a `RunnerSessionContext`, dials the DO, and runs `runner.execute` / `runner.resume` — note that the runner dials **directly** to the DO, not through the gateway.

## Event stream (runner -> DO)

`session.init`, `partial_assistant` (streaming text + thinking deltas), `assistant`, `tool_use_summary`, `tool_result`, `ask_user`, `permission_request`, `task_started` / `progress` / `notification`, `rate_limit`, `result`, `heartbeat`, `error`. Every event carries `ctx.nextSeq`.

## Multi-turn loop

After `type=result` the runner blocks on `queue.waitForNext()` for the next `stream-input` from the DO — it stays alive across turns and does not exit on turn boundaries. Idle for ~30 min and the gateway reaper kills it; the DO then resumes via a fresh runner that reads the SDK's on-disk transcript.

## Termination

Cleanly exits on: SDK abort, SIGTERM (after the 2 s watchdog), or `DialBackClient` terminal — close codes `4401 invalid_token`, `4410 token_rotated`, or post-connect reconnect cap exhausted. The terminal-close path guarantees an abandoned runner cannot squat on a session id and interfere with future spawns.

## Key files

- `packages/session-runner/src/main.ts` — argv parse, lifecycle, meta-file timer, SIGTERM watchdog
- `packages/session-runner/src/adapters/` — the SDK-facing `RunnerAdapter` (currently `ClaudeAdapter`)
- `packages/session-runner/src/transcript-rpc.ts` — `WsTranscriptRpc` mirror of the SDK `SessionStore` over the dial-back WS
- `packages/session-runner/src/atomic.ts` — `atomicOverwrite` / `atomicWriteOnce` for meta + exit files
