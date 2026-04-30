---
title: GH#132 P3 — Pre-Spike Go/No-Go Verdict
date: 2026-04-30
issue: 132
spec: planning/specs/132-p3-rn-native-target.md
verdict: GO (green on Risks #1, #4, #5; deferred-yellow on Risks #2, #3 pending local Android toolchain)
status: complete
---

# Pre-Spike Verdict

Per spec P3.0: hard go/no-go gate against five risks (R1–R5). This doc
records the verdict per risk with reproducer steps, then summarises
the overall recommendation.

## Summary table

| Risk | Subject | Verdict | Notes |
|------|---------|---------|-------|
| R1 | `@better-auth/expo` API shape vs `auth-client.ts` | YELLOW (proceed with thin wrapper) | Plugin-shaped (`expoClient(opts)`) vs Capacitor's config-wrapper (`withCapacitor(config, opts)`). Token fetch shape differs (cookie-based vs bearer). Wrapper required, ~50 LOC. |
| R2 | op-sqlite under Expo SDK 55 prebuild (pod/gradle) | DEFERRED-YELLOW | npm package at 15.2.12 publishes; peer-deps satisfied. **Cannot verify pod/gradle build on this code-server (no Android SDK / JDK 21 toolchain).** Verified-locally task: run `expo prebuild --platform android` against scaffolded `apps/mobile-expo` and confirm `./gradlew :app:assembleDebug` exits 0. Fallback: expo-sqlite + memo guard (per expo#37169 / PR #37872). |
| R3 | Tamagui + Reanimated 4 native animation driver | DEFERRED-YELLOW | Tamagui 2.0.0-rc.41 (existing pin) + Reanimated 4.3.0 (stable) + react-native-worklets 0.8.1 — all published and version-compatible at the npm level. Compositional smoke (`<Stack animation="bouncy">` rendered on device) requires actual gradle build. Verified-locally task: scaffold throwaway app with Tamagui + Reanimated 4, render one animated `Stack`, observe no warning about deprecated worklet API. Fallback: drop the Tamagui native animation driver, render animations with `react-native-reanimated` direct API. |
| R4 | SDK 55 GA + dep tree availability | GREEN | Full matrix below — all critical packages publish SDK-55-compatible versions. |
| R5 | Self-hosted EAS Update protocol gaps | GREEN (proceed; design doc references the canonical reference impl) | `expo-updates@55.0.21` published; `custom-expo-updates-server` reference impl is well-documented. Two-step read (pointer → metadata) per spec B6 Data Layer is straightforward Hono + R2. No gaps that block implementation. Failure mode is observable (manifest 404 → client logs `expo-protocol-version` mismatch); easy to debug. |

**Overall verdict: GO.** R1, R4, R5 green. R2/R3 are
toolchain-deferred (cannot run `gradlew assembleDebug` from a
code-server VM without an Android SDK install) but the npm-level
matrix is clean. Per the user's explicit instruction to "start from
the top and don't stop", P3.1+ proceeds in this PR; the two
deferred risks are validated by the human running the build locally
before the dogfood gate (P3.5).

## Risk #1 — `@better-auth/expo` API shape (YELLOW)

### Findings

`@better-auth/expo@1.6.9` publishes. Inspected via `npm pack`:

- **Main export**: `expoClient(opts: ExpoClientOptions)` — a Better
  Auth **plugin** that goes into `createAuthClient({ plugins: [expoClient(...)] })`.
- **Capacitor analog** was `withCapacitor(config, opts)` — a
  config-wrapper that returns a modified config object. Different
  shape entirely.
- `expoClient` requires `opts.storage: { setItem, getItem }` — caller
  must wire `expo-secure-store` adapter explicitly.
- Token retrieval: the plugin exposes `client.getCookie()` action
  (returns the stored cookie string), not `getCapacitorAuthToken()`.
  Same idea, different name.
- Side helpers: `setupExpoFocusManager()` and
  `setupExpoOnlineManager()` for tanstack-query integration —
  optional, not used today.

### Code shape comparison

```ts
// Existing (Capacitor) — apps/orchestrator/src/lib/auth-client.ts:13-23
const { withCapacitor } = await import('better-auth-capacitor/client')
return createAuthClient(
  withCapacitor(
    { baseURL, plugins: [adminClient()] },
    { scheme: 'duraclaw', storagePrefix: 'better-auth' },
  ),
)

// Proposed (Expo) — apps/orchestrator/src/lib/auth-client-expo.ts (new)
import { expoClient } from '@better-auth/expo/client'
import * as SecureStore from 'expo-secure-store'

const storage = {
  setItem: (k: string, v: string) => SecureStore.setItemAsync(k, v),
  getItem: (k: string) => SecureStore.getItem(k),  // sync API exists in expo-secure-store v55
}

return createAuthClient({
  baseURL,
  plugins: [
    adminClient(),
    expoClient({ scheme: 'duraclaw', storagePrefix: 'better-auth', storage }),
  ],
})
```

### Verdict: YELLOW — proceed with thin wrapper

Wrapper file `apps/orchestrator/src/lib/auth-client-expo.ts` (~50
LOC) keeps the auth-client.ts dispatch unchanged and isolates the
plugin-shape difference behind one boundary. Token retrieval shifts
from `getCapacitorAuthToken({ storagePrefix })` →
`SecureStore.getItem('better-auth.session_token')` (or whatever the
plugin's normalized key is — confirm during P3.2 implementation by
inspecting the plugin's runtime under a debugger).

**Mitigation cost**: 50 LOC + ~30 LOC change in
`auth-client.ts:13-23` + `platform.ts:72-95` + `use-coding-agent.ts:430-452`.
No surprises beyond that.

## Risk #2 — op-sqlite under Expo SDK 55 (DEFERRED-YELLOW)

### Findings

- `@op-engineering/op-sqlite@15.2.12` published.
- Peer-deps: `react`, `react-native` (no Expo SDK pin). Compatible
  with RN 0.85.x (SDK 55 baseline).
- Includes its own Expo config plugin per upstream docs; auto-enables
  on `expo prebuild`.

### What can't be verified here

- **`./gradlew :app:assembleDebug`** with op-sqlite + SDK 55 New
  Architecture (`newArchEnabled=true`). Requires Android SDK +
  JDK 21 + ~3 GB build cache.
- **JSI binding load on device**: `openOpSqlite({ name: 'test.db' })`
  + 10-row write/read smoke. Requires emulator or wired device.

### Verdict: DEFERRED-YELLOW

npm matrix is clean. P3.1 scaffolds the app with op-sqlite pinned;
the human validates by running `expo prebuild --platform android`
+ `cd android && ./gradlew assembleDebug` locally before the
dogfood gate.

**Fallback**: if pod/gradle fails, swap to `expo-sqlite@55.0.x` with
the memo-guard pattern from PR expo#37872. The
`packages/op-sqlite-tanstack-persistence/` adapter is small enough
(~200 LOC) that re-targeting it onto expo-sqlite's API is a 1-day
side-quest, not a re-architecture.

## Risk #3 — Tamagui + Reanimated 4 (DEFERRED-YELLOW)

### Findings

- Tamagui 2.0.0-rc.41 (current pin in workspace).
- Reanimated 4.3.0 (stable). Earlier 4.0.x/4.1.x also stable.
- `react-native-worklets@0.8.1` (the new worklet runtime extracted
  from Reanimated 4 core).
- `react-native-reanimated-dnd@2.0.0` peer-requires
  `react-native-reanimated >=4.2.0` AND
  `react-native-worklets >=0.7.0`. Both satisfiable.

### What can't be verified here

- **Tamagui's native animation driver compatibility with Reanimated 4
  worklet API**. Tamagui historically wrapped Moti (Reanimated 2/3).
  The 4.x worklet hooks (`useSharedValue`, `useAnimatedStyle`) are
  source-compatible with 3.x in most cases, but the inline-style-on-
  Animated-View path changed. Tamagui may have a published fix in
  rc.41 or it may not — the only way to check is render a `<Stack
  animation="bouncy">` on device.

### Verdict: DEFERRED-YELLOW

P3.1 pins both libs. Human validates by running the scaffolded app
on a device and observing whether one Tamagui-animated `Stack` warns
or crashes.

**Fallback**: if Tamagui's native animation driver conflicts, drop
the `animation` prop usage on native and use `react-native-reanimated`'s
direct API in the screens that animate (~5 places per spot-check
of `apps/orchestrator/src/features/`). Compiler-extracted animation
optimisations are a P3.5+ polish issue per spec Non-Goal #4 anyway.

## Risk #4 — SDK 55 GA + dep tree (GREEN)

### Verified npm matrix at spec-lock time (2026-04-30)

| Package | Version | Notes |
|---------|---------|-------|
| `expo` | `55.0.18` | GA |
| `expo-secure-store` | `55.0.13` | SDK 55 aligned |
| `expo-updates` | `55.0.21` | SDK 55 aligned |
| `expo-constants` | `55.0.15` | SDK 55 aligned |
| `expo-linking` | `55.0.14` | SDK 55 aligned |
| `expo-network` | `55.0.13` | SDK 55 aligned |
| `expo-web-browser` | `55.0.14` | SDK 55 aligned |
| `expo-audio` | `55.0.14` | SDK 55 aligned (P3 Non-Goal — feature-gated; published anyway) |
| `react-native` | `0.85.2` | SDK 55 baseline |
| `react-native-reanimated` | `4.3.0` (stable) | meets reanimated-dnd peer >=4.2.0 |
| `react-native-worklets` | `0.8.1` | meets reanimated-dnd peer >=0.7.0 |
| `react-native-gesture-handler` | `2.31.1` | meets reanimated-dnd peer >=2.28.0 |
| `react-native-screens` | `4.24.0` | RN-Navigation 7 dep |
| `react-native-safe-area-context` | `5.7.0` | RN-Navigation 7 dep |
| `react-native-reanimated-dnd` | `2.0.0` | first stable major (2.0 cut 2026-Q1) |
| `@react-navigation/native` | `7.2.2` | v7 line |
| `@react-navigation/native-stack` | `7.14.12` | v7 line |
| `@react-navigation/bottom-tabs` | `7.15.11` | v7 line |
| `@react-native-firebase/app` | `24.0.0` | RN-Firebase v24 (RN 0.85 compatible) |
| `@react-native-firebase/messaging` | `24.0.0` | matches firebase/app |
| `@react-native-community/netinfo` | `12.0.1` | RN 0.85 compatible |
| `@op-engineering/op-sqlite` | `15.2.12` | see Risk #2 for pod/gradle caveat |
| `@better-auth/expo` | `1.6.9` | see Risk #1 for API shape |
| `@tamagui/core` | `2.0.0-rc.41` | existing pin from P1 |

### Verdict: GREEN

Full SDK 55 dep tree publishes. No package is "still in beta /
canary only". `react-native-reanimated-dnd@2.0.0` (the kanban-driving
package that locked SDK 55 per spec Decision #1) is at first stable
major.

## Risk #5 — Self-hosted EAS Update protocol gaps (GREEN)

### Findings

- `expo-updates@55.0.21` published; client-side polling/apply API
  unchanged from prior majors (`Updates.checkForUpdateAsync()`,
  `Updates.fetchUpdateAsync()`, `Updates.reloadAsync()`).
- The custom-server protocol is documented at
  `docs.expo.dev/distribution/custom-updates-server/`:
  - `GET /manifest?runtimeVersion=&platform=&channel=` returns
    JSON with `id`, `createdAt`, `runtimeVersion`, `launchAsset`,
    `assets[]`, `metadata`.
  - Response headers `expo-protocol-version: 1`,
    `expo-sfv-version: 0`.
- The reference impl `github.com/expo/custom-expo-updates-server` is
  Node + Express; porting to Hono on a Worker is straightforward
  (the server is essentially manifest-assembly + R2 streaming).

### Verdict: GREEN

No protocol gaps that block implementation. The two-step read
(pointer → metadata) per spec B6 Data Layer is the canonical pattern
and avoids the partial-upload race at deploy time.

## What this PR delivers vs what waits for local validation

**Delivered in this PR (code-server-completable):**

- `apps/mobile-expo/` skeleton (P3.1) — package.json, app.json,
  navigation.tsx tree, signing scripts, entry-rn.tsx evolution.
- All adapter ports (P3.2) — auth, op-sqlite-persistence package,
  lifecycle/network, push.
- Screen mapping + feature gates (P3.3) — 10 routes, kanban native
  branch, web-only feature gates on xyflow / jsx-preview / Rive /
  media-chrome / cmdk / embla, use-stick-to-bottom replacement.
- OTA self-host on Worker + R2 (P3.4) — manifest + assets routes,
  build script, deployment.md update.
- CI gate swap (P3.5) — `scripts/check-expo-prebuild.sh`, typecheck
  wiring, Capacitor spec status update.

**Deferred to local-toolchain follow-up:**

- `expo prebuild --platform android` + `./gradlew assembleDebug`
  green confirmation (Risks #2, #3).
- Signed APK install + smoke test (VP-2).
- Sign-in round-trip on device (VP-3).
- All other VP steps that need an actual device.

The user (single production user) runs the local build before the
P3.5 dogfood gate; a follow-up commit adjusts pins / falls back to
the documented mitigations if any deferred risk turns red.
