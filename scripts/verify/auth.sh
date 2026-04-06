#!/usr/bin/env bash

set -euo pipefail

source "$(dirname "$0")/common.sh"

require_cmd curl
require_cmd jq

sign_in_payload="$(
  jq -nc \
    --arg email "$VERIFY_AUTH_EMAIL" \
    --arg password "$VERIFY_AUTH_PASSWORD" \
    '{email: $email, password: $password, rememberMe: false}'
)"

sign_up_payload="$(
  jq -nc \
    --arg name "$VERIFY_AUTH_NAME" \
    --arg email "$VERIFY_AUTH_EMAIL" \
    --arg password "$VERIFY_AUTH_PASSWORD" \
    '{name: $name, email: $email, password: $password, rememberMe: false}'
)"

sign_in() {
  curl_json \
    -H "Content-Type: application/json" \
    -H "Origin: $VERIFY_ORIGIN" \
    -c "$VERIFY_COOKIE_JAR" \
    -b "$VERIFY_COOKIE_JAR" \
    -X POST \
    "$VERIFY_ORCH_URL/api/auth/sign-in/email" \
    -d "$sign_in_payload"
}

sign_up() {
  curl_json \
    -H "Content-Type: application/json" \
    -H "Origin: $VERIFY_ORIGIN" \
    -c "$VERIFY_COOKIE_JAR" \
    -b "$VERIFY_COOKIE_JAR" \
    -X POST \
    "$VERIFY_ORCH_URL/api/auth/sign-up/email" \
    -d "$sign_up_payload"
}

print_section "auth"
rm -f "$VERIFY_COOKIE_JAR"

if sign_in >"$VERIFY_LOG_DIR/auth-sign-in.json" 2>"$VERIFY_LOG_DIR/auth-sign-in.stderr"; then
  echo "Signed in existing verification user"
else
  echo "Sign-in failed, attempting sign-up"
  sign_up >"$VERIFY_LOG_DIR/auth-sign-up.json" 2>"$VERIFY_LOG_DIR/auth-sign-up.stderr" || true
  sign_in >"$VERIFY_LOG_DIR/auth-sign-in.json"
fi

curl_json \
  -H "Origin: $VERIFY_ORIGIN" \
  -b "$VERIFY_COOKIE_JAR" \
  "$VERIFY_ORCH_URL/api/auth/get-session" | tee "$VERIFY_LOG_DIR/auth-session.json" | jq -e --arg email "$VERIFY_AUTH_EMAIL" '.user.email == $email' >/dev/null

echo "Session cookie ready: $VERIFY_COOKIE_JAR"
