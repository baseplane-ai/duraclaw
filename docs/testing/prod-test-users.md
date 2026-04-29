# Prod test users

> Manual recipe — three admin users seeded against production for end-to-end smoke testing.

## What this is

Production (`https://dura.baseplane.ai`) carries three admin test
accounts (`agent.verify+prod@example.com`, `+prod-a@`, `+prod-b@`) used
for manual e2e walkthroughs against the live deployment. They are
**seeded, not signed-up** — the `/api/auth/sign-up/email` endpoint is
disabled in prod, so accounts are created via the token-locked
`/api/bootstrap` endpoint, which always promotes the resulting user to
`admin`.

Seeding is intentionally manual: it runs infrequently, is
environment-specific, and shouldn't be re-executed silently on every
deploy. The `BOOTSTRAP_TOKEN` Worker secret is **left set in prod** (we
chose "leave it set" over "delete after seed") so re-seeding is a single
`curl` away when needed.

## Recipe

1. Pull credentials from `.env.test-users.prod` at the worktree root
   (mode 600, gitignored via `.env.test-users*`). If the file is missing
   from a fresh clone, copy it from a peer worktree —
   e.g. `cp /data/projects/duraclaw/.env.test-users.prod .`. There is no
   automated sync.
2. Open `https://dura.baseplane.ai/login` and sign in with one of the
   three emails + the matching password from the env file.
3. Run the canonical "spawn → message → resume → close" flow:
   create a session, send a turn, leave it idle past the reaper window,
   send a follow-up that triggers `resume`, then close.
4. Verify against DO SQLite (`session_transcript` + `event_log`) via
   `wrangler tail` or the `getEventLog()` RPC that the messages and
   identity transitions match expectations.

## What success looks like

- Login redirects to the dashboard without a 401.
- A new session reaches `streaming` then `idle` and persists transcript
  rows in DO SQLite.
- Resume after idle picks the next available identity (LRU) without
  message loss.
- No `BOOTSTRAP_TOKEN` errors appear in `wrangler tail`.

## Common breakages

- **Missing `.env.test-users.prod`** — copy from a peer worktree; do not
  commit and do not paste into chat.
- **`User already exists` on re-seed** — a prior `signUpEmail` 500'd
  mid-flow and left a partial row. Purge from prod D1 (`users`,
  `accounts`, `sessions`, `user_preferences`, `user_tabs`,
  `user_presence` — FK column is `user_id`, snake_case) before retry.
- **Bootstrap returns 401** — confirm `BOOTSTRAP_TOKEN` is still set as
  a Worker secret (`npx wrangler secret list`) and that your
  `Authorization: Bearer …` header matches.
- **Rotation needed** — update `.env.test-users.prod` in *every*
  worktree (no automated sync) and re-seed via `/api/bootstrap`. Do not
  share credentials externally.

## Source

- User memory: "Prod test users" (`ops_prod_test_users.md`)
- `.claude/rules/testing.md` — "Test user credentials (prod)" section
- Bootstrap endpoint: `apps/orchestrator/src/api/index.ts` (`/api/bootstrap`)
