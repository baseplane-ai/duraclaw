#!/usr/bin/env bash
#
# publish-mobile-apk.sh — upload a signed release APK to the
# `duraclaw-mobile` R2 bucket for native-layer updates.
#
# Wraps the `GET /api/mobile/apk/latest` side of the mobile updater —
# only needed when native code changes (Capacitor bump, plugin add),
# not on every web-bundle release (which goes via OTA).
#
# Usage:
#   APP_VERSION=1.2.3 ./scripts/publish-mobile-apk.sh \
#     apps/mobile/android/app/build/outputs/apk/release/app-release-signed.apk
#
# Env:
#   APP_VERSION           — required, human-readable version string
#                           (matches App.getInfo().version on the device).
#   CLOUDFLARE_API_TOKEN  — required for R2 upload.
#   CLOUDFLARE_ACCOUNT_ID — required.
#   SKIP_R2_UPLOAD=1      — dry-run (skip actual upload).

set -euo pipefail

APK_IN="${1:-}"
if [[ -z "$APK_IN" ]]; then
  echo "!!  Usage: $0 <path/to/app-release-signed.apk>" >&2
  exit 1
fi
if [[ ! -f "$APK_IN" ]]; then
  echo "!!  APK not found: $APK_IN" >&2
  exit 1
fi

APP_VERSION="${APP_VERSION:-}"
if [[ -z "$APP_VERSION" ]]; then
  echo "!!  APP_VERSION is required (e.g. 1.2.3)." >&2
  exit 1
fi

R2_BUCKET="duraclaw-mobile"
R2_KEY="apk/duraclaw-$APP_VERSION.apk"

MANIFEST_DIR=$(mktemp -d)
trap 'rm -rf "$MANIFEST_DIR"' EXIT
MANIFEST_FILE="$MANIFEST_DIR/version.json"
cat > "$MANIFEST_FILE" <<EOF
{"version":"$APP_VERSION","key":"$R2_KEY"}
EOF

if [[ "${SKIP_R2_UPLOAD:-}" == "1" ]]; then
  echo "==> SKIP_R2_UPLOAD=1 — would upload:"
  echo "    $R2_BUCKET/$R2_KEY  ← $APK_IN"
  echo "    $R2_BUCKET/apk/version.json  ← {\"version\":\"$APP_VERSION\",\"key\":\"$R2_KEY\"}"
  exit 0
fi

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "!!  CLOUDFLARE_API_TOKEN unset — cannot upload APK." >&2
  exit 1
fi

WRANGLER="pnpm --filter @duraclaw/orchestrator exec wrangler"

echo "==> Uploading APK to R2"
$WRANGLER r2 object put "$R2_BUCKET/$R2_KEY" \
  --file "$APK_IN" \
  --content-type "application/vnd.android.package-archive" \
  --remote

echo "==> Uploading APK version.json to R2"
$WRANGLER r2 object put "$R2_BUCKET/apk/version.json" \
  --file "$MANIFEST_FILE" \
  --content-type "application/json" \
  --remote

echo ""
echo "    R2 key:  $R2_BUCKET/$R2_KEY"
echo "    pointer: $R2_BUCKET/apk/version.json → $APP_VERSION"
