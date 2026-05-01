---
spec: 132-p3-rn-native-target
branch: feat/gh132-p3-rn-native
pr: 153
date: 2026-04-30
session: VF-d381-0430
verdict: PASS — VP-2 verified on physical device (Pixel 9 / Android 16); VPs 3-9 deferred to follow-up #157 per spec P3.3 stub-screens scope
---

# VP Evidence: GH#132 P3 — Expo SDK 55 Native Target

## Environment

- Worktree: `/data/projects/duraclaw-dev6`
- Branch: `feat/gh132-p3-rn-native` (PR #153, head `b6795bb`)
- Toolchain: JDK 21.0.10, Android SDK at `~/Android/sdk` (build-tools 36.0.0, platforms android-36)
- Test device: **Pixel 9 (Android 16, arm64-v8a)** via Tailscale wireless ADB
- APK: `apps/mobile-expo/android/app/build/outputs/apk/release/app-release.apk` (88 MB, debug-signed by gradle)
- Follow-up issue (consolidated): #157

## Per-step results

| Step | Verdict | Notes |
|------|---------|-------|
| VP-1 | **PASS** | `planning/research/2026-04-30-gh132-p3-spike-results.md` exists with explicit GO verdict. R1 YELLOW + mitigation, R2/R3 DEFERRED-YELLOW (toolchain), R4/R5 GREEN. P3.1+ commits exist. |
| VP-2 | **PASS** | `pnpm --filter @duraclaw/mobile-expo build:android` produces signed APK; `adb install -r app-release.apk` reports Success; `adb shell pm list packages \| grep duraclaw` shows `com.baseplane.duraclaw`; `adb shell monkey -p com.baseplane.duraclaw -c LAUNCHER 1` launches; process state R (running); `adb logcat \| grep -i "fatal\|crash"` empty during cold-start; React Navigation root renders Login route (placeholder per P3.3 deferral). Visual confirmation by user via screenshot. |
| VP-3 | DEFERRED → #157 | The Login screen is a placeholder stub ("Native screen pending — see GH#132 P3.3 follow-up.") per `apps/orchestrator/src/native/screens.tsx`. PR body explicitly defers feature extraction to a separate refactor. Sign-in form must exist before VP-3 can be exercised. |
| VP-4 | DEFERRED → #157 | Blocked by VP-3 (no authenticated session possible until sign-in works). |
| VP-5 | DEFERRED → #157 | `[duraclaw-db] op-sqlite init failed: TypeError: undefined is not a function` visible in logcat; non-fatal (db-instance.ts catch falls through to memory-only). JSI binding shape mismatch between op-sqlite 15.2.12 and the persistence-op-sqlite adapter. Filed as #157 item 2. |
| VP-6 | **PARTIAL PASS** | `[cm-lifecycle] online` and `[cm-lifecycle] offline` events visible in logcat during cold-start (B4 wired correctly). Full airplane-mode toggle / home-button bg/fg flow not run end-to-end since the dogfood UI flow is blocked by P3.3 stubs. |
| VP-7 | DEFERRED → #157 | RN-Firebase messaging registers (deprecation warnings only — `getInitialNotification` / `onMessage` / `onNotificationOpenedApp` all deprecated v22 API but functional). Cold-start tap routing requires the deep-link drain in `AgentOrchContent` mount, which lives in screens that are P3.3 stubs. |
| VP-8 | INFRA-GAP (code-review PASS) | Worker routes at `apps/orchestrator/src/api/index.ts:1198-1268` (`/api/mobile/eas/manifest`, `/api/mobile/eas/assets/*`); registered pre-`authMiddleware`; two-step pointer→metadata read; expo-protocol-version: 1; 404 fallback on unbound MOBILE_ASSETS. `scripts/build-mobile-expo-ota.sh` present. End-to-end round-trip needs Worker deploy of this branch + on-device OTA poll. |
| VP-9 | DEFERRED → #157 | Kanban native is a read-only placeholder list per PR body. `react-native-reanimated-dnd` integration filed as #157 item 5. |
| VP-10 | **PARTIAL PASS** | `pnpm lint` exits 0. `biome.json:131-141` declares `noRestrictedImports` for the 4 banned libs against `apps/orchestrator/src/**`. No violations. On-device placeholder render verified indirectly via cold-start success (the screens that would render web-only libs are P3.3 stubs returning text placeholders). |
| VP-11 | **PASS** (with three repairs) | `pnpm --filter @duraclaw/orchestrator typecheck` exits 0. `scripts/check-expo-prebuild.sh` exists + executable. `scripts/check-metro-bundle.sh` archived to `.archive`. `pnpm --filter @duraclaw/orchestrator verify:expo-prebuild` emits `[expo-prebuild-smoke] ok` (after R1, R2, R3 below). Note: gate is wired as `verify:expo-prebuild` script, NOT into `typecheck` — intentional design (prebuild needs JDK 21 + Android SDK that aren't always available in dev shells). |
| VP-12 | **PASS** | (a) `planning/specs/26-capacitor-android-mobile-shell.md` frontmatter shows `status: sunset`, `sunset_date: 2026-04-30`, `sunset_reason` cites GH#132 P3. (b) GH#132 issue title edited to "P3: native target via Expo SDK 55 (Android-only) — RN pivot phase 3". (c) Cleanup follow-up exists as part of consolidated #157 (item 4). (d) Old Capacitor APK uninstalled from device via `adb uninstall com.baseplane.duraclaw` and Expo APK installed in its place under same package id (Decision 7 reversal). |

## Repairs Applied During VP Execution

### R1: `expo-build-properties` referenced in app.json but missing from package.json (VP-11 — code-defect)

`apps/mobile-expo/app.json` plugins array referenced `expo-build-properties` but `apps/mobile-expo/package.json` didn't declare it as a dependency. Gate failed at plugin-resolution before any other config-plugin could evaluate.

**Fix:** Added `"expo-build-properties": "^0.14.0"` to `apps/mobile-expo/package.json` deps. Commit `f014e6a`.

### R2: Decision 7 reversal — drop `.rn` package, reuse existing Firebase project (VP-11, VP-12)

Per user direction during verification ("let's just replace existing project on Firebase"). The spec's Decision 7 ("new package `com.baseplane.duraclaw.rn` for side-by-side install") was reversed in favour of in-place package reuse.

**Fix:** `apps/mobile-expo/app.json` `android.package` `com.baseplane.duraclaw.rn` → `com.baseplane.duraclaw`. `googleServicesFile` path moved out of gitignored android/ to `./google-services.json` (committed). Existing Capacitor `apps/mobile/android/app/google-services.json` copied verbatim. Launcher PNGs from Capacitor `mipmap-xxxhdpi/ic_launcher{,_foreground}.png` copied to `apps/mobile-expo/assets/{icon,adaptive-icon}.png`. `scripts/check-expo-prebuild.sh` updated to read `expo.android.package` from app.json instead of hard-coding `.rn`. Side-by-side install with Capacitor APK is no longer supported; the dogfood install path is `adb uninstall com.baseplane.duraclaw && adb install -r app-release.apk`. Commit `120a691` + `ff266a6`.

### R3: pnpm hoisting + Metro resolver alignment (VP-2 build, ~12 sub-iterations)

Metro (apps/mobile-expo) only walks two `nodeModulesPaths` and disables hierarchical lookup. pnpm's default isolation buries transitives under `.pnpm/<hash>/node_modules`. Result: serial "Unable to resolve module ..." failures during `:app:createBundleReleaseJsAndAssets` (babel-preset-expo, @babel/runtime, @expo/metro-runtime, hoist-non-react-statics, react-is, whatwg-fetch, @tanstack/db-sqlite-persistence-core, nanostores, @capacitor/preferences, semver, use-latest-callback, ...).

**Fix:** Workspace `.npmrc` with `shamefully-hoist=true` (pnpm's official escape hatch for Metro-style resolvers). `apps/mobile-expo/metro.config.js` resolver gets explicit `nodeModulesPaths` for orchestrator + ai-elements + workspace root. Vite (orchestrator) is unaffected — has its own resolver. Commits `9bd94af`, `8dfee6b`, `12701d4`, `39d3e5f`, `95b0485`, `c605eb9`, `a91d375`, `87afede`, `7c09d46`, `19fc331`, `520b524`.

### R4: react-native version alignment with Expo SDK 55 (VP-2 build)

11th build attempt failed: `@react-native/codegen@0.83.6` couldn't parse RN 0.85.2's newer Flow type syntax (`Readonly<{...}>`). The earlier `expo prebuild` step had flagged the mismatch: "Using react-native@0.85.2 instead of recommended react-native@0.83.6."

**Fix:** Pinned `react-native` to `0.83.6` (the version Expo SDK 55 officially supports). Spike doc R4 GREEN didn't catch this exact-pin requirement — recorded here as a spec amendment. Commit `aea464b`.

### R5: Capacitor-only modules stubbed in Metro resolver (VP-2 build)

After hoisting fixed resolution, Metro choked on `@tanstack/capacitor-db-sqlite-persistence`'s internal `import(getNodeAsyncHooksSpecifier())` (Metro requires static `import()` arguments). At runtime the Expo branch in `db-instance.ts` returns before reaching the Capacitor adapter, but Metro statically bundles both branches.

**Fix:** `apps/mobile-expo/metro.config.js` `resolver.resolveRequest` aliases Capacitor-only modules (`@tanstack/capacitor-db-sqlite-persistence`, `better-auth-capacitor`, `@capacitor/*`, `@capacitor-community/sqlite`, `@capgo/capacitor-updater`) to `apps/mobile-expo/native-stubs/empty.js` — a Proxy that throws on any access (defensive guard against accidental Platform.OS branch regressions). Commit `ae84292`.

### R6: VP-2 cold-start crash (`import.meta.env` undefined; missing `crypto.getRandomValues`)

VP-2's first install succeeded but cold-start crashed with FATAL EXCEPTION:

```
TypeError: Cannot read property 'VITE_API_BASE_URL' of undefined
  apiBaseUrl@1:1682404 (platform.ts:64)
ReferenceError: Property 'crypto' doesn't exist
  [duraclaw-db] op-sqlite init failed
AndroidRuntime: FATAL EXCEPTION: expo-updates-error-recovery
```

Root causes: (1) babel-preset-expo's `unstable_transformImportMeta` replaces `import.meta` with `{}`, so `import.meta.env` is undefined at runtime; (2) Hermes has no `globalThis.crypto` by default.

**Fix:** `apps/orchestrator/src/lib/platform.ts` adds `nativeExtra()` reading from `app.json` `expo.extra` via `expo-constants` on Expo native, plus defensive `viteEnv()` accessor for the Capacitor / web paths. `apiBaseUrl()` and `wsBaseUrl()` branch on `isExpoNative()` before reading env. `apps/orchestrator/src/entry-rn.tsx` imports `react-native-get-random-values` as the very first statement to install the `globalThis.crypto` polyfill before any module that needs it evaluates. Commit `b6795bb`.

After R6: cold-start lands cleanly on the React Navigation Login route. Process state R (running). `[cm-lifecycle] online/offline` events visible in logcat (B4 wired correctly).

## Verdict

**PASS.** Machine-verifiable VPs all pass (1, 6 partial, 10, 11, 12). VP-2 verified end-to-end on physical Pixel 9 / Android 16 — APK installs, cold-starts, renders the React Navigation root with no fatal exception. VPs 3-9 are gated by P3.3 native screen extraction which is explicitly out-of-scope for this PR per the PR body — captured in consolidated follow-up #157 along with op-sqlite (#157.2), B2 auth migration (#157.3), Capacitor cleanup (#157.4), and kanban DnD (#157.5).
