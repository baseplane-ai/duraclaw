#!/usr/bin/env bash
#
# build-mobile-ota-bundle.sh — emit the Capgo-consumable OTA payload and
# upload it to the `duraclaw-mobile` R2 bucket.
#
# Runs AFTER `pnpm --filter @duraclaw/orchestrator build`. Two outputs:
#
#   R2 keys under the `duraclaw-mobile` bucket:
#     ota/bundle-<version>.zip   — the zip the Capacitor shell downloads
#     ota/version.json           — { version, key } pointer the Worker reads
#
# The Worker's `POST /api/mobile/updates/manifest` route hands Capacitor
# `${origin}/api/mobile/assets/ota/bundle-<version>.zip`, which streams
# the R2 object back through the Worker. No R2 public-domain required.
#
# Callers:
#   1. apps/mobile/scripts/build-android.sh — so a fresh APK install's
#      bundled web assets match the version it reports over OTA. Upload
#      is skipped locally when CLOUDFLARE_API_TOKEN isn't set; the zip
#      still lands at $MOBILE_OUT for manual inspection.
#   2. The infra deploy pipeline — every `main` push re-uploads the
#      latest zip + version.json so Capacitor shells see the bump.
#      Without this step the OTA channel is dead.
#
# Env:
#   APP_VERSION           — override version. Defaults to `git rev-parse --short HEAD`.
#   CLOUDFLARE_API_TOKEN  — required to actually upload; skip-with-warning otherwise.
#   CLOUDFLARE_ACCOUNT_ID — required to disambiguate when multiple CF accounts auth.
#   SKIP_R2_UPLOAD=1      — explicit opt-out (e.g. dry-run build).
#
# Assumes the repo root is the working directory.

set -euo pipefail

APP_VERSION="${APP_VERSION:-$(git rev-parse --short HEAD)}"
BUNDLE_DIR="apps/orchestrator/dist/client"
MOBILE_OUT="$BUNDLE_DIR/mobile"
BUNDLE_ZIP_BASE="$MOBILE_OUT/bundle-$APP_VERSION"
BUNDLE_ZIP="$BUNDLE_ZIP_BASE.zip"
R2_BUCKET="duraclaw-mobile"
R2_KEY="ota/bundle-$APP_VERSION.zip"

if [[ ! -d "$BUNDLE_DIR" ]]; then
  echo "!!  $BUNDLE_DIR missing. Run pnpm --filter @duraclaw/orchestrator build first." >&2
  exit 1
fi

mkdir -p "$MOBILE_OUT"

# Stage in a tmpdir with /mobile/ excluded so the zip doesn't self-nest
# when re-run against a dist tree that already contains a previous OTA
# payload. Same reason we run AFTER any local `cap sync` — the APK
# shouldn't bundle the zip.
STAGE_DIR=$(mktemp -d)
trap 'rm -rf "$STAGE_DIR"' EXIT
cp -r "$BUNDLE_DIR"/. "$STAGE_DIR/"
rm -rf "$STAGE_DIR/mobile"
# Use Python's shutil.make_archive for broad portability — no `zip`
# binary required on the infra server. `make_archive` appends ".zip"
# itself, so pass the basename without extension.
python3 -c "import shutil, sys; shutil.make_archive(sys.argv[1], 'zip', sys.argv[2])" \
  "$BUNDLE_ZIP_BASE" "$STAGE_DIR"

VERSION_JSON="$MOBILE_OUT/version.json"
cat > "$VERSION_JSON" <<EOF
{"version":"$APP_VERSION","key":"$R2_KEY"}
EOF

echo "    wrote $BUNDLE_ZIP"
echo "    wrote $VERSION_JSON"

# ── R2 upload ───────────────────────────────────────────────────────
if [[ "${SKIP_R2_UPLOAD:-}" == "1" ]]; then
  echo "==> SKIP_R2_UPLOAD=1 — leaving $BUNDLE_ZIP + $VERSION_JSON on disk only"
  exit 0
fi

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "!!  CLOUDFLARE_API_TOKEN unset — skipping R2 upload."
  echo "!!  Local build: that's fine, the zip is at $BUNDLE_ZIP for inspection."
  echo "!!  Infra pipeline: this is a configuration error — the OTA channel will not update."
  exit 0
fi

WRANGLER="pnpm --filter @duraclaw/orchestrator exec wrangler"

echo ""
echo "==> Uploading OTA bundle to R2 bucket $R2_BUCKET"
$WRANGLER r2 object put "$R2_BUCKET/$R2_KEY" \
  --file "$BUNDLE_ZIP" \
  --content-type "application/zip" \
  --remote

echo "==> Uploading OTA version.json to R2"
$WRANGLER r2 object put "$R2_BUCKET/ota/version.json" \
  --file "$VERSION_JSON" \
  --content-type "application/json" \
  --remote

echo ""
echo "    R2 key:  $R2_BUCKET/$R2_KEY"
echo "    pointer: $R2_BUCKET/ota/version.json → $APP_VERSION"
