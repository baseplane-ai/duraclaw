---
date: 2026-04-19
topic: Capacitor (mobile) + Electron (desktop) native build targets with per-platform SQLite — matching the existing web client
status: complete
github_issue: null
related:
  - planning/research/2026-04-10-unified-packaging-tray-app.md
  - GH#12 (unify client data on TanStack DB collections)
---

# Research: Capacitor + Electron native targets with platform-native SQLite

## TL;DR

The web client already runs a full **SQLite + TanStack DB** stack in the browser (wa-sqlite on OPFS, TanStack DB 0.6 persistence adapters). So "give mobile and desktop their own SQLite impl to match the web version" is **not a ground-up port** — it is **substituting one adapter** per platform behind a stable `persistence` handle that four TanStack DB collections already depend on. The heavy lift is not SQLite; it is (1) adapting the Better Auth cookie model to native shells, (2) reaching the Worker's Agents-SDK WebSocket from outside a browser origin, and (3) deciding whether the desktop build embeds the VPS services locally or stays a thin client to the cloud deployment.

The fortunate discovery that unblocks everything: **the client already has zero Cloudflare-specific imports** (`grep` of `apps/orchestrator/src` finds no `cloudflare:` / `@cloudflare/*` from client-only code paths) and all persistence flows through the same four TanStack DB collections in `apps/orchestrator/src/db/`. The React bundle is portable as-is.

## Context

Duraclaw today:

- Browser → CF Worker (TanStack Start) → `SessionDO` (SQLite message history) → VPS `agent-gateway` → `session-runner` (Claude Agent SDK).
- Browser client persists four collections to OPFS SQLite via `@tanstack/browser-db-sqlite-persistence`:
  - `agent-sessions-collection.ts` (schema v3)
  - `messages-collection.ts` (schema v2)
  - `user-tabs-collection.ts` (schema v1)
  - `user-preferences-collection.ts` (schema v1)
- Persistence handle initialised once in `apps/orchestrator/src/db/db-instance.ts:34-38`:
  ```ts
  const database = await openBrowserWASQLiteOPFSDatabase({ databaseName: 'duraclaw' })
  return createBrowserWASQLitePersistence({ database })
  ```
  Every collection takes `persistence` + `schemaVersion` via `persistedCollectionOptions(...)` — a **stable adapter boundary**.

The user's request: ship Duraclaw as a Capacitor mobile app and an Electron desktop app, each with a **platform-native SQLite** (not a WASM build) as the local persister, while keeping the web version's behaviour.

## Classification

**Feasibility study + library evaluation + brainstorm.** Three dimensions must converge:

1. *Tech evaluation* — choose the SQLite implementation per platform.
2. *Feasibility* — identify where the web assumptions (cookie auth, Worker-origin WS, OPFS) break on native.
3. *Architecture* — decide the backend shape for each shell (cloud-only / embedded / hybrid).

## Questions explored

1. Is the current client actually portable to Capacitor/Electron as-is, or does it lean on browser-only APIs?
2. What's the minimum delta to swap the OPFS persister for a native SQLite on each target?
3. Which native SQLite libraries fit TanStack DB 0.6's persistence contract?
4. How does Better Auth work when the shell is `capacitor://localhost` or `file://` instead of the Worker origin?
5. How does the Agents SDK dial-back WebSocket behave from a native shell?
6. Does desktop run the gateway + session-runner locally, or stay a thin client?
7. What does a shared monorepo layout look like (new `apps/mobile`, `apps/desktop`, or a shell/shared split)?

## Findings

### 1. The client is already portable

From the survey of `apps/orchestrator/src/`:

- **No Cloudflare SDK imports in client code.** `useAgent` from `agents/react` is a browser-API consumer (WebSocket + fetch), not a runtime-bound import. `cloudflare:*` imports are fenced to `src/server.ts`, DO files in `src/agents/`, and API handlers — none of which ship in the React client bundle.
- **Auth client** (`lib/auth-client.ts`) uses `window.location.origin` to target `/api/auth/*`. That is the first concrete break — on Capacitor the origin is `capacitor://localhost`; on Electron `file://` or a custom protocol.
- **REST client** (`api/index.ts`) is relative-path fetch — same break point, same fix.
- **Agents SDK client** (`useAgent`) derives its WS URL from the same Worker origin assumption.

So the porting matrix is not "rewrite the UI" — it's "inject a base URL and swap the persister."

### 2. TanStack DB 0.6 already ships the adapters we need (March 2026)

TanStack DB 0.6 (released 2026-03-25) shipped a persistence layer **specifically designed to span runtimes with one collection model**:

> "SQLite-backed adapters across browser, React Native, Expo, Node, Electron, Capacitor, Tauri, and Cloudflare Durable Objects."
> — [TanStack DB 0.6 release blog](https://tanstack.com/blog/tanstack-db-0.6-app-ready-with-persistence-and-includes)

The unified factory signature (from the RN example in the blog):

```ts
import { createReactNativeSQLitePersistence, persistedCollectionOptions }
  from '@tanstack/react-native-db-sqlite-persistence'

const database = open({ name: 'tanstack-db.sqlite', location: 'default' })
const persistence = createReactNativeSQLitePersistence({ database })
```

Duraclaw's browser path uses the exact same shape:

```ts
const database = await openBrowserWASQLiteOPFSDatabase({ databaseName: 'duraclaw' })
const persistence = createBrowserWASQLitePersistence({ database })
```

**All `persistedCollectionOptions({ persistence, schemaVersion })` call sites stay byte-identical.** The per-platform difference is confined to `db-instance.ts`.

### 3. SQLite implementation matrix

| Target | Recommended library | Why | Sync/Async | Notes |
|---|---|---|---|---|
| **Web (current)** | `@tanstack/browser-db-sqlite-persistence` (wa-sqlite + OPFS) | Already in use; official SQLite WASM | async | SSR-guarded |
| **Electron (desktop)** | `better-sqlite3` via `@tanstack/node-db-sqlite-persistence` (or community Electron variant) | ~3M weekly DL, fastest Node SQLite, sync API — zero-jitter UI | **sync** | Must be marked external in Vite Rollup config; native rebuild per Electron version |
| **Electron (alt)** | `node:sqlite` (Node 22.5+ built-in) | Zero-dep, no native rebuild, but younger | sync | Comes "free" with modern Electron; good fallback if better-sqlite3 packaging bites |
| **Capacitor (iOS + Android)** | `@capacitor-community/sqlite` | Only mature Capacitor SQLite with iOS + Android + Electron + Web backends, maintained through 2026 | **async** | Uses SQLCipher under the hood (export-control note); Web fallback uses IndexedDB via `jeep-sqlite`, so on Capacitor-web we'd still hand the browser path to wa-sqlite instead |
| **Capacitor (alt)** | `@capawesome/capacitor-sqlite` | Commercial, cleaner OPFS on web, Capawesome-maintained | async | Licensing is paid; evaluate only if community plugin bites |

**op-sqlite is React-Native-only** (confirmed against [OP-Engineering/op-sqlite](https://github.com/OP-Engineering/op-sqlite) and cross-checked with Capacitor docs); it is not a Capacitor plugin. Don't chase it for the mobile shell.

**Electron key decision**: `better-sqlite3` is the default for desktop — sync API eliminates a whole class of UI jank, and `persistedCollectionOptions` handles sync persisters equally well. The tax is Vite external marking and a rebuild step per Electron version (`electron-rebuild`). `node:sqlite` is the graceful degradation path if packaging proves painful.

### 4. Auth — the biggest deviation from web

Better Auth's cookie-based sessions do not survive the native shell boundaries cleanly:

- **Capacitor**: Apple/Android security policies prevent reading cookies set during a system-browser OAuth redirect back into the `capacitor://localhost` WebView. The community answer is [`better-auth-capacitor`](https://github.com/daveyplate/better-auth-capacitor) — a Capacitor client plugin that:
  - Sets `disableDefaultFetchPlugins: true` so better-auth stops opening Safari/Chrome for OAuth (native auth sheet handles it).
  - Filters Set-Cookie prefixes to avoid infinite refetch loops.
  - Persists the session in `@capacitor/preferences` and replays it as an `Authorization:` header on every fetch.
- **Electron**: Easier — `session.defaultSession` has a full cookie jar; Better Auth "just works" if you set the `base-url` to the deployed Worker and ensure `credentials: 'include'` on fetches. No plugin required.

**Concrete delta**: `auth-client.ts` today reads `window.location.origin`. Both shells need a build-time `VITE_AUTH_BASE_URL` (pointing at the deployed Worker). For Capacitor, we additionally need the Better Auth Capacitor plugin to turn the cookie flow into a bearer flow.

### 5. Agents SDK WebSocket from a native shell

`useAgent({ agent: 'session-agent', name: agentName })` constructs `wss://<origin>/agents/session-agent/<id>`. In a native shell `window.location.origin` is `capacitor://localhost` or `file://`, neither of which routes to the Worker.

The fix is a hook-level base URL override. The `agents` package supports a `host` option (verify in `node_modules/agents/react`); if absent, wrap `useAgent` in a Duraclaw-local hook that reads from `VITE_WORKER_PUBLIC_URL`. The WebSocket itself is RFC-compliant `ws`/`wss`, which both Electron's Chromium and the Capacitor WebView handle natively — no polyfill.

One nuance: Electron + `file://` cannot open `wss://` without CSP relaxations. The pragmatic answer is to serve the React bundle from a `https://app.duraclaw.local` custom-protocol handler (Electron `protocol.registerFileProtocol` + `protocol.registerSchemesAsPrivileged`) so the bundle runs on an `https:` origin and the WS upgrade is untroubled.

### 6. Backend placement — three architectures

The deep architectural question: **where do the Worker, `SessionDO`, `agent-gateway`, and `session-runner` live for a mobile or desktop user?**

#### A — Cloud-only (thin client, simplest)

- Native shell hosts only the React bundle + local SQLite cache.
- All traffic goes to the deployed CF Worker and the shared VPS gateway, exactly like the web.
- **Mobile is forced into this model** — iOS/Android can't run Bun, can't spawn Claude SDK, can't manage git worktrees. No alternative.
- **Desktop default** — ship the same way, leverage the existing deployment pipeline.

Pros: one backend, one auth story, identical to web. Cons: requires cloud connectivity; users are tenants of the shared VPS.

#### B — Local backend (desktop only, full sovereignty)

- Electron ships `agent-gateway` and `session-runner` as sidecar binaries (`bun build --compile`, matches the pattern in `2026-04-10-unified-packaging-tray-app.md`).
- Either (i) swap `SessionDO` for a local TanStack DB collection (since TanStack DB 0.6 has a **Cloudflare DO adapter** — proof the same persistence API works server-side, so the inverse is tractable) or (ii) run a local Miniflare.
- This is essentially the "desktop tray app" roadmap item from `2026-04-10-unified-packaging-tray-app.md` reframed as an Electron shell.

Pros: fully local, offline-capable, no per-user VPS cost. Cons: much more code, per-OS native builds of `better-sqlite3` + Bun binaries, auth becomes "local only" or needs a decoupled sync server.

#### C — Hybrid (desktop advanced)

- Electron dials the user's own VPS gateway directly (bypass CF Worker's dial-back indirection) while CF Worker still handles auth + history metadata.
- Local SQLite mirrors `SessionDO` content; sync is via TanStack DB's sync engine, not DO direct.

Pros: lower latency on turn ingest; offline reads. Cons: auth token flow is bespoke; two write paths to reconcile; hardest to reason about.

**Recommendation**: Start with **A** for both Capacitor and Electron. Treat **B** as a Phase-2 epic for Electron that reuses the local-SQLite work from Phase-1 but adds an embedded gateway. **C** should be rejected unless a concrete user need materialises.

### 7. Monorepo layout

Minimum-churn layout that keeps the React bundle single-sourced:

```
apps/
  orchestrator/          # unchanged — CF Worker + React UI (current)
  desktop/               # NEW — Electron main + preload; renders orchestrator's React bundle
  mobile/                # NEW — Capacitor shell (ios/ + android/); renders orchestrator's React bundle
packages/
  client-shell/          # NEW — platform-agnostic persister factory + auth/WS base-URL injection
  client-persistence-browser/    # wraps @tanstack/browser-db-sqlite-persistence
  client-persistence-electron/   # wraps @tanstack/node-db-sqlite-persistence (better-sqlite3)
  client-persistence-capacitor/  # wraps @capacitor-community/sqlite bridge
```

`db-instance.ts` becomes:

```ts
import { createPersistence } from '@duraclaw/client-shell'
export const dbReady = createPersistence({ databaseName: 'duraclaw' })
```

with the four implementations resolved by a build-time flag (`VITE_PLATFORM=browser|electron|capacitor`) or by Node conditional exports (`"browser" | "node" | "react-native"` — Capacitor uses `"browser"`, so we need an explicit `"capacitor"` condition via a custom Vite alias).

The two new `apps/*` workspaces are thin shells:

- `apps/desktop/`: `electron/main.ts` spawns a `BrowserWindow`, hosts the orchestrator's built `dist/` via a custom protocol, injects `VITE_AUTH_BASE_URL` + `VITE_WORKER_PUBLIC_URL` as env into the preload.
- `apps/mobile/`: `capacitor.config.ts` + `ios/` + `android/` folders; `webDir` points at orchestrator's `dist/`.

CI story: `turbo build --filter=@duraclaw/desktop` produces DMG/NSIS/deb via `electron-builder`; `turbo build --filter=@duraclaw/mobile` runs `npx cap sync` + platform-native builds (Xcode, Gradle).

### 8. Tanstack DB 0.6 cross-runtime as a unification lever for issue #12

Issue #12 wants to unify the 4-channel client reconciliation on TanStack DB collections. TanStack DB 0.6's **same persistence contract for DO + browser + Electron + Capacitor** means a single logical schema can be projected into every tier. If `SessionDO` itself migrates from its hand-rolled SQLite migrations (`session-do-migrations.ts`) to a TanStack-DB-on-DO collection, the **exact same sync protocol** works client-to-DO across web, desktop, and mobile — removing the WS-only hydration path that `use-coding-agent.ts` currently manages. That is out of scope for the native-port work, but is a strong argument for sequencing: **land #12 first**, then the native shells inherit unified sync for free.

## Risks & open questions

| Risk | Likelihood | Mitigation |
|---|---|---|
| `better-sqlite3` packaging breaks on `electron-builder` per OS (known pain point per [PkgPulse benchmark](https://www.pkgpulse.com/blog/better-sqlite3-vs-libsql-vs-sql-js-sqlite-nodejs-2026)) | Medium | Fallback to `node:sqlite` (Electron 30+ ships Node 22); both satisfy the adapter contract |
| `@tanstack/electron-db-sqlite-persistence` / `@tanstack/capacitor-db-sqlite-persistence` may not yet be published (blog claims coverage but we couldn't enumerate npm pages in search) | High | First impl task is **verify availability**; if absent, fork `@tanstack/node-db-sqlite-persistence` and wire it to `better-sqlite3` ourselves — the persistence contract is <200 LOC per adapter |
| Better Auth cookie on Capacitor without the community plugin | High | Adopt [`better-auth-capacitor`](https://github.com/daveyplate/better-auth-capacitor) v0.3.6+ from day one |
| Agents SDK `useAgent` has no documented `host` override | Medium | Small wrapper hook reading `VITE_WORKER_PUBLIC_URL`; upstream PR if clean |
| OPFS/IndexedDB fallback on Capacitor-web path | Low | Not shipping Capacitor-web; Capacitor always uses the native plugin path on iOS/Android |
| SQLCipher in `@capacitor-community/sqlite` triggers US export-control review | Low | Use the non-encrypted open variant (`openEncrypted: false`); document in compliance |
| `file://` CSP blocks WSS in Electron | Medium | Custom `https://app.localhost` protocol handler (standard Electron pattern) |
| Native CI cost (Xcode on macOS runners, `electron-builder` per OS) | Medium | Scope: ship web first, desktop second, mobile last |

## Recommendation & sequencing

**Phase 1 — Electron desktop shell, cloud-only (Architecture A)**
- New `packages/client-shell` with platform-conditioned persister factory.
- New `packages/client-persistence-electron` using `better-sqlite3` (fallback `node:sqlite`).
- New `apps/desktop/` Electron shell hosting the orchestrator bundle via custom protocol.
- Auth: re-use Worker cookies via Electron's cookie jar; set `VITE_AUTH_BASE_URL` at build time.
- Agents SDK: base-URL-override wrapper hook.
- Estimated: 1–2 weeks; reuses 100% of the React app.

**Phase 2 — Capacitor mobile shell (Architecture A only — no choice)**
- New `packages/client-persistence-capacitor` using `@capacitor-community/sqlite`.
- New `apps/mobile/` with `ios/` + `android/` native projects.
- Auth: adopt `better-auth-capacitor` (bearer-token replay).
- Agents SDK: same wrapper hook as desktop.
- PWA install banner (`use-install-banner.ts`) stays for web; disabled on Capacitor.
- Estimated: 2–3 weeks (Apple provisioning + App Store review dominate).

**Phase 3 (optional) — Electron local backend (Architecture B)**
- Bundle `agent-gateway` + `session-runner` as Bun-compiled sidecars.
- Either port `SessionDO` to TanStack DB on Node, or embed Miniflare.
- Full offline workflow.
- Converges with the tray-app roadmap in `2026-04-10-unified-packaging-tray-app.md`.

**Hard prerequisite**: land or decisively shape **GH#12** first — the native shells want a unified client data layer, not four ad-hoc collections plus a WS-hydrate path. Building native on today's 4-channel reconciliation imports that debt into three platforms.

## Sources

- [TanStack DB 0.6 — Persistence, Offline Support, Hierarchical Data (blog)](https://tanstack.com/blog/tanstack-db-0.6-app-ready-with-persistence-and-includes)
- [Electric apps get persistence and includes with TanStack DB 0.6](https://electric-sql.com/blog/2026/03/25/tanstack-db-0.6-app-ready-with-persistence-and-includes)
- [@tanstack/browser-db-sqlite-persistence on npm](https://www.npmjs.com/package/@tanstack/browser-db-sqlite-persistence)
- [capacitor-community/sqlite (GitHub)](https://github.com/capacitor-community/sqlite)
- [Capawesome — Alternative to the Capacitor Community SQLite plugin](https://capawesome.io/blog/alternative-to-capacitor-community-sqlite-plugin/)
- [better-sqlite3 vs libsql vs sql.js — PkgPulse benchmark, 2026](https://www.pkgpulse.com/blog/better-sqlite3-vs-libsql-vs-sql-js-sqlite-nodejs-2026)
- [electron-vite — C/C++ Addons guide (better-sqlite3 packaging)](https://electron-vite.github.io/guide/cpp-addons)
- [daveyplate/better-auth-capacitor (GitHub)](https://github.com/daveyplate/better-auth-capacitor)
- [Better Auth — Integration with Capacitor (issue #6930)](https://github.com/better-auth/better-auth/issues/6930)
- [OP-Engineering/op-sqlite (GitHub) — React Native only](https://github.com/OP-Engineering/op-sqlite)
- Internal: `apps/orchestrator/src/db/db-instance.ts:34-38` (current persister wiring)
- Internal: `apps/orchestrator/src/db/messages-collection.ts:37-58` (adapter swap point)
- Internal: `apps/orchestrator/src/features/agent-orch/use-coding-agent.ts:284` (useAgent WS base-URL dependency)
- Internal: `apps/orchestrator/src/lib/auth-client.ts:1-14` (`window.location.origin` hardcode)
- Internal: `planning/research/2026-04-10-unified-packaging-tray-app.md` (desktop packaging prior art)
