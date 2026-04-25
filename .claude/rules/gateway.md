---
paths:
  - "packages/agent-gateway/**"
---

# Agent Gateway (VPS control plane)

- **Not the SDK host** — that moved to `session-runner`. Gateway just spawns detached runners and exposes HTTP endpoints for the DO.
- **HTTP endpoints**: `POST /sessions/start` (spawn detached runner), `GET /sessions` (list all known), `GET /sessions/:id/status` (exit > pid+live > pid+dead > 404), `GET /health` (no auth), `POST /debug/reap` (dev-only, behind `DURACLAW_DEBUG_ENDPOINTS=1`), plus project-browsing endpoints for UI/debug.
- **Auth**: Bearer token; timing-safe compare. Open if `CC_GATEWAY_API_TOKEN` not set.
- **Session files** under `$SESSIONS_DIR` (default `/run/duraclaw/sessions`, tmpfs, `0700`): `{id}.cmd` (gateway writes, runner reads), `{id}.pid` (runner writes), `{id}.meta.json` (runner writes every 10s), `{id}.exit` (single-writer via `link`+EEXIST), `{id}.log` (gateway-opened stdout/stderr).
- **Reaper**: 5-minute interval + startup pass. Stale (>30min since `last_activity_ts`) -> SIGTERM -> 10s grace -> SIGKILL -> markedCrashed. `.cmd` orphans >5min unlinked; terminal files >1h past `.exit` mtime GC'd together with `.log`.
- **Observability**: on each reaper pass logs `[gateway] inflight=N <id:pid/seq/age/idle>` and on each spawn logs `[gateway] /sessions/start sessionId=... execute project=... worktree=...`.
- **Systemd**: `duraclaw-agent-gateway.service` requires `KillMode=process` + `SendSIGKILL=no` + `RuntimeDirectoryPreserve=yes` so restarts don't sweep the detached runner cgroup and `/run/duraclaw/sessions` survives. Install via `./packages/agent-gateway/systemd/install.sh`.
