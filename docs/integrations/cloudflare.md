# Cloudflare (Workers + Durable Objects + D1 + R2)

Source package / configuration: `apps/orchestrator/wrangler.toml` (the canonical platform config — bindings, migrations, routes, observability).

## Version

Workers runtime pinned via `compatibility_date = "2026-03-31"` with `compatibility_flags = ["nodejs_compat", "web_socket_auto_reply_to_close"]`. The `web_socket_auto_reply_to_close` flag is opt-in here because it doesn't ship by default until compat date 2026-04-07; without it the runtime leaves WS in `CLOSING` after a Close frame and emits abnormal `code=1006` flaps. Wrangler version is pinned per-app (`apps/orchestrator/package.json` -> `wrangler: ^4.80.0`).

## Footprint

The orchestrator runs entirely on Cloudflare:

- **Workers** — the `duraclaw-orchestrator` Worker is the only HTTP/WS-facing surface. It serves the Vite SPA via `env.ASSETS.fetch()`, routes `/api/*` through Hono, and routes `/agents/*` WS upgrades through PartyServer to the right Durable Object.
- **Durable Objects** — five classes bound: `SessionDO` (`SESSION_AGENT`), `UserSettingsDO` (`USER_SETTINGS`), `SessionCollabDOv2` (`SESSION_COLLAB`), `SessionCollabDO` (`SESSION_COLLAB_LEGACY`, kept alive only to avoid implicit delete-class), and `RepoDocumentDO` (`REPO_DOCUMENT`). Migration tags `v1`..`v7` track the SQLite-backed class introductions over time.
- **D1** — single database `duraclaw-auth` (binding `AUTH_DB`, id `c5b4d822-9bc6-467f-9ad6-7ee779b82e0c`) on the `baseplane-ai` account. Holds users / sessions catalog / projects / preferences via the Drizzle schema in `apps/orchestrator/src/db/schema.ts`.
- **R2** — two buckets: `duraclaw-mobile` (binding `MOBILE_ASSETS`) for OTA bundles + APK artifacts, `duraclaw-session-media` (binding `SESSION_MEDIA`) for oversized base64 image offload from session messages. Both are streamed back through same-origin Worker routes; no public R2 URLs are issued.
- **Custom domain** — `dura.baseplane.ai` (custom_domain route in wrangler.toml). This is the auth cookie scope and the WS dial-back origin.
- **Cron triggers** — `*/5 * * * *` invoking `scheduled` in `src/server.ts` (replaces the in-DO discovery alarm from issue #7 p2).
- **Observability** — `[observability] enabled = true` (Workers logs / `wrangler tail`).

## Assumptions

- Workers' execution model: single-request-scoped compute, **30s wall-clock** per request, **128 MB memory**, no Node APIs by default (`nodejs_compat` is opt-in).
- Durable Objects: SQLite-backed storage **persists across redeploys**, single-active-instance per id with the platform serializing concurrent requests to that instance — the per-session DO is the single source of truth for its session.
- D1: SQLite-compatible (Drizzle works), eventually consistent across edge regions, sufficient for catalog operations but NOT for hot per-request paths.
- R2: standard object-store semantics (write-once, read-many, atomic put), Worker can stream objects through itself as a same-origin proxy.
- Custom domain `dura.baseplane.ai` is the cookie scope for Better Auth and the WSS dial-back origin baked into runner-bound `WORKER_PUBLIC_URL`.
- DO migration tags are append-only — rewriting a tag's body is a no-op against deployed Workers.

## What would break if

- A request needing **>30s of compute** wouldn't run on Workers — it would force a non-Worker host (queue worker, container) into the architecture.
- D1 going **read-only** would freeze new session creation (no `agent_sessions` row to insert) but live sessions would continue (the DO is truth for their state).
- D1 dropping **SQLite compatibility** would break Drizzle, the auth integration, and most catalog code paths.
- A DO platform change breaking the **per-id single-active guarantee** would invalidate the assumption that `SessionDO` is the single source of truth.
- An **R2 outage** degrades media display (existing `r2Key` references 404) and freezes mobile OTA polling on the currently-installed bundle, but does not break the core conversation flow.
- Renaming the **`dura.baseplane.ai`** custom domain breaks the auth cookie scope (every browser silently logged out) and the runner dial-back URL (every in-flight runner unable to reconnect to its DO).
- Editing an already-applied migration tag is silently ignored — new DO classes must use a NEW tag.

## See also

- [`docs/theory/boundaries.md`](../theory/boundaries.md) — the theory-layer entry for Cloudflare Workers + DO, D1, and R2.
- [`docs/theory/topology.md`](../theory/topology.md) — the per-session DO model (one DO per session id) and what survives each side's restart.
- `apps/orchestrator/wrangler.toml` — canonical config; treat as load-bearing.
