#!/usr/bin/env bash
#
# build-mobile-expo-ota.sh — emit the EAS-Update-consumable OTA payload
# for the Expo SDK 55 native target.
#
# Runs in the infra deploy pipeline AFTER the orchestrator build. The
# Capacitor counterpart (scripts/build-mobile-ota-bundle.sh) keeps
# running for the brief sunset window — both can co-exist on the same
# R2 bucket because the keyspaces don't overlap (legacy Capgo at
# ota/bundle-<sha>.zip + ota/version.json; new EAS at ota/expo/...).
#
# Pipeline:
#   1. `expo export --platform android --output-dir <staging>`
#      produces the Hermes bundle + assets + a metadata.json that
#      conforms to the expo-updates protocol manifest body.
#   2. Upload per-update objects to R2:
#        ota/expo/<runtimeVersion>/android/<updateId>/bundle.hbc
#        ota/expo/<runtimeVersion>/android/<updateId>/metadata.json
#        ota/expo/<runtimeVersion>/android/<updateId>/assets/<hash>
#   3. ATOMICALLY update the channel pointer (LAST):
#        ota/expo/<runtimeVersion>/android/production/latest.json
#          = { "updateId": "<uuid>", "createdAt": "<iso>" }
#      Pointer-write happens last so a partial upload doesn't break
#      the manifest endpoint — the manifest reader reads the pointer
#      first, so a stale-old-pointer is fine; a missing pointer is
#      "no update available" (404).
#
# Env:
#   APP_VERSION — display version string. Defaults to git short SHA.
#   CHANNEL — EAS Update channel. Defaults to "production".
#   PLATFORM — "android" only (iOS is P4 deferred).
#   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID — required for wrangler
#     r2 object put. The infra pipeline supplies these from secrets.
#
# Standalone use (verification before pipeline wired):
#   export CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=...
#   bash scripts/build-mobile-expo-ota.sh
#
# Assumes the repo root is the working directory.

set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
APP_VERSION="${APP_VERSION:-$(git -C "$REPO_ROOT" rev-parse --short HEAD)}"
CHANNEL="${CHANNEL:-production}"
PLATFORM="${PLATFORM:-android}"
EXPO_APP_DIR="$REPO_ROOT/apps/mobile-expo"
BUCKET="duraclaw-mobile"

if [[ "$PLATFORM" != "android" ]]; then
  echo "!! PLATFORM=$PLATFORM not supported (P3 is android-only)" >&2
  exit 1
fi

if [[ ! -d "$EXPO_APP_DIR" ]]; then
  echo "!! Expo app dir not found: $EXPO_APP_DIR" >&2
  exit 1
fi

if ! command -v wrangler >/dev/null 2>&1; then
  echo "!! wrangler not on PATH. Install via 'pnpm add -g wrangler' or use pnpm exec." >&2
  exit 1
fi

# Stable across runs only if app.json runtimeVersion is fixed-string
# OR (with policy: 'fingerprint') if the native code hasn't drifted.
# The `expo-updates` CLI computes the fingerprint from the staged
# project. We capture it after the export step.

STAGE_DIR=$(mktemp -d)
trap 'rm -rf "$STAGE_DIR"' EXIT

echo "==> [1/4] expo export --platform $PLATFORM"
cd "$EXPO_APP_DIR"
pnpm exec expo export \
  --platform "$PLATFORM" \
  --output-dir "$STAGE_DIR" \
  --dump-sourcemap

# expo export emits:
#   <out>/_expo/static/js/<platform>/<bundle>.hbc
#   <out>/assets/...
#   <out>/metadata.json     (top-level — protocol manifest body source)
# Update id = uuid generated per-export; expo-cli stamps it into
# metadata.json (`id` field), but version varies. Read it back.
METADATA_JSON="$STAGE_DIR/metadata.json"
if [[ ! -f "$METADATA_JSON" ]]; then
  echo "!! expo export did not produce metadata.json at $METADATA_JSON" >&2
  exit 1
fi
UPDATE_ID=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['id'])" "$METADATA_JSON")
RUNTIME_VERSION=$(python3 -c "
import json, sys
m = json.load(open(sys.argv[1]))
# expo-updates puts runtimeVersion at top-level on >=SDK 55
print(m.get('runtimeVersion') or m.get('extra',{}).get('expoClient',{}).get('runtimeVersion','unknown'))
" "$METADATA_JSON")
CREATED_AT=$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')

echo "    updateId=$UPDATE_ID"
echo "    runtimeVersion=$RUNTIME_VERSION"
echo "    createdAt=$CREATED_AT"
if [[ "$RUNTIME_VERSION" == "unknown" ]]; then
  echo "!! Could not read runtimeVersion from metadata.json — aborting before R2 upload." >&2
  exit 1
fi

R2_BASE="ota/expo/$RUNTIME_VERSION/$PLATFORM/$UPDATE_ID"
POINTER_KEY="ota/expo/$RUNTIME_VERSION/$PLATFORM/$CHANNEL/latest.json"

echo ""
echo "==> [2/4] Upload per-update artefacts to R2 bucket '$BUCKET'"

# Walk the staging dir and push each file to R2 under R2_BASE.
# Use `wrangler r2 object put` per file; for large asset trees this
# is sequential (acceptable at single-user scale; the asset count is
# typically <30). Future: parallelise with xargs -P.
pushd "$STAGE_DIR" >/dev/null
while IFS= read -r -d '' file; do
  rel="${file#./}"
  key="$R2_BASE/$rel"
  echo "    put $key"
  wrangler r2 object put "$BUCKET/$key" --file "$file" --remote 1>/dev/null
done < <(find . -type f -print0)
popd >/dev/null

echo ""
echo "==> [3/4] Write atomic pointer LAST: $POINTER_KEY"
PTR_TMP=$(mktemp)
cat > "$PTR_TMP" <<EOF
{"updateId":"$UPDATE_ID","createdAt":"$CREATED_AT","appVersion":"$APP_VERSION"}
EOF
wrangler r2 object put "$BUCKET/$POINTER_KEY" \
  --file "$PTR_TMP" \
  --content-type "application/json" \
  --remote 1>/dev/null
rm -f "$PTR_TMP"

echo ""
echo "==> [4/4] Done."
echo "    runtimeVersion=$RUNTIME_VERSION"
echo "    updateId=$UPDATE_ID"
echo "    channel=$CHANNEL"
echo "    pointer=$POINTER_KEY"
echo ""
echo "    Verify: curl 'https://duraclaw.baseplane.ai/api/mobile/eas/manifest?runtimeVersion=$RUNTIME_VERSION&platform=$PLATFORM&channel=$CHANNEL' | jq ."
