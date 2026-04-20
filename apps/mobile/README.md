# @duraclaw/mobile

Capacitor Android shell for Duraclaw. Wraps the orchestrator React bundle
(`apps/orchestrator/dist/client`) in a native Android WebView and swaps
the OPFS wa-sqlite persistence layer for `@capacitor-community/sqlite`,
auth for bearer-replay via `better-auth-capacitor`, and Web Push for FCM.

## Mobile distribution

### Build

From the repo root:

```bash
pnpm --filter @duraclaw/mobile build:android
```

This runs `apps/mobile/scripts/build-android.sh`, which:

1. Sources `apps/mobile/.env.production` so `VITE_PLATFORM=capacitor` and the
   deployed Worker URLs are baked into the bundle.
2. Builds the orchestrator (`pnpm --filter @duraclaw/orchestrator build`).
3. Runs `pnpm exec cap sync android` to copy web assets + native plugins.
4. Runs `./gradlew assembleRelease` in `apps/mobile/android/`.

Output: `apps/mobile/android/app/build/outputs/apk/release/app-release-unsigned.apk`.

Requires `JAVA_HOME` (JDK 21) and `ANDROID_HOME` (with `cmdline-tools/latest`,
`platform-tools`, `platforms;android-36`, `build-tools;36.0.0`) on PATH.

### Sign

```bash
export KEYSTORE_PATH=~/.duraclaw-keystore.jks
export KEYSTORE_PASS=<pass>
export KEY_ALIAS=duraclaw
export KEY_PASS=<pass>
apps/mobile/scripts/sign-android.sh
```

Outputs `app-release-signed.apk` next to the unsigned APK and runs
`apksigner verify` as a sanity check. Run with no env vars set to print
the dev-keystore-generation help block.

The production keystore lives in the 1Password Engineering vault — see the
infra runbook for retrieval and CI secret bindings.

### Install on device

1. On the Android device, enable "Install from unknown sources" for your
   browser or file manager (Settings > Apps > Special access).
2. Either sideload via ADB:
   ```bash
   adb install -r apps/mobile/android/app/build/outputs/apk/release/app-release-signed.apk
   ```
   or distribute the signed APK via a secure download link (e.g. 1Password
   shared item, internal S3 bucket with signed URL) and tap-to-install.
3. First launch will prompt for notification permission (FCM push).
