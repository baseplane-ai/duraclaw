---
initiative: rn-pivot-p3-native
type: project
issue_type: feature
status: approved
priority: high
github_issue: 132
created: 2026-04-30
updated: 2026-04-30
approved_by: b3nfreed@gmail.com
approved_at: 2026-04-30
predecessors:
  - "GH#125 / PR #127 — P1 Tamagui adoption (merged 2026-04-28)"
  - "GH#131 — P2 RNW universalization (closed 2026-04-29)"
research:
  - "planning/research/2026-04-23-react-native-pivot-evaluation.md (parent strategy)"
  - "planning/research/2026-04-30-gh132-p3-rn-native-target.md (P0 + P1 findings)"
phases:
  - id: p3.0
    name: "Pre-spike — hard go/no-go gate (4 risks, ~2 days)"
    tasks:
      - "Risk #1 (auth): install @better-auth/expo, verify its exported surface against apps/orchestrator/src/lib/auth-client.ts:13-23 + platform.ts:72-95 fetch interceptor + WS bearer at use-coding-agent.ts:415; document API mismatch (if any) and decide wrapper vs direct use"
      - "Risk #2 (SQLite): install op-sqlite under Expo SDK 55 prebuild, verify pod/gradle build green on Fabric/New Architecture, run a 10-row write/read smoke against op-sqlite raw API. If fails: install expo-sqlite as fallback and verify the same."
      - "Risk #3 (Tamagui + Reanimated 4): scaffold a throwaway Expo SDK 55 app importing @tamagui/core (existing 2.0.0-rc.41 pin) + react-native-reanimated@4.x. Verify native animation driver composes (one Stack with $platform-native animation prop renders without crash). Risk: Tamagui's animation driver may not have published Reanimated 4 support."
      - "Risk #4 (SDK 55 GA + dep tree): confirm Expo SDK 55 is GA at spec-lock time (npm view expo@latest version | check release notes for stable). Confirm @react-native-firebase/messaging, @react-native-community/netinfo, expo-secure-store, expo-audio, react-native-reanimated-dnd all publish SDK-55-compatible versions."
      - "Spike output: planning/research/2026-04-3X-gh132-p3-spike-results.md with green/yellow/red per risk. **Hard gate:** if any risk is red, STOP. Open follow-up issue with the unblocking conditions; do not enter P3.1."
    test_cases:
      - id: p3.0-1
        description: "Spike doc committed to planning/research/ with explicit verdict per risk; PR comment summarizes go/no-go"
        type: smoke
      - id: p3.0-2
        description: "If go: each of the 4 risks has a green or documented-yellow verdict with reproducer steps in the doc"
        type: smoke
  - id: p3.1
    name: "Expo target bootstrap — new package, signing, navigation skeleton (~1-2 days)"
    tasks:
      - "Create apps/mobile-expo/ as new Expo SDK 55 project (or rename apps/mobile/ to apps/mobile-capacitor/ first; pick layout). app.json `android.package` = **com.baseplane.duraclaw.rn** (locked per Decision 7). Implements B1."
      - "(implements B1) Wire apps/mobile-expo/ into pnpm workspace (package.json @duraclaw/mobile-expo) and Turbo pipeline"
      - "(implements B1) Pin Expo SDK 55, react-native, @react-navigation/native, @react-navigation/native-stack, @react-navigation/bottom-tabs, react-native-reanimated@4, react-native-gesture-handler@2, react-native-safe-area-context, react-native-screens"
      - "(implements B1) Generate Android signing keystore (or reuse existing with key alias under new package com.baseplane.duraclaw.rn). apps/mobile-expo/scripts/sign-android.sh adapts apps/mobile/scripts/sign-android.sh to the new package. Document key location + env vars"
      - "(implements B1) Evolve apps/orchestrator/src/entry-rn.tsx from P2's smoke-bundle entry to the production AppRegistry entry. AppRegistry.registerComponent('main', () => RootApp). RootApp wraps NavigationContainer + linking config"
      - "(implements B1) Author apps/orchestrator/src/native/navigation.tsx — React Navigation tree mirroring the 10 TanStack routes (per research §6 mapping table). BottomTabs (or Drawer) for _authenticated layout; native-stack inside each tab"
      - "(implements B1) Smoke test: `pnpm --filter @duraclaw/mobile-expo build:android` produces a signed APK, sideloads to dev device via adb, launches to login screen. No crash on cold-start."
    test_cases:
      - id: p3.1-1
        description: "Signed APK installs on dev device under new package id; package name visible in `adb shell pm list packages | grep duraclaw`"
        type: smoke
      - id: p3.1-2
        description: "App launches, renders Login screen via React Navigation native-stack; back-button on Android closes app (no crash)"
        type: smoke
      - id: p3.1-3
        description: "Old Capacitor APK (com.baseplane.duraclaw) and new Expo APK (new package) coexist on the same device — both install successfully, neither corrupts the other"
        type: smoke
  - id: p3.2
    name: "Adapter ports — auth, SQLite, lifecycle, push (~2 days, mostly-parallel; parallel-1 auth + parallel-3 lifecycle share platform.ts as a read dependency, coordinate import shape)"
    tasks:
      - "[parallel-1, auth] (implements B2) Replace better-auth-capacitor dynamic import in apps/orchestrator/src/lib/auth-client.ts with @better-auth/expo (per P3.0 risk #1 verdict). If wrapper needed: write apps/orchestrator/src/lib/auth-client-expo.ts as the thin shim. Update isNative() / Platform.OS branch in auth-client.ts to select expo path on native"
      - "[parallel-1, auth] (implements B2) Update apps/orchestrator/src/lib/platform.ts:72-95 fetch interceptor: replace `import('better-auth-capacitor/client')` with `import('@better-auth/expo')` (or shim). Token storage backend: expo-secure-store. Storage key: 'better-auth:token' (parity with Capacitor)"
      - "[parallel-1, auth] (implements B2) Update apps/orchestrator/src/features/agent-orch/use-coding-agent.ts:409-449 WS bearer fetch — same import swap"
      - "[parallel-2, SQLite] (implements B3) Author packages/op-sqlite-tanstack-persistence/ (new workspace package, ~200 LOC) — mirrors @tanstack/capacitor-db-sqlite-persistence interface. Implements: write, read, query, delete, transaction, schemaVersion. Delegates to op-sqlite JSI bindings"
      - "[parallel-2, SQLite] (implements B3) Author apps/orchestrator/src/db/persistence-op-sqlite.ts mirroring persistence-capacitor.ts shape. Hot-reload guard via op-sqlite's connection lifecycle"
      - "[parallel-2, SQLite] (implements B3) Update apps/orchestrator/src/db/db-instance.ts:35-44 selector — Platform.OS === 'native' → persistence-op-sqlite (was: isNative() → persistence-capacitor). Web path unchanged"
      - "[parallel-3, lifecycle] (implements B4) Replace Capacitor App + Network listeners in apps/orchestrator/src/lib/connection-manager/lifecycle.ts:69-113 with AppState + @react-native-community/netinfo. Map: appStateChange→AppState.addEventListener('change'); networkStatusChange→NetInfo.addEventListener. Seed via NetInfo.fetch() on init. Web fallback (visibilitychange + window.online/offline) unchanged"
      - "[parallel-4, push] (implements B5) Replace @capacitor/push-notifications in apps/orchestrator/src/hooks/use-push-subscription-native.ts and apps/orchestrator/src/lib/native-push-deep-link.ts with @react-native-firebase/messaging. Token via messaging().getToken() + messaging().onTokenRefresh(). Foreground via messaging().onMessage. Tap via messaging().onNotificationOpenedApp. **Cold-start: messaging().getInitialNotification()** must run before React mount in entry-rn.tsx (mirror initNativePushDeepLink pattern). Existing /api/push/fcm-subscribe endpoint accepts the new tokens unchanged"
      - "[parallel-4, push] (implements B5) **Regenerate google-services.json** from Firebase Console with the new package `com.baseplane.duraclaw.rn` added to the existing project (or copy + edit if Firebase Console UI confirms package add). Place at apps/mobile-expo/android/app/google-services.json. Do NOT just copy apps/mobile/android/app/google-services.json verbatim — the package name inside the JSON must match the new Expo package or FCM token registration silently fails. Permission flow: cold-start prompt parity (no UX redesign)"
    test_cases:
      - id: p3.2-1
        description: "Sign in via email+password on signed APK → token stored in expo-secure-store (verify via expo-secure-store getItemAsync('better-auth:token') in dev menu or temporary log line, removed before merge)"
        type: smoke
      - id: p3.2-2
        description: "Open WS to /api/sessions/:id stream → server log shows successful auth via _authToken query param hoisted to bearer header (apps/orchestrator/src/server.ts:101-106)"
        type: smoke
      - id: p3.2-3
        description: "Process-kill app, relaunch — token persists, no re-sign-in required, fetches succeed"
        type: smoke
      - id: p3.2-4
        description: "Open a session, send 5+ messages, kill app, relaunch — messages render from op-sqlite cache (no flash-to-empty), then live updates resume on WS reconnect"
        type: smoke
      - id: p3.2-5
        description: "Toggle airplane mode on/off → connection-manager logs '[cm-lifecycle] online' / 'offline' events with correct ordering"
        type: smoke
      - id: p3.2-6
        description: "Send a test FCM push (server-side via push-fcm.ts) while app in foreground → onMessage fires, notification renders. Background → onNotificationOpenedApp on tap routes to correct session. Cold-start (kill app, tap notification from system tray) → app launches and routes to correct session"
        type: smoke
  - id: p3.3
    name: "Screen migration + feature gates + kanban (~1-2 days)"
    tasks:
      - "(implements B1) Map all 10 TanStack routes (apps/orchestrator/src/routes/**) to React Navigation screens per research §6 table. Shared screen components stay in apps/orchestrator/src/features/* and apps/orchestrator/src/components/*; native nav lives in apps/orchestrator/src/native/navigation.tsx"
      - "(implements B7) Kanban: replace @dnd-kit usage in apps/orchestrator/src/features/kanban/KanbanBoard.tsx with react-native-reanimated-dnd primitives on native (Platform.OS === 'native' branch). Web keeps @dnd-kit. ~200 LOC integration"
      - "(implements B8) Feature-gate xyflow on native: Platform.OS check in packages/ai-elements/src/components/canvas.tsx + node.tsx + edge.tsx + controls.tsx + panel.tsx + toolbar.tsx + connection.tsx. Render <Text>Diagram available on web only</Text> placeholder when Platform.OS === 'native'"
      - "(implements B8) Feature-gate react-jsx-parser on native: same Platform.OS check in packages/ai-elements/src/components/jsx-preview.tsx. Placeholder: <Text>Live JSX preview available on web only</Text>"
      - "(implements B8) Feature-gate Rive on native: Platform.OS check in packages/ai-elements/src/components/persona.tsx. Placeholder: static SVG/Tamagui-rendered avatar (~30 LOC)"
      - "(implements B8) Feature-gate media-chrome on native: Platform.OS check in packages/ai-elements/src/components/audio-player.tsx. Placeholder: <Text>Audio playback available on web only</Text> (no expo-audio replacement in P3 — single user, deferred)"
      - "(implements B8) Feature-gate cmdk on native: Platform.OS check in packages/ai-elements/src/ui/command.tsx. Native fallback: simple FlatList + TextInput modal (~50 LOC)"
      - "(implements B8) Feature-gate embla on native: Platform.OS check in packages/ai-elements/src/ui/carousel.tsx. Native fallback: ScrollView with horizontal+pagingEnabled (~30 LOC)"
      - "(implements B9) Replace use-stick-to-bottom on native: packages/ai-elements/src/components/conversation.tsx — Platform.OS branch using FlatList onMomentumScrollEnd + state to pin scroll-to-bottom on chat (~90 LOC). Web keeps use-stick-to-bottom"
      - "(implements B8) Verify P2's Biome ban (biome.json:93-111) still passes — apps/orchestrator/src/** must not import any of the 4 banned libs directly. Native fallbacks live in packages/ai-elements/** (allowed by current rule)"
    test_cases:
      - id: p3.3-1
        description: "All 10 routes navigable on native device — login → dashboard (BottomTabs) → session detail → settings → projects/$projectId/docs → admin (3 panels) → board → deploys"
        type: smoke
      - id: p3.3-2
        description: "Kanban board on native: drag a card between columns; drop is detected; reorder persists across re-render. Web kanban (dnd-kit) still functional after the conditional branch is added"
        type: smoke
      - id: p3.3-3
        description: "Trigger a session that would render xyflow / JSX-preview / Rive persona / media-chrome on web — on native, placeholder text renders without crash. No Biome lint failure (banned libs not in apps/orchestrator/src/**)"
        type: smoke
      - id: p3.3-4
        description: "Chat thread on native auto-pins to bottom when new messages stream in; manual scroll-up unpins; scroll back to bottom re-pins (use-stick-to-bottom replacement)"
        type: smoke
  - id: p3.4
    name: "OTA self-host on R2 + Worker via expo-updates protocol (~1-2 days)"
    tasks:
      - "(implements B6) Implement Worker route GET /api/mobile/eas/manifest implementing expo-updates protocol (per docs.expo.dev/distribution/custom-updates-server). Reads runtimeVersion + platform + channel from query params. Reads `ota/expo/<runtimeVersion>/<platform>/<channel>/latest.json` from R2 to get the current updateId; reads `ota/expo/<runtimeVersion>/<platform>/<updateId>/metadata.json` to construct the manifest; asset URLs reference `/api/mobile/eas/assets/ota/expo/<runtimeVersion>/<platform>/<updateId>/<file>`. Public route (pre-authMiddleware in apps/orchestrator/src/api/index.ts, parity with /api/mobile/updates/manifest)"
      - "(implements B6) Implement Worker route GET /api/mobile/eas/assets/* — streams assets from duraclaw-mobile R2 bucket. Same MOBILE_ASSETS binding (declare optional on Env type if not already)"
      - "(implements B6) Add scripts/build-mobile-expo-ota.sh that runs `expo export --platform android` (path validated in spike), uploads per-update objects under `ota/expo/<runtimeVersion>/android/<updateId>/{bundle.hbc, metadata.json, assets/...}`, then atomically writes the pointer at `ota/expo/<runtimeVersion>/android/production/latest.json` (contents: `{updateId, createdAt}`). Pointer-write happens last so a partial upload doesn't break the manifest endpoint."
      - "(implements B6) Update apps/mobile-expo/app.json: updates.url = 'https://dura.example.com/api/mobile/eas/manifest', runtimeVersion strategy = 'fingerprint' (locked default; validated in spike). channel = 'production'"
      - "(implements B6) Add CI step in deploy pipeline that runs scripts/build-mobile-expo-ota.sh after orchestrator build (parallel to existing scripts/build-mobile-ota-bundle.sh which keeps running for the Capacitor APK during the brief sunset window)"
      - "(implements B6) Update .claude/rules/deployment.md with the new pipeline contract (per research §5): self-hosted EAS Update routes, R2 layout (the per-update + pointer scheme above), runtimeVersion strategy, fingerprint check"
    test_cases:
      - id: p3.4-1
        description: "Push a JS-only change → CI runs scripts/build-mobile-expo-ota.sh → R2 has new bundle under ota/expo/<runtimeVersion>/. Live native app opens, polls /api/mobile/eas/manifest, downloads bundle, applies on next mount (no APK reinstall needed)"
        type: smoke
      - id: p3.4-2
        description: "Push a native-code change (e.g., bump @react-native-firebase/messaging) → fingerprint changes → CI runs full eas build, produces new APK. Old runtime version's clients reject the new manifest (runtimeVersion mismatch); new APK install picks up the new manifest cleanly"
        type: smoke
      - id: p3.4-3
        description: "Worker route /api/mobile/eas/manifest returns valid expo-updates JSON shape (assert with curl + jq); /api/mobile/eas/assets/<key> streams binary correctly; both routes are public (no 401 on unauthenticated request)"
        type: smoke
  - id: p3.5
    name: "Use-and-fix dogfood + Capacitor sunset + CI gate swap (~1 day)"
    tasks:
      - "(implements B11) Single user (b3nfreed@gmail.com) installs the new Expo APK alongside the Capacitor APK. Uses the new app for normal work for at least one full day"
      - "(implements B2,B3,B4,B5,B6) Spot-check the spike acceptance criteria during normal use: sign-in survives reboot; messages persist across kill+relaunch; branch/rewind keeps messagesCollection coherent; push tap routes correctly; OTA delivers a JS-only update without APK reinstall; airplane-mode toggle handled cleanly"
      - "Bug triage: any issue found during use-and-fix → fix on the same branch (no separate issues unless deferring). Land fixes incrementally"
      - "(implements B11) Capacitor sunset (immediate): once user confirms they're not launching com.baseplane.duraclaw any more, uninstall the old APK from their device. Capgo channel is dead (no traffic). Mark planning/specs/26-capacitor-android-mobile-shell.md status as 'sunset' with date + GH#132 reference. Do NOT delete apps/mobile/ or scripts/build-mobile-ota-bundle.sh in this PR — leave for a follow-up cleanup commit (preserves git blame + revert path during the dogfood week)"
      - "(implements B10) CI gate swap: replace scripts/check-metro-bundle.sh with scripts/check-expo-prebuild.sh that runs `npx expo prebuild --no-install --platform android` and exits 0 on success. Wire into apps/orchestrator/package.json typecheck script (replacing the metro-bundle gate). Keep scripts/check-worker-tamagui-leak.sh unchanged"
      - "Edit GH#132 issue title: 'P3: native target via Expo SDK 55 (Android-only) — RN pivot phase 3' (overrides original SDK 54 + iOS+Android framing). Add a comment summarizing the SDK 55 + Android-only + new-package decisions"
      - "Open follow-up issue 'Cleanup: remove apps/mobile/ + scripts/build-mobile-ota-bundle.sh + Capacitor OTA Worker routes (post-GH#132 sunset)' — scoped to delete dead code 1-2 weeks after this lands"
    test_cases:
      - id: p3.5-1
        description: "User reports 'I'm using the new app for normal work; old app uninstalled' — captured in PR description or close comment"
        type: smoke
      - id: p3.5-2
        description: "scripts/check-expo-prebuild.sh exits 0 on clean main; pnpm typecheck passes including the new gate"
        type: smoke
      - id: p3.5-3
        description: "GH#132 title updated; follow-up cleanup issue exists and is linked from GH#132"
        type: smoke
---

# P3: Native target via Expo SDK 55 (Android-only) — RN pivot phase 3

> GitHub Issue: [#132](https://github.com/baseplane-ai/duraclaw/issues/132)
> Predecessors: GH#125 (P1 Tamagui), GH#131 (P2 RNW universalization)
> Research: [parent strategy](../research/2026-04-23-react-native-pivot-evaluation.md), [P0+P1 findings](../research/2026-04-30-gh132-p3-rn-native-target.md)

## Decisions overriding the issue body

The issue body was written before the P0/P1 work. The following 16
decisions, locked during P1, override the issue body where they
conflict. See `planning/research/2026-04-30-gh132-p3-rn-native-target.md`
§"Decisions Log" for the full rationale per entry.

1. **Expo SDK 55**, not 54 (kanban path requires `react-native-reanimated-dnd` which needs SDK 55)
2. **Android only** for P3; iOS deferred to P4 (issue title said "iOS + Android")
3. **Auth**: use `@better-auth/expo` directly; thin wrapper only on API mismatch (issue body said write `better-auth-react-native` from scratch)
4. **SQLite**: op-sqlite + custom TanStack DB persistence adapter port (~200 LOC); `expo-sqlite + memo guard` is the documented fallback
5. **Kanban**: real native via `react-native-reanimated-dnd` (not feature-gated)
6. **EAS Update**: self-host on R2 + Worker via the `custom-expo-updates-server` reference protocol (issue body listed Capgo replacement only)
7. **App ID**: new package **`com.baseplane.duraclaw.rn`** (locked), side-by-side install with Capacitor APK during the brief dogfood transition
8. **Capacitor sunset: immediate** upon GA (single production user; no parallel maintenance window)
9. **Push permission UX**: cold-start prompt parity with Capacitor (no contextual-prompt redesign)
10. **Risky-libs (xyflow, jsx-parser, Rive, media-chrome)**: all four feature-gated to web-only on native; no native replacements in P3
11. **Secondary libs (cmdk, embla)**: feature-gate to web-only on native; replace `use-stick-to-bottom` only (load-bearing for chat scroll UX)
12. **GA gate**: light VP, "use and fix" continuous deployment shape; P3.0 pre-spike remains a hard go/no-go
13. **iOS confirmed deferred to P4** (no provisioning, no TestFlight, no App Store work in P3)
14. **Branch + PR**: feature branch `feat/gh132-p3-rn-native` per CLAUDE.md feature-scope rule
15. **CI gate evolution**: replace `scripts/check-metro-bundle.sh` with `expo prebuild --no-install` smoke once P3 ships
16. **Issue title**: edit GH#132 title to reflect SDK 55 + Android-only at P3.5 close

## Architectural bets (hard to reverse)

- **B1**: Expo SDK 55 (kanban-driven; reverting drops `react-native-reanimated-dnd`)
- **B2**: New package, not in-place upgrade of `com.baseplane.duraclaw`
- **B3**: Self-hosted EAS Update on our R2/Worker (not Expo CDN default)
- **B4**: Reanimated 4 worklets as native animation runtime (required by reanimated-dnd; locks Tamagui's native animation driver compatibility)

## Open risks (tracked through P3.0 spike)

- **R1** SDK 55 GA timing — fall back to SDK 54 + kanban feature-gate if SDK 55 not GA
- **R2** `@better-auth/expo` API shape — may force a local wrapper after all
- **R3** op-sqlite + SDK 55 Fabric — fall back to expo-sqlite if pod/gradle break
- **R4** Tamagui native animation driver + Reanimated 4 — may conflict; mitigation TBD in spike
- **R5** Self-hosted EAS Update protocol gaps in `custom-expo-updates-server` reference — fall back to Expo CDN default

## Overview

Phase 3 of the RN pivot. Add a real native Android target via Expo SDK
55, replacing each Capacitor seam (auth, SQLite, push, OTA, lifecycle,
network, WebView WS) with its RN-native equivalent. P1 (Tamagui) and
P2 (RNW universalization, Metro smoke gate, Biome ban on web-only libs
in `apps/orchestrator/src/**`) already shipped — this builds on top of
that universal component tree to swap the runtime substrate from
Capacitor WebView to React Native + Expo. The single production user
transitions to the new APK; the old Capacitor APK retires immediately
upon GA. iOS and the Maestro/AI-codegen eval harness are P4.

## Feature Behaviors

### B1: Expo SDK 55 native shell with React Navigation

**Core:**
- **ID:** expo-shell-bootstrap
- **Trigger:** User launches the new Expo APK on a signed-Android device.
- **Expected:** App boots through `entry-rn.tsx` → `AppRegistry.registerComponent('main', ...)` → `NavigationContainer` with linking config → renders Login screen (unauthenticated) or Dashboard (authenticated, post-token-load). React Navigation native-stack handles screen transitions; BottomTabs.Navigator (or Drawer on tablet) hosts the `_authenticated` layout.
- **Verify:** `pnpm --filter @duraclaw/mobile-expo build:android` produces a signed APK; `adb install` succeeds; `adb shell am start -n <package>/.MainActivity` launches to Login or Dashboard depending on stored auth state. No crash in `adb logcat`.
**Source:** new files: `apps/mobile-expo/`, `apps/orchestrator/src/native/navigation.tsx`. Modified: `apps/orchestrator/src/entry-rn.tsx` (evolves from P2's smoke entry).

#### UI Layer
- React Navigation native-stack for detail screens (session, settings, project docs, deploys, admin)
- BottomTabs.Navigator for `_authenticated` layout (replaces TanStack Router web sidebar; tablet/large screens may use Drawer per layout-provider breakpoints)
- All screens shared with web via Tamagui + RNW (per parent research §10.4); kanban is partial-fork (B7)
- Linking config: scheme `<package-name>://`, plus universal-link prefixes for `getInitialURL()` cold-start support

#### Data Layer
- No DO/D1 schema changes. Native shell is a render-substrate swap.

### B2: Auth via `@better-auth/expo` (or thin shim)

**Core:**
- **ID:** auth-expo-adapter
- **Trigger:** User signs in via email+password on the native Login screen.
- **Expected:** Token returned by Better Auth's `set-auth-token` response header is stored in `expo-secure-store` under key `better-auth:token`. All subsequent fetches to `apiBaseUrl()` carry `Authorization: Bearer <token>`. WS handshake uses `_authToken` query param (server hoists to header at `apps/orchestrator/src/server.ts:101-106`). Token survives process kill and reboot.
- **Verify:** Sign in → kill app via swipe → reopen → fetches succeed without re-sign-in. Reboot device → reopen → same. WS connection log shows successful auth on cold-start.
**Source:** Modified: `apps/orchestrator/src/lib/auth-client.ts:13-23`, `apps/orchestrator/src/lib/platform.ts:72-95`, `apps/orchestrator/src/features/agent-orch/use-coding-agent.ts:409-449`. Possibly new: `apps/orchestrator/src/lib/auth-client-expo.ts` (thin wrapper) — only if P3.0 risk #1 verdict requires it.

#### API Layer
- **No server-side changes**. `apps/orchestrator/src/lib/auth.ts:47-74` Better Auth bearer plugin already accepts `Authorization: Bearer` from any client.

#### Data Layer
- Token in `expo-secure-store` (Keychain/Keystore-backed). Storage key `better-auth:token` matches Capacitor Preferences convention.

### B3: SQLite via op-sqlite + custom TanStack DB persistence adapter

**Core:**
- **ID:** sqlite-op-adapter
- **Trigger:** App boot — `dbReady` resolves before `messagesCollection` / `branchInfoCollection` first reads.
- **Expected:** On native, `db-instance.ts:35-44` selects `persistence-op-sqlite.ts` (was: `persistence-capacitor.ts`). All TanStack DB persistence methods (write, read, query, delete, transaction, schemaVersion) delegate to op-sqlite JSI bindings. Schema-version mismatch wipes + resyncs from server (no migration needed — fresh native target). Insert latency <5ms for typical message payload.
- **Verify:** Send 10+ messages in a session → kill app → relaunch → messages render from cache instantly (no flash-to-empty). Branch a turn → rewind → `messagesCollection` content before the branch point unchanged. `pnpm typecheck` passes; new package builds.
**Source:** New: `packages/op-sqlite-tanstack-persistence/` (~200 LOC), `apps/orchestrator/src/db/persistence-op-sqlite.ts`. Modified: `apps/orchestrator/src/db/db-instance.ts:35-44`.

#### Data Layer
- New SQLite database file under op-sqlite's default data dir (Android internal storage). Schema versions: `messagesCollection` v6, `branchInfoCollection` v3, `userTabs` v1 (existing — no version bump for the engine swap).
- **Migration policy**: none. RN target is fresh install; users get an empty op-sqlite DB and resync from server on first connect.
- **Fallback** (per R3): if op-sqlite blocks, swap to `expo-sqlite` + `memo` guard around SQLiteProvider (per expo#37169 resolution in PR #37872).

### B4: Lifecycle (AppState) + Network (NetInfo) replacing Capacitor

**Core:**
- **ID:** rn-lifecycle-network
- **Trigger:** OS lifecycle events (foreground/background) and network changes (Wi-Fi↔LTE, airplane mode toggle).
- **Expected:** `connection-manager/lifecycle.ts:69-113` emits the same `foreground/background/online/offline` events to its `listeners` Set as on Capacitor, but sourced from `AppState.addEventListener('change', ...)` and `NetInfo.addEventListener(...)`. `NetInfo.fetch()` seeds initial state on init. Wi-Fi↔LTE handoff (a #70 pain point) is detected via NetInfo's `type` field — preserved as available signal but not emitted as a distinct event in P3.
- **Verify:** Toggle airplane mode on/off → log shows `[cm-lifecycle] offline` then `[cm-lifecycle] online` in correct order. Background app via home button → `[cm-lifecycle] background` logged. Resume → `foreground`. Connection-manager's reconnect logic (existing) responds correctly.
**Source:** Modified: `apps/orchestrator/src/lib/connection-manager/lifecycle.ts:69-113`. Web fallback (lines 58-63) unchanged.

### B5: Push notifications via @react-native-firebase/messaging

**Core:**
- **ID:** rn-firebase-push
- **Trigger:** App boot (token registration), backend FCM send (foreground render + background tap routing).
- **Expected:** On boot, `messaging().getToken()` returns FCM token; token POSTed to `/api/push/fcm-subscribe` (existing endpoint, unchanged). Foreground messages render via `messaging().onMessage(...)`. Tap on backgrounded notification fires `messaging().onNotificationOpenedApp(...)` → routes to session via existing deep-link handler. **Cold-start tap**: `messaging().getInitialNotification()` invoked in `entry-rn.tsx` BEFORE React mount; result stored in pending slot, drained by `AgentOrchContent` mount effect (mirrors existing `initNativePushDeepLink` pattern at `entry-client.tsx:37`).
- **Verify:** Server-side trigger via `push-fcm.ts` test harness or admin route → device receives notification. Tap notification (cold-start) → app opens to correct session. Foreground notification renders without crash. `adb logcat | grep FCM` shows token registration on first launch.
**Source:** Modified: `apps/orchestrator/src/hooks/use-push-subscription-native.ts`, `apps/orchestrator/src/lib/native-push-deep-link.ts`, `apps/orchestrator/src/entry-rn.tsx`. Reused: `apps/mobile/android/app/google-services.json` → `apps/mobile-expo/android/app/google-services.json` (RN-Firebase Gradle plugin reads same shape).

#### API Layer
- **No server-side endpoint changes**. `/api/push/fcm-subscribe` accepts the new tokens unchanged. `apps/orchestrator/src/lib/push-fcm.ts` FCM HTTP v1 sender is client-agnostic.

#### Data Layer
- FCM tokens for new package register fresh under the new app id. Old tokens (under `com.baseplane.duraclaw`) deprecate naturally as the user stops launching the Capacitor app.

### B6: Self-hosted EAS Update via R2 + Worker

**Core:**
- **ID:** eas-update-self-host
- **Trigger:** App boot or `Updates.checkForUpdateAsync()` call (built-in `expo-updates` poll cadence) detects a newer JS bundle on the manifest endpoint.
- **Expected:** Worker route `GET /api/mobile/eas/manifest` returns expo-updates protocol JSON keyed by runtimeVersion + platform + channel; asset URLs point to `GET /api/mobile/eas/assets/<key>` which streams from `duraclaw-mobile` R2 bucket. Client downloads, applies on next mount, falls back automatically if the new bundle crashes on launch (built-in EAS rollback). Pipeline: `scripts/build-mobile-expo-ota.sh` builds + uploads to R2 under `ota/expo/<runtimeVersion>/<updateId>/` on every orchestrator deploy.
- **Verify:** Push a JS-only orchestrator change → CI runs OTA script → R2 has new objects. Open native app → `expo-updates` polls, downloads, applies on next mount (verify via in-app version stamp or `Updates.runtimeVersion`/`Updates.updateId`). `curl /api/mobile/eas/manifest?runtimeVersion=...&platform=android&channel=production` returns valid expo-updates JSON.
**Source:** New: `apps/orchestrator/src/api/mobile/eas-manifest.ts`, `apps/orchestrator/src/api/mobile/eas-assets.ts` (Hono routes), `scripts/build-mobile-expo-ota.sh`. Modified: `apps/orchestrator/src/api/index.ts` (mount routes pre-authMiddleware, parity with existing `/api/mobile/updates/manifest`), `apps/mobile-expo/app.json` (updates.url + runtimeVersion strategy + channel), `.claude/rules/deployment.md`.

#### API Layer
- `GET /api/mobile/eas/manifest` — public, returns expo-updates manifest JSON (per docs.expo.dev/distribution/custom-updates-server).
- `GET /api/mobile/eas/assets/*` — public, streams R2 objects via `MOBILE_ASSETS` binding.
- Both routes registered BEFORE `authMiddleware` (parity with `/api/mobile/updates/manifest`).

#### Data Layer
Canonical R2 layout for self-hosted EAS Update (the build script writes per-update objects first, then atomically updates the pointer; the manifest route reads the pointer first to learn which updateId is current):

```
duraclaw-mobile (R2 bucket)
├── ota/expo/<runtimeVersion>/<platform>/<updateId>/
│   ├── bundle.hbc            # Hermes bytecode JS bundle
│   ├── metadata.json         # asset hashes, launchAsset key, expo-updates fields
│   └── assets/<hash>         # static assets keyed by content hash
├── ota/expo/<runtimeVersion>/<platform>/<channel>/latest.json
│                              # pointer: { updateId: "<uuid>", createdAt: "<iso>" }
│                              # written ATOMICALLY after per-update objects exist
├── ota/bundle-<sha>.zip      # legacy Capgo, kept until sunset
├── ota/version.json          # legacy Capgo pointer
└── apk/...                   # legacy native APK fallback
```

**Read path (manifest route)**: `<channel>/latest.json` → `<updateId>/metadata.json` → assemble manifest with asset URLs pointing at `/api/mobile/eas/assets/<R2 key>`.

**Write path (build script)**: upload bundle + metadata + assets first, then write `latest.json` last. Partial uploads never break the manifest endpoint.

### B7: Kanban via react-native-reanimated-dnd

**Core:**
- **ID:** rn-kanban
- **Trigger:** User opens `/board` route on native; drags a card between columns or reorders within a column.
- **Expected:** Kanban renders as multi-column board with `react-native-reanimated-dnd` Draggable + Droppable primitives. Drag-between-columns updates server state via existing kanban API (no protocol change). Web build (TanStack Router → KanbanBoard.tsx) keeps the existing @dnd-kit implementation under `Platform.OS === 'web'` branch. ~200 LOC integration.
- **Verify:** On native: drag card from column A to column B; release; card persists in column B after re-render. Reorder within a column works. Confirmation modal (existing UX) fires on drop.
**Source:** Modified: `apps/orchestrator/src/features/kanban/KanbanBoard.tsx` (Platform.OS branch), `apps/mobile-expo/package.json` (add `react-native-reanimated-dnd`).

### B8: Risky-lib feature gates (web-only on native)

**Core:**
- **ID:** risky-libs-web-only
- **Trigger:** A native screen renders a component that imports xyflow / jsx-parser / Rive / media-chrome / cmdk / embla.
- **Expected:** Each component file in `packages/ai-elements/src/components/` (canvas, jsx-preview, persona, audio-player) and `packages/ai-elements/src/ui/` (command, carousel) wraps its web-only content in a `Platform.OS === 'web'` branch. Native render path returns a placeholder `<Text>` element or simple RN-native fallback (cmdk → FlatList+TextInput modal, embla → ScrollView pagingEnabled). No native imports of the banned libraries. P2's Biome rule (`biome.json:93-111`) continues to pass against `apps/orchestrator/src/**`.
- **Verify:** Open native screens that would render xyflow / JSX-preview / Rive persona / media-chrome → placeholder text renders without crash. `pnpm lint` passes. `pnpm typecheck` passes including the Worker-leak guard.
**Source:** Modified: `packages/ai-elements/src/components/{canvas,node,edge,controls,panel,toolbar,connection,jsx-preview,persona,audio-player}.tsx`, `packages/ai-elements/src/ui/{command,carousel}.tsx`.

### B9: Replace use-stick-to-bottom on native (chat scroll pin)

**Core:**
- **ID:** chat-scroll-pin-rn
- **Trigger:** New chat message streams in while user is scrolled to (or near) bottom of the conversation view on native.
- **Expected:** `packages/ai-elements/src/components/conversation.tsx` has a `Platform.OS === 'native'` branch using FlatList's `onMomentumScrollEnd` + `onScroll` + boolean state (`pinnedToBottom`) to auto-scroll to bottom on new content when pinned. Manual scroll-up sets `pinnedToBottom = false`; scrolling back to within ~50px of bottom re-pins. Web keeps `use-stick-to-bottom`.
- **Verify:** Native: open a streaming session; messages auto-scroll to bottom. Manually scroll up; new messages do NOT auto-scroll. Scroll back to bottom; new messages auto-scroll resumes.
**Source:** Modified: `packages/ai-elements/src/components/conversation.tsx`.

### B10: CI gate evolution (Metro smoke → Expo prebuild smoke)

**Core:**
- **ID:** ci-gate-expo-prebuild
- **Trigger:** Developer runs `pnpm typecheck` (which invokes `apps/orchestrator/package.json:typecheck` script) or CI runs the same on PR.
- **Expected:** New script `scripts/check-expo-prebuild.sh` runs `npx expo prebuild --no-install --platform android --clean` against `apps/mobile-expo/` and exits 0 on success, 1 on any error. Wired into the typecheck script in place of `scripts/check-metro-bundle.sh`. `scripts/check-worker-tamagui-leak.sh` continues to run unchanged.
- **Verify:** `pnpm --filter @duraclaw/orchestrator typecheck` exits 0 on clean main. Deliberately break a native plugin import in `apps/mobile-expo/package.json` → typecheck fails. Revert.
**Source:** New: `scripts/check-expo-prebuild.sh`. Modified: `apps/orchestrator/package.json:typecheck` script. Removed (renamed to `.archive`): `scripts/check-metro-bundle.sh` (kept in tree for one PR cycle as reference, then deleted in follow-up cleanup).

### B11: Capacitor sunset (immediate post-GA)

**Core:**
- **ID:** capacitor-sunset
- **Trigger:** P3.5 use-and-fix gate passes for the single user.
- **Expected:** User uninstalls `com.baseplane.duraclaw` (Capacitor APK) from their device. Capgo OTA channel sees zero traffic. No active maintenance of `apps/mobile/`, `scripts/build-mobile-ota-bundle.sh`, or the `/api/mobile/updates/manifest` + `/api/mobile/apk/latest` Worker routes. `planning/specs/26-capacitor-android-mobile-shell.md` status updated to `sunset` with date + GH#132 reference. **Code is NOT deleted in this PR** — kept for one dogfood week as revert path; deletion happens in a follow-up cleanup issue 1-2 weeks post-merge.
- **Verify:** User confirms in PR comment or session transcript that they're not launching the old app. Capgo bucket traffic monitoring (if available) shows zero hits on `/api/mobile/updates/manifest` for 7+ days.
**Source:** Modified: `planning/specs/26-capacitor-android-mobile-shell.md` (status frontmatter). New: follow-up GH issue for cleanup.

## Non-Goals

Explicit scope exclusions, pulled from the P1 interview's Open Risks
section and Decisions Log:

1. **iOS** — no provisioning, no TestFlight, no App Store work. Deferred to P4.
2. **Maestro / visual regression / AI-codegen eval harness** — P4.
3. **Play Store submission** — single user installs APK directly (sideload). Play Store push deferred until multi-user.
4. **Tamagui native animation driver compiler-extracted optimizations** — if SDK 55 + Reanimated 4 forces runtime-evaluated animations on native, accept the perf cost; compiler-extracted animation is a P3.5+ polish issue.
5. **Native replacement for media-chrome (expo-audio)** — single user, audio playback feature isn't currently used on mobile. Feature-gate to web only; replace in a follow-up issue when usage signal exists.
6. **Native replacement for cmdk + embla** — same reason. Feature-gate; revisit on usage.
7. **Native xyflow / Rive / JSX-preview replacements** — feature-gate web-only on native.
8. **Capacitor codepath cleanup** — `apps/mobile/`, `scripts/build-mobile-ota-bundle.sh`, `/api/mobile/updates/manifest` + `/api/mobile/apk/latest` routes stay in tree during P3 dogfood. Deletion is a follow-up cleanup issue (1-2 weeks post-GA).
9. **Migration of Capacitor SQLite DB to op-sqlite** — not done. Single user gets a fresh op-sqlite DB on first launch; messages resync from server.
10. **In-place upgrade from `com.baseplane.duraclaw` (Capacitor) to a renamed package** — using a new package name. Old + new install side-by-side during the brief dogfood transition.
11. **Push permission UX redesign** — keep cold-start prompt parity with Capacitor.
12. **Multi-user / Play App Signing key migration** — single user, single device install.
13. **Expo Router migration** (Option B per parent §11.5) — Option A (TanStack Router web + React Navigation native) is the P3 default. Option B is P3.5 follow-up only if the trigger criteria (research §6) fire.

## Verification Plan

A fresh agent runs these steps verbatim. No prior context required.
Each step has a literal command, URL, or UI action and an expected
visible outcome.

### VP-1: P3.0 spike output exists and is conclusive

**Pre:** P3.0 phase complete.

```bash
ls planning/research/2026-04-3*-gh132-p3-spike-results.md
```

**Expected:** file exists. Cat it; document has explicit go/no-go verdict per risk R1-R5. If go, all four risks are green or documented-yellow with reproducer steps. If any red, P3.1+ tasks must NOT have started — verify by `git log --oneline | head -20`.

### VP-2: Signed Expo APK installs and launches

**Pre:** P3.1 phase complete.

```bash
pnpm --filter @duraclaw/mobile-expo build:android
ls apps/mobile-expo/android/app/build/outputs/apk/release/app-release-signed.apk
adb install -r apps/mobile-expo/android/app/build/outputs/apk/release/app-release-signed.apk
adb shell pm list packages | grep duraclaw
```

**Expected:** Build succeeds. APK file exists. Install reports `Success`. `pm list packages` shows BOTH the old `package:com.baseplane.duraclaw` AND the new package (e.g., `package:com.baseplane.duraclaw.rn`). Launch via:

```bash
adb shell monkey -p <new-package> -c android.intent.category.LAUNCHER 1
```

App opens to Login screen. `adb logcat | grep -i "fatal\|crash"` empty during cold-start.

### VP-3: Sign-in round-trip + token persistence

**Pre:** P3.2 phase complete; VP-2 passed.

1. Open app, sign in via email+password.
2. Verify on-screen: dashboard renders.
3. `adb shell am force-stop <new-package>` (process kill).
4. Relaunch app. **Expected:** dashboard renders without re-sign-in (token restored from `expo-secure-store`).
5. `adb shell reboot`. After boot, relaunch app. **Expected:** same — token persists across reboot.

### VP-4: WS bearer + auth round-trip

**Pre:** VP-3 passed.

Open a session detail (`/?session=<id>`). Server log (Worker tail or `wrangler tail` in dev) shows `[ws-upgrade] auth ok` for that session. No 401/4401 close codes.

```bash
adb logcat | grep -i 'ws:\|websocket\|cm-lifecycle' | tail -50
```

**Expected:** `[ws:agent-stream] open` followed by message frames. No `4401` or unexpected `close` events.

### VP-5: SQLite persistence + branch/rewind coherence

**Pre:** P3.2 phase complete.

1. Open a session. Send 5+ user messages; wait for assistant responses to stream complete.
2. `adb shell am force-stop <new-package>`.
3. Relaunch. Open same session. **Expected:** messages render from cache instantly (no spinner, no flash-to-empty).
4. Branch a turn (UI affordance on a mid-stream message). **Expected:** branchInfo row created; UI shows branch indicator.
5. Rewind to the branch. **Expected:** messages before the branch point unchanged in `messagesCollection`; messages after the branch point removed.

### VP-6: Lifecycle + network signals

**Pre:** P3.2 phase complete.

```bash
adb logcat | grep cm-lifecycle &
```

1. Toggle airplane mode ON. **Expected:** `[cm-lifecycle] offline` logged within 1s.
2. Toggle OFF. **Expected:** `[cm-lifecycle] online` logged within 2s; WS reconnects.
3. Press home button (background). **Expected:** `[cm-lifecycle] background`.
4. Resume app. **Expected:** `[cm-lifecycle] foreground`; pending WS messages drain.

### VP-7: Push notification cold-start tap routes correctly

**Pre:** P3.2 phase complete; FCM token registered (verified by checking `agent_sessions` D1 table or push subscriptions table).

1. Trigger a server-side push to the new device's token (admin route or `push-fcm.ts` test harness): payload `{ "data": { "sessionId": "<test-session-id>" } }`.
2. With app foreground: notification renders; tapping it navigates to that session. **Expected:** correct session opens.
3. Background app, send another push: notification appears in system tray. Tap. **Expected:** app comes to foreground, navigates to that session.
4. Force-stop app: `adb shell am force-stop <new-package>`. Send push. Tap notification from system tray. **Expected:** app cold-starts and lands on the correct session (cold-start path via `messaging().getInitialNotification()`).

### VP-8: OTA self-host round-trip

**Pre:** P3.4 phase complete.

1. Make a JS-only change to the orchestrator (e.g., modify a string in a route file).
2. Run the deploy via either path:
   - **Pipeline path**: `git push origin <branch>` → infra pipeline runs → CI runs `scripts/build-mobile-expo-ota.sh`.
   - **Manual fallback** (for verification before pipeline is wired): export `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`, then `bash scripts/build-mobile-expo-ota.sh`. Same R2 effect.
3. Verify R2: `wrangler r2 object list duraclaw-mobile --prefix ota/expo/`. **Expected:** new per-update objects (`bundle.hbc`, `metadata.json`, `assets/...`) AND an updated `latest.json` pointer under the channel.
4. Open the native app (already installed). Wait for `expo-updates` poll (or trigger manually via Settings → Force Update).
5. **Expected:** update downloads, applies on next mount; verify the new string is visible in the UI.

```bash
curl -s "https://<deploy-host>/api/mobile/eas/manifest?runtimeVersion=<rv>&platform=android&channel=production" | jq .
```

**Expected:** valid expo-updates manifest JSON with launchAsset + assets fields.

### VP-9: Kanban native drag-between-columns

**Pre:** P3.3 phase complete.

1. Open `/board` route on native.
2. Long-press a card; drag to another column; release.
3. **Expected:** confirmation modal fires (existing UX); on confirm, card moves to the new column; state persists across re-render and re-launch.

### VP-10: Risky-lib feature gates

**Pre:** P3.3 phase complete.

1. Navigate to a screen that would normally render xyflow on web (e.g., a session with a diagram artifact). **Expected:** placeholder text renders, no crash.
2. Same for jsx-preview, Rive persona, media-chrome audio. **Expected:** placeholder texts; no crashes.
3. Run lint:

```bash
pnpm lint
```

**Expected:** exits 0. Biome rule `noRestrictedImports` (biome.json:93-111) does not flag any new imports.

### VP-11: CI gate swap

**Pre:** P3.5 phase complete.

```bash
pnpm --filter @duraclaw/orchestrator typecheck
```

**Expected:** exits 0. Output includes a `[expo-prebuild-smoke] ok` line (or equivalent from the new script).

```bash
ls scripts/check-expo-prebuild.sh
ls scripts/check-metro-bundle.sh.archive 2>/dev/null || ls scripts/check-metro-bundle.sh  # one of these exists; not both active
```

**Expected:** `check-expo-prebuild.sh` exists and is executable. The old metro-bundle gate is either renamed to `.archive` or deleted.

### VP-12: Capacitor sunset state

**Pre:** P3.5 phase complete.

1. Verify `planning/specs/26-capacitor-android-mobile-shell.md` frontmatter: `status: sunset`, `sunset_date: 2026-04-3X`, `sunset_reason: "GH#132 P3 — replaced by Expo SDK 55 native target"`.
2. Verify GH#132 has a comment referencing the cleanup follow-up issue.
3. Verify GH#132 issue title matches: `P3: native target via Expo SDK 55 (Android-only) — RN pivot phase 3` (or close paraphrase).
4. Old Capacitor APK is uninstalled from the dev device:

```bash
adb shell pm list packages | grep "com.baseplane.duraclaw\b"  # not the .rn variant
```

**Expected:** no match (old package not installed). The new package still appears in `pm list packages`.

## Implementation Hints

### Key imports

```ts
// Auth
import { withExpo } from '@better-auth/expo'  // verify exact export name in P3.0 spike
import * as SecureStore from 'expo-secure-store'

// SQLite
import { open as openOpSqlite } from '@op-engineering/op-sqlite'
import { createOpSqliteTanstackPersistence } from '@duraclaw/op-sqlite-tanstack-persistence'  // new workspace package

// Lifecycle / network
import { AppState } from 'react-native'
import NetInfo from '@react-native-community/netinfo'

// Push
import messaging from '@react-native-firebase/messaging'

// OTA (client side; server side is hand-rolled Hono routes)
import * as Updates from 'expo-updates'

// Navigation
import { NavigationContainer } from '@react-navigation/native'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs'

// Kanban
import { Draggable, Droppable, DropProvider } from 'react-native-reanimated-dnd'

// Reanimated 4
import Animated from 'react-native-reanimated'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
```

### Code patterns

**Pattern 1 — Platform-conditional import (existing repo idiom)**

```ts
// apps/orchestrator/src/lib/auth-client.ts  (post-P3 shape)
import { Platform } from 'react-native'

export async function loadAuthClient() {
  if (Platform.OS === 'web') {
    return import('better-auth/client')
  }
  // Native (Expo)
  return import('@better-auth/expo')
}
```

**Pattern 2 — Native-vs-web platform branch in a shared screen**

```tsx
// packages/ai-elements/src/components/canvas.tsx
import { Platform, Text } from 'react-native'

export function Canvas(props: CanvasProps) {
  if (Platform.OS !== 'web') {
    return <Text>Diagram available on web only</Text>
  }
  // Existing xyflow implementation
  const { ReactFlow, Background } = require('@xyflow/react')
  return <ReactFlow ...{props} />
}
```

**Pattern 3 — TanStack DB persistence adapter shape**

Mirror `@tanstack/capacitor-db-sqlite-persistence` exports:

```ts
// packages/op-sqlite-tanstack-persistence/src/index.ts
export async function createOpSqliteTanstackPersistence(opts: { database: string }) {
  const db = openOpSqlite({ name: opts.database })
  return {
    async write(table: string, key: string, value: unknown) { /* INSERT OR REPLACE */ },
    async read(table: string, key: string) { /* SELECT * WHERE key = ? */ },
    async query(table: string) { /* SELECT * */ },
    async delete(table: string, key: string) { /* DELETE WHERE key = ? */ },
    async transaction<T>(fn: () => Promise<T>): Promise<T> {
      await db.execute('BEGIN')
      try { const r = await fn(); await db.execute('COMMIT'); return r }
      catch (e) { await db.execute('ROLLBACK'); throw e }
    },
    schemaVersion: 1,  // ignored by op-sqlite; managed by TanStack DB collection options
  }
}
```

**Pattern 4 — Expo updates protocol manifest (Worker route shape)**

```ts
// apps/orchestrator/src/api/mobile/eas-manifest.ts
import { Hono } from 'hono'

export const easManifest = new Hono<{ Bindings: Env }>()

easManifest.get('/manifest', async (c) => {
  const runtimeVersion = c.req.query('runtimeVersion')
  const platform = c.req.query('platform') ?? 'android'
  const channel = c.req.query('channel') ?? 'production'
  if (!runtimeVersion) return c.text('runtimeVersion required', 400)

  // Two-step read: pointer → metadata. See B6 Data Layer for canonical R2 layout.
  const ptrObj = await c.env.MOBILE_ASSETS.get(`ota/expo/${runtimeVersion}/${platform}/${channel}/latest.json`)
  if (!ptrObj) return c.text('No update available', 404)
  const { updateId } = await ptrObj.json<{ updateId: string }>()
  const metaObj = await c.env.MOBILE_ASSETS.get(`ota/expo/${runtimeVersion}/${platform}/${updateId}/metadata.json`)
  if (!metaObj) return c.text('Stale pointer; metadata missing', 404)
  const manifest = await metaObj.json()

  // Per docs.expo.dev/distribution/custom-updates-server: return manifest with
  // launchAsset + assets keyed by content hash; multipart/mixed in some configs.
  c.header('expo-protocol-version', '1')
  c.header('expo-sfv-version', '0')
  return c.json(manifest)
})
```

**Pattern 5 — Cold-start push tap (entry-rn.tsx shape)**

```tsx
// apps/orchestrator/src/entry-rn.tsx
import { AppRegistry } from 'react-native'
import messaging from '@react-native-firebase/messaging'

let pendingDeepLink: string | null = null

// MUST run before React mount
;(async () => {
  const initialNotification = await messaging().getInitialNotification()
  if (initialNotification?.data?.sessionId) {
    pendingDeepLink = `/?session=${initialNotification.data.sessionId}`
  }
})()

export function getPendingDeepLink() {
  const link = pendingDeepLink
  pendingDeepLink = null
  return link
}

AppRegistry.registerComponent('main', () => RootApp)
```

### Gotchas

- **`@better-auth/expo` exact package name + exports**: verify in P3.0 spike against the actual npm package. Mid-2026 ecosystem; package may be `@better-auth/expo` or `better-auth-expo` (no scope). Spec text uses `@better-auth/expo` for narrative; implementer must check.
- **op-sqlite + Fabric pod install**: the New Architecture requires `RCT_NEW_ARCH_ENABLED=1` in build env. SDK 55 sets this by default but op-sqlite's pod spec may require explicit opt-in or version pin. Check `apps/mobile-expo/ios/Podfile.properties.json` (if iOS pods generated by mistake — they shouldn't be in P3) or Android `gradle.properties` (`newArchEnabled=true`).
- **react-native-reanimated@4 worklets vs Tamagui native driver**: Tamagui's animation driver historically used Moti (Reanimated 2/3). Reanimated 4 worklets API is mostly source-compatible but inline-style-on-Animated-View has changed. In P3.0 risk #4, render a Tamagui `Stack` with `animation="bouncy"` prop and verify no warning about deprecated worklet API.
- **`@react-native-firebase/messaging` vs Expo Notifications**: do NOT use `expo-notifications`. RN-Firebase is the production path because we use FCM HTTP v1 already (`apps/orchestrator/src/lib/push-fcm.ts`) and `expo-notifications` adds an indirection layer (Expo's push service) that we don't need at single-user scale.
- **`google-services.json` package name**: do NOT just symlink `apps/mobile/android/app/google-services.json` — its inner `client.client_info.android_client_info.package_name` is `com.baseplane.duraclaw` (Capacitor app) and FCM token registration silently fails when the runtime package is `com.baseplane.duraclaw.rn`. Mandatory step: in Firebase Console, add `com.baseplane.duraclaw.rn` as a new Android app under the existing project, download the regenerated `google-services.json` (it now includes both packages), place at `apps/mobile-expo/android/app/google-services.json`. RN-Firebase Gradle plugin reads it identically to Capacitor's plugin.
- **`expo-secure-store` size limit**: ~2KB on iOS Keychain (irrelevant — iOS deferred), ~no practical limit on Android Keystore. Bearer tokens are <500 bytes; safe.
- **Self-hosted EAS Update protocol version**: `expo-updates` reads `expo-protocol-version` response header; mismatch = client ignores update silently. Stick with `1` for SDK 55.
- **`runtimeVersion` strategy choice**: `'fingerprint'` strategy hashes the native code; bumping a native dep changes the hash. `'appVersion'` strategy ties to app.json version. **Pick `'fingerprint'`** so JS-only updates ship without manual version bumps; spike #4 should validate this works under our deps.
- **`adb logcat` log filter**: existing tag prefixes (`[cm]`, `[cm-lifecycle]`, `[ws:<channel>]`) come from JS console — they pass through to logcat in release builds when `loggingBehavior: 'production'` is set. RN doesn't have a direct equivalent; for P3, use `import { console } from 'react-native'` (default) and rely on `react-native log-android` or `adb logcat ReactNativeJS:V` (RN's tag) for tail.
- **Worker route ordering**: `/api/mobile/eas/manifest` and `/api/mobile/eas/assets/*` MUST be mounted BEFORE `authMiddleware` in `apps/orchestrator/src/api/index.ts` (parity with `/api/mobile/updates/manifest` per `.claude/rules/mobile.md`). Otherwise expired-session users can't fetch updates.
- **MOBILE_ASSETS R2 binding optionality**: declared optional in `Env` type — if a Worker is deployed without the bucket bound, the new EAS routes must degrade to "no update available" (404) instead of 500'ing. Mirror existing pattern.

### Reference docs

- [docs.expo.dev/versions/latest/sdk/](https://docs.expo.dev/versions/latest/sdk/) — Expo SDK 55 module index. Find compatibility info for op-sqlite, RN-Firebase, NetInfo, secure-store, audio.
- [docs.expo.dev/distribution/custom-updates-server/](https://docs.expo.dev/distribution/custom-updates-server/) — expo-updates protocol spec for self-hosting.
- [github.com/expo/custom-expo-updates-server](https://github.com/expo/custom-expo-updates-server) — Node.js reference implementation; port the protocol logic to our Worker.
- [docs.expo.dev/eas-update/runtime-versions/](https://docs.expo.dev/eas-update/runtime-versions/) — runtimeVersion strategy options (`appVersion` vs `fingerprint`).
- [github.com/OP-Engineering/op-sqlite](https://github.com/OP-Engineering/op-sqlite) — JSI SQLite. Setup + Expo plugin.
- [reactnavigation.org/docs/](https://reactnavigation.org/docs/) — React Navigation v7 docs (native-stack, bottom-tabs, linking).
- [github.com/entropyconquers/react-native-reanimated-dnd](https://github.com/entropyconquers/react-native-reanimated-dnd) — DnD primitives; Draggable/Droppable/DropProvider API.
- [rnfirebase.io/messaging/usage](https://rnfirebase.io/messaging/usage) — RN-Firebase messaging integration; cold-start `getInitialNotification()`.
- [tamagui.dev/docs/intro/why-a-compiler](https://tamagui.dev/docs/intro/why-a-compiler) — Tamagui native animation driver; check current Reanimated version compatibility.
- Internal: `planning/research/2026-04-23-react-native-pivot-evaluation.md` (parent strategy); `planning/research/2026-04-30-gh132-p3-rn-native-target.md` (P0 + P1 doc with full file:line catalog and Decisions Log).
- Internal: `.claude/rules/mobile.md` (Capacitor 8 baseline being replaced); `.claude/rules/deployment.md` (pipeline contract — needs update in P3.4); `.claude/rules/worktree-setup.md` (port derivation for dev env, unchanged by P3).
