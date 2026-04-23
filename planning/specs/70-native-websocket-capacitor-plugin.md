---
initiative: native-websocket
type: project
issue_type: feature
status: approved
priority: medium
github_issue: 70
created: 2026-04-22
updated: 2026-04-23
phases:
  - id: p1a
    name: "Plugin scaffold — native + bridge + shim"
    tasks:
      - "Scaffold packages/capacitor-native-ws/ — package.json (workspace), tsconfig, android/build.gradle.kts, ios/ empty stub"
      - "Write NativeWebSocketPlugin.kt — @CapacitorPlugin with connect/send/close @PluginMethods + notifyListeners for open/message/close/error; ALL WebSocketListener callbacks marshaled to main thread via Handler(Looper.getMainLooper()).post {}; connect() gated on CountDownLatch until onServiceConnected fires (see B1 service binding note)"
      - "Write NativeWebSocketService.kt — bound Service hosting OkHttp WebSocket instances keyed by caller-assigned id; single shared OkHttpClient with pingInterval(30, SECONDS); baseline logcat under tag Capacitor/NativeWs for open/close/error events (structured logging expanded in P2)"
      - "Write ConnectionRegistry.kt — thread-safe ConcurrentHashMap<id, ManagedSocket> with bindService lifecycle; duplicate id replaces existing socket with 1001 'replaced'"
      - "Write src/definitions.ts — NativeWSPlugin interface (connect/send/close/addListener/removeAllListeners)"
      - "Write src/index.ts — registerPlugin<NativeWSPlugin>('NativeWebSocket')"
      - "Write src/web.ts — WebPlugin fallback that delegates to real browser WebSocket"
      - "Write src/shim.ts — NativeWebSocketShim with: pending-event queue (drains on readyState→OPEN or first addEventListener), property-setter descriptors for on{open,close,error,message}, listener handle storage + cleanup on close, binaryType support"
      - "Declare <service android:name='.NativeWebSocketService' /> and INTERNET permission in plugin AndroidManifest.xml"
      - "pnpm build for the plugin package; unit tests for shim (property-setter compat, pending-event queue drain, listener cleanup on close, base64 round-trip)"
      - "Implementation order within P1a: ConnectionRegistry.kt → NativeWebSocketService.kt → NativeWebSocketPlugin.kt → definitions.ts → index.ts → web.ts → shim.ts → AndroidManifest.xml → unit tests"
    test_cases:
      - "pnpm build succeeds for @duraclaw/capacitor-native-ws"
      - "Unit test: construct NativeWebSocketShim, assign ws.onopen = fn, trigger open → fn called"
      - "Unit test: pending-event queue — open event arrives before addEventListener, drain occurs on first addEventListener('open', fn) call"
      - "Unit test: close() calls .remove() on all 4 PluginListenerHandles; no leaked listeners after N reconnect cycles; double-close is idempotent"
      - "Unit test: base64 round-trip — ArrayBuffer → base64 → ArrayBuffer yields identical bytes"
      - "Unit test: send() on CONNECTING socket throws DOMException('WebSocket is not open', 'InvalidStateError')"
      - "Unit test: constructor normalizes string protocols to [string]"
      - "Kotlin test (Robolectric or JUnit): ConnectionRegistry add/replace/remove; duplicate id closes existing with 1001"
  - id: p1b
    name: "globalThis.WebSocket swap + signed APK integration"
    tasks:
      - "Export installNativeWebSocket() from platform.ts — swaps globalThis.WebSocket = NativeWebSocketShim when isNative()"
      - "Call installNativeWebSocket() in entry-client.tsx after installNativeFetchInterceptor() and before any library loads"
      - "Add @duraclaw/capacitor-native-ws as workspace:* dep in apps/mobile/package.json"
      - "Add NativeWebSocket: {} to plugins in apps/mobile/capacitor.config.ts"
      - "Build signed release APK; verify app launches and all three WS channels connect via logcat"
    test_cases:
      - "cap sync android succeeds without manifest merge conflicts"
      - "Signed release APK: login, open a session, send a message — agent responds (proves agent:* + user-stream WS work)"
      - "logcat tag Capacitor/NativeWs shows [open] events for all active channels"
      - "Verify binaryType='arraybuffer' is honored — collab:* yjs sync completes without errors"
      - "Verify DialBackClient property-setter pattern works end-to-end on device"
  - id: p2
    name: "NetworkCallback + OkHttp ping + diagnostics"
    tasks:
      - "Register ConnectivityManager.NetworkCallback in NativeWebSocketService — emit networkChange event to JS on onAvailable/onLost/onCapabilitiesChanged"
      - "On OkHttp onFailure (SocketTimeoutException from missed pong), emit close event with code 1006 + reason 'ping timeout'; log to Capacitor/NativeWs"
      - "Add logcat logging under tag Capacitor/NativeWs for open/close/error/networkChange with socket id, url, uptime, close code/reason"
      - "Expose window.__nativeWs in DEV builds — { connections: Array<{id, url, readyState, lastSeenTs}>, recentCloses: RingBuffer<10>, reconnectLog: RingBuffer<10> }"
      - "Guard DEV exposure with import.meta.env.DEV so production bundles dead-code-eliminate it"
      - "Wire lifecycleEventSource (the install() function inside the module-level lifecycleEventSource object in connection-manager/lifecycle.ts) to consume networkChange events from the plugin on native (replace or augment @capacitor/network)"
    test_cases:
      - "Screen-off 30s+ on Pixel: socket stays connected (OkHttp ping keeps it alive)"
      - "Wi-Fi toggle on emulator: networkChange event fires, ConnectionManager triggers reconnect"
      - "window.__nativeWs populated in DEV build with correct connection entries"
      - "Ping timeout scenario: enable airplane mode for >35s, verify close event fires with code 1006"
  - id: p3
    name: "Signed-release verification + roadmap update"
    tasks:
      - "Build signed release APK with full P1+P2 code"
      - "Install on Pixel via wireless adb"
      - "Execute screen-off-30s must-pass gate"
      - "Informally validate: Wi-Fi→LTE handoff, WebView reload, GH#69 derived-status check"
      - "Record logcat evidence for each scenario"
      - "Update planning/progress.md — add GH#70 under Phase 1.3 Mobile Chat"
      - "Update GH#70 issue with verification results"
    test_cases:
      - "Must-pass: screen-off 30s+ → socket stays connected on signed release APK on Pixel"
      - "Informal: Wi-Fi disable → LTE reconnect < 5s"
      - "Informal: window.location.reload() → session re-hydrates, no frame loss visible"
      - "Informal: GH#69 scenario — mobile refresh does not reveal missed frames or flip derived status"
---

# Native WebSocket Capacitor Plugin

## Overview

The Capacitor 8 Android shell routes all three client-owned WebSockets
(`agent:*` PartySocket, `user-stream` PartySocket, `collab:*` y-partyserver
YProvider) through the WebView's browser `WebSocket`. This is unreliable on
Android: JS timers throttle under Doze / App Standby, the WebView has no
link-layer network-change signal (`ConnectivityManager.NetworkCallback`),
sockets die on WebView reload, and binary yjs frames round-trip through JS
unnecessarily. This spec delivers `@duraclaw/capacitor-native-ws` — a
Capacitor plugin that hosts sockets in an Android bound `Service` backed by
OkHttp 4.12+, with a browser-`WebSocket`-compatible shim that swaps
`globalThis.WebSocket` under `isNative()` for zero-touch compatibility with
PartySocket, y-partyserver, DialBackClient, and BufferedChannel.

## Feature Behaviors

### B1: Plugin scaffold and OkHttp bound Service

**Core:**
- **ID:** `plugin-scaffold`
- **Trigger:** `cap sync android` after adding `@duraclaw/capacitor-native-ws` as a `workspace:*` dependency in `apps/mobile/package.json` and declaring `NativeWebSocket: {}` in `capacitor.config.ts` plugins.
- **Expected:** Plugin registers as `NativeWebSocket` in the Capacitor plugin registry. Kotlin `NativeWebSocketService` binds on first `connect()` call and hosts OkHttp `WebSocket` instances keyed by caller-assigned `id`. Service runs in the same process as the WebView (no `android:process`). Service unbinds and sockets close when the Activity is destroyed or WebView reloads.
- **Verify:** `adb logcat -s Capacitor/NativeWs` shows `[open] id=agent:session-agent url=wss://…` on session start. `pnpm build` for the plugin package succeeds. `cap sync android` merges manifests without conflict.
**Source:** new package `packages/capacitor-native-ws/`

#### Native Layer (Kotlin)

**NativeWebSocketPlugin.kt** — `@CapacitorPlugin(name = "NativeWebSocket")`:
- `@PluginMethod connect(call: PluginCall)` — extracts `id`, `url`, `protocols?` from call data. Delegates to `NativeWebSocketService.open(id, url, protocols)`. Returns success. Ping interval is service-level (30s), not per-socket configurable.
- `@PluginMethod send(call: PluginCall)` — extracts `id`, `text?`, `binary?` (base64). Delegates to service. Binary decoded via `Base64.decode()` → `ByteString`.
- `@PluginMethod close(call: PluginCall)` — extracts `id`, `code?`, `reason?`. Delegates to service.
- Service binding: `load()` calls `bindService()` only (no `startService` — we want the service to die on unbind so sockets close when the Activity is destroyed or WebView reloads). `handleOnDestroy()` calls `unbindService()`. Since the service was only bound (not started), Android destroys it on last unbind, which triggers `NativeWebSocketService.onDestroy()` → close all sockets.
- **Async bind race:** `bindService()` is async — `ServiceConnection.onServiceConnected()` fires later. If `connect()` is called before the service is bound (plausible on cold start — `installNativeWebSocket()` runs in `entry-client.tsx` and PartySocket connects immediately), the plugin must gate on the bind. Use a `CountDownLatch(1)` in the plugin: `connect()` calls `latch.await(5, SECONDS)` before delegating to service. `onServiceConnected` calls `latch.countDown()`. Timeout produces an error event to JS (not a crash). This ensures the first `connect()` call blocks briefly on cold start but subsequent calls proceed immediately.
- **Thread marshaling:** ALL `WebSocketListener` callbacks (`onOpen`, `onMessage`, `onClosing`, `onClosed`, `onFailure`) fire on OkHttp's dispatcher thread. Every `notifyListeners()` call MUST be wrapped in `Handler(Looper.getMainLooper()).post { ... }` because Capacitor's bridge evaluates JS via `WebView.evaluateJavascript()` which is main-thread-only. This applies to ALL callbacks, not just `onFailure`.

**NativeWebSocketService.kt** — `Service()` with `IBinder`:
- Holds `ConnectionRegistry` — `ConcurrentHashMap<String, ManagedSocket>` where `ManagedSocket` wraps `okhttp3.WebSocket` + metadata (`url`, `openedAt`, `lastMessageTs`, `readyState`).
- `open(id, url, protocols)` — if `id` already exists in the registry, close the existing socket with `1001 "replaced"` before creating the new one. Uses the shared `OkHttpClient` (configured with `pingInterval(30, SECONDS)` at service creation), creates `Request` from `url` (with `protocols` as `Sec-WebSocket-Protocol` header), calls `client.newWebSocket(request, listener)`. OkHttp handles ping/pong internally — no RTT is exposed (OkHttp's `WebSocketListener` has no `onPong` callback; ping/pong is opaque, see [OkHttp #6146](https://github.com/square/okhttp/issues/6146)). The effective timeout is ~30s (one missed pong triggers `onFailure`), not configurable independently of `pingInterval`. When `protocols` has multiple entries, they are sent as a single comma-separated `Sec-WebSocket-Protocol` header value per RFC 6455 section 4.1: `protocols.joinToString(", ")`.
- `WebSocketListener` callbacks → `notifyListeners()` on the plugin (ALL wrapped in `Handler(Looper.getMainLooper()).post { ... }`):
  - `onOpen` → `notifyListeners("open", JSObject().put("id", id))`
  - `onMessage(text)` → `notifyListeners("message", JSObject().put("id", id).put("text", text))`
  - `onMessage(bytes)` → `notifyListeners("message", JSObject().put("id", id).put("binary", bytes.base64()))`
  - `onClosing(code, reason)` → complete the handshake by calling `webSocket.close(code, reason)`. Do NOT emit a JS event — wait for `onClosed`.
  - `onClosed(code, reason)` → `notifyListeners("close", JSObject().put("id", id).put("code", code).put("reason", reason).put("wasClean", true))`. Remove from registry.
  - `onFailure` → `notifyListeners("error", JSObject().put("id", id).put("message", t.message))` then `notifyListeners("close", JSObject().put("id", id).put("code", 1006).put("reason", t.message ?: "abnormal closure").put("wasClean", false))`. Remove from registry.
  **Important:** Only `onClosed` and `onFailure` emit the JS `close` event — never `onClosing`. Emitting from both would cause PartySocket to trigger two overlapping reconnect cycles.
- Single shared `OkHttpClient` instance across all sockets (connection pool reuse).
- `onDestroy()` iterates registry, closes all sockets with `1001 "going away"`.

**AndroidManifest.xml** (plugin):
```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <uses-permission android:name="android.permission.INTERNET" />
  <application>
    <service android:name=".NativeWebSocketService" />
  </application>
</manifest>
```

#### TypeScript Layer

**src/definitions.ts:**
```typescript
export interface NativeWSPlugin {
  connect(opts: {
    id: string
    url: string
    protocols?: string[]
    tlsPinning?: { sha256: string[] }  // reserved for future use; v1 ignores
  }): Promise<void>
  send(opts: { id: string; text?: string; binary?: string }): Promise<void>
  close(opts: { id: string; code?: number; reason?: string }): Promise<void>
  addListener(event: 'open', cb: (data: { id: string }) => void): Promise<PluginListenerHandle>
  addListener(event: 'message', cb: (data: { id: string; text?: string; binary?: string }) => void): Promise<PluginListenerHandle>
  addListener(event: 'close', cb: (data: { id: string; code: number; reason: string; wasClean: boolean }) => void): Promise<PluginListenerHandle>
  addListener(event: 'error', cb: (data: { id: string; message: string }) => void): Promise<PluginListenerHandle>
  addListener(event: 'networkChange', cb: (data: { online: boolean; transport: string }) => void): Promise<PluginListenerHandle>
  removeAllListeners(): Promise<void>
}
```

Ping interval (30s) is a service-level constant — not configurable per-socket (OkHttp's `pingInterval` is per-`OkHttpClient`, and all sockets share one client). The effective timeout on a missed pong is ~30s (the next ping cycle), not independently configurable. See B3 for details.

**src/web.ts** — `WebPlugin` fallback: all methods throw `'NativeWebSocket is not available on web'`. The shim detects this at install time and falls back to the real `WebSocket`.

---

### B2: Browser-WebSocket-compatible shim

**Core:**
- **ID:** `ws-shim`
- **Trigger:** `installNativeWebSocket()` called from `entry-client.tsx` after `installNativeFetchInterceptor()` and before any library (PartySocket, y-partyserver) instantiates a `WebSocket`.
- **Expected:** On `isNative() === true`, `globalThis.WebSocket` is replaced with `NativeWebSocketShim`. On `isNative() === false` or if the native plugin fails to load, the original `WebSocket` is preserved (graceful fallback with a `console.warn`). All existing consumers (PartySocket v1.1.4, y-partyserver v2.1.4, DialBackClient, BufferedChannel, `attachWsDebug`) work without modification.
- **Verify:** On a Capacitor build, `new WebSocket('wss://...')` routes through the native plugin. On web, `globalThis.WebSocket` is untouched. PartySocket connects; YProvider syncs yjs docs; DialBackClient's `ws.onopen = fn` fires.
**Source:** new file `packages/capacitor-native-ws/src/shim.ts`, modified `apps/orchestrator/src/lib/platform.ts`, modified `apps/orchestrator/src/entry-client.tsx`

#### Shim API Surface

The shim class `NativeWebSocketShim` implements the subset of the browser `WebSocket` interface actually consumed in this repo:

| Surface | Implementation | Consumer |
|---------|---------------|----------|
| `constructor(url, protocols?)` | Normalizes `protocols`: if `string`, wraps in `[protocols]` (browser `WebSocket` accepts both `string` and `string[]`). Calls `NativeWebSocket.connect({ id: uuid(), url, protocols })`. Stores `id`. Sets `readyState = WebSocket.CONNECTING`. Registers 4 native listeners (open/message/close/error) filtered by `id`. Stores `PluginListenerHandle` promises for cleanup. Initializes pending-event queue. | all |
| `readyState: number` | Getter backed by internal state. Updated on open → `OPEN`, close → `CLOSED`. Constants: `CONNECTING=0`, `OPEN=1`, `CLOSING=2`, `CLOSED=3` exposed as static + instance props. | all |
| `url: string` | Read-only, set in constructor. | `attachWsDebug` |
| `binaryType: BinaryType` | Settable. When `'arraybuffer'`, binary `message` events deliver `ArrayBuffer`. When `'blob'` (default per spec), deliver `Blob`. | YProvider sets `'arraybuffer'` internally |
| `send(data: string \| ArrayBuffer \| Uint8Array)` | Throws `DOMException('WebSocket is not open', 'InvalidStateError')` if `readyState !== OPEN` (matching browser behavior). `string` → `NativeWebSocket.send({ id, text: data })`. `ArrayBuffer`/`Uint8Array` → base64-encode → `NativeWebSocket.send({ id, binary })`. | PartySocket, YProvider, BufferedChannel |
| `close(code?, reason?)` | Sets `readyState = CLOSING`. Calls `NativeWebSocket.close({ id, code, reason })`. | adapters, ConnectionManager |
| `addEventListener(type, fn)` | Internal `EventTarget`-like map. Types: `'open'`, `'close'`, `'error'`, `'message'`. Options parameter (`{ once, capture }`) is NOT supported in v1 — only `(type, fn)` signature. PartySocket v1.1.4 does not use `once` on the inner WebSocket. | PartySocket, adapters, `attachWsDebug` |
| `removeEventListener(type, fn)` | Removes from map. | lifecycle cleanup |
| `onopen` / `onclose` / `onerror` / `onmessage` | **Property setters** — each setter stores the callback and internally registers/unregisters via the event map. Must support `ws.onopen = fn` assignment pattern. | **DialBackClient** (critical — uses property assignment, not `addEventListener`) |
| `bufferedAmount` | Stub: returns `0`. | unused |
| `protocol` | Stub: returns `''`. | unused |
| `extensions` | Stub: returns `''`. | unused |

**Event dispatch from native listener callbacks:**

The shim registers four `NativeWebSocket.addListener()` handlers at construction time, filtered by `id`:

- `'open'` → `readyState = OPEN`, drain pending-event queue, dispatch `new Event('open')`, fire `this.onopen?.(event)`.
- `'message'` → if `data.binary`, decode base64 to `ArrayBuffer` (or `Blob` per `binaryType`), else use `data.text`. Dispatch `new MessageEvent('message', { data })`. Fire `this.onmessage?.(event)`.
- `'close'` → `readyState = CLOSED`, dispatch `new CloseEvent('close', { code, reason, wasClean })`, fire `this.onclose?.(event)`. **Clean up listeners:** call `.remove()` on all 4 stored `PluginListenerHandle`s (awaited from construction). This prevents listener leak across reconnect cycles.
- `'error'` → dispatch `new Event('error')`, fire `this.onerror?.(event)`.

**Pending-event queue (race condition mitigation):**

`NativeWebSocket.addListener()` is async (returns `Promise<PluginListenerHandle>`), but the constructor cannot `await`. On a fast native bridge, the Kotlin `onOpen` callback may fire before the JS listener is registered. The shim MUST buffer events that arrive before the async listener setup completes:

- **Data structure:** `_pendingEvents: Array<{ type: string, data: any }>`, max depth 32 (sufficient for the open + initial message burst).
- **Queue phase:** Active from construction until all 4 `addListener` promises resolve. During this phase, native callbacks push to `_pendingEvents` instead of dispatching.
- **Drain trigger:** When all 4 listener promises settle (via `Promise.all`), drain `_pendingEvents` in order through the normal dispatch path. Set `_listenersReady = true` so future events dispatch immediately.
- **Overflow:** If queue exceeds 32 entries before listeners are ready (should never happen — bridge is local), drop oldest and log `console.warn('[native-ws] pending event queue overflow')`.

**Listener handle lifecycle:**

Each shim instance stores `_listenerHandles: Promise<PluginListenerHandle>[]` (length 4). On `close()` or `'close'` event:
1. Await each handle.
2. Call `handle.remove()` on each.
3. Null out references.

This prevents orphaned listeners from accumulating across PartySocket's reconnect cycle (each reconnect creates a new shim instance → new listeners → old listeners must be removed).

**Idempotency:** `_cleanupListeners()` is called from both `close()` (user-initiated) and the `'close'` event handler. It MUST be idempotent — guard with `if (this._listenerHandles.length === 0) return` to prevent double-removal.

**Fallback logic in `installNativeWebSocket()`:**

```typescript
export function installNativeWebSocket(): void {
  if (!isNative()) return
  try {
    // Probe: if plugin isn't loaded, this throws
    const probe = NativeWebSocket // registerPlugin result
    if (!probe?.connect) {
      console.warn('[native-ws] Plugin not available, keeping browser WebSocket')
      return
    }
    const OriginalWebSocket = globalThis.WebSocket
    globalThis.WebSocket = NativeWebSocketShim as any
    // Preserve constants on the constructor
    ;(globalThis.WebSocket as any).CONNECTING = 0
    ;(globalThis.WebSocket as any).OPEN = 1
    ;(globalThis.WebSocket as any).CLOSING = 2
    ;(globalThis.WebSocket as any).CLOSED = 3
    console.info('[native-ws] Installed NativeWebSocketShim')
  } catch (e) {
    console.warn('[native-ws] Failed to install shim, falling back to browser WebSocket', e)
  }
}
```

---

### B3: OkHttp WS-level keepalive (ping/pong)

**Core:**
- **ID:** `okhttp-keepalive`
- **Trigger:** The shared `OkHttpClient` in `NativeWebSocketService` is configured with `pingInterval(30, TimeUnit.SECONDS)` at service creation time. All sockets inherit this interval.
- **Expected:** OkHttp sends WS-protocol ping frames every 30s. Ping/pong is handled internally by OkHttp and is **opaque to consumers** — there is no `onPong` callback in `WebSocketListener` ([OkHttp #6146](https://github.com/square/okhttp/issues/6146)). If a pong is not received before the next ping is due (~30s), OkHttp triggers `onFailure` with a `SocketTimeoutException`. The shim emits a `close` event with `code: 1006, reason: 'ping timeout', wasClean: false`. This defeats CF Workers' idle-TCP kill (~60s observed in GH#57) without any application-level heartbeat. The effective timeout on network loss is ~30s (one missed pong), not configurable independently of `pingInterval`.
- **Verify:** With an active session idle for 2+ minutes, socket stays `OPEN` (no `[close]` events in logcat). After enabling airplane mode for >35s, a `[close]` event with `code=1006` appears in logcat for each socket. Note: ping/pong frames themselves are not visible in logcat because OkHttp does not expose pong receipt to the application layer.
**Source:** `packages/capacitor-native-ws/android/src/main/kotlin/.../NativeWebSocketService.kt`

---

### B4: ConnectivityManager.NetworkCallback integration

**Core:**
- **ID:** `network-callback`
- **Trigger:** `NativeWebSocketService.onCreate()` registers a `ConnectivityManager.NetworkCallback` for the default network.
- **Expected:** On `onAvailable` / `onLost` / `onCapabilitiesChanged`, the plugin emits a `networkChange` event to JS with `{ online: boolean, transport: 'wifi' | 'cell' | 'none' }`. On `isNative()`, `lifecycleEventSource` in `connection-manager/lifecycle.ts` consumes this event as a replacement for `@capacitor/network`'s `networkStatusChange` (which is less reliable — no transport type, slower delivery). ConnectionManager's existing reconnect policy (5s staleness gate, 0–500ms stagger) fires on `online: true` transitions.
- **Verify:** On emulator, toggle Wi-Fi off → logcat shows `[networkChange] online=false transport=none`. Toggle Wi-Fi on → `[networkChange] online=true transport=wifi`. ConnectionManager triggers reconnect for any closed sockets.
**Source:** `packages/capacitor-native-ws/android/src/main/kotlin/.../NativeWebSocketService.kt`, modified `apps/orchestrator/src/lib/connection-manager/lifecycle.ts`

#### Lifecycle integration

In `connection-manager/lifecycle.ts`, the module-level `lifecycleEventSource` object's internal `install()` function currently dynamically imports `@capacitor/network` behind `isNative()`. With B4, add a branch inside `install()`: if `isNative()` AND the `NativeWebSocket` plugin is available, prefer the plugin's `networkChange` listener over `@capacitor/network`. The plugin event maps to the existing lifecycle event taxonomy (`'online'` / `'offline'`).

```typescript
// Inside install() in lifecycleEventSource (connection-manager/lifecycle.ts),
// native network branch:
if (isNative()) {
  try {
    const { NativeWebSocket } = await import('@duraclaw/capacitor-native-ws')
    NativeWebSocket.addListener('networkChange', (data) => {
      emit(data.online ? 'online' : 'offline')
    })
  } catch {
    // Fallback to @capacitor/network
    const { Network } = await import('@capacitor/network')
    // ... existing code
  }
}
```

---

### B5: DEV diagnostics exposure

**Core:**
- **ID:** `dev-diagnostics`
- **Trigger:** `import.meta.env.DEV === true` on a Capacitor build.
- **Expected:** `window.__nativeWs` is populated with `{ connections: Array<{id, url, readyState, lastSeenTs}>, recentCloses: FixedRingBuffer(10), reconnectLog: FixedRingBuffer(10) }`. `FixedRingBuffer` is a trivial fixed-size circular array (implement inline — no existing utility in the codebase): `push()` overwrites oldest when full; `toArray()` returns entries in insertion order. Updated on every open/close/message/error event from the plugin. Dead-code-eliminated from production bundles via `import.meta.env.DEV` guard. Note: ping RTT is not available because OkHttp does not expose pong receipt to the application layer ([OkHttp #6146](https://github.com/square/okhttp/issues/6146)).
- **Verify:** On a DEV Capacitor build, open browser devtools or `adb shell input text 'javascript:JSON.stringify(window.__nativeWs)'`, confirm entries match active sockets.
**Source:** new file `packages/capacitor-native-ws/src/diagnostics.ts`, wired from `shim.ts`

---

### B6: Logcat instrumentation (release builds)

**Core:**
- **ID:** `logcat-instrumentation`
- **Trigger:** Any socket lifecycle event (open, close, error, message-count-batch) on the native side.
- **Expected:** Native Kotlin code logs under tag `Capacitor/NativeWs` with structured format:
  - `[open] id=<id> url=<url>`
  - `[close] id=<id> code=<code> reason=<reason> wasClean=<bool> uptime=<ms>`
  - `[error] id=<id> message=<msg>`
  - `[networkChange] online=<bool> transport=<type>`
  Note: ping/pong is not logged because OkHttp handles it internally with no application-layer callback. Connection liveness is inferred from the absence of `[close]` events.
  Logs survive signed release APKs (Capacitor's `android.loggingBehavior: 'production'` is already configured in `capacitor.config.ts`).
- **Verify:** `adb logcat -s Capacitor/NativeWs` shows structured log lines during a live session on a signed release APK.
**Source:** `packages/capacitor-native-ws/android/src/main/kotlin/.../NativeWebSocketService.kt`

---

### B7: Graceful fallback to browser WebSocket

**Core:**
- **ID:** `graceful-fallback`
- **Trigger:** `installNativeWebSocket()` runs on a Capacitor build but `NativeWebSocket` plugin is not available (plugin not bundled, native load failure, or ANR in `load()`).
- **Expected:** `globalThis.WebSocket` is NOT replaced. The original browser `WebSocket` remains functional. A single `console.warn('[native-ws] Plugin not available, keeping browser WebSocket')` is emitted. All three WS channels connect via the web path (degraded but functional). No user-visible error.
- **Verify:** Remove `@duraclaw/capacitor-native-ws` from `apps/mobile/package.json`, rebuild. App launches, sessions work via browser WebSocket. logcat shows the warn line.
**Source:** `packages/capacitor-native-ws/src/shim.ts` (`installNativeWebSocket()`)

---

## Non-Goals

1. **iOS support** — Plugin ships Android-only. `ios/` contains an empty Swift stub. iOS is a separate follow-up spec when the platform is on the roadmap.
2. **Persistent / Foreground Service / always-on mode** — No `ForegroundService`. No `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`. Socket dies when the app backgrounds. Android 15+ caps `FOREGROUND_SERVICE_DATA_SYNC` at 6h/day; `connectedDevice` is a Play Store policy risk. Industry precedent (Discord, Telegram, Slack, Signal) unanimously uses FCM wake-up instead.
3. **FCM background wake-up** — This spec is transport-only. FCM-triggered reconnect when the app wakes from background is a separate spec. Existing `push-fcm.ts` wiring is untouched.
4. **Cert pinning configuration** — The `NativeWSPlugin.connect()` interface includes an optional `tlsPinning: { sha256: string[] }` field for forward-compatible API design, but v1 ignores it — the Kotlin implementation does not wire `CertificatePinner`. A rotation policy must be established before pinning is safe to enable (expired pin = app-wide WS outage requiring OTA rollback).
5. **WebView-reload frame buffering** — Socket dies with the WebView; no native-side ring buffer. ConnectionManager's reconnect-on-open handlers already cover this path. Same behavior as web WS today.
6. **Separate-process Service** — No `android:process=':ws'`. Service runs in the WebView process. No AIDL. Simpler lifecycle at the cost of no WebView-reload survival (accepted — see non-goal 5).
7. **Server-side telemetry** — Diagnostics stay in the WebView (`window.__nativeWs`) and logcat. No new HTTP endpoints for mobile connection metrics.

## Implementation Phases

See frontmatter `phases` for task + test_case detail. Summary:

### Phase 1a: Plugin scaffold — native + bridge + shim

Greenfield `packages/capacitor-native-ws/`. Build the Kotlin plugin
(`NativeWebSocketPlugin` + `NativeWebSocketService` + `ConnectionRegistry`),
the TypeScript definitions + `registerPlugin`, and the
`NativeWebSocketShim` class. All OkHttp `WebSocketListener` callbacks
marshaled to main thread. Shim includes pending-event queue, property-
setter descriptors, listener-handle cleanup on close, and `binaryType`
support. End state: package builds, unit tests pass for shim compat.

**Key risks:**
- The `onopen` / `onclose` property-setter pattern used by `DialBackClient`
  (`packages/shared-transport/src/dial-back-client.ts:121`). The shim MUST
  define `set onopen(fn)` / `get onopen()` (and siblings) as proper
  property descriptors, not just fields.
- Async listener registration race: `NativeWebSocket.addListener()` is
  async but the constructor can't `await`. The pending-event queue design
  (see B2) mitigates this — unit-test it explicitly.
- Listener leak: each PartySocket reconnect creates a new shim. The old
  shim's 4 plugin listeners must be `.remove()`'d on close.

### Phase 1b: `globalThis.WebSocket` swap + signed APK integration

Wire the shim into the app: `installNativeWebSocket()` in `platform.ts`,
called from `entry-client.tsx`. Add workspace dep + `capacitor.config.ts`
plugin entry. Build signed release APK; verify all three WS channels
route through OkHttp on the Pixel.

### Phase 2: NetworkCallback + OkHttp ping + diagnostics

Layer the reliability features: `ConnectivityManager.NetworkCallback` for
real-time network transitions, structured logcat under
`Capacitor/NativeWs`, `window.__nativeWs` DEV registry. Wire
`lifecycleEventSource` (inside the `install()` function of the module-
level `lifecycleEventSource` object in `connection-manager/lifecycle.ts`)
to prefer the plugin's `networkChange` event over `@capacitor/network` on
native builds. OkHttp `pingInterval(30s)` is already configured in P1a's
shared `OkHttpClient` — this phase adds the logcat lines and verifies
keepalive behavior under screen-off.

### Phase 3: Signed-release verification + roadmap update

Execute the must-pass gate (screen-off 30s+) on the Pixel via wireless
adb with a signed release APK. Informally validate Wi-Fi→LTE handoff,
WebView reload, and GH#69 derived-status regression. Record logcat
evidence. Update `planning/progress.md` and GH#70.

## Verification Plan

All steps executed on the dev Pixel (`46211FDAQ00534`) at Tailscale IP
`100.113.109.57` via wireless adb. Signed release APK required.

### Pre-flight

```bash
export PATH="/home/ubuntu/Android/sdk/platform-tools:$PATH"
adb connect 100.113.109.57:<PORT>
adb devices  # confirm device status

# Build + sign + install
cd /data/projects/duraclaw-dev3
pnpm --filter @duraclaw/capacitor-native-ws build
cd apps/mobile
pnpm cap sync android
bash scripts/build-android.sh
bash scripts/sign-android.sh
adb -s 100.113.109.57:<PORT> install -r \
  android/app/build/outputs/apk/release/app-release-signed.apk
```

### VP-1: Plugin loads and all three WS channels connect

```bash
# Clear logcat, launch app
adb -s 100.113.109.57:<PORT> logcat -c
adb -s 100.113.109.57:<PORT> shell monkey -p com.baseplane.duraclaw \
  -c android.intent.category.LAUNCHER 1

# Wait for login + session open, then:
adb -s 100.113.109.57:<PORT> logcat -d -s Capacitor/NativeWs | head -20
```

**Expected:** At least 2 `[open]` lines — one for `user-stream`, one for `agent:<agentName>`. If a collab session is active, a third `[open]` for `collab:<sessionId>`.

**Expected:** No `[native-ws] Plugin not available` warning in `Capacitor/Console`.

### VP-2: Must-pass — screen-off 30s+, socket stays connected

```bash
# Start a session, send a message, wait for agent response to confirm OPEN
# Lock phone screen (physical button or:)
adb -s 100.113.109.57:<PORT> shell input keyevent 26  # KEYCODE_POWER (screen off)

# Wait 35 seconds
sleep 35

# Wake screen
adb -s 100.113.109.57:<PORT> shell input keyevent 26  # KEYCODE_POWER (screen on)
adb -s 100.113.109.57:<PORT> shell input swipe 540 2000 540 1000  # swipe to unlock

# Check logcat — should have NO [close] events during the 35s window
adb -s 100.113.109.57:<PORT> logcat -d -s Capacitor/NativeWs | grep '\[close\]'
```

**Expected:** No `[close]` events during the 35s window. Socket `readyState` is still `OPEN` after unlock. Note: ping/pong frames are not visible in logcat (OkHttp handles them internally) — connection liveness is inferred from the absence of close events.

**Failure mode:** If `[close]` appears with `code=1006 reason=ping timeout`, OkHttp's ping was not sufficient to keep the connection alive through the screen-off window. Escalate: may need to acquire a partial `WakeLock` during screen-off (adds battery cost).

### VP-3: Ping timeout on sustained network loss

OkHttp's effective timeout is ~30s (one missed pong at the next ping interval), not 90s.

```bash
# With active session, enable airplane mode on the Pixel
adb -s 100.113.109.57:<PORT> shell cmd connectivity airplane-mode enable

# Wait 40 seconds (past ~30s OkHttp ping timeout)
sleep 40

# Check logcat
adb -s 100.113.109.57:<PORT> logcat -d -s Capacitor/NativeWs | grep '\[close\]'
```

**Expected:** `[close] id=<id> code=1006 reason=<SocketTimeoutException message> wasClean=false` for each open socket.

```bash
# Disable airplane mode
adb -s 100.113.109.57:<PORT> shell cmd connectivity airplane-mode disable
```

### VP-4: NetworkCallback fires on connectivity change

```bash
adb -s 100.113.109.57:<PORT> logcat -c
# Toggle Wi-Fi off on the device
adb -s 100.113.109.57:<PORT> shell svc wifi disable
sleep 3
adb -s 100.113.109.57:<PORT> logcat -d -s Capacitor/NativeWs | grep networkChange
```

**Expected:** `[networkChange] online=false transport=none` (or `transport=cell` if mobile data is active).

```bash
adb -s 100.113.109.57:<PORT> shell svc wifi enable
sleep 5
adb -s 100.113.109.57:<PORT> logcat -d -s Capacitor/NativeWs | grep networkChange
```

**Expected:** `[networkChange] online=true transport=wifi`.

### VP-5: Graceful fallback (plugin removed)

Remove `@duraclaw/capacitor-native-ws` from `apps/mobile/package.json`,
rebuild APK, install. Launch app. Login. Open session.

**Expected:** `Capacitor/Console` shows `[native-ws] Plugin not available, keeping browser WebSocket`. Session works — agent responds to messages. All three WS channels connect via browser `WebSocket` (visible in devtools network tab, NOT in `Capacitor/NativeWs` logcat).

### VP-6: DialBackClient property-setter compat

Run the `shared-transport` test suite:

```bash
cd /data/projects/duraclaw-dev3
pnpm --filter @duraclaw/shared-transport test
```

**Expected:** All tests pass. DialBackClient's `ws.onopen = fn` pattern works with the shim class. (If shared-transport tests don't exercise the shim directly, add a unit test in `packages/capacitor-native-ws/` that constructs a `NativeWebSocketShim`, assigns `ws.onopen = fn`, triggers open, and asserts `fn` was called.)

## Implementation Hints

### Key Imports

```typescript
// Plugin registration (packages/capacitor-native-ws/src/index.ts)
import { registerPlugin } from '@capacitor/core'
import type { NativeWSPlugin } from './definitions'
export const NativeWebSocket = registerPlugin<NativeWSPlugin>('NativeWebSocket')

// Shim install (apps/orchestrator/src/lib/platform.ts)
import { NativeWebSocket } from '@duraclaw/capacitor-native-ws'
import { NativeWebSocketShim } from '@duraclaw/capacitor-native-ws/shim'

// Lifecycle integration (apps/orchestrator/src/lib/connection-manager/lifecycle.ts)
import { NativeWebSocket } from '@duraclaw/capacitor-native-ws'
```

```kotlin
// Kotlin plugin (packages/capacitor-native-ws/android/.../NativeWebSocketPlugin.kt)
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import okhttp3.OkHttpClient
import okhttp3.WebSocket
import okhttp3.WebSocketListener
```

### Code Patterns

**1. Property-setter pattern for WebSocket event handlers (critical):**

```typescript
// In NativeWebSocketShim — must match browser WebSocket behavior
private _onopen: ((ev: Event) => void) | null = null

get onopen() { return this._onopen }
set onopen(fn: ((ev: Event) => void) | null) {
  if (this._onopen) this.removeEventListener('open', this._onopen)
  this._onopen = fn
  if (fn) this.addEventListener('open', fn)
}
// Repeat for onclose, onerror, onmessage
```

**2. Base64 ↔ ArrayBuffer conversion in shim:**

```typescript
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
```

**3. Existing shim install pattern (from `installNativeFetchInterceptor`):**

See `apps/orchestrator/src/lib/platform.ts:72–95` — the fetch interceptor follows the same `isNative() → try/catch → swap globalThis` pattern the WS shim should use.

**4. Capacitor plugin event listener with id filtering + pending queue:**

```typescript
// In shim constructor — store handle promise for cleanup:
const openHandle = NativeWebSocket.addListener('open', (data) => {
  if (data.id !== this._id) return  // filter to this socket
  if (!this._listenersReady) {
    this._pendingEvents.push({ type: 'open', data })
    return
  }
  this._readyState = WebSocket.OPEN
  const event = new Event('open')
  this._dispatchEvent(event)
})
this._listenerHandles.push(openHandle)
// ... repeat for message, close, error

// After all 4 listeners registered:
Promise.all(this._listenerHandles).then(() => {
  this._listenersReady = true
  for (const pending of this._pendingEvents) {
    this._handleNativeEvent(pending.type, pending.data)
  }
  this._pendingEvents.length = 0
})
```

**5. Listener cleanup on close (prevent leak across reconnects):**

```typescript
private async _cleanupListeners(): Promise<void> {
  for (const handlePromise of this._listenerHandles) {
    try {
      const handle = await handlePromise
      handle.remove()
    } catch { /* listener was never registered */ }
  }
  this._listenerHandles = []
}
// Called from close() and from the 'close' event handler
```

### Gotchas

1. **`registerPlugin` name must match `@CapacitorPlugin(name=...)` exactly** — `'NativeWebSocket'` in both. Case-sensitive. Mismatch = silent failure (plugin methods return `undefined`).

2. **Capacitor 8 does NOT auto-discover workspace plugins** — must explicitly add `"@duraclaw/capacitor-native-ws": "workspace:*"` to `apps/mobile/package.json` AND `NativeWebSocket: {}` to `capacitor.config.ts` plugins.

3. **`NativeWebSocket.addListener()` is async** (returns `Promise<PluginListenerHandle>`). The shim constructor cannot `await` it. The pending-event queue design (see B2 "Pending-event queue" section) mitigates this: buffer events until all 4 listener promises resolve, then drain. Max queue depth 32. This is critical — without it, `open` events on a fast bridge are lost, hanging PartySocket's reconnect loop.

4. **OkHttp `pingInterval` is per-client, not per-socket.** All sockets share one `OkHttpClient` with `pingInterval(30, SECONDS)`. The `NativeWSPlugin.connect()` API intentionally omits per-socket ping config to avoid a false contract. The effective timeout on a missed pong is ~30s (the next ping cycle), not independently configurable — see B3.

5. **ALL OkHttp `WebSocketListener` callbacks fire on OkHttp's dispatcher thread, not the main thread.** `notifyListeners()` in Capacitor evaluates JS via `WebView.evaluateJavascript()` which is main-thread-only. Wrap EVERY callback (`onOpen`, `onMessage`, `onClosing`, `onClosed`, `onFailure`) in `Handler(Looper.getMainLooper()).post { ... }`. Failing to do this for `onMessage` (the highest-frequency callback) will crash or silently fail to deliver messages.

6. **CapacitorHttp conflict** ([ionic-team/capacitor#7568](https://github.com/ionic-team/capacitor/issues/7568)) — CapacitorHttp intercepts HTTP requests, which can interfere with WebSocket upgrades. Our plugin uses its own `OkHttpClient` so this doesn't apply, but if someone enables CapacitorHttp AND our plugin, verify no conflict. If conflict emerges, add `CapacitorHttp: { enabled: false }` guidance.

7. **`binaryType` default** — per the WebSocket spec, default `binaryType` is `'blob'`, but YProvider immediately sets it to `'arraybuffer'`. The shim should default to `'blob'` for spec compliance but handle `'arraybuffer'` (the common case) efficiently.

### Reference Docs

- [Capacitor Plugin Development Guide (v8)](https://capacitorjs.com/docs/plugins/creating-plugins) — plugin scaffold, `@CapacitorPlugin`, `@PluginMethod`, `notifyListeners`
- [OkHttp WebSocket API](https://square.github.io/okhttp/4.x/okhttp/okhttp3/-web-socket/) — `WebSocketListener` callbacks, `ByteString` binary handling
- [OkHttp Ping Interval](https://square.github.io/okhttp/4.x/okhttp/okhttp3/-ok-http-client/-builder/ping-interval/) — `pingInterval(interval, unit)` on `OkHttpClient.Builder`
- [ConnectivityManager.NetworkCallback](https://developer.android.com/reference/android/net/ConnectivityManager.NetworkCallback) — `onAvailable`, `onLost`, `onCapabilitiesChanged`
- [Android Foreground Service Types (out of scope but referenced)](https://developer.android.com/develop/background-work/services/fgs/service-types) — why `dataSync` is a trap
- [PartySocket source (v1.1.4)](https://github.com/partykit/partykit/tree/main/packages/partysocket) — ReconnectingWebSocket adapter, `new WebSocket(url)` call site
- [y-partyserver YProvider source](https://github.com/y-sweet/y-sweet/tree/main/packages/y-partyserver) — binary sync protocol, `binaryType` setting
