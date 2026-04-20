#!/usr/bin/env bash
#
# build-mobile-ota-bundle.sh — emit the Capgo-consumable OTA payload.
#
# Runs AFTER `pnpm --filter @duraclaw/orchestrator build`. Writes:
#   apps/orchestrator/dist/client/mobile/bundle-<version>.zip
#   apps/orchestrator/dist/client/mobile/version.json   { version, path }
#
# Two callers:
#   1. apps/mobile/scripts/build-android.sh — so a fresh APK install's
#      bundled web assets match the version it reports over OTA.
#   2. The infra deploy pipeline — so every `main` push produces a new
#      OTA payload the Capacitor shells can pull. Without step 2, the
#      /api/mobile/updates/manifest route always returns "no update"
#      and the OTA channel is dead.
#
# Env:
#   APP_VERSION — override the version string. Defaults to
#                 `git rev-parse --short HEAD`.
#
# Assumes the repo root is the working directory.

set -euo pipefail

APP_VERSION="${APP_VERSION:-$(git rev-parse --short HEAD)}"
BUNDLE_DIR="apps/orchestrator/dist/client"
MOBILE_OUT="$BUNDLE_DIR/mobile"
BUNDLE_ZIP_BASE="$MOBILE_OUT/bundle-$APP_VERSION"
BUNDLE_ZIP="$BUNDLE_ZIP_BASE.zip"

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
cat > "$MOBILE_OUT/version.json" <<EOF
{"version":"$APP_VERSION","path":"/mobile/bundle-$APP_VERSION.zip"}
EOF

echo "    wrote $BUNDLE_ZIP"
echo "    wrote $MOBILE_OUT/version.json"
