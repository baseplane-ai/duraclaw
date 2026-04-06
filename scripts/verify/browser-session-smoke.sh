#!/usr/bin/env bash

set -euo pipefail

source "$(dirname "$0")/common.sh"

require_cmd agent-browser

if [[ ! -f "$VERIFY_STATE_DIR/latest-session-id.txt" ]]; then
  bash "$VERIFY_ROOT/scripts/verify/session-smoke.sh" >/dev/null
fi

session_id="$(cat "$VERIFY_STATE_DIR/latest-session-id.txt")"
if [[ -z "$session_id" ]]; then
  echo "Missing latest session id for browser session smoke" >&2
  exit 1
fi

browser_session="${VERIFY_BROWSER_SESSION}-session"
snapshot_path="$VERIFY_LOG_DIR/browser-session-snapshot.txt"
screenshot_path="$VERIFY_LOG_DIR/browser-session.png"

agent-browser --session "$browser_session" close >/dev/null 2>&1 || true
agent-browser --session "$browser_session" open "$VERIFY_ORCH_URL/login" >/dev/null
agent-browser --session "$browser_session" wait 1000 >/dev/null
agent-browser --session "$browser_session" fill 'input[placeholder="Email"]' "$VERIFY_AUTH_EMAIL" >/dev/null
agent-browser --session "$browser_session" fill 'input[placeholder="Password"]' "$VERIFY_AUTH_PASSWORD" >/dev/null
agent-browser --session "$browser_session" focus 'input[placeholder="Password"]' >/dev/null
agent-browser --session "$browser_session" press Enter >/dev/null
agent-browser --session "$browser_session" wait 1500 >/dev/null

print_section "browser-session"
agent-browser --session "$browser_session" open "$VERIFY_ORCH_URL/session/$session_id" >/dev/null
agent-browser --session "$browser_session" wait 2500 >/dev/null

body_text="$(agent-browser --session "$browser_session" get text body)"
if ! grep -q "VERIFY" <<<"$body_text"; then
  echo "Expected VERIFY in session page output" >&2
  exit 1
fi

agent-browser --session "$browser_session" snapshot -i >"$snapshot_path"
agent-browser --session "$browser_session" screenshot "$screenshot_path" >/dev/null
agent-browser --session "$browser_session" close >/dev/null

echo "Browser session smoke OK"
echo "Snapshot:   $snapshot_path"
echo "Screenshot: $screenshot_path"
