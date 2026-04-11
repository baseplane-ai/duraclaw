# CC Gateway

HTTP API gateway for controlling Claude Code sessions across baseplane worktrees. Wraps `@anthropic-ai/claude-agent-sdk` to route prompts to the correct worktree directory.

```
Client → HTTP API (port 9877) → claude-agent-sdk query() → claude binary
                                  ├── cwd: /data/projects/baseplane-devN
                                  ├── permissionMode: bypassPermissions
                                  └── settingSources: ['project']
```

## Quick Start

```bash
# Direct
CC_GATEWAY_PORT=9877 node --import=tsx packages/cc-gateway/src/server.ts

# Systemd
./packages/cc-gateway/systemd/install.sh
sudo systemctl status baseplane-cc-gateway
sudo journalctl -u baseplane-cc-gateway -f
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CC_GATEWAY_PORT` | `9877` | HTTP listen port |
| `CC_GATEWAY_API_TOKEN` | *(none)* | Bearer token for auth (if unset, no auth required) |
| `ANTHROPIC_API_KEY` | *(from .env)* | API key for Claude |

## API

All endpoints except `/health` require `Authorization: Bearer <token>` (when `CC_GATEWAY_API_TOKEN` is set).

### Health

```bash
curl http://localhost:9877/health
```

### List Worktrees

```bash
curl -H "Authorization: Bearer $TOKEN" http://localhost:9877/worktrees
```

Returns discovered `/data/projects/baseplane*` directories with branch info and active session status.

### Create Session

```bash
curl -N -H "Content-Type: application/json" \
  -d '{"worktree":"baseplane-dev1","prompt":"what branch am I on?"}' \
  http://localhost:9877/sessions
```

Returns an SSE stream. Optional fields: `model`, `system_prompt`, `allowed_tools`, `max_turns`, `max_budget_usd`.

One active session per worktree. Returns `409` if worktree is busy.

### Resume Session

```bash
curl -N -H "Content-Type: application/json" \
  -d '{"prompt":"now do X"}' \
  http://localhost:9877/sessions/$SESSION_ID/message
```

Resumes the SDK session with full conversation context. Returns SSE stream.

### Abort Session

```bash
curl -X POST http://localhost:9877/sessions/$SESSION_ID/abort
```

### List / Get / Delete Sessions

```bash
curl http://localhost:9877/sessions              # list all
curl http://localhost:9877/sessions/$SESSION_ID   # get details
curl -X DELETE http://localhost:9877/sessions/$SESSION_ID  # remove from tracking
```

### Gateway Status

```bash
curl http://localhost:9877/status
```

Returns server info, session counts, and worktree list.

## SSE Events

```
event: session_init
data: {"session_id":"...","sdk_session_id":"...","worktree":"dev1","model":"...","tools":[...]}

event: assistant
data: {"uuid":"...","content":[{"type":"text","text":"..."}]}

event: result
data: {"session_id":"...","subtype":"success","duration_ms":...,"total_cost_usd":...,"result":"..."}

event: error
data: {"session_id":"...","error":"..."}
```

Heartbeat comments (`: heartbeat`) sent every 15s. Client disconnect triggers abort.

## Design

- **One session per worktree** — prevents file conflicts
- **`settingSources: ['project']`** — loads CLAUDE.md, hooks, and skills from each worktree
- **`bypassPermissions`** — unattended execution, no interactive prompts
- **CLAUDECODE env vars stripped** — prevents SDK from detecting nested session
- **Binds `127.0.0.1` only** — expose externally via Cloudflare tunnel
- **State at `~/.cc-gateway/state.json`** — atomic writes, crash recovery for orphaned sessions
- **No turn limit by default** — omit `max_turns` for unlimited; pass it to cap

## File Structure

```
src/
├── server.ts      # HTTP server, routing, startup/shutdown
├── auth.ts        # Bearer token (timing-safe compare)
├── types.ts       # All interfaces
├── state.ts       # Atomic JSON persistence
├── worktrees.ts   # Auto-discover /data/projects/baseplane*
├── sessions.ts    # Core: create, resume, abort via SDK query()
├── sse.ts         # SSE write helpers
└── env.ts         # Strip CLAUDECODE* env vars
```
