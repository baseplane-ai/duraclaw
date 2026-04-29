# Local dev stack — `dev-up.sh`

> Manual recipe — bring up a per-worktree local orchestrator + gateway, with auto-derived non-colliding ports.

## What this is

`scripts/verify/dev-up.sh` is the canonical way to start a local
Duraclaw stack for the current worktree. It:

1. Generates `apps/orchestrator/.dev.vars` from the worktree's `.env`
   (via `sync_dev_vars()` in `scripts/verify/common.sh`).
2. Starts the agent-gateway (Bun) and the orchestrator (Vite +
   miniflare) under `tmux`, writing PID files and logs into
   `.verify-runtime/`.
3. Waits for both services to answer health checks before returning.

Ports are **derived from the worktree's absolute path** via `cksum %
800`, so any number of clones can run in parallel without manual port
allocation.

## Port derivation

| Range | Purpose |
|-------|---------|
| 9800–10599 | Gateway (`CC_GATEWAY_PORT`) |
| 11000–11799 | Browser A CDP (dual-browser) |
| 12000–12799 | Browser B CDP (dual-browser) |
| 13000–13799 | AXI-A bridge (dual-browser) |
| 14000–14799 | AXI-B bridge (dual-browser) |
| 15000–15799 | AXI bridge (single-browser via `scripts/axi`) |
| 15800–16599 | Docs runner (`CC_DOCS_RUNNER_PORT`) |
| 43000–43799 | Orchestrator (`VERIFY_ORCH_PORT`) |

See `.claude/rules/worktree-setup.md` for the per-worktree assignment
table.

## Recipe (fresh clone)

1. `cd /data/projects && git clone git@github.com:baseplane-ai/duraclaw.git duraclaw-devN`
2. `cd duraclaw-devN`
3. `cp .env.example .env` and fill in `CC_GATEWAY_API_TOKEN` +
   `BOOTSTRAP_TOKEN` (or run `scripts/setup-clone.sh --from
   /data/projects/duraclaw/.env` to copy from a peer worktree).
4. `scripts/verify/dev-up.sh` — generates `.dev.vars`, starts both
   services, prints the orchestrator URL on success.
5. Optional: seed local users via `/api/bootstrap` (see
   `.claude/rules/testing.md`).

## What success looks like

- Gateway log: `agent-gateway listening on 127.0.0.1:<port>` (port
  matches your worktree's row in the table).
- Orchestrator log: Vite ready banner + `Miniflare ready`, listening on
  `http://127.0.0.1:<orch-port>`.
- `cat apps/orchestrator/.dev.vars` shows `CC_GATEWAY_URL`,
  `WORKER_PUBLIC_URL`, `BETTER_AUTH_URL`, `CC_GATEWAY_SECRET`,
  optionally `BOOTSTRAP_TOKEN`.
- `kata status` (or just `cat .verify-runtime/*.pid`) confirms both PIDs
  are alive.
- `curl http://127.0.0.1:<orch-port>/api/health` returns 200.

## Common breakages

- **Missing `WORKER_PUBLIC_URL` in `.dev.vars`** — classic silent fail
  (GH#8): message lands in history, no assistant turn. Re-run
  `dev-up.sh` after fixing `.env` (don't hand-edit `.dev.vars`, it gets
  regenerated).
- **`Gateway not configured for this worker`** — same root cause; check
  `.dev.vars`.
- **Port already in use** — a previous run wasn't cleanly stopped. Run
  `pkill -f duraclaw-agent-gateway` (and `pkill -f wrangler` if needed)
  then re-run `dev-up.sh`.
- **Gateway returns 401 on dial-back** — `CC_GATEWAY_API_TOKEN` missing
  or mismatched between `.env` and the runner's env. Re-source `.env`
  and restart.
- **`CC_GATEWAY_PORT` set in `.env`** — never do this; it collides
  across worktrees. Use `VERIFY_GATEWAY_PORT` if you need to override
  the derived port.
- **Browser sessions colliding across worktrees** — use `scripts/axi`,
  not raw `chrome-devtools-axi`; the wrapper isolates the Chrome profile
  and bridge port per worktree.

## Source

- `scripts/verify/dev-up.sh` and `scripts/verify/common.sh`
- `.claude/rules/worktree-setup.md` (port derivation + bootstrap flow)
- `.claude/rules/testing.md` (verify-mode local stack section)
