# CLAUDE.md — Duraclaw

## Project Overview

Duraclaw orchestrates Claude Code sessions across multiple VPS worktrees. A Cloudflare Workers frontend (orchestrator) owns session lifecycle via Durable Objects, and a VPS-side `agent-gateway` spawns per-session `session-runner` processes that each own one Claude Agent SDK query and dial the DO directly.

## Architecture

```
Browser
  │
  ▼
CF Worker (TanStack Start) ─── React UI + API routes
  │
  ▼
SessionDO (1 per session) ─── state + SQLite message history
  ▲          │
  │          │ HTTPS POST /sessions/start
  │          ▼
  │      ┌─ agent-gateway (VPS, systemd) ─ spawn/list/status/reap
  │      │            │
  │      │            │ spawn detached, passes callback_url + token
  │      │            ▼
  │      └── session-runner (per session) ── owns Claude SDK query()
  │                   │                      uses BufferedChannel ring (10K/50MB)
  └───────────────────┘
         dial-back WSS — direct to DO, reconnects with 1/3/9/27/30s backoff
```

Key invariants:
- `agent-gateway` never runs the SDK. It's a spawn/list/reap control plane.
- `session-runner` never embeds the DO. It dials `CC_GATEWAY_URL`'s partner `WORKER_PUBLIC_URL` (`wss://dura…/agents/session-agent/<do-id>?role=gateway&token=…`).
- Gateway restart / CF Worker redeploy are non-events for an in-flight runner; the BufferedChannel buffers while the WS is down, replays on reconnect, emits a single gap sentinel only on overflow.
- Session status derives from `messagesCollection` via `useDerivedStatus`; D1 `agent_sessions` is the idle/background fallback, not a truth-gate.

### Client data flow (session live state)

**Spec #31 unified sync channel** — `messagesCollection` is the sole live
source of per-session status and gate. The DO suppresses the Agents SDK's
built-in state broadcast (`shouldSendProtocolMessages() => false`); the
`SessionState` blob type is deleted. Hooks `useDerivedStatus(sessionId)`
and `useDerivedGate(sessionId)` fold over `messagesCollection` to surface
the active status / pending gate for any consumer. The DO persists its
own typed `SessionMeta` in a `session_meta` SQLite table (migration v6+v7)
and restores it on rehydrate via `hydrateMetaFromSql()` — no more reliance
on the Agents SDK `setState` JSON blob surviving eviction.

The browser has three render sources for per-session state, all TanStack DB
collections (OPFS-persisted, reactive via `useLiveQuery`):

1. `sessionsCollection` — per-session summary (`project`, `model`,
   `numTurns`, `totalCostUsd`, `durationMs`, `contextUsage`, `kataState`,
   `worktreeInfo`, `messageSeq`, and `status`). D1-mirrored via
   `broadcastSessionRow`. Session status derives from
   `useDerivedStatus(sessionId) ?? session?.status` — the hook folds
   over `messagesCollection` and uses `messageSeq` as a tiebreaker to
   detect stale D1 cache. The transient `sessionLocalCollection` carries
   only `{id, wsReadyState, wsCloseTs}` (memory-only, no persistence).
2. `messagesCollection` — per-session message history, one collection per
   agentName (memoised by `createMessagesCollection`). Query-backed with a
   REST fallback (`GET /api/sessions/:id/messages`) for cold-start and
   reconnect-with-stale-cache; WS is the live push channel. This is also
   the authoritative source for derived status / gate (see above).
3. `branchInfoCollection` — per-session branch siblings for rewind /
   resubmit / navigate. Populated by DO-pushed snapshots alongside
   messages; the `useBranchInfo` hook drives the branch arrows in the UI.

**Seq'd `{type:'messages'}` wire protocol** (GH#14 B1–B3): the SessionDO
stamps every broadcast with a per-session monotonic `seq`. The client
tracks `lastSeq` per agentName in a ref. `kind:'delta'` frames whose
`seq === lastSeq + 1` apply directly (upsert / delete on `messagesCollection`
plus any `branchInfo` upserts piggybacked on the frame). Out-of-order or
gap-detected frames trigger a `requestSnapshot()` RPC to the DO. The
server replies with `kind:'snapshot'` (reason: `reconnect` / `rewind` /
`resubmit` / `branch-navigate`) carrying the full linear history plus
refreshed branchInfo rows; the snapshot handler replaces the collection
contents for that session and resets `lastSeq`.

**DO-authored snapshots** — rewind / resubmit / branch-navigate are
computed server-side via `session.getHistory(leafId)` and pushed to every
connected client as a `kind:'snapshot'` frame. The client RPCs
(`rewind`, `resubmitMessage`, `getBranchHistory`) fire-and-await; no
client-side history mutation, no per-tab divergence.

**Optimistic user turns** (GH#14 B5–B6) use
`createTransaction({mutationFn})` with client-generated
`usr-client-<uuid>` ids. The DO accepts the client id as the primary
`SessionMessage.id`, so the server echo reconciles via TanStack DB
deep-equality — a single row that updates in place, no delete+insert
churn and no client-side sort hints.

Display derivation goes through
`deriveDisplayStateFromStatus(status, wsReadyState)` in
`apps/orchestrator/src/lib/display-state.ts` so StatusBar, sidebar cards,
and the tab bar all agree on label / color / icon. `status` is typically
`useDerivedStatus(sessionId) ?? live.status` at the call site, which lets
active sessions track message-derived status while idle / background
sessions fall back to the D1-mirrored top-level field.

### Client connection manager (GH#42)

`apps/orchestrator/src/lib/connection-manager/` holds a cross-cutting
coordinator for every client-owned WS (`agent:<agentName>` PartySocket,
`user-stream` PartySocket, `collab:<sessionId>` y-partyserver provider).
Substrate-agnostic `ManagedConnection` adapters (`adapters/partysocket-adapter.ts`
+ `adapters/yprovider-adapter.ts`) plug into a module-level
`connectionRegistry`. A singleton `connectionManager` (started once from
`routes/__root.tsx`) subscribes to `lifecycleEventSource` — Capacitor
`App.appStateChange` + `Network.networkStatusChange` behind `isNative()`,
plus browser `visibilitychange` / `online` / `offline` — and on every
`foreground` or `online` event iterates the registry and schedules a
`conn.reconnect()` with a per-conn random stagger ∈ [0, 500) ms for any
conn whose `lastSeenTs` is >5 s stale. `useConnectionStatus()` folds
`readyState` across every registered conn into a unified `isOnline` signal
that drives the `OfflineBanner` (with a 1 s show-debounce). Replaces the
prior `use-app-lifecycle.ts` hook — foreground → `hydrate()` is now
triggered by the agent adapter's post-reconnect `open` event inside
`use-coding-agent.ts` (gated by `hasConnectedOnce` to skip the initial
connect). `@capacitor/app` / `@capacitor/network` are dynamically
imported behind `isNative()` so the web bundle excludes them. In DEV,
`window.__connectionRegistry` + `window.__connectionManager` (with a
`lastReconnectLog` ring buffer) are exposed for `scripts/axi eval`.

### Synced collections (user-scoped reactive data)

`createSyncedCollection` at `apps/orchestrator/src/db/synced-collection.ts`
is the canonical factory for user-scoped TanStack DB collections. It wraps
`queryCollectionOptions` and installs a custom `SyncConfig.sync` so the
synced layer is driven by WS delta frames from `UserSettingsDO` instead of
polling. Four collections ride on it today: `user_tabs`,
`user_preferences`, `projects`, `chains`.

**Two-layer model — don't conflate them:**

- **Optimistic layer** — user-initiated writes via `onInsert / onUpdate /
  onDelete` handlers (`mutationFn` POSTs the REST endpoint, rolls back on
  throw). Lives in TanStack DB's `optimisticUpserts` / `optimisticDeletes`
  maps and disappears when the write settles.
- **Synced layer** — authoritative state from D1. Populated cold by
  `queryFn` (initial load + reconnect resync) and kept hot by WS delta
  frames dispatched through `begin / write / commit` on
  `SyncConfig.sync`'s params. The server echo of the user's own write
  reconciles via TanStack DB's `deepEquals` loopback guard — no
  watermark, no tombstone, no client-side dedup.

**Wire protocol** — `SyncedCollectionFrame` in
`packages/shared-types/src/index.ts`. Discriminated union, no optional
`value` / `key` fields:

```typescript
type SyncedCollectionOp<TRow> =
  | { type: 'insert'; value: TRow }
  | { type: 'update'; value: TRow }
  | { type: 'delete'; key: string }

interface SyncedCollectionFrame<TRow> {
  type: 'synced-collection-delta'
  collection: string
  ops: Array<SyncedCollectionOp<TRow>>
}
```

**Fanout path** — API writes call `broadcastSyncedDelta(env, userId,
collection, ops)` (`apps/orchestrator/src/lib/broadcast-synced-delta.ts`)
wrapped in `ctx.waitUntil`. The helper POSTs `/broadcast` on the user's
`UserSettingsDO` with `Authorization: Bearer ${SYNC_BROADCAST_SECRET}`.
The DO validates the frame shape, iterates its socket set (hibernation-
aware — rehydrated from `this.ctx.getWebSockets()` on init), and
broadcasts the JSON payload. 256 KiB cap enforced; use `chunkOps()` in
`apps/orchestrator/src/lib/chunk-frame.ts` for bulk syncs.

**Cross-user fanout** (projects) — `/api/gateway/projects/sync`
reconciles D1 then queries `SELECT user_id FROM user_presence` (the
active-user index, maintained by `UserSettingsDO`'s ref-counted
connect/disconnect 0↔1 transitions) and fans out via
`Promise.allSettled` so one dead DO doesn't abort the rest.

**Reconnect semantics** (B7) — the hook's `onUserStreamReconnect`
handler calls `queryClient.invalidateQueries({queryKey})` on every
registered collection, which triggers `queryFn` re-fetch through the
query-collection layer. In-flight optimistic mutations settle via their
own mutationFn resolution (success → deep-equal reconcile, throw →
rollback). The "optimistic delete reappears because mutationFn threw
offline" path is explicitly accepted behavior, not a bug.

**Secrets** — `SYNC_BROADCAST_SECRET` (worker → DO) and
`CC_GATEWAY_SECRET` (gateway → worker) rotate independently.

## Monorepo Structure

```
apps/
  orchestrator/          # CF Workers + TanStack Start (React 19, Vite 7)
  mobile/                # Capacitor 8 Android shell (thin client, GH#26)
packages/
  agent-gateway/         # VPS control plane (Bun HTTP server, systemd)
  session-runner/        # Per-session SDK owner (spawned by gateway)
  shared-transport/      # BufferedChannel + DialBackClient (runner → DO WS)
  shared-types/          # GatewayCommand / GatewayEvent / SessionSummary types
  ai-elements/           # Shared UI component library
  kata/                  # Workflow management CLI
planning/
  spec-templates/        # Feature, bug, epic spec templates
```

## Tech Stack

- **Runtime**: TypeScript 5.8, React 19, Vite 7
- **Monorepo**: pnpm workspaces + Turbo
- **Orchestrator**: Cloudflare Workers, Durable Objects (Agents SDK v0.7), TanStack Start
- **Auth**: Better Auth with D1 (Drizzle adapter)
- **Gateway**: Bun HTTP server — spawn/list/status/reap only
- **Session-runner**: Bun-executable that wraps `@anthropic-ai/claude-agent-sdk` and dials the DO via `shared-transport`
- **Linting**: Biome (spaces, no semicolons, single quotes in biome-managed files)

## Key Commands

```bash
pnpm build              # Build all packages (tsup for workspace libs)
pnpm typecheck          # Typecheck all packages
pnpm test               # Run vitest suites across the workspace
pnpm dev                # Dev mode (all packages)

# Orchestrator
cd apps/orchestrator
pnpm dev                # Local dev (Vite + miniflare)
pnpm ship               # Build + wrangler deploy (do NOT run manually — see Deployment)

# Gateway (local)
cd packages/agent-gateway
bun run src/server.ts   # Starts on 127.0.0.1:$CC_GATEWAY_PORT (default 9877)

# Session-runner binary build
pnpm --filter @duraclaw/session-runner build   # Emits dist/main.js with #!/usr/bin/env bun shebang
```

## New Worktree Setup

Clone and bootstrap a new dev worktree in one shot:

```bash
cd /data/projects
git clone git@github.com:baseplane-ai/duraclaw.git duraclaw-dev4
cd duraclaw-dev4
scripts/setup-clone.sh --from /data/projects/duraclaw/.env
```

Or manually:

```bash
cp .env.example .env        # fill in CC_GATEWAY_API_TOKEN + BOOTSTRAP_TOKEN
scripts/verify/dev-up.sh    # generates .dev.vars, starts gateway + orchestrator
```

**Port derivation** — each worktree auto-derives a unique set of ports from
its absolute path via `cksum % 800`. No manual allocation needed — any new
clone Just Works.

| Worktree | Orch | Gateway | CDP-A | CDP-B | Bridge-A | Bridge-B | Axi |
|----------|------|---------|-------|-------|----------|----------|-----|
| duraclaw | 43307 | 10107 | 11307 | 12307 | 13307 | 14307 | 15307 |
| duraclaw-dev1 | 43054 | 9854 | 11054 | 12054 | 13054 | 14054 | 15054 |
| duraclaw-dev2 | 43613 | 10413 | 11613 | 12613 | 13613 | 14613 | 15613 |
| duraclaw-dev3 | 43537 | 10337 | 11537 | 12537 | 13537 | 14537 | 15537 |

Port ranges (all non-overlapping):

| Range | Purpose |
|-------|---------|
| 9800–10599 | Gateway |
| 11000–11799 | Browser A CDP (dual-browser) |
| 12000–12799 | Browser B CDP (dual-browser) |
| 13000–13799 | AXI-A bridge (dual-browser) |
| 14000–14799 | AXI-B bridge (dual-browser) |
| 15000–15799 | AXI bridge (single-browser via `scripts/axi`) |
| 43000–43799 | Orchestrator |

**Rules:**
- Never set `CC_GATEWAY_PORT` in `.env` — it collides across worktrees. Use `VERIFY_GATEWAY_PORT` to override.
- `.dev.vars` is generated — never hand-edit. Override via `.env` + `dev-up.sh`.
- `.env` is gitignored. `.env.example` is the canonical template.
- Use `scripts/axi` (not raw `chrome-devtools-axi`) so browser sessions are isolated per worktree.

## Packages

### apps/orchestrator (CF Workers)

- **Durable Objects**: `SessionDO` (1 per session, owns state + SQLite message history + `active_callback_token` for runner auth), `ProjectRegistry` (singleton, worktree locks + session index), `UserSettingsDO`
- **Auth**: Better Auth with D1 via Drizzle. Per-request auth instance (D1 only available in request context). Login at `/login`, API at `/api/auth/*`
- **Environment** (wrangler secrets): `CC_GATEWAY_URL` (http(s) URL to gateway), `CC_GATEWAY_SECRET` (bearer matched by gateway), `WORKER_PUBLIC_URL` (wss base the runner uses to dial the DO), `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`
- **D1 Database**: `duraclaw-auth`
- **Entry point**: `src/server.ts` exports DO classes + TanStack Start default handler

### apps/mobile (Capacitor 8 Android shell)

- **Thin client** — wraps the orchestrator React bundle as a sandboxed `capacitor://localhost` WebView that talks to the deployed Worker over HTTPS / WSS. No local server in the APK.
- **Native swaps**: OPFS sqlite → `@capacitor-community/sqlite`; cookie auth → `better-auth-capacitor` bearer; Web Push → FCM HTTP v1 via `jose`-signed JWT (`apps/orchestrator/src/lib/push-fcm.ts`); WS host overridden via `useAgent({ host: wsBaseUrl() })`.
- **Platform gating** lives in `apps/orchestrator/src/lib/platform.ts` — `isNative()` keys off `import.meta.env.VITE_PLATFORM === 'capacitor'`, dead-code-eliminated from the web bundle by Vite. Native imports (`@capacitor/*`) are dynamic so they're tree-shaken from the web build.
- **Build** — `pnpm --filter @duraclaw/mobile build:android` runs `apps/mobile/scripts/build-android.sh` (env load → vite build → cap sync → gradle assembleRelease). Sign with `apps/mobile/scripts/sign-android.sh` (KEYSTORE_PATH/PASS/KEY_ALIAS/KEY_PASS env vars).
- **Toolchain pins** — JDK 21, Android SDK platform 36, build-tools 36.0.0. See `apps/mobile/README.md` for full prerequisites, FCM provisioning, dev-keystore generation, and source map.
- **Spec**: `planning/specs/26-capacitor-android-mobile-shell.md`. GitHub: issue #26, PR #29.

#### OTA auto-update (Capgo web bundle + self-hosted APK fallback)

Two update channels so we don't have to reinstall the APK for every JS
change:

1. **Web-bundle OTA via `@capgo/capacitor-updater`** — covers 95% of
   releases. `initMobileUpdater()` in
   `apps/orchestrator/src/lib/mobile-updater.ts` is called from
   `entry-client.tsx` on every native launch. It:
   - calls `CapacitorUpdater.notifyAppReady()` so Capgo doesn't
     auto-rollback the current bundle;
   - POSTs `{platform, version_name: VITE_APP_VERSION}` to
     `/api/mobile/updates/manifest`;
   - if the Worker reports a newer version, `download()`s the zip and
     `set()`s it — the WebView reloads into the new bundle on next
     mount.

2. **Native-APK fallback** — fires only when native-layer code changes
   (Capacitor / plugin bump). `checkNativeApkUpdate()` polls
   `GET /api/mobile/apk/latest`, compares to `App.getInfo().version`,
   and on mismatch `window.confirm()`s the user. On accept, navigates
   the WebView to the APK URL; Android's download manager + the
   `REQUEST_INSTALL_PACKAGES` permission hand off to the package
   installer. Once-per-version dedupe via `localStorage` key
   `duraclaw.apk-prompt.dismissed-version`.

**Version source** — `VITE_APP_VERSION` is stamped into the bundle by
`apps/mobile/scripts/build-android.sh` as `git rev-parse --short HEAD`
(override via `APP_VERSION=…`). After `cap sync` (so the zip doesn't
double-bundle into the APK) the same script runs
`scripts/build-mobile-ota-bundle.sh`, which stages a copy of
`dist/client` with `/mobile/` excluded, zips it, writes a local copy at
`apps/orchestrator/dist/client/mobile/bundle-<sha>.zip` for inspection,
and writes `version.json` (`{version, key}`) alongside. The infra
deploy pipeline then uploads both to the `duraclaw-mobile` R2 bucket:

- `ota/bundle-<sha>.zip` — the Capgo-consumable web-bundle payload.
- `ota/version.json` — `{version, key}` read by the Worker's
  `/api/mobile/updates/manifest` route via
  `env.MOBILE_ASSETS.get('ota/version.json')`.

The manifest route returns
`${origin}/api/mobile/assets/ota/bundle-<sha>.zip` — a same-origin
Worker URL that streams the R2 object back through
`GET /api/mobile/assets/*` (no R2 public-domain / pre-signed URLs).

Local builds skip the R2 upload (infra handles that). The
zip is still written locally so you can poke at it. Infra
misconfig (missing upload step) is the "OTA channel is dead" failure mode.

**APK-fallback counterpart** — the infra pipeline uploads a signed
release APK to `apk/duraclaw-<version>.apk` and writes
`apk/version.json` (`{version, key}`) alongside in the same R2 bucket.
The `GET /api/mobile/apk/latest` route reads the R2 manifest. This
step is **only** wired for native-layer bumps (Capacitor / plugin
bump); it is NOT run on every OTA release. Route returns
`{message: "No APK available"}` when `apk/version.json` is absent from
R2.

**Both manifest routes are public** (registered BEFORE `authMiddleware`
in `apps/orchestrator/src/api/index.ts`) so an expired-session user can
still update to the current build. The `MOBILE_ASSETS` R2 binding is
declared optional in the `Env` type — workers deployed without the
bucket bound (older environments, tests) degrade to "no update
available" instead of 500'ing.

**APK signing** — `apps/mobile/scripts/sign-android.sh` wraps
`apksigner` and requires `KEYSTORE_PATH`, `KEYSTORE_PASS`, `KEY_ALIAS`,
`KEY_PASS`. The keystore and signing credentials live on the infra
server (same box that runs the deploy pipeline); they are never needed
in dev worktrees. Production keystore lives in the 1Password
Engineering vault; inject via CI secret bindings, never commit.

#### Sideloading to the Pixel over wireless ADB (Tailscale)

The dev Pixel (`46211FDAQ00534`) is reachable from the VPS via Tailscale
at `100.113.109.57`. Pairing record is persisted under `~/.android/`
(`adbkey`, `adb_known_hosts.pb`) — **re-pairing is almost never needed**,
only the `connect` port changes.

Toolchain on this VPS:

- `adb` binary: `/home/ubuntu/Android/sdk/platform-tools/adb`
  (not on `$PATH` by default — `export PATH="/home/ubuntu/Android/sdk/platform-tools:$PATH"`)
- adb server is typically already running on `:5037` from a prior session
- Package id: `com.baseplane.duraclaw`

Standard install flow:

```bash
export PATH="/home/ubuntu/Android/sdk/platform-tools:$PATH"
adb connect 100.113.109.57:<PORT>     # PORT rotates each WiFi-debug toggle — ask the user
adb devices                            # confirm <IP>:<PORT>   device
adb -s 100.113.109.57:<PORT> install -r \
  apps/mobile/android/app/build/outputs/apk/release/app-release-signed.apk
adb -s 100.113.109.57:<PORT> shell monkey -p com.baseplane.duraclaw \
  -c android.intent.category.LAUNCHER 1
```

Gotchas:

- **Port rotation**: Android cycles the Wireless-debugging port every
  toggle and on idle-drop. If `adb connect` says `Connection refused`,
  the pairing is still good — ask the user to open
  **Settings → System → Developer options → Wireless debugging** and
  read the current `IP address & Port`. No re-pair needed.
- **mDNS is not forwarded across Tailscale**, so `adb mdns services`
  won't discover the phone from the VPS — always `connect` by explicit
  `IP:PORT`.
- **`INSTALL_FAILED_UPDATE_INCOMPATIBLE`** means the signing key differs
  from an installed build — `adb uninstall com.baseplane.duraclaw` then
  retry. Debug-signed and release-signed APKs collide this way.
- **Project `grep` alias** on this box is `rg` and rejects `-E`; use
  `/usr/bin/grep -E` when parsing `dumpsys package` / `pm list packages`
  output.

#### Tailing WebView console to logcat (connection thrash triage)

Capacitor's `android.loggingBehavior: 'production'` (set in
`apps/mobile/capacitor.config.ts`) routes WebView `console.*` output to
logcat in release APKs — without it, signed builds silently swallow
every client-side log. Tag is `Capacitor/Console`. Relevant prefixes
emitted by the client:

- `[cm] reconnect …` — ConnectionManager scheduled a reconnect
  (reason: `foreground` / `online` / `manual`, with `lastSeenMs`).
- `[cm-lifecycle] <event>` — `foreground` / `background` / `online` /
  `offline` / `visible` / `hidden` fan-out from Capacitor +
  `window`/`document` listeners.
- `[ws:<channel>] open|close|error …` — per-socket lifecycle from
  `attachWsDebug`. Channels include `session:<agentName>`,
  `user-stream`, and `collab:<sessionId>`. Close events carry
  `code`, `reason`, `wasClean`, `uptime`, and the full `url`.

Standard filter (live-tail, triage stuck-connecting / thrash):

```bash
export PATH="/home/ubuntu/Android/sdk/platform-tools:$PATH"
adb -s 100.113.109.57:<PORT> logcat -c        # clear backlog
adb -s 100.113.109.57:<PORT> logcat "*:S" \
  Capacitor/Console:V Capacitor:V chromium:V
```

Keep `chromium:V` in the filter so you also catch native-layer WebView
errors (cert chain, WS handshake failures) that don't go through
`console.*`. To widen when hunting a non-obvious cause, drop the `*:S`
silencer and pipe through `/usr/bin/grep -E 'cm|ws:|Capacitor|chromium'`.

### packages/agent-gateway (VPS control plane)

- **Not the SDK host anymore** — that moved to `session-runner`. Gateway just spawns detached runners and exposes HTTP endpoints for the DO.
- **HTTP endpoints**: `POST /sessions/start` (spawn detached runner), `GET /sessions` (list all known), `GET /sessions/:id/status` (exit > pid+live > pid+dead > 404), `GET /health` (no auth), `POST /debug/reap` (dev-only, behind `DURACLAW_DEBUG_ENDPOINTS=1`), plus project-browsing endpoints for UI/debug.
- **Auth**: Bearer token; timing-safe compare. Open if `CC_GATEWAY_API_TOKEN` not set.
- **Session files** under `$SESSIONS_DIR` (default `/run/duraclaw/sessions`, tmpfs, `0700`): `{id}.cmd` (gateway writes, runner reads), `{id}.pid` (runner writes), `{id}.meta.json` (runner writes every 10s), `{id}.exit` (single-writer via `link`+EEXIST), `{id}.log` (gateway-opened stdout/stderr).
- **Reaper**: 5-minute interval + startup pass. Stale (>30min since `last_activity_ts`) → SIGTERM → 10s grace → SIGKILL → markedCrashed. `.cmd` orphans >5min unlinked; terminal files >1h past `.exit` mtime GC'd together with `.log`.
- **Observability**: on each reaper pass logs `[gateway] inflight=N <id:pid/seq/age/idle>` and on each spawn logs `[gateway] /sessions/start sessionId=… execute project=… worktree=…`.
- **Systemd**: `duraclaw-agent-gateway.service` requires `KillMode=process` + `SendSIGKILL=no` + `RuntimeDirectoryPreserve=yes` so restarts don't sweep the detached runner cgroup and `/run/duraclaw/sessions` survives. Install via `./packages/agent-gateway/systemd/install.sh`.

### packages/session-runner (per-session SDK owner)

- One process per session. Spawned detached by gateway with 7 positional argv: `sessionId cmdFile callback_url bearer pidFile exitFile metaFile`.
- Writes `.pid` at startup, reads `.cmd`, dials the DO via `DialBackClient` (from `shared-transport`), then runs `query()` / `query({resume:sdk_session_id})` from `@anthropic-ai/claude-agent-sdk`.
- Emits `session.init` / `partial_assistant` (from `stream_event.content_block_delta.text_delta` and `thinking_delta`) / `assistant` / `tool_result` / `result` / etc. via the channel, assigning monotonic `ctx.nextSeq` to every event.
- Stays alive across turns — after `type=result` it blocks on `queue.waitForNext()` for the next `stream-input` from the DO.
- Exits cleanly on: SDK abort, SIGTERM (2s watchdog), or DialBackClient terminal (`4401 invalid_token`, `4410 token_rotated`, or post-connect reconnect cap exhausted).

### packages/shared-transport

- **`BufferedChannel`**: ring buffer (10K events / 50MB) that sends directly when the WS is attached and queues otherwise. On overflow drops oldest and emits a single `{type:'gap',dropped_count,from_seq,to_seq}` sentinel on next replay.
- **`DialBackClient`**: WS client that dials `callbackUrl?token=<bearer>`, exposes `send()` / `onCommand()`, reconnects with `[1s, 3s, 9s, 27s, 30s×]` backoff. Resets `attempt` after 10s of stable connection. Terminates (fires `onTerminate`) on close codes `4401` / `4410` or after 20 post-connect failures without stability.

### packages/kata (Workflow CLI)

- Full source lives in `packages/kata/` (migrated from external `kata-wm` repo).
  Not published to npm — clone-and-run-from-source via Bun.
- 8 modes: planning, implementation, research, task, debug, verify, freeform, onboard
- Phase tracking, stop condition gates, session persistence
- Run via `kata enter <mode>`
- **CLI**: `src/index.ts` has `#!/usr/bin/env bun` shebang — runs TypeScript
  directly, no build step. `scripts/link-kata.sh` creates `~/.local/bin/kata`
  symlink + runs `bun install`. Called automatically by `setup-clone.sh`.
- Dependencies: `js-yaml`, `zod` (runtime); `bun` (execution)

## Session lifecycle & resume

1. **New session** — browser calls DO `spawn()` → DO `triggerGatewayDial({type:'execute', …})` → `POST /sessions/start` → gateway spawns detached runner → runner dials DO at `wss://…/agents/session-agent/<do-id>?role=gateway&token=…` → DO validates token (timing-safe) against `active_callback_token` → accept → SDK runs → events stream.
2. **Follow-up message, runner still connected** (normal path) — `sendMessage` sees `getGatewayConnectionId()` → sends `stream-input` over existing WS → runner's command queue wakes the multi-turn loop. No re-spawn.
3. **Follow-up after >30min idle** — reaper has killed the runner; DO state is `idle` with persisted `sdk_session_id`. `sendMessage` falls through to `triggerGatewayDial({type:'resume', sdk_session_id})` → new runner, SDK `resume` reads the on-disk transcript (`@anthropic-ai/claude-agent-sdk` session file in the project dir).
4. **Orphan case** — runner alive on VPS but unreachable from DO. `sendMessage` preflights `GET /sessions` on the gateway, finds the orphan by `sdk_session_id`, auto-delegates to `forkWithHistory(content)`: the DO serialises local history as `<prior_conversation>…</prior_conversation>`, drops `sdk_session_id` (forces a fresh one — no `hasLiveResume` collision), and spawns a new `execute` with the transcript-prefixed prompt. User-visible UX is a normal send.
5. **Rate-limit → caam rotation** (GH#92) — when the SDK emits a `rate_limit_event` and caam is configured, the runner derives a cooldown window from `rate_limit_info.resetsAt`, parks the active profile via `caam cooldown set claude/<active> --minutes N`, activates `caam next claude` (peer-detection gated — see D4 single-active-runner assumption), and exits with `.exit {state:'rate_limited', rotation:{from, to}, exit_code:0}`. The DO sees the `rate_limit` event, inserts a system-role breadcrumb into `messagesCollection` with `metadata.caam = {kind:'rotated', from, to, at}`, sets `SessionMeta.pendingResume = {kind:'rotation', at: now+1s}` (persisted to `session_meta.pending_resume_json`, migration v17), and schedules a DO alarm. When the alarm fires, the DO calls `triggerGatewayDial({type:'resume', sdk_session_id})` exactly once and clears `pendingResume`. When no profile is available (every profile cooling), the session transitions to `'waiting_profile'` and resumes at `earliest_clear_ts + 30s`. When peer-detection trips (another live claude runner), the session exits `rate_limited_no_rotate` → `'error'` with no auto-resume; the user must send a fresh message to retry. The `metadata.caam` breadcrumbs render in the transcript but are filtered out of `forkWithHistory`'s SDK resume-prompt serializer so the model never replays them as conversation turns. See `planning/research/2026-04-24-caam-auth-rotation-gh92.md` for the VPS prerequisites and dev injection endpoints.

The orphan case is self-healing from the runner side too: on close code `4401`/`4410` from the DO, the runner aborts and exits rather than squatting on the sdk_session_id.

## VPS Communication Protocol

Transport: runner → DO over wss, and gateway → DO via HTTP only (spawn/status). Shapes live in `packages/shared-types/src/index.ts`.

**GatewayCommand** (DO → runner, over dial-back WS):
- `stream-input` — inject a user turn into the live SDK query
- `interrupt`, `rewind`, `get-context-usage` — mid-session controls
- `resolve-gate` — answer to `ask_user` / `permission_request`

**GatewayEvent** (runner → DO, over dial-back WS):
- `session.init`, `partial_assistant` (streaming text / reasoning deltas), `assistant` (finalised turn), `tool_use_summary`, `tool_result`, `ask_user`, `permission_request`, `task_started`/`progress`/`notification`, `rate_limit`, `result`, `heartbeat`, `error`

Every event is stamped with a monotonic `seq` by the runner's BufferedChannel so the DO can detect and act on gap sentinels.

## Deployment

All deploys are handled by the infra server — pushing to `main` on `origin` triggers the pipeline that builds and ships both the orchestrator (CF Workers) and the agent-gateway (systemd on VPS). Do not run `pnpm ship`, `wrangler deploy`, or the gateway install script manually.

**Infra-pipeline contract for mobile OTA** — the pipeline must (a)
build the orchestrator with `VITE_APP_VERSION` stamped in, and (b)
run `scripts/build-mobile-ota-bundle.sh` with `CLOUDFLARE_API_TOKEN` +
`CLOUDFLARE_ACCOUNT_ID` in-env so the script uploads the zip + the
`ota/version.json` pointer to the `duraclaw-mobile` R2 bucket. The
Worker's `/api/mobile/updates/manifest` route then reads from R2 and
hands Capgo a same-origin URL that streams the bundle through
`GET /api/mobile/assets/*`. Without step (b) the OTA channel is dead —
every native shell polls, sees no newer version, and stays on the
bundle the APK shipped with.

```bash
export APP_VERSION=$(git rev-parse --short HEAD)
VITE_APP_VERSION="$APP_VERSION" \
  pnpm --filter @duraclaw/orchestrator build
bash scripts/build-mobile-ota-bundle.sh   # emits zip + version.json locally
# Infra pipeline uploads the zip + version.json to R2 (duraclaw-mobile bucket)
# and then deploys the Worker. Without the upload step the OTA channel is dead.
wrangler deploy --cwd apps/orchestrator
```

## Progress Tracking

- **Roadmap:** `planning/specs/roadmap-v2-full-vision.md` — full vision with all detail
- **Progress:** `planning/progress.md` — phase/subphase status tracker
- **Specs:** `planning/specs/` — individual feature specs (linked from progress tracker)

## UI Testing

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

### Dual browser profiles (multi-user verification)

`chrome-devtools-axi` wraps a single persistent Chrome — `CHROME_DEVTOOLS_AXI_USER_DATA_DIR`
on a second call is ignored because the first Chrome holds the profile lock.
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
Headed mode via `BROWSER_HEADED=1 scripts/verify/browser-dual-up.sh`.

**Ergonomic multi-user helpers** (prefer these over raw `axi-a` / `axi-b`
whenever both users are involved):

```bash
# One-shot: launch both Chromes, seed both accounts, log each in.
scripts/verify/axi-dual-login.sh

# Log one browser in as a specific user (idempotent — no-op if already
# signed in; falls back to sign-up if the user doesn't exist yet).
scripts/verify/axi-login a                      # default $VERIFY_USER_A_*
scripts/verify/axi-login b alt@example.com pw   # override email/password

# Run the same axi command against both browsers in parallel, with
# [A] / [B] prefixed output.
scripts/verify/axi-both snapshot
scripts/verify/axi-both eval 'location.pathname'
```

Defaults come from `scripts/verify/common.sh`:

- User A: `agent.verify+a@example.com` / `duraclaw-test-password-a`
- User B: `agent.verify+b@example.com` / `duraclaw-test-password-b`

Override via `VERIFY_USER_A_EMAIL`, `VERIFY_USER_A_PASSWORD`,
`VERIFY_USER_B_EMAIL`, `VERIFY_USER_B_PASSWORD` if you need different
credentials. Sign-in uses Better Auth's `/api/auth/sign-in/email` called
from inside the page context (via `axi eval`), so the Set-Cookie lands in
the Chrome profile directly — no fragile snapshot-ref scraping.

### Verify-mode local stack

`scripts/verify/dev-up.sh` starts a local orchestrator (miniflare) and
local agent-gateway for the current worktree — each on **worktree-derived
ports** so parallel worktrees don't collide. The offset comes from
`cksum($VERIFY_ROOT) % 800`, giving every checkout a stable slot across
7 non-overlapping port ranges (see port table in "New Worktree Setup")
without manual allocation.

`scripts/verify/common.sh`:

- Derives `VERIFY_ORCH_PORT` and `CC_GATEWAY_PORT` from the worktree path.
- `VERIFY_GATEWAY_PORT` (NOT `CC_GATEWAY_PORT`) is the override knob —
  `CC_GATEWAY_PORT` is commonly exported by the prod/main-worktree shell
  profile at `9877`, and letting that leak into a peer worktree hijacks
  gateway dispatch. The wrapper always **re-exports** `CC_GATEWAY_PORT`
  from the derived/overridden value so the spawned gateway binds the
  right port no matter what the parent shell shipped.
- `sync_dev_vars()` regenerates `apps/orchestrator/.dev.vars` every
  `dev-up.sh` run — `BETTER_AUTH_URL`, `CC_GATEWAY_URL`,
  `CC_GATEWAY_SECRET`, `WORKER_PUBLIC_URL`, and (if present in `.env`)
  `BOOTSTRAP_TOKEN`. Pre-existing keys like `BETTER_AUTH_SECRET` /
  `VAPID_*` are preserved. `.dev.vars` is a generated artifact — don't
  hand-edit, override via `$VERIFY_ROOT/.env` instead.

Expected generated `.dev.vars` shape (ports auto-derived):

```
BETTER_AUTH_URL=http://127.0.0.1:<orch>
CC_GATEWAY_URL=ws://127.0.0.1:<gateway>
CC_GATEWAY_SECRET=<from .env>
WORKER_PUBLIC_URL=http://127.0.0.1:<orch>
BOOTSTRAP_TOKEN=<from .env, optional — enables /api/bootstrap seeding>
```

Missing `WORKER_PUBLIC_URL` causes the classic "message lands in history,
no assistant turn" silent-fail (GH#8). `sendMessage` now preflights this
and returns an explicit error instead of persisting into limbo — if you see
`Gateway not configured for this worker`, fill in `.dev.vars`.

**Dual-browser bridge isolation** (`axi-a` / `axi-b`):
All browser ports (CDP, bridge) and profile/state dirs are per-worktree
isolated via `common.sh` — see port table in "New Worktree Setup". Each
wrapper gets its own `$HOME` (`/tmp/duraclaw-axi-{a,b}-<worktree>`) so
`chrome-devtools-axi`'s bridge PID file doesn't clobber the peer's, even
across concurrent worktree verify sessions.

**User seeding**: `/api/auth/sign-up/email` is disabled by default. Use
the token-protected `/api/bootstrap` endpoint (enabled when
`BOOTSTRAP_TOKEN` is present in `.dev.vars`) to seed the `+a` and `+b`
users in a fresh worktree:

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
every git repo under `/data/projects/`. If you set them, ensure the prefix
covers the worktree you'll dispatch into — the runner logs a verbose miss
line (`[session-runner] project miss: name=...`) when filtered out.

### Portless mode (stable subdomains, multi-worktree-safe)

Direct-port mode (`dev-up.sh`) already derives per-worktree ports, but
portless mode offers stable `.localhost` subdomains as an alternative —
useful when URLs need to be constant across restarts or shared in config.

One-time setup:

```bash
npm install -g portless         # global CLI
portless proxy start            # prompts sudo once (binds 443, trusts CA)
portless hosts sync             # adds *.localhost entries to /etc/hosts
```

Then per-session:

```bash
scripts/verify/portless-up.sh       # launches both under portless
scripts/verify/portless-down.sh     # teardown
```

Subdomain contract:

- Orchestrator: `https://duraclaw-orch.localhost`
- Gateway:      `https://duraclaw-gw.localhost` (WS: `wss://duraclaw-gw.localhost`)

`.dev.vars` in portless mode:

```
BETTER_AUTH_URL=https://duraclaw-orch.localhost
CC_GATEWAY_URL=wss://duraclaw-gw.localhost
WORKER_PUBLIC_URL=https://duraclaw-orch.localhost
CC_GATEWAY_SECRET=<unchanged>
```

The gateway honours portless's injected `PORT` env var (see
`packages/agent-gateway/src/server.ts` — `PORT ?? CC_GATEWAY_PORT ?? 9877`),
so no service-side changes are needed to opt in.

Both scripts write `VERIFY_*` runtime URLs into the shared verify state
file so the existing `scripts/verify/*.sh` suite continues to work against
the portless URLs without modification.

Design rationale and Phase-3 follow-up (assistant-visible runner errors)
in `planning/research/2026-04-18-verify-infra-issue-8.md`.

## Conventions

- Commit messages: `type(scope): description` (feat, fix, chore, refactor, docs, test)
- Biome formatting: 2-space indent, 100 char line width, LF endings
- Path alias: `~/` maps to `./src/` in orchestrator
- Git workflow — **scope determines whether a PR is involved**, not habit.
  Always commit and push to **the currently checked-out branch** on
  `origin` (github.com/baseplane-ai/duraclaw); never switch branches to
  push elsewhere. Respect whatever branch the human/session left you on.
  - **Task-scoped work** (task / debug / freeform mode, small fixes,
    docs, chores, quick refactors): commit directly to `main` and push.
    No branch, no PR. CI runs remotely after push. Do NOT open a PR for
    task-scoped work — stale PRs pile up when commits have already
    landed on `main` directly, and they have to be closed manually.
  - **Feature-scoped work** (implementation mode off an approved spec,
    multi-commit epics, anything that needs review before landing): work
    on a feature branch (`feature/<issue>-...`, `feat/...`, `fix/...`),
    push to that branch, open a PR, and land via a proper merge (squash
    or merge-commit). Never push a feature branch's commits to `main`
    out-of-band while its PR is open — that strands the PR as
    superseded-but-not-closed, which is exactly the stale-PR failure
    mode this rule exists to prevent. If a rebase has rewritten branch
    history, push with `--force-with-lease` (never plain `--force`).
  - If you're unsure which bucket a change falls into, ask before
    opening a PR. A PR that duplicates commits already on `main` is
    worse than no PR.
