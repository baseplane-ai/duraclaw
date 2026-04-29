# Orchestrator

Source package: `apps/orchestrator/`.

The Cloudflare-Workers frontend tier. Serves the Vite SPA, runs the Hono API, hosts Better Auth, owns every Durable Object class, and is the only host that talks to D1, R2, and the VPS gateway.

## Module Test

- **Nav entry / surface:** `https://dura.baseplane.ai` — the Worker entrypoint that serves the React 19 + TanStack Router SPA, the `/api/*` Hono routes, the Better Auth flow at `/login` + `/api/auth/*`, and the WebSocket upgrade routes that bridge clients to per-session, per-document, per-user, and per-project Durable Objects.
- **Owns:** the per-session Durable Object (`SessionDO`), the per-user `UserSettingsDO`, the per-document `RepoDocumentDO` (collaborative yjs host), the singleton `ProjectRegistry`-style DOs; the D1 `auth`, `agent_sessions`, `runner_identities`, `projectMetadata`, and Better Auth tables; the React SPA bundle.
- **Domain question:** Where do user sessions live, and how do they sync to clients?

## Owns

- `agent_sessions` (D1) — idle/background fallback row per session; lifecycle phases: `created → running → idle → archived`
- `runner_identities` (D1) — admin-managed identity catalog with LRU + cooldown bookkeeping for failover
- `projectMetadata` (D1) — per-project state (docs-runner DO id, docs worktree path, tombstone settings)
- `sessionMessages` (DO SQLite, inside `SessionDO`) — durable per-session message history + `event_log` for observability
- All per-user synced collections (sessions, branches, tabs, preferences, viewers) hydrated client-side via PartyServer
- The active callback token used to authenticate runner dial-backs (rotated by `triggerGatewayDial`)

## Consumes

- [`docs/integrations/cloudflare.md`] — Workers, Durable Objects, D1, R2, and PartyServer underpinnings
- [`docs/integrations/better-auth.md`] — D1-backed session cookie auth (per-request instance because D1 only exists in the request context)
- [`docs/modules/agent-gateway.md`] — POSTs `/sessions/start` over HTTPS with bearer auth to spawn runners
- [`docs/modules/mobile.md`] — uploads OTA web bundles to R2 and serves the manifest route the mobile shell polls

## Theory references

- [`docs/theory/topology.md`] — the orchestrator is the frontend tier and the only host that talks to D1, R2, and the gateway
- [`docs/theory/data.md`] — the DO is authoritative for live session state; D1 is the idle/background fallback, not a truth-gate
- [`docs/theory/dynamics.md`] — orchestrator-side spawn intent, resume scheduling, identity failover, orphan recovery
- [`docs/theory/trust.md`] — Better Auth cookie boundary, callback-token mint + timing-safe validation, dual-auth on collaborative DO endpoints

## Key files

- `apps/orchestrator/src/server.ts` — Worker `fetch` handler: routes WS upgrades via `routePartykitRequest`, HTTP via the Hono app from `createApiApp()`, exports the four DO classes
- `apps/orchestrator/src/agents/session-do/index.ts` — `SessionDO` entry; orchestrates spawn, resume, gates, identity failover, orphan recovery
- `apps/orchestrator/src/agents/session-do/runner-link.ts` — runner-side WS validation (timing-safe token compare) + close-code semantics (`4401` invalid token, `4410` token rotated)
- `apps/orchestrator/src/agents/repo-document-do.ts` — `RepoDocumentDO`, the per-document yjs host with `hibernate: true` and dual-auth `onConnect`
- `apps/orchestrator/src/agents/user-settings-do.ts` — `UserSettingsDO`, the per-user fan-out for synced collections
- `apps/orchestrator/src/db/schema.ts` — Drizzle definitions for D1: `agent_sessions`, `runner_identities`, `projectMetadata`, Better Auth tables
- `apps/orchestrator/src/api/index.ts` — Hono router: identity admin, sessions API, project metadata, push, mobile OTA manifest, etc.

## Surfaces

- **HTTP** — `GET /` static SPA assets, `/api/*` Hono routes, `/api/auth/*` Better Auth handler, `/api/mobile/updates/manifest` (public, mounted before auth middleware)
- **WebSocket** — `/agents/session-agent/<do-id>` (browser peer + runner dial-back), `/api/collab/repo-document/:entityId/ws` (browser + docs-runner peers), `/agents/user-settings-agent/<userId>` (per-user fan-out)
- **DO bindings** — `SESSION_AGENT`, `REPO_DOCUMENT`, `USER_SETTINGS_AGENT`, `PROJECT_REGISTRY` (declared in `wrangler.toml`)

## Environment (wrangler secrets)

`CC_GATEWAY_URL`, `CC_GATEWAY_SECRET`, `WORKER_PUBLIC_URL` (the wss base runners dial), `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `DOCS_RUNNER_SECRET`, `IDENTITY_HOME_BASE` (default `/srv/duraclaw/homes`), and the optional `MOBILE_ASSETS` R2 binding for OTA distribution.
