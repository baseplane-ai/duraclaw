# Mobile

Source package: `apps/mobile/`.

A Capacitor 8 Android shell that wraps the orchestrator React bundle as a sandboxed `capacitor://localhost` WebView. Thin client by construction — no local server in the APK, no privileged paths the desktop browser does not have. Talks to the deployed Worker over HTTPS / WSS.

## Module Test

- **Nav entry / surface:** `apps/mobile/` — the Capacitor 8 Android shell. Built via `pnpm --filter @duraclaw/mobile build:android` and signed via `apps/mobile/scripts/sign-android.sh`. End users run the signed APK installed from the duraclaw distribution channel.
- **Owns:** the native shell (Android Gradle module, Capacitor config), the OTA-bundle pull (Capgo + self-hosted APK fallback), the FCM push-notifications wiring, the platform-gating module that the orchestrator's web bundle uses to swap native vs. web behaviour.
- **Domain question:** How does duraclaw run on Android without re-shipping a native binary for every web change?

## Owns

- `apps/mobile/android/` — Gradle module, AndroidManifest, signing config, build outputs
- `apps/mobile/scripts/build-android.sh` and `apps/mobile/scripts/sign-android.sh` — the build + sign pipeline
- The in-app OTA poll (`initMobileUpdater()` in `apps/orchestrator/src/lib/mobile-updater.ts`) — calls `notifyAppReady()`, POSTs the platform + `VITE_APP_VERSION` to `/api/mobile/updates/manifest`, downloads + sets the new bundle on a hit
- The native-APK fallback (`checkNativeApkUpdate()` polling `GET /api/mobile/apk/latest`) for Capacitor / native-plugin bumps that the web-bundle channel cannot deliver
- The platform-gating module `apps/orchestrator/src/lib/platform.ts` (`isNative()` keys off `import.meta.env.VITE_PLATFORM === 'capacitor'`)

## Consumes

- [`docs/integrations/capacitor.md`] — Capacitor 8 runtime, the `@capacitor/*` plugins, `@capgo/capacitor-updater` for the OTA channel
- [`docs/modules/orchestrator.md`] — the OTA bundle is uploaded to the `duraclaw-mobile` R2 bucket by the orchestrator's release pipeline; `/api/mobile/updates/manifest` and `/api/mobile/apk/latest` are public routes mounted before auth middleware so an expired-session user can still update

## Theory references

- [`docs/theory/topology.md`] — the mobile shell is the same SPA running inside Capacitor; it does not introduce new edges or new privileged paths
- [`docs/theory/boundaries.md`] — Firebase / FCM HTTP v1 (jose-signed JWT) is the platform boundary for push; Capgo is the platform boundary for OTA bundle distribution

## Native swaps

- OPFS sqlite → `@capacitor-community/sqlite`
- Cookie auth → `better-auth-capacitor` bearer
- Web Push → FCM HTTP v1 via `jose`-signed JWT (`apps/orchestrator/src/lib/push-fcm.ts`)
- WS host → `useAgent({ host: wsBaseUrl() })` so the client dials the deployed Worker, not `capacitor://localhost`

Native imports (`@capacitor/*`) are dynamic so they tree-shake out of the web build; `isNative()` is dead-code-eliminated from the web bundle by Vite.

## OTA contract

Two channels:

1. **Web-bundle OTA via `@capgo/capacitor-updater`** — covers ~95% of releases. The build script runs `scripts/build-mobile-ota-bundle.sh`, which stages a copy of `dist/client`, zips it, and writes `version.json` (`{version, key}`) alongside. The infra deploy pipeline uploads both to the `duraclaw-mobile` R2 bucket. The Worker reads `ota/version.json` via `env.MOBILE_ASSETS.get(...)`. `MOBILE_ASSETS` is declared optional in the `Env` type — Workers deployed without the bucket bound degrade to "no update available" instead of 500'ing.
2. **Native-APK fallback** — fires only when native-layer code changes (Capacitor / plugin bump). On mismatch the user is `window.confirm()`ed.

`VITE_APP_VERSION` is stamped into the bundle by `apps/mobile/scripts/build-android.sh` as `git rev-parse --short HEAD`.

## Toolchain pins

JDK 21, Android SDK platform 36, build-tools 36.0.0. Full prerequisites, FCM provisioning, dev-keystore generation, and source-map are in `apps/mobile/README.md`. Production keystore lives in a secrets manager (the project uses 1Password); never commit `.jks` files or signing passwords.

## Spec

`planning/specs/26-capacitor-android-mobile-shell.md` (GitHub issue #26, PR #29) is the source of truth for the shell, the OTA channels, and the native-swap matrix.
