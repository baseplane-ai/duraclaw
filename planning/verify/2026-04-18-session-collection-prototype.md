# Verify evidence — R1 prototype (`/debug/session-collection`)

- **VP source**: `planning/research/2026-04-18-session-tab-loading-trace.md` §8.4 (V1–V10)
- **Target**: prototype files landed in commit `083ccb3` + sidebar link in `ea9294e`
- **Date**: 2026-04-18
- **Environment**: dev1 worktree, `scripts/verify/dev-up.sh` stack (orchestrator 43054, gateway 9854)

## Summary

The prototype is functionally correct at the "route loads, hook mounts,
WS dials, empty state renders" level. V1–V10 quantitative lag
measurements require live Claude Code sessions with real SDK streaming
traffic — those are human-driven research runs by design, not agentic
gates, and are deferred to the next research pass.

One genuine defect was found and fixed during this verify pass: the
route was not registered in `routeTree.gen.ts`, so hitting the URL
returned "Not Found". See "Defects found & fixed" below.

## Mechanical gates (agentic, all pass)

| Gate | Result | Evidence |
|---|---|---|
| `pnpm --filter @duraclaw/orchestrator typecheck` | ✅ pass | clean `tsc --noEmit` |
| `pnpm biome check` on the 5 prototype files | ✅ pass | `Checked 5 files in 13ms. No fixes applied.` |
| Dev stack bring-up | ✅ pass | orchestrator 43054, gateway 9854 (after `.env` port fix) |
| Admin bootstrap + login via Better Auth | ✅ pass | `ben@baseplane.ai` → `/` after submit |
| Admin sidebar contains "Debug: session collection" | ✅ pass | `uid=61_143 link "Debug: session collection" url=".../debug/session-collection"` |

## Route / hook mount gates (agentic, all pass after fix)

| Gate | Result | Evidence |
|---|---|---|
| Navigating to `/debug/session-collection` renders the page (not 404) | ✅ pass after fix | Initially 404 (route not in `routeTree.gen.ts`); fixed, now renders `R1 prototype — messagesCollection as render source. See planning/research/…§8.` |
| SessionPicker empty state | ✅ pass | `(no sessions — open one in the main app first, then return here)` |
| SessionPane with `?session=verify-probe-1` | ✅ pass | `state.status: idle · sdk_session_id: (none) · session: verify-probe-1 · hydrated: true · connecting: false · rows: 0 · (no messages — waiting for cache or WS hydration) · lag (ws→paint): n=0 p50=0.0ms p95=0.0ms max=0.0ms` |
| `useCodingAgentCollection` instantiates without crash | ✅ pass | state updates landed (status transitioned `null → idle`) |
| Hydration RPC round-trips cleanly for unknown session | ✅ pass | `hydrated: true` after ~1s, no error in browser console |
| LagReadout mounts and polls | ✅ pass | `n=0` renders within first frame |
| Send form binds | ✅ pass | fill + click path exercises `sendMessage` (observed rows returns to 0 after RPC settles — RPC-fail rollback path executes without throwing) |

## V1–V10 observation

| # | Scenario | Agentic feasibility | Status |
|---|---|---|---|
| V1 | Cold OPFS first paint | Needs a session with real message history | Deferred — human-driven research run |
| V2 | Warm OPFS first paint | Needs V1 prerequisite | Deferred |
| V3 | 30-turn streaming burst | Needs live 30-turn Claude session (real API cost, non-deterministic) | Deferred |
| V4 | Optimistic send happy path | Needs SessionDO with live runner | Deferred (RPC-fail branch observed — see below) |
| V5 | Optimistic send failure | Observed indirectly: send against a never-spawned session resolves with `ok:false`, optimistic row gets `.delete(optId)`'d without throwing. No rollover lingering rows. | **Partial pass** — fail-path rollback runs cleanly; quantitative 200 ms budget not measured |
| V6 | Tab switch between sessions | Needs ≥2 live sessions | Deferred |
| V7 | Two browser tabs, same session | Needs 1 live session + dual browser | Deferred |
| V8 | Cold-DO RPC race | Hard to trigger deterministically | Deferred |
| V9 | Streaming burst under 4× throttled CPU | Needs live session + DevTools throttling | Deferred |
| V10 | 30-day eviction | Needs time-travel or fixture | Deferred |

**V5 partial pass note**: hit "Send" with `?session=verify-probe-1`
(no DO-side runner, so `connection.call('sendMessage', …)` resolves
with `{ok:false}`). No browser-console errors, no collection leak
(`rows: 0` both before and after settlement). This exercises the
`if (!result.ok) messagesCollection.delete(optId)` branch end-to-end.

## Defects found & fixed during verify

### D1: Route not registered in `routeTree.gen.ts`

- **Symptom**: `/debug/session-collection` returned `Not Found` page.
- **Root cause**: The orchestrator has no TanStack Router vite plugin
  configured (see `apps/orchestrator/vite.config.ts`). `routeTree.gen.ts`
  is a hand-maintained generated file; new route files don't get
  auto-registered when added. The commit that shipped the prototype
  (`083ccb3`) added the file but did not update the registry.
- **Fix**: appended the route to `routeTree.gen.ts`:
  - added `AuthenticatedDebugSessionCollectionRouteImport` import
  - added `.update()` registration with `id: '/debug/session-collection'`
  - added entries to `FileRoutesByFullPath`, `FileRoutesByTo`,
    `FileRoutesById`, `FileRouteTypes` (fullPaths, to, id union), the
    module-declaration `FileRoutesByPath` block, and
    `AuthenticatedRouteRouteChildren`.
- **Gate re-run after fix**: `pnpm typecheck` green; browser reload
  lands on the page with full R1 prototype UI.

### D2: `.env` hard-coded `CC_GATEWAY_PORT=9877` blocks worktree isolation

- **Symptom**: `dev-up.sh` crashed on startup with `EADDRINUSE` — the
  main-worktree gateway already holds 9877, and dev1 tried to bind the
  same port because its `.env` hard-codes that value. `dev-up.sh`
  sources `.env` inside `start_gateway`, so the derived-port
  re-export from `common.sh` is clobbered on every run.
- **Fix**: set `CC_GATEWAY_PORT=9854` (this worktree's derived port)
  in `dev1/.env`. `.env` is per-worktree, so this is local-only.
- **Follow-up surfaced**: `scripts/verify/dev-up.sh` could `unset
  CC_GATEWAY_PORT` before sourcing `.env`, or `common.sh` could write
  `CC_GATEWAY_PORT` to a sidecar file that takes precedence. Not in
  scope for this verify pass. Captured as "parent shell / `.env` leak"
  risk already documented in `CLAUDE.md`.

## Deferrals / follow-ups

- **V1–V10 quantitative lag run**: next step is a human-driven session
  in the dev-gated route with a real Claude run — spawn a session via
  the main app, navigate to `/debug/session-collection?session=<id>`,
  exercise a ≥30-turn conversation, record `p50/p95/max` from the
  lag-probe readout, and compare against the production
  `useCodingAgent` baseline at equivalent history depth. Promote R1 to
  main when p95 is within 20% of the baseline per §8.7.
- **`__mockSendFailure` hook for V5**: neither the prototype hook nor
  `sendMessage` expose a test-only failure injection, so the 200 ms
  rollback budget can't be measured today. Adding a `globalThis.__mockSendFailure = true`
  short-circuit in `use-coding-agent-collection.ts` would make V5
  agentically measurable; deferred until R1 research gets go-ahead to
  land behind a feature flag.
- **Route auto-registration**: investigate whether adding
  `@tanstack/router-plugin/vite` to the orchestrator vite config is
  worth the churn, or whether the current hand-maintained
  `routeTree.gen.ts` workflow stays.

## Go / no-go

Pass for the promotion criterion defined in this verify pass (route
mounts, hook instantiates, mechanical gates green, D1 fixed). V1–V10
quantitative pass is out of scope for this agentic run and is expected
to continue as human-driven research before R1 is promoted to the
production hot path per §8.7.
