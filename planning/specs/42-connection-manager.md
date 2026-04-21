---
initiative: connection-manager
type: project
issue_type: feature
status: approved
priority: medium
github_issue: 42
created: 2026-04-21
updated: 2026-04-21
phases:
  # Phase dependencies:
  #   p1: none (interface + PartySocket adapter — standalone)
  #   p2: [p1]  (YProvider adapter uses the interface; registry singleton is standalone but lives with p2)
  #   p3: none  (lifecycle source is self-contained — can run in parallel with p1/p2)
  #   p4: [p2, p3]  (manager needs both the registry and the lifecycle source)
  #   p5: [p1, p2, p4]  (hook wiring needs adapters + manager)
  #   p6: [p2, p5]  (useConnectionStatus reads registry; OfflineBanner assumes hooks are wired)
  #   p7: [p5, p6]  (verification runs against the full wired system)
  - id: p1
    name: "ManagedConnection interface + PartySocket adapter"
    tasks:
      - "Create `apps/orchestrator/src/lib/connection-manager/types.ts` exporting `ManagedConnection` interface: `{ readonly id: string; readonly kind: 'partysocket' | 'yprovider'; readonly readyState: number; reconnect(code?: number, reason?: string): void; close(code?: number, reason?: string): void; lastSeenTs: number; addEventListener(event: 'open'|'close'|'error'|'message', fn: (ev: Event | MessageEvent) => void): void; removeEventListener(event, fn: (ev: Event | MessageEvent) => void): void }`. Callback type is `(ev: Event | MessageEvent) => void` — PartySocket adapter passes the native DOM event through; YProvider adapter synthesizes `new Event('open' | 'close' | 'error')` or a `MessageEvent('message', { data: <y-sync-payload> })` so both adapters honor the same callback signature. Consumers that need substrate-specific data cast as needed. The `code`/`reason` args on reconnect/close are optional diagnostic labels (`'cm-foreground'`, etc.) that PartySocket forwards to the server as a close code and y-partyserver adapter ignores"
      - "Create `apps/orchestrator/src/lib/connection-manager/adapters/partysocket-adapter.ts` exporting `createPartySocketAdapter(ps: PartySocket, id: string): ManagedConnection`. Adapter mirrors `ps.readyState`, forwards `.reconnect(code, reason)` and `.close(code, reason)`, tracks `lastSeenTs` by listening to `message` events and updating the timestamp (also bumps on `open`). Event subscriptions pass through to `ps.addEventListener` / `removeEventListener`"
      - "Adapter must tolerate PartySocket's hybrid event shape (it dispatches DOM `Event` on open/close but `MessageEvent` on message). Cast types appropriately; do NOT mutate the raw event"
    test_cases:
      - "Unit test: `createPartySocketAdapter(mockPartySocket, 'user-stream').readyState` returns the current `mockPartySocket.readyState` value live (mutable property passthrough)"
      - "Unit test: `.reconnect()` called on adapter invokes `mockPartySocket.reconnect()` once"
      - "Unit test: emitting a `message` event bumps `lastSeenTs` to the current time (`Date.now()` within 10ms)"
      - "Unit test: emitting an `open` event also bumps `lastSeenTs`"
  - id: p2
    name: "YProvider adapter + registry singleton"
    tasks:
      - "Create `apps/orchestrator/src/lib/connection-manager/adapters/yprovider-adapter.ts` exporting `createYProviderAdapter(provider: YProvider, id: string): ManagedConnection`. `readyState` derived from `provider.wsconnected ? WebSocket.OPEN : (provider.wsconnecting ? WebSocket.CONNECTING : WebSocket.CLOSED)`. `.reconnect()` calls `provider.disconnect()` immediately followed by `provider.connect()`. `.close()` calls `provider.disconnect()`. `lastSeenTs` bumps on provider's internal `synced` observable AND on every awareness update (both are live-connection signals)"
      - "Event compatibility: YProvider does NOT expose DOM events — instead it has an `observable` pattern (`provider.on('status', fn)`). The adapter translates: subscribing to `'open'` listens on status for `{status:'connected'}`, `'close'` listens for `{status:'disconnected'}`, `'error'` is a no-op (YProvider doesn't surface errors on a separate channel), `'message'` hooks `provider.on('sync')`. Unsubscribe mirrors the translation"
      - "Create `apps/orchestrator/src/lib/connection-manager/registry.ts` exporting singleton `connectionRegistry` with `register(conn: ManagedConnection): () => void` (returns unregister fn), `unregister(id: string): ManagedConnection | undefined` (returns the removed entry if any; silent no-op for unknown ids), `snapshot(): ReadonlyArray<ManagedConnection>`, and `onChange(fn: (snapshot) => void): () => void` so UI can subscribe to registry changes for a unified `isOnline`"
      - "Registry MUST survive React StrictMode double-mount: calling `register(conn)` for an `id` already in the registry replaces the previous entry (logs a dev-mode warning) rather than throwing. The previous entry's unregister fn becomes a no-op"
      - "Dev affordance: when `import.meta.env.DEV` is true, also expose `connectionRegistry` on `window.__connectionRegistry` for inspection via `scripts/axi eval`. Never exposed in production builds"
    test_cases:
      - "Unit test: `createYProviderAdapter`'s readyState reflects `wsconnected=true` → OPEN, `wsconnecting=true` → CONNECTING, both false → CLOSED"
      - "Unit test: calling adapter's `.reconnect()` invokes provider.disconnect() then provider.connect() in that order"
      - "Unit test: registry.register(a); registry.register(b); registry.snapshot() returns [a, b] in insertion order"
      - "Unit test: double-register of same id replaces and returns a fresh unregister fn"
      - "Unit test: onChange subscribers are fired once per register/unregister call"
  - id: p3
    name: "Lifecycle event sources (Capacitor + browser)"
    tasks:
      - "Create `apps/orchestrator/src/lib/connection-manager/lifecycle.ts` exporting a `LifecycleEventSource` with `subscribe(fn: (event: 'foreground'|'background'|'online'|'offline'|'visible'|'hidden') => void): () => void`"
      - "Native listeners: dynamically import `@capacitor/app` and `@capacitor/network` behind `if (isNative())`. On `App.addListener('appStateChange', ({isActive}) => ...)` emit `'foreground'` when isActive, `'background'` otherwise. On `Network.addListener('networkStatusChange', ({connected}) => ...)` emit `'online'` / `'offline'`"
      - "Initial state seeding (native): immediately after subscribing to `networkStatusChange`, call `await Network.getStatus()` and synthetically emit `'online'` or `'offline'` based on `.connected`. Required because `networkStatusChange` does NOT fire on app launch — without this, launching the app while offline leaves the manager assuming online, and no reconnect fires when connectivity returns. No equivalent seed for `App.appStateChange` — app is trivially foregrounded on launch by definition of being able to execute JS"
      - "Web listeners (always installed): `document.addEventListener('visibilitychange', () => emit(document.hidden ? 'hidden' : 'visible'))`, `window.addEventListener('online', () => emit('online'))`, `window.addEventListener('offline', () => emit('offline'))`. On native these fire too (Capacitor WebView honors them) but they're supplementary — `foreground` is the authoritative signal, the rest can fire redundantly without ill effect because the reconnect path is idempotent when `lastSeenTs` is recent"
      - "Teardown: every listener registered in a lifecycle source must have a matching remove call. Return an unsubscribe fn from `subscribe()` that tears down all four listener types. Multiple concurrent subscribers ARE supported — internally the source holds a `Set<Listener>` and fans out each emitted event to every subscriber. Native listeners on App/Network are installed on first subscribe and torn down when the last subscriber unsubscribes. Primary consumer is the ConnectionManager; tests can subscribe spies alongside without interference"
      - "SSR-safe: all initialisation is behind `typeof window === 'undefined'` early return. Subscribe becomes a no-op that returns a no-op unsubscribe"
    test_cases:
      - "Unit test (web): firing a synthetic `online` event on window invokes the subscribed fn with 'online'"
      - "Unit test (web): firing `visibilitychange` with `document.hidden=true` invokes fn with 'hidden', false with 'visible'"
      - "Unit test (native mock): isNative() returns true; simulated `App.appStateChange { isActive: true }` invokes fn with 'foreground'"
      - "Unit test (native mock): simulated `Network.networkStatusChange { connected: false }` invokes fn with 'offline'"
      - "Unit test (native mock): `Network.getStatus()` returning `{ connected: false }` on subscribe invokes fn with 'offline' synchronously (well, microtask-synchronously — the init awaits the promise)"
      - "Unit test (native mock): `Network.getStatus()` returning `{ connected: true }` on subscribe invokes fn with 'online'"
      - "Unit test: unsubscribe fn removes all four listener types (verify via spy counts)"
  - id: p4
    name: "ConnectionManager coordinator + reconnect policy"
    tasks:
      - "Create `apps/orchestrator/src/lib/connection-manager/manager.ts` exporting singleton `connectionManager`. **Public API surface:** `start()`, `stop()`, `reconnectAll()`. The manager does NOT expose `register` — registration is exclusively on `connectionRegistry`. On `start()` (called once from app shell), subscribe to `lifecycleEventSource`. On `foreground` or `online` event: iterate `connectionRegistry.snapshot()` and for every `conn` where `Date.now() - conn.lastSeenTs > 5000`, schedule `conn.reconnect()` with a per-conn random delay ∈ [0, 500) ms using `setTimeout`. On `background`, `offline`, or `hidden`: no reconnect action (let the OS kill sockets, we'll pick up on resume)"
      - "Random source: the manager accepts a `{ random?: () => number }` injection point (defaults to `Math.random`). Tests override this to get deterministic stagger intervals; prod always uses the default"
      - "Reconnect scheduling: use a per-conn `Map<id, number>` of pending timer handles. If a new reconnect is scheduled while one is already pending for the same `id`, cancel the old and reschedule. Prevents stampedes from rapid foreground/background flips"
      - "Expose `connectionManager.reconnectAll()` for test/debug affordance. Fires `conn.reconnect()` on every registered connection **immediately with no stagger and no lastSeenTs gate**. Used in tests that want deterministic reconnect timing. No UI consumer is wired in this spec — if the existing MessageInput has a reconnect-now button, flipping it to call `connectionManager.reconnectAll()` is a trivial follow-up PR (out of scope here). Every `conn.reconnect()` call is wrapped in try/catch; a throw on one connection is logged and swallowed so the remaining connections still reconnect"
      - "Error handling on the event-driven reconnect path: when iterating the registry snapshot, each `conn.reconnect()` call is wrapped in try/catch. A throw (e.g., YProvider.disconnect() throws because the socket was garbage-collected) is logged via `console.warn('[cm] reconnect threw', id, err)` and swallowed. Broken connections don't block the rest of the sweep"
      - "Instrument each reconnect call with a structured console.debug: `[cm] reconnect id=<id> lastSeenMs=<ms> delay=<ms> reason=<foreground|online|manual>`. Suppressed in prod via `import.meta.env.DEV` gate — dev only"
      - "Dev affordance: maintain a ring buffer `lastReconnectLog: Array<{id, lastSeenMs, delay, reason, ts}>` capped at the 10 most recent entries. When `import.meta.env.DEV` is true, expose `connectionManager` (including `.lastReconnectLog`) on `window.__connectionManager` for inspection via `scripts/axi eval`. Never exposed in production builds"
      - "`connectionManager` is lazy-init: `start()` wires the lifecycle subscription. `stop()` (a) unsubscribes from the lifecycle source AND (b) iterates the pending-timers Map and calls `clearTimeout` on every entry, then clears the Map. `start()` after `stop()` is supported (re-subscribe). Double-start is a no-op"
    test_cases:
      - "Unit test: register conn with lastSeenTs = Date.now() - 6000; fire 'foreground'; conn.reconnect() is called within 500ms"
      - "Unit test: register conn with lastSeenTs = Date.now() - 2000 (under threshold); fire 'foreground'; conn.reconnect() is NOT called"
      - "Unit test: register 5 conns all stale; inject a deterministic `random` that returns [0, 0.2, 0.4, 0.6, 0.8] in order; fire 'foreground'; all 5 reconnect() calls land at timestamps corresponding to delays [0, 100, 200, 300, 400]ms (tolerance ±20ms). Proves stagger works; not flaky because the random source is injected"
      - "Unit test: default random source (Math.random) produces at least one pair of distinct delays across 5 conns (weaker, non-deterministic check confirming the default path is wired)"
      - "Unit test: rapid foreground/background flip within 200ms — no duplicate reconnect call for the same conn (pending timer cancelled)"
      - "Unit test: call start(); schedule a reconnect (fire 'foreground' with stale conn); call stop() before the timer fires; verify the timer is cleared (conn.reconnect() is NEVER called)"
      - "Unit test: reconnectAll() fires reconnect on every registered conn regardless of lastSeenTs"
  - id: p5
    name: "Hook integration + remove use-app-lifecycle"
    tasks:
      - "Create `apps/orchestrator/src/lib/connection-manager/hooks.ts` exporting `useManagedConnection(conn: ManagedConnection | null, id: string)`. Registers `conn` with `connectionRegistry` on mount (if non-null), unregisters on unmount OR when `conn` object identity changes. Uses `useEffect` with `[conn, id]` as the dependency array — the `conn` reference identity is the signal for re-register (the underlying socket instance is created by the hook and is stable across reconnects, so identity only changes on genuine socket swaps like session-id change). `ManagedConnection` has no `.url` property by design — identity rides on the adapter object itself"
      - "Wire `use-coding-agent.ts` (search for `const connection = useAgent<unknown>(` — currently near L419; the existing readyState mirror effect at L529-542 is the closest anchor for the insertion): after `const connection = useAgent(...)` returns, create the adapter via `useMemo(() => createPartySocketAdapter(connection, `agent:${agentName}`), [connection, agentName])` and call `useManagedConnection(adapter, `agent:${agentName}`)`"
      - "Wire `use-user-stream.ts`: after the singleton PartySocket opens in `openSocket(userId)` (L69), create a `userStreamAdapter` and `connectionRegistry.register(adapter)`. On `closeSocket()` call the returned unregister fn. Since use-user-stream is module-level (not React), register/unregister happens outside any hook — use the non-hook `connectionRegistry.register` directly"
      - "Wire `use-session-collab.ts` at L80-85 area: after `useYProvider(...)` returns non-null, call `useManagedConnection(createYProviderAdapter(provider, `collab:${sessionId}`), `collab:${sessionId}`)`"
      - "Delete `apps/orchestrator/src/features/agent-orch/use-app-lifecycle.ts` (L1-38). Its foreground→hydrate() behavior moves into `use-coding-agent.ts` by subscribing to the agent adapter's `open` event directly (via `adapter.addEventListener('open', ...)`). The hook uses a `hasConnectedOnce` ref gate: the FIRST `open` (initial connect) does NOT fire `hydrate()` — useAgent's internal connection handshake handles initial state. Subsequent `open` events (reconnects) DO call `hydrate()`. This preserves the existing semantics of useAppLifecycle which only fired on foreground transitions, never on initial mount"
      - "In `apps/orchestrator/src/routes/__root.tsx` (or the app shell component that currently calls `useAppLifecycle`), replace the `useAppLifecycle` call with `connectionManager.start()` wired in a single top-level `useEffect`. Teardown on unmount is a no-op in prod (app shell outlives the manager) but included for StrictMode and testing"
    test_cases:
      - "Vitest + jsdom + React Testing Library test (`apps/orchestrator/src/lib/connection-manager/__tests__/hooks.test.tsx`): render `<useManagedConnection>` via `renderHook` with a mock adapter; assert `connectionRegistry.snapshot()` contains the entry after mount; unmount via `result.unmount()`; assert entry is gone"
      - "Grep test: `rg 'use-app-lifecycle' apps/orchestrator` after deletion returns zero matches"
      - "Grep test: `rg \"App.addListener\\('appStateChange'\" apps/orchestrator` returns exactly one match — in `lib/connection-manager/lifecycle.ts`"
      - "Unit test: two successive `open` events fired on a mocked agent adapter invoke the wired `hydrate()` exactly once (the second); proves `hasConnectedOnce` gate works"
      - "Manual device test: on Android, kill network → restore network; within ~500ms the agent socket shows an `open` event (staggered reconnect lands) — verified via DevTools WebView inspector"
  - id: p6
    name: "Unified online signal + UI wiring"
    tasks:
      - "Create `apps/orchestrator/src/lib/connection-manager/useConnectionStatus.ts` exporting `useConnectionStatus(): { isOnline: boolean; connections: Array<{ id: string; readyState: number }> }`. Subscribes to `connectionRegistry.onChange` + each conn's `open`/`close` events. Derived `isOnline` is `true` iff every registered conn has `readyState === WebSocket.OPEN`"
      - "Dynamic subscription bookkeeping for `useConnectionStatus`: on each `onChange` fire, diff the previous snapshot against the new one — for every conn in `added`, attach open/close listeners and stash the unsubscribe fn in a `Map<id, () => void>` ref; for every conn in `removed`, call its stashed unsubscribe and delete from the ref. On hook unmount, iterate the Map and unsubscribe every entry. Prevents stale listeners on connections that have been unregistered, and guarantees newly-registered connections participate in the `isOnline` derivation"
      - "Rewrite `apps/orchestrator/src/components/offline-banner.tsx` to consume `useConnectionStatus().isOnline` instead of `navigator.onLine` polling. Banner debounce direction: **debounce `isOnline=true → banner=visible` transitions by 1s** (i.e., delay SHOWING the banner). A sub-1-second reconnect blip never flashes the banner. Once visible, the banner hides IMMEDIATELY on recovery. Semantically: offline must be sustained for 1s before the user is told; online is reflected instantly because the user is probably waiting to see it"
      - "StatusBar integration: if the existing StatusBar component derives WS status from `readyState` of a specific socket, add a secondary indicator for 'all sockets healthy' vs 'some disconnected' driven by `useConnectionStatus`. Spec #31's existing per-session status logic is unchanged"
    test_cases:
      - "Vitest + jsdom + RTL (`apps/orchestrator/src/lib/connection-manager/__tests__/useConnectionStatus.test.tsx`): register 3 mock adapters, drop 1 for 1.2s (simulated via `vi.useFakeTimers()` + advanceTimersByTime); assert `useConnectionStatus().isOnline === false` AND banner component renders 'Reconnecting…' at t=1.0s+"
      - "Vitest: register 3 mocks, drop 1 for 0.4s then fire its 'open' event → advance timers past 1s → banner NEVER renders (sub-1s disconnect absorbed by debounce)"
      - "Vitest: sustained disconnect (2s, banner visible) → fire 'open' on dropped adapter → banner hides within one render tick (no debounce on hide path)"
      - "Manual test on web: DevTools Network → Offline; within 1s the banner is NOT shown; past 1s the banner appears. Restore → banner disappears immediately"
  - id: p7
    name: "Verification + device test + docs"
    tasks:
      - "Update CLAUDE.md 'Architecture' section — add a 'Client connection manager' subsection under 'Client data flow' pointing to `apps/orchestrator/src/lib/connection-manager/`. One paragraph describing the registry + lifecycle source + policy"
      - "Run the Verification Plan steps literally (see below) on the local verify stack + an Android device via the Pixel sideload flow described in CLAUDE.md"
      - "Check final bundle: `pnpm --filter @duraclaw/orchestrator build` → verify `@capacitor/app` and `@capacitor/network` do NOT appear in the web bundle (grep dist/client for those imports). They must remain dynamically imported behind `isNative()`"
    test_cases:
      - "Web bundle grep: `grep -r '@capacitor/app' apps/orchestrator/dist/client` returns no matches"
      - "Web bundle grep: `grep -r '@capacitor/network' apps/orchestrator/dist/client` returns no matches"
      - "Android device: kill WiFi → re-enable WiFi → all 3 WSs show 'open' within 1s of network regain (verify via connectionRegistry snapshot in devtools)"
---

# Client ConnectionManager

## Overview

Capacitor Android WS reliability is the acute pain point — agent streaming, synced-collection deltas, and Yjs draft sync all sit on independent WS substrates (partysocket for 2, y-partyserver's WebsocketProvider for 1) with no cross-cutting lifecycle coordination. A singleton `ConnectionManager` registers every WS, listens to `@capacitor/app`/`@capacitor/network`/`visibilitychange`/`online`/`offline`, and fires staggered eager reconnects when the OS hands us back a foreground or network event. `@capacitor/network` is installed but currently unwired — free signal. Result: recovery latency on backgrounded-socket death drops from the OS TCP timeout (30–90 s) to sub-second; three sockets coordinate through one signal instead of each waiting independently.

## Feature Behaviors

### B1: ManagedConnection adapter interface

**Core:**
- **ID:** managed-connection-interface
- **Trigger:** Any new WS-owning hook or module needs to plug into the registry.
- **Expected:** A small, substrate-agnostic interface. Adapters exist for PartySocket and y-partyserver's YProvider. New substrates are added by writing an adapter, not touching the manager.
- **Verify:** Unit tests for both adapters assert `readyState`, `.reconnect()` delegation, and `lastSeenTs` bump on message/open events.

#### Code Layer

- New file: `apps/orchestrator/src/lib/connection-manager/types.ts` — `ManagedConnection` interface.
- New file: `apps/orchestrator/src/lib/connection-manager/adapters/partysocket-adapter.ts`.
- New file: `apps/orchestrator/src/lib/connection-manager/adapters/yprovider-adapter.ts`.

### B2: Registry singleton

**Core:**
- **ID:** connection-registry
- **Trigger:** Any hook/module calls `connectionRegistry.register(adapter)`.
- **Expected:** Module-level registry holds a `Map<id, ManagedConnection>` preserving insertion order. Change events fire to subscribers. Double-register replaces with dev warning. Unregister returns the removed conn if any.
- **Verify:** Unit tests for register/unregister/snapshot/onChange + double-register replacement.

#### Code Layer

- New file: `apps/orchestrator/src/lib/connection-manager/registry.ts`.

### B3: Lifecycle event source (Capacitor + browser)

**Core:**
- **ID:** lifecycle-event-source
- **Trigger:** OS-level state change (app foreground/background, network on/off, tab visible/hidden).
- **Expected:** Unified `subscribe(fn)` exposes a single stream of events `'foreground'|'background'|'online'|'offline'|'visible'|'hidden'`. Capacitor plugins are dynamically imported behind `isNative()` so the web bundle excludes them.
- **Verify:** Web bundle grep confirms absence of `@capacitor/app` + `@capacitor/network`. Unit tests cover every event on native mock + web fallback.
**Source:** `apps/mobile/package.json:12-22` (plugins installed), `apps/orchestrator/src/lib/platform.ts:33-35` (`isNative()`), `apps/orchestrator/src/features/agent-orch/use-app-lifecycle.ts:22-31` (existing dynamic-import pattern to mirror).

#### Code Layer

- New file: `apps/orchestrator/src/lib/connection-manager/lifecycle.ts`.
- Delete: `apps/orchestrator/src/features/agent-orch/use-app-lifecycle.ts` (rolled up into manager; see B7).

### B4: Coordinated reconnect policy

**Core:**
- **ID:** coordinated-reconnect
- **Trigger:** Lifecycle source emits `'foreground'` or `'online'`.
- **Expected:** For every registered connection where `Date.now() - conn.lastSeenTs > 5000` ms, schedule `conn.reconnect()` with a per-conn random `[0, 500) ms` stagger. No probe/ping. Pending timers cancelled if re-scheduled for the same conn (prevents stampede on rapid OS flips). `'background'`/`'offline'`/`'hidden'` events: no action.
- **Verify:** Unit tests for the stagger spread, threshold gate, and rapid-flip dedup.

#### Code Layer

- New file: `apps/orchestrator/src/lib/connection-manager/manager.ts`.

### B5: Hook-level auto-register

**Core:**
- **ID:** use-managed-connection
- **Trigger:** A hook component mounts with a WS connection object.
- **Expected:** `useManagedConnection(conn, id)` registers on mount, unregisters on unmount, re-registers on conn identity change. Module-level consumers (use-user-stream singleton) use `connectionRegistry.register` directly since they don't have a React lifecycle.
- **Verify:** Integration test — mount app shell, snapshot contains 3 entries; unmount MessageInput, `collab:*` entry removed.
**Source:** `apps/orchestrator/src/features/agent-orch/use-coding-agent.ts:419-516` (useAgent call to wire), `apps/orchestrator/src/hooks/use-user-stream.ts:69-148` (singleton openSocket/closeSocket to wire), `apps/orchestrator/src/hooks/use-session-collab.ts:80-85` (useYProvider call to wire).

#### Code Layer

- New file: `apps/orchestrator/src/lib/connection-manager/hooks.ts` — `useManagedConnection`.
- Modify: `apps/orchestrator/src/features/agent-orch/use-coding-agent.ts` — add adapter wrap + hook call near the existing useAgent instantiation (currently L419–516; readyState mirror at L529–542 is the closest stable anchor).
- Modify: `apps/orchestrator/src/hooks/use-user-stream.ts` — register in `openSocket`, unregister in `closeSocket`.
- Modify: `apps/orchestrator/src/hooks/use-session-collab.ts` — add adapter wrap + hook call after provider resolves.

### B6: Unified `isOnline` signal

**Core:**
- **ID:** use-connection-status
- **Trigger:** UI component needs to know "are all WSs healthy".
- **Expected:** `useConnectionStatus()` returns `{ isOnline, connections }`. `isOnline = true` iff every registered conn has `readyState === OPEN`. The OfflineBanner consumer debounces the SHOW transition by 1 s — `isOnline` going `true → false` must be sustained for 1 s before the banner renders. Recovery (`false → true`) reflects immediately. Dynamic subscription bookkeeping (diff previous vs new registry snapshot on every `onChange`) prevents leaked listeners on unregistered connections and guarantees new connections participate in the derived signal.
- **Verify:** Integration tests — sub-1s disconnect never flashes the banner; sustained disconnect shows banner after 1 s; recovery hides immediately.

#### UI Layer

- Rewrite `apps/orchestrator/src/components/offline-banner.tsx` to consume `useConnectionStatus().isOnline` (currently uses `navigator.onLine` only).
- StatusBar: no changes in this spec. A secondary "global WS health" indicator alongside the per-session WS status from Spec #31 is a possible future enhancement but is explicitly out of scope here — the OfflineBanner rewrite covers the MVP user-visible surface.

#### Code Layer

- New file: `apps/orchestrator/src/lib/connection-manager/useConnectionStatus.ts`.
- Modify: `apps/orchestrator/src/components/offline-banner.tsx:6-14`.

### B7: Replace `useAppLifecycle` with manager-driven hydrate

**Core:**
- **ID:** replace-app-lifecycle
- **Trigger:** App was backgrounded and returns to foreground (or any subsequent reconnect).
- **Expected:** `use-coding-agent` subscribes to its adapter's `open` event directly via `adapter.addEventListener('open', ...)`. The FIRST `open` event (initial connect at mount) is ignored via a `hasConnectedOnce` ref — matching the existing `useAppLifecycle` which only fired on transitions. Subsequent `open` events (after a reconnect driven by the manager) call `hydrate()` to replay missed messages. The separate `useAppLifecycle` listener is deleted — the manager is the only thing installing `App.addListener`.
- **Verify:** Grep confirms `use-app-lifecycle.ts` is deleted and `App.addListener('appStateChange', …)` appears in exactly one file: `apps/orchestrator/src/lib/connection-manager/lifecycle.ts`. Unit test: two successive `open` events on a mocked adapter invoke `hydrate()` exactly once (the second).
**Source:** `apps/orchestrator/src/features/agent-orch/use-app-lifecycle.ts:1-38`.

#### Code Layer

- Delete: `apps/orchestrator/src/features/agent-orch/use-app-lifecycle.ts`.
- Modify: `apps/orchestrator/src/features/agent-orch/use-coding-agent.ts` — wire `hydrate()` on adapter reconnect.
- Modify: whichever app-shell component currently imports `useAppLifecycle` (grep to find: likely `__root.tsx` or a layout component) — replace with a single top-level `useEffect(() => { connectionManager.start(); return () => connectionManager.stop() }, [])`.

### B8: Web-bundle tree-shake verification

**Core:**
- **ID:** web-bundle-clean
- **Trigger:** Production web build.
- **Expected:** `@capacitor/app` and `@capacitor/network` are entirely absent from `dist/client/` output. Dynamic-import pattern mirrors the existing `use-app-lifecycle.ts:22-31` pattern (async IIFE gated by `isNative()`).
- **Verify:** Grep `dist/client` after `pnpm --filter @duraclaw/orchestrator build`.

## Non-Goals

- **REST / fetch retry coordination.** The manager owns WS only. Fetch retries stay with their callers.
- **Substrate unification via `WebSocketPolyfill`.** y-partyserver accepts a polyfill option but substituting partysocket there replaces Yjs-aware reconnect logic with generic. Deferred unless Option-A adapters prove insufficient.
- **Service Worker / worker-thread based coordination.** Capacitor WebView's SW story is messy and over-engineered for MVP.
- **Fixing cursor-jump-on-remote-delta in `PromptInputTextarea`.** Separate follow-up spec — cursor preservation is a textarea-binding problem, not a lifecycle problem.
- **Multi-user collab drafts UX.** SessionCollabDO remains per-session; the manager treats the Yjs provider as one more socket, no feature change.
- **Foreground service (GH#40).** Native Android service that keeps sockets alive *while backgrounded*. The manager complements it but doesn't replace it — GH#40 addresses "don't let the OS kill the socket", the manager addresses "when it inevitably does, recover fast."

## Implementation Phases

See frontmatter. Seven phases, each completable in 1–4 hours:

1. **P1** — `ManagedConnection` interface + PartySocket adapter.
2. **P2** — YProvider adapter + registry singleton.
3. **P3** — Lifecycle event source (Capacitor + browser).
4. **P4** — ConnectionManager coordinator + reconnect policy.
5. **P5** — Hook integration + delete `use-app-lifecycle`.
6. **P6** — Unified `isOnline` signal + offline-banner rewrite.
7. **P7** — Verification + device test + CLAUDE.md docs update.

## Verification Plan

Every step below is literal and executable by a fresh agent.

### V1: Unit tests pass

```bash
pnpm --filter @duraclaw/orchestrator test -- connection-manager
```

Expected: all suites under `apps/orchestrator/src/lib/connection-manager/**/*.test.ts` pass.

### V2: Web bundle excludes Capacitor plugins

```bash
pnpm --filter @duraclaw/orchestrator build
rg '@capacitor/(app|network)' apps/orchestrator/dist/client
```

Expected: `rg` returns zero matches (exit code 1).

### V3: Three connections registered on app mount (web)

1. `scripts/verify/dev-up.sh`
2. `scripts/axi open http://localhost:$VERIFY_ORCH_PORT/login`
3. Log in as `agent.verify+duraclaw@example.com` / `duraclaw-test-password`.
4. Open any existing session (or create one).
5. `scripts/axi eval 'JSON.stringify(window.__connectionRegistry?.snapshot()?.map(c => ({id: c.id, readyState: c.readyState})) ?? [])'`

Expected output:

```json
[
  {"id":"user-stream","readyState":1},
  {"id":"agent:<agentName>","readyState":1},
  {"id":"collab:<sessionId>","readyState":1}
]
```

(`__connectionRegistry` is exposed on `window` only in `import.meta.env.DEV` builds, from `registry.ts` — include that dev affordance.)

### V4: Unmounting MessageInput removes the collab entry

1. Continuing from V3.
2. Navigate to a page without MessageInput (e.g., session list).
3. `scripts/axi eval 'window.__connectionRegistry.snapshot().map(c => c.id)'`

Expected: output does NOT contain any `collab:*` entry.

### V5: Offline → online on web triggers coordinated reconnect

1. Continuing from V3.
2. `scripts/axi eval 'window.dispatchEvent(new Event("offline"))'`
3. Wait 500 ms.
4. `scripts/axi eval 'window.dispatchEvent(new Event("online"))'`
5. Within 1 s: `scripts/axi eval 'window.__connectionManager?.lastReconnectLog'` (maintained in DEV builds — a ring buffer of the last 10 reconnect events with `{id, lastSeenMs, delay, reason}`).

Expected: log contains 3 entries (`agent:*`, `user-stream`, `collab:*`) with `reason: 'online'`, `delay` values spread across [0, 500).

### V6: Backgrounded-socket recovery on Android device

1. Sideload the APK via the flow in CLAUDE.md (`adb -s 100.113.109.57:<PORT> install -r apps/mobile/android/app/build/outputs/apk/release/app-release-signed.apk`).
2. Open the app, log in, open a session.
3. Chrome DevTools inspect via `chrome://inspect/#devices` targeting the Android WebView.
4. In DevTools console: `window.__connectionRegistry.snapshot().map(c => ({id: c.id, rs: c.readyState}))` — all OPEN.
5. Toggle Airplane mode ON, wait 10 s, toggle OFF.
6. Within 1 s of network regain: re-run the snapshot command.

Expected: all three conns back to OPEN within 1 s. Before the fix, this typically took 30–90 s.

### V7: OfflineBanner driven by unified signal

1. Continuing from V3.
2. DevTools → Network → Offline.
3. Expected at t=500ms: OfflineBanner NOT visible (inside debounce window).
4. Expected at t=1100ms: OfflineBanner visible (past debounce).
5. DevTools → Network → Online.
6. Expected within 300ms of step 5: OfflineBanner hides (no debounce on hide, reconnect completes quickly).

## Implementation Hints

### Key Imports

```typescript
// Dynamic import for Capacitor plugins (keeps web bundle clean)
const { App } = await import('@capacitor/app')
const { Network } = await import('@capacitor/network')

// Existing substrate types
import PartySocket from 'partysocket'
import type YProvider from 'y-partyserver/provider'

// Platform detection (existing, use as-is)
import { isNative } from '~/lib/platform'
```

### Code Patterns

**Dynamic-import guard mirroring `use-app-lifecycle.ts:17-37`:**

```typescript
useEffect(() => {
  if (!isNative()) return
  let cancelled = false
  let remove: (() => void) | null = null
  ;(async () => {
    const { App } = await import('@capacitor/app')
    if (cancelled) return
    const handle = await App.addListener('appStateChange', ({ isActive }) => {
      emit(isActive ? 'foreground' : 'background')
    })
    remove = () => handle.remove()
  })()
  return () => { cancelled = true; remove?.() }
}, [])
```

**PartySocket `.reconnect()` contract** (partysocket v1.1.4, `dist/ws.d.ts`):

```typescript
// ps.reconnect(code?: number, reason?: string) forces drop+reconnect via
// ReconnectingWebSocket's exponential backoff. Passing code=4000 reason='cm-foreground'
// is a debug affordance; partysocket doesn't interpret these beyond logging.
ps.reconnect(4000, 'cm-foreground')
```

**YProvider reconnect** (y-partyserver 2.1.4):

```typescript
// No public .reconnect(); use disconnect+connect idempotently.
// provider.connect() is safe to call when already connected — internally no-ops.
provider.disconnect()
provider.connect()
```

**YProvider liveness signals** (y-partyserver 2.1.4):

```typescript
// 'synced' observable fires on initial and post-reconnect sync completion
provider.on('sync', (isSynced: boolean) => { if (isSynced) bumpLastSeen() })
// Awareness updates fire on every remote presence change (cursor, typing, etc.)
provider.awareness.on('update', () => bumpLastSeen())
// Both unsubscribe via .off(event, fn) — mirror the subscribe pattern
```

**Module-level singleton pattern** (mirror `use-user-stream.ts:41-66`):

```typescript
// Module-level state, accessed by both hook consumers and registry.register
let sockets = new Map<string, ManagedConnection>()
let listeners = new Set<(snapshot: ReadonlyArray<ManagedConnection>) => void>()
// ...export functions that mutate this state
```

**Per-connection random stagger:**

```typescript
const delay = Math.floor(Math.random() * 500) // [0, 500) ms
const timer = setTimeout(() => conn.reconnect(), delay)
pendingTimers.set(conn.id, timer)
```

### Gotchas

- **PartySocket's `.readyState` is mutable, not React state.** If you read it in a React effect dep array it won't trigger re-renders. The existing pattern at `use-coding-agent.ts:529-542` mirrors it through `useState`+`addEventListener`; the adapter doesn't need to — it just exposes the live mutable value for the registry.
- **YProvider doesn't emit DOM events.** It's an `lib0/observable` with string-keyed `.on(event, fn)`. The adapter translates between the DOM-event shape the registry expects and the observable pattern — don't expect `provider.addEventListener` to exist.
- **React StrictMode double-mount** fires the register effect twice. Registry tolerates this via replace-with-warning; don't throw.
- **`@capacitor/network` on native** returns `{ connected: boolean, connectionType: 'wifi'|'cellular'|'none'|'unknown' }`. Use `connected`, not `connectionType`.
- **`App.appStateChange` doesn't fire on initial launch** — it only fires on subsequent transitions. Don't rely on it for initial online detection; seed via `Network.getStatus()` on subscribe.
- **`visibilitychange` on Capacitor** fires redundantly with `appStateChange` on most Android versions. That's fine — reconnect is idempotent on `lastSeenTs` gate.
- **Sideloading collision** per CLAUDE.md: `INSTALL_FAILED_UPDATE_INCOMPATIBLE` means debug/release signing mismatch — `adb uninstall com.baseplane.duraclaw` then retry.
- **Registry must expose on `window` only in DEV** (`import.meta.env.DEV`) — never in production, it's a debug affordance and exposing in prod leaks implementation.

### Reference Docs

- `https://capacitorjs.com/docs/apis/app` — `@capacitor/app` API surface (`appStateChange` is the only event we use).
- `https://capacitorjs.com/docs/apis/network` — `@capacitor/network` API surface (`getStatus()` + `networkStatusChange`).
- `https://github.com/cloudflare/partykit/tree/main/packages/partysocket` — PartySocket + ReconnectingWebSocket reconnect semantics.
- `https://github.com/cloudflare/partykit/tree/main/packages/y-partyserver` — y-partyserver provider reconnect (internal `_reconnectWS()` is not public; use disconnect+connect).
- Research doc: `planning/research/2026-04-21-do-topology-collapse-connection-manager.md` — full context including cost analysis, CF DO constraints, and why this is Option A not Option B.
