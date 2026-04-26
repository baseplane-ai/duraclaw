# @duraclaw/session-runner

Per-session Claude Agent SDK owner. One detached process per session, spawned
by [`@duraclaw/agent-gateway`](../agent-gateway). Dials the Durable Object
directly via [`@duraclaw/shared-transport`](../shared-transport).

## Argv

Spawned with exactly 7 positional arguments (the gateway's
`handleStartSession` in `agent-gateway/src/handlers.ts` is the sole caller):

```
session-runner <sessionId> <cmdFile> <callback_url> <bearer> <pidFile> <exitFile> <metaFile>
```

- `cmdFile` — JSON-encoded `GatewayCommand` (`execute` or `resume`) the
  runner reads synchronously on startup.
- `callback_url` / `bearer` — the DO's WS endpoint and the per-dial
  `active_callback_token` minted by `triggerGatewayDial`.
- `pidFile` / `exitFile` / `metaFile` — runner-owned state files under the
  gateway's `SESSIONS_DIR` (typically `/run/duraclaw/sessions`).

Mismatched arity → `exit(2)` with a usage message on stderr. Missing `cmdFile`
→ write `.exit` with `{state:'failed', exit_code:1, error}` and `exit(1)`.

## Lifecycle

1. Parse argv, read `cmdFile`.
2. Concurrent-resume guard: if `cmd.type === 'resume'` scan sibling
   `*.meta.json` for a live `runner_session_id` match; if one is found with a
   live pid, write `{state:'failed', exit_code:2, error:'runner_session_id already active'}`
   and exit.
3. Write `pidFile`.
4. Build `BufferedChannel` (10K events / 50MB ring), start `DialBackClient`
   against `callback_url`.
5. Invoke `ClaudeRunner.execute` / `.resume` which drives
   `@anthropic-ai/claude-agent-sdk`'s `query()`. Messages flow through the
   channel with monotonic `ctx.nextSeq`.
6. Every 10s, atomically overwrite `metaFile` with a snapshot of
   `ctx.meta` (5 consecutive failures → abort).
7. On clean shutdown write `exitFile` once via `link`+EEXIST (single
   writer; the reaper uses the same file for crashed runners).
8. On `SIGTERM`: abort, wait up to 2s for the SDK query to unwind, write
   `{state:'aborted', exit_code:0}` and exit. 2s watchdog → force exit(1)
   with a best-effort exit file.

## Multi-turn behaviour

The SDK iterator is kept open after `type=result` — the runner blocks on a
command queue waiting for the next `stream-input` from the DO, then runs
another `query({resume: runner_session_id})`. Exits only on abort, SIGTERM, or
the DialBackClient firing `onTerminate` (close codes `4401`/`4410` or
reconnect-cap exhaustion).

## Building

```bash
pnpm --filter @duraclaw/session-runner build
# emits dist/main.js with #!/usr/bin/env bun shebang, 0755
```

The gateway's `findSessionRunnerBin` walks up from the gateway entry point
through `node_modules/@duraclaw/session-runner/dist/main.js`, so an
installed symlink from `pnpm install` is enough. If you see
`session-runner bin not found` in the gateway log, the deploy hasn't built
this package yet.
