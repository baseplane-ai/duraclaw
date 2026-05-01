#!/usr/bin/env bash
# GH#132 P3.5 — Expo prebuild smoke CI gate (replaces check-metro-bundle.sh).
#
# Purpose: prove the apps/mobile-expo project resolves under
# `expo prebuild --no-install --platform android` — i.e. the Expo
# config plugins (op-sqlite, RN-Firebase, expo-secure-store,
# expo-updates, expo-build-properties) all evaluate cleanly against the
# pinned SDK 55 dep tree. Failure (plugin error, schema validation,
# missing peer dep) blocks PR merge.
#
# Why prebuild instead of metro-bundle: P2's metro smoke proved
# orchestrator source resolved under react-native-web. P3 needs a
# stronger gate: the actual native config-plugin pipeline must succeed,
# because that's what runs in `expo run:android` / `eas build`. A
# resolver-clean source tree that fails prebuild is a worse failure
# (silent until APK build).
#
# Output: a regenerated apps/mobile-expo/android/ tree at
# /tmp/expo-prebuild-smoke/. NOT shipped — gradle build runs out-of-band
# in the local dev / CI Android stage.
#
# Invocation: run from anywhere; cd's to the repo root.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
OUT_DIR=/tmp/expo-prebuild-smoke
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

echo "GH#132 P3.5: running expo prebuild smoke → $OUT_DIR"

# Use --no-install to skip CocoaPods / Gradle install (this is an
# orchestrator-side smoke, not a full native build). --platform android
# locks scope (iOS pods would need a darwin host anyway).
#
# We deliberately don't use `--clean` — that would wipe an existing
# android/ project tracked in git. The infra path uses --clean inside a
# pristine build dir per scripts/bundle-bin.sh convention.
pnpm --filter @duraclaw/mobile-expo exec npx expo prebuild \
  --no-install \
  --platform android \
  || { echo "ERROR: expo prebuild --no-install failed" >&2; exit 1; }

# Verify the prebuild step produced the expected artefacts:
#   apps/mobile-expo/android/                — gradle wrapper + project files
#   apps/mobile-expo/android/app/build.gradle — app module
#   apps/mobile-expo/android/app/src/main/AndroidManifest.xml
ANDROID_DIR=apps/mobile-expo/android
for required in \
  "$ANDROID_DIR/build.gradle" \
  "$ANDROID_DIR/settings.gradle" \
  "$ANDROID_DIR/app/build.gradle" \
  "$ANDROID_DIR/app/src/main/AndroidManifest.xml"
do
  if [[ ! -s "$required" ]]; then
    echo "ERROR: expected prebuild artefact missing or empty: $required" >&2
    exit 1
  fi
done

# Verify the generated AndroidManifest.xml carries the package id
# declared in app.json. If the Expo config plugin chain misread
# app.json, the package would default to something else and the gate
# should catch it. Reads the source of truth from app.json so the gate
# tracks Decision-7 reversals (e.g. dropping .rn for in-place reuse of
# the existing Firebase project) without manual edits here.
MANIFEST="$ANDROID_DIR/app/src/main/AndroidManifest.xml"
EXPECTED_PKG=$(node -e "console.log(require('./apps/mobile-expo/app.json').expo.android.package)")
if [[ -z "$EXPECTED_PKG" ]]; then
  echo "ERROR: could not read expo.android.package from apps/mobile-expo/app.json" >&2
  exit 1
fi
if ! grep -q "$EXPECTED_PKG" "$ANDROID_DIR/app/build.gradle"; then
  echo "ERROR: app/build.gradle missing expected package id ($EXPECTED_PKG)" >&2
  exit 1
fi

echo "[expo-prebuild-smoke] ok"
