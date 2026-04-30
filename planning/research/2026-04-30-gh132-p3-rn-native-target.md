---
date: 2026-04-30
topic: "GH#132 P3 — native target via Expo SDK 54 (Android-first); Capacitor seam swaps"
type: feasibility
status: complete
github_issue: 132
items_researched: 7
predecessors:
  - "planning/research/2026-04-23-react-native-pivot-evaluation.md (parent strategy doc)"
  - "GH#125 / PR #127 — P1 Tamagui adoption (merged 2026-04-28)"
  - "GH#131 — P2 RNW universalization (closed 2026-04-29)"
  - "GH#130 — P1c post-merge verification (open; gates impl, not spec)"
---

# Research: GH#132 P3 — RN native target (Android-first; iOS deferred to P4)

## Context

GH#132 is phase 3 of the RN pivot. The strategy was settled by the parent
research (`2026-04-23-react-native-pivot-evaluation.md` §10.4 / §11.5):
add a real native target via Expo SDK 54, replace each Capacitor seam
with its RN-native equivalent, sunset the Capacitor Android app. Routing
default is Option A (TanStack Router web + React Navigation native;
shared screens via Tamagui + RNW). P1 (Tamagui) shipped, P2 (RNW
universalization, Metro smoke gate, Biome ban on web-only libs in
`apps/orchestrator/src/**`) shipped.

This research catalogs the **concrete integration surface** for each
seam — file:line — so the spec can be written against real code, not
the strategic shape. iOS is **explicitly out of scope** for P3 per
user direction (deferred to P4 alongside Maestro + Play Store).

## Scope

7 deep-dive items, one Explore agent each. Items, fields, and sources
were confirmed with the user before spawning. See agent prompts in the
session transcript for the per-item brief.

| # | Item | Risk class |
|---|---|---|
| 1 | State post-P2: every Capacitor seam + native-conditional path | Foundation |
| 2 | Auth seam — `better-auth-react-native` adapter | Spike #1 |
| 3 | SQLite seam — op-sqlite vs expo-sqlite + TanStack DB adapter | Spike #2 |
| 4 | Lifecycle + push + network seams (mechanical swaps) | Mechanical |
| 5 | OTA — EAS Update vs Capgo + APK fallback | Mechanical |
| 6 | Routing — React Navigation native shell | Architecture |
| 7 | Risky-component fallbacks (xyflow / jsx-parser / Rive / media-chrome) | Spike #3 |

## Findings

### 1. Current Capacitor surface (post-P2)

**Total surface**: 9 plugins, 14 consumer files, ~50 `isNative()`
decision points, 6 dynamic imports, 2 OTA channels (Capgo + APK
fallback), 1 fetch interceptor, 1 WS host override.

**Plugin pins** (`apps/mobile/package.json:12-25`):
`@capacitor-community/sqlite@^8.1.0`, `@capacitor/{android,app,core,network,preferences,push-notifications}@^8.x`,
`@capgo/capacitor-updater@^7.0.0`, `@tanstack/capacitor-db-sqlite-persistence@0.1.9`.

**Native-conditional code** lives in:
- `apps/orchestrator/src/lib/platform.ts:33-95` — `isNative()`,
  `apiBaseUrl()`, `wsBaseUrl()`, `installNativeFetchInterceptor()`
- `apps/orchestrator/src/lib/connection-manager/lifecycle.ts:69-113` —
  `App.appStateChange` + `Network.networkStatusChange` listeners
- `apps/orchestrator/src/lib/mobile-updater.ts` — full Capgo + APK
  fallback flow
- `apps/orchestrator/src/db/{db-instance,persistence-capacitor}.ts` —
  SQLite backend selection
- `apps/orchestrator/src/lib/auth-client.ts:13-23` — better-auth-capacitor
  dynamic import
- `apps/orchestrator/src/hooks/use-push-subscription{,-native}.ts` +
  `lib/native-push-deep-link.ts` — push token + tap routing
- `apps/orchestrator/src/features/agent-orch/use-coding-agent.ts:409-449`
  — bearer token from Capacitor Preferences for WS

**P2 leftovers already in tree** (preserve, do not re-implement):
- `apps/orchestrator/vite.config.ts` lines 48 (RNW alias) / 57-59
  (`ssr.noExternal`) / 64-66 (`optimizeDeps.exclude`)
- `apps/orchestrator/{app.json, metro.config.cjs, src/entry-rn.tsx}`
- `scripts/check-worker-tamagui-leak.sh` (banned `@tamagui` and
  `react-native[-web]` from Worker bundle)
- `scripts/check-metro-bundle.sh` (Metro export smoke gate; hard CI)
- `biome.json` lines 93-111 (banned `@xyflow/react`,
  `react-jsx-parser`, `@rive-app/react-webgl2`, `media-chrome`
  from `apps/orchestrator/src/**`)

### 2. Auth — `better-auth-react-native` adapter (Spike #1)

**Existing Capacitor shape** (`auth-client.ts:13-23`,
`platform.ts:72-95`, `auth.ts:47-74`):
- Bearer token in Capacitor Preferences (key `better-auth:token`)
- Global `fetch` interceptor injects `Authorization: Bearer` for
  `apiBaseUrl()` requests
- WS bearer via `_authToken` query param (`use-user-stream.ts:100-108`),
  hoisted to header at edge (`server.ts:101-106`)
- Server-side accepts bearer via Better Auth's `bearer()` plugin —
  **no server-side changes needed** for RN

**RN adapter** (we own it):
- Storage: **`expo-secure-store`** (Keychain/Keystore-backed) — chosen
  over MMKV for security parity with cookies
- Public API mirrors `better-auth-capacitor`: `withReactNative()`,
  `getReactNativeAuthToken()`, `setReactNativeAuthToken()`,
  `clearReactNativeAuthToken()`
- Estimated ~300-400 LOC, client-only

**Mid-2026 ecosystem note**: `@better-auth/expo` plugin appears to
exist on npm (per Explore agent's WebSearch). **Open call for spec**:
use `@better-auth/expo` directly vs. write our own thin adapter that
matches the Capacitor sibling's interface? Adapter-symmetry argues
for thin local wrapper that may delegate to `@better-auth/expo`
internally; reduces orchestrator-side churn.

**Spike acceptance** (gates P3 main work):
1. Sign-in round-trip via expo-secure-store stores token
2. WS handshake with `_authToken` param succeeds
3. 4401 reconnect backs off cleanly
4. Process-kill + relaunch restores token without re-sign-in
5. Reboot + relaunch (signed build) restores token

### 3. SQLite — op-sqlite vs expo-sqlite (Spike #2)

**Workload characterization**:
- `messagesCollection` schema v6 (`messages-collection.ts:166`),
  500+ rows/long session, ms-cadence inserts during streaming,
  insert→update auto-conversion for partial_assistant deltas
- `branchInfoCollection` schema v3 (`branch-info-collection.ts:15`),
  reconnect replays full set
- Both use TanStack DB `persistedCollectionOptions()` interface

**Adapter status (mid-2026)**:
- **expo#37169** — production suspense/navigation bug — **fixed in
  PR #37872 (April 2026)** via `memo` + deep-equals on
  SQLiteProvider. Fix is shallow; high-frequency reconnect (our
  branch/rewind flow) may still expose adjacent issues.
- **op-sqlite v15.2.11** (April 17, 2026) — JSI-backed, fastest,
  actively maintained. **No first-party TanStack DB persistence
  adapter** — must port from
  `@tanstack/capacitor-db-sqlite-persistence` (~200 LOC, mechanical
  interface adapter).

**Recommendation**: **op-sqlite + custom adapter port** (~200 LOC).
Migration not required — RN is a fresh native target, users get a
clean install. Schema-version mismatch handling: wipe + resync from
server (cheaper than migration; messages re-stream from DO).

**Spike acceptance**:
1. Adapter implements all TanStack DB persistence methods
2. 10-min branch/rewind dogfood session keeps `messagesCollection`
   coherent through reconnect
3. Cold-launch instant load from cache
4. Persistence overhead <5ms (JSI baseline) per insert

**Fallback** if op-sqlite blocks on EAS/SDK 54: **expo-sqlite + memo
guard + incremental reconnect**. Adapter is closer to existing
`@tanstack/browser-db-sqlite-persistence`.

### 4. Lifecycle + push + network (mechanical swaps)

**Lifecycle** (`@capacitor/app` → RN `AppState`):
- `lifecycle.ts:78` — `App.addListener('appStateChange', ...)` →
  `AppState.addEventListener('change', ...)`
- Direct mapping; RN `inactive` state has no Capacitor equivalent
  (treat as `background`)
- `App.addListener('appUrlOpen', ...)` not used today; Expo Router /
  `Linking.addEventListener('url', ...)` for future deep-links

**Network** (`@capacitor/network` → `@react-native-community/netinfo`):
- `lifecycle.ts:89-110` — `Network.addListener('networkStatusChange', ...)` +
  `Network.getStatus()` seed → `NetInfo.addEventListener` +
  `NetInfo.fetch()` seed
- NetInfo adds `type` (wifi/cellular/ethernet) — new info we don't
  currently react to. Wi-Fi↔LTE handoff (#70 pain point) becomes
  detectable; preserve current behavior (boolean only) with `type`
  available for future use.

**Push** (`@capacitor/push-notifications` →
`@react-native-firebase/messaging`):
- Token: `PushNotifications.addListener('registration', ...)` +
  `register()` → `messaging().getToken()` +
  `messaging().onTokenRefresh()`
- Foreground: `PushNotifications.addListener('pushNotificationReceived', ...)` →
  `messaging().onMessage(...)`
- Tap: `PushNotifications.addListener('pushNotificationActionPerformed', ...)` →
  `messaging().onNotificationOpenedApp(...)`
- Cold-start: **`messaging().getInitialNotification()`** — must run
  before React mount (mirrors `initNativePushDeepLink` pattern in
  `entry-client.tsx:37`)
- `apps/mobile/android/app/google-services.json` reused as-is
  (RN-Firebase Gradle plugin reads same file)
- Server endpoints (`/api/push/fcm-subscribe`, `push-fcm.ts`)
  **unchanged** — same FCM HTTP v1 token format

**Mechanical swap budget**: ~170 LOC across all three. Riskiest
element: cold-start notification tap delivery on Android (timing
between OS launch + JS boot + `getInitialNotification()` call).

### 5. OTA — EAS Update migration

**Current Capgo flow** (full surface in `mobile-updater.ts`,
`/api/mobile/{updates/manifest, apk/latest, assets/*}` routes,
`scripts/build-mobile-ota-bundle.sh`, `duraclaw-mobile` R2 bucket):
- `notifyAppReady()` rollback semantics
- 3-attempt retry with 30-min backoff
- APK fallback (`/api/mobile/apk/latest`) — load-bearing for
  native-layer updates
- Public manifest routes (pre-`authMiddleware` so expired sessions
  can still update)

**EAS Update model**:
- Channels (e.g., `production`, `staging`)
- Runtime version pinning via `@expo/fingerprint` of native code
- Auto-rollback on launch crash via `Updates.reloadAsync()`
- Default: Expo CDN for assets; **self-hosting possible** via
  `custom-expo-updates-server` reference impl (could point at our
  own R2 + Worker if we want to keep one infra path)

**Cutover plan — recommend Option (a) parallel migration**:
- Capacitor APK keeps Capgo channel + R2 bucket unchanged
- New Expo Android app uses EAS Update independently
- Users migrate when they install the new APK from Play Store
- After 6-12 months, deprecate Capgo channel
- **Why not (b) single-backend EAS-protocol Worker**: 2-3 days extra
  engineering during the migration; high coupling
- **Why not (c) hard cutover**: breaks existing users who don't
  manually upgrade; APK fallback can't bridge

**Pipeline contract diff** (`.claude/rules/deployment.md`):
- New env: `EXPO_TOKEN`, `EAS_PROJECT_ID`
- New step: `eas fingerprint --json` → branch on change → `eas build`
  if changed, then `eas update`
- Keep: `VITE_APP_VERSION` (git SHA, JS version)
- Add: `runtimeVersion` in `app.json` (native interface contract)
- Both checked by `expo-updates` client

**Estimated effort**: ~0.5 day for the EAS plumbing; complexity is
lower than Capgo because EAS has rollback + channels built-in.

### 6. Routing — React Navigation native shell

**Route inventory** (10 files, verified post-P2):
- `__root.tsx`, `login.tsx`, `_authenticated/route.tsx`
- `_authenticated/index.tsx` (dashboard, with typed search params:
  `session`, `newSessionProject`, `newTab`)
- `_authenticated/session.$id.tsx` (legacy redirect)
- `_authenticated/board.tsx` (kanban)
- `_authenticated/settings.tsx`
- `_authenticated/projects.$projectId.docs.tsx`
- `_authenticated/deploys.tsx`
- `_authenticated/admin.*.tsx` (3 files)

**Native nav primitives** (Option A per parent §11.5):
- BottomTabs.Navigator on phone, Drawer on tablet
- Stack screens for detail views
- Modal stack for command palette + dialogs
- 7/10 routes share the **same screen component file** with web via
  Tamagui + RNW; 1 (kanban) is forked due to dnd-kit incompatibility;
  partial fork on deploys for Rive feature-gate

**Deep-linking** (`Linking` config):
- Push notifications: `data.sessionId` → `AgentOrch?session=:id`
  (preserve current behavior)
- `getInitialURL()` on cold-start (parallel with
  `getInitialNotification()` for push taps)

**Web build isolation**: React Navigation as native-only dep;
tree-shaken from web via entry-point split (`entry-client.tsx`
unchanged) + `Platform.OS === 'web'` guards in shared screens.
Vite confirms no `react-navigation` bytes in `dist/client/`.

**Typed search param gap**: Only `_authenticated/index.tsx` uses
typed params today (3 keys). Native equivalent is weaker; mitigation
is manual param parsing on RN side. **Option B (Expo Router
everywhere) deferred to P3.5** — defined trigger: any 2 of
{velocity-degradation, drift-bug-rate, URL-filter-need,
EAS-instability} active >2 weeks.

### 7. Risky-component fallbacks (Spike #3)

All four primary libs are confined to `packages/ai-elements/**`
(P2 Biome rule blocks them from `apps/orchestrator/src/**`).

| Library | Disposition | Effort | Rationale |
|---|---|---|---|
| `@xyflow/react` | **Feature-gate web-only** | 80-150 LOC | No native peer; placeholder UI on RN ("Diagram not yet available on mobile") |
| `react-jsx-parser` | **Feature-gate + schema fallback** | 250-350 LOC | Custom JSX interpreter is risky; emit constrained schema (Button/Text/View allow-list) for native render |
| `@rive-app/react-webgl2` | **Feature-gate, static avatar** | 100-150 LOC | `rive-react-native` SDK exists but different API; static SVG avatar is acceptable for MVP |
| `media-chrome` | **Replace with `expo-audio`** | 80-150 LOC | API maps cleanly; web/native dual-path via `Platform.select()` |

**Secondary libs found in `packages/ai-elements/**` (not in P2 ban
list but need RN handling)**:
- `cmdk` (command palette) → custom RN modal + FlatList (~150 LOC)
- `embla-carousel-react` → FlatList + `pagingEnabled` (~150 LOC)
- `use-stick-to-bottom` (chat scroll pin) → FlatList
  `onMomentumScrollEnd` + state (~90 LOC) — load-bearing for chat UX

**Total feature-gate + replacement budget**: 790-1280 LOC. Phasing:
- **P3a (must ship)**: xyflow gate, jsx-parser gate, Rive gate,
  media-chrome replacement (audio is critical), use-stick-to-bottom
  replacement (chat UX critical)
- **P3b (post-MVP polish)**: cmdk, embla replacements; revisit Rive
  native SDK port if time

## Comparison

### Spike-risk gating matrix

| Spike | Outcome → continues to | Fallback if blocks |
|---|---|---|
| #1 Auth (`better-auth-react-native`) | Full P3 main work | Defer P3; stay on Capacitor + ship #70 |
| #2 SQLite (op-sqlite adapter) | Full P3 main work | Use `expo-sqlite` with memo guard |
| #3 Risky libs | Full P3 main work | Drop affected features on native (placeholder UI) |

All three pass → ship P3 in ~1-2 weeks repo-velocity wall clock.
Any blocks → fall back to Capacitor + #70 per parent §9.5.

### Phase plan sketch (concrete sub-phases for spec)

| Sub-phase | Scope | Wall-clock |
|---|---|---|
| **P3.0 Pre-spike** (gate) | Three risks above; produce go/no-go | 2 days |
| **P3.1 Expo target bootstrap** | Expo SDK 54 prebuild; entry-rn.tsx → production entry; React Navigation skeleton; signing | 1-2 days |
| **P3.2 Adapter ports** (parallel) | better-auth-react-native; op-sqlite TanStack adapter; AppState/NetInfo lifecycle; @react-native-firebase/messaging push | 2-3 days |
| **P3.3 Screen migration** | Map TanStack routes → React Navigation; fork kanban; feature-gate xyflow/jsx-parser/Rive; replace media-chrome/use-stick-to-bottom | 2-3 days |
| **P3.4 OTA + signing** | EAS Update channel; pipeline contract update; signed Android build; sideload smoke | 1 day |
| **P3.5 Capacitor sunset gate** | Dogfood signed build; verify acceptance criteria; mark Capacitor for deprecation | 1 day |

**Total P3 envelope: ~9-12 days wall-clock at repo velocity, on top
of a 2-day pre-spike.** Matches parent §9.3 ~4-6 days post-spike;
adjusted up for the routing/screen migration depth that surfaced in
this research.

## Recommendations

1. **Spec the pre-spike (P3.0) as a hard gate**, not a soft
   recommendation. Three explicit go/no-go checks before P3.1 starts.
2. **Pick op-sqlite as the SQLite default**, with `expo-sqlite +
   memo guard` as the documented fallback if the adapter port
   blocks.
3. **Pick `expo-secure-store` for auth storage**, not MMKV. Keychain/
   Keystore parity with cookies is the right security model for
   bearer tokens.
4. **Investigate `@better-auth/expo` first** before writing a thin
   local adapter. May save the 300-400 LOC port entirely; if not, a
   thin wrapper around it preserves Capacitor-sibling symmetry.
5. **Defer iOS to P4**, as user directed. Spec is Android-only with
   Expo prebuild; iOS provisioning, TestFlight, App Store come in
   P4 alongside Maestro.
6. **OTA migration option (a) — parallel channels** for 6-12 months.
   Don't try to unify Capgo + EAS Update through a Worker proxy
   during the migration window.
7. **Native nav: stick with Option A (React Navigation native +
   TanStack Router web)**. Defer Expo Router-everywhere (Option B)
   to a measurable P3.5 trigger.
8. **Risky-lib P3a/P3b split**: ship the four primary library gates
   + media-chrome + use-stick-to-bottom in P3.3; defer cmdk + embla
   replacements + Rive RN SDK port to P3b polish.
9. **Capacitor sunset**: not in P3. Ship the new Expo Android app
   alongside the Capacitor APK; users migrate by Play Store update.
   Schedule deprecation 6-12 months out.

## Open Questions (for P1 interview)

1. **`@better-auth/expo` vs custom adapter?** — affects spike scope
2. **Self-host EAS Update via R2/Worker vs default Expo CDN?** —
   affects pipeline complexity + reproducibility story
3. **Kanban on native: full RN-Gesture-Handler rewrite vs feature-
   gate ("kanban available on web")?** — 800 LOC if rewrite; 0 if
   gate
4. **Push permission UX on Android 13+** — same flow as Capacitor
   today, or take the opportunity to redesign (e.g., contextual
   prompt on first session-start)?
5. **Capacitor sunset timeline** — set explicit calendar deadline in
   spec, or "6-12 months" soft target?
6. **App ID / package name** — keep `com.baseplane.duraclaw`
   (current Capacitor app) or new package for the Expo build?
   Affects Play Store continuity vs. clean break.
7. **CI gate behavior** — should `scripts/check-metro-bundle.sh`
   continue to run, or be replaced by `eas build --dry-run` /
   `eas update --dry-run` once P3 ships?

## Next Steps

1. P1 interview — surface the 7 open questions above; lock decisions
   that change the phase shape (kanban gate vs rewrite, EAS hosting,
   adapter approach).
2. P2 spec — write against the phase sketch (P3.0 pre-spike, P3.1-P3.5),
   embed B-IDs against the parent research's verification gates,
   write VP that mirrors the spike acceptance criteria.
3. Consider adding research item #8 (iOS) at P4 spec time, not now.

---

## Decisions Log (P1 interview, 2026-04-30)

Captured at end of P1 interview. Each entry overrides any conflicting
default in the issue body or parent research.

### Architectural overrides

1. **Expo SDK 55, not 54** (issue body says 54). Triggered by kanban
   path: only viable RN multi-column kanban lib
   (`react-native-reanimated-dnd`) requires SDK 55 + Reanimated 4.
   - **Spike risk added (P3.0)**: verify SDK 55 + all P3 deps
     (RN-Firebase, NetInfo, expo-secure-store, op-sqlite, expo-audio,
     reanimated-dnd, Tamagui native driver) compose without conflict
     and SDK 55 is GA at spec-lock time.
   - **Action**: edit GH#132 title to reflect SDK 55 (P4 close step).

2. **Auth adapter: use `@better-auth/expo` directly**. Skip the local
   wrapper if its exported surface matches our existing
   `auth-client.ts:13-23` call shape; add a thin wrapper only on
   mismatch. Spike scope drops to ~50-100 LOC verification + glue.

3. **SQLite: op-sqlite + custom TanStack DB adapter port (~200 LOC)**;
   `expo-sqlite + memo guard` documented as fallback if op-sqlite
   blocks on SDK 55 / Fabric. No migration from Capacitor DB —
   single user, fresh install, resync from server.

4. **Kanban on native: bump to SDK 55 + adopt
   `react-native-reanimated-dnd`**. ~200 LOC integration after the
   SDK upgrade. Real native kanban, not feature-gated.

5. **EAS Update: self-host on R2 + Worker** via the
   `custom-expo-updates-server` reference impl. Single infra path
   (existing `duraclaw-mobile` R2 bucket, Worker routes), no
   `EXPO_TOKEN` runtime dependency. +2-3 days to P3.4.

6. **App ID: new package** (e.g., `com.baseplane.duraclaw.rn` —
   exact name TBD in spec). Side-by-side install during dogfood
   transition. Capacitor APK uses old `com.baseplane.duraclaw`,
   Expo APK uses new package. No long-running parallel maintenance
   because of decision #7 (immediate sunset).

7. **Capacitor sunset: immediate** upon Expo GA. Production has one
   user; once they're on the new APK, the old Capacitor APK is dead.
   No 90-day deadline, no in-app urgency banner, no Play Store
   dual-listing concerns. Capgo channel stops the moment user stops
   launching old package.

8. **Routing: Option A confirmed** (TanStack Router web + React
   Navigation native, shared screens via Tamagui + RNW). Option B
   (Expo Router everywhere) deferred to P3.5 with the trigger
   criteria from research §6 unchanged.

### UX / Process decisions

9. **Push permission: cold-start prompt parity with Capacitor**. Not
   the contextual "first long-session" pattern. ~0 LOC delta from
   current behavior. Reconsider when there are more users.

10. **Risky-lib disposition: feature-gate ALL four (xyflow,
    jsx-parser, Rive, media-chrome) to web-only on native**. Single
    user, no current mobile usage of those features → no native
    replacement effort spent in P3. The per-library replacement
    work (e.g., media-chrome → expo-audio) becomes a follow-up
    issue post-P3 when usage signal exists.

11. **Secondary libs (cmdk, embla, use-stick-to-bottom)**: only
    replace `use-stick-to-bottom` (chat scroll pin is load-bearing
    for chat UX). Feature-gate cmdk + embla to web on native;
    revisit when usage signal exists.

12. **GA gate: light VP, "use and fix"** continuous deployment
    shape. P3.0 pre-spike remains a hard go/no-go gate. Per-phase
    smoke tests but no formal multi-day dogfood ceremony. The
    parent's VP-2/VP-3-style evidence requirements drop to
    spot-checks during normal use.

13. **iOS scope: deferred to P4** (already established in P0;
    confirmed in P1).

### Process decisions

14. **Branch + PR**: feature branch `feat/gh132-p3-rn-native` per
    CLAUDE.md feature-scope rule. Multi-commit, push, open PR,
    merge when P3.5 use-and-fix gate passes. Clean revert path.

15. **CI gate evolution**: `scripts/check-metro-bundle.sh` (P2)
    replaced by `expo prebuild --no-install` smoke once P3 ships.
    Real Expo prebuild as the gate; Metro web-export ceremony
    drops as obsolete.

16. **Issue title update**: edit GH#132 title to reflect SDK 55
    override; spec preamble has a "Decisions overriding the issue
    body" section listing all 16 entries.

### Architectural bets (hard to reverse)

Per kata-interview methodology: decisions that lock direction and
should be called out in the spec for explicit review.

- **B1**: Expo SDK 55 (not 54). Reverting means dropping
  `react-native-reanimated-dnd` and feature-gating kanban (or
  building ~800 LOC custom).
- **B2**: New package, not in-place upgrade of `com.baseplane.duraclaw`.
  Reverting means migrating signing keys + Play App Signing later.
- **B3**: EAS Update self-host on R2 + Worker (not Expo CDN).
  Reverting means re-pointing `app.json` `updates.url` to Expo CDN
  and migrating any in-flight channels.
- **B4**: Reanimated 4 worklets (required by reanimated-dnd).
  Locks the animation runtime for all native motion. Tamagui's
  native animation driver must compose with it (verified in
  P3.0 spike).

### Open risks (known unknowns at spec-lock time)

- **R1**: SDK 55 GA timing — if SDK 55 isn't GA when P3 starts,
  fall back to SDK 54 + kanban feature-gate. P3.0 spike must check
  this on day 1.
- **R2**: `@better-auth/expo` API shape vs our existing fetch
  interceptor — may force the local wrapper after all. Spike check.
- **R3**: op-sqlite + SDK 55 Fabric integration — if pod/gradle
  build breaks on SDK 55, fall back to expo-sqlite.
- **R4**: Tamagui native animation driver + Reanimated 4 — if they
  conflict, kanban path is at risk. Spike check.
- **R5**: Self-hosted EAS Update — Expo's `custom-expo-updates-server`
  reference is community-grade; if its protocol implementation has
  gaps under our load (unlikely with single user, but worth noting),
  fall back to default Expo CDN.

### Codebase findings consolidated

See §1-7 of this doc for file:line catalog. Key constraints for
spec writer:

- All 14 native-conditional sites (full list in §1) must be touched.
- P2's existing CI gates (`check-worker-tamagui-leak.sh`,
  `check-metro-bundle.sh`, biome.json:93-111 import bans) must
  pass throughout P3 — never disable them.
- `apps/mobile/` directory transitions from Capacitor project to
  Expo project (or new `apps/mobile-expo/` and `apps/mobile/`
  archived during dogfood transition — let spec author choose
  layout).
- `apps/orchestrator/src/entry-rn.tsx` evolves from P2's smoke-bundle
  entry to P3's production AppRegistry entry.
- `apps/orchestrator/metro.config.cjs` may need stub-list updates
  as new native-only deps land.
