---
paths:
  - "apps/orchestrator/**"
---

# Orchestrator (CF Workers)

- **Durable Objects**: `SessionDO` (1 per session, owns state + SQLite message history + `active_callback_token` for runner auth), `ProjectRegistry` (singleton, worktree locks + session index), `UserSettingsDO`
- **Auth**: Better Auth with D1 via Drizzle. Per-request auth instance (D1 only available in request context). Login at `/login`, API at `/api/auth/*`
- **Environment** (wrangler secrets): `CC_GATEWAY_URL` (http(s) URL to gateway), `CC_GATEWAY_SECRET` (bearer matched by gateway), `WORKER_PUBLIC_URL` (wss base the runner uses to dial the DO), `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`
- **D1 Database**: `duraclaw-auth`
- **Entry point**: `src/server.ts` exports DO classes + TanStack Start default handler
