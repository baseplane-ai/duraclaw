#!/usr/bin/env bash
#
# sign-android.sh — sign a release APK with apksigner (v2/v3 scheme).
#
# Usage:
#   KEYSTORE_PATH=~/.duraclaw-keystore.jks \
#   KEYSTORE_PASS=... \
#   KEY_ALIAS=duraclaw \
#   KEY_PASS=... \
#     ./apps/mobile/scripts/sign-android.sh [path/to/app-release-unsigned.apk]
#
# Defaults the input APK to the standard Gradle output path produced by
# build-android.sh. Output APK is written next to the input with the
# "-unsigned" suffix replaced by "-signed".

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
MOBILE_DIR="$SCRIPT_DIR/.."
DEFAULT_IN="$MOBILE_DIR/android/app/build/outputs/apk/release/app-release-unsigned.apk"

IN_APK="${1:-$DEFAULT_IN}"

if [[ ! -f "$IN_APK" ]]; then
  echo "!!  Input APK not found: $IN_APK" >&2
  echo "!!  Run apps/mobile/scripts/build-android.sh first." >&2
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

Then re-run with the same passwords exported:

  export KEYSTORE_PATH=~/.duraclaw-keystore.jks
  export KEYSTORE_PASS=<pass>
  export KEY_ALIAS=duraclaw
  export KEY_PASS=<pass>
  apps/mobile/scripts/sign-android.sh

Production keystore: stored in the 1Password Engineering vault. Supply via
CI secret bindings — never commit the .jks file or the passwords. Rotate
only with explicit infra approval (changing the signing key invalidates
upgrades for any installed APK).
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
    echo "!!  Install build-tools;36.0.0 via sdkmanager." >&2
    exit 1
  fi
fi

echo "==> Signing"
echo "    in:  $IN_APK"
echo "    out: $OUT_APK"
echo "    keystore: $KEYSTORE_PATH (alias=$KEY_ALIAS)"
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
