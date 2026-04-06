# Verification Tools — Duraclaw

This project verifies against a real local stack:

- Orchestrator UI/API on a Vite-assigned local port, persisted to `logs/verify/state/runtime.env`
- Gateway API on `http://127.0.0.1:9877`
- Auth via Better Auth cookie sessions
- Browser automation via `agent-browser`

## Verification Growth Rule

- Treat `pnpm verify:smoke` as the current baseline, not the permanent definition of "covered"
- As roadmap items land, add or extend targeted verification scripts in `scripts/verify/` and expose them as root `pnpm verify:*` commands
- Prefer capability-oriented names such as `verify:dashboard`, `verify:session:rewind`, or `verify:settings:theme`
- Keep new checks cumulative and map them back to the roadmap subphase they prove

## Project Dev Server

```bash
# Starts both services in the background, writes logs under logs/verify/
pnpm verify:dev:up

# Readiness endpoint for the orchestrator
# Resolved at runtime from logs/verify/state/runtime.env
${VERIFY_ORCH_URL}/api/auth/get-session

# Preferred UI port
43173
```

## API Base URLs

```text
${VERIFY_ORCH_URL}/api
http://127.0.0.1:9877
```

## Authentication

```bash
# Creates or signs into the local verification user and refreshes the cookie jar.
# Cookie jar: logs/verify/state/auth.cookies.txt
pnpm verify:auth
```

Default local verification credentials can be overridden:

```bash
export VERIFY_AUTH_EMAIL="agent.verify+duraclaw@example.com"
export VERIFY_AUTH_PASSWORD="duraclaw-test-password"
```

## Database Access

```bash
# Better Auth user/session tables (local D1 for the orchestrator worker)
cd apps/orchestrator
pnpm exec wrangler d1 execute duraclaw-auth --local --command \
  "SELECT email, name FROM user ORDER BY createdAt DESC LIMIT 5;"

# Session state is stored in Durable Object SQLite. Verify that state through the
# real HTTP/WebSocket APIs rather than trying to read the DO database directly.
```

## Key Endpoints / Pages

| Route | Method | Purpose |
|-------|--------|---------|
| `/health` | `GET` | Gateway readiness; no auth required |
| `/projects` | `GET` | Gateway project discovery; Bearer auth if `CC_GATEWAY_API_TOKEN` is set |
| `/projects/:name/files?depth=1` | `GET` | Real file-tree verification against a discovered project |
| `/projects/:name/git-status` | `GET` | Real git-status verification against a discovered project |
| `/api/auth/get-session` | `GET` | Orchestrator readiness and authenticated session validation |
| `/api/auth/sign-up/email` | `POST` | Create the local verification user |
| `/api/auth/sign-in/email` | `POST` | Produce a real Better Auth session cookie |
| `/api/projects` | `GET` | Orchestrator -> gateway project proxy verification |
| `/api/sessions` | `POST` | Real session creation verification |
| `/api/sessions/:id` | `GET` | Session state polling and completion verification |
| `/api/sessions/:id/messages` | `GET` | Persisted assistant output verification |
| `/login` | `GET` | Browser entry point for real UI auth smoke tests |
| `/` | `GET` | Post-login landing page for browser smoke verification |
| `/session/:id` | `GET` | Live session page verification in the browser |

## Project-Specific Notes

- Canonical quick smoke suite: `pnpm verify:smoke`
- Session lifecycle smoke: `pnpm verify:session`
- Session UI smoke: `pnpm verify:browser:session`
- Future roadmap work should follow the same pattern: baseline smoke stays green, and each new feature adds a targeted `verify:*` command instead of relying on the old baseline alone
- Raw artifacts go to `logs/verify/`
- Structured phase evidence belongs in `.kata/verification-evidence/`
- `pnpm verify:dev:up` overrides local dev env so the orchestrator points at `ws://127.0.0.1:9877`, then records the actual Vite URL in `logs/verify/state/runtime.env`
- The orchestrator dev server is held open in tmux session `duraclaw-verify-orchestrator`
- The orchestrator launcher must preserve a PTY. Logging is done with `tmux pipe-pane`; direct shell redirection can produce empty HTML responses for `/` and `/login` while API routes still appear healthy
- If local orchestrator startup fails, check `logs/verify/orchestrator.log`
- The preferred orchestrator port is `43173`, but the wrapper tolerates Vite picking another local port and reuses that detected URL for later auth/browser checks
- `VERIFY_PROJECT` is optional. If unset, the gateway smoke script uses the first discovered project returned by `/projects`
- The gateway currently discovers `/data/projects/baseplane*` by default, so verification normally targets one of those worktrees rather than the `duraclaw` repo itself
- The repo-local CLI entrypoint for workflow checks is `pnpm kata ...`
