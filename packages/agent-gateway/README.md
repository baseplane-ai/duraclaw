# @duraclaw/agent-gateway

Thin control plane for spawning `session-runner` processes on a Duraclaw VPS. Does
NOT run the Claude Agent SDK — that lives in [`@duraclaw/session-runner`](../session-runner).
Does NOT dial the Durable Object — the runner dials the DO directly over WebSocket.
The gateway only accepts spawn requests, enumerates on-disk session state, and
reaps stale processes.

## Endpoints

| Method | Path                        | Description                                       |
|--------|-----------------------------|---------------------------------------------------|
| POST   | `/sessions/start`           | Spawn detached `session-runner`; returns in <100ms |
| GET    | `/sessions`                 | List all known sessions (scans pid files)         |
| GET    | `/sessions/:id/status`      | Resolve one session's state (exit > pid+live > pid+dead > 404) |
| GET    | `/health`                   | Liveness (no auth)                                |
| GET    | `/openapi.json`             | OpenAPI spec (no auth)                            |
| POST   | `/debug/reap`               | On-demand reaper pass (dev-only, gated by `DURACLAW_DEBUG_ENDPOINTS=1`) |

Project-browsing endpoints (`GET /projects`, `GET /projects/:name/files/...`,
`git-status`, `kata-status`, `sessions/:id/messages`, `sessions/:id/fork`, …)
remain for UI/debug use. Full schemas live in `src/openapi.ts` — that file is
authoritative; this README is a pointer.

All endpoints except `/health` and `/openapi.json` require
`Authorization: Bearer $CC_GATEWAY_API_TOKEN`.

## Directory contract

Per-session control files live under `$SESSIONS_DIR` (default
`/run/duraclaw/sessions`, a tmpfs mode-0700 dir created by the systemd
`RuntimeDirectory=` directive):

| File                 | Writer         | Lifecycle                                                        |
|----------------------|----------------|------------------------------------------------------------------|
| `{id}.cmd`           | gateway        | Written on `/sessions/start`; unlinked by runner after read      |
| `{id}.pid`           | session-runner | Written at startup; unlinked on clean exit; reaper GCs orphans   |
| `{id}.meta.json`     | session-runner | Rewritten every 10s (atomic write-then-rename)                   |
| `{id}.exit`          | runner OR reaper | Single-writer (`link`+EEXIST); terminal state                  |
| `{id}.log`           | gateway        | stdout/stderr append-only log                                    |

Reaper cadence: 5-minute interval + startup pass. Stale runners (>30min since
`last_activity_ts`) get SIGTERM then SIGKILL after a 10s grace. `.cmd` orphans
>5min with no live pid are unlinked. Terminal files >1h past `.exit` mtime are
unlinked together with their `.log`.

## Environment variables

| Variable                     | Default                        | Notes                                                     |
|------------------------------|--------------------------------|-----------------------------------------------------------|
| `CC_GATEWAY_PORT`            | `9877`                         | Bind port; gateway always binds `127.0.0.1`               |
| `CC_GATEWAY_API_TOKEN`       | *(unset = no auth)*            | Bearer secret; timing-safe compare                        |
| `SESSIONS_DIR`               | `/run/duraclaw/sessions`       | Control-file directory; passed to spawned runner as env   |
| `SESSION_RUNNER_BIN`         | auto-resolved                  | Absolute path override for the runner entry point         |
| `DURACLAW_DEBUG_ENDPOINTS`   | *(unset)*                      | `1` enables `POST /debug/reap` for integration tests       |

## Running

```bash
# Dev
bun run packages/agent-gateway/src/server.ts

# Systemd (prod)
./packages/agent-gateway/systemd/install.sh
sudo systemctl status duraclaw-agent-gateway
sudo journalctl -u duraclaw-agent-gateway -f
```
