# @duraclaw/mobile-expo

Expo SDK 55 native Android target — replaces the Capacitor 8 shell at
`apps/mobile/` per [GH#132](https://github.com/baseplane-ai/duraclaw/issues/132).

## Package id

**`com.baseplane.duraclaw.rn`** (new — coexists side-by-side with the old
`com.baseplane.duraclaw` Capacitor APK during the dogfood transition).

## Toolchain prerequisites

- JDK 21 (`brew install --cask zulu@21` or distro JDK 21)
- Android SDK with cmdline-tools/latest, platform-tools, platforms;android-36,
  build-tools;36.0.0
- Export `ANDROID_HOME=$HOME/Android/sdk` (or your distro path) and
  `JAVA_HOME` pointing at JDK 21
- pnpm 9.x (workspace manager)

## First-time setup

```bash
cd apps/mobile-expo
pnpm install            # installs into root workspace
pnpm exec expo prebuild --platform android --clean
```

The prebuild step generates the `android/` native project. It is gitignored
— regenerated on every `build:android` run.

## google-services.json

The `apps/mobile-expo/android/app/google-services.json` is **not** a copy of
the old `apps/mobile/android/app/google-services.json`. The inner
`client.client_info.android_client_info.package_name` field must match the
runtime package, and the new package is `com.baseplane.duraclaw.rn`.

To regenerate:

1. Open Firebase Console → existing duraclaw project.
2. Add a new Android app under that project: package
   `com.baseplane.duraclaw.rn`, app nickname e.g. "Duraclaw RN".
3. Download the regenerated `google-services.json` (the file now contains
   client entries for BOTH packages — the old Capacitor one and the new RN
   one). Place it at `apps/mobile-expo/android/app/google-services.json`.
4. The RN-Firebase Gradle plugin reads this file at gradle build time —
   no further wiring needed.

## Build + sign + install

```bash
# Build (regenerates android/, runs gradle assembleRelease)
pnpm --filter @duraclaw/mobile-expo build:android

# Sign with the duraclaw keystore (same shape as apps/mobile)
KEYSTORE_PATH=~/.duraclaw-keystore.jks KEYSTORE_PASS=... \
  KEY_ALIAS=duraclaw KEY_PASS=... \
  pnpm --filter @duraclaw/mobile-expo sign:android

# Sideload to a wirelessly-connected dev device (see .claude/rules/mobile.md
# for ADB pairing convention — same as apps/mobile)
adb install -r apps/mobile-expo/android/app/build/outputs/apk/release/app-release-signed.apk
adb shell monkey -p com.baseplane.duraclaw.rn -c android.intent.category.LAUNCHER 1
```

## OTA updates (self-hosted EAS Update)

Updates are served from the duraclaw Worker, not the Expo CDN. See
`scripts/build-mobile-expo-ota.sh` and the routes
`/api/mobile/eas/manifest` + `/api/mobile/eas/assets/*` in
`apps/orchestrator/src/api/mobile/`.

Runtime version strategy is `'fingerprint'` — bumping a native dep
changes the hash, which forces a new APK build (the existing fingerprint's
clients will stay on their bundle). JS-only changes ship as OTA updates
on the same fingerprint.

## Differences vs apps/mobile (Capacitor)

| Concern | Capacitor (apps/mobile) | Expo (apps/mobile-expo) |
|---------|-------------------------|-------------------------|
| Web bundle | Vite → dist/client → cap sync | Metro bundles direct from source |
| Auth storage | Capacitor Preferences | expo-secure-store |
| SQLite | @capacitor-community/sqlite | @op-engineering/op-sqlite |
| Push | @capacitor/push-notifications | @react-native-firebase/messaging |
| Lifecycle | Capacitor App + Network | RN AppState + @react-native-community/netinfo |
| OTA channel | @capgo/capacitor-updater | expo-updates (custom server on R2 + Worker) |
| Package id | com.baseplane.duraclaw | com.baseplane.duraclaw.rn |

## Sunset of apps/mobile

Per spec B11, `apps/mobile/` is NOT deleted in this PR — kept for ~1-2
weeks post-merge as a revert path. A follow-up cleanup issue removes
`apps/mobile/`, `scripts/build-mobile-ota-bundle.sh`, the
`/api/mobile/updates/manifest` + `/api/mobile/apk/latest` Worker routes,
and the corresponding R2 layout.
