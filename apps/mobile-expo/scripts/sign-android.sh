#!/usr/bin/env bash
#
# sign-android.sh — sign a release APK from the Expo target with apksigner.
#
# Mirrors apps/mobile/scripts/sign-android.sh exactly, except:
#   - The default input APK comes from the Expo prebuild gradle output, which
#     lives at apps/mobile-expo/android/app/build/outputs/apk/release/app-release-unsigned.apk
#   - The signed output package is com.baseplane.duraclaw — same as the
#     Capacitor APK (Decision 7 reversed during VP-11 verification, commit
#     120a691). To install over an existing Capacitor APK without
#     INSTALL_FAILED_UPDATE_INCOMPATIBLE, sign with the SAME keystore that
#     signed the Capacitor build. Otherwise `adb uninstall com.baseplane.duraclaw`
#     before installing this APK (acceptable since Capacitor is sunsetting).
#
# Usage:
#   KEYSTORE_PATH=~/.duraclaw-keystore.jks \
#   KEYSTORE_PASS=... \
#   KEY_ALIAS=duraclaw \
#   KEY_PASS=... \
#     ./apps/mobile-expo/scripts/sign-android.sh [path/to/app-release-unsigned.apk]

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
APP_DIR="$SCRIPT_DIR/.."
DEFAULT_IN="$APP_DIR/android/app/build/outputs/apk/release/app-release-unsigned.apk"

IN_APK="${1:-$DEFAULT_IN}"

if [[ ! -f "$IN_APK" ]]; then
  echo "!!  Input APK not found: $IN_APK" >&2
  echo "!!  Run apps/mobile-expo/scripts/build-android.sh first." >&2
  exit 1
fi

OUT_APK="${IN_APK/-unsigned.apk/-signed.apk}"
if [[ "$OUT_APK" == "$IN_APK" ]]; then
  OUT_APK="${IN_APK%.apk}-signed.apk"
fi

missing=0
for var in KEYSTORE_PATH KEYSTORE_PASS KEY_ALIAS KEY_PASS; do
  if [[ -z "${!var:-}" ]]; then
    echo "!!  Required env var $var is not set." >&2
    missing=1
  fi
done

if [[ "$missing" -ne 0 ]]; then
  cat >&2 <<'HELP'

Generate a development keystore (one-time, local dev only):

  keytool -genkey -v -keystore ~/.duraclaw-keystore.jks \
    -keyalg RSA -keysize 2048 -validity 10000 -alias duraclaw \
    -storepass <pass> -keypass <pass> \
    -dname "CN=Duraclaw, OU=Eng, O=Baseplane, L=Internal, S=Internal, C=US"

Reuse the existing apps/mobile/ Capacitor keystore if you have it — same
package id (com.baseplane.duraclaw), same key → install path replaces the
Capacitor APK without uninstall. Different key → adb uninstall first.
HELP
  exit 1
fi

if [[ ! -f "$KEYSTORE_PATH" ]]; then
  echo "!!  Keystore not found at: $KEYSTORE_PATH" >&2
  exit 1
fi

if [[ -z "${ANDROID_HOME:-}" && -z "${ANDROID_SDK_ROOT:-}" ]]; then
  echo "!!  ANDROID_HOME (or ANDROID_SDK_ROOT) is not set — needed to locate apksigner." >&2
  exit 1
fi

SDK_ROOT="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
APKSIGNER="$SDK_ROOT/build-tools/36.0.0/apksigner"
if [[ ! -x "$APKSIGNER" ]]; then
  if command -v apksigner >/dev/null 2>&1; then
    APKSIGNER=$(command -v apksigner)
  else
    echo "!!  apksigner not found at $APKSIGNER and not on PATH." >&2
    exit 1
  fi
fi

echo "==> Signing (Expo target — package com.baseplane.duraclaw.rn)"
echo "    in:  $IN_APK"
echo "    out: $OUT_APK"
"$APKSIGNER" sign \
  --ks "$KEYSTORE_PATH" \
  --ks-pass "pass:$KEYSTORE_PASS" \
  --key-pass "pass:$KEY_PASS" \
  --ks-key-alias "$KEY_ALIAS" \
  --out "$OUT_APK" \
  "$IN_APK"

echo ""
echo "==> Verifying signature"
"$APKSIGNER" verify "$OUT_APK"

echo ""
echo "==> Signed APK ready:"
echo "    $OUT_APK"
echo ""
echo "    Install on device: adb install -r \"$OUT_APK\""
echo ""
echo "    Both packages can coexist on the same device:"
echo "      com.baseplane.duraclaw      (Capacitor — sunsetting)"
echo "      com.baseplane.duraclaw.rn   (Expo — this APK)"
