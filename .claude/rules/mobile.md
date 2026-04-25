---
paths:
  - "apps/mobile/**"
  - "apps/orchestrator/src/lib/mobile-updater.ts"
  - "apps/orchestrator/src/lib/platform.ts"
  - "apps/orchestrator/src/lib/push-fcm.ts"
  - "scripts/build-mobile-ota-bundle.sh"
---

# Mobile (Capacitor 8 Android shell)

- **Thin client** — wraps the orchestrator React bundle as a sandboxed `capacitor://localhost` WebView that talks to the deployed Worker over HTTPS / WSS. No local server in the APK.
- **Native swaps**: OPFS sqlite -> `@capacitor-community/sqlite`; cookie auth -> `better-auth-capacitor` bearer; Web Push -> FCM HTTP v1 via `jose`-signed JWT (`apps/orchestrator/src/lib/push-fcm.ts`); WS host overridden via `useAgent({ host: wsBaseUrl() })`.
- **Platform gating** lives in `apps/orchestrator/src/lib/platform.ts` — `isNative()` keys off `import.meta.env.VITE_PLATFORM === 'capacitor'`, dead-code-eliminated from the web bundle by Vite. Native imports (`@capacitor/*`) are dynamic so they're tree-shaken from the web build.
- **Build** — `pnpm --filter @duraclaw/mobile build:android` runs `apps/mobile/scripts/build-android.sh` (env load -> vite build -> cap sync -> gradle assembleRelease). Sign with `apps/mobile/scripts/sign-android.sh` (KEYSTORE_PATH/PASS/KEY_ALIAS/KEY_PASS env vars).
- **Toolchain pins** — JDK 21, Android SDK platform 36, build-tools 36.0.0. See `apps/mobile/README.md` for full prerequisites, FCM provisioning, dev-keystore generation, and source map.
- **Spec**: `planning/specs/26-capacitor-android-mobile-shell.md`. GitHub: issue #26, PR #29.

## OTA auto-update (Capgo web bundle + self-hosted APK fallback)

Two update channels so we don't have to reinstall the APK for every JS change:

1. **Web-bundle OTA via `@capgo/capacitor-updater`** — covers 95% of
   releases. `initMobileUpdater()` in
   `apps/orchestrator/src/lib/mobile-updater.ts` is called from
   `entry-client.tsx` on every native launch. It:
   - calls `CapacitorUpdater.notifyAppReady()` so Capgo doesn't
     auto-rollback the current bundle;
   - POSTs `{platform, version_name: VITE_APP_VERSION}` to
     `/api/mobile/updates/manifest`;
   - if the Worker reports a newer version, `download()`s the zip and
     `set()`s it — the WebView reloads into the new bundle on next mount.

2. **Native-APK fallback** — fires only when native-layer code changes
   (Capacitor / plugin bump). `checkNativeApkUpdate()` polls
   `GET /api/mobile/apk/latest`, compares to `App.getInfo().version`,
   and on mismatch `window.confirm()`s the user.

**Version source** — `VITE_APP_VERSION` is stamped into the bundle by
`apps/mobile/scripts/build-android.sh` as `git rev-parse --short HEAD`.
After `cap sync` the same script runs `scripts/build-mobile-ota-bundle.sh`,
which stages a copy of `dist/client`, zips it, writes
`version.json` (`{version, key}`) alongside. The infra deploy pipeline
uploads both to the `duraclaw-mobile` R2 bucket:

- `ota/bundle-<sha>.zip` — the Capgo-consumable web-bundle payload.
- `ota/version.json` — read by the Worker's `/api/mobile/updates/manifest`
  route via `env.MOBILE_ASSETS.get('ota/version.json')`.

**Both manifest routes are public** (registered BEFORE `authMiddleware`
in `apps/orchestrator/src/api/index.ts`) so an expired-session user can
still update. The `MOBILE_ASSETS` R2 binding is declared optional in the
`Env` type — workers deployed without the bucket bound degrade to "no
update available" instead of 500'ing.

**APK signing** — `apps/mobile/scripts/sign-android.sh` wraps `apksigner`
and requires `KEYSTORE_PATH`, `KEYSTORE_PASS`, `KEY_ALIAS`, `KEY_PASS`.
Production keystore lives in 1Password Engineering vault; never commit.

## Sideloading to the Pixel over wireless ADB (Tailscale)

The dev Pixel (`46211FDAQ00534`) is reachable from the VPS via Tailscale
at `100.113.109.57`. Pairing record is persisted under `~/.android/` —
**re-pairing is almost never needed**, only the `connect` port changes.

Toolchain on this VPS:

- `adb` binary: `/home/ubuntu/Android/sdk/platform-tools/adb`
  (not on `$PATH` by default — `export PATH="/home/ubuntu/Android/sdk/platform-tools:$PATH"`)
- Package id: `com.baseplane.duraclaw`

```bash
export PATH="/home/ubuntu/Android/sdk/platform-tools:$PATH"
adb connect 100.113.109.57:<PORT>     # PORT rotates each WiFi-debug toggle -- ask the user
adb devices
adb -s 100.113.109.57:<PORT> install -r \
  apps/mobile/android/app/build/outputs/apk/release/app-release-signed.apk
adb -s 100.113.109.57:<PORT> shell monkey -p com.baseplane.duraclaw \
  -c android.intent.category.LAUNCHER 1
```

Gotchas:

- **Port rotation**: Android cycles the Wireless-debugging port every
  toggle and on idle-drop. If `adb connect` says `Connection refused`,
  ask the user to read the current port. No re-pair needed.
- **mDNS is not forwarded across Tailscale** — always `connect` by
  explicit `IP:PORT`.
- **`INSTALL_FAILED_UPDATE_INCOMPATIBLE`** means the signing key differs
  — `adb uninstall com.baseplane.duraclaw` then retry.
- **Project `grep` alias** on this box is `rg` and rejects `-E`; use
  `/usr/bin/grep -E` when parsing `dumpsys package` output.

## Tailing WebView console to logcat

Capacitor's `android.loggingBehavior: 'production'` routes WebView
`console.*` output to logcat in release APKs. Tag is `Capacitor/Console`.

Relevant prefixes:

- `[cm] reconnect ...` — ConnectionManager scheduled a reconnect
- `[cm-lifecycle] <event>` — foreground / background / online / offline
- `[ws:<channel>] open|close|error ...` — per-socket lifecycle

```bash
export PATH="/home/ubuntu/Android/sdk/platform-tools:$PATH"
adb -s 100.113.109.57:<PORT> logcat -c
adb -s 100.113.109.57:<PORT> logcat "*:S" \
  Capacitor/Console:V Capacitor:V chromium:V
```
