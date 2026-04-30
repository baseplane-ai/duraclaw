#!/usr/bin/env bash
#
# build-android.sh — orchestrate a release Android APK build for the Expo target.
#
# Pipeline:
#   1. expo prebuild --platform android --clean (regenerates native android/ project)
#   2. cd android && ./gradlew assembleRelease (produces unsigned APK)
#   3. Pass to scripts/sign-android.sh to produce a sideload-ready signed APK.
#
# Differences from apps/mobile/scripts/build-android.sh (Capacitor):
#   - No `cap sync` — Expo prebuild handles the same job (regen native projects).
#   - No separate Vite build — Metro bundles JS into the APK at gradle time.
#   - Package id is com.baseplane.duraclaw.rn (NEW — coexists with the old
#     com.baseplane.duraclaw Capacitor APK during the dogfood transition).

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT="$SCRIPT_DIR/../../.."
APP_DIR="$SCRIPT_DIR/.."

echo "==> [1/3] Stamping app version"
APP_VERSION="${APP_VERSION:-$(git -C "$REPO_ROOT" rev-parse --short HEAD)}"
export EXPO_PUBLIC_APP_VERSION="$APP_VERSION"
echo "    EXPO_PUBLIC_APP_VERSION=$EXPO_PUBLIC_APP_VERSION"

echo ""
echo "==> [2/3] expo prebuild --platform android --clean"
if [[ -z "${JAVA_HOME:-}" ]]; then
  echo "!!  JAVA_HOME is not set. Install JDK 21 and export JAVA_HOME." >&2
  exit 1
fi
if [[ -z "${ANDROID_HOME:-}" && -z "${ANDROID_SDK_ROOT:-}" ]]; then
  echo "!!  ANDROID_HOME (or ANDROID_SDK_ROOT) is not set." >&2
  exit 1
fi

cd "$APP_DIR"
pnpm exec expo prebuild --platform android --clean

echo ""
echo "==> [3/3] Gradle assembleRelease"
cd "$APP_DIR/android"
./gradlew assembleRelease

UNSIGNED_APK="$APP_DIR/android/app/build/outputs/apk/release/app-release-unsigned.apk"
echo ""
echo "==> Done. Unsigned APK:"
echo "    $UNSIGNED_APK"
echo ""
echo "    Next: sign with apps/mobile-expo/scripts/sign-android.sh"
