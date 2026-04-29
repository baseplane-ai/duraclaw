# Agent Gateway

Source package: `packages/agent-gateway/`.

A long-running Bun HTTP server on a VPS, supervised by systemd. Pure control plane: it spawns runners on request, lists running runners, reaps idle ones, and that is the entirety of its job.

> **Critical caveat — the gateway never runs the SDK.** That role belongs to `session-runner`. The gateway only spawns detached runner processes, exposes HTTP endpoints to the per-session DO, lists/reaps PIDs, and curates `$SESSIONS_DIR` on tmpfs. It does not embed the Claude SDK, it does not buffer messages, it does not proxy events.

## Module Test

- **Nav entry / surface:** the VPS systemd unit `duraclaw-agent-gateway.service` listening on `127.0.0.1:$CC_GATEWAY_PORT` (default `9877`; per-worktree-derived in dev). Bearer-token-authenticated HTTP endpoints consumed exclusively by the orchestrator's per-session DOs.
- **Owns:** spawn / list / status / reap of `session-runner` and `docs-runner` processes; the `$SESSIONS_DIR` file lifecycle; the idle reaper.
- **Domain question:** How does duraclaw spawn and supervise per-session SDK processes?

## Owns

- The runner process tree (detached children of the gateway), keyed by session id / project id
- The reaper — 5-minute interval + startup pass; stale (>30 min since `last_activity_ts`) runners get SIGTERM, 10s grace, then SIGKILL
- Spawn-side bookkeeping: `{id}.cmd` (gateway writes, runner reads), `{id}.pid`, `{id}.meta.json`, `{id}.exit`, `{id}.log` under `$SESSIONS_DIR` (default `/run/duraclaw/sessions`, tmpfs, mode `0700`)
- Orphan / terminal-file GC — `.cmd` orphans >5 min unlinked; terminal trios >1 h past `.exit` mtime swept

## Consumes

- [`docs/theory/dynamics.md`] — the spawn / reaper / orphan-recovery invariants the gateway implements
- [`docs/theory/trust.md`] — bearer-token boundary against the orchestrator, timing-safe compare, the open-mode escape hatch
- [`docs/modules/session-runner.md`] — primary spawn target; the gateway hands it 7 positional argv and forgets about it
- [`docs/modules/docs-runner.md`] — second spawn target with a 5-argv contract behind `POST /docs-runners/start`

## Theory references

- [`docs/theory/topology.md`] — the gateway is the only VPS-side host the orchestrator can talk to; runners only emit upward to their DO
- [`docs/theory/dynamics.md`] — gateway restart is a non-event for any runner already dialed back

## HTTP endpoints

- `POST /sessions/start` — spawn detached session-runner, write `.cmd`, return 202
- `GET /sessions` / `GET /sessions/:id/status` — status precedence: exit > pid+live > pid+dead > 404
- `POST /docs-runners/start`, `GET /docs-runners`, `GET /docs-runners/:projectId/status`, `GET /docs-runners/:projectId/files` — per-project docs-runner lifecycle + project file walk
- `GET /health` — no auth
- `POST /debug/reap` — dev-only, gated on `DURACLAW_DEBUG_ENDPOINTS=1`
- Project-browsing endpoints used by the orchestrator UI and debug surfaces

## Auth

Bearer token, timing-safe compare against `CC_GATEWAY_API_TOKEN`. If the token is unset the gateway runs **open** — fine for local dev, never appropriate for prod.

## Systemd contract

`duraclaw-agent-gateway.service` runs the bundled artifact `packages/agent-gateway/dist/server.js`, never source. The unit requires `KillMode=process` + `SendSIGKILL=no` + `RuntimeDirectoryPreserve=yes` so a gateway restart does not sweep the detached runner cgroup and `/run/duraclaw/sessions` survives the bounce. Install via `./packages/agent-gateway/systemd/install.sh`.

## VPS bundles

Gateway, session-runner, and docs-runner all ship as self-contained Bun bundles produced by `scripts/bundle-bin.sh` (`bun build --target=bun` + atomic `mv` from a staging dir). Runner bundles inline workspace + npm deps so a `pnpm install` mid-pipeline cannot race a live spawn.

## Observability

Each reaper pass logs `[gateway] inflight=N <id:pid/seq/age/idle>`; each spawn logs `[gateway] /sessions/start sessionId=... execute project=... worktree=...`. Reap decisions are forwarded to the originating DO via `recordReapDecision` RPC and end up in the DO's `event_log` under tag `reap`.
