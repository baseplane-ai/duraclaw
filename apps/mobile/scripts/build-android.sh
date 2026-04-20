#!/usr/bin/env bash
#
# build-android.sh — orchestrate a release Android APK build.
#
# Pipeline:
#   1. Source apps/mobile/.env.production (VITE_PLATFORM, VITE_API_BASE_URL,
#      VITE_WORKER_PUBLIC_URL) so the orchestrator Vite build embeds the
#      correct deployed Worker URLs into the JS bundle.
#   2. Build the orchestrator (apps/orchestrator/dist/client) — capacitor.config.ts
#      points webDir at this directory.
#   3. Sync native plugins + web assets into the Android project (cap sync).
#   4. Run Gradle assembleRelease to produce an unsigned APK. Pass to
#      scripts/sign-android.sh to produce a sideload-ready signed APK.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT="$SCRIPT_DIR/../../.."
MOBILE_DIR="$SCRIPT_DIR/.."
ENV_FILE="$MOBILE_DIR/.env.production"

echo "==> [1/4] Loading mobile production env"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a
  source "$ENV_FILE"
  set +a
  echo "    sourced $ENV_FILE"
  echo "    VITE_PLATFORM=${VITE_PLATFORM:-<unset>}"
  echo "    VITE_API_BASE_URL=${VITE_API_BASE_URL:-<unset>}"
  echo "    VITE_WORKER_PUBLIC_URL=${VITE_WORKER_PUBLIC_URL:-<unset>}"
else
  echo "!!  $ENV_FILE not found — orchestrator build will produce a web-targeted bundle"
  echo "!!  the resulting APK will not connect to the deployed Worker"
fi

echo ""
echo "==> [2/4] Building orchestrator (Vite production build)"
cd "$REPO_ROOT"
# Stamp the built bundle with the git SHA so the mobile OTA updater can
# compare installed version vs. deployed version (see mobile-updater.ts).
APP_VERSION="${APP_VERSION:-$(git rev-parse --short HEAD)}"
export VITE_APP_VERSION="$APP_VERSION"
echo "    VITE_APP_VERSION=$VITE_APP_VERSION"
pnpm --filter @duraclaw/orchestrator build

echo ""
echo "==> [3/4] Syncing Capacitor (web assets + native plugins → android/)"
cd "$MOBILE_DIR"
pnpm exec cap sync android

echo ""
echo "==> [3b/4] Emitting mobile OTA bundle zip"
# Must run AFTER cap sync so the zip doesn't get bundled into the APK
# (which would double the binary size and defeat OTA updates). The
# actual work is shared with the infra deploy pipeline — see
# scripts/build-mobile-ota-bundle.sh.
cd "$REPO_ROOT"
APP_VERSION="$APP_VERSION" bash scripts/build-mobile-ota-bundle.sh

echo ""
echo "==> [4/4] Gradle assembleRelease"
if [[ -z "${JAVA_HOME:-}" ]]; then
  echo "!!  JAVA_HOME is not set. Install JDK 21 (Capacitor 8 default) and export JAVA_HOME before running this script." >&2
  exit 1
fi
if [[ -z "${ANDROID_HOME:-}" && -z "${ANDROID_SDK_ROOT:-}" ]]; then
  echo "!!  ANDROID_HOME (or ANDROID_SDK_ROOT) is not set." >&2
  echo "!!  Install Android SDK with cmdline-tools/latest, platform-tools, platforms;android-36," >&2
  echo "!!  build-tools;36.0.0 and export ANDROID_HOME=\$HOME/Android/sdk." >&2
  exit 1
fi

cd "$MOBILE_DIR/android"
./gradlew assembleRelease

UNSIGNED_APK="$MOBILE_DIR/android/app/build/outputs/apk/release/app-release-unsigned.apk"
echo ""
echo "==> Done. Unsigned APK:"
echo "    $UNSIGNED_APK"
echo ""
echo "    Next: sign with apps/mobile/scripts/sign-android.sh"
