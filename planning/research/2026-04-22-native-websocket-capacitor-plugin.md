---
date: 2026-04-22
topic: Native WebSocket Capacitor plugin to replace web WS in mobile shell
type: feasibility
status: complete
github_issue: 70
items_researched: 7
---

# Research: Native WebSocket Capacitor plugin for the Duraclaw mobile shell

## Context

The Capacitor 8 Android shell (`apps/mobile`) routes all three client-owned
WebSockets through the WebView's browser `WebSocket`:

- `agent:<agentName>` PartySocket (per-session message stream)
- `user-stream` PartySocket (synced-collection delta fanout)
- `collab:<sessionId>` y-partyserver provider (yjs collaborative state)

This is implicated in GH#69 (derived status shows idle while stream is still
live; mobile refresh reveals missed frames) and more broadly in the pain
points that motivated GH#42 (ConnectionManager + lifecycle-driven reconnect).
This research evaluates whether a native Capacitor plugin — hosting sockets
in an Android `Service` backed by a native HTTP/WS library — can resolve the
class of bugs that web-WS-in-a-WebView produces on Android, and what such a
plugin should look like.

Scope classification: **feasibility study** (Android-only first pass; iOS
out of scope).

## Scope

Seven deep-dives across two axes: **current-state archaeology** in the
Duraclaw repo, and **external tech/policy evaluation** for the native
stack. Each deep-dive was delegated to a parallel Explore agent with the
prompt pinned in this session's transcript.

| # | Item | Fields | Sources |
|---|------|--------|---------|
| 1 | WS landscape in `apps/orchestrator` | library+version, binary semantics, heartbeat, reconnect, auth, consumer, file:line | codebase (Glob/Grep/Read) |
| 2 | Android-native WS stack | OkHttp / Ktor / Java-WebSocket / Scarlet across maintenance, HTTP mode, binary, ping, pinning, proxy, API, size; Doze/Standby/FGS_TYPE/Play policy | developer.android.com, Square OkHttp, Play Console docs |
| 3 | Capacitor 8 plugin architecture | package layout, `@CapacitorPlugin` + `registerPlugin`, bridge binary handling, lifecycle hooks, Service binding, manifest merging, pnpm monorepo integration | capacitorjs.com docs, `@capacitor/*` repos |
| 4 | Existing Capacitor/Cordova WS plugins | candidates × adoption, v8 compat, Android lib, binary, FGS, reconnect, auth, issues, license | npm, GitHub, Capacitor community |
| 5 | Integration points in the shim layer | min WebSocket API surface, consumer × API table, auth path, adapter touch-up, file list | codebase (Glob/Grep/Read) |
| 6 | Battery / FGS policy / Play review surface | FGS_TYPE, permissions, Play policy 2025–2026, prominent-disclosure UX, Doze vs FGS, FCM alternative | developer.android.com, play.google.com policy, industry precedent |
| 7 | Prior art in this repo | #69 root cause, related issues, prior specs/research, ConnectionManager git log, roadmap position, gaps | `planning/`, `git log`, `gh-axi` |

iOS explicitly excluded. Scope decisions ratified via `AskUserQuestion` at
the top of P0 (Android-only; both modes with FG behind opt-in; shim + plugin
API; issue created — #70).

## Findings

### 1 — WS landscape in `apps/orchestrator`

**Three channels** the shim must cover transparently:

| Channel | Library | Wire | Heartbeat | Reconnect | Auth (native) | Consumer |
|---------|---------|------|-----------|-----------|---------------|----------|
| `agent:<agentName>` | PartySocket v1.1.4 | JSON frames | library-internal (`maxRetries: Infinity`, 1–5s exp backoff) | library-managed + ConnectionManager observes via `readyState` | bearer in `?_authToken=…` query param (hoisted to `Authorization` by Worker before routing) | `use-coding-agent.ts` L339–349 via `useAgent()` |
| `user-stream` | PartySocket v1.1.4 | JSON `SyncedCollectionFrame` | library-internal | same as above | per-connect async token fn → `{ _authToken }` | `use-user-stream.ts` L84–109 |
| `collab:<sessionId>` | y-partyserver v2.1.4 (`YProvider`) | **binary** Yjs `Update` frames + JSON Awareness | `sync`/`awareness` events bump `lastSeenTs` | adapter calls `provider.disconnect()` → `provider.connect()` | inherited from parent WS (401 → close 4401) | `use-session-collab.ts` L92–97 |

**ConnectionManager** (`apps/orchestrator/src/lib/connection-manager/`) —
substrate-agnostic registry; `ManagedConnection` interface exposes
`readyState`, `lastSeenTs`, `reconnect()`, `close()`, and DOM event
listeners. Adapters at `adapters/partysocket-adapter.ts:11–48` and
`adapters/yprovider-adapter.ts:19–103` translate library events into a
common DOM-shaped surface. Lifecycle source at `lifecycle.ts:1–158` fires
`foreground|background|online|offline|visible|hidden`; reconnect only
triggered for CLOSED/CLOSING sockets with `lastSeenTs > 5000ms` stale,
with per-conn random stagger ∈ [0, 500) ms.

**Direct `new WebSocket(...)` call sites** (not via PartySocket /
y-partyserver): `packages/shared-transport/src/dial-back-client.ts:121`
(runner-side) and `packages/shared-transport/src/buffered-channel.ts:126–144`
(attaches external WS). **Critical:** DialBackClient uses `ws.onopen = fn`
property-assignment rather than `addEventListener` — the shim must support
both patterns.

**Binary hot path:** `YProvider` sends binary `Update` frames (Yjs wire
protocol). If the plugin base64-encodes on the bridge, every yjs update
pays 3:4 overhead + one encode + one decode. Plugin MUST preserve
`binaryType='arraybuffer'` semantics and not re-encode binary frames that
JS never meaningfully touches.

**Existing native-aware code:**
- `apps/orchestrator/src/lib/platform.ts:33–118` — `isNative()`,
  `wsBaseUrl()`, `installNativeFetchInterceptor()` (injects bearer on
  HTTP).
- `use-user-stream.ts:100–108` — native-only async `query({_authToken})`.
- `use-coding-agent.ts:312–334` — pre-resolve token at mount to avoid
  async-query tight-loop pathology (GH#49).

### 2 — Android-native WS stack

| Library | Status | Transport | Binary | Ping API | Cert pin | Proxy | API | Size | Verdict |
|---------|--------|-----------|--------|----------|----------|-------|-----|------|---------|
| **OkHttp 4.12+** | ✅ Active (Square, 2025+) | HTTP/1.1 upgrade; shared connection pool w/ REST | `ByteString` | `client.pingInterval()` | `CertificatePinner` | System proxy | Callback; verbose | ~200 KB | **PICK** |
| Ktor WebSockets | ✅ Active (JetBrains, 2025+) | HTTP/1.1 (CIO) or HTTP/2 | `ByteArray` | Configurable | Via `HttpClient` | Via `HttpClient` | Coroutines-native | ~300 KB | Close second |
| Java-WebSocket | ❌ Archived 2016 | HTTP/1.1 | `ByteArray` | Manual | Manual | Limited | Legacy callback | ~50 KB | Skip |
| Scarlet (Tinder) | ❌ Archived 2021 | Via OkHttp | Via adapters | Manual/RxJava | Via OkHttp | Via OkHttp | RxJava | ~120 KB | Skip |

**Foreground Service reality check (this is the big finding):**

- Android 15+ caps `FOREGROUND_SERVICE_DATA_SYNC` at **6 hours per 24**
  ([developer.android.com/about/versions/15/changes/datasync-migration](https://developer.android.com/about/versions/15/changes/datasync-migration)).
- `dataSync` is explicitly **not** for user-initiated streams — Google
  recommends `WorkManager` user-initiated-data-transfer jobs.
- `connectedDevice` is semantically for BLE / companion-device WS, not
  cloud sockets — would likely be rejected on Play review.
- `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` is prohibited for most app
  categories on Play ([support.google.com/android/thread/95011040](https://support.google.com/android/thread/95011040)).
- April 2026 policy update further narrowed approved FGS types
  ([support.google.com/googleplay/android-developer/answer/16926792](https://support.google.com/googleplay/android-developer/answer/16926792)).

**Industry precedent is unanimous:** Discord, Telegram, Slack, Signal all
run WebSockets **foreground-only** and delegate background wakeup to
**FCM high-priority push**. None use a persistent FGS. None request
battery optimization exemption.

**Implication for this plugin:** the original "both modes; FG behind
opt-in" scope from the issue should be walked back. Ship
foreground-only + FCM-wake-up as the primary pattern. Leave `persistent`
as explicit future-work if a concrete need emerges.

**`ConnectivityManager.NetworkCallback`** is reliable for
`onAvailable`/`onLost`/`onCapabilitiesChanged` on Android 12+
([developer.android.com/reference/android/net/ConnectivityManager.NetworkCallback](https://developer.android.com/reference/android/net/ConnectivityManager.NetworkCallback));
known VPN / Tailscale / Private-DNS races exist but don't bite our use
case (Tailscale only matters on the VPS side, not the mobile client).

### 3 — Capacitor 8 plugin architecture

**Package layout for `packages/capacitor-native-ws/`:**

```
capacitor-native-ws/
├── android/
│   ├── build.gradle.kts
│   └── src/main/
│       ├── AndroidManifest.xml      # <service>, permissions
│       └── kotlin/com/duraclaw/nativews/
│           ├── NativeWebSocketPlugin.kt   # @CapacitorPlugin
│           ├── NativeWebSocketService.kt  # bound Service
│           └── ConnectionRegistry.kt
├── ios/
│   └── Sources/NativeWebSocketPlugin/     # empty stub
├── src/
│   ├── definitions.ts   # NativeWSPlugin interface
│   ├── index.ts         # registerPlugin<T>('NativeWebSocket')
│   ├── shim.ts          # NativeWebSocketShim (browser-WS-compat)
│   └── web.ts           # WebPlugin fallback (throws or delegates to real WebSocket)
├── package.json  (workspace:* in apps/mobile)
└── tsconfig.json
```

**Plugin config contract** — `package.json` must include
`"capacitor": { "plugins": [{ "name": "NativeWebSocket" }] }`; Kotlin
`@CapacitorPlugin(name="NativeWebSocket")` name must match exactly.

**Bridge binary handling** — `base64 string` is the only first-class
native→JS binary channel. No shared memory, `Blob`, or fd passing. This
is the single biggest perf cost — mitigate via (a) batched
`notifyListeners` for small frames, (b) direct `ArrayBuffer`
reconstruction in the shim so consumers see `MessageEvent.data` as
`ArrayBuffer` per spec.

**Lifecycle hooks** — `load()` survives WebView reload iff the native
plugin class is re-created fresh on reload (it is). A bound Service can
survive reload only with `android:process=":ws"` + AIDL IPC (overkill)
or by being `startService`-started (not bind-only) and holding its own
state. Simpler path: Service dies with WebView; `BufferedChannel` on the
client tolerates the brief gap.

**Service binding pattern** — no canonical example in `@capacitor/*`
official plugins (push-notifications avoids this via FCM). Use
`startService()` + `bindService()` pattern; plugin holds `IBinder`
reference; on `handleOnDestroy`, `unbindService()`.

**Manifest merging** — plugin declares `<service>` + permissions in its
own `AndroidManifest.xml`; Capacitor CLI merges on `cap sync android`.
App manifest wins on duplicate keys; document required permissions in
the plugin README.

**pnpm monorepo** — Capacitor 8 does NOT auto-discover workspace
plugins. `apps/mobile/package.json` must list
`"@duraclaw/capacitor-native-ws": "workspace:*"` explicitly, and
`capacitor.config.ts` must have `plugins: { NativeWebSocket: {} }`.

### 4 — Existing Capacitor/Cordova WS plugins

| Plugin | Last pub | Weekly DL | Android lib | Binary | FGS | Reconnect | Headers | Verdict |
|--------|----------|-----------|-------------|--------|-----|-----------|---------|---------|
| `@miaz/capacitor-websocket` | ~1yr | 27 | NeoVisionaries | undoc | no | undoc | undoc | forkable, but rewrite anyway |
| `@wahr/capacitor-websocket-client` | ~2yr | 0 | undoc | undoc | no | undoc | undoc | abandoned |
| `@nesto-software/capacitor-websocket` | ~1yr | undoc | undoc | undoc | no | undoc | undoc | thin docs, skip |
| `pauldev20/capacitor-websockets` | dead | not on npm | — | — | no | — | — | iOS-only |
| `@capacitor-community/websocket` | **doesn't exist** (RFC #117 open since 2021) | — | — | — | — | — | — | — |

**CapacitorHttp known conflict:** [ionic-team/capacitor#7568](https://github.com/ionic-team/capacitor/issues/7568)
— interferes with WebSocket on Android, HTTP 400 on Socket.IO. Our
plugin must coexist with CapacitorHttp and explicitly route WS traffic
through its own OkHttp client (not shared with CapacitorHttp).

**Verdict: BUILD NEW.** All candidates undocumented on the features we
need (binary, FGS, reconnect, headers). Maintenance vacuum. v8 compat
unverified. Fork-then-rewrite isn't cheaper than greenfield given how
much surgery is needed.

### 5 — Integration points in the shim layer

**Minimum WebSocket shim API surface** — the union of methods/events
actually touched by consumers in this repo:

| Surface | Required | Consumers | Notes |
|---------|:---:|---|---|
| `readyState: number` | ✓ | all | mutable; must match WS constants 0–3 |
| `send(data: string \| ArrayBuffer \| Uint8Array)` | ✓ | PartySocket, YProvider, BufferedChannel | no Blob handling observed |
| `close(code?, reason?)` | ✓ | adapters, manager | must emit `close` event |
| `addEventListener('open'\|'close'\|'error'\|'message', fn)` | ✓ | PartySocket, YProvider, adapters | |
| `removeEventListener(...)` | ✓ | lifecycle cleanup | |
| `onopen` / `onclose` / `onerror` **property setters** | ✓ | **DialBackClient** | non-negotiable; property-assign pattern |
| `binaryType: 'arraybuffer'` | ✓ | YProvider (yjs sets internally) | shim must honor |
| `url: string` | ✓ (read-only) | `attachWsDebug` | for logging only |
| `bufferedAmount` / `protocol` / `extensions` | — | unused | stub/omit |

**Consumer × surface table** (file:line evidence in the WS-landscape
agent report, archived in P0 session transcript):

| Library | `readyState` | `send()` | addEL | removeEL | `close()` | `ws.onX =` |
|---------|:---:|:---:|:---:|:---:|:---:|:---:|
| PartySocket | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| YProvider | ✓ | ✓ | ✓ (via adapter) | ✓ | ✓ | — |
| DialBackClient | ✓ | ✓ | — | — | ✓ | **✓** |
| BufferedChannel | ✓ | ✓ | ✓ | — | — | — |
| `attachWsDebug` | ✓ | — | ✓ | ✓ | — | — |

**Auth delivery mechanism:** query param `?_authToken=…`; Worker
(`apps/orchestrator/src/server.ts:57–61`) hoists it to
`Authorization: Bearer …` before routing to DOs. WebSocket can't send
custom headers cross-origin from a WebView. **The plugin must preserve
this — do not try to "fix" auth by adding a header option that can't
actually work with the current Worker routing.**

**Files needing non-trivial change** (assuming shim replaces
`globalThis.WebSocket` at `entry-client.tsx` before library load):

- `apps/orchestrator/src/entry-client.tsx` — install shim behind `isNative()`.
- `apps/orchestrator/src/lib/platform.ts` — export shim installer.
- (optional) `apps/orchestrator/src/lib/ws-debug.ts` — no change if shim
  matches WS surface; extend if we want native-layer close-reason
  forwarding.

Everything else (PartySocket, y-partyserver, adapters, DialBackClient,
BufferedChannel, ConnectionManager) is untouched.

### 6 — Battery / FGS policy / Play Store review surface

**Concrete recommendation**: **Skip FGS entirely for v1.**

- Primary mode: bound `Service`, foreground-only. WS dies on background.
- Background wakeup: extend the existing FCM wiring (`apps/orchestrator/src/lib/push-fcm.ts`)
  to nudge the app when the server has unconsumed frames.
- `persistent` mode: defer to a future spec if and when real user
  evidence demands it.

Rationale is the stack from deep-dive 2 plus UX:

- **6-hour FGS_DATA_SYNC cap (Android 15+)** makes the original
  "persistent" pitch broken by design for long coding sessions.
- **`connectedDevice`** is semantic mismatch → Play rejection risk.
- **Every comparable app** (Discord, Slack, Telegram, Signal) has
  already solved this via FCM; we get the industry's battle-tested
  pattern for free.
- **Play Console review surface** for a declared FGS type requires
  description + justification + video demo of user-triggered flow
  ([support.google.com/googleplay/android-developer/answer/13392821](https://support.google.com/googleplay/android-developer/answer/13392821));
  not worth the friction until we have evidence users need it.

If we ever ship `persistent`, the likely shape is `shortService` with
user-opt-in renewal (not `dataSync`, not `connectedDevice`). Risk
assessment: 3/5 for `shortService`, 4/5 for `dataSync`, 5/5 for
`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`.

### 7 — Prior art in this repo

**GH#69** root cause per `planning/specs/50-status-ttl.md`:
`lastEventTs` (runner-liveness signal) was in-memory on `SessionDO`;
eviction destroyed it; D1 went stale; client 45s TTL flipped
`running→idle` while runner was live. Fix: persist to D1, rehydrate on
wake, grace period + tripwire.

**GH#42** (`planning/specs/42-connection-manager.md`) already
substrate-agnostic — ManagedConnection interface, registry, lifecycle
events, staggered reconnect. **This spec plugs INTO that, doesn't
replace it.** The native plugin simply provides a more reliable
transport under PartySocket / YProvider; ConnectionManager continues to
coordinate lifecycle.

**`planning/research/2026-04-22-silent-session-closures-post-ttl.md`**
surfaces a critical gap: GH#50 deleted the app-level heartbeat as
redundant post-TTL. But CF Workers' idle-TCP kill still happens, and
`DialBackClient` has no ping/pong. **This spec must restore
protocol-level keepalive** — either via OkHttp `pingInterval` +
`pingTimeoutMs` on the native side, or by guaranteeing an app-level
heartbeat. Without this, native WS regresses to the same silent-close
behavior the research doc describes.

**Related issues / specs:**

| # | Title | Status | Relevance |
|---|-------|--------|-----------|
| 50 | Status TTL + `last_event_ts` persistence | approved, in-progress | Separate spec; orthogonal to this one but must not be re-regressed. |
| 42 | ConnectionManager + lifecycle reconnect | approved, pending impl | **Dependency** — native WS plugs into the existing adapter surface. |
| 26 | Capacitor Android mobile shell | mostly shipped, P5 pending | Establishes `isNative()`, `wsBaseUrl()`, bearer-auth wiring. |
| 49 | use-coding-agent reconnect feedback loop | closed | Informs pre-resolve-token pattern for native. |
| 57 | WS flaps + keepalive | closed | Keepalive was added then removed; this spec restores it at the transport layer. |

**ConnectionManager git log:** `e3bfdee feat(client): ConnectionManager
+ lifecycle-driven WS reconnect (GH#42) (#45)` (2026-04-21), followed by
mobile fixes (`fix(mobile): don't reconnect OPEN sockets`, `fix(mobile):
don't interrupt partysocket retry`). Active investment in mobile WS
reliability is ongoing; this spec is the logical next step.

**Roadmap position (`planning/progress.md`):** GH#42 is "approved
pending impl"; GH#50 is "Spec". Native WS is implied but not a distinct
roadmap item. After this spec lands, file a roadmap entry under Phase
1.3 Mobile Chat.

## Comparison matrix — the pivotal tech decisions

| Decision | Option A | Option B | Pick | Rationale |
|----------|----------|----------|------|-----------|
| Android WS library | OkHttp 4.12+ | Ktor | **OkHttp** | Shared REST pool, `CertificatePinner`, de facto, smaller footprint. |
| Service model | Bound Service, FG-only | Foreground Service | **Bound FG-only** | Play policy; 6h FGS cap; industry precedent. |
| Background wakeup | Persistent FGS | FCM high-priority | **FCM** | Zero Play friction; battery-friendly; existing wiring. |
| Shim shape | Shim only | Shim + plugin API | **Shim + plugin API** | PartySocket/y-partyserver zero-touch + diagnostics/pinning escape hatch. |
| Existing plugin reuse | Fork `@miaz` | Build new | **Build new** | No functional gap closure from any candidate; fork+rewrite ≈ greenfield. |
| Binary bridge | Base64 everything | Skip base64 for yjs Updates | **Base64 + ArrayBuffer reconstruction in shim** | No shared-mem option in Capacitor v8; mitigate with batched notify. |
| Auth | Bearer header | `?_authToken=` query param | **Query param (preserve)** | WebView WS can't send custom headers cross-origin; Worker already hoists to header server-side. |
| Keepalive | App-level heartbeat | Protocol `pingInterval` | **Both — OkHttp ping + optional app heartbeat** | CF Workers idle-TCP kill; restore regression from GH#50. |

## Recommendations

1. **Build `@duraclaw/capacitor-native-ws`** in `packages/capacitor-native-ws/`,
   Android-only for v1. OkHttp 4.12+ backed, bound-Service, foreground-only.
2. **Ship as shim + plugin API.** Shim swaps `globalThis.WebSocket` under
   `isNative()` — zero-touch for PartySocket, y-partyserver, DialBackClient,
   BufferedChannel. Plugin API exposes cert pinning, diagnostics ring-buffer,
   `networkChange` event.
3. **Preserve query-param auth.** Do not try to "upgrade" to header auth;
   the Worker routing depends on `_authToken` being query-string-visible.
4. **Restore protocol-level keepalive via OkHttp `pingInterval`.** Defense in
   depth against CF Workers' idle-TCP kill. Do not reintroduce the full
   app-level heartbeat that GH#50 removed unless load-test shows OkHttp
   ping insufficient.
5. **Skip FGS for v1.** Bind to the existing FCM pipeline for background
   wakeup. File a separate spec for `persistent` mode if user evidence
   demands it later.
6. **Depends on GH#42 implementation landing.** The ConnectionManager
   adapters are the integration surface; don't spec around a moving target.

## Open questions

1. **OkHttp `pingInterval` / `pingTimeoutMs` concrete values.** 30s / 90s
   is a defensible starting pair, but should be benchmarked against CF
   Workers' actual idle-TCP kill window (GH#57 research had empirical
   numbers — re-run against current production).
2. **ConnectionManager adapter scope.** Does the shim-only approach suffice
   (PartySocket adapter unchanged), or do we need a `native-ws-adapter.ts`
   for diagnostics/pinning? Lean toward "shim only"; revisit if
   diagnostics need DO-side visibility.
3. **`ws.onopen` property-assignment shim compat.** DialBackClient uses it;
   the shim class must define enumerable setters for `onopen` / `onclose` /
   `onerror` / `onmessage` that internally `addEventListener` (and unregister
   the prior one). Implementation detail but easy to miss.
4. **FCM wake-up scope for this spec.** In-scope (one-paragraph handshake +
   background-state handler), or explicitly defer to a separate "background
   streaming" spec? Recommend defer; this spec is transport-only.
5. **Build pipeline interaction with GH#26 P5.** `apps/mobile/scripts/build-android.sh`
   already exists and Capacitor auto-syncs workspace plugins on
   `pnpm cap sync android`. Verify no additional infra work needed.

## Next steps

1. **P1 interview** — resolve the 5 open questions with the user.
2. **P2 spec** under `planning/specs/70-native-websocket-capacitor-plugin.md`
   with 4 phases:
   - **Phase A** — plugin scaffold, OkHttp bound Service, shim w/ minimum
     API surface, `isNative()` wiring in `entry-client.tsx`.
   - **Phase B** — `ConnectivityManager.NetworkCallback`, OkHttp ping /
     pong, native-side replay buffer for the WebView-reload gap.
   - **Phase C** — ConnectionManager adapter integration, diagnostics
     exposure (`window.__nativeWs` in DEV, logcat prefix `Capacitor/NativeWs`).
   - **Phase D** — APK build, adb device test matrix (screen-off,
     Wi-Fi↔LTE handoff, WebView reload, Doze), verification plan.
3. **P3 review** — against Play policy checklist, keepalive regression
   coverage (`silent-session-closures-post-ttl` risk list), and the GH#69
   symptom matrix.
4. **Roadmap hook** — on P4 close, add entry under `planning/progress.md`
   Phase 1.3 Mobile Chat.
