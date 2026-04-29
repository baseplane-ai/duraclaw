# Capacitor (Android shell + Firebase push + OTA)

Source package / configuration: `apps/mobile/` (the Capacitor 8 Android shell), `scripts/build-mobile-ota-bundle.sh` (the OTA payload builder), and `apps/orchestrator/src/lib/mobile-updater.ts` (the in-bundle OTA client).

## Version

`@capacitor/core` and `@capacitor/android` pinned at `^8.3.1` in `apps/mobile/package.json`. Companion plugins: `@capacitor/app`, `@capacitor/network`, `@capacitor/preferences`, `@capacitor/push-notifications` at `^8.0.1`; `@capacitor-community/sqlite` at `^8.1.0`; `@capgo/capacitor-updater` at `^7.0.0`. Mobile-side bearer plugin `better-auth-capacitor` lives in the orchestrator package.

## Footprint

Capacitor 8 wraps the orchestrator's web bundle into a sandboxed `capacitor://localhost` Android WebView that talks to the deployed Worker over HTTPS / WSS. **Thin client** — there is no local server in the APK; same React SPA, same routes as the desktop browser.

Native swaps the SPA performs on Capacitor:

- OPFS sqlite -> `@capacitor-community/sqlite`
- cookie auth -> `better-auth-capacitor` bearer-token replay
- Web Push -> Firebase Cloud Messaging (FCM) HTTP v1 via a `jose`-signed JWT, dispatched by the Worker (`apps/orchestrator/src/lib/push-fcm.ts`); device side is `@capacitor/push-notifications`. FCM provisioning lives in `apps/mobile/android/app/google-services.json` (gitignored; per-environment).
- WS host overridden via `useAgent({ host: wsBaseUrl() })`.

Platform gating is in `apps/orchestrator/src/lib/platform.ts` — `isNative()` keys off `import.meta.env.VITE_PLATFORM === 'capacitor'`, dead-code-eliminated from the web bundle. Native imports (`@capacitor/*`) are dynamic so they tree-shake out of the web build.

## OTA pipeline

Two update channels:

1. **Web-bundle OTA via `@capgo/capacitor-updater`** — covers ~95% of releases. `initMobileUpdater()` (`apps/orchestrator/src/lib/mobile-updater.ts`) runs on every native launch from `entry-client.tsx`: calls `notifyAppReady()`, POSTs `{platform, version_name: VITE_APP_VERSION}` to `/api/mobile/updates/manifest`, and on a newer version `download()`s + `set()`s the zip; the WebView reloads into the new bundle on next mount.
2. **Native-APK fallback** — fires only on native-layer code changes (Capacitor / plugin bump). `checkNativeApkUpdate()` polls `GET /api/mobile/apk/latest`, compares to `App.getInfo().version`, and on mismatch prompts the user.

Build flow:

- `VITE_APP_VERSION` is stamped in by `apps/mobile/scripts/build-android.sh` as `git rev-parse --short HEAD`.
- After `cap sync`, `scripts/build-mobile-ota-bundle.sh` stages a copy of `apps/orchestrator/dist/client`, zips it (excluding `mobile/` to avoid self-nesting), writes `version.json` (`{version, key}`).
- The infra deploy pipeline uploads `ota/bundle-<sha>.zip` and `ota/version.json` to the `duraclaw-mobile` R2 bucket. Without the upload step the OTA channel is dead.
- The Worker's `/api/mobile/updates/manifest` route reads `ota/version.json` via `env.MOBILE_ASSETS.get()` and hands Capgo a same-origin URL streamed through `GET /api/mobile/assets/*` — no public R2 URLs.

Both manifest routes are public (registered before `authMiddleware`) so an expired-session user can still update.

## Assumptions

- **Android-only.** No iOS shell exists; `@capacitor/ios` is not pinned.
- **Firebase is push-only** — never an auth source, never a data host. The dependency is `google-services.json` + the FCM HTTP v1 endpoint signed via `jose`.
- The OTA bundle **excludes service-worker hashing** because the native shell handles caching (Capgo) and the WebView reloads point at the new bundle directory directly.
- The Capacitor WebView's `androidScheme: 'https'` makes its Origin `https://localhost`; Better Auth's `trustedOrigins` includes that explicitly in production.
- The infra deploy pipeline is responsible for the R2 upload of `ota/bundle-<sha>.zip` + `ota/version.json`; `scripts/build-mobile-ota-bundle.sh` only produces local artifacts.
- The native shell polls `/api/mobile/updates/manifest` (Worker) — not R2 directly — so no public R2 URL is exposed.
- APK signing is out-of-band: production keystore in 1Password; CI passes `KEYSTORE_PATH` / `KEYSTORE_PASS` / `KEY_ALIAS` / `KEY_PASS`.

## What would break if

- An **iOS path** were added — would require a parallel push integration (APNs with its own server-side credentials), making the Firebase assumption Android-only and adding a new boundary entry.
- **Firebase project rotation** (new sender id / new service account) breaks all currently-installed devices' push until they re-register their FCM token.
- **R2 bucket rename** (`duraclaw-mobile` -> something else) breaks OTA polling because the Worker route hardcodes that binding via wrangler.toml; every shipped APK polls forever and stays on its baked-in bundle.
- A **Capgo updater SemVer-major bump** changing the `download()` / `set()` contract requires coordinated APK + bundle re-release because the in-flight bundle calls the new API on the previous native shell.
- An **Android WebView regression** changing `capacitor://localhost` Origin -> Better Auth CSRF check fails on every native request until `trustedOrigins` is updated.
- Skipping the **infra-pipeline OTA upload step** silently freezes every APK on its baked-in bundle (manifest reports "no newer version available").

## See also

- [`docs/theory/boundaries.md`](../theory/boundaries.md) — Capacitor + Firebase boundary entry.
- [`docs/integrations/cloudflare.md`](./cloudflare.md) — `duraclaw-mobile` R2 bucket details and the Worker passthrough route.
- `apps/mobile/README.md` — full prerequisites, FCM provisioning, dev keystore generation.
- `planning/specs/26-capacitor-android-mobile-shell.md` — the original mobile shell spec.
