#!/usr/bin/env bash

set -euo pipefail

source "$(dirname "$0")/common.sh"

require_cmd agent-browser

bash "$VERIFY_ROOT/scripts/verify/auth.sh" >/dev/null

agent-browser --session "$VERIFY_BROWSER_SESSION" close >/dev/null 2>&1 || true

print_section "browser"
agent-browser --session "$VERIFY_BROWSER_SESSION" open "$VERIFY_ORCH_URL/login" >/dev/null
agent-browser --session "$VERIFY_BROWSER_SESSION" wait 1000 >/dev/null
agent-browser --session "$VERIFY_BROWSER_SESSION" fill 'input[placeholder="Email"]' "$VERIFY_AUTH_EMAIL" >/dev/null
agent-browser --session "$VERIFY_BROWSER_SESSION" fill 'input[placeholder="Password"]' "$VERIFY_AUTH_PASSWORD" >/dev/null
agent-browser --session "$VERIFY_BROWSER_SESSION" focus 'input[placeholder="Password"]' >/dev/null
agent-browser --session "$VERIFY_BROWSER_SESSION" press Enter >/dev/null
agent-browser --session "$VERIFY_BROWSER_SESSION" wait 2000 >/dev/null

current_url="$(agent-browser --session "$VERIFY_BROWSER_SESSION" get url)"
if [[ "$current_url" == *"/login"* ]]; then
  echo "Browser login did not leave /login" >&2
  exit 1
fi

body_text="$(agent-browser --session "$VERIFY_BROWSER_SESSION" get text body)"
if ! grep -q "Projects" <<<"$body_text"; then
  echo "Expected dashboard content missing after browser login" >&2
  exit 1
fi

agent-browser --session "$VERIFY_BROWSER_SESSION" snapshot -i >"$VERIFY_BROWSER_SNAPSHOT"
agent-browser --session "$VERIFY_BROWSER_SESSION" screenshot "$VERIFY_BROWSER_SCREENSHOT" >/dev/null
agent-browser --session "$VERIFY_BROWSER_SESSION" close >/dev/null

echo "Browser smoke OK"
echo "Snapshot:   $VERIFY_BROWSER_SNAPSHOT"
echo "Screenshot: $VERIFY_BROWSER_SCREENSHOT"
