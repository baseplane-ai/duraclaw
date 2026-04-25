---
paths:
  - "scripts/verify/**"
  - "scripts/axi"
---

# UI Testing & Verification

Use `scripts/axi` (not raw `chrome-devtools-axi`) for browser verification
of UI changes — it auto-isolates the Chrome profile and bridge port per
worktree so parallel agents don't clobber each other's browser state.
Same interface as `chrome-devtools-axi`, handles SPAs, JS rendering, and
interaction.

**Test user credentials (local dev):**
- Email: `agent.verify+duraclaw@example.com`
- Password: `duraclaw-test-password`
- Name: `agent-verify`

**Test user credentials (prod, https://dura.baseplane.ai):**
Three admin test users (`agent.verify+prod@`, `+prod-a@`, `+prod-b@`) are
seeded in prod. Passwords are NOT in this file — they live in
`.env.test-users.prod` at the root of each worktree (mode 600, gitignored
via the `.env.test-users*` pattern). If the file is missing from a fresh
clone, copy it from a peer worktree (e.g.
`/data/projects/duraclaw/.env.test-users.prod`).

Re-seed procedure (endpoint is token-locked): `BOOTSTRAP_TOKEN` is kept
set as a Worker secret in prod, so `POST /api/bootstrap` with
`Authorization: Bearer $BOOTSTRAP_TOKEN` and `{email,password,name}` works
directly — no secret-put round-trip. Bootstrap always promotes seeded
users to `admin`. If `signUpEmail` 500s mid-flow, a partial user row can
land in D1 with an unrecoverable password; purge from `users` /
`accounts` / `sessions` / `user_preferences` / `user_tabs` /
`user_presence` (FK column is `user_id`, snake_case) before retry.

**Common workflow:**
```bash
scripts/axi open <url>          # Navigate to page
scripts/axi snapshot            # Get accessibility tree with @refs
scripts/axi click @<ref>        # Click an element
scripts/axi fill @<ref> <text>  # Fill an input field
scripts/axi screenshot          # Visual capture
scripts/axi eval <js>           # Run JS in page context
```

**Login flow example:**
```bash
scripts/axi open http://localhost:43173/login
scripts/axi snapshot
scripts/axi fill @<email-ref> agent.verify+duraclaw@example.com
scripts/axi fill @<password-ref> duraclaw-test-password
scripts/axi click @<submit-ref>
scripts/axi snapshot            # Verify redirect to dashboard
```

**GitHub operations:** Use `gh-axi` instead of `gh` for issues, PRs, runs, releases.

## Dual browser profiles (multi-user verification)

For VPs that need two real signed-in users at once, pre-launch two Chromes
and target each via `CHROME_DEVTOOLS_AXI_BROWSER_URL`:

```bash
scripts/verify/browser-dual-up.sh          # idempotent: launches A + B on per-worktree ports
scripts/verify/axi-a open http://localhost:43173/login   # drive user A
scripts/verify/axi-b open http://localhost:43173/login   # drive user B
scripts/verify/browser-dual-down.sh        # teardown
```

Profiles live at `/tmp/duraclaw-chrome-a-<worktree>` and
`/tmp/duraclaw-chrome-b-<worktree>` — each has its own cookie jar, so
sign-in state doesn't cross-contaminate between users OR between worktrees.

**Ergonomic multi-user helpers** (prefer these over raw `axi-a` / `axi-b`):

```bash
scripts/verify/axi-dual-login.sh                         # one-shot: launch + seed + login both
scripts/verify/axi-login a                               # default $VERIFY_USER_A_*
scripts/verify/axi-login b alt@example.com pw            # override email/password
scripts/verify/axi-both snapshot                         # same command against both browsers
```

Defaults from `scripts/verify/common.sh`:
- User A: `agent.verify+a@example.com` / `duraclaw-test-password-a`
- User B: `agent.verify+b@example.com` / `duraclaw-test-password-b`

Override via `VERIFY_USER_A_EMAIL`, `VERIFY_USER_A_PASSWORD`,
`VERIFY_USER_B_EMAIL`, `VERIFY_USER_B_PASSWORD`.

## Verify-mode local stack

`scripts/verify/dev-up.sh` starts a local orchestrator (miniflare) and
local agent-gateway for the current worktree — each on **worktree-derived
ports** so parallel worktrees don't collide.

`scripts/verify/common.sh`:

- Derives `VERIFY_ORCH_PORT` and `CC_GATEWAY_PORT` from the worktree path.
- `VERIFY_GATEWAY_PORT` (NOT `CC_GATEWAY_PORT`) is the override knob.
- `sync_dev_vars()` regenerates `apps/orchestrator/.dev.vars` every
  `dev-up.sh` run. `.dev.vars` is a generated artifact — don't hand-edit,
  override via `$VERIFY_ROOT/.env` instead.

Expected generated `.dev.vars` shape:

```
BETTER_AUTH_URL=http://127.0.0.1:<orch>
CC_GATEWAY_URL=ws://127.0.0.1:<gateway>
CC_GATEWAY_SECRET=<from .env>
WORKER_PUBLIC_URL=http://127.0.0.1:<orch>
BOOTSTRAP_TOKEN=<from .env, optional>
```

Missing `WORKER_PUBLIC_URL` causes the classic "message lands in history,
no assistant turn" silent-fail (GH#8). If you see `Gateway not configured
for this worker`, fill in `.dev.vars`.

**User seeding**: `/api/auth/sign-up/email` is disabled by default. Use
the token-protected `/api/bootstrap` endpoint:

```bash
source .env
for u in a b; do
  curl -s -X POST http://127.0.0.1:$VERIFY_ORCH_PORT/api/bootstrap \
    -H "Authorization: Bearer $BOOTSTRAP_TOKEN" \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"agent.verify+$u@example.com\",\"password\":\"duraclaw-test-password-$u\",\"name\":\"agent-verify-$u\"}"
done
```

Gateway-side project resolution is governed by `PROJECT_PATTERNS` /
`WORKTREE_PATTERNS` (comma-separated prefixes). Leaving them unset accepts
every git repo under `/data/projects/`.

## Portless mode (stable subdomains)

Direct-port mode (`dev-up.sh`) already derives per-worktree ports, but
portless mode offers stable `.localhost` subdomains as an alternative.

```bash
scripts/verify/portless-up.sh       # launches both under portless
scripts/verify/portless-down.sh     # teardown
```

Subdomain contract:
- Orchestrator: `https://duraclaw-orch.localhost`
- Gateway: `https://duraclaw-gw.localhost` (WS: `wss://duraclaw-gw.localhost`)
